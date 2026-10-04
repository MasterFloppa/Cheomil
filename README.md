# Cheomil

**Good food, already at home.** A local-first cooking companion built for a friend who wants to turn the ingredients at home into meals, without losing track of what remains.

## Run on Windows

Prerequisites: Node.js 24.12 or newer, Ollama, and the Gemma 3 4B model.

```powershell
git clone https://github.com/MasterFloppa/Cheomil.git
Set-Location Cheomil
ollama pull gemma3:4b
npm start
```

Open **http://127.0.0.1:3000**. Ollama must be running at `http://127.0.0.1:11434`.

The production app has **no npm runtime dependencies**. `npm install` is only required for the optional Edge browser test.

## The everyday loop

1. Enter the ingredients you have, including their quantities. Use **g**, **ml**, or **pcs**. Adding an existing ingredient tops up its stock.
2. Ask a question such as "What can I make for lunch?" The local model proposes recipes with pantry ingredient references, quantities, serving counts, and cooking steps.
3. Say "I cooked [dish name]" or select **I cooked this**. Review the total amounts actually used, edit if necessary, and confirm. Only those amounts are deducted.
4. Say "I bought 1 kg rice and 6 eggs." Review and confirm the restock. Ambiguous or missing purchase quantities should prompt a clarification rather than invented stock.

Inventory, recipes, conversation history, and reviews are stored in `data\pantry.sqlite`. Reloading or restarting the app does not erase them. Empty ingredients disappear from the visible pantry and can be restocked later.

The page stays within the viewport: the ingredient list and conversation scroll independently, while the chat composer stays in place. On small screens the panels stack; the pantry panel also scrolls when needed to keep its form accessible.

Chat supports follow-up questions using the most recent eight messages and saved recipe suggestions. **New chat** deletes the old conversation, saved suggestions, and reviews rather than archiving them, so the model starts with fresh conversation memory. Your ingredient inventory and any previously confirmed inventory changes stay intact. Starting over is blocked while a reply is in progress.

Cooking and chat-based restocking **never mutate inventory before confirmation**. Confirmation is transactional and idempotent: a double-click or retry cannot apply the same review twice. A stale review is rejected if an ingredient is missing, has incompatible units, or no longer has enough stock. Multiple recipe suggestions are alternatives, not a combined meal plan.

## Why open innovation matters

Gemma is an **open-weight** model, not a fully open-source model. Its local weights are served by the open-source Ollama runtime. This meets the challenge's explicit open-weight model option.

The AI is central to the app: it interprets natural-language pantry requests, creates pantry-grounded recipes, and identifies cooked dishes from saved suggestions. Ordinary inventory arithmetic and approval remain deterministic application logic rather than trusting an LLM to update the database.

After the model is downloaded, recipe/chat inference runs locally without a cloud AI key or an internet connection. Pantry data is not sent to a remote model provider. The model can be swapped through an environment variable. Local inference trades cloud dependency for your machine's memory, electricity, and CPU/GPU time; it is not universally cost-free.

Gemma's [terms](https://ai.google.dev/gemma/terms) govern the model; this application's MIT license does not change those terms. [Ollama](https://github.com/ollama/ollama) is MIT-licensed. The interface uses the Clawpilot theme supplied by the local web-artifacts-builder skill; that skill/theme is prior art, not an original visual system.

The panda-chef illustration was supplied for this project and is used as the header logo and browser favicon.

## Architecture

- Native Node.js HTTP server, bound to loopback only.
- Node's built-in SQLite driver for persistent local state.
- Ollama `/api/chat` with a constrained JSON response schema.
- Each generated recipe includes a complete pantry quantity ledger, explicitly setting unused ingredients to zero. The app displays and deducts only the positive amounts.
- Server-side recipe validation: ingredient names must match the pantry, appear only once, and requested quantities cannot exceed the supplied stock. Names are resolved to database IDs by the app, not the model.
- Names, descriptions, and steps are checked for untracked pantry ingredients and common foods, including unavailable oil, butter, and spices. One corrective model pass is allowed for invalid drafts; a second failure is shown explicitly.
- Conservative recipe-use guides reject token amounts of main ingredients, scale quantities with servings, and omit stock below the guide in the generation schema. For example, Onion needs at least 10 g per serving: 2 g is omitted, not treated as two onions. Small seasoning amounts remain valid. Pantry warnings make likely quantity/unit mistakes visible without silently converting units.
- Scraps and seasonings alone cannot be presented as meals, and serving counts must have enough substantial food. These are sanity heuristics, not nutritional requirements or a complete culinary database. A saved suggestion that fails the current checks is marked for replacement and cannot create a new cooking review.
- Restock amounts must match a verbatim numeric quantity from the user's current message, including deterministic kg/litre conversion. Existing stock cannot be silently treated as a new purchase.
- Explicit purchase/restock requests without numeric amounts receive an application-generated clarification before inference, preventing invented additions or misleading success claims.
- Atomic, independently validated review confirmations with integer thousandths for quantity arithmetic.
- Vanilla JavaScript interface with light/dark themes, responsive layout, accessible labels, and no external assets or CDN requirements.

Model instructions also prohibit assumed oil, spices, or other ingredients; only tap water and ordinary kitchen equipment are free resources. Natural-language instructions remain AI-generated: the structural ingredient checks cannot prove every sentence is correct. Review recipes for suitability, allergies, and food safety.

This is a **single-person, single-device app**, not an internet-facing multi-user service. Do not expose it with a public tunnel without adding authentication and deployment hardening. Node's SQLite API is still marked experimental in the installed Node version.

## Configuration

Set environment variables in the same PowerShell session before starting:

```powershell
$env:PORT = '3000'
$env:OLLAMA_MODEL = 'gemma3:4b'
$env:OLLAMA_URL = 'http://127.0.0.1:11434'
# Optional: put the database in another directory.
$env:PANTRY_DATA_DIR = 'F:\CheomilData'
npm start
```

By default the model uses an 8K context window and up to 2,200 output tokens. CPU inference can take a minute or more; each model pass times out after three minutes with a visible error. A corrective pass can extend the total request time. The UI prevents overlapping chat requests. Use numeric digits for restock quantities.

## Checks

```powershell
npm test
npm install
npm run test:browser
# Optional: the same Edge end-to-end flow using the actual local model.
$env:LIVE_AI = '1'
npm run test:browser
# Optional: mixed-pantry lunch, missing quantities, and multi-item kg conversion.
npm run test:ai
```

Browser checks use **Microsoft Edge only**, temporary in-memory data, and never alter your actual pantry. Screenshots are written under `test-results\`.

## Challenge submission

Built for the [Hacktoberfest Weekend Challenge: Build for a Friend](https://dev.to/challenges/hacktoberfest-weekend-2026-10-01).

Source: [MasterFloppa/Cheomil](https://github.com/MasterFloppa/Cheomil).

A submission still needs a DEV post, demo, explanation of the real friend's problem, and ideally their feedback after using it. Required tags: `devchallenge`, `weekendchallenge`, `hf26challenge`. Potential partner categories are **Best Use of Gemma** and **Best Use of GitHub Copilot**, if the final write-up documents their use.

The deadline is **October 5, 2026, 12:29 PM IST**. Any commits after that deadline must be disclosed here. Do not publish pantry data, database files, account tokens, or private agent conversations.
