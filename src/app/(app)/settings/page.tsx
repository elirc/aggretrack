import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { db } from "@/db/client";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { can } from "@/lib/authz/permissions";
import { getOrgSettings } from "@/lib/services/users";
import { PageHeader } from "@/components/layout/PageHeader";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { OrgSettingsForm } from "@/components/auth/OrgSettingsForm";

export const metadata: Metadata = { title: "Settings" };

const SUB_PAGES = [
  { href: "/settings/users", label: "Users & roles", permission: "users.read" },
  { href: "/settings/master-data", label: "Master data", permission: "master-data.read" },
  { href: "/settings/billing", label: "Billing", permission: "billing.manage" },
  { href: "/settings/import", label: "CSV import", permission: "import.write" },
  { href: "/settings/audit", label: "Audit log", permission: "audit.read" },
] as const;

export default async function SettingsPage() {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");

  const links = SUB_PAGES.filter((p) => can(ctx.role, p.permission));

  if (!can(ctx.role, "org.settings")) {
    return (
      <div>
        <PageHeader title="Settings" />
        <Alert>
          <AlertTitle>No access</AlertTitle>
          <AlertDescription>Only owners and managers can change organisation settings.</AlertDescription>
        </Alert>
        <SettingsLinks links={links} />
      </div>
    );
  }

  let settings;
  try {
    settings = await getOrgSettings(db, ctx);
  } catch {
    return (
      <div>
        <PageHeader title="Settings" />
        <Alert variant="destructive">
          <AlertTitle>Could not load settings</AlertTitle>
          <AlertDescription>Please refresh the page to try again.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Organisation profile, thresholds and privacy." />
      {ctx.readOnly ? (
        <Alert>
          <AlertDescription>Subscription inactive — settings are read only.</AlertDescription>
        </Alert>
      ) : null}
      <SettingsLinks links={links} />
      <OrgSettingsForm
        canEdit={!ctx.readOnly}
        defaults={{
          name: settings.name,
          adjustmentApprovalThresholdKg: settings.adjustmentApprovalThresholdKg,
          lowStockThresholdKg: settings.lowStockThresholdKg,
          oldStockDays: settings.oldStockDays,
          capacityAlertPercent: settings.capacityAlertPercent,
          invoiceTaxPercent: settings.invoiceTaxPercent,
          hidePricesFromWarehouse: settings.hidePricesFromWarehouse,
        }}
      />
    </div>
  );
}

function SettingsLinks({ links }: { links: readonly { href: string; label: string }[] }) {
  if (links.length === 0) return null;
  return (
    <nav className="mt-4 divide-y rounded-lg border" aria-label="Settings sections">
      {links.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className="flex min-h-12 items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/50"
        >
          {l.label}
          <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
        </Link>
      ))}
    </nav>
  );
}
