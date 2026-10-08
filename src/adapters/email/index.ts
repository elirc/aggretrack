import type { EmailAdapter } from "./types";
import { createMockEmail } from "./mock";
import { createResendEmail } from "./resend";

export type { EmailAdapter, EmailInput } from "./types";

let cached: EmailAdapter | null = null;

export function getEmailAdapter(): EmailAdapter {
  if (!cached) {
    const driver = process.env.EMAIL_DRIVER ?? "mock";
    switch (driver) {
      case "resend":
        cached = createResendEmail();
        break;
      case "mock":
        cached = createMockEmail();
        break;
      default:
        throw new Error(`Unknown EMAIL_DRIVER: ${driver}`);
    }
  }
  return cached;
}
