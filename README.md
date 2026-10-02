# hedera-ccip-timelock-dao

A [Scaffold-HBAR](https://github.com/hedera-dev/create-scaffold-hbar) template for a token-governed DAO on Hedera whose proposals queue and execute themselves, on Hedera or on Base Sepolia.

- **Vote with an HTS token, safely.** Holders wrap the HTS governance token 1:1 into an `ERC20Votes` token, so each vote counts the balance at the proposal's snapshot. Tokens bought after a vote opens cannot vote on it. ([Why wrap to vote](docs/wrap-to-vote.md))
- **No keeper.** Creating a proposal asks the Hedera Schedule Service (HIP-1215) to call the governor back when voting ends; that call queues the proposal and schedules the one that executes it when the timelock ends. If a scheduled call fails, anyone can finish the job from the app.
- **Cross-chain actions with receipts.** A proposal can include calls on Base Sepolia. They travel in one Chainlink CCIP message, run from the DAO's own account there, and a receipt comes back to Hedera saying whether they ran. The CCIP fee is quoted at execution and capped by the vote.

![Proposals page of the testnet DAO: a USDC payout and a parameter change on Base Sepolia, both with receipts back on Hedera, a proposal held by its fee cap, and a Hedera-only payment](docs/img/proposals.jpg)

*The live testnet DAO ([PROOFS.md](PROOFS.md)). [Every page and state](docs/frontend.md) is also tested with fixture data at 1440 and 390 px in light and dark.*

## Live on testnet

A DAO made from this template runs on Hedera testnet, and a freshly scaffolded project opens it: `packages/nextjs/contracts/daoDeployment.ts` points at it until you deploy your own.

| Hedera testnet | Address |
|---|---|
| `DaoGovernor` | [0x7d1e2fa702d137b019c44b9a562e04dd89cf7468](https://hashscan.io/testnet/contract/0x7d1e2fa702d137b019c44b9a562e04dd89cf7468) |
| `DaoTimelock` (treasury) | [0xa895bf23411339f0bc19ee7859be455dcfb57d18](https://hashscan.io/testnet/contract/0xa895bf23411339f0bc19ee7859be455dcfb57d18) |
| `VoteToken` (vHGOV) | [0x12a964056dbc26ad3206f03191daa7cf5d8c6bfa](https://hashscan.io/testnet/contract/0x12a964056dbc26ad3206f03191daa7cf5d8c6bfa) |
| HGOV | HTS token `0.0.10822898` |

| Base Sepolia | Address |
|---|---|
| The DAO's account | [0xa0E81699e1BC4f571d90A941b01420796192B124](https://sepolia.basescan.org/address/0xa0E81699e1BC4f571d90A941b01420796192B124) |
| `CrossChainExecutor`, shared by every DAO from this template (verified on Sourcify) | [0x9B7691B0766A55D8509b07Cb633Ce281feE2A632](https://sepolia.basescan.org/address/0x9B7691B0766A55D8509b07Cb633Ce281feE2A632) |
| `RemoteParameters`, shared demo target | [0x5f8b11a830ce09d87fA586c95e7C85FA57691cd9](https://sepolia.basescan.org/address/0x5f8b11a830ce09d87fA586c95e7C85FA57691cd9) |

[PROOFS.md](PROOFS.md) records four proposals run through the app by two voters, each queued and executed by the network with no keeper: a Hedera-only payment, a fee cap that stopped an execution, a parameter set on Base Sepolia, and a 5 USDC payout from the DAO's Base account, both with their receipts back on Hedera. CI re-checks every on-chain link in these docs daily (`npm run check:proofs`).

**Try it with only Hedera testnet HBAR.** Scaffold the template ([Quick start](#quick-start)) and follow [Take part with a testnet wallet](#take-part-with-a-testnet-wallet). The DAO pays for the network's queue and execute calls and for CCIP fees; you pay about 3 HBAR of gas for the whole run. One faucet claim (1,000 HGOV, wrapped into 1,000 vHGOV) passes a proposal on its own while fewer than 25,000 vHGOV exist (quorum is 4%).

## Quick start

You need:

- Node 20.18.3 or later.
- A global Git user name and email (`git config --global user.name "…"` and `git config --global user.email "…"`). The CLI checks them in the folder you run it from, before any repository exists there, so an identity set only for some folders does not count.
- Foundry (`foundryup`). Any version from 1.4 builds, tests and deploys; `npm run lint` needs 1.8.4 or later (`foundryup --install 1.8.4`).

Scaffold and run the template with npm; other package managers are not supported.

```bash
npx create-scaffold-hbar@latest my-dao --template Baskarayelu/hedera-ccip-timelock-dao
cd my-dao
npm run next:dev
```

The CLI asks whether to add the Hedera Skills agent guides (either answer works) and which network to use: choose **Testnet**. It installs the dependencies itself. To skip the questions, as CI and coding agents must, add `--yes --skip-hedera-skills --network testnet`.

Open http://localhost:3000. The app opens the live testnet DAO.

To use npm's `create` command instead, write `create scaffold-hbar@latest my-dao -- --template Baskarayelu/hedera-ccip-timelock-dao` after `npm`: the `--` passes the flags through to the CLI.

### Take part with a testnet wallet

1. **Get a testnet account.** Create an ECDSA account at [portal.hedera.com](https://portal.hedera.com) and fund it from the [faucet](https://portal.hedera.com/faucet). About 10 HBAR covers every step below; they spend about 3 ([Costs](docs/costs.md)). Add Hedera testnet to your wallet (chain id 296, RPC `https://testnet.hashio.io/api`) and import the account's private key in its HEX form (the portal shows HEX and DER; wallets take the HEX one). The app's burner wallet is for looking around: it starts with no HBAR and no Hedera account, so it can act only after you send HBAR to its address from the faucet.
2. **Voting power** page: press **Claim** to get 1,000 HGOV from the DAO's own faucet (once per account every 24 hours), wrap them into vHGOV, and delegate to yourself. An association step appears only if your account needs one.
3. **New proposal**: add a Base action such as *Set a parameter*. The page quotes the CCIP fee live and proposes a cap of twice the quote. Submit.
4. **Vote** on the proposal's page once voting opens, 1 minute after you propose; voting stays open for 5 minutes. Then watch it: the network queues it 5 seconds after voting ends and executes it 2 minutes later (the timelock), about 8 minutes after you proposed. A Base action runs on Base Sepolia within a minute of that, and its receipt reaches Hedera once Base Sepolia finalizes the block, which took 20 to 25 minutes during our runs; the page estimates it live. The timeline links each step to HashScan, the CCIP explorer and Basescan.

### Deploy your own DAO

The deploy uses the executor already on Base Sepolia, so you need only testnet HBAR: about 60 HBAR, of which 22 pays for the contracts and the token and the rest funds the callback float (15) and the treasury (20). Token creation also sends 30 HBAR with its call and gets back what the network does not charge (about 18), so start with at least 60. See [Costs](docs/costs.md).

```bash
npm run foundry:account:generate   # writes a fresh key to packages/foundry/.env
# fund the printed address at https://portal.hedera.com/faucet
npm run foundry:deploy:hedera      # token, vote token, timelock, governor, wiring, funding
npm run foundry:export             # points the frontend at your DAO
```

To deploy from an existing testnet key, put `DEPLOYER_PRIVATE_KEY=0x…` in `.env.local` at the repository root instead; it takes precedence over `packages/foundry/.env`. Both files are gitignored. Voting periods, quorum, gas limits and HBAR amounts are set in `packages/foundry/.env`, which installing copies from `packages/foundry/.env.example`.

The script prints the DAO's account address on Base Sepolia. Fund it with Base Sepolia ETH to pay for its own receipts (the executor sponsors the first ten), and with any tokens the DAO should control there.

## How it works

```mermaid
sequenceDiagram
  participant G as Governor (Hedera)
  participant H as Schedule Service
  participant T as Timelock (Hedera)
  participant E as Executor (Base Sepolia)
  G->>H: propose: schedule autoQueue at voting end
  H->>G: autoQueue: queue, schedule autoExecute at the ETA
  H->>G: autoExecute: execute
  G->>T: run actions; send Base calls over CCIP (fee quoted, capped)
  T->>E: CCIP: run calls from the DAO's account
  E->>T: CCIP: receipt (executed, failed with reason, or expired)
```

[Architecture](docs/architecture.md) covers the contracts, the full sequence and the frontend's data layer. [Threat model](docs/threat-model.md) lists what is protected and how, including what is demo-only.

## Project layout

| Path | What |
|---|---|
| `packages/foundry/contracts/hedera/` | `DaoGovernor`, `DaoTimelock`, `VoteToken`, `GovTokenFaucet`, `HssScheduler` |
| `packages/foundry/contracts/remote/` | `CrossChainExecutor`, `DaoAccount`, `RemoteParameters` (Base Sepolia) |
| `packages/foundry/test/` | Forge tests and the HSS, CCIP and mirror-node test doubles |
| `packages/foundry/scripts-js/` | Deploy and export scripts (viem) |
| `packages/foundry/deployments/` | Committed deployment records |
| `packages/nextjs/` | The app: pages in `components/dao/pages`, data layer in `lib/dao`, tests in `e2e/` |

## Commands

Run these from the repository root.

| Command | What it does |
|---|---|
| `npm run next:dev` | The app at http://localhost:3000 |
| `npm run test` | 60 Foundry tests and the frontend's data-layer tests |
| `npm run next:test:e2e` | Every page and state in the browser (run `npx playwright install chromium` once first) |
| `npm run lint` | ESLint and Prettier, `forge fmt`, `forge lint`, and the docs check |
| `npm run build` | Compile the contracts and build the app |
| `npm run foundry:deploy:hedera` | Deploy a DAO to Hedera testnet |
| `npm run foundry:export` | Regenerate the app's ABIs and addresses from `packages/foundry/deployments` |
| `npm run check:proofs` | Re-verify every HashScan, CCIP explorer and Basescan link in the docs |

## Docs

- [Architecture](docs/architecture.md): contracts, a proposal's life, the frontend's data layer
- [Why wrap to vote](docs/wrap-to-vote.md): HTS has no vote checkpoints, and what that means
- [Threat model](docs/threat-model.md): assets, trust, attacks and mitigations
- [Frontend](docs/frontend.md): pages, states, live data and tests
- [Hedera, CCIP and CLI gotchas](docs/gotchas.md): behaviour measured on testnet that shaped the design
- [Costs](docs/costs.md): how Hedera bills gas, and what each step, proposal and deployment costs, measured
- [AGENTS.md](AGENTS.md): briefing for coding agents working in a scaffolded project

## Licence

MIT. Built on the Scaffold-HBAR blank template (MIT, BuidlGuidl and hedera-dev).
