import { NextResponse } from "next/server";
import { getNoteBySlug } from "@/lib/vault";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  const { slug } = await params;
  const slugPath = (slug ?? []).join("/");
  if (!slugPath) {
    return NextResponse.json({ error: "missing slug" }, { status: 400 });
  }
  const note = await getNoteBySlug(slugPath);
  if (!note) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(note);
}
