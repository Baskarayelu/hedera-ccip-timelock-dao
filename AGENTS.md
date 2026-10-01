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
| `packages/nextjs/` | Next.js App Router frontend (RainbowKit, wagmi, viem, DaisyUI) |

## Commands

Run them from the repository root.

```bash
npm install
npm run test                        # all Foundry tests
npm run lint                        # Prettier, forge fmt, forge lint (needs Foundry 1.8.4+)
npm run build                       # forge compile + next build
npm run next:dev                    # http://localhost:3000

npm run foundry:account:generate    # writes a fresh testnet key to packages/foundry/.env
npm run foundry:deploy:remote       # Base Sepolia executor (shared; normally already deployed)
npm run foundry:deploy:hedera       # a complete DAO on Hedera testnet
npm run foundry:export              # regenerate packages/nextjs/contracts/deployedContracts.ts
```

Keys come from `.env.local` at the repository root, then `packages/foundry/.env`. Both are gitignored. Never print a key, and never commit either file.

## Hedera rules that break things silently

- **Two HBAR units.** Inside the EVM, `msg.value`, balances and CCIP fees are in **tinybar** (8 decimals). A JSON-RPC `value` is in **weibar** (18 decimals), so 1 HBAR is `1e8` in Solidity and `1e18` in a viem transaction.
- **`block.timestamp` trails consensus time.** It is the start of the ~2 s record-file block, so a scheduled call due at second S can read S - 3. Schedule a callback that needs `block.timestamp >= T` at `T + BLOCK_CLOCK_MARGIN` (4 s).
- **One `scheduleCall` per transaction.** A second one returns response code 373. A busy second returns 370 and still costs ~1.4M gas, so probe `hasScheduleCapacity` inside the transaction first; the relay's `eth_call` ignores throttles. `HssScheduler._scheduleSelfCall` does all of this; reuse it.
- **Never send `msg.value` to 0x16b.** The call fails and burns all its gas.
- **A scheduled call runs once.** If the payer cannot cover `gasLimit × gas price` when it fires, the schedule is consumed with no event and no retry. Keep the governor's float funded, and keep `queue`, `execute` and `rearm` permissionless.
- **Auto-execution goes through `Governor.execute`**, not the timelock directly. OpenZeppelin's `onlyGovernance` checks only pass on that path.
- **HTS association.** Accounts and contracts must be associated with an HTS token before receiving it. Contracts associate through the token's HIP-719 `associate()`, then confirm with `isAssociated()`.
- **The relay reserves `gasLimit × price` up front.** Send Hedera transactions as legacy transactions with explicit gas limits; estimates undercount system-contract work.
- **CCIP receivers must answer ERC-165** for `IAny2EVMMessageReceiver` (`0x85572ffb`), or the OffRamp drops the data. Size destination gas generously: a receiver that also sends a receipt needed ~362k gas on Base Sepolia.

## Tests

- `MockHederaScheduleService` is etched at `0x16b`. It models busy seconds, the per-transaction limit, the 62-day window, unfunded payers and the 3 s block-clock lag. Call `hss.newTransaction()` between simulated transactions and `hss.executeDue()` to let the network fire due schedules.
- `MockCcipRouter` instances with different chain selectors model two chains in one EVM; `deliver(source, id)` plays the OffRamp.
- HTS tests use hedera-forking's emulation with `OfflineMirrorNode`, so they run without network access.

## Writing docs in this repository

When `create-scaffold-hbar` scaffolds with npm, it rewrites text files: commands for other package managers are rewritten for npm, and every "npm" followed by a word becomes "npm run" plus that word. In Markdown, write commands only as `npm run <script>`, `npm install` or `npx …`, and never put another word straight after "npm". The template gate in CI fails if any scaffolded Markdown differs from the source.

## Style

Match the surrounding code. Solidity is formatted by `forge fmt` (120 columns) and linted by `forge lint`. TypeScript and JS are formatted by Prettier (120 columns). Comments say why, not what.
