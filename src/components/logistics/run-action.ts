import { toast } from "sonner";

import type { ActionResult } from "@/lib/authz/guard";

/** Client-side action helpers (toasts). Import from client components only. */

export function actionErrorMessage(code: string): string {
  switch (code) {
    case "NOT_FOUND":
      return "That record no longer exists. Refresh and try again.";
    case "IN_USE":
      return "It is still in use (for example, expenses attached) and can't be removed.";
    case "TRIP_DIRECTION":
      return "That link doesn't match the trip direction.";
    case "INVALID_STATE":
      return "That record is in a state that doesn't allow this (e.g. cancelled).";
    case "INVALID_INPUT":
    case "VALIDATION":
      return "Please check the highlighted fields.";
    case "FORBIDDEN":
      return "You don't have permission to do that.";
    case "READ_ONLY":
      return "Subscription inactive — your organisation is read only.";
    case "UNAUTHENTICATED":
      return "Your session has expired. Please sign in again.";
    default:
      return "Something went wrong. Please try again.";
  }
}

/** Call a guarded server action; toast success/failure; return data or null. */
export async function runAction<I, R>(
  action: (raw: I) => Promise<ActionResult<R>>,
  input: I,
  success?: string,
): Promise<R | null> {
  try {
    const res = await action(input);
    if (res.ok) {
      if (success) toast.success(success);
      return res.data;
    }
    toast.error(actionErrorMessage(res.error));
    return null;
  } catch {
    toast.error(actionErrorMessage("INTERNAL"));
    return null;
  }
}
