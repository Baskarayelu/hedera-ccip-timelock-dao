/**
 * Creates a fresh ECDSA deployer key in packages/foundry/.env and prints the address to fund.
 * Refuses to overwrite an existing key. Testnet use only: the key is stored in plain text.
 *
 *   npm run foundry:account:generate
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";

if (/^DEPLOYER_PRIVATE_KEY=0x[0-9a-fA-F]{64}\s*$/m.test(current)) {
  const existing = current.match(/^DEPLOYER_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/m)[1];
  console.log(`A deployer key already exists for ${privateKeyToAccount(existing).address}; leaving it alone.`);
  process.exit(0);
}

const key = generatePrivateKey();
const line = `DEPLOYER_PRIVATE_KEY=${key}`;
const next = /^DEPLOYER_PRIVATE_KEY=.*$/m.test(current)
  ? current.replace(/^DEPLOYER_PRIVATE_KEY=.*$/m, line)
  : `${current.trimEnd()}\n${line}\n`;
writeFileSync(envPath, next, { mode: 0o600 });

const { address } = privateKeyToAccount(key);
console.log(`New deployer: ${address}`);
console.log("Fund it with testnet HBAR at https://portal.hedera.com/faucet (paste this address).");
