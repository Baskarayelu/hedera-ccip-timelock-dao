# hedera-ccip-timelock-dao

A [Scaffold-HBAR](https://github.com/hedera-dev/create-scaffold-hbar) template for a DAO on Hedera whose proposals queue and execute themselves, and can act on another chain.

- **Vote with an HTS token.** Holders wrap the HTS governance token 1:1 into an ERC20Votes token, so voting weight is read at each proposal's snapshot.
- **No keeper.** Creating a proposal schedules a Hedera Schedule Service (HIP-1215) call that queues it when voting ends. Queueing schedules the call that executes it when the timelock ends.
- **Cross-chain actions.** An executed proposal can send a batch of calls to Base Sepolia over Chainlink CCIP. The calls run from the DAO's own account there, and a receipt comes back to Hedera.

> **Status:** in development for the Scaffold-HBAR template bounty. The contracts, tests and deploy scripts are in place, and the shared executor is live on Base Sepolia. The frontend, the deployed testnet DAO and the full documentation are in progress.

## Scaffold it

```bash
npx create-scaffold-hbar@latest my-dao --template Baskarayelu/hedera-ccip-timelock-dao
```

npm's `create` command works too: write `create scaffold-hbar@latest`, and with npm (v7 and later), put `--` before the CLI's flags so they reach the CLI.

Requirements: Node 20.18.3 or later, Git, and Foundry 1.8.4 or later (`foundryup`).

## Develop

```bash
npm install
npm run test    # 60 Foundry tests: mocked HSS (busy seconds, payer balance, clock lag) and a two-chain CCIP mock
npm run lint
npm run build
```

## Licence

MIT. Built on the Scaffold-HBAR blank template (MIT, BuidlGuidl and hedera-dev).
