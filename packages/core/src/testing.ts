/**
 * Fixture-backed test harness for adapters. No network, no database.
 *
 * Layout an adapter package expects:
 *   fixtures/
 *     <name>.html | <name>.json      recorded response bodies
 *     <name>.meta.json               { "url": "...", "status": 200 }   (optional; defaults 200)
 *
 * A fixture is matched to a request by exact URL. Record fixtures with:
 *   curl -A "pounce/0.1" -o fixtures/list.html "https://…"
 * and strip anything you would not want to republish (there is nothing to strip
 * from a list page in practice, but check).
 */
import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { AdapterContext, AdapterLogger, AdapterState, SourceAdapter } from "./adapter.js";
import type { HttpClient, HttpResponse } from "./http.js";

interface FixtureEntry {
  url: string;
  status: number;
  body: string;
  contentType: string;
}

export async function loadFixtures(dir: string): Promise<Map<string, FixtureEntry>> {
  const files = await readdir(dir);
  const bodies = files.filter((f) => !f.endsWith(".meta.json"));
  const out = new Map<string, FixtureEntry>();
  for (const file of bodies) {
    const name = basename(file, extname(file));
    const metaPath = join(dir, `${name}.meta.json`);
    let meta: { url?: string; status?: number } = {};
    try {
      meta = JSON.parse(await readFile(metaPath, "utf8"));
    } catch {
      /* no meta: URL defaults to fixture://name */
    }
    const url = meta.url ?? `fixture://${name}`;
    out.set(url, {
      url,
      status: meta.status ?? 200,
      body: await readFile(join(dir, file), "utf8"),
      contentType: extname(file) === ".json" ? "application/json" : "text/html",
    });
  }
  return out;
}

export class FixtureHttpClient implements HttpClient {
  public readonly requests: string[] = [];
  constructor(private readonly fixtures: Map<string, FixtureEntry>) {}

  async get(url: string): Promise<HttpResponse> {
    this.requests.push(url);
    const fx = this.fixtures.get(url);
    if (!fx) {
      throw new Error(
        `No fixture for ${url}. Known: ${[...this.fixtures.keys()].join(", ") || "(none)"}`,
      );
    }
    return {
      status: fx.status,
      url: fx.url,
      headers: { "content-type": fx.contentType },
      text: async () => fx.body,
      json: async <T>() => JSON.parse(fx.body) as T,
    };
  }
}

export class MemoryState implements AdapterState {
  private readonly m = new Map<string, string>();
  async get(key: string) {
    return this.m.get(key);
  }
  async set(key: string, value: string) {
    this.m.set(key, value);
  }
}

export const silentLogger: AdapterLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export interface TestContextOptions {
  fixturesDir: string;
  now?: Date;
  logger?: AdapterLogger;
}

/** Build an AdapterContext wired to recorded fixtures. */
export async function createTestContext(
  opts: TestContextOptions,
): Promise<AdapterContext & { http: FixtureHttpClient }> {
  const http = new FixtureHttpClient(await loadFixtures(opts.fixturesDir));
  const now = opts.now ?? new Date("2026-09-12T12:00:00Z");
  return { http, logger: opts.logger ?? silentLogger, now: () => now, state: new MemoryState() };
}

/**
 * Contract checks every adapter must pass, independent of its source.
 * Call from the adapter's own test file with the framework of your choice;
 * it throws on the first violation.
 */
export async function assertAdapterContract<Raw>(
  adapter: SourceAdapter<Raw>,
  ctx: AdapterContext,
  scope = { cities: [] as string[] },
): Promise<{ raws: Raw[]; canon: ReturnType<SourceAdapter<Raw>["toCanonical"]>[] }> {
  if (!/^[a-z][a-z0-9_-]*$/.test(adapter.id)) throw new Error(`bad adapter id "${adapter.id}"`);
  if (adapter.polling.intervalSeconds < adapter.polling.minIntervalSeconds)
    throw new Error("polling.intervalSeconds below minIntervalSeconds");

  const result = await adapter.list(scope, ctx);
  if (result.listings.length === 0) throw new Error("list() returned no listings from fixtures");

  const canon = result.listings.map((r) => adapter.toCanonical(r));
  const ids = new Set<string>();
  for (const c of canon) {
    if (!c.sourceListingId) throw new Error("toCanonical(): sourceListingId missing");
    if (ids.has(c.sourceListingId))
      throw new Error(`duplicate sourceListingId ${c.sourceListingId}`);
    ids.add(c.sourceListingId);
    if (!/^https?:\/\//.test(c.url)) throw new Error(`toCanonical(): url not absolute: ${c.url}`);
    if (c.lat !== undefined && (c.lng === undefined || Math.abs(c.lat) > 90))
      throw new Error("toCanonical(): lat/lng malformed");
  }
  return { raws: result.listings, canon };
}
