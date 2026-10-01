import { VARIANTS, advance, openFocusProposal, openScenario, shot } from "./helpers";
import { type Page, expect, test } from "@playwright/test";

async function fillProposal(page: Page) {
  await page.getByLabel("Title").fill("Set the protocol fee to 30 bps and pay the Q4 grant");
  await page
    .getByLabel("Description")
    .fill("Lowers the Base deployment’s fee from 45 to 30 bps and pays the Q4 grant to the indexer team.");
  await page.getByRole("button", { name: "Set a parameter" }).click();
  await page.getByLabel("Key").fill("protocol.feeBps");
  await page.getByLabel("New value").fill("30");
  await page.getByRole("button", { name: "Send tokens from the DAO’s account" }).click();
  await page.getByLabel("Amount", { exact: true }).fill("100");
  await page.getByLabel("Recipient on Base").fill("0x9b1c5f8e2d4a7b3c6e0f1a2b3c4d5e6f7a8b44fa");
  // Live quote, then the default cap: twice the quote rounded up to 0.01 HBAR.
  await expect(page.getByTestId("fee-now")).toHaveText("1.07 HBAR");
  await expect(page.getByLabel("Fee cap in HBAR")).toHaveValue("2.15");
}

test("happy path: set up voting power, propose a Base action, vote, and the network does the rest", async ({ page }) => {
  await openScenario(page, "fresh", "/voting-power");

  // 1. Associate (this account has no free automatic-association slot).
  await expect(page.getByTestId("banner")).toContainText("not associated with HGOV");
  await page.getByRole("button", { name: "Associate" }).click();
  await expect(page.getByTestId("step-1")).toHaveAttribute("data-state", "done");

  // 2. Claim from the faucet.
  await page.getByRole("button", { name: "Claim" }).click();
  await expect(page.getByTestId("bal-hgov")).toHaveText("1,000.00");
  await expect(page.getByTestId("step-2")).toContainText("Next claim from");

  // 3. Wrap part of it: approve, then deposit.
  await page.getByLabel("Amount to wrap").fill("400");
  await page.getByRole("button", { name: "Approve and wrap" }).click();
  await expect(page.getByTestId("bal-vhgov")).toHaveText("400.00");
  await expect(page.getByTestId("bal-hgov")).toHaveText("600.00");
  await expect(page.getByTestId("banner")).toContainText("Your 400 vHGOV carry no votes yet");

  // 4. Delegate to myself.
  await page.getByRole("button", { name: "Delegate to myself" }).click();
  await expect(page.getByTestId("bal-power")).toHaveText("400.00");
  await expect(page.getByTestId("step-4")).toContainText("Delegated to yourself");

  // Propose a Base Sepolia action.
  await page.getByRole("navigation", { name: "Main" }).first().getByRole("link", { name: "New proposal" }).click();
  await fillProposal(page);
  await page.getByRole("button", { name: "Preview the calls" }).click();
  await expect(page.getByTestId("call-preview")).toContainText("Set protocol.feeBps to 30");
  await expect(page.getByTestId("call-preview")).toContainText("Send 100 USDC to 0x9b1C…44FA");
  await page.getByRole("button", { name: "Create proposal" }).click();
  await expect(page.getByTestId("banner")).toContainText("Voting opens at");
  await expect(page.getByTestId("tl-proposed")).toHaveAttribute("data-status", "done");

  // Vote once voting opens.
  await advance(page, 61);
  await expect(page.getByTestId("banner")).toContainText("Voting is open until");
  await page.getByRole("button", { name: "For", exact: true }).click();
  await expect(page.getByTestId("you")).toHaveText("You voted For with 400 vHGOV.");
  await expect(page.getByTestId("votes-for")).toHaveText("400");

  // Voting ends; the network queues it (deadline + 1 + 4 s).
  await advance(page, 300);
  await expect(page.getByTestId("banner")).toContainText("Passed. The network queues it at");
  await advance(page, 6);
  await expect(page.getByTestId("banner")).toContainText("Executes itself at");
  await expect(page.getByTestId("tl-queued")).toHaveAttribute("data-status", "done");
  await expect(page.getByTestId("tl-queued")).toContainText("Ran with no keeper");

  // The timelock ends; the network executes it and sends the CCIP message.
  await advance(page, 125);
  await expect(page.getByTestId("banner")).toContainText("not delivered yet");
  await expect(page.getByTestId("tl-sent")).toContainText("Fee quoted at execution: 1.07 HBAR.");

  // CCIP delivers to Base; the receipt follows after Base finality.
  await advance(page, 35);
  await expect(page.getByTestId("banner")).toContainText("Receipt on its way");
  await advance(page, 22 * 60 + 34);
  await expect(page.getByTestId("banner")).toContainText("Done: executed on Base Sepolia, receipt received on Hedera");
  await expect(page.getByTestId("tl-receipt")).toHaveAttribute("data-status", "done");

  await page.getByRole("link", { name: "← Proposals" }).click();
  await expect(page.getByTestId("proposal-row").first()).toContainText("Executed");
});

test("fee above the cap: Execute now refuses while the fee is high, then succeeds when it drops", async ({ page }) => {
  await openFocusProposal(page, "feeAboveCap");
  await page.getByRole("button", { name: "Execute now" }).click();
  await expect(page.getByText(/the CCIP fee was 2\.31 HBAR, above the 2\.00 HBAR cap/)).toBeVisible();
  await page.evaluate(() => (window as unknown as { __dao: { setFee: (t: string) => void } }).__dao.setFee("150000000"));
  await expect(page.getByTestId("banner")).toContainText("within the 2.00 HBAR cap, so it can be executed now");
  await page.getByRole("button", { name: "Execute now" }).click();
  await expect(page.getByTestId("banner")).toContainText("not delivered yet");
  await expect(page.getByTestId("tl-executed")).toContainText("Executed by hand");
});

test("failed queue call: anyone can queue it, then the network executes", async ({ page }) => {
  await openFocusProposal(page, "queueFailed");
  await page.getByRole("button", { name: "Queue now" }).click();
  await expect(page.getByTestId("banner")).toContainText("Executes itself at");
  await expect(page.getByTestId("tl-queued")).toContainText("Queued by hand");
});

test("failed execution: schedule it again and the network retries", async ({ page }) => {
  await openFocusProposal(page, "executionFailed");
  await page.getByRole("button", { name: "Schedule it again" }).click();
  await expect(page.getByTestId("banner")).toContainText("Executes itself at");
});

test("wrong network: the switch clears the banner", async ({ page }) => {
  await openScenario(page, "wrongNetwork");
  await page.getByRole("button", { name: "Switch to Hedera testnet" }).click();
  // (Next.js's route announcer also has role="alert", so match the banner itself.)
  await expect(page.locator(".network-alert")).toHaveCount(0);
});

test("cancel: the proposer can cancel while pending", async ({ page }) => {
  await openFocusProposal(page, "pending");
  await page.getByRole("button", { name: "Cancel this proposal" }).click();
  await expect(page.getByTestId("banner")).toContainText("Cancelled by the proposer");
});

for (const variant of VARIANTS) {
  test(`new proposal screen ${variant.name}`, async ({ browser }) => {
    const page = await browser.newPage({ viewport: variant.viewport, colorScheme: variant.colorScheme, timezoneId: "UTC" });
    await openScenario(page, "list", "/proposals/new");
    await fillProposal(page);
    await shot(page, `new-proposal--${variant.name}`);
    await page.close();
  });
}
