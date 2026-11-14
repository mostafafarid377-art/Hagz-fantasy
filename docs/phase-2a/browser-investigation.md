# Responsive browser-test investigation

## Outcome

The original full run had 41/42 passing: in the responsive English/Arabic test, after an Arabic `Create player` click, `expect(.form-panel).toBeVisible()` timed out with no matching element. Its captured accessibility snapshot showed the Arabic management page and the create button, not the access-restricted page. A previous single-test rerun passed. The original run did not retain an action trace, so it does not show whether the click event was dispatched, a navigation/reload occurred, or the form appeared briefly and was removed.

**The original failure was not reproduced and its root cause is not established.** No frontend or browser-test fix was made; changing timing or selectors without a demonstrated cause would risk hiding the issue. Passing repetitions do not prove it cannot recur. The earlier working session involved concurrent repository edits and test execution, so dev-server reload is one possible hypothesis, not a demonstrated cause of this failure.

## Reproduction and environment

- Ran the exact unmodified test using `npx playwright test e2e/qa.spec.ts -g 'responsive English and Arabic pages' --repeat-each=5 --workers=2 --trace=on`: **5/5 passed**. Each run covers English and Arabic at 390×844, 768×1024 and 1440×900, visits all existing routes and exercises leader management and rejection forms. Two workers ran separate test contexts.
- Independently stressed the creation action with a temporary external Node/Playwright script: **180/180 passed**, 30 clicks per language/viewport combination, navigating to `/management` each time after setting the leader role. This narrower stress test uses `domcontentloaded`, not the original test's full route sequence; it supplements rather than replaces the exact repeats.
- Reran full suite with `npm run test:e2e -- --trace retain-on-failure`: **42/42 passed**, one worker; no failure trace generated.
- Browser was the same available temporary Chromium **153.0.8010.0** with NSS libraries from `/tmp`, via `CHROMIUM_PATH` and `LD_LIBRARY_PATH`. Installed Playwright **1.65.1** specifies Chromium **159.0.8154.6** in its browser manifest; the pinned browser was not available in this sandbox. A browser-version mismatch is a possible environmental factor, **not an established cause**. Recheck with the Playwright-pinned browser in CI before declaring this fully resolved.

## Investigation

- **Timing:** The scenario waits for `networkidle` on navigation, Playwright auto-waits for the create button, then waits up to 5 seconds for `.form-panel`. `Management` sets component state to `null` in the click handler, which renders `PlayerForm` synchronously; navigation/reload would reset component state. Network idleness alone is not proof the app will never reload. No timing or reload cause was demonstrated by these runs.
- **State/isolation:** The Playwright `page` fixture creates an isolated browser context per test. `fresh` clears localStorage and reloads; its explicit clear does not clear IndexedDB, but distinct contexts isolate IndexedDB across tests. The original scenario deliberately keeps a single context during its language/viewport loop, resets the role to manager after each iteration, and selects leader before management. The original snapshot showed the leader management view. No cross-test leakage was observed; this does not prove no race within an iteration.
- **Viewports and direction:** The exact repeats exercised all three sizes in LTR and RTL. The separate stress loop also succeeded for all six combinations. No reproducible viewport/RTL-specific failure was found.
- **Selectors:** The clicked control is a role/name locator for `Create player`/`إنشاء لاعب`; the target is the CSS `.form-panel` used by `PlayerForm`. The original snapshot indicated the management button existed, while the assertion reported no panel. That is not sufficient evidence to blame a wrong selector or conclude the click handler ran. No selector was weakened or removed.

Next investigation if it recurs: keep `--trace retain-on-failure`, screenshot and console/server logs, record the active URL, viewport, selected role and navigation/reload events immediately before/after the click, and reproduce with the matching Playwright browser. Determine whether the handler ran and whether the form rendered before proposing a focused application or test fix. Do not replace the assertion with a retry click or a longer timeout without evidence.
