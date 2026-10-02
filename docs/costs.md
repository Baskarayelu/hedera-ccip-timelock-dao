# Costs

What each step costs on Hedera testnet, measured from mirror-node records in October 2026. HBAR figures use 83 tinybar per gas, the price the network billed while these were measured (it moves with the HBAR/USD rate; it was 81–83 over the measurements). Gas figures do not move.

## How Hedera bills gas

**A transaction, and a scheduled call, is billed for the gas it used. The gas limit is never billed, but it has to be covered by a balance.**

- The JSON-RPC relay refuses a transaction unless the sender holds `gasLimit × eth_gasPrice`. `eth_gasPrice` quotes about 5% above the price the network bills (86–87 against 82–83 tinybar per gas).
- A scheduled call fails with `INSUFFICIENT_PAYER_BALANCE` unless its payer holds `gasLimit × gas price` when it fires. The network still charges a small fixed fee for that failed attempt, and the schedule is consumed: it never retries.
- When the call runs, the payer is charged `gasUsed × gas price`, exactly.

Measured on a test DAO deployed with a 12,000,000 gas limit for its queue callback and a 5 HBAR float:

| Step | Gas limit | Gas used | Charged | Link |
|---|---:|---:|---:|---|
| Queue callback fires; the float holds 5 HBAR, less than 12,000,000 × 83 tinybar = 9.96 HBAR | 12,000,000 | none (not run) | 0.0272 HBAR (fixed fee), `INSUFFICIENT_PAYER_BALANCE` | [schedule 0.0.10816222](https://hashscan.io/testnet/schedule/0.0.10816222) |
| Same callback after topping the float up to 11.97 HBAR and pressing *Schedule it again* | 12,000,000 | 1,609,796 | 1.3361 HBAR = 1,609,796 × 83 tinybar | [schedule 0.0.10816306](https://hashscan.io/testnet/schedule/0.0.10816306) |
| Ordinary transaction: deploying `DaoGovernor` | 8,000,000 | 5,153,549 | 4.2259 HBAR = 5,153,549 × 82 tinybar | [tx 0x2b097fa3…](https://hashscan.io/testnet/transaction/0x2b097fa33f44bfef1c757786b7aba6ec0027ee26715a8fdd17b01e18680db9d0) |

Billing at 80% of the limit would have charged 7.97 HBAR for the second row. It charged 1.34.

**What this means for gas limits.** A generous limit costs nothing extra. It only raises the balance that has to be there: the sender's for a transaction, the governor's float for a callback. The frontend sets each limit from the relay's estimate plus 25%, never below a per-call floor (`GAS_FLOOR` in `packages/nextjs/lib/dao/source.ts`) of about 1.25 times the gas measured below.

## Callback gas limits

The governor pays for two scheduled calls per proposal from its float. Their limits are deploy settings (`AUTO_QUEUE_GAS`, `AUTO_EXECUTE_GAS`) and governance can change them later with `setAutoGasLimit`.

| Callback | Measured gas used | Default limit | Margin |
|---|---|---:|---|
| `autoQueue`: queues the proposal and schedules `autoExecute` | 1,602,335 (one action) to 1,697,904 (five actions); 2,164,590 with 4 KB of calldata | 3,000,000 | 1.39× the 4 KB proposal. Each extra byte of proposal costs about 137 gas, because the whole proposal travels in the schedule. |
| `autoExecute`: executes the proposal, including any CCIP send | 108,205 (an HBAR transfer) to 538,891 (HBAR and token transfers plus a three-call CCIP message) | 1,500,000 | 2.8× the five-action proposal. Room for one heavy Hedera action, such as an HTS association (about 740,000), next to a CCIP send (about 466,000). |

With the defaults, the float must hold at least 3,000,000 × 83 tinybar = 2.49 HBAR whenever a callback fires; the Proposals page warns when it does not. A callback that fails or is refused is recovered from the proposal's page: *Schedule it again* (the caller pays to schedule, the float pays to run), or *Queue now* / *Execute now* (the caller pays).

Every callback measured, each run once by the network with no keeper:

| Proposal | Callback | Gas used | Schedule |
|---|---|---:|---|
| One Base action | queue | 1,609,796 | [0.0.10816306](https://hashscan.io/testnet/schedule/0.0.10816306) |
| One Base action | execute, CCIP send | 465,652 | [0.0.10816307](https://hashscan.io/testnet/schedule/0.0.10816307) |
| One Hedera action (HBAR) | queue | 1,602,335 | [0.0.10816346](https://hashscan.io/testnet/schedule/0.0.10816346) |
| One Hedera action (HBAR) | execute | 108,205 | [0.0.10816409](https://hashscan.io/testnet/schedule/0.0.10816409) |
| Fee cap below the quote | execute, stopped by `FeeAboveCap` | 199,874 | [0.0.10816433](https://hashscan.io/testnet/schedule/0.0.10816433) |
| Five actions on both chains | queue | 1,697,904 | [0.0.10822331](https://hashscan.io/testnet/schedule/0.0.10822331) |
| Five actions on both chains | execute, CCIP send | 538,891 | [0.0.10822390](https://hashscan.io/testnet/schedule/0.0.10822390) |
| 4 KB of calldata | queue | 2,164,590 | [0.0.10822422](https://hashscan.io/testnet/schedule/0.0.10822422) |
| 4 KB of calldata | execute | 211,188 | [0.0.10822480](https://hashscan.io/testnet/schedule/0.0.10822480) |

## What a participant pays

| Step | Gas used | HBAR |
|---|---:|---:|
| Associate the governance token (only when the account has no free association slot) | 726,488 | 0.60 |
| Claim 1,000 HGOV from the faucet | 787,895 | 0.65 |
| Approve the vote token to take HGOV | 727,020 | 0.60 |
| Wrap HGOV into vHGOV | 145,894 | 0.12 |
| Delegate | 95,644 | 0.08 |
| Propose (one to five actions) | 1,513,796–1,599,086 | 1.26–1.33 |
| Vote | 83,238 | 0.07 |
| Unwrap | 123,548 | 0.10 |
| Cancel a pending proposal (also deletes its scheduled callback) | 124,758 | 0.10 |
| *Schedule it again* | 1,495,029 | 1.24 |
| *Execute now* (an HBAR transfer and one Base action) | 465,311 | 0.39, plus the CCIP fee from the treasury |

Setting up and taking part once (claim, approve, wrap, delegate, propose, vote) spends about 2.8 HBAR, or 3.4 with an association. On the official DAO it cost voter A 2.73 HBAR ([PROOFS.md](../PROOFS.md)). The relay also wants each transaction's `gasLimit × eth_gasPrice` on hand when it is sent; for a proposal that is about 2.1 HBAR. **About 10 HBAR covers every step** with room to spare.

## What a proposal costs the DAO

For a proposal with one action on Base Sepolia:

| Who pays | What | HBAR |
|---|---|---:|
| Float | Queue callback | 1.33 |
| Float | Execute callback, including the CCIP send | 0.39 |
| Treasury | CCIP fee to Base Sepolia, quoted at execution | 1.14–1.17 measured |
| The DAO's account on Base | Receipt back to Hedera | 0.000058–0.000059 ETH ([ReceiptSent](https://sepolia.basescan.org/tx/0xf71f51a3004a236b302da643b780033ecea278cd9eeb658518e4c72dcff14e66)) |

A Hedera-only proposal costs the float 1.33 + 0.09 HBAR and no CCIP fee. A callback refused for a short float costs it 0.0272 HBAR. The executor on Base pays the receipt from the DAO's account when it holds enough ETH, otherwise from its sponsor pool (ten receipts per DAO).

## Measured again on the official DAO

The DAO in [PROOFS.md](../PROOFS.md) runs with the default limits (3,000,000 and 1,500,000). Its callbacks used the same gas as the test DAO's, and each was billed exactly gas used × 81 tinybar, the price that day:

| Proposal | Queue callback | Execute callback | CCIP fee (treasury) | Receipt fee (DAO's Base account) |
|---|---:|---:|---:|---:|
| 1. Hedera-only payment | 1,602,335 gas | 108,205 gas | none | none |
| 2. Fee cap below the quote | 1,609,952 gas | 200,018 gas, stopped by `FeeAboveCap` | not charged | none |
| 3. Parameter on Base | 1,609,844 gas | 465,700 gas | 1.138 HBAR | 0.0000579 ETH |
| 4. 5 USDC payout on Base | 1,609,928 gas | 465,784 gas | 1.139 HBAR | 0.0000587 ETH |

Its deployment cost 21.73 HBAR in gas and fees, plus the 35 HBAR of default float and treasury funding.

## Deploying a DAO

Measured on the same test DAO:

| Step | Gas used | HBAR |
|---|---:|---:|
| `GovTokenFaucet` | 868,000 | 0.71 |
| Create the HTS token (gas plus the network's token-creation fee; the deploy sends 30 HBAR and the faucet returns what is not charged) | 193,389 | 11.73 |
| `VoteToken` | 2,073,421 | 1.70 |
| Associate the vote token with HGOV | 739,153 | 0.61 |
| `DaoTimelock` | 2,764,364 | 2.27 |
| `DaoGovernor` | 5,153,549 | 4.23 |
| Roles, executor registration, treasury association, admin renounce | 918,181 | 0.75 |
| **Contracts and token** | | **22.0** |
| Callback float (`GOVERNOR_FLOAT_HBAR`) | | 15 |
| Treasury (`TREASURY_HBAR`) | | 20 |
| **Total with the default funding** | | **about 57** |

The largest single transaction, the governor's deployment, needs 8,000,000 × 87 tinybar = 7 HBAR on hand, and token creation briefly needs the 30 HBAR it sends.
