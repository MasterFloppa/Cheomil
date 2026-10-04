const foods = [
  { names: ['salt'], g: 0.01, seasoning: true },
  { names: ['pepper', 'black pepper', 'white pepper'], g: 0.01, seasoning: true },
  ...['onion powder', 'garlic powder', 'cumin', 'turmeric', 'paprika', 'cinnamon', 'saffron', 'oregano', 'thyme', 'basil', 'parsley']
    .map(name => ({ names: [name], g: 0.01, seasoning: true })),
  { names: ['chilli powder', 'chili powder'], g: 0.01, seasoning: true },
  { names: ['coriander', 'cilantro'], g: 0.01, seasoning: true },
  { names: ['oil'], g: 0.5, ml: 0.5, seasoning: true },
  { names: ['butter'], g: 0.5, seasoning: true },
  { names: ['ghee'], g: 0.5, seasoning: true },
  { names: ['sugar'], g: 0.1, seasoning: true },
  { names: ['honey'], g: 0.1, seasoning: true },
  { names: ['vinegar'], ml: 0.5, seasoning: true },
  { names: ['soy sauce'], ml: 0.5, seasoning: true },
  { names: ['stock', 'broth'], ml: 10, seasoning: true },
  { names: ['garlic'], g: 1, pcs: 0.125, seasoning: true },
  { names: ['ginger'], g: 1, pcs: 0.125, seasoning: true },
  { names: ['onion'], g: 10, pcs: 0.125 },
  { names: ['tomato'], g: 10, pcs: 0.125 },
  { names: ['capsicum', 'bell pepper'], g: 10, pcs: 0.125 },
  { names: ['carrot'], g: 10, pcs: 0.125 },
  { names: ['potato'], g: 20, pcs: 0.25 },
  { names: ['rice'], g: 25 },
  { names: ['pasta'], g: 25 },
  { names: ['noodle'], g: 25 },
  { names: ['flour'], g: 20 },
  { names: ['oat'], g: 20 },
  { names: ['bread'], g: 10, pcs: 0.25 },
  { names: ['chicken'], g: 25, pcs: 0.25 },
  { names: ['fish'], g: 25, pcs: 0.25 },
  ...['beef', 'pork', 'lamb', 'mutton', 'meat'].map(name => ({ names: [name], g: 25, pcs: 0.25 })),
  { names: ['egg'], g: 20, pcs: 0.5 },
  { names: ['bean'], g: 25 },
  { names: ['chickpea'], g: 25 },
  { names: ['lentil', 'dal'], g: 25 },
  { names: ['tofu'], g: 25, pcs: 0.25 },
  { names: ['paneer'], g: 25, pcs: 0.25 },
  { names: ['cheese'], g: 5, pcs: 0.25 },
  { names: ['milk'], ml: 10 },
  { names: ['yogurt', 'yoghurt', 'curd'], g: 10, ml: 10 },
];

function normalize(text) {
  return text.normalize('NFKC').toLocaleLowerCase('en-US');
}

function forms(name) {
  const value = normalize(name);
  const variants = new Set([value]);
  if (value.endsWith('ies')) variants.add(`${value.slice(0, -3)}y`);
  else if (value.endsWith('oes')) variants.add(value.slice(0, -2));
  else if (value.endsWith('s')) variants.add(value.slice(0, -1));
  else {
    variants.add(`${value}s`);
    if (value.endsWith('o')) variants.add(`${value}es`);
  }
  return [...variants];
}

function ingredientPattern(name) {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${forms(name).map(form => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}\\p{N}])`, 'gu');
}

export function mentionsIngredient(text, name, allowNegation = false) {
  const normalized = normalize(text);
  return [...normalized.matchAll(ingredientPattern(name))].some(match => !allowNegation ||
    !/\b(?:without|no|omit|skip|avoid|do not use|do not add)\s+(?:any\s+)?$/.test(normalized.slice(0, match.index)));
}

function profile(item) {
  return foods.find(food => food.names.some(name => mentionsIngredient(item.name, name)));
}

export function minimumRecipeQuantity(item, servings = 1) {
  const rule = profile(item);
  return (rule?.[item.unit] ?? (item.unit === 'pcs' ? 0.125 : 1)) * servings;
}

export function pantryQuantityHint(item) {
  const minimum = minimumRecipeQuantity(item);
  return item.quantity < minimum
    ? `Too little for recipe use (minimum ${minimum} ${item.unit} per serving). Check the quantity and unit.`
    : '';
}

export function foodPortions(items) {
  return items.reduce((total, item) => {
    if (profile(item)?.seasoning || item.quantity < minimumRecipeQuantity(item)) return total;
    return total + item.quantity / (item.unit === 'pcs' ? 1 : item.unit === 'ml' ? 100 : 50);
  }, 0);
}

export function untrackedRecipeText(recipe) {
  let text = normalize([recipe.name, recipe.description ?? '', ...(recipe.steps ?? [])].join(' '));
  for (const item of [...recipe.ingredients].sort((a, b) => b.name.length - a.name.length)) {
    for (const name of [item.name, ...(profile(item)?.names ?? [])]) {
      text = text.replace(ingredientPattern(name), '#');
    }
  }
  return text;
}

export function recipeIssue(recipe) {
  const servings = recipe.servings ?? 1;
  for (const item of recipe.ingredients) {
    const minimum = minimumRecipeQuantity(item, servings);
    if (item.quantity < minimum) {
      return `${item.name}: ${item.quantity} ${item.unit} is too little for ${servings} serving(s). Use at least ${minimum} ${item.unit}, or omit it completely.`;
    }
  }
  if (foodPortions(recipe.ingredients) + 1e-9 < servings) {
    return 'There is not enough substantial food for the stated servings. Reduce the serving count or ask what needs restocking; do not present scraps or seasonings as a meal.';
  }
  const text = untrackedRecipeText(recipe);
  for (const food of foods) {
    for (const name of food.names) {
      // Bell peppers are vegetables, not an implicit supply of pepper seasoning.
      const checkedText = name === 'pepper' ? text.replace(/bell peppers?/gi, '') : text;
      if (mentionsIngredient(checkedText, name, true)) {
        return `The recipe mentions ${name} without a tracked ingredient amount. Omit it or use an ingredient actually available in the pantry.`;
      }
    }
  }
  return '';
}
