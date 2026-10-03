# Hedera, CCIP and CLI gotchas

Behaviour this template depends on, measured on Hedera testnet (services 0.77.2) and Base Sepolia while building it, with the transactions that show it. Each one either broke something or would have.

## Hedera Schedule Service (HIP-1215)

**A contract can schedule a call to itself, and the network runs it with no keeper.** The scheduled call arrives with `msg.sender == address(this)`, paid by the contract. Measured: a schedule due at second 1790882223 ran at 1790882223.04 ([schedule 0.0.10813640](https://hashscan.io/testnet/schedule/0.0.10813640)).

**`block.timestamp` trails consensus time.** That same call read `block.timestamp = 1790882221`: Hedera's EVM clock is the start of the ~2 s record-file block, not the transaction's consensus time. A callback that needs `block.timestamp > T` must be scheduled a few seconds after T. This template uses `BLOCK_CLOCK_MARGIN = 4`, and the HSS test double fires calls with the clock 3 s behind so tests fail without the margin.

**One `scheduleCall` per transaction.** A second one in the same transaction returns response code 373.

**A busy second costs as much as a successful schedule.** Each second holds about 15M gas of scheduled calls. Filling one second and scheduling into it again returned 370 (`SCHEDULE_EXPIRY_IS_BUSY`), and both transactions used exactly 1,436,980 gas ([22](https://hashscan.io/testnet/transaction/0x927993a3b5b5be9185a3e121d35970ce1473015a7419297bd592d18da3cca91e), [370](https://hashscan.io/testnet/transaction/0x8722ad017f736b001199f321a0ca6f4c7419e3c2d4f38619178d5d60c708069e)). Probe `hasScheduleCapacity` inside the transaction first. The relay's `eth_call` of that view is simulated by the mirror node and ignores throttles (it even returns true for a gas amount of 2²⁵⁶−1), so it cannot be trusted off-chain.

**An unfunded payer loses the schedule silently.** When the call fires, the payer must hold `gasLimit × gas price`. If it does not, the network records `INSUFFICIENT_PAYER_BALANCE`, emits nothing and does not retry. The payer was charged nothing when it held nothing ([schedule 0.0.10813682](https://hashscan.io/testnet/schedule/0.0.10813682), 1790882411.10), and a small fixed fee (0.027 HBAR) when it held some HBAR but less than the limit needs ([schedule 0.0.10816222](https://hashscan.io/testnet/schedule/0.0.10816222)). Keep the paying contract funded and keep a manual path.

**Never send `msg.value` to 0x16b.** The call fails with `INVALID_CONTRACT_ID` and burns all its gas. The `value` argument of `scheduleCall` is in tinybar and is taken from the payer when the call runs.

**Delays from 1 s to 62 days.** An expiry at or before now returns 307; beyond 62 days (5,356,800 s) returns 306.

**Contracts cannot sign schedules** (`signSchedule` from a contract is disabled since services 0.74), so this template uses only self-scheduled calls.

## Hedera EVM and JSON-RPC

**Two HBAR units.** Inside the EVM (`msg.value`, balances, CCIP fees) HBAR is tinybar, 8 decimals. Over JSON-RPC (`eth_getBalance`, a transaction's `value`, `eth_gasPrice`) it is weibar, 18 decimals. 1 HBAR is `1e8` in Solidity and `1e18` in a viem transaction. The frontend keeps every amount in tinybar and converts only at the RPC boundary (`lib/dao/units.ts`).

**The relay reserves `gasLimit × price` before running a transaction**, and rejects it if the sender cannot cover that. An EIP-1559 max fee roughly doubles the reservation, so the deploy scripts and the frontend send legacy transactions at `eth_gasPrice` (86 tinybar per gas when measured).

**Hedera bills the gas used, not the gas limit.** Every transaction and every scheduled callback measured for this template was charged exactly `gasUsed × the network's gas price`, whatever its limit: a callback with a 12,000,000 limit that used 1,609,796 gas cost 1.34 HBAR, not 80% of its limit (details in [Costs](costs.md)). The limit still has to be covered by a balance twice over: the relay refuses a transaction unless the sender holds `limit × eth_gasPrice`, and a scheduled call fails with `INSUFFICIENT_PAYER_BALANCE` unless its payer holds `limit × price` when it fires. `eth_gasPrice` quotes about 5% above the price the network bills (86–87 against 82–83 tinybar). The frontend sets each limit from the relay's estimate plus 25%, with a floor per call type (`GAS_FLOOR` in `lib/dao/source.ts`) for calls into system contracts.

**Accounts created from an EVM address associate automatically.** An account created by sending HBAR to a new EVM address has `max_automatic_token_associations = -1` (unlimited), so it can receive HGOV without associating first. Accounts with no free slot must call the token's HIP-719 `associate()`. The Voting power page reads the mirror node and tells the two apart.

**OpenZeppelin's `DEFAULT_ADMIN_ROLE` is `bytes32(0)`**, not `keccak256("DEFAULT_ADMIN_ROLE")` as the other roles' pattern suggests. Renouncing the hash succeeds and changes nothing; this template's first testnet deployment did exactly that. The deploy script reads every role id from the timelock and checks, before it finishes, that the deployer is no longer admin and the governor holds its roles.

**Multicall3 exists on testnet** at `0xcA11bde05977b3631167028862bE2a173976CA11`, though viem's chain definition does not list it. `scaffold.config.ts` adds it, so the frontend's reads batch into one call.

## Chainlink CCIP

**Lanes used:** Hedera testnet (selector `222782988166878823`, router `0x802C5F84eAD128Ff36fD6a3f8a418e339f467Ce4`) and Base Sepolia (selector `10344971235874465080`, router `0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93`).

**The two directions take very different times.** Hedera → Base took 32 s from the DAO's scheduled execute call ([message 0x6149f6c7…](https://ccip.chain.link/msg/0x6149f6c7ca36d269662cc089d5a9fe21ebd0107014733d99841531bcc4cb8639), proposal 3 in [PROOFS.md](../PROOFS.md)). An earlier probe also arrived in 35 s but then failed on Base because it asked for too little destination gas ([message 0x82309dcb…](https://ccip.chain.link/msg/0x82309dcb1ee3162ea6beacdc749053a890089c0c5bae84a5bb5711877faee026), shown as failed). Base → Hedera took 22 min 31 s ([message 0x5a19c501…](https://ccip.chain.link/msg/0x5a19c5012fedf18afff8e3e7cd076539923bcdb70558589786bd985c79bab44e)), almost all of it waiting for Base Sepolia to finalize the block; its finalized head ran 19–23 minutes behind. The frontend reads the current lag instead of quoting a fixed time.

**Size destination gas generously.** The first probe asked for 300,000 gas on Base and failed out of gas (`ReceiverError(0x)`); receiving a request and sending a receipt back measured 362,014 gas. Proposals default to 600,000.

**Receivers must answer ERC-165** for `IAny2EVMMessageReceiver` (`0x85572ffb`); otherwise the OffRamp does not deliver the data. Sent to an address with no code, the message's data is dropped.

**Quote the fee when you send.** Fees move with the destination chain's gas price, so a fixed `msg.value` eventually fails. `sendCrossChain` quotes `getFee` at execution, inside a scheduled call, and pays from the treasury.

**The CCIP explorer's message API** (`https://ccip.chain.link/api/h/atlas/message/<id>`) sends no CORS headers, so browsers cannot read it directly; the app proxies it through `/api/ccip/[messageId]`. It answers an id it has not indexed yet with HTTP 500 rather than 404.

## create-scaffold-hbar

**Pass the CLI's flags after `--` when you use npm's `create` command** (needed since npm's version 7): `create scaffold-hbar@latest my-dao -- --template owner/repo`. Without the `--`, npm's own parser keeps the flags and the CLI falls back to its interactive prompts. `npx create-scaffold-hbar@latest` needs no `--`.

**The CLI reads `template.json` from `main`** unless the template is given as `owner/repo#ref`, through GitHub's unauthenticated API (60 requests per hour per IP). If that fetch fails for any reason it silently falls back to default capabilities. This template's `template.json` sets the default package manager to npm.

**With npm, the CLI rewrites text files:** other package managers' commands become commands for npm, and every "npm" followed by a word becomes "npm run" plus that word, except for run, install, exec and ci. `scripts/check-docs.mjs` (part of `npm run lint`) and the template gate in CI keep this repository's files safe from that rewrite.

**The CLI needs a Git identity** (`git config user.name` and `user.email`) in the directory where it runs, for its initial commit. It checks before that directory is a repository, so an identity Git applies only inside some repositories (an `includeIf` rule) is not seen. Set a global one, or run the CLI inside a repository where the rule applies (`mkdir work && cd work && git init`), as the README describes.

**The CLI installs with `npm install --legacy-peer-deps`**, which drops packages that only arrive as peer dependencies. `ws` did: `isows` (used by viem's WebSocket transport, which RainbowKit imports) needs it at the top of `node_modules`, and without it every page failed to compile in a freshly scaffolded project. `ws` is therefore a direct dependency in the root `package.json`, and the template gate scaffolds through the CLI's own install so a gap like this fails in CI.

## Foundry

**Foundry 1.8.4 or later for linting.** Any version from 1.4 builds, tests and deploys, but `foundry.toml` configures lint rules by IDs that older versions reject (`Unknown lint ID: block-timestamp`), so `npm run lint` needs 1.8.4. Install the latest stable with `foundryup`, or exactly this version with `foundryup --install 1.8.4`.
