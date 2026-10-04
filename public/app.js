import { pantryQuantityHint, recipeIssue } from './recipe-rules.js';

const $ = selector => document.querySelector(selector);
let pantry = [];
let busy = false;
let noticeTimer;
const formatQuantity = value => new Intl.NumberFormat('en', { maximumFractionDigits: 3 }).format(value);

function scrollChatTo(node, block = 'start') {
  if (!node) return;
  const chat = $('#chat-scroll');
  const target = node.getBoundingClientRect();
  const top = chat.scrollTop + target.top - chat.getBoundingClientRect().top;
  chat.scrollTo({ top: block === 'center' ? top - (chat.clientHeight - target.height) / 2 : top, behavior: 'smooth' });
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function notify(message, error = false) {
  const notice = $('#notice');
  notice.textContent = message;
  notice.className = `notice${error ? ' error' : ''}`;
  notice.setAttribute('role', error ? 'alert' : 'status');
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, error ? 12000 : 5000);
}

async function api(path, method = 'GET', body) {
  const response = await fetch(path, {
    method,
    ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

function setBusy(value) {
  busy = value;
  $('#thinking').hidden = !value;
  $('#send-button').disabled = value;
  $('#chat-input').disabled = value;
  $('#new-chat').disabled = value;
  document.querySelectorAll('.chip').forEach(button => { button.disabled = value; });
}

function renderInventory(items) {
  pantry = items;
  $('#pantry-count').textContent = String(items.length);
  $('#pantry-summary').textContent = items.length ? `${items.length} ingredient${items.length === 1 ? '' : 's'} ready for your next meal.` : 'Your kitchen, ready to fill.';
  const list = $('#inventory');
  list.replaceChildren();
  if (!items.length) {
    const empty = element('div', 'empty-pantry');
    empty.append(element('strong', '', 'Every good meal starts somewhere.'), element('p', '', 'Add what you have below, or tell me your groceries with amounts in chat.'));
    list.append(empty);
  }
  for (const item of items) {
    const row = element('div', 'inventory-item');
    row.dataset.name = item.name;
    const details = element('div', 'ingredient-details');
    details.append(element('strong', '', item.name), element('span', '', `${formatQuantity(item.quantity)} ${item.unit}`));
    const hint = pantryQuantityHint(item);
    if (hint) details.append(element('p', 'quantity-warning', hint));
    const tools = element('div', 'item-tools');
    const edit = element('button', '', 'Edit');
    edit.setAttribute('aria-label', `Edit ${item.name}`);
    edit.addEventListener('click', () => {
      const form = $('#edit-form');
      form.elements.id.value = item.id;
      form.elements.name.value = item.name;
      form.elements.quantity.value = item.quantity;
      form.elements.unit.value = item.unit;
      $('#edit-dialog').showModal();
    });
    const remove = element('button', '', 'Remove');
    remove.setAttribute('aria-label', `Remove ${item.name}`);
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Remove all ${item.name} from your pantry?`)) return;
      try {
        remove.disabled = true;
        const result = await api(`/api/ingredients/${item.id}`, 'DELETE');
        renderInventory(result.inventory);
        notify(`${item.name} removed.`);
      } catch (error) { notify(error.message, true); } finally { remove.disabled = false; }
    });
    tools.append(edit, remove);
    row.append(element('span', 'ingredient-symbol', item.name.slice(0, 2)), details, tools);
    list.append(row);
  }
}

function renderRecipe(recipe, index) {
  const card = element('article', 'recipe-card');
  const top = element('div', 'recipe-top');
  top.append(element('span', 'recipe-number', `RECIPE ${String(index + 1).padStart(2, '0')}`),
    element('span', 'recipe-meta', `${recipe.minutes} min / ${recipe.servings} serving${recipe.servings === 1 ? '' : 's'}`));
  card.append(top, element('h3', '', recipe.name), element('p', '', recipe.description));
  const ingredients = element('div', 'recipe-ingredients');
  for (const item of recipe.ingredients) {
    ingredients.append(element('span', 'ingredient-tag', `${item.name} / ${formatQuantity(item.quantity)} ${item.unit}`));
  }
  const details = element('details');
  details.append(element('summary', '', 'How to make it'));
  const steps = element('ol');
  for (const step of recipe.steps) steps.append(element('li', '', step));
  details.append(steps);
  const bottom = element('div', 'recipe-bottom');
  const cook = element('button', 'button primary', 'I cooked this');
  const issue = recipeIssue(recipe);
  if (issue) {
    card.append(element('p', 'quantity-warning', `This saved suggestion needs replacing: ${issue} Ask for a fresh recipe.`));
    cook.disabled = true;
    cook.title = issue;
  }
  cook.addEventListener('click', async () => {
    cook.disabled = true;
    try {
      await api('/api/cooking-review', 'POST', { recipeId: recipe.id });
      await refresh();
      scrollChatTo($('#messages').lastElementChild, 'center');
    } catch (error) { notify(error.message, true); } finally { cook.disabled = false; }
  });
  bottom.append(element('span', 'tiny', 'Uses only your pantry. Stock stays unchanged until you confirm.'), cook);
  card.append(ingredients, details, bottom);
  return card;
}

function renderReview(action) {
  const card = element('section', 'review-card');
  card.dataset.actionId = action.id;
  card.append(element('div', 'section-label', action.kind === 'cook' ? 'BEFORE WE UPDATE YOUR PANTRY' : 'A LITTLE PANTRY TOP-UP'),
    element('h3', '', action.title),
    element('p', '', action.kind === 'cook' ? 'These are the total amounts used, not your remaining stock. Adjust to what you actually cooked.'
      : 'Check the quantities you bought. These will be added to your existing stock.'));
  if (action.status !== 'pending') {
    card.append(element('div', `review-status ${action.status === 'cancelled' ? 'cancelled' : ''}`,
      action.status === 'confirmed' ? 'Confirmed. Pantry updated.' : 'Cancelled. Pantry unchanged.'));
    return card;
  }
  const form = element('form');
  const rows = element('div', 'review-rows');
  const inputs = [];
  action.items.forEach((item, index) => {
    const row = element('div', 'review-row');
    const input = element('input');
    input.type = 'number';
    input.min = '0.001';
    input.max = '1000000';
    input.step = '0.001';
    input.required = true;
    input.value = String(item.quantity);
    input.id = `${action.id}-${index}`;
    const label = element('label', '', item.name);
    label.htmlFor = input.id;
    if (action.kind === 'cook') {
      const available = pantry.find(stock => stock.id === item.ingredientId);
      const current = element('div', 'tiny', `In pantry: ${formatQuantity(available?.quantity ?? 0)} ${item.unit}`);
      label.append(current);
    }
    row.append(label, input, element('span', '', item.unit));
    rows.append(row);
    inputs.push(input);
  });
  const actions = element('div', 'review-actions');
  const confirm = element('button', 'button primary', action.kind === 'cook' ? 'Confirm cooking' : 'Confirm restock');
  confirm.type = 'submit';
  const cancel = element('button', 'button', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', async () => {
    cancel.disabled = true;
    try { await api('/api/cancel', 'POST', { actionId: action.id }); await refresh(); notify('Cancelled. Pantry unchanged.'); }
    catch (error) { notify(error.message, true); } finally { cancel.disabled = false; }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    confirm.disabled = true;
    cancel.disabled = true;
    try {
      const result = await api('/api/confirm', 'POST', { actionId: action.id, quantities: inputs.map(input => Number(input.value)) });
      await refresh();
      notify(result.message);
    } catch (error) { notify(error.message, true); } finally { confirm.disabled = false; cancel.disabled = false; }
  });
  actions.append(confirm, cancel);
  form.append(rows, actions);
  card.append(form);
  return card;
}

function appendMessage(message) {
  const node = element('div', `message ${message.role || 'assistant'}`);
  node.append(element('div', 'message-heading', message.role === 'user' ? 'You' : 'Cheomil'), element('p', '', message.message));
  if (message.recipes) {
    const grid = element('div', 'recipe-grid');
    message.recipes.forEach((recipe, index) => grid.append(renderRecipe(recipe, index)));
    node.append(grid);
  }
  if (message.action) node.append(renderReview(message.action));
  $('#messages').append(node);
}

async function refresh() {
  const state = await api('/api/state');
  renderInventory(state.inventory);
  $('#messages').replaceChildren();
  state.messages.forEach(appendMessage);
  $('#welcome').hidden = state.messages.length > 0;
}

async function checkHealth() {
  const status = $('#ai-status');
  status.textContent = 'Checking local AI...';
  try {
    const health = await api('/api/health');
    status.textContent = health.available ? 'Local AI ready' : 'Local AI offline';
    status.className = `ai-status ${health.available ? 'ready' : 'offline'}`;
    status.title = `${health.model}: ${health.message}`;
    if (!health.available) notify(health.message, true);
  } catch (error) {
    status.textContent = 'Connection unavailable';
    status.className = 'ai-status offline';
    notify(error.message, true);
  }
}

$('#ingredient-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const result = await api('/api/ingredients', 'POST', {
      name: form.elements.name.value, quantity: Number(form.elements.quantity.value), unit: form.elements.unit.value,
    });
    renderInventory(result.inventory);
    notify('Ingredient added to your pantry.');
    form.reset();
    $('#ingredient-name').focus();
  } catch (error) { notify(error.message, true); } finally { button.disabled = false; }
});

$('#edit-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await api(`/api/ingredients/${form.elements.id.value}`, 'PATCH', {
      name: form.elements.name.value, quantity: Number(form.elements.quantity.value), unit: form.elements.unit.value,
    });
    renderInventory(result.inventory);
    $('#edit-dialog').close();
    notify('Pantry item updated.');
  } catch (error) { notify(error.message, true); } finally { button.disabled = false; }
});
$('#close-edit').addEventListener('click', () => $('#edit-dialog').close());

$('#chat-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const input = $('#chat-input');
  const message = input.value.trim();
  if (!message) return;
  $('#welcome').hidden = true;
  appendMessage({ role: 'user', message });
  input.value = '';
  setBusy(true);
  scrollChatTo($('#thinking'), 'center');
  try {
    await api('/api/chat', 'POST', { message });
    await refresh();
    scrollChatTo($('#messages').lastElementChild);
  } catch (error) {
    notify(error.message, true);
    input.value = message;
    try { await refresh(); } catch (refreshError) { notify(refreshError.message, true); }
  } finally {
    setBusy(false);
    input.focus({ preventScroll: true });
  }
});
$('#chat-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('#chat-form').requestSubmit();
  }
});
document.querySelectorAll('.chip').forEach(button => {
  button.addEventListener('click', () => {
    if (busy) return;
    $('#chat-input').value = button.dataset.prompt;
    $('#chat-form').requestSubmit();
  });
});
$('#ai-status').addEventListener('click', checkHealth);
$('#new-chat').addEventListener('click', async () => {
  if (busy) return;
  const button = $('#new-chat');
  button.disabled = true;
  try {
    await api('/api/chat/new', 'POST', {});
    await refresh();
    $('#chat-input').value = '';
    $('#chat-scroll').scrollTop = 0;
    $('#chat-input').focus({ preventScroll: true });
    notify('New chat started. Chat memory cleared; your pantry is unchanged.');
  } catch (error) { notify(error.message, true); } finally { button.disabled = false; }
});
$('#theme-toggle').addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  const url = new URL(window.location.href);
  url.searchParams.set('scoutTheme', theme);
  window.history.replaceState(null, '', url);
});

await Promise.all([
  refresh().catch(error => notify(error.message, true)),
  checkHealth(),
]);
