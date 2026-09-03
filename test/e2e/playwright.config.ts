import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  fullyParallel: false,
  workers: process.env.CI ? 1 : 2,
  reporter: process.env.CI ? "github" : [["list"]],
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "chromium", testIgnore: /perf\//, use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", testIgnore: /perf\//, use: { ...devices["Desktop Firefox"] } },
    {
      name: "perf",
      testMatch: /perf\/.*\.spec\.ts/,
      workers: 1,
      timeout: 120_000,
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: ["--enable-precise-memory-info", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"] },
      },
    },
  ],
});
