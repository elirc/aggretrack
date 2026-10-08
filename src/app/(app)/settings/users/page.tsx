import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { ALL_ROLES, can } from "@/lib/authz/permissions";
import { getOrgSettings, listAccessOptions, listMembers } from "@/lib/services/users";
import { PageHeader } from "@/components/layout/PageHeader";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { MembersView } from "./_components/MembersView";

export const metadata: Metadata = { title: "Users & roles" };

export default async function UsersPage() {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");

  if (!can(ctx.role, "users.read")) {
    return (
      <div>
        <PageHeader title="Users & roles" />
        <Alert>
          <AlertTitle>No access</AlertTitle>
          <AlertDescription>Ask an owner or manager to manage users.</AlertDescription>
        </Alert>
      </div>
    );
  }

  // Errors bubble to error.tsx.
  const [members, options, settings] = await Promise.all([
    listMembers(db, ctx),
    listAccessOptions(db, ctx),
    getOrgSettings(db, ctx),
  ]);

  const canManage = can(ctx.role, "users.manage") && !ctx.readOnly;

  return (
    <div>
      <PageHeader
        title="Users & roles"
        description="Who can sign in, what they can do and where."
      />
      {ctx.readOnly ? (
        <Alert className="mb-4">
          <AlertDescription>Subscription inactive — users are read only.</AlertDescription>
        </Alert>
      ) : null}
      <MembersView
        members={members}
        options={options}
        viewerRole={ctx.role}
        viewerUserId={ctx.userId}
        canManage={canManage}
        canEditOrgSettings={can(ctx.role, "org.settings") && !ctx.readOnly}
        hidePricesFromWarehouse={settings.hidePricesFromWarehouse}
        allRoles={[...ALL_ROLES]}
      />
    </div>
  );
}
