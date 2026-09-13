import type { HttpClient, HttpResponse } from "@pounce/core";
import { describe, expect, it } from "vitest";
import { type Throttle, nextBackoff, watchForThrottling } from "./throttle.js";

const policy = { initialSeconds: 60, factor: 2, maxSeconds: 900 };
const tick = Date.parse("2026-09-13T12:00:00Z");

function respond(status: number, headers: Record<string, string> = {}): HttpClient {
  return {
    async get(url): Promise<HttpResponse> {
      return { status, url, headers, text: async () => "", json: async <T>() => ({}) as T };
    },
  };
}

describe("watchForThrottling", () => {
  it("records nothing for non-throttling statuses", async () => {
    for (const status of [200, 403, 404]) {
      const watched = watchForThrottling(respond(status));
      await watched.http.get("https://a.example/");
      expect(watched.throttle()).toBeUndefined();
    }
  });

  it("records 429 with Retry-After seconds, and passes the response through", async () => {
    const watched = watchForThrottling(respond(429, { "retry-after": "90" }), () => tick + 300);
    const res = await watched.http.get("https://a.example/");
    expect(res.status).toBe(429);
    expect(watched.throttle()).toEqual({
      status: 429,
      retryAfterMs: 90_000,
      receivedAt: tick + 300,
    });
  });

  it("records 5xx without Retry-After", async () => {
    const watched = watchForThrottling(respond(503), () => tick);
    await watched.http.get("https://a.example/");
    expect(watched.throttle()).toEqual({ status: 503, retryAfterMs: undefined, receivedAt: tick });
  });
});

describe("nextBackoff", () => {
  const t = (retryAfterMs?: number): Throttle => ({
    status: 429,
    retryAfterMs,
    receivedAt: tick + 300,
  });

  it("counts the policy delay from the scheduled tick, so the next 60s tick still runs", () => {
    const b = nextBackoff(policy, undefined, t(), tick).backoff;
    expect(b.failures).toBe(1);
    expect(tick + 60_000 < b.until).toBe(false);
    // ...even when BullMQ makes that tick due a few ms early
    expect(tick + 59_990 < b.until).toBe(false);
    // but the tick in between is skipped
    expect(tick + 30_000 < b.until).toBe(true);
  });

  it("escalates with consecutive failures", () => {
    const first = nextBackoff(policy, undefined, t(), tick).backoff;
    const second = nextBackoff(policy, first, t(), tick + 60_000).backoff;
    expect(second.failures).toBe(2);
    expect(tick + 120_000 < second.until).toBe(true);
    expect(tick + 180_000 < second.until).toBe(false);
  });

  it("honours a Retry-After from response time, even if it lands just past a tick", () => {
    const b = nextBackoff(policy, undefined, t(60_000), tick).backoff;
    expect(b.until).toBe(tick + 60_300);
    expect(tick + 60_000 < b.until).toBe(true);
  });

  it("ignores a Retry-After shorter than the policy delay", () => {
    const b = nextBackoff(policy, undefined, t(10_000), tick).backoff;
    expect(b.until).toBe(tick + 60_000 - 1000);
  });

  it("lets Retry-After exceed maxSeconds up to 3600s without clamping", () => {
    const next = nextBackoff(policy, undefined, t(3_600_000), tick);
    expect(next.backoff.until).toBe(tick + 300 + 3_600_000);
    expect(next.retryAfterClampedFromMs).toBeUndefined();
  });

  it("clamps Retry-After beyond 3600s and reports the original value", () => {
    const next = nextBackoff(policy, undefined, t(86_400_000), tick);
    expect(next.backoff.until).toBe(tick + 300 + 3_600_000);
    expect(next.retryAfterClampedFromMs).toBe(86_400_000);
    expect(next.backoff.reason).toBe(
      "HTTP 429 from list(); next poll not before 2026-09-13T13:00:00.300Z (failure 1, backoff 60s, Retry-After 86400s clamped to 3600s)",
    );
  });

  it("states the status and resume time in the reason", () => {
    expect(nextBackoff(policy, undefined, t(90_000), tick).backoff.reason).toBe(
      "HTTP 429 from list(); next poll not before 2026-09-13T12:01:30.300Z (failure 1, backoff 60s, Retry-After 90s)",
    );
  });
});
