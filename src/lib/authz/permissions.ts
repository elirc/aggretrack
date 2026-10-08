/**
 * The single authority for business permissions (DECISIONS #10).
 * Better Auth's organization plugin stores the role string on member.role;
 * this matrix decides what each role may do. Checked by the orgAction guard.
 */

export type Role =
  | "owner"
  | "manager"
  | "procurement"
  | "warehouse"
  | "sales"
  | "accountant";

export const ALL_PERMISSIONS = [
  "supplier.read",
  "supplier.write",
  "purchase.read",
  "purchase.create",
  "purchase.approve",
  "purchase.receive",
  "advance.read",
  "advance.write",
  "supplier-payment.read",
  "supplier-payment.write",
  "price-guide.read",
  "price-guide.write",
  "stock.read",
  "transfer.read",
  "transfer.write",
  "transfer.receive",
  "count.read",
  "count.write",
  "count.post",
  "adjustment.read",
  "adjustment.write",
  "adjustment.approve",
  "sale.read",
  "sale.write",
  "sale.allocate",
  "dispatch.read",
  "dispatch.write",
  "dispatch.deliver",
  "invoice.read",
  "invoice.write",
  "customer.read",
  "customer.write",
  "customer-payment.read",
  "customer-payment.write",
  "trip.read",
  "trip.write",
  "expense.read",
  "expense.write",
  "report.read",
  "report.export",
  "dashboard.read",
  "master-data.read",
  "master-data.write",
  "users.read",
  "users.manage",
  "org.settings",
  "billing.manage",
  "audit.read",
  "import.write",
  "notification.read",
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

const ALL_READS = ALL_PERMISSIONS.filter(
  (p) => p.endsWith(".read") || p === "report.export",
);

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[] | "*"> = {
  owner: "*",

  // Manager: all operations, approvals, reports — everything except billing.
  manager: ALL_PERMISSIONS.filter((p) => p !== "billing.manage"),

  // Procurement officer: suppliers, purchases, advances; reads price guides
  // and master data needed on the purchase form.
  procurement: [
    "supplier.read",
    "supplier.write",
    "purchase.read",
    "purchase.create",
    "purchase.receive",
    "advance.read",
    "advance.write",
    "supplier-payment.read",
    "price-guide.read",
    "master-data.read",
    "stock.read",
    "dashboard.read",
    "notification.read",
  ],

  // Warehouse keeper: receipts, transfers, counts, dispatch delivery for
  // assigned warehouses. No price-bearing permissions beyond stock.read
  // (price columns are stripped server-side when hidePrices is on).
  warehouse: [
    "purchase.read",
    "purchase.receive",
    "stock.read",
    "transfer.read",
    "transfer.write",
    "transfer.receive",
    "count.read",
    "count.write",
    "count.post",
    "adjustment.read",
    "adjustment.write",
    "dispatch.read",
    "dispatch.deliver",
    "master-data.read",
    "dashboard.read",
    "notification.read",
  ],

  // Sales officer: customers, sales orders, dispatches, invoices,
  // customer payments; needs stock availability to allocate.
  sales: [
    "customer.read",
    "customer.write",
    "sale.read",
    "sale.write",
    "sale.allocate",
    "dispatch.read",
    "dispatch.write",
    "invoice.read",
    "invoice.write",
    "customer-payment.read",
    "customer-payment.write",
    "stock.read",
    "master-data.read",
    "dashboard.read",
    "notification.read",
  ],

  // Accountant: reads everything, exports reports, records payments and
  // expenses on both sides.
  accountant: [
    ...ALL_READS,
    "supplier-payment.write",
    "customer-payment.write",
    "expense.write",
  ],
};

export function can(role: Role, permission: Permission): boolean {
  const granted = ROLE_PERMISSIONS[role];
  if (granted === "*") return true;
  return granted.includes(permission);
}

/** A permission that changes state (used for the read-only subscription gate). */
export function isMutating(permission: Permission): boolean {
  return !permission.endsWith(".read") && !permission.endsWith(".export");
}

export const ALL_ROLES: readonly Role[] = [
  "owner",
  "manager",
  "procurement",
  "warehouse",
  "sales",
  "accountant",
];
