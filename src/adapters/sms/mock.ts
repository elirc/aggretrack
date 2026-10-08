import type { SmsAdapter } from "./types";

export function createMockSms(): SmsAdapter {
  return {
    async send(to, body) {
      const id = `mock-${crypto.randomUUID()}`;
      console.log(`[SMS:mock] to=${to} body=${body}`);
      return { id };
    },
  };
}
