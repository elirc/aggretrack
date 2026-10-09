import { NextResponse } from "next/server";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { getDocumentFile } from "@/lib/services/documents";
import { isDomainError } from "@/lib/domain/errors";

// Streams a stored, organisation-scoped PDF (GRN, waybill, invoice, statement).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await resolveOrgContext();
  if (!ctx) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  const { id } = await params;
  try {
    const file = await getDocumentFile(ctx, id);
    return new NextResponse(new Uint8Array(file.buffer), {
      headers: {
        "Content-Type": file.mime,
        "Content-Disposition": `inline; filename="${file.filename.replace(/[^\w.\- ]/g, "_")}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (isDomainError(err) && err.code === "NOT_FOUND") {
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    console.error("[api/documents]", err);
    return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
  }
}
