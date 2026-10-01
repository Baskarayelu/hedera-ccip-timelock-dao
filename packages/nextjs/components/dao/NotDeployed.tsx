import { Banner } from "./ui";

/** Live mode before any DAO is deployed: say how to get one instead of showing empty numbers. */
export function NotDeployed() {
  return (
    <Banner
      banner={{
        tone: "info",
        title: "No DAO is deployed from this project yet",
        body: "Deploy one to Hedera testnet with `npm run foundry:deploy:hedera`, then run `npm run foundry:export` and reload. The README explains the keys and HBAR it needs.",
      }}
    />
  );
}
