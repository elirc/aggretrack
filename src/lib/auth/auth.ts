import { betterAuth } from "better-auth";
// Fallback if @better-auth/drizzle-adapter is absent: import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { phoneNumber, organization } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/db/client";
import * as schema from "@/db/schema";
import { getSmsAdapter } from "@/adapters/sms";

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,

  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { ...schema },
  }),

  emailAndPassword: {
    enabled: true,
  },

  user: {
    additionalFields: {
      isPlatformAdmin: {
        type: "boolean",
        defaultValue: false,
        input: false,
      },
    },
  },

  rateLimit: {
    // UNVERIFIED shape (INTEGRATIONS §1) — verify customRules path/keys against
    // installed better-auth types. storage "database" keeps limits multi-instance safe.
    enabled: true,
    window: 60,
    max: 10,
    storage: "database",
    customRules: {
      "/phone-number/send-otp": { window: 600, max: 3 },
    },
  },

  plugins: [
    phoneNumber({
      otpLength: 6,
      expiresIn: 300,
      allowedAttempts: 3,
      requireVerification: true,
      sendOTP: ({ phoneNumber: phone, code }) => {
        // Fire-and-forget per Better Auth docs — never await here.
        void getSmsAdapter()
          .send(phone, `Your AggreTrack verification code is ${code}`)
          .catch((err) =>
            console.error("[auth] failed to send OTP SMS to", phone, err),
          );
      },
      signUpOnVerification: {
        getTempEmail: (phone) =>
          `${phone.replace(/[^0-9]/g, "")}@phone.aggretrack.local`,
        getTempName: (phone) => phone,
      },
      // Spec: in mock mode the OTP is always 123456 and no external call is made.
      // The plugin has no generateOTP hook, so mock mode swaps in a custom
      // verifier that accepts only the fixed code. Real mode (undefined) uses
      // the plugin's internal OTP verification.
      verifyOTP:
        process.env.SMS_DRIVER === "mock"
          ? ({ code }) => code === "123456"
          : undefined,
    }),

    organization({
      // Roles are plain strings on member.role; business permissions live in
      // src/lib/authz/permissions.ts (DECISIONS #10). If invitations reject
      // custom role strings at runtime, orchestrator wires minimal ac/roles here.
      creatorRole: "owner",
    }),

    // Must be LAST so server actions can set cookies (INTEGRATIONS §1).
    nextCookies(),
  ],
});

export type AuthSession = typeof auth.$Infer.Session;
