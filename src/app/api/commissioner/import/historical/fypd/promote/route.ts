import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCommissioner } from "@/lib/current-manager";
import { promoteFypdBatch } from "@/lib/import/fypd-promotion";

/**
 * Promotes one staged FypdImportBatch (created by the historical-import
 * commit route) into a real FypdDraft/FypdSelection. Separate from that
 * commit step on purpose: a commissioner reviews/confirms each batch's
 * season year first (see fypd-history.ts), so this never runs as an
 * automatic side effect of the workbook import itself.
 */
export async function POST(req: Request) {
  if (!(await requireCommissioner())) {
    return NextResponse.json({ error: "Commissioner access required" }, { status: 403 });
  }

  const { batchId } = (await req.json()) as { batchId?: string };
  if (!batchId) return NextResponse.json({ error: "batchId is required" }, { status: 400 });

  try {
    const result = await prisma.$transaction(async (tx) => promoteFypdBatch(tx, batchId), {
      timeout: 30_000,
      maxWait: 10_000,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Promotion failed." }, { status: 400 });
  }
}
