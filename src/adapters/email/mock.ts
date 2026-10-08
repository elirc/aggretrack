import type { EmailAdapter } from "./types";

export function createMockEmail(): EmailAdapter {
  return {
    async send({ to, subject }) {
      const id = `mock-${crypto.randomUUID()}`;
      console.log(`[EMAIL:mock] to=${Array.isArray(to) ? to.join(",") : to} subject=${subject}`);
      return { id };
    },
  };
}
