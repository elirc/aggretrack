import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth/auth";
import { autoLoginEnabled } from "@/lib/auth/auto-login";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { db } from "@/db/client";
import { organization, user } from "@/db/schema";
import { AppShell } from "@/components/layout/AppShell";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await resolveOrgContext();
  if (!ctx) {
    // Signed in but without an organisation yet → finish registration.
    // No session at all → auto-login as the demo user when configured,
    // otherwise the login page.
    const session = await auth.api.getSession({ headers: await headers() });
    if (session) redirect("/register");
    redirect(autoLoginEnabled() ? "/api/demo-login" : "/login");
  }

  const [org] = await db
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, ctx.orgId))
    .limit(1);
  const [viewer] = await db
    .select({ name: user.name })
    .from(user)
    .where(eq(user.id, ctx.userId))
    .limit(1);

  return (
    <AppShell
      orgName={org?.name ?? "AggreTrack"}
      userName={viewer?.name ?? ""}
      role={ctx.role}
      readOnly={ctx.readOnly}
    >
      {children}
    </AppShell>
  );
}
