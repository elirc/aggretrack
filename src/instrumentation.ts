/**
 * Boot-time safety gate (spec: the app must refuse to start in production
 * with mock auth enabled). APP_ENV=demo intentionally allows mock drivers
 * so the Docker Compose demo can run with NODE_ENV=production.
 */
export async function register() {
  const appEnv = process.env.APP_ENV ?? "development";
  if (appEnv !== "production") return;

  const drivers: Record<string, string | undefined> = {
    SMS_DRIVER: process.env.SMS_DRIVER,
    EMAIL_DRIVER: process.env.EMAIL_DRIVER,
    PAYMENTS_DRIVER: process.env.PAYMENTS_DRIVER,
  };

  const offenders = Object.entries(drivers)
    .filter(([, value]) => !value || value === "mock")
    .map(([key, value]) => `${key}=${value ?? "(unset)"}`);

  if (offenders.length > 0) {
    throw new Error(
      `Refusing to start: APP_ENV=production with mock/unset adapter drivers (${offenders.join(
        ", ",
      )}). Set real drivers or use APP_ENV=demo.`,
    );
  }
}
