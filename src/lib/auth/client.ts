import { createAuthClient } from "better-auth/react";
import {
  phoneNumberClient,
  organizationClient,
} from "better-auth/client/plugins";

// No explicit baseURL: auth lives on the same origin as the app, so the
// client defaults to window.location.origin. Baking NEXT_PUBLIC_APP_URL in
// at build time would pin the bundle to one host.
export const authClient = createAuthClient({
  plugins: [phoneNumberClient(), organizationClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;
