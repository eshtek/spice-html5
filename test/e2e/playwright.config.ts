import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/* macOS guards each app's data directory, and holds a child process to what
   the app that spawned it may read. Started from an editor's terminal or an
   agent, Firefox is refused ~/Library/Application Support/Firefox, cannot
   load its profile registry, and never finishes launching: older builds sit
   at an invisible "Profile Missing" dialog until the launch times out, newer
   ones exit with "Could not find profile folder". A home of its own keeps it
   out of that directory; Playwright passes the real profile with -profile. */
const firefoxEnv =
  process.platform === "darwin"
    ? { ...process.env, CFFIXED_USER_HOME: mkdtempSync(join(tmpdir(), "spice-html5-firefox-home-")) }
    : undefined;

export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  fullyParallel: false,
  workers: process.env.CI ? 1 : 2,
  reporter: process.env.CI ? "github" : [["list"]],
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "chromium", testIgnore: /perf\//, use: { ...devices["Desktop Chrome"] } },
    {
      name: "firefox",
      testIgnore: /perf\//,
      use: { ...devices["Desktop Firefox"], launchOptions: firefoxEnv ? { env: firefoxEnv } : {} },
    },
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
