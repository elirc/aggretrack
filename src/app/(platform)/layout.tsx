import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/auth";

export default async function PlatformLayout({ children }: { children: ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  const isPlatformAdmin =
    (session.user as { isPlatformAdmin?: boolean }).isPlatformAdmin === true;
  if (!isPlatformAdmin) redirect("/");

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="sticky top-0 z-40 border-b bg-background">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-4 px-4 text-sm">
          <span className="font-semibold">AggreTrack · Platform</span>
          <nav className="flex gap-3 text-muted-foreground">
            <Link href="/platform" className="hover:text-foreground">
              Health
            </Link>
            <Link href="/platform/organisations" className="hover:text-foreground">
              Organisations
            </Link>
            <Link href="/platform/plans" className="hover:text-foreground">
              Plans
            </Link>
            <Link href="/platform/audit" className="hover:text-foreground">
              Audit
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-4">{children}</main>
    </div>
  );
}
