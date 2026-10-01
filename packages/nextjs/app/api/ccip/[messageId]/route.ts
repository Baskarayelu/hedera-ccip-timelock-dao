import { NextResponse } from "next/server";

/**
 * Proxies the Chainlink CCIP explorer's message lookup (it does not allow cross-origin reads) and keeps
 * only the fields the DAO pages use. Execution state follows CCIP's ExecutionState: 2 = success,
 * 3 = failure, anything else = not executed on the destination yet. The explorer answers an id it has
 * not indexed yet with 404 or 500, so both mean "no record yet".
 */
const CCIP_API = process.env.CCIP_EXPLORER_API_URL ?? "https://ccip.chain.link/api/h/atlas/message";
const MESSAGE_ID = /^0x[0-9a-fA-F]{64}$/;

export type CcipMessageStatus = {
  found: boolean;
  state: "pending" | "success" | "failed";
  sendTimestamp: string | null;
  sendFinalized: string | null;
  receiptTimestamp: string | null;
  receiptTransactionHash: string | null;
};

export async function GET(_req: Request, { params }: { params: Promise<{ messageId: string }> }) {
  const { messageId } = await params;
  if (!MESSAGE_ID.test(messageId)) {
    return NextResponse.json({ error: "Expected a 32-byte hex message id" }, { status: 400 });
  }
  try {
    const res = await fetch(`${CCIP_API}/${messageId}`, { cache: "no-store" });
    if (res.status === 404 || res.status === 500) {
      const notFound: CcipMessageStatus = {
        found: false,
        state: "pending",
        sendTimestamp: null,
        sendFinalized: null,
        receiptTimestamp: null,
        receiptTransactionHash: null,
      };
      return NextResponse.json(notFound);
    }
    if (!res.ok) return NextResponse.json({ error: `CCIP explorer returned ${res.status}` }, { status: 502 });
    const body = (await res.json()) as Record<string, unknown>;
    const str = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : null);
    const status: CcipMessageStatus = {
      found: true,
      state: body.state === 2 ? "success" : body.state === 3 ? "failed" : "pending",
      sendTimestamp: str("sendTimestamp"),
      sendFinalized: str("sendFinalized"),
      receiptTimestamp: str("receiptTimestamp"),
      receiptTransactionHash: str("receiptTransactionHash"),
    };
    return NextResponse.json(status);
  } catch (error) {
    console.error("[api/ccip]", error);
    return NextResponse.json({ error: "CCIP explorer unreachable" }, { status: 502 });
  }
}
