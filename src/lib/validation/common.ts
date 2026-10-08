import { z } from "zod";

/** Reusable zod pieces shared by forms, server actions and the sync endpoint. */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const zUuid = z.string().regex(UUID_RE, "Invalid id");

export const zId = zUuid;

/**
 * Nigerian phone number, normalised to international format without "+"
 * (e.g. "2348012345678"). Accepts 0801..., +234801..., 234801... with
 * spaces/dashes.
 */
export const zPhoneNg = z
  .string()
  .trim()
  .transform((raw, ctx) => {
    const cleaned = raw.replace(/[\s()-]/g, "");
    let digits = cleaned.startsWith("+") ? cleaned.slice(1) : cleaned;
    if (/^0\d{10}$/.test(digits)) digits = `234${digits.slice(1)}`;
    if (!/^234\d{10}$/.test(digits)) {
      ctx.addIssue({ code: "custom", message: "Enter a valid Nigerian phone number" });
      return z.NEVER;
    }
    return digits;
  });

/** Weight entered/stored as a kg decimal string, >= 0, max 3 decimals. */
export const zKgString = z
  .string()
  .trim()
  .regex(/^\d{1,9}(\.\d{1,3})?$/, "Enter a weight in kg (up to 3 decimals)");

/** Money as integer kobo, >= 0. */
export const zKobo = z.number().int("Amount must be integer kobo").min(0);

/** Calendar date "yyyy-mm-dd". */
export const zDateISO = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use yyyy-mm-dd")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "Not a real date");

export const zPage = z.coerce.number().int().min(1).default(1);
export const zPageSize = z.coerce.number().int().min(1).max(200).default(50);

/** Flatten a ZodError into { "path.to.field": ["msg", ...] } for ActionResult.fieldErrors. */
export function zodErrorToFieldErrors(err: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "_root";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}
