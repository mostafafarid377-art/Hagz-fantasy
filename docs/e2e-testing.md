# Browser E2E testing

The regular E2E suite uses Microsoft Playwright Test and Chromium by default. It launches the Vite app with Supabase settings explicitly empty, so tests use the local Demo store and cannot write to a real project.

## Install

```sh
npm ci
npx playwright install --with-deps chromium
```

`--with-deps` installs Chromium and its Linux system packages on supported Linux hosts. On Windows or macOS, use `npx playwright install chromium`; the OS libraries are managed by the browser installer/platform.

## Commands

```sh
npm run test:e2e          # headless Chromium (default)
npm run test:e2e:ui       # Playwright UI runner
npm run test:e2e:headed   # visible Chromium window (requires a desktop/display)
npm run test:e2e:report   # open the last HTML report
```

On failure, Playwright retains a screenshot, video and trace under `test-results/` and writes an HTML report to `playwright-report/`. In CI, both directories are uploaded as the `playwright-diagnostics` artifact. The GitHub Pages workflow uploads its own Pages-E2E diagnostics.

For an installed nonstandard Chromium binary, set `CHROMIUM_PATH` before running the tests. The browser is still verified by the Playwright launch itself; setting a path alone is not evidence that it launched.

## Future cross-browser runs

Chromium is the default project. Firefox and WebKit device projects are defined but opt-in so a normal run never fails just because those browsers are not installed:

```sh
npx playwright install firefox webkit
PLAYWRIGHT_CROSS_BROWSER=1 npm run test:e2e
```

In PowerShell:

```powershell
npx playwright install firefox webkit
$env:PLAYWRIGHT_CROSS_BROWSER = '1'
npm run test:e2e
```

The E2E suite covers navigation, role-gated demo actions, auth-form feedback/demo fallback, browser interactions, and local persistence after reload. It does not use production Supabase credentials or claim a real hosted sign-in; hosted-auth integration requires a separate isolated test project and non-production test account.
