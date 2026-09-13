/**
 * Backoff policy for a source that is pushing back (429) or failing (5xx).
 * Pure arithmetic; the worker owns the clock and where the state is stored.
 */
import type { PollingPolicy } from "../adapter.js";

/** Statuses that mean "poll this source less often". */
export function isBackoffStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Delay before the next poll after `consecutiveFailures` throttled polls in a row:
 * initialSeconds × factor^(n−1), capped at maxSeconds. A Retry-After longer than
 * that wins, even past maxSeconds — the source said so.
 */
export function backoffDelayMs(
  backoff: PollingPolicy["backoff"],
  consecutiveFailures: number,
  retryAfterMs?: number,
): number {
  const n = Math.max(1, consecutiveFailures);
  const computed = Math.min(backoff.initialSeconds * backoff.factor ** (n - 1), backoff.maxSeconds);
  return Math.max(computed * 1000, retryAfterMs ?? 0);
}

/** Retry-After (RFC 9110 §10.2.3): delta-seconds or an HTTP-date. Returns ms from `now`. */
export function parseRetryAfter(value: string | undefined, now: Date): number | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  // Only HTTP-dates; Date.parse alone would also accept things like "-5".
  if (!/[a-z]/i.test(v)) return undefined;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now.getTime());
}
