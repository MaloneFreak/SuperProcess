import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests drive the built app in a real browser. AI providers are
 * replaced by scripted responses, so the tests need no API key or network.
 * Build first: `npm run build && npm run e2e`.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1360, height: 900 },
    locale: 'en-US',
    trace: 'off',
  },
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
  },
});
