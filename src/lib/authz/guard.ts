import "server-only";

import { z } from "zod";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/auth";
import { DomainError } from "@/lib/domain/errors";
import type { OrgContext } from "./context";
import { can, isMutating, type Permission } from "./permissions";
import { resolveOrgContext } from "./resolve";

export type ActionResult<R> =
  | { ok: true; data: R }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

/**
 * Wrap every server action in this guard (ARCHITECTURE §Auth & authz).
 * Order: session → server-resolved org → permission → read-only gate →
 * zod parse → handler. DomainError codes surface as { ok:false, error:code }.
 */
export function orgAction<S extends z.ZodType, R>(opts: {
  permission: Permission;
  schema: S;
  handler: (input: z.output<S>, ctx: OrgContext) => Promise<R>;
}): (raw: z.input<S>) => Promise<ActionResult<R>> {
  return async (raw) => {
    try {
      const ctx = await resolveOrgContext();
      if (!ctx) return { ok: false, error: "UNAUTHENTICATED" };

      if (!can(ctx.role, opts.permission)) {
        return { ok: false, error: "FORBIDDEN" };
      }

      // billing.manage is exempt from the read-only gate: paying is the only
      // way OUT of read-only, and billing never touches business data.
      if (isMutating(opts.permission) && ctx.readOnly && opts.permission !== "billing.manage") {
        // Subscription inactive — organisation is read only, never deleted.
        return { ok: false, error: "READ_ONLY" };
      }

      const parsed = opts.schema.safeParse(raw);
      if (!parsed.success) {
        return {
          ok: false,
          error: "VALIDATION",
          fieldErrors: z.flattenError(parsed.error).fieldErrors as Record<
            string,
            string[]
          >,
        };
      }

      const data = await opts.handler(parsed.data, ctx);
      return { ok: true, data };
    } catch (err) {
      if (err instanceof DomainError) {
        return { ok: false, error: err.code };
      }
      console.error("[orgAction] unhandled error", err);
      return { ok: false, error: "INTERNAL" };
    }
  };
}

/**
 * Twin guard for platform-admin actions (no organisation scope).
 */
export function platformAction<S extends z.ZodType, R>(opts: {
  schema: S;
  handler: (input: z.output<S>, ctx: { userId: string }) => Promise<R>;
}): (raw: z.input<S>) => Promise<ActionResult<R>> {
  return async (raw) => {
    try {
      const session = await auth.api.getSession({ headers: await headers() });
      if (!session) return { ok: false, error: "UNAUTHENTICATED" };

      const isPlatformAdmin =
        (session.user as { isPlatformAdmin?: boolean }).isPlatformAdmin ===
        true;
      if (!isPlatformAdmin) return { ok: false, error: "FORBIDDEN" };

      const parsed = opts.schema.safeParse(raw);
      if (!parsed.success) {
        return {
          ok: false,
          error: "VALIDATION",
          fieldErrors: z.flattenError(parsed.error).fieldErrors as Record<
            string,
            string[]
          >,
        };
      }

      const data = await opts.handler(parsed.data, {
        userId: session.user.id,
      });
      return { ok: true, data };
    } catch (err) {
      if (err instanceof DomainError) {
        return { ok: false, error: err.code };
      }
      console.error("[platformAction] unhandled error", err);
      return { ok: false, error: "INTERNAL" };
    }
  };
}
