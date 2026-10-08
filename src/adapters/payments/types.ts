export interface PaystackEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface CreatePlanInput {
  name: string;
  amountKobo: number;
  interval: "monthly" | "quarterly" | "annually";
}

export interface InitializeSubscriptionInput {
  email: string;
  planCode: string;
  amountKobo: number;
  metadata?: Record<string, unknown>;
}

export interface PaymentsAdapter {
  createPlan(input: CreatePlanInput): Promise<{ planCode: string }>;
  initializeSubscription(
    input: InitializeSubscriptionInput,
  ): Promise<{ checkoutUrl: string; reference: string }>;
  /** Returns the parsed event when the signature verifies, else null. Never throws on bad input. */
  verifyWebhook(rawBody: string, signature: string | null): PaystackEvent | null;
  cancelSubscription(input: { subscriptionCode: string; emailToken: string }): Promise<void>;
}
