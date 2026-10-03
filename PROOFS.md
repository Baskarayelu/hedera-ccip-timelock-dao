# Proofs

Everything below happened on Hedera testnet and Base Sepolia on 2 October 2026, through this repository's app and contracts: one DAO, two voters, four proposals. The Hedera network itself (HIP-1215 scheduled calls) queued each proposal and then executed it, or for proposal 2 stopped it at its fee cap; no keeper, bot or second transaction was involved after the votes.

`npm run check:proofs` re-verifies every link in this file, and CI runs it on every push and once a day. Links that prove a specific effect (an event, a revert reason, a token transfer) are checked for it too; the expectations live in [`docs/proofs.json`](docs/proofs.json).

## The DAO

| Contract | Address |
|---|---|
| `DaoGovernor` | [0x7d1e2fa702d137b019c44b9a562e04dd89cf7468](https://hashscan.io/testnet/contract/0x7d1e2fa702d137b019c44b9a562e04dd89cf7468) |
| `DaoTimelock` (treasury, CCIP outbox and inbox) | [0xa895bf23411339f0bc19ee7859be455dcfb57d18](https://hashscan.io/testnet/contract/0xa895bf23411339f0bc19ee7859be455dcfb57d18) |
| `VoteToken` (vHGOV) | [0x12a964056dbc26ad3206f03191daa7cf5d8c6bfa](https://hashscan.io/testnet/contract/0x12a964056dbc26ad3206f03191daa7cf5d8c6bfa) |
| `GovTokenFaucet` | [0xc3467144fea2d32329cb42d95e5190355834749a](https://hashscan.io/testnet/contract/0xc3467144fea2d32329cb42d95e5190355834749a) |
| HGOV (HTS token 0.0.10822898) | `0x0000000000000000000000000000000000A524F2` |
| The DAO's account on Base Sepolia | [0xa0E81699e1BC4f571d90A941b01420796192B124](https://sepolia.basescan.org/address/0xa0E81699e1BC4f571d90A941b01420796192B124) |
| Shared `CrossChainExecutor` on Base Sepolia | [0x9b7691b0766a55d8509b07cb633ce281fee2a632](https://sepolia.basescan.org/address/0x9b7691b0766a55d8509b07cb633ce281fee2a632) |

Settings: 1 minute voting delay, 5 minute vote, 2 minute timelock, 4% quorum; callback gas limits 3,000,000 (queue) and 1,500,000 (execute).

### Deployment

From `0x92947b03E93c5c9517A573Ca4270794fBE407218`, with `npm run foundry:deploy:hedera`. That account (voter A below) kept the timelock's admin role until the last row, at 18:43 UTC on 2 October: after the four proposals and the top-ups. The timelock's logs show it was never used: no role granted or revoked, no executor or token changed between the deployment and the renounce. Since then the deployer holds no role, and the timelock administers itself: only proposals can change it.

| Step | Transaction |
|---|---|
| Deploy `GovTokenFaucet` | [0x0acd35c2…](https://hashscan.io/testnet/transaction/0x0acd35c21e7d6e641cf9e85a8ca01ffacebe8ca0eccfa856085c12640a42c0ef) |
| Create the HGOV HTS token | [0xef94c444…](https://hashscan.io/testnet/transaction/0xef94c444f1d5774e8e9bd78a66766f045e46805ae4ac9daa182493535a478ae7) |
| Deploy `VoteToken` | [0x8e23a308…](https://hashscan.io/testnet/transaction/0x8e23a308512e404455949407fcbc339848b718718c5bc3fc9ad25203608fa5ee) |
| Associate `VoteToken` with HGOV | [0x09f799f4…](https://hashscan.io/testnet/transaction/0x09f799f42f6b2dc2853ddd922e7b560da7eba4d2986d2526e3d383c082299e96) |
| Deploy `DaoTimelock` | [0x9f9317df…](https://hashscan.io/testnet/transaction/0x9f9317dfff44d8c94932d6c35bbd671fffcda46acebe7abe48711916100188a9) |
| Deploy `DaoGovernor` | [0x620a1640…](https://hashscan.io/testnet/transaction/0x620a1640ce9b756baa4ac6e90bc101828e7fab3521cb527c38dd3e0a3127218f) |
| Governor may propose | [0x29c0f094…](https://hashscan.io/testnet/transaction/0x29c0f094ab47243bbd2f6e7db804eb93f9bf9fd9babfec369d16f306a60b5ac4) |
| Governor may cancel | [0x3851b701…](https://hashscan.io/testnet/transaction/0x3851b70193dbdb3cc5c6736563dff9c52b507bc4cc5cc4c71981ffb21680aae3) |
| Register the Base Sepolia executor | [0x35632a0d…](https://hashscan.io/testnet/transaction/0x35632a0df35f5303638286d50f93f1e9984e5e62ef625311ee9aa0ab6eeae670) |
| Associate the treasury with HGOV | [0xd98d67eb…](https://hashscan.io/testnet/transaction/0xd98d67eb73412de83eaba347190e08967ffd03a5b3f510cc2ceb71142c2818f5) |
| Fund the callback float (15 HBAR) | [0xfc58fc46…](https://hashscan.io/testnet/transaction/0xfc58fc46eb4083de7d9e24e4e61733330277bc370a957d0cd3d3c1e97e08e791) |
| Fund the treasury (20 HBAR) | [0x18a97f32…](https://hashscan.io/testnet/transaction/0x18a97f32bad66b5faa81545737ae398606cff7e385d0e7cc2ca1ed2c5e269d87) |
| Deployer renounces the admin role: this call used the hash of the role's name instead of OpenZeppelin's `0x00` id, so it changed nothing | [0x71d7e751…](https://hashscan.io/testnet/transaction/0x71d7e7510d9e5449bd7785840486c9d1c54b789404c6178f953804d50f96eb45) |
| Deployer renounces the real admin role (`RoleRevoked(0x00, deployer)`), after a first-time run of the README caught the mistake; the deploy script now reads role ids from the contract and checks the roles before it finishes | [0x2cbaefb9…](https://hashscan.io/testnet/transaction/0x2cbaefb963fe024fc426f9b16e7c26fc8c65331fd2782957c2b01a9cbd318bef) |

After the four proposals, the deployer topped up the callback float and the treasury so that people trying the DAO have room to run their own proposals (anyone can send HBAR to either):

| Top-up | Transaction |
|---|---|
| Callback float +100 HBAR | [0x7d84caf4…](https://hashscan.io/testnet/transaction/0x7d84caf49f15d194991c5304359bc3d01b9a2c007e99a88bf84a0f3785bdea0c) |
| Treasury +50 HBAR | [0xc188dd09…](https://hashscan.io/testnet/transaction/0xc188dd09fc0c086b8c1932c1c7d1966f0735cbe7e25086018b03540a352f9b54) |

### Voting power

Two voters, each through the app's *Voting power* page. Both accounts associate with new tokens automatically, so neither needed the association step.

| Step | Voter A `0x9294…7218` (wrapped all 1,000 HGOV) | Voter B `0x3f24…1Bd7` (wrapped 600 of its 1,000 HGOV) |
|---|---|---|
| Claim 1,000 HGOV | [0xe6964a49…](https://hashscan.io/testnet/transaction/0xe6964a492ea01949d92e4e3e68d3ac029f82b9a975c03ae73d3a6aa76b90e4ac) | [0xd2a94d55…](https://hashscan.io/testnet/transaction/0xd2a94d55f75f78081f0f976bccb1d5b59063f26374e6a8e49841394dd9c29152) |
| Approve | [0xc67b4f04…](https://hashscan.io/testnet/transaction/0xc67b4f0428aeabb76cc78fc26c55317b3f9404f34fca81f364403d8a3d6c0b23) | [0x22ff32bc…](https://hashscan.io/testnet/transaction/0x22ff32bccdfbd64e8427833652fa352ee8a788c3a84ca519a8987cf105107388) |
| Wrap | [0x9ec7aca7…](https://hashscan.io/testnet/transaction/0x9ec7aca7cc6a1f968e5231e5466f993e67461d77d523499738faa46e5d65e859) | [0x42789ca0…](https://hashscan.io/testnet/transaction/0x42789ca0240ba4852b5147a1f9398c81775ee572b72ff19f28b1430c2e02f647) |
| Delegate to self | [0xe743de65…](https://hashscan.io/testnet/transaction/0xe743de653ed6705e6849251d7f5a290eb5cd6374a039c2eca46369cd5adafb98) | [0x68fd0786…](https://hashscan.io/testnet/transaction/0x68fd07863ff07314dcc6a49d768d36b36b078288afca9c71032de3e3fde1dac9) |

Voter A proposed all four proposals; both voted For on each. Voter A's four setup transactions cost 1.42 HBAR in gas; each proposal then cost them about 1.23–1.24 HBAR to create and 0.07 HBAR to vote on, so setup, one proposal and its vote came to 2.72 HBAR (proposal 1) or 2.73 HBAR (proposal 3).

## Proposal 1: a Hedera-only payment

*Pay a 2 HBAR contributor grant.* The treasury sends 2 HBAR on Hedera.

| Step | Proof |
|---|---|
| Proposed (also scheduled the network to queue it) | [0x589a6ec3…](https://hashscan.io/testnet/transaction/0x589a6ec395edade6c41861da56502c9536ab85d0418e3dc5af6baec58f2c0249) |
| Votes: A, B | [0xa4620fb2…](https://hashscan.io/testnet/transaction/0xa4620fb2de2c103a8057108eb85f8eae7b6a4b6feab5a24e07ba832c3cd57026), [0x9818260c…](https://hashscan.io/testnet/transaction/0x9818260cda97f6467a9e0f684d87706cc82780b2b398748c2e6a2de086673aa4) |
| The network queued it, 5 s after voting ended | [schedule 0.0.10823011](https://hashscan.io/testnet/schedule/0.0.10823011) |
| The network executed it, 4 s after the timelock ended | [schedule 0.0.10823075](https://hashscan.io/testnet/schedule/0.0.10823075) |

## Proposal 2: the fee cap stops an execution

*Set protocol.maxSlippageBps with a fee cap below the quote.* The proposal allows at most 0.50 HBAR for the CCIP fee; the router quoted 1.138 HBAR when it executed.

| Step | Proof |
|---|---|
| Proposed | [0xe2015350…](https://hashscan.io/testnet/transaction/0xe2015350578a9c4553b1b5c9394de14f3cc1e5d55ba87ff7769344426126b1d1) |
| Votes: A, B | [0xe12bf54c…](https://hashscan.io/testnet/transaction/0xe12bf54c87deeab3be90de9c1c93562b6f4f483387667a1731e34685479ff104), [0xc374cec1…](https://hashscan.io/testnet/transaction/0xc374cec1bbb4f5bb606ba18f282bdf620ac040856a4ac804b097caee8dba8b48) |
| The network queued it | [schedule 0.0.10823129](https://hashscan.io/testnet/schedule/0.0.10823129) |
| The network's execution stopped: `AutoActionFailed` carrying `FeeAboveCap(113801892, 50000000)`. Nothing left the treasury and the proposal stays queued. | [schedule 0.0.10823188](https://hashscan.io/testnet/schedule/0.0.10823188) |

On the proposal's page, *Execute now* from a funded wallet then showed "the CCIP fee was 1.13 HBAR, above the 0.50 HBAR cap this proposal allows" (the app cuts HBAR amounts to two decimals) and sent nothing: the app estimates every transaction first and refuses one that would revert with a reason the DAO's contracts define. (A wallet with no Hedera account yet is asked to fund it first: the relay cannot simulate a transaction for it.)

## Proposal 3: a parameter on Base Sepolia

*Set the Base protocol fee to 30 bps.* The DAO's account on Base calls `RemoteParameters.set("protocol.feeBps", 30)`.

| Step | Proof |
|---|---|
| Proposed | [0x2f3ccd3b…](https://hashscan.io/testnet/transaction/0x2f3ccd3b4908d5459a16874c21be4e305cbc335e1a605cd09abfcc91ff3c2de6) |
| Votes: A, B | [0x8db8db67…](https://hashscan.io/testnet/transaction/0x8db8db6767579ddc4ac1828ce1deeaa30c97f51c9f3ed4cb89c0ecca2c603dc9), [0x45398744…](https://hashscan.io/testnet/transaction/0x453987445d15f5db665a6461eaa6a12f67da26c9e4cb5515db67aefc81e4df0f) |
| The network queued it | [schedule 0.0.10823152](https://hashscan.io/testnet/schedule/0.0.10823152) |
| The network executed it and sent one CCIP message (fee 1.138 HBAR, quoted then) | [schedule 0.0.10823215](https://hashscan.io/testnet/schedule/0.0.10823215) |
| CCIP delivered it to Base Sepolia, 32 s later | [message 0x6149f6c7…](https://ccip.chain.link/msg/0x6149f6c7ca36d269662cc089d5a9fe21ebd0107014733d99841531bcc4cb8639) |
| The DAO's account set `protocol.feeBps` to 30, and the executor sent a receipt paid from that account | [Base tx 0x68d095ac…](https://sepolia.basescan.org/tx/0x68d095ac6568d6c08ebfecae780cb76229e68154ca1b7591d1524a766e637886) |
| The receipt travelled back after Base Sepolia finality | [message 0xcd76f3d0…](https://ccip.chain.link/msg/0xcd76f3d0087c761a8e6a0bdb9885808be78bf718a0a33d4ec930e813ee4e6d4a) |
| The timelock recorded it (`CrossChainReceipt`, Executed), 23 min 54 s after the call ran on Base | [0xbb278a03…](https://hashscan.io/testnet/transaction/0xbb278a037e6560ed33a25787357b55a38c0c01ecd5731bf79b236c7011349bcd) |

## Proposal 4: a USDC payout on Base Sepolia

*Pay a 5 USDC contributor grant on Base.* The DAO's account on Base transfers 5 USDC (Circle's testnet USDC) to `0x3f24…1Bd7`.

| Step | Proof |
|---|---|
| Proposed | [0xa6077ed2…](https://hashscan.io/testnet/transaction/0xa6077ed25d1c3ba87e959c0f700715013d343e9a78456002075ef89c00d7866d) |
| Votes: A, B | [0x9448cba4…](https://hashscan.io/testnet/transaction/0x9448cba4f9ab429b48df588be3d4355e7e464ee4e33fd1fd359c0dde9d5ec9f2), [0xd219926d…](https://hashscan.io/testnet/transaction/0xd219926d314d164d8a5e02bf8f4351b485ab87ae8a7221f0fa9cee4d6d528b88) |
| The network queued it | [schedule 0.0.10827814](https://hashscan.io/testnet/schedule/0.0.10827814) |
| The network executed it and sent one CCIP message (fee 1.139 HBAR) | [schedule 0.0.10827874](https://hashscan.io/testnet/schedule/0.0.10827874) |
| CCIP delivered it to Base Sepolia, 35 s later | [message 0x05bc641e…](https://ccip.chain.link/msg/0x05bc641e81a835af93504dc180ddd7e5d1c781399690135c59c9583ddb8f2561) |
| 5 USDC moved from the DAO's account to the recipient; receipt paid from the DAO's account | [Base tx 0xc13c775b…](https://sepolia.basescan.org/tx/0xc13c775bb0a5a525ae96eb5f6dc320a83c10bf5a3cc40ea6998e13af8c988875) |
| The receipt travelled back after Base Sepolia finality | [message 0xc929a98e…](https://ccip.chain.link/msg/0xc929a98e93acb1aae7bb8f8d623efed14e25dae21577ff52f02b87716510b0a3) |
| The timelock recorded it (`CrossChainReceipt`, Executed), 22 min 13 s after the call ran on Base | [0x495b93a6…](https://hashscan.io/testnet/transaction/0x495b93a602034d7b68c75c81f14f7a411fe058070a80ad2aeb37d0cd270aa1d8) |

## What the runs measured

| | Proposal 3 | Proposal 4 |
|---|---|---|
| Voting ended → queued by the network | 5 s | 5 s |
| Timelock ended → executed by the network | 4 s | 4 s |
| Executed on Hedera → ran on Base Sepolia | 32 s | 35 s |
| Ran on Base → receipt recorded on Hedera | 23 min 54 s | 22 min 13 s |

The receipt leg is almost all Base Sepolia finality: the blocks with the calls finalized 23 min 34 s (proposal 3) and 21 min 32 s (proposal 4) after they ran, and CCIP took 20 s and 41 s after that. Gas and HBAR for every step are in [Costs](docs/costs.md).
