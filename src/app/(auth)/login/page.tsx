import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LoginTabs } from "@/components/auth/LoginTabs";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await resolveOrgContext()) redirect("/");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Sign in</CardTitle>
          <CardDescription>Use your phone number, or email and password.</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginTabs />
        </CardContent>
      </Card>
      <p className="text-center text-sm text-muted-foreground">
        New to AggreTrack?{" "}
        <Link href="/register" className="font-medium text-primary underline-offset-4 hover:underline">
          Create an account
        </Link>
      </p>
    </div>
  );
}
