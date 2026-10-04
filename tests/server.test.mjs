import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createStore } from '../lib/store.mjs';
import { createApp } from '../server.mjs';

async function fixture(t, chat) {
  const store = createStore(':memory:');
  const server = createApp({ store, ai: {
    health: async () => ({ available: true, model: 'test-model' }),
    chat: chat || (async () => ({ intent: 'message', message: 'Tell me what you have.' })),
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, method = 'GET', body, headers = {}) {
    const response = await fetch(`${base}${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  return { store, request, base };
}

test('HTTP ingredient creation, editing, removal, health and state', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/health')).body.available, true);
  const add = await request('/api/ingredients', 'POST', { name: 'Rice', quantity: 500, unit: 'g' });
  assert.equal(add.status, 201);
  const id = add.body.inventory[0].id;
  const edit = await request(`/api/ingredients/${id}`, 'PATCH', { name: 'Rice', quantity: 600, unit: 'g' });
  assert.equal(edit.body.inventory[0].quantity, 600);
  assert.equal((await request(`/api/ingredients/${id}`, 'DELETE')).body.inventory.length, 0);
  assert.equal((await request('/api/state')).body.messages.length, 0);
});

test('meal chat produces saved recipes and cooking requires separate confirmation', async t => {
  const { request, store } = await fixture(t, async ({ pantry }) => ({
    intent: 'suggest', message: 'Here is a lunch idea.',
    recipes: [{ name: 'Steamed rice', description: 'Simple rice.', servings: 1, minutes: 20,
      ingredients: [{ name: pantry[0].name, quantity: 100 }], steps: ['Cook the rice in water.'] }],
  }));
  await request('/api/ingredients', 'POST', { name: 'Rice', quantity: 500, unit: 'g' });
  const reply = await request('/api/chat', 'POST', { message: 'Lunch?' });
  assert.equal(reply.status, 200);
  const review = await request('/api/cooking-review', 'POST', { recipeId: reply.body.recipes[0].id });
  assert.equal(store.inventory()[0].quantity, 500);
  const confirm = await request('/api/confirm', 'POST', { actionId: review.body.action.id, quantities: [100] });
  assert.equal(confirm.body.inventory[0].quantity, 400);
  assert.equal((await request('/api/state')).body.messages[2].action.status, 'confirmed');
});

test('chat restocking is reviewed, not applied immediately', async t => {
  const { request, store } = await fixture(t, async () => ({
    intent: 'restock', message: 'Review your groceries.', restock: [{ name: 'Eggs', quantity: 6, unit: 'pcs', source_text: '6 eggs' }],
  }));
  const reply = await request('/api/chat', 'POST', { message: 'I bought 6 eggs.' });
  assert.equal(store.inventory().length, 0);
  await request('/api/confirm', 'POST', { actionId: reply.body.action.id, quantities: [6] });
  assert.equal(store.inventory()[0].quantity, 6);
});

test('cooking through natural-language chat targets an existing saved recipe', async t => {
  const { request, store } = await fixture(t, async ({ recipes }) => ({
    intent: 'cook', message: 'Review this dish.', recipe_id: recipes[0].id,
  }));
  const [rice] = store.add({ name: 'Rice', quantity: 500, unit: 'g' });
  store.saveRecipe({ name: 'Rice', ingredients: [{ ingredientId: rice.id, name: 'Rice', unit: 'g', quantity: 100 }] });
  const reply = await request('/api/chat', 'POST', { message: 'I cooked the rice.' });
  assert.equal(reply.body.action.kind, 'cook');
  assert.equal(store.inventory()[0].quantity, 500);
});

test('purchases without amounts ask for quantities without allowing invented model claims', async t => {
  const { request, store } = await fixture(t, async () => {
    assert.fail('A purchase with no quantities must not reach the model.');
  });
  store.add({ name: 'Rice', quantity: 500, unit: 'g' });
  const before = store.inventory();
  for (const message of ['I bought rice and eggs. Add them to my pantry.', 'We have just purchased some eggs.', 'Please restock my rice.']) {
    const reply = await request('/api/chat', 'POST', { message });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.action, undefined);
    assert.match(reply.body.message, /How much/);
    assert.match(reply.body.message, /Nothing has been added/);
    assert.deepEqual(store.inventory(), before);
  }
  assert.equal(store.state().messages.length, 6);
});

test('unknown pantry references and invalid input return explicit errors without changing data', async t => {
  const { request, store } = await fixture(t, async () => ({
    intent: 'suggest', message: 'A meal.',
    recipes: [{ name: 'Bread', description: 'Toast.', servings: 1, minutes: 5,
      ingredients: [{ name: 'nonexistent', quantity: 1 }], steps: ['Toast.'] }],
  }));
  const bad = await request('/api/chat', 'POST', { message: 'Lunch?' });
  assert.equal(bad.status, 502);
  assert.match(bad.body.error, /outside/);
  assert.equal(store.recentRecipes().length, 0);
  assert.equal(store.state().messages.length, 0);
  assert.equal((await request('/api/chat', 'POST', { message: '' })).status, 400);
  assert.equal((await request('/api/ingredients', 'POST', { name: 'rice', quantity: -2, unit: 'g' })).status, 400);
  assert.equal((await request('/api/confirm', 'POST', { actionId: 'missing', quantities: [] })).status, 404);
});

test('local origin restrictions protect pantry mutations', async t => {
  const { request, base } = await fixture(t);
  assert.equal((await request('/api/ingredients', 'POST', { name: 'rice', quantity: 500, unit: 'g' },
    { Origin: 'https://example.com' })).status, 403);
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(`${base}/api/state`, { headers: { Host: 'example.com' } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('non-object JSON and invalid review identifiers return validation errors', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/chat', 'POST', null)).status, 400);
  assert.equal((await request('/api/chat', 'POST', [])).status, 400);
  assert.equal((await request('/api/cooking-review', 'POST', { recipeId: {} })).status, 400);
  assert.equal((await request('/api/confirm', 'POST', { actionId: [], quantities: [] })).status, 400);
});

test('an invalid recipe draft gets one correction pass without writing partial history', async t => {
  let calls = 0;
  const { request, store } = await fixture(t, async ({ pantry, feedback }) => {
    calls++;
    if (calls === 2) assert.match(feedback, /Oil/);
    const eggs = pantry.find(item => item.name === 'Eggs');
    const oil = pantry.find(item => item.name === 'Oil');
    return { intent: 'suggest', message: 'A simple meal.',
      recipes: [{ name: 'Eggs', description: 'Fried eggs.', servings: 1, minutes: 5,
        ingredients: [{ name: eggs.name, quantity: 2 }, ...(calls === 2 ? [{ name: oil.name, quantity: 5 }] : [])],
        steps: ['Heat oil and fry the eggs.'] }] };
  });

  store.add({ name: 'Eggs', quantity: 6, unit: 'pcs' });
  store.add({ name: 'Oil', quantity: 100, unit: 'ml' });
  const reply = await request('/api/chat', 'POST', { message: 'What can I make?' });
  assert.equal(reply.status, 200);
  assert.equal(calls, 2);
  assert.equal(store.state().messages.length, 2);
  assert.equal(store.recentRecipes().length, 1);
  assert.equal(store.inventory().find(item => item.name === 'Oil').quantity, 100);
});

test('old impractical suggestions cannot create cooking reviews through either route', async t => {
    const { request, store } = await fixture(t, async ({ recipes }) => ({
      intent: 'cook', message: 'Review this dish.', recipe_id: recipes[0].id,
    }));
    const [onion] = store.add({ name: 'Onion', quantity: 2, unit: 'g' });
    const recipe = store.saveRecipe({ name: 'Onion dish', servings: 1, steps: ['Cook Onion in oil.'],
      ingredients: [{ ingredientId: onion.id, name: 'Onion', unit: 'g', quantity: 1 }] });
    const direct = await request('/api/cooking-review', 'POST', { recipeId: recipe.id });
    assert.equal(direct.status, 409);
    assert.match(direct.body.error, /needs replacing/);
    const chat = await request('/api/chat', 'POST', { message: 'I cooked the onion dish.' });
    assert.equal(chat.status, 409);
    assert.equal(store.inventory()[0].quantity, 2);
    assert.equal(store.state().messages.length, 0);
  });

  test('tiny ingredient and missing-oil drafts are corrected without saving misleading suggestions', async t => {
    let calls = 0;
    const { request, store } = await fixture(t, async ({ feedback }) => {
      calls++;
      if (calls === 2) assert.match(feedback, /Onion.*too little/);
      return { intent: 'suggest', message: 'A simple lunch.', recipes: [{
        name: 'Pasta', description: 'Pasta in tap water.', servings: 1, minutes: 15,
        ingredients: { Pasta: 100, Onion: calls === 1 ? 1 : 0 },
        steps: calls === 1 ? ['Boil Pasta and Onion in water.'] : ['Boil Pasta in tap water.'],
      }] };
    });
    store.add({ name: 'Pasta', quantity: 500, unit: 'g' });
    store.add({ name: 'Onion', quantity: 2, unit: 'g' });
    const reply = await request('/api/chat', 'POST', { message: 'What can I make for lunch?' });
    assert.equal(reply.status, 200);
    assert.equal(calls, 2);
    assert.deepEqual(reply.body.recipes[0].ingredients.map(item => item.name), ['Pasta']);
    assert.equal(store.recentRecipes().length, 1);
    assert.equal(store.inventory().find(item => item.name === 'Onion').quantity, 2);
  });

  test('follow-up chat receives recent context; new chat clears it without clearing ingredients', async t => {
    const contexts = [];
    const { request, store } = await fixture(t, async context => {
      contexts.push(context);
      return { intent: 'message', message: 'Ask me about your pantry.' };
    });
    store.add({ name: 'Rice', quantity: 500, unit: 'g' });
    await request('/api/chat', 'POST', { message: 'How do I cook rice?' });
    await request('/api/chat', 'POST', { message: 'Can I make that faster?' });
    assert.equal(contexts[1].history[0].content, 'How do I cook rice?');
    assert.equal(contexts[1].history[1].content, 'Ask me about your pantry.');
    const before = store.inventory();
    assert.equal((await request('/api/chat/new', 'POST', {})).status, 200);
    assert.deepEqual(store.state(), { inventory: before, messages: [] });
    await request('/api/chat', 'POST', { message: 'A fresh question.' });
    assert.deepEqual(contexts[2].history, []);
    assert.deepEqual(contexts[2].recipes, []);
    assert.deepEqual(contexts[2].pantry, before);
  });

  test('new chat cannot erase context while a model response is in flight', async t => {
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    const { request, store } = await fixture(t, async () => {
      entered();
      await pending;
      return { intent: 'message', message: 'Reply complete.' };
    });
    const reply = request('/api/chat', 'POST', { message: 'A question.' });
    await started;
    try {
      assert.equal((await request('/api/chat/new', 'POST', {})).status, 409);
      assert.equal((await request('/api/chat', 'POST', { message: 'Another question.' })).status, 409);
    } finally { release(); }
    assert.equal((await reply).status, 200);
    assert.equal(store.state().messages.length, 2);
  });
