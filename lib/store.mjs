import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function quantity(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1_000_000) {
    throw new AppError('Enter a quantity greater than zero and no more than 1,000,000.');
  }
  const scaled = Math.round(value * 1000);
  if (scaled === 0 || Math.abs(value * 1000 - scaled) > 0.000001) {
    throw new AppError('Quantities can have up to three decimal places.');
  }
  return scaled;
}

export function ingredient(input) {
  if (!input || typeof input.name !== 'string') throw new AppError('An ingredient name is required.');
  const name = input.name.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new AppError('Ingredient names must be 1-80 characters without control characters.');
  }
  if (!['g', 'ml', 'pcs'].includes(input.unit)) throw new AppError('Choose grams, millilitres, or pieces.');
  return { name, key: name.toLocaleLowerCase('en-US'), unit: input.unit, amount: quantity(input.quantity) };
}

export function createStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS ingredients (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
      unit TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount >= 0)
    );
    CREATE TABLE IF NOT EXISTS recipes (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS actions (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', result TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, payload TEXT NOT NULL
    );
  `);

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function inventory() {
    return db.prepare('SELECT * FROM ingredients WHERE amount > 0 ORDER BY name COLLATE NOCASE')
      .all().map(({ amount, name_key, ...item }) => ({ ...item, quantity: amount / 1000 }));
  }

  function addOne(input) {
    const item = ingredient(input);
    const existing = db.prepare('SELECT * FROM ingredients WHERE name_key = ?').get(item.key);
    if (existing && existing.unit !== item.unit) {
      throw new AppError(`${existing.name} is tracked in ${existing.unit}. Use that unit when restocking.`, 409);
    }
    if (existing) {
      if (existing.amount + item.amount > 1_000_000_000) throw new AppError('This restock would exceed the quantity limit.');
      db.prepare('UPDATE ingredients SET amount = amount + ? WHERE id = ?').run(item.amount, existing.id);
    } else {
      db.prepare('INSERT INTO ingredients VALUES (?, ?, ?, ?, ?)').run(
        randomUUID(), item.name, item.key, item.unit, item.amount,
      );
    }
  }

  function saveMessage(role, payload) {
    db.prepare('INSERT INTO messages(role, payload) VALUES (?, ?)').run(role, JSON.stringify(payload));
  }

  function getRecipe(id) {
    if (typeof id !== 'string' || !id) throw new AppError('A saved recipe ID is required.');
    const row = db.prepare('SELECT payload FROM recipes WHERE id = ?').get(id);
    if (!row) throw new AppError('That recipe was not found. Ask for a fresh suggestion.', 404);
    return JSON.parse(row.payload);
  }

  function createAction(kind, title, items, recipeId = null) {
    const action = { id: randomUUID(), kind, title, items, recipeId, status: 'pending' };
    db.prepare('INSERT INTO actions(id, kind, payload) VALUES (?, ?, ?)').run(
      action.id, kind, JSON.stringify(action),
    );
    return action;
  }

  function cookingReview(recipeId) {
    const recipe = getRecipe(recipeId);
    return createAction('cook', recipe.name, recipe.ingredients, recipeId);
  }

  return {
    close: () => db.close(),
    inventory,
    state() {
      const actions = new Map(db.prepare('SELECT id, status FROM actions').all().map(row => [row.id, row.status]));
      const messages = db.prepare('SELECT role, payload FROM messages ORDER BY id DESC LIMIT 60').all().reverse()
        .map(row => {
          const payload = JSON.parse(row.payload);
          if (payload.action) payload.action.status = actions.get(payload.action.id) ?? payload.action.status;
          return { role: row.role, ...payload };
        });
      return { inventory: inventory(), messages };
    },
    newChat() {
      return transaction(() => {
        db.exec('DELETE FROM messages; DELETE FROM actions; DELETE FROM recipes;');
        return { inventory: inventory(), messages: [] };
      });
    },
    history() {
      return db.prepare('SELECT role, payload FROM messages ORDER BY id DESC LIMIT 8').all().reverse()
        .map(row => ({ role: row.role, content: JSON.parse(row.payload).message }));
    },
    recentRecipes() {
      return db.prepare('SELECT payload FROM recipes ORDER BY rowid DESC LIMIT 12').all()
        .map(row => JSON.parse(row.payload));
    },
    add(input) {
      return transaction(() => { addOne(input); return inventory(); });
    },
    set(id, input) {
      const item = ingredient(input);
      if (!db.prepare('SELECT id FROM ingredients WHERE id = ?').get(id)) throw new AppError('Ingredient not found.', 404);
      const duplicate = db.prepare('SELECT id FROM ingredients WHERE name_key = ? AND id != ?').get(item.key, id);
      if (duplicate) throw new AppError('Another ingredient already has that name.', 409);
      db.prepare('UPDATE ingredients SET name = ?, name_key = ?, unit = ?, amount = ? WHERE id = ?')
        .run(item.name, item.key, item.unit, item.amount, id);
      return inventory();
    },
    remove(id) {
      const result = db.prepare('DELETE FROM ingredients WHERE id = ?').run(id);
      if (!result.changes) throw new AppError('Ingredient not found.', 404);
      return inventory();
    },
    saveRecipe(recipe) {
      const saved = { ...recipe, id: randomUUID() };
      db.prepare('INSERT INTO recipes VALUES (?, ?)').run(saved.id, JSON.stringify(saved));
      return saved;
    },
    saveMessage,
    getRecipe,
    cookingReview,
    restockReview(items) {
      if (!Array.isArray(items) || !items.length || items.length > 30) {
        throw new AppError('A restock must contain 1-30 ingredients.');
      }
      const normalized = items.map(input => {
        const item = ingredient(input);
        return { name: item.name, unit: item.unit, quantity: item.amount / 1000 };
      });
      if (new Set(normalized.map(item => item.name.toLocaleLowerCase('en-US'))).size !== normalized.length) {
        throw new AppError('Each ingredient should appear only once in a restock.');
      }
      return createAction('restock', 'Restock your pantry', normalized);
    },
    confirm(id, amounts) {
      if (typeof id !== 'string' || !id) throw new AppError('A review ID is required.');
      return transaction(() => {
        const row = db.prepare('SELECT * FROM actions WHERE id = ?').get(id);
        if (!row) throw new AppError('Review not found.', 404);
        if (row.status === 'confirmed') return { ...JSON.parse(row.result), inventory: inventory(), alreadyConfirmed: true };
        if (row.status !== 'pending') throw new AppError('This review has already been cancelled.', 409);
        const action = JSON.parse(row.payload);
        if (!Array.isArray(amounts) || amounts.length !== action.items.length) {
          throw new AppError('Review a quantity for every ingredient.');
        }
        const scaled = amounts.map(quantity);
        if (row.kind === 'cook') {
          for (const [index, item] of action.items.entries()) {
            const stock = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(item.ingredientId);
            if (!stock || stock.unit !== item.unit ||
                stock.name_key !== item.name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US') ||
                stock.amount < scaled[index]) {
              throw new AppError(`Not enough ${item.name} in the pantry. Restock or adjust the amount before confirming.`, 409);
            }
            db.prepare('UPDATE ingredients SET amount = amount - ? WHERE id = ?').run(scaled[index], stock.id);
          }
        } else {
          action.items.forEach((item, index) => addOne({ ...item, quantity: scaled[index] / 1000 }));
        }
        const result = {
          message: row.kind === 'cook' ? `Recorded ${action.title}. Only the amounts you reviewed were used.`
            : 'Restock confirmed. Your pantry is updated.',
          kind: row.kind,
        };
        db.prepare("UPDATE actions SET status = 'confirmed', result = ? WHERE id = ?").run(JSON.stringify(result), id);
        saveMessage('assistant', result);
        return { ...result, inventory: inventory() };
      });
    },
    cancel(id) {
      if (typeof id !== 'string' || !id) throw new AppError('A review ID is required.');
      const result = db.prepare("UPDATE actions SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(id);
      if (!result.changes) throw new AppError('This review is no longer pending.', 409);
      return { message: 'Review cancelled. Your pantry has not changed.' };
    },
  };
}
