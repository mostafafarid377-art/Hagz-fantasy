import { defineConfig, devices } from '@playwright/test';

const chromiumPath = process.env.CHROMIUM_PATH;
const projects = [
  {
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath, args: ['--no-sandbox'] } } : {}),
    },
  },
  {
    name: 'firefox',
    use: { ...devices['Desktop Firefox'] },
  },
  {
    name: 'webkit',
    use: { ...devices['Desktop Safari'] },
  },
];

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['./scripts/playwright-summary-reporter.mjs'],
  ],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: process.env.PLAYWRIGHT_HEADED !== '1',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  projects: process.env.PLAYWRIGHT_CROSS_BROWSER === '1' ? projects : [projects[0]],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    env: {
      // The default E2E suite exercises the explicit Demo mode and must never
      // inherit a developer's live Supabase credentials or mutate real data.
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_ANON_KEY: '',
    },
    timeout: 120_000,
  },
});
