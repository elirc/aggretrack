import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/auth";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { RegisterFlow } from "@/components/auth/RegisterFlow";
import { showMockOtpHint } from "@/components/auth/mock-hint";

export const metadata: Metadata = { title: "Create account" };

export default async function RegisterPage() {
  // Already in an organisation → nothing to register.
  if (await resolveOrgContext()) redirect("/");

  const session = await auth.api.getSession({ headers: await headers() });
  const rawName = session?.user.name ?? "";
  // Phone sign-up stores the phone as a temporary name; don't prefill that.
  const defaultName = /^\+?\d+$/.test(rawName) ? "" : rawName;

  return (
    <RegisterFlow
      signedIn={Boolean(session)}
      defaultName={defaultName}
      showMockHint={showMockOtpHint()}
    />
  );
}
