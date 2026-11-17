import { defineConfig, devices } from '@playwright/test';

const configuredBase = process.env.PAGES_TEST_BASE_PATH ?? '/Hagz-fantasy/';
const basePath = configuredBase === '/' || configuredBase === '' ? '/' : `/${configuredBase.replace(/^\/+|\/+$/g, '')}/`;
const chromiumPath = process.env.CHROMIUM_PATH;
const browserProjects = [
  {
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath, args: ['--no-sandbox'] } } : {}),
    },
  },
  { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  { name: 'webkit', use: { ...devices['Desktop Safari'] } },
];

export default defineConfig({
  testDir: './e2e-pages',
  outputDir: './test-results/pages',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/pages', open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:4174${basePath}`,
    headless: process.env.PLAYWRIGHT_HEADED !== '1',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  projects: process.env.PLAYWRIGHT_CROSS_BROWSER === '1' ? browserProjects : [browserProjects[0]],
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 4174 --strictPort',
    env: { VITE_BASE_PATH: basePath },
    url: `http://127.0.0.1:4174${basePath}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
