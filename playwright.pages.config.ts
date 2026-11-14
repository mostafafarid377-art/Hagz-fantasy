import { defineConfig, devices } from '@playwright/test';

const configuredBase = process.env.PAGES_TEST_BASE_PATH ?? '/Hagz-fantasy/';
const basePath = configuredBase === '/' || configuredBase === '' ? '/' : `/${configuredBase.replace(/^\/+|\/+$/g, '')}/`;

export default defineConfig({
  testDir: './e2e-pages',
  use: {
    baseURL: `http://127.0.0.1:4174${basePath}`,
    ...devices['Desktop Chrome'],
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : undefined,
  },
  webServer: {
    command: 'npm run preview -- --port 4174',
    env: { VITE_BASE_PATH: basePath },
    port: 4174,
    reuseExistingServer: false,
  },
  reporter: 'list',
});
