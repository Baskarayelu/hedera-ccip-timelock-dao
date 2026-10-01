import { getAddress } from "viem";
import type { Address } from "viem";

/**
 * Units on Hedera:
 * - inside the EVM (contract values, CCIP fees, `msg.value`) HBAR is tinybar, 8 decimals;
 * - over JSON-RPC (`eth_getBalance`, a transaction's `value`, `eth_gasPrice`) it is weibar, 18 decimals.
 * Every HBAR amount in this app is tinybar; convert at the RPC boundary only.
 */
export const TINYBAR_PER_HBAR = 100_000_000n;
export const WEIBAR_PER_TINYBAR = 10_000_000_000n;

export const weibarToTinybar = (weibar: bigint) => weibar / WEIBAR_PER_TINYBAR;
export const tinybarToWeibar = (tinybar: bigint) => tinybar * WEIBAR_PER_TINYBAR;

/** HGOV and vHGOV use 6 decimals (set by the faucet when it creates the token). */
export const GOV_DECIMALS = 6;
export const USDC_DECIMALS = 6;
export const ETH_DECIMALS = 18;
export const HBAR_DECIMALS = 8;

/** Parses a user-typed decimal ("1,000.5") into base units. Returns null when it is not a valid amount. */
export function parseAmount(input: string, decimals: number): bigint | null {
  const text = input.replace(/[,_\s]/g, "");
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(text)) return null;
  const [whole = "0", fraction = ""] = text.split(".");
  if (fraction.length > decimals) return null;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** Formats base units with thousands separators and a fixed number of fraction digits (rounded down). */
export function formatUnitsFixed(value: bigint, decimals: number, digits = 2): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const shown = digits > 0 ? ((abs % scale) * 10n ** BigInt(digits)) / scale : 0n;
  const wholeText = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fractionText = digits > 0 ? `.${shown.toString().padStart(digits, "0")}` : "";
  return `${negative ? "-" : ""}${wholeText}${fractionText}`;
}

export const formatHbar = (tinybar: bigint, digits = 2) => `${formatUnitsFixed(tinybar, HBAR_DECIMALS, digits)} HBAR`;
export const formatGov = (amount: bigint, digits = 2) => formatUnitsFixed(amount, GOV_DECIMALS, digits);
/** Vote weights read best without decimals unless they have them. */
export const formatVotes = (amount: bigint) =>
  formatUnitsFixed(amount, GOV_DECIMALS, amount % 10n ** BigInt(GOV_DECIMALS) === 0n ? 0 : 2);

/** Rounds a tinybar amount up to the next 0.01 HBAR. */
export const ceilToCentiHbar = (tinybar: bigint) => {
  const step = TINYBAR_PER_HBAR / 100n;
  return ((tinybar + step - 1n) / step) * step;
};

export function shortAddress(address: Address | string): string {
  let text = address;
  try {
    text = getAddress(address);
  } catch {
    // not a valid address; shorten it as-is
  }
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}

export const shortHash = (hash: string) => `${hash.slice(0, 8)}…${hash.slice(-4)}`;

/** Hedera entity id of a long-zero address (system-assigned contract, token or schedule address). */
export function entityIdOf(address: Address): string {
  return `0.0.${BigInt(address).toString()}`;
}

/** Long-zero EVM address of a Hedera entity id ("0.0.123"). */
export function addressOfEntity(id: string): Address {
  const num = BigInt(id.split(".").pop() ?? "0");
  return `0x${num.toString(16).padStart(40, "0")}` as Address;
}

/** Up to `maxDigits` fraction digits, trailing zeros dropped: 250 USDC, 0.004 ETH. */
export function formatAmount(value: bigint, decimals: number, maxDigits = 4): string {
  return formatUnitsFixed(value, decimals, maxDigits).replace(/\.?0+$/, "");
}
