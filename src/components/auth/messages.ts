import type { FieldValues, Path, UseFormSetError } from "react-hook-form";

/** Human messages for ActionResult error codes used by auth/users/settings. */
const ACTION_MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: "Your session has expired. Please sign in again.",
  FORBIDDEN: "You don't have permission to do that.",
  READ_ONLY: "Subscription inactive — this organisation is read only.",
  VALIDATION: "Please check the highlighted fields.",
  INTERNAL: "Something went wrong. Please try again.",
  NOT_FOUND: "That record no longer exists.",
  OWNER_ONLY: "Only an owner can change owners.",
  LAST_OWNER: "An organisation needs at least one owner.",
  CANNOT_REMOVE_SELF: "You cannot remove yourself.",
  ALREADY_MEMBER: "That person is already a member.",
  CONFLICT: "That phone and email belong to different people.",
  USER_LIMIT_REACHED: "Your plan's user limit has been reached.",
  NO_PLAN: "No subscription plan is available.",
};

export function actionErrorMessage(code: string): string {
  return ACTION_MESSAGES[code] ?? code;
}

/** Push ActionResult.fieldErrors into a react-hook-form instance. */
export function applyFieldErrors<T extends FieldValues>(
  setError: UseFormSetError<T>,
  fieldErrors: Record<string, string[]> | undefined,
): void {
  if (!fieldErrors) return;
  for (const [key, msgs] of Object.entries(fieldErrors)) {
    if (msgs?.[0]) setError(key as Path<T>, { type: "server", message: msgs[0] });
  }
}

/** Better Auth client errors → readable text. */
export function authErrorMessage(
  err: { message?: string | null; code?: string | null; status?: number } | null | undefined,
): string {
  if (!err) return "Something went wrong. Please try again.";
  if (err.status === 429) return "Too many attempts. Please wait a few minutes and try again.";
  switch (err.code) {
    case "INVALID_OTP":
    case "OTP_NOT_FOUND":
      return "That code is not correct.";
    case "OTP_EXPIRED":
      return "That code has expired. Request a new one.";
    case "TOO_MANY_ATTEMPTS":
      return "Too many wrong codes. Request a new one.";
    case "INVALID_EMAIL_OR_PASSWORD":
      return "Email or password is incorrect.";
    default:
      return err.message || "Something went wrong. Please try again.";
  }
}
