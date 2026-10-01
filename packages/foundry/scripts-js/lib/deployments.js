import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const deploymentsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "deployments");

/**
 * Deployment records live in `packages/foundry/deployments/<chainId>.json` and are committed: they are
 * the template's proof of a working testnet deployment and the source for the frontend's addresses.
 */
export function readDeployment(chainId) {
  const path = join(deploymentsDir, `${chainId}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

export function writeDeployment(chainId, record) {
  mkdirSync(deploymentsDir, { recursive: true });
  const path = join(deploymentsDir, `${chainId}.json`);
  writeFileSync(path, `${JSON.stringify(record, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
  return path;
}
