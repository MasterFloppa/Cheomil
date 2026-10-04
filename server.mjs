import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createStore, AppError } from './lib/store.mjs';
import { createAI, validateRecipe, validateRestock } from './lib/ai.mjs';
import { recipeIssue } from './public/recipe-rules.js';

const root = dirname(fileURLToPath(import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/recipe-rules.js', ['recipe-rules.js', 'text/javascript; charset=utf-8']],
  ['/panda-chef.jpg', ['Panda chef.jpg', 'image/jpeg']],
]);
const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');
const themeScript = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\r\n?/g, '\n');
const themeHash = createHash('sha256').update(themeScript).digest('base64');

async function readJSON(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw new AppError('Send JSON with Content-Type: application/json.', 415);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new AppError('Request is too large.', 413);
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('Request contains invalid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('Request body must be a JSON object.');
  return body;
}

export function createApp({ store, ai }) {
  let chatting = false;
  function cookingReview(id) {
    const issue = recipeIssue(store.getRecipe(id));
    if (issue) throw new AppError(`That saved suggestion needs replacing: ${issue} Ask for a fresh recipe.`, 409);
    return store.cookingReview(id);
  }
  return createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'sha256-${themeHash}'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    try {
      const host = request.headers.host;
      if (!host || !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) {
        throw new AppError('This app only accepts local requests.', 403);
      }
      if (request.headers.origin && request.headers.origin !== `http://${host}`) {
        throw new AppError('Cross-origin requests are not permitted.', 403);
      }
      const path = new URL(request.url, `http://${host}`).pathname;
      const method = request.method;
      if (method === 'GET' && assets.has(path)) {
        const [name, type] = assets.get(path);
        response.writeHead(200, { 'Content-Type': type });
        response.end(readFileSync(join(root, 'public', name)));
        return;
      }
      if (method === 'GET' && path === '/api/state') return send(200, store.state());
      if (method === 'GET' && path === '/api/health') return send(200, await ai.health());
      if (method === 'POST' && path === '/api/ingredients') {
        return send(201, { inventory: store.add(await readJSON(request)) });
      }
      const itemMatch = path.match(/^\/api\/ingredients\/([a-f0-9-]{36})$/);
      if (itemMatch && method === 'PATCH') return send(200, { inventory: store.set(itemMatch[1], await readJSON(request)) });
      if (itemMatch && method === 'DELETE') return send(200, { inventory: store.remove(itemMatch[1]) });
      if (method === 'POST' && path === '/api/cooking-review') {
        const body = await readJSON(request);
        const action = cookingReview(body.recipeId);
        const payload = { message: `Review what you used for ${action.title}. Adjust the amounts if needed, then confirm.`, action };
        store.saveMessage('assistant', payload);
        return send(200, payload);
      }
      if (method === 'POST' && path === '/api/confirm') {
        const body = await readJSON(request);
        return send(200, store.confirm(body.actionId, body.quantities));
      }
      if (method === 'POST' && path === '/api/cancel') {
        const body = await readJSON(request);
        return send(200, store.cancel(body.actionId));
      }
      if (method === 'POST' && path === '/api/chat/new') {
        await readJSON(request);
        if (chatting) throw new AppError('Wait for the current reply before starting a new chat.', 409);
        return send(200, store.newChat());
      }
      if (method === 'POST' && path === '/api/chat') {
        const body = await readJSON(request);
        if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 2000) {
          throw new AppError('Write a message of 1-2,000 characters.');
        }
        if (chatting) throw new AppError('The local model is answering another message. Please wait.', 409);
        chatting = true;
        try {
          const pantry = store.inventory();
          const message = body.message.trim();
          const purchaseWithoutAmounts = !/\d/.test(message) &&
            /\b(?:i|we)\s+(?:(?:have|just)\s+){0,2}(?:bought|purchased)\b|^(?:please\s+)?(?:restock\b|add\b.*\b(?:pantry|inventory)\b)/i.test(message);
          if (purchaseWithoutAmounts) {
            const payload = { message: 'How much of each ingredient did you buy? Use numeric quantities, such as "1 kg rice and 6 eggs". Nothing has been added; you will review and confirm the restock first.' };
            store.saveMessage('user', { message });
            store.saveMessage('assistant', payload);
            return send(200, payload);
          }
          const context = { message, pantry, recipes: store.recentRecipes(), history: store.history() };
          let result, feedback, previous, validatedRecipes, validatedRestock;
          for (let attempt = 0; attempt < 2; attempt++) {
            result = await ai.chat({ ...context, feedback, previous });
            try {
              if (!result || !['suggest', 'restock', 'cook', 'message'].includes(result.intent) ||
                  typeof result.message !== 'string' || !result.message.trim() || result.message.length > 4000) {
                throw new AppError('The model returned an invalid reply. Please retry.', 502);
              }
              if (result.intent === 'suggest') {
                if (!Array.isArray(result.recipes) || !result.recipes.length || result.recipes.length > 3) {
                  throw new AppError('The model did not provide a complete suggestion. Please retry.', 502);
                }
                validatedRecipes = result.recipes.map(recipe => validateRecipe(recipe, pantry));
              } else if (result.intent === 'restock') {
                validatedRestock = validateRestock(result.restock, message);
              }
              break;
            } catch (error) {
              if (!(error instanceof AppError) || error.status !== 502 || attempt === 1) throw error;
              console.warn('[Cheomil] Correcting model draft:', error.message);
              feedback = error.message;
              previous = result;
            }
          }
          const payload = { message: result.message };
          if (result.intent === 'suggest') {
            payload.recipes = validatedRecipes.map(recipe => store.saveRecipe(recipe));
          } else if (result.intent === 'cook') {
            if (typeof result.recipe_id !== 'string' || !result.recipe_id) throw new AppError('Please specify which suggested dish you cooked.');
            payload.action = cookingReview(result.recipe_id);
            payload.message = `Review the ingredients used for ${payload.action.title}. Nothing will be deducted until you confirm.`;
          } else if (result.intent === 'restock') {
            payload.action = store.restockReview(validatedRestock);
            payload.message = 'Review your groceries and amounts. Nothing will be added until you confirm.';
          }
          store.saveMessage('user', { message });
          store.saveMessage('assistant', payload);
          return send(200, payload);
        } finally {
          chatting = false;
        }
      }
      throw new AppError('Route not found.', 404);
    } catch (error) {
      if (!(error instanceof AppError) || error.status >= 500) console.error('[Cheomil]', error);
      send(error instanceof AppError ? error.status : 500, {
        error: error instanceof AppError ? error.message : 'An unexpected server error occurred. Check the server console.',
      });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dataDirectory = process.env.PANTRY_DATA_DIR || join(root, 'data');
  mkdirSync(dataDirectory, { recursive: true });
  const store = createStore(join(dataDirectory, 'pantry.sqlite'));
  const ai = createAI({ url: process.env.OLLAMA_URL || 'http://127.0.0.1:11434', model: process.env.OLLAMA_MODEL || 'gemma3:4b' });
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const server = createApp({ store, ai });
  server.listen(port, '127.0.0.1', () => console.log(`Cheomil: http://127.0.0.1:${port} | model: ${ai.model}`));
  const shutdown = () => server.close(() => { store.close(); process.exit(0); });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
