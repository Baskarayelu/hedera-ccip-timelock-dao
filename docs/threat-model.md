# Threat model

What this template protects, against whom, and where it relies on trust. Contract and function names refer to `packages/foundry/contracts/`.

## Assets

- The treasury: HBAR and HTS tokens held by `DaoTimelock`.
- The callback float: HBAR held by `DaoGovernor`, which pays the network for scheduled calls.
- The DAO's account on Base Sepolia (`DaoAccount`) and anything it owns or controls there.
- The integrity of the vote: who can vote, with what weight, and that a passed proposal runs exactly as voted.

## Actors and trust

| Actor | Trusted for | Not trusted for |
|---|---|---|
| Token holders | Their own votes | Anything else |
| Anyone | Nothing: `queue`, `execute` and `rearm` are permissionless, and cannot change what runs | — |
| Hedera network (consensus, HSS) | Running scheduled calls at their second, once | Retrying a failed call |
| Chainlink CCIP | Delivering a message once, with the true source chain and sender | Timeliness, or a stable fee |
| Other DAOs using the shared executor | Nothing | Touching this DAO's account |
| The deployer | Wiring the DAO during deployment | Anything afterwards: the deploy script renounces the timelock's admin role |
| Mirror node, JSON-RPC relay, CCIP explorer | What the frontend displays | What the contracts do |

## Threats and mitigations

### Voting

| Threat | Mitigation |
|---|---|
| Buy or borrow tokens after a proposal opens and vote with them | Weight is `getPastVotes(voter, snapshot)` on the vHGOV wrapper, which checkpoints every transfer. Tokens wrapped or delegated after the snapshot count from the next proposal. See [Why wrap to vote](wrap-to-vote.md). |
| Vote, move the tokens, vote again | Checkpoints fix each wallet's weight at the snapshot, and OpenZeppelin's `GovernorCountingSimple` allows one vote per address. |
| Wrapper under-collateralised by token fees | `VoteToken.depositFor` mints only what arrived and reverts with `UnexpectedDeposit` otherwise; HGOV has no fee schedule key. |
| **Anyone can mint votes from the faucet** | **Demo only.** `GovTokenFaucet.claim` gives any account 1,000 HGOV per cooldown, so a determined actor with many accounts can gather a majority. It exists so judges and testers can vote. A real DAO should mint a fixed supply to its holders and drop the faucet. |
| A malicious proposal passes | Ordinary governance risk. The timelock delay is the window to react; the demo's 2 minutes is for testing only (`TIMELOCK_DELAY_SECONDS`). |

### Keeperless execution

| Threat | Mitigation |
|---|---|
| A busy second (response 370) costs gas and schedules nothing | `HssScheduler` probes `hasScheduleCapacity` inside the transaction for up to 8 consecutive seconds and calls `scheduleCall` once, in the first second with room. The relay's `eth_call` ignores throttles, so only the in-transaction probe is trusted. |
| The schedule service is busy or unavailable | `propose` and `queue` still succeed; the governor emits `AutoActionUnavailable` with the response code, and anyone can `queue`, `execute` or `rearm` by hand. |
| A callback fires before voting has really ended | Callbacks are scheduled 4 s after their target (`BLOCK_CLOCK_MARGIN`), because `block.timestamp` trails consensus time by up to ~3 s. Each callback also checks the proposal's state and emits `AutoActionSkipped` instead of acting when it is not ready. |
| The float cannot pay when a callback fires | The network consumes the schedule silently (`INSUFFICIENT_PAYER_BALANCE`, no event). The frontend reads the schedule's result from the mirror node, shows the float balance, and offers "Schedule it again" and "Queue now" / "Execute now". Anyone can send HBAR to the governor to top up the float. |
| A callback reverts | `autoQueue`/`autoExecute` catch the revert and emit `AutoActionFailed` with the reason, which the frontend decodes (for example `FeeAboveCap`). The proposal stays queued and can be executed or rescheduled. |
| Someone fakes a callback | `autoQueue` and `autoExecute` revert with `OnlySelf` unless the caller is the governor itself, which only the schedule service can make it be. |
| Draining the float with `rearm` | `rearm` is refused while an earlier callback for the same step is still pending (`AlreadyArmed`) and once the step no longer applies (`NotRearmable`), so it only works while a step is failing. Each rearm costs the caller the scheduling gas (about 1.2 HBAR) and costs the float at most the callback's gas. The float holds only what is needed for callbacks, and governance can withdraw it (`withdrawFloat`). |
| Cancelled proposals still cost the float | `_cancel` deletes the pending schedules through the schedule service. |

### Cross-chain

| Threat | Mitigation |
|---|---|
| Someone other than CCIP calls the executor or the timelock's receiver | `CcipReceiverBase` accepts `ccipReceive` only from the configured router (`NotRouter`). |
| Another DAO acts through this DAO's account | The executor derives the account from the CCIP-authenticated (source chain, sender) pair. Each pair gets its own deterministic clone, and only that clone's creator, the executor, can drive it. |
| The same message is delivered twice | `CrossChainExecutor.statusOf[messageId]` is set once; a second delivery reverts with `AlreadyProcessed`. |
| A delayed message runs long after the vote | Each request carries `validUntil` (24 h after sending by default, `REQUEST_TTL_SECONDS`). The executor reports `Expired` instead of running it. |
| The CCIP fee spikes | The proposal carries a voted fee cap. `sendCrossChain` quotes at execution and reverts with `FeeAboveCap` above it, so the treasury never pays more than voters approved. |
| One call in the batch fails on Base | `DaoAccount.executeCalls` is atomic: any failing call reverts the batch with `CallFailed(index, reason)`. The receipt carries the reason (truncated to 256 bytes so the receipt fee stays bounded). |
| The executor runs out of gas receiving a message | CCIP marks the message failed, and it can be re-executed with more gas from the CCIP explorer; the executor still processes it once and still checks expiry. The frontend shows this state. |
| A forged receipt on Hedera | `DaoTimelock._ccipReceive` accepts a receipt only from the executor registered for that source chain, only for a request it sent to that chain, and only once (`UnknownSender`, `UnknownRequest`, `DuplicateReceipt`). |
| The receipt cannot be paid | The executor pays from the DAO's account first, then from a sponsor pool capped per DAO (10 receipts by default). If neither can pay it emits `ReceiptNotSent`; the outcome is still on Base, where the frontend reads it. |
| Re-entering the executor from a target | `_ccipReceive` is `nonReentrant` (OpenZeppelin `ReentrancyGuardTransient`). |

### Configuration and keys

- The deploy script ends by renouncing the deployer's `DEFAULT_ADMIN_ROLE` on the timelock. After that, registering an executor (`setRemoteExecutor`) or associating a token (`associateToken`) needs a proposal.
- The governor's settings (`setAutoGasLimit`, `withdrawFloat`, voting settings) are `onlyGovernance`.
- The executor on Base has no owner; its router, receipt gas and sponsor cap are immutable.
- HGOV's only key is the supply key, held by the faucet contract, whose only minting path is `claim`. There is no admin key, so the token's configuration cannot change.

### The frontend

The app reads public infrastructure (the Hedera mirror node, the Hashio relay, the CCIP explorer through a small proxy route, and a Base Sepolia RPC) to display state. A compromised or stale provider can mislead the display, never the contracts. Every value the app shows links to HashScan, the CCIP explorer or Basescan so it can be checked independently.
