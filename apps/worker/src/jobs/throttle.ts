import {
  type HttpClient,
  type PollingPolicy,
  backoffDelayMs,
  isBackoffStatus,
  parseRetryAfter,
} from "@pounce/core";
import type { SourceBackoff } from "../state.js";

export interface Throttle {
  status: number;
  retryAfterMs: number | undefined;
  receivedAt: number;
}

/**
 * Wraps ctx.http for the duration of list() and remembers the last 429/5xx.
 * Adapters decide what a bad status means for parsing (the fake one throws);
 * this lets the worker back off regardless of how the adapter reacted.
 */
export function watchForThrottling(
  inner: HttpClient,
  clock: () => number = Date.now,
): { http: HttpClient; throttle: () => Throttle | undefined } {
  let last: Throttle | undefined;
  return {
    http: {
      async get(url, options) {
        const res = await inner.get(url, options);
        if (isBackoffStatus(res.status)) {
          const receivedAt = clock();
          last = {
            status: res.status,
            retryAfterMs: parseRetryAfter(res.headers["retry-after"], new Date(receivedAt)),
            receivedAt,
          };
        }
        return res;
      },
    },
    throttle: () => last,
  };
}

/**
 * BullMQ's due times drift by a few ms when a scheduler is re-upserted. Without
 * slack, a 60s backoff on a 60s schedule could skip a tick that is due 5ms early.
 */
const TICK_SLACK_MS = 1000;

/** A misconfigured or hostile Retry-After must not park a source for days. */
export const MAX_RETRY_AFTER_MS = 3_600_000;

export interface NextBackoff {
  backoff: SourceBackoff;
  /** The source's Retry-After, in ms, when it exceeded MAX_RETRY_AFTER_MS and was clamped. */
  retryAfterClampedFromMs: number | undefined;
}

/**
 * The backoff after a throttled poll. The policy delay counts from the poll's
 * scheduled tick (less TICK_SLACK_MS), so a 60s backoff on a 60s schedule skips
 * nothing. Retry-After counts strictly from when the response arrived, wins when
 * longer than the policy delay (even past maxSeconds), and is clamped to
 * MAX_RETRY_AFTER_MS.
 */
export function nextBackoff(
  policy: PollingPolicy["backoff"],
  previous: SourceBackoff | undefined,
  throttle: Throttle,
  scheduledAt: number,
): NextBackoff {
  const failures = (previous?.failures ?? 0) + 1;
  const delayMs = backoffDelayMs(policy, failures);
  const clamped = throttle.retryAfterMs !== undefined && throttle.retryAfterMs > MAX_RETRY_AFTER_MS;
  const retryAfterMs = clamped ? MAX_RETRY_AFTER_MS : throttle.retryAfterMs;
  const until = Math.max(
    scheduledAt + delayMs - TICK_SLACK_MS,
    throttle.receivedAt + (retryAfterMs ?? 0),
  );
  let retryAfter = "";
  if (throttle.retryAfterMs !== undefined) {
    retryAfter = clamped
      ? `, Retry-After ${throttle.retryAfterMs / 1000}s clamped to ${MAX_RETRY_AFTER_MS / 1000}s`
      : `, Retry-After ${throttle.retryAfterMs / 1000}s`;
  }
  const reason =
    `HTTP ${throttle.status} from list(); next poll not before ${new Date(until).toISOString()}` +
    ` (failure ${failures}, backoff ${delayMs / 1000}s${retryAfter})`;
  return {
    backoff: { failures, until, reason },
    retryAfterClampedFromMs: clamped ? throttle.retryAfterMs : undefined,
  };
}
