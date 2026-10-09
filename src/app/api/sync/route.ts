import { revalidatePath } from "next/cache";

import { db } from "@/db/client";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { enqueuePendingJobs } from "@/lib/services/suppliers";
import { loadRefData, processSyncBatch, syncRequestSchema } from "@/lib/services/sync";

/**
 * Offline sync endpoint (ARCHITECTURE §Offline / PWA).
 *
 * POST { ops: [{ clientId, kind, payload, orgId? }] } → { orgId, results: [...] }
 *   per op: applied | duplicate | error{code,message}. Replaying a batch is safe.
 * GET → org-scoped reference lists for the offline forms (Dexie refData cache).
 *
 * The org is always resolved from the session, never from the body.
 */

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function POST(req: Request) {
  const ctx = await resolveOrgContext();
  if (!ctx) return Response.json({ error: "UNAUTHENTICATED" }, { status: 401, headers: noStore });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400, headers: noStore });
  }
  const parsed = syncRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "VALIDATION", message: parsed.error.issues[0]?.message }, { status: 400, headers: noStore });
  }

  const res = await processSyncBatch(db, ctx, parsed.data.ops, { enqueueJobs: enqueuePendingJobs });

  if (res.results.some((r) => r.status === "applied")) {
    revalidatePath("/purchases");
    revalidatePath("/stock");
    revalidatePath("/dispatches");
    revalidatePath("/");
  }
  return Response.json(res, { headers: noStore });
}

export async function GET() {
  const ctx = await resolveOrgContext();
  if (!ctx) return Response.json({ error: "UNAUTHENTICATED" }, { status: 401, headers: noStore });
  return Response.json(await loadRefData(db, ctx), { headers: noStore });
}
