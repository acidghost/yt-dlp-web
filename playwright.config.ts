import { defineConfig } from "playwright/test";

const port = 3000;

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  retries: 0,
  projects: [
    { name: "journeys", testMatch: "**/journeys.spec.ts" },
    { name: "browser-integration", testIgnore: "**/journeys.spec.ts" },
  ],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    },
  },
  webServer: {
    command: "bun e2e/support/server.ts",
    reuseExistingServer: false,
    url: `http://127.0.0.1:${port}/healthz`,
    env: {
      PORT: String(port),
      // Test the deployed client; dev-mode runtime warnings open a Bun overlay.
      NODE_ENV: "production",
    },
  },
});
