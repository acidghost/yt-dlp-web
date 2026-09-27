import { defineConfig } from "playwright/test";

const port = 3000;

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    },
  },
  webServer: {
    command: "bun app/index.ts",
    url: `http://127.0.0.1:${port}/healthz`,
    env: { PORT: String(port), DATA_DIR: "tmp/e2e-data" },
  },
});
