import type { SmsAdapter } from "./types";
import { createMockSms } from "./mock";
import { createTermiiSms } from "./termii";

export type { SmsAdapter } from "./types";

let cached: SmsAdapter | null = null;

export function getSmsAdapter(): SmsAdapter {
  if (!cached) {
    const driver = process.env.SMS_DRIVER ?? "mock";
    switch (driver) {
      case "termii":
        cached = createTermiiSms();
        break;
      case "mock":
        cached = createMockSms();
        break;
      default:
        throw new Error(`Unknown SMS_DRIVER: ${driver}`);
    }
  }
  return cached;
}
