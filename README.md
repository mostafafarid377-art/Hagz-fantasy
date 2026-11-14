# Fantasy Friends — Phase 1.5

A mobile-first, local demo of private fantasy football for your own football community. **Your friends. Your team. Your league.**

## Run locally

Requires Node.js 20+ and npm.

```sh
npm install
npm run dev
```

Open the URL printed by Vite. Choose **Explore demo** on the landing page; no account or credentials are required. Switch between Manager and League Leader via the icon beside the profile in the top bar, or in **Settings → Demo role**. Switch leagues in the sidebar. The language control is available in the header and settings.

```sh
npm test                # Vitest business-rule tests
npm run typecheck       # TypeScript check
npm run build           # TypeScript check and production bundle
npx playwright install   # install browser and OS dependencies if necessary
npm run test:e2e        # Playwright browser tests
```

For a preinstalled Chromium executable, optionally set `CHROMIUM_PATH` when running the E2E suite. Playwright also requires the system libraries documented by Playwright (on Linux, `npx playwright install-deps chromium`).

## Project structure

- `src/data` — seed leagues, players, squads and standings
- `src/types` — domain types
- `src/services` — squad, permission and suggestion rules, with unit tests
- `src/hooks` — locally persisted demo state and actions
- `src/components`, `src/layouts`, `src/pages` — reusable UI and routes
- `src/translations` — i18next English/Arabic strings and language selection
- `e2e` — browser journeys

## Demo behavior and limitations

Demo state is stored in this browser's localStorage and local photos in IndexedDB; neither is a remote database. Reset demo state in Settings. Roles are a demo UI concept, not security or authentication. Creating/joining leagues, market edits, suggestions and reviews, squad changes, captain choices and market status are local only. A newly created league starts with an empty independent market. Players can be owned by multiple managers; each role has a separate squad. The first 11 roster entries are starters; use the arrows to reorder, and the rest are bench players. Managers can select a formation and tap a player in My Squad to substitute them with a highlighted starter or bench player. Guided substitutions preserve or improve the selected formation, while existing roster controls remain available. In Edit Squad, tap an empty position to add an available player, or tap a selected player and choose a same-position market replacement; the budget and market status are checked before confirmation. Changes remain a draft until the 15-player distribution, budget, starting formation, bench and distinct captain/vice captain pass validation and the manager confirms the lineup. Confirmation is local demo state, not a match submission. The squad builder enforces budget, per-position limits and duplicate prevention. Transfers are same-position, budget-checked replacements with no configured fees or limits.

Fixtures, standings, match events, fantasy points, activity and notifications are illustrative static data; they do not recalculate for new leagues or squad changes. The competition sample is associated with The Football Circle; other leagues show empty competition states. Standings rank the static demo totals by fantasy points only; equal totals share a rank. No live scoring engine is active. There is no match scoring engine, result verification, real login, real invitations, payment, API, Supabase or multi-device synchronization. Player images can be selected from the device (JPG/JPEG/PNG/WebP up to 5 MB) or optionally provided as HTTP(S) URLs. Local files are validated, then stored as blobs in IndexedDB; player and suggestion records hold only opaque local image references. Older demo data URLs are migrated to IndexedDB when possible. Images are local demo data, not uploaded or synchronized between devices, and may disappear if browser data is cleared. Browser storage is limited and image saves report storage failures. External image URLs depend on their host being reachable. The image service separates storage from display so a future Supabase Storage adapter can store URLs or storage paths instead of binary data in player rows; no cloud upload is implemented. Demo permissions are not a substitute for server authorization. The match dates and season are fictional sample content.

Recommended next phase: design the Supabase schema and row-level security around league membership and multiple ownership; add real authentication and invitations, server-side validation and transactional market workflows, followed by verified match results and a tested points engine. Connect competition views to league-specific live data only after these foundations are in place.

## GitHub Pages deployment

The repository's GitHub Pages site must serve a **built** Vite app, not the source files on `main`. In GitHub, open **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions**. After this change is merged into `main`, the `Build and deploy GitHub Pages` workflow builds the app and publishes the `dist` artifact. It also runs unit tests and a browser smoke test before deployment. You can rerun it from the Actions tab using **Run workflow**. The site's URL is shown in Settings → Pages and in the workflow's deployment environment.

The Pages workflow supplies the correct project URL prefix using `configure-pages` and enables hash-based routes (for example, `/#/dashboard`) so bookmarked routes work on GitHub Pages without server rewrites. Other hosts retain normal browser-history routes and must rewrite app routes to `index.html` on refresh. For a different subdirectory host, set `VITE_BASE_PATH` at build time; set `VITE_ROUTER_MODE=hash` if the host cannot rewrite routes.

```sh
npm run test:pages:assets  # verify the generated project-site asset paths
npm run test:e2e:pages     # build a Pages-style app and run a browser smoke test
```

The browser test requires Playwright's Chromium and system dependencies (`npx playwright install --with-deps chromium`). The default smoke-test prefix is `/Hagz-fantasy/`.

## Phase 1.5 verification note

The Playwright suite covers English/Arabic responsive layouts, roles, market, image selection and persistence, suggestions and reviews, squads, all formations and transfers. For the Phase 1.5 sandbox verification, the Playwright CDN download failed; a temporary npm-distributed Chromium 153.0.8010.0 and locally built NSS/NSPR libraries were used with `CHROMIUM_PATH` and `LD_LIBRARY_PATH`. Those temporary paths are not part of the project. Normal development and CI should install the Playwright-managed browser and system dependencies as described above. QA screenshots are in `qa-screenshots/`.
