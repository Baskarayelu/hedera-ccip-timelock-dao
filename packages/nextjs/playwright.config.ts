import { defineConfig, devices } from "@playwright/test";

/**
 * Two projects:
 * - unit: pure TypeScript checks of the data layer (no browser);
 * - e2e: the pages in fixture mode (NEXT_PUBLIC_DAO_FIXTURES=true), from a production build in .next-e2e.
 * Times render in UTC so screenshots match the scenarios' clock.
 */
// Unit specs format times in the worker's zone; the browser projects use timezoneId below.
process.env.TZ = "UTC";
// Every spec here runs against fixtures, including the unit specs that import the data layer directly.
process.env.NEXT_PUBLIC_DAO_FIXTURES = "true";

const PORT = Number(process.env.E2E_PORT ?? 3100);
/** `--project unit` needs no server. */
const unitOnly = process.argv.some(
  (arg, i, all) => arg === "--project=unit" || (arg === "--project" && all[i + 1] === "unit"),
);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    timezoneId: "UTC",
    locale: "en-GB",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "unit", testMatch: /unit\/.*\.spec\.ts/ },
    {
      name: "e2e",
      testMatch: /flows\/.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
    },
  ],
  webServer: unitOnly
    ? undefined
    : {
        command: `npx next build && node e2e/restore-next-env.cjs && npx next start --port ${PORT}`,
        url: `http://localhost:${PORT}/api/health`,
        // Always start our own fixture build: a server already on the port may be another app or a live build.
        reuseExistingServer: false,
        timeout: 600_000,
        env: { NEXT_PUBLIC_DAO_FIXTURES: "true", NEXT_DIST_DIR: ".next-e2e" },
      },
});
