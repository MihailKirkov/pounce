/**
 * The real HttpClient handed to adapters as `ctx.http`. This is the one place in
 * the codebase allowed to call global fetch on an adapter's behalf.
 *
 * Per client instance it keeps, in memory:
 *  - the start time of the last request to each host, to enforce `minGapMs`
 *    (robots.txt fetches count too — they hit the same server);
 *  - parsed robots.txt per origin, for one hour.
 */
import {
  type HttpClient,
  type HttpRequestOptions,
  type HttpResponse,
  RobotsDisallowedError,
} from "../http.js";

export interface HttpClientOptions {
  userAgent: string;
  /** Minimum time between the start of two requests to the same host. */
  minGapMs: number;
  /** Default per-request timeout. Overridable per request. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const ROBOTS_TTL_MS = 60 * 60 * 1000;

export function createHttpClient(opts: HttpClientOptions): HttpClient {
  const defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const agentToken = productToken(opts.userAgent);
  const nextSlot = new Map<string, number>();
  const robotsCache = new Map<string, { expiresAt: number; rules: Promise<RobotsRules> }>();

  /** Reserve the next free slot for `host` and wait for it. Safe under concurrent calls. */
  async function waitForSlot(host: string): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, nextSlot.get(host) ?? now);
    nextSlot.set(host, slot + opts.minGapMs);
    if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
  }

  async function rawGet(url: URL, options: HttpRequestOptions = {}): Promise<Response> {
    await waitForSlot(url.host);
    const headers = new Headers(options.headers);
    headers.set("User-Agent", opts.userAgent);
    return fetch(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(options.timeoutMs ?? defaultTimeoutMs),
    });
  }

  async function loadRobots(origin: string): Promise<RobotsRules> {
    try {
      const res = await rawGet(new URL("/robots.txt", origin));
      // RFC 9309 §2.3.1.3: 4xx means no restrictions.
      if (res.status >= 400 && res.status < 500) return ALLOW_ALL;
      if (res.status >= 500) throw new Error(`robots.txt returned ${res.status}`);
      return parseRobots(await res.text(), agentToken);
    } catch (err) {
      // RFC 9309 §2.3.1.4: unreachable means disallow everything. Don't cache
      // that for an hour; the next request retries.
      robotsCache.delete(origin);
      throw err;
    }
  }

  async function isAllowed(url: URL): Promise<boolean> {
    const now = Date.now();
    let entry = robotsCache.get(url.origin);
    if (!entry || entry.expiresAt <= now) {
      entry = { expiresAt: now + ROBOTS_TTL_MS, rules: loadRobots(url.origin) };
      robotsCache.set(url.origin, entry);
    }
    let rules: RobotsRules;
    try {
      rules = await entry.rules;
    } catch {
      return false;
    }
    const path = url.pathname + url.search;
    return rules.every((group) => isAllowedByGroup(group, path));
  }

  return {
    async get(url, options) {
      const target = new URL(url);
      if (!(await isAllowed(target))) throw new RobotsDisallowedError(url);
      const res = await rawGet(target, options);
      return toHttpResponse(res, url);
    },
  };
}

function toHttpResponse(res: Response, requestedUrl: string): HttpResponse {
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  let body: Promise<string> | undefined;
  const text = () => {
    body ??= res.text();
    return body;
  };
  return {
    status: res.status,
    url: res.url || requestedUrl,
    headers,
    text,
    json: async <T>() => JSON.parse(await text()) as T,
  };
}

// ---------------------------------------------------------------------------
// robots.txt — User-agent / Allow / Disallow only. Everything else is ignored.

interface RobotsRule {
  allow: boolean;
  pattern: string;
  regex: RegExp;
}

/** Rules that apply to us: our own group(s) and the `*` group(s), checked independently. */
type RobotsRules = RobotsRule[][];

const ALLOW_ALL: RobotsRules = [];

/** "pounce/0.1 (+https://…)" → "pounce" */
function productToken(userAgent: string): string {
  return (userAgent.trim().split(/[\s/]/)[0] ?? "").toLowerCase();
}

function parseRobots(body: string, agentToken: string): RobotsRules {
  const ours: RobotsRule[] = [];
  const star: RobotsRule[] = [];
  let groupAgents: string[] = [];
  let inRules = false;

  for (const rawLine of body.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === "user-agent") {
      // A user-agent line after rules starts a new group.
      if (inRules) groupAgents = [];
      inRules = false;
      groupAgents.push(value.toLowerCase());
    } else if (key === "allow" || key === "disallow") {
      inRules = true;
      // An empty Disallow means "nothing disallowed"; an empty Allow means nothing.
      if (value === "") continue;
      const rule = { allow: key === "allow", pattern: value, regex: patternToRegex(value) };
      if (groupAgents.includes(agentToken)) ours.push(rule);
      if (groupAgents.includes("*")) star.push(rule);
    }
  }

  return [ours, star].filter((group) => group.length > 0);
}

/** Longest matching pattern wins; on a tie, Allow wins. No match means allowed. */
function isAllowedByGroup(group: RobotsRule[], path: string): boolean {
  let best: RobotsRule | undefined;
  for (const rule of group) {
    if (!rule.regex.test(path)) continue;
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow)
    ) {
      best = rule;
    }
  }
  return best?.allow ?? true;
}

/** Prefix match, with `*` as any sequence and a trailing `$` as end-of-path. */
function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`);
}
