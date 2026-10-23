import { NextResponse } from "next/server";
import { search } from "@/lib/vault";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const results = await search(q);
  return NextResponse.json({ query: q, results });
}
