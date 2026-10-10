// Frictionless demo access: when AUTO_LOGIN_EMAIL/PASSWORD are set (and the
// app is not in production), an unauthenticated visit is signed in as that
// user automatically via /api/demo-login — no login screen, no sign-up.
export function autoLoginEnabled(): boolean {
  return (
    process.env.APP_ENV !== "production" &&
    !!process.env.AUTO_LOGIN_EMAIL &&
    !!process.env.AUTO_LOGIN_PASSWORD
  );
}

export function autoLoginCredentials(): { email: string; password: string } {
  return {
    email: process.env.AUTO_LOGIN_EMAIL ?? "",
    password: process.env.AUTO_LOGIN_PASSWORD ?? "",
  };
}
