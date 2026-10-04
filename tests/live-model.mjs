import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createStore } from '../lib/store.mjs';
import { createAI } from '../lib/ai.mjs';
import { createApp } from '../server.mjs';

const store = createStore(':memory:');
for (const item of [
  { name: 'Rice', quantity: 1000, unit: 'g' }, { name: 'Eggs', quantity: 6, unit: 'pcs' },
  { name: 'Tomatoes', quantity: 4, unit: 'pcs' }, { name: 'Onions', quantity: 3, unit: 'pcs' },
  { name: 'Oil', quantity: 100, unit: 'ml' }, { name: 'Salt', quantity: 50, unit: 'g' },
]) store.add(item);
const model = createAI();
const server = createApp({ store, ai: {
  health: () => model.health(),
  chat: context => {
    if (context.feedback) console.log('Rejected fixture model draft:', JSON.stringify(context.previous));
    return model.chat(context);
  },
} });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
async function chat(message) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }),
  });
  const reply = await response.json();
  assert.equal(response.status, 200, JSON.stringify(reply));
  return reply;
}
try {
  const before = store.inventory();
  const lunch = await chat('What can I make for lunch? Suggest two different simple meals for one person using only what I have.');
  assert.equal(lunch.recipes.length, 2);
  assert.deepEqual(store.inventory(), before);
  console.log('Mixed pantry meals:', lunch.recipes.map(recipe => recipe.name).join(', '));
  const missing = await chat('I bought rice and eggs. Add them to my pantry.');
  assert.equal(missing.action, undefined);
  assert.match(missing.message, /How much/);
  assert.match(missing.message, /Nothing has been added/);
  assert.deepEqual(store.inventory(), before);
  console.log('Missing quantities:', missing.message);
  const groceries = await chat('I bought 1 kg rice and 6 eggs. Add these to my pantry.');
  assert.equal(groceries.action.kind, 'restock');
  assert.deepEqual(groceries.action.items.map(item => item.quantity).sort((a, b) => a - b), [6, 1000]);
  assert.deepEqual(store.inventory(), before);
  store.confirm(groceries.action.id, groceries.action.items.map(item => item.quantity));
  assert.equal(store.inventory().find(item => item.name === 'Rice').quantity, 2000);
  assert.equal(store.inventory().find(item => item.name === 'Eggs').quantity, 12);
  console.log('Live multi-item purchases, kg conversion, and explicit confirmation passed.');

  for (const item of store.inventory()) store.remove(item.id);
  for (const item of [
    { name: 'Capsicum', quantity: 3, unit: 'pcs' }, { name: 'Chicken', quantity: 500, unit: 'g' },
    { name: 'Garlic', quantity: 2, unit: 'pcs' }, { name: 'Onion', quantity: 2, unit: 'g' },
    { name: 'Pasta', quantity: 500, unit: 'g' }, { name: 'Tomato', quantity: 4, unit: 'pcs' },
  ]) store.add(item);
  const screenshotPantry = store.inventory();
  const practical = await chat('What can I make for lunch? Suggest two practical meals for one person. Use only my current pantry, not any ingredients from earlier recipes.');
  assert.ok(practical.recipes?.length > 0, JSON.stringify(practical));
  for (const recipe of practical.recipes) {
    assert.equal(recipe.ingredients.some(item => item.name === 'Onion'), false);
    assert.equal(recipe.ingredients.some(item => ['Oil', 'Salt', 'Butter'].includes(item.name)), false);
  }
  assert.deepEqual(store.inventory(), screenshotPantry);
  console.log('Screenshot pantry passed: 2 g onion omitted; no assumed oil or seasoning:', practical.recipes.map(recipe => recipe.name).join(', '));

  for (const item of store.inventory()) store.remove(item.id);
  store.add({ name: 'Onion', quantity: 2, unit: 'g' });
  const tiny = await chat('What can I make for lunch with only my current pantry?');
  assert.equal(tiny.recipes, undefined);
  assert.equal(tiny.action, undefined);
  assert.match(tiny.message, /not enough|too little|insufficient|restock|more|need|limited/i);
  assert.equal(store.inventory()[0].quantity, 2);
  console.log('Tiny-only pantry asks for more food instead of inventing a meal:', tiny.message);
} finally {
  await new Promise(resolve => server.close(resolve));
  store.close();
}
