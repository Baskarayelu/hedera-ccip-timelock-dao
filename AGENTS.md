# Agent instructions

Briefing for coding agents (Claude Code, Cursor, Codex) working in a project scaffolded from **hedera-ccip-timelock-dao**. Claude Code loads it through `CLAUDE.md`.

The project is a DAO on Hedera:

- HTS governance token, wrapped 1:1 into an ERC20Votes token (`VoteToken`) for snapshot voting.
- OpenZeppelin Governor (`DaoGovernor`) that queues and executes its own proposals through the Hedera Schedule Service (HIP-1215).
- Timelock (`DaoTimelock`) that holds the treasury and sends cross-chain call batches over Chainlink CCIP.
- On Base Sepolia, a shared `CrossChainExecutor` runs each batch from the sending DAO's own `DaoAccount` and sends a receipt back to Hedera.

## Layout

| Path | What |
|---|---|
| `packages/foundry/contracts/hedera/` | Governor, timelock, vote token, HTS faucet, `HssScheduler` base |
| `packages/foundry/contracts/remote/` | Executor, per-DAO account, demo `RemoteParameters` |
| `packages/foundry/contracts/ccip/`, `shared/` | Minimal CCIP types/interfaces; the wire format both chains share |
| `packages/foundry/test/` | Forge tests; `mocks/` holds the HSS, CCIP router and offline mirror-node doubles |
| `packages/foundry/scripts-js/` | viem deploy scripts and the ABI exporter |
| `packages/foundry/deployments/` | Committed deployment records (`296.json` Hedera testnet, `84532.json` Base Sepolia) |
| `packages/nextjs/components/dao/` | The app's pages (`pages/`), shell, provider and hooks |
| `packages/nextjs/lib/dao/` | Data layer: `DaoSource`, live and fixture sources, `derive.ts`, encoding, units |
| `packages/nextjs/e2e/` | Playwright: `unit/` (no browser) and `flows/` (pages in fixture mode) |
| `docs/` | Architecture, threat model, wrap-to-vote, frontend, gotchas, costs |

## Commands

Run them from the repository root.

```bash
npm install
npm run test                        # Foundry tests and the frontend's data-layer unit tests
npm run next:test:e2e               # every page and state in Chromium (npx playwright install chromium once)
npm run lint                        # Prettier, forge fmt, forge lint (needs Foundry 1.8.4+)
npm run build                       # forge compile + next build
npm run next:dev                    # http://localhost:3000

npm run foundry:account:generate    # writes a fresh testnet key to packages/foundry/.env
npm run foundry:deploy:remote       # Base Sepolia executor (shared; normally already deployed)
npm run foundry:deploy:hedera       # a complete DAO on Hedera testnet
npm run foundry:export              # regenerate packages/nextjs/contracts/{abis,daoDeployment,deployedContracts}.ts
```

Keys come from `.env.local` at the repository root, then `packages/foundry/.env`. Both are gitignored. Never print a key, and never commit either file.

## Hedera rules that break things silently

- **Two HBAR units.** Inside the EVM, `msg.value`, balances and CCIP fees are in **tinybar** (8 decimals). A JSON-RPC `value` is in **weibar** (18 decimals), so 1 HBAR is `1e8` in Solidity and `1e18` in a viem transaction.
- **`block.timestamp` trails consensus time.** It is the start of the ~2 s record-file block, so a scheduled call due at second S can read S - 3. Schedule a callback that needs `block.timestamp >= T` at `T + BLOCK_CLOCK_MARGIN` (4 s).
- **One `scheduleCall` per transaction.** A second one returns response code 373. A busy second returns 370 and still costs ~1.4M gas, so probe `hasScheduleCapacity` inside the transaction first; the relay's `eth_call` ignores throttles. `HssScheduler._scheduleSelfCall` does all of this; reuse it.
- **Never send `msg.value` to 0x16b.** The call fails and burns all its gas.
- **A scheduled call runs once.** If the payer cannot cover `gasLimit × gas price` when it fires, the schedule is consumed with no event and no retry, and a small fixed fee is still charged. Only the gas used is billed when it runs. Keep the governor's float funded, and keep `queue`, `execute` and `rearm` permissionless.
- **Auto-execution goes through `Governor.execute`**, not the timelock directly. OpenZeppelin's `onlyGovernance` checks only pass on that path.
- **HTS association.** Accounts and contracts must be associated with an HTS token before receiving it. Contracts associate through the token's HIP-719 `associate()`, then confirm with `isAssociated()`.
- **The relay reserves `gasLimit × price` up front, but Hedera bills only the gas used** (measured in `docs/costs.md`). Send Hedera transactions as legacy transactions with explicit gas limits; a generous limit costs balance, not HBAR, and estimates can undercount system-contract work.
- **CCIP receivers must answer ERC-165** for `IAny2EVMMessageReceiver` (`0x85572ffb`), or the OffRamp drops the data. Size destination gas generously: a receiver that also sends a receipt needed ~362k gas on Base Sepolia.

## Frontend rules

- **Pages never read the chain directly.** They use the hooks in `components/dao/hooks.ts`, which call a `DaoSource` (`lib/dao/source.ts`). Add a read or write to the interface, implement it in `lib/dao/live/source.ts` and in `lib/dao/fixtures/world.ts`, and keep both returning raw records.
- **States are derived in one place.** `lib/dao/derive.ts` turns a raw `ProposalRecord` into a phase, banner, timeline and fallback actions. To add a state, add it there, add a fixture scenario that reaches it in `fixtures/scenarios.ts`, then a unit expectation in `e2e/unit/derive.spec.ts` and a page check in `e2e/flows/states.spec.ts`.
- **No hard-coded numbers.** Fees, rules, balances and timings come from reads; when there is nothing to measure, say so in the copy.
- **HBAR is tinybar everywhere in `lib/dao`.** Convert weibar at the RPC boundary with `units.ts`.
- **Writes** go through `planTx` (contract call plus a gas floor per kind). Hedera transactions are legacy, at `eth_gasPrice`, with an explicit gas limit.
- **Class names:** DaisyUI is still loaded for `/debug`, so the DAO styles in `styles/dao.css` avoid its component names (`btn`, `card`, `stack`, `steps`, `timeline`, `label` and so on). Prefix new classes or check DaisyUI's list.
- **Addresses** come from `contracts/daoDeployment.ts`, written by `npm run foundry:export`; never edit it by hand.

## Tests

- `MockHederaScheduleService` is etched at `0x16b`. It models busy seconds, the per-transaction limit, the 62-day window, unfunded payers and the 3 s block-clock lag. Call `hss.newTransaction()` between simulated transactions and `hss.executeDue()` to let the network fire due schedules.
- `MockCcipRouter` instances with different chain selectors model two chains in one EVM; `deliver(source, id)` plays the OffRamp.
- HTS tests use hedera-forking's emulation with `OfflineMirrorNode`, so they run without network access.
- Frontend e2e tests build the app with `NEXT_PUBLIC_DAO_FIXTURES=true` into `.next-e2e` and serve it; `?scenario=<name>` picks a fixture world, and `window.__dao.advance(seconds)` moves its clock.

## Writing docs in this repository

When `create-scaffold-hbar` scaffolds with npm, it rewrites text files: commands for other package managers are rewritten for npm, and every "npm" followed by a word becomes "npm run" plus that word. In Markdown, write commands only as `npm run <script>`, `npm install` or `npx …`, and never put another word straight after "npm". The template gate in CI fails if any scaffolded Markdown differs from the source.

## Style

Match the surrounding code. Solidity is formatted by `forge fmt` (120 columns) and linted by `forge lint`. TypeScript and JS are formatted by Prettier (120 columns). Comments say why, not what.
