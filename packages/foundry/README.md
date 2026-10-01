# Contracts

Foundry workspace for the DAO on Hedera testnet and its executor on Base Sepolia. Run these commands from the repository root.

## Test

```bash
npm run test
```

The tests need no network: the Hedera Schedule Service, the CCIP routers and the mirror node are test doubles in `test/mocks/`, built to match behaviour measured on testnet.

## Deploy your own DAO

1. Create a deployer key and fund it with testnet HBAR at https://portal.hedera.com/faucet:

   ```bash
   npm run foundry:account:generate
   ```

2. Deploy. This uses the shared executor already on Base Sepolia (`deployments/84532.json`), so you only need HBAR:

   ```bash
   npm run foundry:deploy:hedera
   ```

   The script creates the HTS token, deploys the vote token, timelock and governor, wires the roles, funds the callback float and treasury, and renounces the deployer's admin role. Settings (voting period, timelock delay, quorum, HBAR amounts) come from `.env`; see `.env.example`.

3. Point the frontend at your DAO:

   ```bash
   npm run foundry:export
   ```

## Verify

Hedera testnet and Base Sepolia are both supported by Sourcify:

```bash
npm run foundry:verify:testnet -- <address> contracts/hedera/DaoGovernor.sol:DaoGovernor
npm run foundry:verify:base-sepolia -- <address> contracts/remote/CrossChainExecutor.sol:CrossChainExecutor
```

Pass `--constructor-args` with the ABI-encoded constructor arguments; the values are the settings in `deployments/*.json` and the addresses the deploy scripts print.
