/**
 * Generated-document storage: storage adapter (bytes) + `documents` row (metadata).
 *
 * Relative imports on purpose — this module is loaded by the worker under tsx.
 * No "server-only" import for the same reason (it would throw outside Next).
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { getStorageAdapter } from "../../adapters/storage";
import { db as defaultDb, type DbOrTx } from "../../db/client";
import { documents } from "../../db/schema";
import type { OrgContext } from "../authz/context";
import type { DocType } from "../domain/numbering";
import { DomainError } from "../domain/errors";

/**
 * Minimal context: a full OrgContext satisfies it; the worker passes
 * `{ orgId, userId: null }` (system-generated).
 */
export type DocumentCtx = Pick<OrgContext, "orgId"> & { userId?: string | null };

export interface StoreDocumentInput {
  type: DocType;
  /** Business number (e.g. GRN-2026-00001). null for unnumbered docs (statements). */
  number?: string | null;
  refType?: DocType | null;
  refId?: string | null;
  buffer: Buffer;
  mime?: string;
}

const PDF_MIME = "application/pdf";
const SAFE_SEGMENT = /[^A-Za-z0-9_.-]/g;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function segment(s: string): string {
  const cleaned = s.replace(SAFE_SEGMENT, "_");
  if (!cleaned || cleaned.startsWith(".")) throw new Error(`Invalid storage key segment: ${s}`);
  return cleaned;
}

/** org/{orgId}/{type}/{number-or-id}.pdf */
export function documentStorageKey(orgId: string, type: DocType, numberOrId: string): string {
  return `org/${segment(orgId)}/${segment(type)}/${segment(numberOrId)}.pdf`;
}

/**
 * Store bytes + record metadata. Numbered documents are idempotent per
 * (org, type, number): a re-render (job retry, regeneration) overwrites the
 * stored file and refreshes the existing row instead of inserting a duplicate.
 *
 * Note: storage writes are not transactional — if the caller's tx rolls back
 * after this returns, the file stays as an orphan (harmless; same key is
 * reused on retry for numbered docs).
 */
export async function storeDocument(
  dbOrTx: DbOrTx,
  ctx: DocumentCtx,
  input: StoreDocumentInput,
): Promise<{ id: string; storageKey: string }> {
  const mime = input.mime ?? PDF_MIME;
  const storage = getStorageAdapter();
  const number = input.number ?? null;

  if (number) {
    const [existing] = await dbOrTx
      .select({ id: documents.id, storageKey: documents.storageKey })
      .from(documents)
      .where(
        and(
          eq(documents.organisationId, ctx.orgId),
          eq(documents.type, input.type),
          eq(documents.number, number),
        ),
      )
      .limit(1);
    if (existing) {
      await storage.put(existing.storageKey, input.buffer, mime);
      await dbOrTx
        .update(documents)
        .set({ sizeBytes: input.buffer.length, mime, updatedAt: new Date() })
        .where(and(eq(documents.id, existing.id), eq(documents.organisationId, ctx.orgId)));
      return { id: existing.id, storageKey: existing.storageKey };
    }
  }

  const id = randomUUID();
  const storageKey = documentStorageKey(ctx.orgId, input.type, number ?? id);
  await storage.put(storageKey, input.buffer, mime);
  await dbOrTx.insert(documents).values({
    id,
    organisationId: ctx.orgId,
    type: input.type,
    number,
    refType: input.refType ?? null,
    refId: input.refId ?? null,
    storageKey,
    mime,
    sizeBytes: input.buffer.length,
    createdBy: ctx.userId ?? null,
  });
  return { id, storageKey };
}

/**
 * Load a stored document's bytes. Org-scoped: a foreign or unknown id throws
 * DomainError("NOT_FOUND") (no existence leak). Role/permission checks belong
 * to the caller (api/documents/[id] route via the guard).
 */
export async function getDocumentFile(
  ctx: DocumentCtx,
  id: string,
  dbOrTx: DbOrTx = defaultDb,
): Promise<{ buffer: Buffer; mime: string; filename: string }> {
  if (!UUID_RE.test(id)) throw new DomainError("NOT_FOUND", "Document not found");
  const [row] = await dbOrTx
    .select({
      id: documents.id,
      type: documents.type,
      number: documents.number,
      storageKey: documents.storageKey,
      mime: documents.mime,
    })
    .from(documents)
    .where(and(eq(documents.id, id), eq(documents.organisationId, ctx.orgId)))
    .limit(1);
  if (!row) throw new DomainError("NOT_FOUND", "Document not found");
  const buffer = await getStorageAdapter().get(row.storageKey);
  const ext = row.mime === PDF_MIME ? "pdf" : "bin";
  const filename = `${segment(row.number ?? `${row.type}-${row.id}`)}.${ext}`;
  return { buffer, mime: row.mime, filename };
}
