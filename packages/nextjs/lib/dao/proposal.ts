import { daoGovernorAbi, daoTimelockAbi, remoteParametersAbi, requestParameters } from "./abis";
import { BASE_SELECTOR, GOV_SYMBOL } from "./config";
import type { BuiltProposal, ProposalRecord, RemoteCall } from "./types";
import {
  ETH_DECIMALS,
  GOV_DECIMALS,
  HBAR_DECIMALS,
  USDC_DECIMALS,
  formatAmount,
  formatHbar,
  formatUnitsFixed,
  parseAmount,
  shortAddress,
} from "./units";
import {
  type Address,
  type Hex,
  concatHex,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAbiItem,
  hexToString,
  isAddress,
  isHex,
  size,
  stringToHex,
  toFunctionSelector,
  trim,
} from "viem";

const SEND_CROSS_CHAIN = toFunctionSelector(getAbiItem({ abi: daoTimelockAbi, name: "sendCrossChain" }));
const isBundleCall = (target: Address, data: Hex, timelock: Address) =>
  target.toLowerCase() === timelock.toLowerCase() && data.slice(0, 10).toLowerCase() === SEND_CROSS_CHAIN;

/** Addresses the builder and decoder need; the live config or a fixture supplies them. */
export type DaoAddresses = {
  governor: Address;
  timelock: Address;
  voteToken: Address;
  faucet: Address;
  governanceToken: Address;
  remoteParameters: Address;
  usdc: Address;
  remoteAccount: Address;
};

// ---------------------------------------------------------------------------------------------
// Drafts (the New proposal form)
// ---------------------------------------------------------------------------------------------

export type DraftAction =
  | { id: string; kind: "hbar"; to: string; amount: string }
  | { id: string; kind: "hgov"; to: string; amount: string }
  | { id: string; kind: "hederaCall"; target: string; value: string; data: string }
  | { id: string; kind: "param"; key: string; value: string }
  | { id: string; kind: "baseToken"; token: "USDC" | "ETH"; amount: string; to: string }
  | { id: string; kind: "baseCall"; target: string; value: string; data: string };

export type DraftKind = DraftAction["kind"];

export const BASE_KINDS: ReadonlySet<DraftKind> = new Set(["param", "baseToken", "baseCall"]);
export const isBaseDraft = (action: DraftAction) => BASE_KINDS.has(action.kind);

export const DRAFT_LABELS: Record<DraftKind, string> = {
  hbar: "Send HBAR from the treasury",
  hgov: `Send ${GOV_SYMBOL} from the treasury`,
  hederaCall: "Call a Hedera contract",
  param: "Set a parameter",
  baseToken: "Send tokens from the DAO’s account",
  baseCall: "Call a Base contract",
};

export function emptyDraft(kind: DraftKind, id: string): DraftAction {
  switch (kind) {
    case "hbar":
    case "hgov":
      return { id, kind, to: "", amount: "" };
    case "hederaCall":
    case "baseCall":
      return { id, kind, target: "", value: "0", data: "0x" };
    case "param":
      return { id, kind, key: "", value: "" };
    case "baseToken":
      return { id, kind, token: "USDC", amount: "", to: "" };
  }
}

export type DraftErrors = Record<string, string>;

const addressError = (text: string) => (isAddress(text.trim()) ? undefined : "Enter a 0x address (40 hex digits).");
const amountError = (text: string, decimals: number, allowZero = false) => {
  const value = parseAmount(text, decimals);
  if (value === null) return `Enter a number with at most ${decimals} decimals.`;
  if (!allowZero && value === 0n) return "Enter an amount above zero.";
  return undefined;
};
const dataError = (text: string) =>
  isHex(text.trim()) && text.trim().length % 2 === 0 ? undefined : "Enter hex calldata (0x…).";

/** Field errors for one draft action, keyed by field name. Empty when the action is valid. */
export function validateDraft(action: DraftAction): DraftErrors {
  const errors: Record<string, string | undefined> = {};
  switch (action.kind) {
    case "hbar":
      errors.to = addressError(action.to);
      errors.amount = amountError(action.amount, HBAR_DECIMALS);
      break;
    case "hgov":
      errors.to = addressError(action.to);
      errors.amount = amountError(action.amount, GOV_DECIMALS);
      break;
    case "hederaCall":
      errors.target = addressError(action.target);
      errors.value = amountError(action.value, HBAR_DECIMALS, true);
      errors.data = dataError(action.data);
      break;
    case "baseCall":
      errors.target = addressError(action.target);
      errors.value = amountError(action.value, ETH_DECIMALS, true);
      errors.data = dataError(action.data);
      break;
    case "param":
      if (!action.key.trim()) errors.key = "Enter a key, e.g. protocol.feeBps.";
      else if (new TextEncoder().encode(action.key.trim()).length > 32) errors.key = "Keys are at most 32 bytes.";
      errors.value = /^\d+$/.test(action.value.trim()) ? undefined : "Enter a whole number.";
      break;
    case "baseToken":
      errors.to = addressError(action.to);
      errors.amount = amountError(action.amount, action.token === "USDC" ? USDC_DECIMALS : ETH_DECIMALS);
      break;
  }
  return Object.fromEntries(Object.entries(errors).filter(([, v]) => v)) as DraftErrors;
}

/** Parameter keys are stored as the key's UTF-8 bytes, right-padded to 32, so they read back as text. */
export const paramKey = (key: string) => stringToHex(key.trim(), { size: 32 });

/** Turns a valid draft into the call it makes: on Hedera from the timelock, on Base from the DAO's account. */
export function draftToCall(action: DraftAction, addresses: DaoAddresses): RemoteCall {
  const amount = (text: string, decimals: number) => parseAmount(text, decimals) ?? 0n;
  switch (action.kind) {
    case "hbar":
      return { target: action.to.trim() as Address, value: amount(action.amount, HBAR_DECIMALS), data: "0x" };
    case "hgov":
      return {
        target: addresses.governanceToken,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [action.to.trim() as Address, amount(action.amount, GOV_DECIMALS)],
        }),
      };
    case "hederaCall":
      return {
        target: action.target.trim() as Address,
        value: amount(action.value, HBAR_DECIMALS),
        data: action.data.trim() as Hex,
      };
    case "param":
      return {
        target: addresses.remoteParameters,
        value: 0n,
        data: encodeFunctionData({
          abi: remoteParametersAbi,
          functionName: "set",
          args: [paramKey(action.key), BigInt(action.value.trim())],
        }),
      };
    case "baseToken":
      return action.token === "ETH"
        ? { target: action.to.trim() as Address, value: amount(action.amount, ETH_DECIMALS), data: "0x" }
        : {
            target: addresses.usdc,
            value: 0n,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "transfer",
              args: [action.to.trim() as Address, amount(action.amount, USDC_DECIMALS)],
            }),
          };
    case "baseCall":
      return {
        target: action.target.trim() as Address,
        value: amount(action.value, ETH_DECIMALS),
        data: action.data.trim() as Hex,
      };
  }
}

export const describeProposal = (title: string, body: string) => `# ${title.trim()}\n\n${body.trim()}`.trim();

/**
 * Builds the proposal the governor receives. Hedera actions run first, in order, from the timelock.
 * All Base actions travel together as one final action: `timelock.sendCrossChain`, which quotes the CCIP
 * fee when it executes and refuses to pay more than `feeCap`.
 */
export function buildProposal(
  draft: { title: string; body: string; actions: DraftAction[]; feeCap: bigint; destGasLimit: bigint },
  addresses: DaoAddresses,
): BuiltProposal {
  const hedera = draft.actions.filter(a => !isBaseDraft(a)).map(a => draftToCall(a, addresses));
  const base = draft.actions.filter(isBaseDraft).map(a => draftToCall(a, addresses));
  const calls = [...hedera];
  if (base.length) {
    calls.push({
      target: addresses.timelock,
      value: 0n,
      data: encodeFunctionData({
        abi: daoTimelockAbi,
        functionName: "sendCrossChain",
        args: [BASE_SELECTOR, base, draft.destGasLimit, draft.feeCap],
      }),
    });
  }
  return {
    targets: calls.map(c => c.target),
    values: calls.map(c => c.value),
    calldatas: calls.map(c => c.data),
    description: describeProposal(draft.title, draft.body),
  };
}

// ---------------------------------------------------------------------------------------------
// CCIP message (must match DaoTimelock.sendCrossChain byte for byte, so the fee quote is exact)
// ---------------------------------------------------------------------------------------------

/** `bytes4(keccak256("CCIP GenericExtraArgsV2"))` */
const GENERIC_EXTRA_ARGS_V2_TAG = "0x181dcf10";

export const extraArgsV2 = (gasLimit: bigint) =>
  concatHex([
    GENERIC_EXTRA_ARGS_V2_TAG,
    encodeAbiParameters([{ type: "uint256" }, { type: "bool" }], [gasLimit, true]),
  ]);

export const encodeRequest = (calls: readonly RemoteCall[], validUntil: bigint) =>
  encodeAbiParameters(requestParameters, [{ version: 1, validUntil, calls: [...calls] }]);

export function ccipMessage(executor: Address, calls: readonly RemoteCall[], destGasLimit: bigint, validUntil: bigint) {
  return {
    receiver: encodeAbiParameters([{ type: "address" }], [executor]),
    data: encodeRequest(calls, validUntil),
    tokenAmounts: [],
    feeToken: "0x0000000000000000000000000000000000000000" as Address,
    extraArgs: extraArgsV2(destGasLimit),
  };
}

// ---------------------------------------------------------------------------------------------
// Decoding a proposal for display
// ---------------------------------------------------------------------------------------------

export type TextPart = { text: string; mono?: boolean };
export type ActionView = { chain: "hedera" | "base"; parts: TextPart[]; detail: string };
export type CrossChainBundle = { calls: RemoteCall[]; destGasLimit: bigint; feeCap: bigint; destChain: bigint };

/** Splits "# Title\n\nBody" into its parts; falls back to the first line. */
export function splitDescription(description: string): { title: string; body: string } {
  const [first = "", ...rest] = description.split("\n");
  const title = first.replace(/^#+\s*/, "").trim() || "Untitled proposal";
  return { title, body: rest.join("\n").trim() };
}

/** The Base batch inside a proposal, if it has one. */
export function crossChainBundle(proposal: Pick<ProposalRecord, "targets" | "calldatas">, timelock: Address) {
  for (let i = 0; i < proposal.targets.length; i++) {
    if (!isBundleCall(proposal.targets[i], proposal.calldatas[i], timelock)) continue;
    try {
      const decoded = decodeFunctionData({ abi: daoTimelockAbi, data: proposal.calldatas[i] });
      if (decoded.functionName !== "sendCrossChain") continue;
      const [destChain, calls, destGasLimit, feeCap] = decoded.args;
      return { destChain, calls: [...calls], destGasLimit, feeCap } satisfies CrossChainBundle;
    } catch {
      continue;
    }
  }
  return null;
}

/** Sum of HBAR the proposal's Hedera calls send from the treasury (tinybar). */
export const hederaValueTotal = (proposal: Pick<ProposalRecord, "values">) =>
  proposal.values.reduce((sum, v) => sum + v, 0n);

/** Reads a parameter key back as text when it is printable, else shows the hex. */
export function readParamKey(key: Hex): string {
  try {
    const text = hexToString(trim(key, { dir: "right" }));
    if (/^[\x20-\x7e]+$/.test(text)) return text;
  } catch {
    // fall through to hex
  }
  return key;
}

function genericCall(chain: "hedera" | "base", call: RemoteCall, symbol: string, decimals: number): ActionView {
  const value = call.value ? ` with ${formatUnitsFixed(call.value, decimals, 4)} ${symbol}` : "";
  return {
    chain,
    parts: [{ text: "Call " }, { text: shortAddress(call.target), mono: true }, { text: value }],
    detail: call.data === "0x" ? "No calldata" : `Calldata ${call.data.slice(0, 10)}… (${size(call.data)} bytes)`,
  };
}

function describeBaseCall(call: RemoteCall, addresses: DaoAddresses): ActionView {
  const from = `the DAO’s account ${shortAddress(addresses.remoteAccount)}`;
  if (call.target.toLowerCase() === addresses.remoteParameters.toLowerCase()) {
    try {
      const { args } = decodeFunctionData({ abi: remoteParametersAbi, data: call.data });
      const [key, value] = args as readonly [Hex, bigint];
      return {
        chain: "base",
        parts: [{ text: "Set " }, { text: readParamKey(key), mono: true }, { text: ` to ${value.toString()}` }],
        detail: `RemoteParameters.set, called by ${from}`,
      };
    } catch {
      // fall through
    }
  }
  if (call.target.toLowerCase() === addresses.usdc.toLowerCase()) {
    try {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data });
      if (decoded.functionName === "transfer") {
        const [to, amount] = decoded.args;
        return {
          chain: "base",
          parts: [
            { text: `Send ${formatAmount(amount, USDC_DECIMALS, 2)} USDC to ` },
            { text: shortAddress(to), mono: true },
          ],
          detail: `USDC.transfer from ${from}`,
        };
      }
    } catch {
      // fall through
    }
  }
  if (call.data === "0x" && call.value > 0n) {
    return {
      chain: "base",
      parts: [
        { text: `Send ${formatAmount(call.value, ETH_DECIMALS, 6)} ETH to ` },
        { text: shortAddress(call.target), mono: true },
      ],
      detail: `From ${from}`,
    };
  }
  return genericCall("base", call, "ETH", ETH_DECIMALS);
}

function describeHederaCall(call: RemoteCall, addresses: DaoAddresses): ActionView {
  if (call.data === "0x" && call.value > 0n) {
    return {
      chain: "hedera",
      parts: [{ text: `Send ${formatHbar(call.value)} to ` }, { text: shortAddress(call.target), mono: true }],
      detail: "From the treasury (the timelock)",
    };
  }
  if (call.target.toLowerCase() === addresses.governanceToken.toLowerCase()) {
    try {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data });
      if (decoded.functionName === "transfer") {
        const [to, amount] = decoded.args;
        return {
          chain: "hedera",
          parts: [
            { text: `Send ${formatAmount(amount, GOV_DECIMALS, 2)} ${GOV_SYMBOL} to ` },
            { text: shortAddress(to), mono: true },
          ],
          detail: "From the treasury (the timelock)",
        };
      }
    } catch {
      // fall through
    }
  }
  for (const [address, abi, name] of [
    [addresses.governor, daoGovernorAbi, "Governor"],
    [addresses.timelock, daoTimelockAbi, "Timelock"],
  ] as const) {
    if (call.target.toLowerCase() !== address.toLowerCase()) continue;
    try {
      const decoded = decodeFunctionData({ abi, data: call.data });
      const args = (decoded.args ?? []).map(a => (typeof a === "bigint" ? a.toString() : String(a)));
      return {
        chain: "hedera",
        parts: [{ text: `${name}: ` }, { text: `${decoded.functionName}(${args.join(", ")})`, mono: true }],
        detail: `Called by the timelock on the DAO’s own ${name.toLowerCase()}`,
      };
    } catch {
      // fall through
    }
  }
  return genericCall("hedera", call, "HBAR", HBAR_DECIMALS);
}

/** Human-readable actions, Hedera first, then the Base batch and how it is delivered. */
export function describeActions(
  proposal: Pick<ProposalRecord, "targets" | "values" | "calldatas">,
  addresses: DaoAddresses,
): { actions: ActionView[]; bundle: CrossChainBundle | null } {
  const bundle = crossChainBundle(proposal, addresses.timelock);
  const actions: ActionView[] = [];
  proposal.targets.forEach((target, i) => {
    const call = { target, value: proposal.values[i], data: proposal.calldatas[i] };
    if (bundle && isBundleCall(target, call.data, addresses.timelock)) {
      bundle.calls.forEach(c => actions.push(describeBaseCall(c, addresses)));
    } else actions.push(describeHederaCall(call, addresses));
  });
  return { actions, bundle };
}
