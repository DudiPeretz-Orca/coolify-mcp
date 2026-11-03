/**
 * Every value interpolated into a Coolify API URL path must pass through safeSegment.
 * fetch() normalises `..` and `%2e%2e` segments, so an unchecked id such as `../../<app>`
 * turns a call on one resource into a request for a different one, bypassing the scope gate.
 */
export const SAFE_SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class InvalidArgumentError extends Error {
  constructor(label: string) {
    super(`invalid_argument: ${label} must match ${SAFE_SEGMENT_RE.source}`);
    this.name = 'InvalidArgumentError';
  }
}

/** Returns the value unchanged (never trimmed or decoded) or throws InvalidArgumentError. */
export function safeSegment(value: unknown, label: string): string {
  // Numeric ids (GitHub app ids, PR numbers) are legitimate; stringify only safe integers.
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value !== 'string' || !SAFE_SEGMENT_RE.test(value)) {
    throw new InvalidArgumentError(label);
  }
  return value;
}
