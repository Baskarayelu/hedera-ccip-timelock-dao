import {
  crossChainExecutorAbi,
  daoAccountAbi,
  daoGovernorAbi,
  daoTimelockAbi,
  govTokenFaucetAbi,
  remoteParametersAbi,
  voteTokenAbi,
} from "./abis";
import { ProposalState } from "./types";
import { USDC_DECIMALS, formatHbar, formatUnitsFixed, shortAddress } from "./units";
import { type Abi, type Hex, decodeErrorResult } from "viem";

const ALL_ERRORS = [
  ...daoGovernorAbi,
  ...daoTimelockAbi,
  ...voteTokenAbi,
  ...govTokenFaucetAbi,
  ...crossChainExecutorAbi,
  ...daoAccountAbi,
  ...remoteParametersAbi,
].filter(item => item.type === "error") as Abi;

export type DecodedRevert = { name: string; args: readonly unknown[]; text: string };

/** Hedera response codes our contracts surface (HederaResponseCodes.sol). */
const HEDERA_CODES: Record<number, string> = {
  22: "SUCCESS",
  184: "TOKEN_NOT_ASSOCIATED_TO_ACCOUNT",
  306: "SCHEDULE_EXPIRATION_TIME_TOO_FAR_IN_FUTURE",
  307: "SCHEDULE_EXPIRATION_TIME_MUST_BE_HIGHER_THAN_CONSENSUS_TIME",
  370: "SCHEDULE_EXPIRY_IS_BUSY",
  373: "SCHEDULE_FUTURE_THROTTLE_EXCEEDED",
};
export const hederaCodeName = (code: number) =>
  code === -1
    ? "no free second in the search window"
    : code === -2
      ? "schedule service unavailable"
      : (HEDERA_CODES[code] ?? `code ${code}`);

const STATE_NAMES = Object.fromEntries(
  Object.entries(ProposalState)
    .filter(([, v]) => typeof v === "number")
    .map(([k, v]) => [v, k]),
) as Record<number, string>;

function describe(name: string, args: readonly unknown[]): string {
  const big = (i: number) => args[i] as bigint;
  switch (name) {
    case "FeeAboveCap":
      return `the CCIP fee was ${formatHbar(big(0))}, above the ${formatHbar(big(1))} cap this proposal allows`;
    case "UnknownDestination":
      return "no executor is registered for the destination chain";
    case "FailedCall":
      return "a call ran out of HBAR or reverted without a reason";
    case "InsufficientBalance":
      return `the sender held ${formatHbar(big(0))} but needed ${formatHbar(big(1))}`;
    case "ERC20InsufficientBalance":
      return `${shortAddress(args[0] as string)} holds ${formatUnitsFixed(big(1), USDC_DECIMALS)} but the transfer needs ${formatUnitsFixed(big(2), USDC_DECIMALS)}`;
    case "GovernorUnexpectedProposalState":
      return `the proposal was ${STATE_NAMES[Number(args[1])] ?? "in another state"}`;
    case "TimelockUnexpectedOperationState":
      return "the timelock operation was not ready (its delay has not passed, or it already ran)";
    case "ClaimTooSoon":
      return "this account claimed within the cooldown";
    case "NotAssociated":
      return "the account is not associated with HGOV";
    case "HtsFailed":
      return `the token service returned ${hederaCodeName(Number(args[0]))}`;
    case "GovernorAlreadyCastVote":
      return "this account already voted";
    case "GovernorInsufficientProposerVotes":
      return "not enough votes to propose";
    case "AlreadyArmed":
      return "a callback for this step is already scheduled";
    case "NotRearmable":
      return `the proposal is ${STATE_NAMES[Number(args[2])] ?? "in another state"}, so this step no longer applies`;
    case "CallFailed": {
      const inner = decodeRevert(args[1] as Hex);
      return `call ${Number(big(0)) + 1} failed: ${inner.text}`;
    }
    case "Error":
      return String(args[0]);
    case "Panic":
      return `panic ${String(args[0])}`;
    default:
      return `${name}(${args.map(a => (typeof a === "bigint" ? a.toString() : String(a))).join(", ")})`;
  }
}

/** Turns revert bytes from any of the DAO's contracts (or a standard error) into a sentence. */
export function decodeRevert(data: Hex | undefined): DecodedRevert {
  if (!data || data === "0x") return { name: "", args: [], text: "it reverted without a reason" };
  try {
    const { errorName, args = [] } = decodeErrorResult({ abi: ALL_ERRORS, data });
    return { name: errorName, args, text: describe(errorName, args) };
  } catch {
    return { name: "", args: [], text: `unrecognised revert data ${data.slice(0, 10)}…` };
  }
}

/** The raw form shown next to the sentence, e.g. "FeeAboveCap(231000000, 200000000)". */
export function revertSignature(decoded: DecodedRevert): string {
  if (!decoded.name) return "";
  return `${decoded.name}(${decoded.args.map(a => (typeof a === "bigint" ? a.toString() : String(a))).join(", ")})`;
}

/** Best-effort message from a wallet or RPC error for a toast. */
export function errorMessage(error: unknown): string {
  const e = error as { shortMessage?: string; message?: string; cause?: { data?: Hex } };
  if (e?.cause?.data) return decodeRevert(e.cause.data).text;
  return e?.shortMessage ?? e?.message ?? String(error);
}
