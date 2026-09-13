import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RobotsDisallowedError } from "../http.js";
import { createHttpClient } from "./client.js";

const UA = "pounce/0.1 (+https://github.com/example/pounce)";

interface Call {
  url: string;
  at: number;
  userAgent: string | null;
}

/** Stub global fetch: serves `robots` for /robots.txt and "ok" (or `status`) for everything else. */
function stubFetch(robots: Record<string, { body: string; status?: number }>, status = 200) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, at: Date.now(), userAgent: new Headers(init?.headers).get("user-agent") });
    const { origin, pathname } = new URL(url);
    if (pathname === "/robots.txt") {
      const r = robots[origin] ?? { body: "", status: 404 };
      return new Response(r.body, { status: r.status ?? 200 });
    }
    return new Response("ok", { status });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-09-13T12:00:00Z") });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("createHttpClient", () => {
  it("respects minGapMs between requests to the same host", async () => {
    const { calls } = stubFetch({ "https://a.example": { body: "User-agent: *\nAllow: /" } });
    const client = createHttpClient({ userAgent: UA, minGapMs: 1000 });

    const done = Promise.all([
      client.get("https://a.example/one"),
      client.get("https://a.example/two"),
      client.get("https://a.example/three"),
    ]);
    await vi.runAllTimersAsync();
    await done;

    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/robots.txt",
      "/one",
      "/two",
      "/three",
    ]);
    for (let i = 1; i < calls.length; i++) {
      const prev = calls[i - 1];
      const cur = calls[i];
      if (!prev || !cur) throw new Error("unreachable");
      expect(cur.at - prev.at).toBeGreaterThanOrEqual(1000);
    }
  });

  it("does not throttle different hosts against each other", async () => {
    const { calls } = stubFetch({});
    const client = createHttpClient({ userAgent: UA, minGapMs: 1000 });

    const done = Promise.all([
      client.get("https://a.example/x"),
      client.get("https://b.example/x"),
    ]);
    await vi.runAllTimersAsync();
    await done;

    const pages = calls.filter((c) => !c.url.endsWith("/robots.txt"));
    expect(pages).toHaveLength(2);
    expect(pages[0]?.at).toBe(pages[1]?.at);
  });

  it("throws RobotsDisallowedError for a path disallowed for *, without requesting it", async () => {
    const { calls } = stubFetch({
      "https://a.example": { body: "User-agent: *\nDisallow: /private\n" },
    });
    const client = createHttpClient({ userAgent: UA, minGapMs: 0 });

    await expect(client.get("https://a.example/private/page")).rejects.toBeInstanceOf(
      RobotsDisallowedError,
    );
    expect(calls.map((c) => c.url)).toEqual(["https://a.example/robots.txt"]);
  });

  it("throws RobotsDisallowedError for a path disallowed for our user agent", async () => {
    stubFetch({
      "https://a.example": {
        body: [
          "# comments and unknown directives are ignored",
          "Sitemap: https://a.example/sitemap.xml",
          "User-agent: googlebot",
          "Disallow: /",
          "",
          "User-agent: Pounce",
          "Crawl-delay: 5",
          "Disallow: /huur/*?sort=  # no sorted indexes",
          "",
          "User-agent: *",
          "Allow: /",
        ].join("\n"),
      },
    });
    const client = createHttpClient({ userAgent: UA, minGapMs: 0 });

    await expect(client.get("https://a.example/huur/eindhoven?sort=price")).rejects.toBeInstanceOf(
      RobotsDisallowedError,
    );
    await expect(client.get("https://a.example/huur/eindhoven")).resolves.toMatchObject({
      status: 200,
    });
  });

  it("lets a longer Allow override a shorter Disallow", async () => {
    stubFetch({
      "https://a.example": { body: "User-agent: *\nDisallow: /huur\nAllow: /huur/eindhoven\n" },
    });
    const client = createHttpClient({ userAgent: UA, minGapMs: 0 });

    await expect(client.get("https://a.example/huur/eindhoven")).resolves.toMatchObject({
      status: 200,
    });
    await expect(client.get("https://a.example/huur/utrecht")).rejects.toBeInstanceOf(
      RobotsDisallowedError,
    );
  });

  it("proceeds on an allowed path, sets User-Agent on every request, returns the body", async () => {
    const { calls } = stubFetch({
      "https://a.example": { body: "User-agent: *\nDisallow: /private\n" },
    });
    const client = createHttpClient({ userAgent: UA, minGapMs: 0 });

    const res = await client.get("https://a.example/huur/eindhoven", {
      headers: { "User-Agent": "spoofed", Accept: "text/html" },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(await res.text()).toBe("ok");
    expect(calls.map((c) => c.url)).toEqual([
      "https://a.example/robots.txt",
      "https://a.example/huur/eindhoven",
    ]);
    expect(calls.every((c) => c.userAgent === UA)).toBe(true);
  });

  it("treats a missing robots.txt (404) as allow-all", async () => {
    stubFetch({});
    const client = createHttpClient({ userAgent: UA, minGapMs: 0 });

    await expect(client.get("https://a.example/anything")).resolves.toMatchObject({ status: 200 });
  });

  it("returns status >= 400 instead of throwing", async () => {
    stubFetch({}, 503);
    const client = createHttpClient({ userAgent: UA, minGapMs: 0 });

    const res = await client.get("https://a.example/gone");
    expect(res.status).toBe(503);
  });

  it("fetches robots.txt once per origin and refetches after an hour", async () => {
    const { calls } = stubFetch({ "https://a.example": { body: "User-agent: *\nAllow: /\n" } });
    const client = createHttpClient({ userAgent: UA, minGapMs: 0 });
    const robotsCalls = () => calls.filter((c) => c.url === "https://a.example/robots.txt").length;

    await Promise.all([client.get("https://a.example/1"), client.get("https://a.example/2")]);
    await client.get("https://a.example/3");
    expect(robotsCalls()).toBe(1);

    vi.setSystemTime(Date.now() + 59 * 60_000);
    await client.get("https://a.example/4");
    expect(robotsCalls()).toBe(1);

    vi.setSystemTime(Date.now() + 2 * 60_000);
    await client.get("https://a.example/5");
    expect(robotsCalls()).toBe(2);
  });
});
