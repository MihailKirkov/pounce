import { describe, expect, it } from "vitest";
import { backoffDelayMs, isBackoffStatus, parseRetryAfter } from "./backoff.js";

const policy = { initialSeconds: 60, factor: 2, maxSeconds: 900 };
const now = new Date("2026-09-13T12:00:00Z");

describe("isBackoffStatus", () => {
  it("is true for 429 and 5xx only", () => {
    expect([200, 304, 403, 404, 429, 500, 503, 599].map(isBackoffStatus)).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
    ]);
  });
});

describe("backoffDelayMs", () => {
  it("starts at initialSeconds and multiplies by factor per consecutive failure", () => {
    expect(backoffDelayMs(policy, 1)).toBe(60_000);
    expect(backoffDelayMs(policy, 2)).toBe(120_000);
    expect(backoffDelayMs(policy, 3)).toBe(240_000);
  });

  it("caps at maxSeconds", () => {
    expect(backoffDelayMs(policy, 5)).toBe(900_000);
    expect(backoffDelayMs(policy, 50)).toBe(900_000);
  });

  it("treats zero or negative failures as the first failure", () => {
    expect(backoffDelayMs(policy, 0)).toBe(60_000);
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter(" 0 ", now)).toBe(0);
  });

  it("parses an HTTP-date relative to now, clamping the past to zero", () => {
    expect(parseRetryAfter("Sun, 13 Sep 2026 12:05:00 GMT", now)).toBe(300_000);
    expect(parseRetryAfter("Sun, 13 Sep 2026 11:00:00 GMT", now)).toBe(0);
  });

  it("returns undefined when absent or unparseable", () => {
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
    expect(parseRetryAfter("", now)).toBeUndefined();
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter("-5", now)).toBeUndefined();
  });
});
