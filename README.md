# Recipe Box

A personal recipe box, live at **https://shaanvaidya.github.io/recipe-box/**.

Static vanilla HTML/CSS/JS on GitHub Pages. The app shell is public, but every
recipe, note, and photo lives in the **private** repo
[`shaanvaidya/recipe-box-data`](https://github.com/shaanvaidya/recipe-box-data),
read and written straight from the browser via the GitHub contents API with a
fine-grained personal access token. No servers, no build step, and the data is
versioned by git for free.

## Features

- **Add recipes three ways** — paste a URL (parses schema.org/Recipe JSON-LD or
  microdata, which nearly all recipe sites have), paste raw text (heuristic
  split into title/ingredients/steps), or type it in by hand. Everything lands
  in a preview form before saving.
- **Browse** — search across titles, tags, and ingredients; category and tag
  filters; newest / A–Z / favorites sort.
- **Cook** — servings scaler (½×/1×/2×/3×/custom) with proper fraction display,
  US ↔ metric toggle (incl. cups→grams via a density table and °F→°C in step
  text), tick-off ingredient checklist, and a full-screen step-by-step cook
  mode that keeps the screen awake.
- **Notes** — a dated cooking log per recipe ("2026-07-18: used half the
  sugar — better").
- **Converter** — standalone volume/weight/oven/cups↔grams converter, works
  offline and without a token.
- **Photos** — optional, compressed client-side (~200 KB) before committing.
- **PWA** — installable on iOS/Android, offline reading of previously viewed
  recipes, light/dark theme.

## One-time setup

1. **Data repo** — create a **private** repo `recipe-box-data` with a README
   (the contents API needs the branch to exist). Optionally add an
   `index.json` containing `{"version":1,"recipes":[]}`.
2. **Token** — GitHub → Settings → Developer settings → Personal access tokens
   → **Fine-grained tokens** → Generate:
   - Repository access: **Only select repositories** → `recipe-box-data`
   - Permissions → Repository → **Contents: Read and write**
   - Expiration: up to 1 year (the app shows a banner when it expires)
3. **Unlock a device** — open the site → Settings → paste the token. Repeat
   once per device. On a phone, use *Add to Home Screen* to install it.

## Data layout (`recipe-box-data`)

```
index.json          # list-view summary: id, title, category, tags, favorite, updatedAt
recipes/<id>.json   # full recipe: ingredients (raw + parsed qty/unit/item), steps, notes…
photos/<id>.jpg     # optional, compressed
```

The recipe file is always written before the index, so a failed save can only
leave the index stale — Settings → *Rebuild index* regenerates it from the
recipe files.

## Development

```
python3 -m http.server 8000   # then open http://localhost:8000
```

No dependencies, no build. `js/ingredients.js` and `js/importers.js` are pure
and can be smoke-tested with Node (`node -e 'require("./js/ingredients.js")'`).
