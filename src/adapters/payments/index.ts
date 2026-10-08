import type { PaymentsAdapter } from "./types";
import { createMockPayments } from "./mock";
import { createPaystackPayments } from "./paystack";

export type {
  PaymentsAdapter,
  PaystackEvent,
  CreatePlanInput,
  InitializeSubscriptionInput,
} from "./types";

let cached: PaymentsAdapter | null = null;

export function getPaymentsAdapter(): PaymentsAdapter {
  if (!cached) {
    const driver = process.env.PAYMENTS_DRIVER ?? "mock";
    switch (driver) {
      case "paystack":
        cached = createPaystackPayments();
        break;
      case "mock":
        cached = createMockPayments();
        break;
      default:
        throw new Error(`Unknown PAYMENTS_DRIVER: ${driver}`);
    }
  }
  return cached;
}
