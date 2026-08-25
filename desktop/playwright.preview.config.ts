import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["**/focus-preview.spec.ts"],
  timeout: 120_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    ...devices["Desktop Chrome"],
    // 1440x900 is the review size baxen asked for. It must come *after* the
    // device spread, which would otherwise pin 1280x720.
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "python3 -m http.server 4173 -d dist",
    cwd: ".",
    reuseExistingServer: true,
    url: "http://127.0.0.1:4173",
  },
});
