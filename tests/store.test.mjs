import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, ingredient, quantity } from '../lib/store.mjs';
import { validateRecipe, schemaForContext, validateRestock } from '../lib/ai.mjs';
import { minimumRecipeQuantity, pantryQuantityHint, foodPortions } from '../public/recipe-rules.js';

function fixture(t) {
  const store = createStore(':memory:');
  t.after(() => store.close());
  return store;
}

function sampleRecipe(store, uses) {
  return store.saveRecipe({
    name: 'Pantry rice', description: 'A simple meal.', servings: 1, minutes: 20,
    ingredients: uses.map(([name, amount]) => {
      const item = store.inventory().find(item => item.name === name);
      return { ingredientId: item.id, name, unit: item.unit, quantity: amount };
    }),
    steps: ['Cook and serve.'],
  });
}

test('quantities and names are normalized, with invalid values rejected', () => {
  assert.equal(quantity(0.125), 125);
  for (const value of [0, -1, NaN, Infinity, '2', 0.0001, 1.1234, 1_000_001]) {
    assert.throws(() => quantity(value));
  }
  assert.equal(ingredient({ name: '  Brown   Rice ', quantity: 100, unit: 'g' }).key, 'brown rice');
  assert.throws(() => ingredient({ name: '', quantity: 1, unit: 'g' }));
  assert.throws(() => ingredient({ name: 'rice', quantity: 1, unit: 'kg' }));
});

test('restocking merges matching names but never mixes incompatible units', t => {
  const store = fixture(t);
  store.add({ name: 'Rice', quantity: 500, unit: 'g' });
  store.add({ name: 'rice', quantity: 250, unit: 'g' });
  assert.equal(store.inventory().length, 1);
  assert.equal(store.inventory()[0].quantity, 750);
  assert.throws(() => store.add({ name: 'Rice', quantity: 1, unit: 'pcs' }));
  assert.equal(store.inventory()[0].quantity, 750);
});

test('cooking review does not mutate inventory; confirmation uses adjusted amounts exactly once', t => {
  const store = fixture(t);
  store.add({ name: 'Rice', quantity: 1000, unit: 'g' });
  const recipe = sampleRecipe(store, [['Rice', 200]]);
  const action = store.cookingReview(recipe.id);
  assert.equal(store.inventory()[0].quantity, 1000);
  store.confirm(action.id, [150.125]);
  assert.equal(store.inventory()[0].quantity, 849.875);
  assert.equal(store.confirm(action.id, [150.125]).alreadyConfirmed, true);
  assert.equal(store.inventory()[0].quantity, 849.875);
});

test('insufficient stock rolls back all recipe deductions and allows correction', t => {
  const store = fixture(t);
  store.add({ name: 'Rice', quantity: 500, unit: 'g' });
  store.add({ name: 'Eggs', quantity: 1, unit: 'pcs' });
  const action = store.cookingReview(sampleRecipe(store, [['Rice', 100], ['Eggs', 1]]).id);
  assert.throws(() => store.confirm(action.id, [100, 2]), /Not enough Eggs/);
  assert.equal(store.inventory().find(item => item.name === 'Rice').quantity, 500);
  store.confirm(action.id, [100, 1]);
  assert.equal(store.inventory().find(item => item.name === 'Rice').quantity, 400);
  assert.equal(store.inventory().some(item => item.name === 'Eggs'), false);
  store.add({ name: 'Eggs', quantity: 6, unit: 'pcs' });
  assert.equal(store.inventory().find(item => item.name === 'Eggs').quantity, 6);
});

test('changed or removed ingredients cannot be deducted by an old review', t => {
  const store = fixture(t);
  const [rice] = store.add({ name: 'Rice', quantity: 500, unit: 'g' });
  const action = store.cookingReview(sampleRecipe(store, [['Rice', 100]]).id);
  store.set(rice.id, { name: 'Rice', quantity: 2, unit: 'pcs' });
  assert.throws(() => store.confirm(action.id, [1]), /Not enough/);
  store.remove(rice.id);
  assert.throws(() => store.confirm(action.id, [1]), /Not enough/);
});

test('restock review is atomic, editable, cancellable, and idempotent', t => {
  const store = fixture(t);
  store.add({ name: 'Rice', quantity: 100, unit: 'g' });
  const invalid = store.restockReview([
    { name: 'Eggs', quantity: 6, unit: 'pcs' }, { name: 'Rice', quantity: 1, unit: 'pcs' },
  ]);
  assert.throws(() => store.confirm(invalid.id, [6, 1]), /tracked in g/);
  assert.equal(store.inventory().length, 1);
  const action = store.restockReview([{ name: 'Rice', quantity: 500, unit: 'g' }]);
  assert.equal(store.inventory()[0].quantity, 100);
  store.confirm(action.id, [400]);
  store.confirm(action.id, [400]);
  assert.equal(store.inventory()[0].quantity, 500);
  const cancelled = store.restockReview([{ name: 'Eggs', quantity: 6, unit: 'pcs' }]);
  store.cancel(cancelled.id);
  assert.throws(() => store.confirm(cancelled.id, [6]), /cancelled/);
  assert.throws(() => store.restockReview([{ name: 'Rice', quantity: 1, unit: 'g' }, { name: 'rice', quantity: 2, unit: 'g' }]));
});

test('pantry, chat, recipes, and pending reviews survive a database reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cheomil-persistence-'));
  const path = join(directory, 'test.sqlite');
  let store = createStore(path);
  try {
    store.add({ name: 'Rice', quantity: 500, unit: 'g' });
    const recipe = sampleRecipe(store, [['Rice', 100]]);
    const action = store.cookingReview(recipe.id);
    store.saveMessage('assistant', { message: 'Review first.', action });
    store.close();
    store = createStore(path);
    assert.equal(store.inventory()[0].quantity, 500);
    assert.equal(store.state().messages[0].action.status, 'pending');
    store.confirm(action.id, [100]);
    assert.equal(store.state().messages[0].action.status, 'confirmed');
    assert.equal(store.inventory()[0].quantity, 400);
    assert.equal(store.recentRecipes()[0].id, recipe.id);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test('model recipes cannot use unknown ingredients, duplicate entries, or unavailable amounts', () => {
  const pantry = [{ id: 'rice-id', name: 'Rice', unit: 'g', quantity: 500 }];
  const base = { name: 'Rice', description: 'Steamed rice.', minutes: 20, servings: 1, steps: ['Boil the rice in water.'] };
  assert.equal(validateRecipe({ ...base, ingredients: [{ name: 'Rice', quantity: 100 }] }, pantry).ingredients[0].unit, 'g');
  assert.throws(() => validateRecipe({ ...base, ingredients: [{ name: 'Oil', quantity: 10 }] }, pantry), /outside/);
  assert.throws(() => validateRecipe({ ...base, ingredients: [{ name: 'Rice', quantity: 501 }] }, pantry), /more Rice/);
  assert.throws(() => validateRecipe({ ...base, ingredients: [{ name: 'Rice', quantity: 1.1234 }] }, pantry), /invalid amount/);
  assert.throws(() => validateRecipe({ ...base, ingredients: [{ name: 'Rice', quantity: 100 }, { name: 'Rice', quantity: 100 }] }, pantry), /outside/);
});

test('structured output enforces the active intent and bounds ingredient references to the pantry', () => {
  const pantry = [{ id: 'rice-id', name: 'Rice', unit: 'g', quantity: 500 }];
  const schema = schemaForContext(pantry, [{ id: 'recipe-id' }]);
  const suggest = schema.oneOf.find(branch => branch.properties.intent.const === 'suggest');
  assert.equal(suggest.properties.recipes.minItems, 1);
  assert.deepEqual(suggest.properties.recipes.items.properties.ingredients.required, ['Rice']);
  assert.equal(suggest.properties.recipes.items.properties.ingredients.properties.Rice.anyOf[1].maximum, 500);
  assert.equal(suggest.properties.recipes.items.properties.ingredients.properties.Rice.anyOf[1].minimum, 25);
  const cook = schema.oneOf.find(branch => branch.properties.intent.const === 'cook');
  assert.deepEqual(cook.properties.recipe_id.enum, ['recipe-id']);
  assert.equal(cook.properties.recipes.maxItems, 0);
  assert.equal(schemaForContext([], []).oneOf.some(branch => ['cook', 'suggest'].includes(branch.properties.intent.const)), false);
  assert.equal(schemaForContext(pantry, [], 'I bought rice.').oneOf.some(branch => branch.properties.intent.const === 'restock'), false);
  assert.equal(schemaForContext(pantry, [], 'I bought 500 g rice.').oneOf.some(branch => branch.properties.intent.const === 'restock'), true);
});

test('small main ingredients are omitted, but legitimate seasoning and fractional pieces remain usable', () => {
  const pantry = [
    { id: 'pasta', name: 'Pasta', unit: 'g', quantity: 500 },
    { id: 'onion', name: 'Onion', unit: 'g', quantity: 2 },
    { id: 'salt', name: 'Salt', unit: 'g', quantity: 1 },
  ];
  const base = { name: 'Plain pasta', description: 'Pasta cooked in water.', minutes: 15, servings: 1,
    steps: ['Boil Pasta in tap water.'] };
  assert.throws(() => validateRecipe({ ...base, ingredients: { Pasta: 100, Onion: 1, Salt: 0 } }, pantry), /Onion.*too little/);
  assert.throws(() => validateRecipe({ ...base, ingredients: { Pasta: 100, Onion: 0, Salt: 0 },
    description: 'Pasta with onion.' }, pantry), /Onion is below the practical amount.*Keep its ledger quantity at 0/);
  assert.equal(validateRecipe({ ...base, ingredients: { Pasta: 100, Onion: 0, Salt: 0.1 },
    steps: ['Boil Pasta in tap water with Salt.'] }, pantry).ingredients.length, 2);
  assert.match(pantryQuantityHint(pantry[1]), /Too little/);
  assert.equal(pantryQuantityHint(pantry[2]), '');
  const schema = schemaForContext(pantry, [], 'Lunch?');
  const ledger = schema.oneOf.find(branch => branch.properties.intent.const === 'suggest').properties.recipes.items.properties.ingredients;
  assert.equal(ledger.properties.Onion.const, 0);
  assert.equal(minimumRecipeQuantity({ name: 'Onions', unit: 'pcs' }), 0.125);
  assert.equal(minimumRecipeQuantity({ name: 'Onion powder', unit: 'g' }), 0.01);
  assert.equal(foodPortions([{ name: 'Salt', unit: 'g', quantity: 500 }]), 0);
});

test('practical quantity boundaries scale with servings without converting grams into pieces', () => {
  const pantry = [{ id: 'pasta', name: 'Pasta', unit: 'g', quantity: 500 },
    { id: 'onion', name: 'Onion', unit: 'g', quantity: 100 }];
  const base = { name: 'Pasta with onion', description: 'A simple dish.', minutes: 15, servings: 1,
    steps: ['Simmer Pasta and Onion in tap water.'] };
  assert.throws(() => validateRecipe({ ...base, ingredients: { Pasta: 100, Onion: 9.999 } }, pantry), /too little/);
  assert.equal(validateRecipe({ ...base, ingredients: { Pasta: 100, Onion: 10 } }, pantry).ingredients[1].quantity, 10);
  assert.throws(() => validateRecipe({ ...base, servings: 2, ingredients: { Pasta: 200, Onion: 10 } }, pantry), /at least 20 g/);
  assert.equal(validateRecipe({ ...base, servings: 2, ingredients: { Pasta: 200, Onion: 20 } }, pantry).servings, 2);
  const pieces = [{ ...pantry[0] }, { ...pantry[1], unit: 'pcs', quantity: 2 }];
  assert.equal(validateRecipe({ ...base, ingredients: { Pasta: 100, Onion: 0.5 } }, pieces).ingredients[1].unit, 'pcs');
});

test('tiny leftovers and condiments cannot be advertised as meals or inflated serving counts', () => {
  const pantry = [{ id: 'onion', name: 'Onion', unit: 'g', quantity: 2 }];
  assert.equal(schemaForContext(pantry, []).oneOf.some(branch => branch.properties.intent.const === 'suggest'), false);
  const rice = [{ id: 'rice', name: 'Rice', unit: 'g', quantity: 100 }];
  const recipe = { name: 'Rice', description: 'Rice in water.', minutes: 20, servings: 3,
    ingredients: { Rice: 100 }, steps: ['Boil Rice in tap water.'] };
  assert.throws(() => validateRecipe(recipe, rice), /not enough substantial food/);
  const salt = [{ id: 'salt', name: 'Salt', unit: 'g', quantity: 500 }];
  assert.throws(() => validateRecipe({ ...recipe, name: 'Salt water', description: '', servings: 1,
    ingredients: { Salt: 1 }, steps: ['Dissolve Salt in water.'] }, salt), /not enough substantial food/);
});

test('unavailable oils, spices, and foods in prose are rejected, including title and description', () => {
  const pantry = [{ id: 'pasta', name: 'Pasta', unit: 'g', quantity: 100 }];
  const base = { name: 'Pasta', description: 'Plain pasta.', servings: 1, minutes: 15,
    ingredients: { Pasta: 100 }, steps: ['Boil Pasta in water.'] };
  for (const name of ['oil', 'butter', 'salt', 'pepper', 'milk', 'garlic', 'paprika']) {
    assert.throws(() => validateRecipe({ ...base, steps: [`Add ${name} to the Pasta.`] }, pantry), /without a tracked ingredient amount/);
  }
  assert.throws(() => validateRecipe({ ...base, description: 'Pasta with tomato.' }, pantry), /tomato without a tracked ingredient amount/);
  assert.equal(validateRecipe({ ...base, steps: ['Boil Pasta in tap water without oil.'] }, pantry).ingredients.length, 1);
  assert.throws(() => validateRecipe({ ...base, ingredients: [null] }, pantry), /incomplete recipe/);
  const powder = [...pantry, { id: 'powder', name: 'Onion powder', unit: 'g', quantity: 2 }];
  assert.equal(validateRecipe({ ...base, ingredients: { Pasta: 100, 'Onion powder': 0.1 },
    steps: ['Boil Pasta in water and stir in Onion powder.'] }, powder).ingredients.length, 2);
});

test('renamed ingredients cannot be consumed by an old cooking review', t => {
  const store = fixture(t);
  const [rice] = store.add({ name: 'Rice', quantity: 500, unit: 'g' });
  const action = store.cookingReview(sampleRecipe(store, [['Rice', 100]]).id);
  store.set(rice.id, { name: 'Flour', quantity: 500, unit: 'g' });
  assert.throws(() => store.confirm(action.id, [100]), /Not enough Rice/);
  assert.equal(store.inventory()[0].quantity, 500);
});

test('new chat deletes conversation memory, recipes, and reviews without changing pantry quantities', t => {
  const store = fixture(t);
  store.add({ name: 'Rice', quantity: 500, unit: 'g' });
  const recipe = sampleRecipe(store, [['Rice', 100]]);
  const action = store.cookingReview(recipe.id);
  store.saveMessage('user', { message: 'Lunch?' });
  store.saveMessage('assistant', { message: 'Rice.', recipes: [recipe], action });
  const before = store.inventory();
  assert.deepEqual(store.newChat(), { inventory: before, messages: [] });
  assert.deepEqual(store.history(), []);
  assert.deepEqual(store.recentRecipes(), []);
  assert.throws(() => store.getRecipe(recipe.id), /not found/);
  assert.throws(() => store.confirm(action.id, [100]), /not found/);
  assert.deepEqual(store.inventory(), before);
  store.saveMessage('user', { message: 'A fresh question.' });
  assert.equal(store.history().length, 1);
});

test('purchase quantities must be quoted from the current message and converted without guessing', () => {
  const message = 'I bought 1.5 kg rice, 6 eggs and 2 l milk.';
  const items = validateRestock([
    { name: 'Rice', quantity: 1500, unit: 'g', source_text: '1.5 kg rice' },
    { name: 'Eggs', quantity: 6, unit: 'pcs', source_text: '6 eggs' },
    { name: 'Milk', quantity: 2000, unit: 'ml', source_text: '2 l milk' },
  ], message);
  assert.deepEqual(items.map(item => item.quantity), [1500, 6, 2000]);
  assert.throws(() => validateRestock([{ name: 'Rice', quantity: 1000, unit: 'g', source_text: '1000 g rice' }], 'I bought rice.'), /ground/);
  assert.throws(() => validateRestock([{ name: 'Rice', quantity: 1000, unit: 'g', source_text: '1.5 kg rice' }], message), /misread/);
  assert.throws(() => validateRestock([{ name: 'Rice', quantity: 1, unit: 'g', source_text: '-1 g rice' }], '-1 g rice'), /numeric quantity/);
});

test('a recipe must track pantry items mentioned in its cooking steps', () => {
  const pantry = [
    { id: 'eggs', name: 'Eggs', quantity: 6, unit: 'pcs' },
    { id: 'oil', name: 'Oil', quantity: 100, unit: 'ml' },
    { id: 'tomatoes', name: 'Tomatoes', quantity: 3, unit: 'pcs' },
  ];
  const recipe = { name: 'Eggs', description: 'Fried eggs.', servings: 1, minutes: 5,
    ingredients: [{ name: 'Eggs', quantity: 2 }], steps: ['Heat oil and fry the eggs.'] };
  assert.throws(() => validateRecipe(recipe, pantry), /Oil without a tracked quantity/);
  assert.throws(() => validateRecipe({ ...recipe, steps: ['Add tomato and fry the eggs.'] }, pantry), /Tomatoes without a tracked quantity/);
  const tracked = validateRecipe({ ...recipe, ingredients: { Eggs: 2, Oil: 5, Tomatoes: 0 } }, pantry);
  assert.equal(tracked.ingredients.length, 2);
  assert.equal(tracked.ingredients.find(item => item.name === 'Oil').quantity, 5);
  assert.throws(() => validateRecipe({ ...recipe, ingredients: { Eggs: 2, Oil: 0, Tomatoes: 0 } }, pantry), /Oil without a tracked quantity/);
  assert.throws(() => validateRecipe({ ...recipe, ingredients: { Eggs: 2, Oil: 5 } }, pantry), /incomplete pantry quantity ledger/);
  assert.throws(() => validateRecipe({ ...recipe, ingredients: { Eggs: 2, Oil: 5, Tomatoes: 0, Butter: 0 } }, pantry), /incomplete pantry quantity ledger/);
});
