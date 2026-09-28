/**
 * Stable error vocabulary of protocol v1. Codes and exit codes are part of the
 * public contract: add new codes, never rename or renumber existing ones.
 */
export const EXIT_CODES = {
  USAGE: 2,
  UNKNOWN_COMMAND: 2,
  RUN_AMBIGUOUS: 2,
  RUN_NOT_FOUND: 3,
  REPORT_MISSING: 3,
  LOCK_HELD: 4,
  RUN_ACTIVE: 4,
  RUN_NOT_ACTIVE: 4,
  INVALID_CONFIG: 5,
  ASSIGNMENT_INVALID: 5,
  DISCOVERY_INVALID: 5,
  WORKER_UNAVAILABLE: 6,
  MODEL_UNAVAILABLE: 6,
  LAUNCH_FAILED: 6,
  STARTUP_UNCONFIRMED: 6,
  CONTROL_UNAVAILABLE: 6,
  HUB_UNAVAILABLE: 6,
  CALLBACK_FAILED: 6,
  WAIT_TIMEOUT: 7,
  IO_ERROR: 1,
  INTERNAL: 1,
} as const;

export type ErrorCode = keyof typeof EXIT_CODES;

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, hint?: string, details?: unknown) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
  get exitCode(): number { return EXIT_CODES[this.code]; }
}

/** Normalizes anything thrown into a CliError; plain errors from ported modules get the fallback code. */
export function toCliError(error: any, fallback: ErrorCode = 'INTERNAL', hint?: string): CliError {
  if (error instanceof CliError) return error;
  const message = String(error?.message ?? error ?? 'Unknown error.');
  if (fallback === 'INTERNAL' && typeof error?.code === 'string' && /^E[A-Z]+$/.test(error.code)) return new CliError('IO_ERROR', message, hint);
  return new CliError(fallback, message, hint);
}

/** Runs fn and re-labels plain errors with a specific code (for calls into ported modules). */
export function labelled<T>(code: ErrorCode, fn: () => T, hint?: string): T {
  try { return fn(); } catch (error) { throw toCliError(error, code, hint); }
}

export async function labelledAsync<T>(code: ErrorCode, fn: () => Promise<T>, hint?: string): Promise<T> {
  try { return await fn(); } catch (error) { throw toCliError(error, code, hint); }
}
