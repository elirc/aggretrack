import "server-only";

import { notFound, redirect } from "next/navigation";

import type { OrgContext } from "@/lib/authz/context";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { DomainError } from "@/lib/domain/errors";
import { zDateISO, zUuid } from "@/lib/validation/common";

/** Server-side helpers for the buying pages (reads call services directly). */

export async function requireOrgContext(): Promise<OrgContext> {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  return ctx;
}

/** Await a service read; a NOT_FOUND domain error renders the 404 page. */
export async function orNotFound<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof DomainError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
}

/** Route param that must be a uuid (else 404 — avoids a uuid cast error in SQL). */
export function uuidParamOr404(id: string): string {
  if (!zUuid.safeParse(id).success) notFound();
  return id;
}

export type RawSearchParams = Record<string, string | string[] | undefined>;

export function sp(params: RawSearchParams, key: string): string | undefined {
  const v = params[key];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() !== "" ? s.trim() : undefined;
}

export function spUuid(params: RawSearchParams, key: string): string | undefined {
  const v = sp(params, key);
  return v && zUuid.safeParse(v).success ? v : undefined;
}

export function spDate(params: RawSearchParams, key: string): string | undefined {
  const v = sp(params, key);
  return v && zDateISO.safeParse(v).success ? v : undefined;
}

export function spPage(params: RawSearchParams): number {
  const n = Number(sp(params, "page") ?? "1");
  return Number.isInteger(n) && n >= 1 ? n : 1;
}
