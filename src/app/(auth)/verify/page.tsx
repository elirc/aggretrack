import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { phoneLoginSchema } from "@/lib/validation/users";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { OtpForm } from "@/components/auth/OtpForm";
import { showMockOtpHint } from "@/components/auth/mock-hint";

export const metadata: Metadata = { title: "Verify code" };

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.phone) ? sp.phone[0] : sp.phone;
  const parsed = phoneLoginSchema.safeParse({ phone: raw ?? "" });
  if (!parsed.success) redirect("/login");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Enter your code</CardTitle>
          <CardDescription>We sent a 6-digit code by SMS.</CardDescription>
        </CardHeader>
        <CardContent>
          <OtpForm phone={parsed.data.phone} showMockHint={showMockOtpHint()} redirectTo="/" />
        </CardContent>
      </Card>
      <p className="text-center text-sm text-muted-foreground">
        Wrong number?{" "}
        <Link href="/login" className="font-medium text-primary underline-offset-4 hover:underline">
          Start again
        </Link>
      </p>
    </div>
  );
}
