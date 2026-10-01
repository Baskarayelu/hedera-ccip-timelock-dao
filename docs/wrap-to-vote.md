# Why wrap to vote

Voters wrap the HTS governance token (HGOV) 1:1 into vHGOV, an OpenZeppelin `ERC20Votes` token, and delegate. The governor counts `getPastVotes(account, snapshot)`. This page explains why the extra step exists and what it protects against.

## The problem: HTS balances have no history

A safe token vote needs each voter's weight *at the moment the proposal opened* (its snapshot). Otherwise someone can buy or borrow tokens after a proposal opens, vote, and sell them again, or vote, move the tokens to a second wallet and vote again.

EVM governance tokens solve this with checkpoints: every transfer records the new balance with a timestamp, and the governor reads the balance at the snapshot. That only works if the token's own code runs on every transfer.

HTS tokens are native Hedera tokens. Most transfers are `CryptoTransfer` transactions that never touch the EVM, so no contract code runs and nothing can record a checkpoint. The token's EVM address (HIP-719) is a facade that redirects calls to the token service; it has no transfer hook. Hiero's account hooks (HIP-1195) are not enabled on Hedera testnet today (`hooks.hooksEnabled=false` in services 0.77.2), and even then a hook only runs when the sender's transfer names it.

## The answer: put the checkpoints on a wrapper

`VoteToken` is `ERC20Wrapper + ERC20Votes`:

- `depositFor` takes HGOV from the voter and mints the same amount of vHGOV. `withdrawTo` burns vHGOV and returns HGOV. The wrapper always holds exactly the HGOV it issued.
- vHGOV transfers are ordinary EVM transfers, so `ERC20Votes` records a checkpoint on each one.
- The clock is the block timestamp (`CLOCK_MODE` is `mode=timestamp`), because Hedera block numbers follow ~2-second record files of irregular length.
- The governor reads `getPastVotes(voter, snapshot)`. Tokens wrapped, delegated, bought or moved after a proposal opens count from the next proposal, and one set of tokens cannot vote twice on the same proposal.

The frontend shows this as four steps on the Voting power page (associate, claim, wrap, delegate) and explains on each proposal why an account can or cannot vote on it.

## What it costs, and the limits

- **Two extra transactions** per voter, once: approve and wrap. Delegation is needed with any `ERC20Votes` token.
- **Association.** The wrapper associates itself with HGOV at deploy time. Voters must be associated, or have a free automatic-association slot, to receive HGOV from the faucet and when they unwrap. Accounts created by sending HBAR to an EVM address get unlimited automatic associations, so for them this step is not needed; the Voting power page checks the mirror node and says which case applies.
- **Fees on the underlying token would break the 1:1 backing.** A fractional custom fee would deliver less than the deposit. `depositFor` checks the balance it actually received and reverts with `UnexpectedDeposit` if it differs, and the faucet creates HGOV with no fee schedule key so fees cannot be added later.
- **Keys on the underlying token could block unwrapping.** HGOV has only a supply key (held by the faucet contract): no freeze, pause, KYC, wipe or admin key.

## Alternatives considered

| Approach | Why not |
|---|---|
| Lock tokens in a vault and count the vault balance when someone votes | Without a snapshot, tokens locked after a proposal opens still count. Example: Hashgraph's accelerator DEX governor ([`HederaGovernor.sol` at `1957bec`](https://github.com/hashgraph/hedera-accelerator-defi-dex/blob/1957becf9992c376aa0201b38884282dc386f5b9/contracts/governance/HederaGovernor.sol#L405-L411)) returns `tokenHolder.balanceOfVoter(account)` and ignores the timepoint. Its holder contract blocks withdrawals while the voter has active votes, which stops the same tokens voting twice, but tokens bought and locked after a proposal opens still vote on it. |
| Snapshot balances from the mirror node | Trusts an off-chain indexer for the vote count, and testnet mirror snapshots lag. |
| Have the governor hold freeze or pause keys and freeze holders during votes | Freezes holders' tokens everywhere, including DEX pools, for the length of every vote. |
| Wait for Hiero hooks | Not enabled on testnet, and a hook only runs when the sender's transfer opts in, so it cannot guarantee a checkpoint. |
