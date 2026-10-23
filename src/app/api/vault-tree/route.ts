import { NextResponse } from "next/server";
import { getTree } from "@/lib/vault";

export const dynamic = "force-dynamic";

export async function GET() {
  const tree = await getTree();
  return NextResponse.json({ tree });
}
