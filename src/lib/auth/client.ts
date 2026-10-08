import { createAuthClient } from "better-auth/react";
import {
  phoneNumberClient,
  organizationClient,
} from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL,
  plugins: [phoneNumberClient(), organizationClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;
