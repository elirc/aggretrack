import "server-only";

/** Show the fixed mock OTP hint only outside production with the mock SMS driver. */
export function showMockOtpHint(): boolean {
  return process.env.APP_ENV !== "production" && (process.env.SMS_DRIVER ?? "mock") === "mock";
}
