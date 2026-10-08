/**
 * Domain error thrown by pure domain functions and services.
 * The orgAction guard maps these to { ok: false, error: code } results.
 */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
    public readonly meta?: unknown,
  ) {
    super(message ?? code);
    this.name = "DomainError";
  }
}

export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError;
}
