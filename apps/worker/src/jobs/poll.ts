/**
 * poll:<sourceId> — list() → bump last_seen_at for known listings → detail() and
 * ingestNewListing() (normalize, dedup, match, enqueue notify) for new ones →
 * one source_runs row.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AdapterContext,
  type AdapterLogger,
  type SearchScope,
  type SourceAdapter,
  createHttpClient,
  testing,
} from "@pounce/core";
import { type Db, listings, sourceRuns } from "@pounce/db";
import type { Job } from "bullmq";
import { and, eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { registry } from "../registry.js";
import { clearBackoff, createRedisAdapterState, readBackoff, writeBackoff } from "../state.js";
import { type ActiveSearch, ingestNewListing, loadActiveSearches } from "./ingest.js";
import type { NotifyJobData } from "./notify.js";
import { MAX_RETRY_AFTER_MS, nextBackoff, watchForThrottling } from "./throttle.js";

export interface PollJobData {
  sourceId: string;
}

export interface PollDeps {
  db: Db;
  redis: Redis;
  log: Logger;
  userAgent: string;
  /**
   * Sprint 1 only: serve ctx.http from the adapter package's fixtures instead of
   * the network (fake.example does not exist). Remove in sprint 2.
   */
  fixtureMode: boolean;
  /** Enqueues notify jobs built with notifyJob(), so jobIds match the sweeper's. */
  enqueueNotify: (jobs: NotifyJobData[]) => Promise<void>;
}

// Sprint 1: one hardcoded scope. Later, the union of active saved searches.
const SCOPE: SearchScope = { cities: ["Eindhoven"] };

export function createPollProcessor(deps: PollDeps) {
  // One context per source for the life of the process, so the request gap and
  // the robots.txt cache in the HttpClient carry over between polls.
  const contexts = new Map<string, Promise<AdapterContext>>();

  return async function processPoll(job: Job<PollJobData>): Promise<void> {
    const adapter = registry[job.data.sourceId];
    if (!adapter) throw new Error(`poll: unknown source "${job.data.sourceId}"`);

    let ctx = contexts.get(adapter.id);
    if (!ctx) {
      ctx = buildContext(adapter, deps);
      contexts.set(adapter.id, ctx);
    }
    // When the job was due: scheduler jobs are created one tick early with a
    // delay. Backoff compares against this, not the wall clock, so worker pickup
    // jitter cannot skip a poll that is exactly one interval later.
    const scheduledAt = job.timestamp + (job.opts.delay ?? 0);
    await pollSource(adapter, await ctx, deps, scheduledAt);
  };
}

async function buildContext(adapter: SourceAdapter, deps: PollDeps): Promise<AdapterContext> {
  const log = deps.log.child({ source: adapter.id });
  const http = deps.fixtureMode
    ? (await testing.createTestContext({ fixturesDir: fixturesDirFor(adapter.id) })).http
    : createHttpClient({
        userAgent: deps.userAgent,
        minGapMs: adapter.polling.minRequestGapMs,
      });
  return {
    http,
    logger: toAdapterLogger(log),
    now: () => new Date(),
    state: createRedisAdapterState(deps.redis, adapter.id),
  };
}

function fixturesDirFor(adapterId: string): string {
  const entry = fileURLToPath(import.meta.resolve(`@pounce/adapter-${adapterId}`));
  return join(dirname(entry), "..", "fixtures");
}

async function pollSource(
  adapter: SourceAdapter,
  ctx: AdapterContext,
  deps: PollDeps,
  scheduledAt: number,
): Promise<void> {
  const { db, redis } = deps;
  const log = deps.log.child({ source: adapter.id });

  const backoff = await readBackoff(redis, adapter.id);
  if (backoff && scheduledAt < backoff.until) {
    log.info(
      {
        event: "poll_skipped",
        until: new Date(backoff.until).toISOString(),
        failures: backoff.failures,
        reason: backoff.reason,
      },
      "poll skipped: backing off",
    );
    return;
  }

  const startedAt = new Date();
  const [run] = await db
    .insert(sourceRuns)
    .values({ sourceId: adapter.id, startedAt })
    .returning({ id: sourceRuns.id });
  if (!run) throw new Error("poll: source_runs insert returned no row");

  let seen = 0;
  let created = 0;
  const errors: string[] = [];

  try {
    const watched = watchForThrottling(ctx.http);
    let result: Awaited<ReturnType<SourceAdapter["list"]>> | undefined;
    try {
      result = await adapter.list(SCOPE, { ...ctx, http: watched.http });
    } catch (err) {
      errors.push(`list(): ${errorMessage(err)}`);
    }

    const throttle = watched.throttle();
    if (throttle) {
      const next = nextBackoff(adapter.polling.backoff, backoff, throttle, scheduledAt);
      if (next.retryAfterClampedFromMs !== undefined) {
        log.warn(
          {
            event: "retry_after_clamped",
            retryAfterSeconds: next.retryAfterClampedFromMs / 1000,
            clampedToSeconds: MAX_RETRY_AFTER_MS / 1000,
          },
          "Retry-After exceeds maximum; clamped",
        );
      }
      await writeBackoff(redis, adapter.id, next.backoff);
      // The reason names the original Retry-After when clamped; it lands in source_runs.error.
      errors.unshift(next.backoff.reason);
    } else if (result && backoff) {
      await clearBackoff(redis, adapter.id);
    }

    if (result) {
      seen = result.listings.length;
      // Once per poll: a search edited mid-poll applies from the next one.
      const searches = await loadActiveSearches(db);
      for (const raw of result.listings) {
        // One bad listing is recorded and skipped; it must not cost the others.
        try {
          if (await ingest(adapter, ctx, deps, searches, raw)) created++;
        } catch (err) {
          errors.push(`listing: ${errorMessage(err)}`);
        }
      }
    }
  } catch (err) {
    errors.push(errorMessage(err));
  }

  const finishedAt = new Date();
  const error = errors.length > 0 ? errors.join("; ") : null;
  await db
    .update(sourceRuns)
    .set({ finishedAt, listingsSeen: seen, listingsNew: created, error })
    .where(eq(sourceRuns.id, run.id));

  const line = {
    event: "poll",
    seen,
    new: created,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    ...(error === null ? {} : { error }),
  };
  if (error === null) log.info(line, "poll");
  else log.warn(line, "poll");
}

/** Returns true if the listing was new and ingested. */
async function ingest(
  adapter: SourceAdapter,
  ctx: AdapterContext,
  deps: PollDeps,
  searches: readonly ActiveSearch[],
  raw: unknown,
): Promise<boolean> {
  const { db } = deps;
  const log = deps.log.child({ source: adapter.id });
  const listed = adapter.toCanonical(raw);
  const now = ctx.now();

  const bumped = await db
    .update(listings)
    .set({ lastSeenAt: now })
    .where(
      and(eq(listings.sourceId, adapter.id), eq(listings.sourceListingId, listed.sourceListingId)),
    )
    .returning({ id: listings.id });
  if (bumped.length > 0) return false;

  let canon = listed;
  if (adapter.detail) {
    try {
      canon = adapter.toCanonical(await adapter.detail(raw, ctx));
    } catch (err) {
      // Missing detail data may fail matching later, never ingestion.
      log.warn(
        { sourceListingId: listed.sourceListingId, error: errorMessage(err) },
        "detail() failed; inserting list data only",
      );
    }
  }

  const ingested = await ingestNewListing(
    { db, log: deps.log, enqueueNotify: deps.enqueueNotify },
    adapter.id,
    canon,
    now,
    searches,
  );
  return ingested !== undefined;
}

function toAdapterLogger(log: Logger): AdapterLogger {
  return {
    debug: (msg, data) => log.debug(data ?? {}, msg),
    info: (msg, data) => log.info(data ?? {}, msg),
    warn: (msg, data) => log.warn(data ?? {}, msg),
    error: (msg, data) => log.error(data ?? {}, msg),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
