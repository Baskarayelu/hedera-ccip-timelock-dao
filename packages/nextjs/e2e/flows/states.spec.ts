import { VARIANTS, openFocusProposal, openScenario, shot } from "./helpers";
import { expect, test } from "@playwright/test";

/**
 * Every screen and every unhappy state, asserted and photographed at 1440 and 390 px in light and dark.
 * Screenshots land in e2e/screenshots/ (gitignored) for review.
 */

type Check = (page: import("@playwright/test").Page) => Promise<void>;

const banner = (title: string | RegExp): Check => async page =>
  expect(page.getByTestId("banner").first()).toContainText(title);

const PAGES: { name: string; scenario: string; path?: string; detail?: boolean; check: Check }[] = [
  // Screens
  {
    name: "proposals",
    scenario: "list",
    check: async page => {
      await expect(page.getByTestId("proposal-row")).toHaveCount(5);
      await expect(page.getByRole("tab", { name: "All 5" })).toBeVisible();
      await expect(page.getByText("18.92 HBAR")).toBeVisible(); // 20 HBAR less one 1.07 HBAR CCIP fee
    },
  },
  { name: "detail-queued", scenario: "queued", detail: true, check: banner("Executes itself at 14:28:10, in 1 min 12 s") },
  {
    name: "voting-power",
    scenario: "claim",
    path: "/voting-power",
    check: async page => {
      await expect(page.getByTestId("step-1")).toHaveAttribute("data-state", "done");
      await expect(page.getByTestId("step-2")).toHaveAttribute("data-state", "current");
    },
  },
  // Unhappy states: voting power
  {
    name: "state-not-associated",
    scenario: "notAssociated",
    path: "/voting-power",
    check: banner("Your account is not associated with HGOV yet"),
  },
  {
    name: "state-auto-associates",
    scenario: "autoAssociates",
    path: "/voting-power",
    check: async page => expect(page.getByTestId("step-1")).toContainText("Not needed"),
  },
  {
    name: "state-claimed-recently",
    scenario: "claimedRecently",
    path: "/voting-power",
    check: async page => {
      await expect(page.getByTestId("step-2")).toContainText("Claimed at 09:14:02. Next claim from 3 Oct 09:14");
      await expect(page.getByRole("button", { name: "Claim" })).toBeDisabled();
    },
  },
  {
    name: "state-not-delegated",
    scenario: "notDelegated",
    path: "/voting-power",
    check: banner("Your 1,000 vHGOV carry no votes yet"),
  },
  // Unhappy states: proposals list
  { name: "state-empty", scenario: "empty", check: async page => expect(page.getByText("No proposals yet")).toBeVisible() },
  {
    name: "state-wrong-network",
    scenario: "wrongNetwork",
    check: async page => {
      await expect(page.locator(".network-alert")).toContainText("Your wallet is on another network");
      await expect(page.getByRole("button", { name: "Switch to Hedera testnet" })).toBeVisible();
    },
  },
  {
    name: "state-no-wallet",
    scenario: "noWallet",
    path: "/voting-power",
    check: banner("Connect a wallet to set up voting"),
  },
  // Unhappy (and in-between) states: proposal detail
  { name: "state-pending", scenario: "pending", detail: true, check: banner("Voting opens at 14:21:01") },
  {
    name: "state-active",
    scenario: "active",
    detail: true,
    check: async page => {
      await expect(page.getByTestId("you")).toHaveText("Your voting power at the snapshot: 400 vHGOV.");
      await expect(page.getByRole("button", { name: "For", exact: true })).toBeEnabled();
    },
  },
  {
    name: "state-no-voting-power",
    scenario: "activeNoPower",
    detail: true,
    check: async page => {
      await expect(page.getByTestId("you")).toContainText("You had no delegated votes at the snapshot (14:21:01)");
      await expect(page.getByRole("button", { name: "For", exact: true })).toBeDisabled();
    },
  },
  { name: "state-queue-failed", scenario: "queueFailed", detail: true, check: banner("INSUFFICIENT_PAYER_BALANCE") },
  {
    name: "state-sent-not-delivered",
    scenario: "inFlight",
    detail: true,
    check: banner("Sent to Base Sepolia at 14:28:10, not delivered yet"),
  },
  {
    name: "state-receipt-pending",
    scenario: "receiptPending",
    detail: true,
    check: banner("Ran on Base Sepolia at 14:28:45. Receipt on its way."),
  },
  {
    name: "state-receipt-received",
    scenario: "done",
    detail: true,
    check: banner("Done: executed on Base Sepolia, receipt received on Hedera at 14:51:19"),
  },
  {
    name: "state-remote-failed",
    scenario: "remoteFailed",
    detail: true,
    check: banner("Delivered, but the calls failed on Base Sepolia"),
  },
  { name: "state-expired", scenario: "expired", detail: true, check: banner("Arrived too late and was not run") },
  {
    name: "state-delivery-failed",
    scenario: "deliveryFailed",
    detail: true,
    check: banner("CCIP could not run it on Base Sepolia"),
  },
  {
    name: "state-fee-above-cap",
    scenario: "feeAboveCap",
    detail: true,
    check: async page => {
      await banner("Waiting: the CCIP fee is above the cap you voted for")(page);
      await expect(page.getByRole("button", { name: "Execute now" })).toBeEnabled();
    },
  },
  {
    name: "state-execution-failed",
    scenario: "executionFailed",
    detail: true,
    check: async page => {
      await banner("The network’s execution call failed")(page);
      await expect(page.getByRole("button", { name: "Execute now" })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Schedule it again" })).toBeEnabled();
    },
  },
  { name: "state-executed-hedera", scenario: "executedLocal", detail: true, check: banner("Executed on Hedera at 14:28:10") },
  { name: "state-defeated", scenario: "defeated", detail: true, check: banner("Defeated: more votes against than for") },
  { name: "state-no-quorum", scenario: "noQuorum", detail: true, check: banner("Defeated: quorum not reached") },
  { name: "state-canceled", scenario: "canceled", detail: true, check: banner("Cancelled by the proposer at 14:20:40") },
];

for (const variant of VARIANTS) {
  test.describe(variant.name, () => {
    test.use({ viewport: variant.viewport, colorScheme: variant.colorScheme });
    for (const p of PAGES) {
      test(p.name, async ({ page }) => {
        if (p.detail) await openFocusProposal(page, p.scenario);
        else await openScenario(page, p.scenario, p.path);
        await p.check(page);
        await shot(page, `${p.name}--${variant.name}`);
      });
    }
  });
}
