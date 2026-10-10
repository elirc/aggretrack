import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/auth";
import { autoLoginCredentials, autoLoginEnabled } from "@/lib/auth/auto-login";

// Signs the visitor in as the configured demo user and sends them to the
// dashboard. Only active when AUTO_LOGIN_* is configured outside production;
// otherwise it just falls through to the normal login page.
export async function GET(req: Request) {
  const home = new URL("/", req.url);
  const login = new URL("/login", req.url);

  if (!autoLoginEnabled()) {
    return NextResponse.redirect(login);
  }

  try {
    const { email, password } = autoLoginCredentials();
    const signIn = await auth.api.signInEmail({
      body: { email, password },
      asResponse: true,
    });
    if (!signIn.ok) {
      console.error("[demo-login] sign-in failed:", signIn.status);
      return NextResponse.redirect(login);
    }
    const res = NextResponse.redirect(home);
    // Forward every session cookie Better Auth set.
    for (const [key, value] of signIn.headers.entries()) {
      if (key.toLowerCase() === "set-cookie") {
        res.headers.append("set-cookie", value);
      }
    }
    return res;
  } catch (err) {
    console.error("[demo-login]", err);
    return NextResponse.redirect(login);
  }
}
