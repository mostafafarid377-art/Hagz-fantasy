import { defineConfig, devices } from '@playwright/test';

// Isolated fake backend only. Never inherits a developer's Supabase settings.
export default defineConfig({
  testDir: './e2e-live-receipts',
  workers: 1, retries: 0, reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4174',
    launchOptions: { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] },
    video: 'off', trace: 'off',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174', reuseExistingServer: false, timeout: 120_000,
    env: { VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_SUPABASE_ANON_KEY: 'sb_publishable_fake_test_key_123456789' },
  },
});
