import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { createStore } from '../lib/store.mjs';
import { createAI } from '../lib/ai.mjs';
import { createApp } from '../server.mjs';

const live = process.env.LIVE_AI === '1';
const store = createStore(':memory:');
const fakeAI = {
  health: async () => ({ available: true, model: 'test-model' }),
  chat: async ({ message, pantry, recipes }) => {
    if (message.includes('bought')) return { intent: 'restock', message: 'Review groceries.', restock: [{ name: 'Rice', quantity: 500, unit: 'g', source_text: '500 g rice' }] };
    if (message.includes('cooked')) return { intent: 'cook', message: 'Review cooking.', recipe_id: recipes[0].id };
    return { intent: 'suggest', message: 'One simple meal.',
      recipes: [{ name: 'Steamed rice', description: 'Rice with water.', minutes: 20, servings: 1,
        ingredients: [{ name: pantry[0].name, quantity: 100 }], steps: ['Simmer the rice in water until cooked.'] }] };
  },
};
const server = createApp({ store, ai: live ? createAI() : fakeAI });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const base = `http://127.0.0.1:${server.address().port}`;

async function chat(message) {
  await page.locator('#chat-input').fill(message);
  const reply = page.waitForResponse(response => response.url().endsWith('/api/chat') && response.request().method() === 'POST', { timeout: 400000 });
  await page.getByRole('button', { name: 'Send message' }).click();
  const response = await reply;
  const payload = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(payload));
  await page.locator('#send-button').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#send-button').disabled);
  return payload;
}

async function checkInternalScrolling(viewport) {
  await page.setViewportSize(viewport);
  await page.locator('.recipe-card details').evaluateAll(details => details.forEach(node => { node.open = false; }));
  const before = await page.locator('.workspace').boundingBox();
  await page.locator('.recipe-card details').evaluateAll(details => details.forEach(node => { node.open = true; }));
  assert.deepEqual(await page.locator('.workspace').boundingBox(), before);
  const geometry = await page.evaluate(() => {
    const workspace = document.querySelector('.workspace');
    const inventory = document.querySelector('#inventory');
    const chat = document.querySelector('#chat-scroll');
    const composer = document.querySelector('#chat-form').getBoundingClientRect();
    return {
      documentHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight,
      documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
      workspaceBottom: workspace.getBoundingClientRect().bottom, workspaceScroll: workspace.scrollTop,
      inventoryHeight: inventory.clientHeight, inventoryOverflow: inventory.scrollHeight > inventory.clientHeight,
      chatHeight: chat.clientHeight, chatOverflow: chat.scrollHeight > chat.clientHeight,
      composerTop: composer.top, composerBottom: composer.bottom, pageScroll: scrollY,
    };
  });
  assert.ok(geometry.documentHeight <= geometry.viewportHeight, JSON.stringify(geometry));
  assert.ok(geometry.documentWidth <= geometry.viewportWidth, JSON.stringify(geometry));
  assert.ok(geometry.workspaceBottom <= geometry.viewportHeight);
  assert.equal(geometry.workspaceScroll, 0);
  assert.equal(geometry.pageScroll, 0);
  assert.ok(geometry.inventoryHeight >= 96 && geometry.inventoryOverflow, JSON.stringify(geometry));
  assert.ok(geometry.chatHeight > 32 && geometry.chatOverflow, JSON.stringify(geometry));
  assert.ok(geometry.composerTop >= 0 && geometry.composerBottom <= geometry.viewportHeight, JSON.stringify(geometry));

  await page.locator('#chat-scroll').evaluate(node => { node.scrollTop = 0; });
  await page.locator('#chat-scroll').hover();
  await page.mouse.wheel(0, 300);
  await page.waitForFunction(() => document.querySelector('#chat-scroll').scrollTop > 0);
  const chatPosition = await page.locator('#chat-scroll').evaluate(node => node.scrollTop);
  await page.locator('#inventory').evaluate(node => { node.scrollTop = 0; });
  await page.locator('#inventory').hover();
  await page.mouse.wheel(0, 300);
  await page.waitForFunction(() => document.querySelector('#inventory').scrollTop > 0);
  assert.equal(await page.locator('#chat-scroll').evaluate(node => node.scrollTop), chatPosition);
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  assert.equal(await page.locator('.workspace').evaluate(node => node.scrollTop), 0);
  await page.getByRole('button', { name: 'Send message' }).scrollIntoViewIfNeeded();
  assert.equal(await page.locator('.workspace').evaluate(node => node.scrollTop), 0);
}

try {
  await page.goto(`${base}/?scoutTheme=light`);
  await page.waitForFunction(() => {
    const logo = document.querySelector('.brand-mark');
    return logo instanceof HTMLImageElement && logo.complete && logo.naturalWidth > 0;
  });
  const iconPath = await page.locator('link[rel="icon"]').getAttribute('href');
  assert.equal(iconPath, '/panda-chef.jpg');
  const iconResponse = await page.request.get(`${base}${iconPath}`);
  assert.equal(iconResponse.status(), 200);
  assert.equal(iconResponse.headers()['content-type'], 'image/jpeg');
  assert.equal(await page.title(), 'Cheomil | Good food, already at home');
  assert.equal(await page.getByRole('link', { name: 'Cheomil home' }).textContent(), 'Cheomil');
  assert.equal(await page.locator('.pantry-footnote, .composer-caption, .add-section > p').count(), 0);
  await page.getByText('Local AI ready', { exact: true }).waitFor();
  await page.locator('#ingredient-name').fill('Rice');
  await page.locator('#ingredient-quantity').fill('500');
  await page.getByRole('button', { name: '+ Add to pantry', exact: true }).click();
  await page.locator('.inventory-item[data-name="Rice"]').waitFor();
  assert.equal(store.inventory()[0].quantity, 500);
  await page.reload();
  await page.locator('.inventory-item[data-name="Rice"]').waitFor();
  const suggestion = await chat('Suggest exactly one simple lunch for one person with rice and tap water. Use 100 g rice from my pantry.');
  assert.equal(suggestion.recipes.length, 1);
  assert.equal(store.inventory()[0].quantity, 500);
  await page.locator('.recipe-card').waitFor();
  assert.ok(await page.getByText('Cheomil', { exact: true }).count() > 0);
  await page.getByText('How to make it', { exact: true }).click();
  assert.ok(await page.locator('.recipe-card li').count() > 0);
  const cooking = await chat(`I cooked ${suggestion.recipes[0].name}.`);
  assert.equal(cooking.action.kind, 'cook');
  assert.equal(store.inventory()[0].quantity, 500);
  const review = page.locator(`.review-card[data-action-id="${cooking.action.id}"]`);
  await review.locator('input').first().fill('90');
  await review.getByRole('button', { name: 'Confirm cooking', exact: true }).click();
  await review.getByText('Confirmed. Pantry updated.', { exact: true }).waitFor();
  assert.equal(store.inventory()[0].quantity, 410);
  const restock = await chat('I bought 500 g rice. Add it to my pantry.');
  assert.equal(restock.action.kind, 'restock');
  assert.equal(store.inventory()[0].quantity, 410);
  const restockReview = page.locator(`.review-card[data-action-id="${restock.action.id}"]`);
  await restockReview.getByRole('button', { name: 'Confirm restock', exact: true }).click();
  await restockReview.getByText('Confirmed. Pantry updated.', { exact: true }).waitFor();
  assert.equal(store.inventory()[0].quantity, 910);
  await page.getByRole('button', { name: 'Edit Rice', exact: true }).click();
  await page.locator('#edit-quantity').fill('1000');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.locator('#edit-dialog').waitFor({ state: 'hidden' });
  assert.equal(store.inventory()[0].quantity, 1000);
  await page.reload();
  await page.locator('.inventory-item[data-name="Rice"]').waitFor();
  assert.ok((await page.locator('.inventory-item').textContent()).includes('1,000'));
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: `test-results/${live ? 'live' : 'fixture'}-desktop.png`, fullPage: true });
  await page.getByRole('button', { name: 'Switch color theme' }).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `test-results/${live ? 'live' : 'fixture'}-mobile.png`, fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);

  store.add({ name: 'Onion', quantity: 2, unit: 'g' });
  for (let index = 0; index < 39; index++) store.add({ name: `Ingredient ${index}`, quantity: 100, unit: 'g' });
  const recipe = store.recentRecipes()[0];
  store.saveMessage('assistant', { message: 'An old suggestion.', recipes: [{
    ...recipe, name: 'Rice with onion', ingredients: [
      ...recipe.ingredients, { ingredientId: 'old-onion', name: 'Onion', quantity: 1, unit: 'g' },
    ],
  }] });
  for (let index = 0; index < 12; index++) {
    store.saveMessage('assistant', { message: `Meal suggestion ${index + 1}.`, recipes: [{
      ...recipe, steps: Array.from({ length: 12 }, () => 'Cook the rice gently in tap water until tender. Check it regularly and serve when fully cooked.'),
    }] });
  }
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.inventory-item').length === 41);
  await page.locator('.inventory-item[data-name="Onion"]').getByText(/Too little/).waitFor();
  const old = page.locator('.recipe-card').filter({ hasText: 'This saved suggestion needs replacing:' });
  assert.equal(await old.count(), 1);
  assert.equal(await old.getByRole('button', { name: 'I cooked this' }).isDisabled(), true);
  await page.setViewportSize({ width: 2000, height: 1000 });
  const wideFrame = await page.locator('.workspace').boundingBox();
  assert.equal(wideFrame.width, 1968);
  assert.equal(wideFrame.x, 16);
  assert.equal(wideFrame.y, 76);
  for (const viewport of [
    { width: 1440, height: 1100 }, { width: 1280, height: 720 },
    { width: 390, height: 844 }, { width: 390, height: 600 }, { width: 844, height: 390 },
  ]) await checkInternalScrolling(viewport);
  const beforeNewChat = store.inventory();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.locator('#welcome').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#messages').textContent(), '');
  assert.deepEqual(store.inventory(), beforeNewChat);
  assert.deepEqual(store.history(), []);
  assert.deepEqual(store.recentRecipes(), []);
  await page.reload();
  await page.locator('#welcome').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.inventory-item').count(), 41);
  assert.equal(await page.locator('#messages').textContent(), '');
  assert.deepEqual(errors, []);
  console.log(`Edge ${live ? 'LIVE GEMMA' : 'fixture'} passed: pantry entry, reload, recipes, chat cooking, adjusted confirmation, restock, editing, themes, mobile layout, and independent scrolling without page expansion.`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  store.close();
}
