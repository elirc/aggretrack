import { z } from "zod";
import { ALL_ROLES, type Role } from "@/lib/authz/permissions";
import { zKgString, zPhoneNg, zUuid } from "./common";

/** Zod schemas for auth screens, members/roles and organisation settings. */

export const zRole = z.enum(ALL_ROLES as unknown as [Role, ...Role[]], {
  message: "Pick a role",
});

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  manager: "Manager",
  procurement: "Procurement officer",
  warehouse: "Warehouse keeper",
  sales: "Sales officer",
  accountant: "Accountant",
};

/** "" → undefined so optional text inputs can be left blank. */
const optionalEmail = z
  .union([z.literal(""), z.email("Enter a valid email")])
  .optional()
  .transform((v) => (v ? v.trim().toLowerCase() : undefined));

const optionalPassword = z
  .union([z.literal(""), z.string().min(8, "At least 8 characters").max(128)])
  .optional()
  .transform((v) => (v ? v : undefined));

// --- Auth screens -----------------------------------------------------------

export const phoneLoginSchema = z.object({ phone: zPhoneNg });

export const otpSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter the 6-digit code"),
});

export const emailLoginSchema = z.object({
  email: z.email("Enter a valid email"),
  password: z.string().min(1, "Enter your password"),
});

export const registerOrgSchema = z.object({
  userName: z.string().trim().min(2, "Enter your name").max(80),
  orgName: z.string().trim().min(2, "Enter your business name").max(120),
});

/** Server action payload after the client created the org (nothing to send). */
export const initialiseOrgSchema = z.object({});

/** "Maize Traders Ltd" → "maize-traders-ltd". */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "org"
  );
}

// --- Members ----------------------------------------------------------------

export const addMemberSchema = z
  .object({
    name: z.string().trim().min(2, "Enter a name").max(80),
    phone: zPhoneNg,
    role: zRole,
    email: optionalEmail,
    password: optionalPassword,
  })
  .superRefine((v, ctx) => {
    if (v.password && !v.email) {
      ctx.addIssue({
        code: "custom",
        path: ["email"],
        message: "Email is required when setting a password",
      });
    }
  });
export type AddMemberInput = z.output<typeof addMemberSchema>;

export const changeRoleSchema = z.object({
  memberId: z.string().min(1),
  role: zRole,
});
export type ChangeRoleInput = z.output<typeof changeRoleSchema>;

export const removeMemberSchema = z.object({ memberId: z.string().min(1) });
export type RemoveMemberInput = z.output<typeof removeMemberSchema>;

/** Empty arrays = unrestricted (no access rows). */
export const memberRestrictionsSchema = z.object({
  memberId: z.string().min(1),
  warehouseIds: z.array(zUuid).max(500),
  buyingPointIds: z.array(zUuid).max(500),
});
export type MemberRestrictionsInput = z.output<typeof memberRestrictionsSchema>;

// --- Organisation settings ---------------------------------------------------

const zPercentString = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, "Enter a percentage (up to 2 decimals)")
  .refine((s) => Number(s) <= 100, "Must be 100 or less");

export const orgSettingsSchema = z.object({
  name: z.string().trim().min(2, "Enter the organisation name").max(120),
  adjustmentApprovalThresholdKg: zKgString,
  lowStockThresholdKg: zKgString,
  oldStockDays: z.coerce
    .number<string | number>()
    .int("Whole days only")
    .min(1, "At least 1 day")
    .max(3650),
  capacityAlertPercent: z.coerce
    .number<string | number>()
    .int("Whole percent only")
    .min(1)
    .max(100, "Must be 100 or less"),
  invoiceTaxPercent: zPercentString,
  hidePricesFromWarehouse: z.boolean(),
});
export const hidePricesSchema = z.object({ hide: z.boolean() });

export type OrgSettingsInput =z.output<typeof orgSettingsSchema>;
export type OrgSettingsFormValues = z.input<typeof orgSettingsSchema>;
