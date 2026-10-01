import { NextResponse } from "next/server";

/** Liveness check for the e2e runner and the CI gate. */
export function GET() {
  return NextResponse.json({ ok: true });
}
