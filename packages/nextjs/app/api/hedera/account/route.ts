import { NextResponse } from "next/server";

const MIRROR_BASE: Record<string, string> = {
  testnet: process.env.HEDERA_MIRROR_TESTNET_URL ?? "https://testnet.mirrornode.hedera.com",
  mainnet: process.env.HEDERA_MIRROR_MAINNET_URL ?? "https://mainnet.mirrornode.hedera.com",
};

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const evm = searchParams.get("evm");
  const network = (searchParams.get("network") ?? "testnet").toLowerCase();

  if (!evm || !EVM_ADDRESS_RE.test(evm)) {
    return NextResponse.json({ error: "Missing or invalid EVM address" }, { status: 400 });
  }

  const base = MIRROR_BASE[network] ?? MIRROR_BASE.testnet;
  const url = `${base}/api/v1/accounts/${evm}`;

  try {
    // Not cached: the balance and whether the account exists change when someone funds it.
    const res = await fetch(url, { cache: "no-store" });

    if (!res.ok) {
      if (res.status === 404) {
        return NextResponse.json({ accountId: null });
      }
      return NextResponse.json({ error: "Mirror node request failed", status: res.status }, { status: 502 });
    }

    const data = (await res.json()) as {
      account?: string;
      balance?: { balance?: number };
      max_automatic_token_associations?: number;
    };
    const accountId = typeof data.account === "string" ? data.account : null;
    return NextResponse.json({
      accountId,
      balance: data.balance?.balance ?? 0,
      maxAutomaticTokenAssociations: data.max_automatic_token_associations ?? 0,
    });
  } catch (e) {
    console.error("[api/hedera/account]", e);
    return NextResponse.json({ error: "Resolution failed" }, { status: 502 });
  }
}
