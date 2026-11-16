import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './browser',
  fullyParallel: true,
  reporter: 'list',
  outputDir: './.local/browser-results',
  use: {
    baseURL: 'http://127.0.0.1:5174',
    viewport: { width: 1440, height: 1000 },
    launchOptions: process.env.PILOT_CHROMIUM ? { executablePath: process.env.PILOT_CHROMIUM } : {},
  },
  webServer: {
    command: 'npm run pilot:dev',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: false,
  },
})
