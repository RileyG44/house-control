import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export default defineConfig({
  testDir: './tests', fullyParallel: false, workers: 1, timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:8798', headless: true,
    launchOptions: { executablePath: process.env.HOUSE_TEST_CHROME || (existsSync(chrome) ? chrome : undefined) },
    screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  projects: [
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'desktop', use: { viewport: { width: 1280, height: 960 } } },
  ],
  webServer: { command: `${process.env.HOUSE_TEST_PYTHON || '../hub/.venv/bin/python'} tests/preview_hub.py`,
    url: 'http://127.0.0.1:8798', reuseExistingServer: false },
});
