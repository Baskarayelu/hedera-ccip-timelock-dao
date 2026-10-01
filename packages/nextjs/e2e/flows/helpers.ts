import { type Page, expect } from "@playwright/test";

export const VIEWPORTS = {
  desktop: { width: 1440, height: 1000 },
  phone: { width: 390, height: 844 },
} as const;

export type Variant = { name: string; viewport: { width: number; height: number }; colorScheme: "light" | "dark" };

export const VARIANTS: Variant[] = [
  { name: "1440-light", viewport: VIEWPORTS.desktop, colorScheme: "light" },
  { name: "1440-dark", viewport: VIEWPORTS.desktop, colorScheme: "dark" },
  { name: "390-light", viewport: VIEWPORTS.phone, colorScheme: "light" },
  { name: "390-dark", viewport: VIEWPORTS.phone, colorScheme: "dark" },
];

/** Loads a page with a fixture scenario and waits until its data rendered. */
export async function openScenario(page: Page, scenario: string, path = "/") {
  await page.goto(`${path}?scenario=${scenario}`);
  await expect(page.locator(".dao")).toBeVisible();
  await expect(page.locator("[aria-busy='true']")).toHaveCount(0);
}

/** Opens the scenario's newest proposal from the list (client-side, so the fixture world is kept). */
export async function openFocusProposal(page: Page, scenario: string) {
  await openScenario(page, scenario);
  await page.getByTestId("proposal-row").first().click();
  await expect(page.getByTestId("banner")).toBeVisible();
}

/** Moves the fixture network's clock forward. */
export async function advance(page: Page, seconds: number) {
  await page.evaluate(s => (window as unknown as { __dao: { advance: (n: number) => void } }).__dao.advance(s), seconds);
}

export async function shot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: true });
}
