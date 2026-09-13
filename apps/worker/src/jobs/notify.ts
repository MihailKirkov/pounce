/**
 * notify — one Telegram alert per (saved search, property), ever (DECISIONS #003).
 *
 * The guarantee is the unique constraint on notifications(search_id,
 * property_id, channel): the row is inserted before sending, so there is
 * never a second row. Who may send against that row is decided by the row
 * alone: sent_at set means delivered; otherwise a job sends only while it
 * holds the claimed_at lease; dead_at set means it gave up for good. BullMQ
 * attempt counts play no part.
 */
import { formatTelegram } from "@pounce/core";
import { type Db, listings, notifications, properties, savedSearches } from "@pounce/db";
import { type Job, type JobsOptions, UnrecoverableError } from "bullmq";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { listingFromRow, searchFromRow } from "../rows.js";

export const NOTIFY_CHANNEL = "telegram";

/**
 * How long a claim protects a send in flight. Far above the 10 s Telegram
 * timeout; a worker that holds a lease longer than this can be overtaken and
 * the alert sent twice.
 */
export const LEASE_INTERVAL = "2 minutes";

/**
 * Failed sends, counted on the row across every job and sweep, before the row
 * goes dead. With 5 BullMQ attempts per job that is two retry chains.
 */
export const MAX_SEND_ATTEMPTS = 10;

/**
 * 5 attempts; retries after 5s, 10s, 20s, 40s.
 *
 * Finished jobs are removed because BullMQ drops an add whose jobId still
 * exists in *any* state, completed and failed included. Kept, a failed job
 * would block every later sweep of its pair. The notifications row is the record.
 */
export const notifyJobOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: true,
} satisfies JobsOptions;

export interface NotifyJobData {
  searchId: string;
  propertyId: string;
}

/** `:` is reserved in BullMQ custom ids, so the parts are joined with `-`. */
export function notifyJobId({ searchId, propertyId }: NotifyJobData): string {
  return `notify-${searchId}-${propertyId}`;
}

/**
 * A notify job for Queue.add/addBulk. The deterministic jobId means the queue
 * holds at most one pending job per pair; a duplicate add is dropped.
 */
export function notifyJob(data: NotifyJobData) {
  return { name: "notify", data, opts: { jobId: notifyJobId(data) } };
}

/** Sends one plain-text message. Throws on any failure. */
export type SendTelegram = (chatId: string, text: string) => Promise<void>;

export interface NotifyDeps {
  db: Db;
  log: Logger;
  sendTelegram: SendTelegram;
  /** Source id → display name for the message, e.g. "Pararius". */
  sourceName: (sourceId: string) => string;
  now?: () => Date;
}

type NotifyJob = Pick<Job<NotifyJobData>, "id" | "data">;

type Claim =
  | { kind: "owned"; id: string }
  | { kind: "sent" }
  | { kind: "dead" }
  | { kind: "leased" };

export function createNotifyProcessor(deps: NotifyDeps) {
  const now = deps.now ?? (() => new Date());

  return async function processNotify(job: NotifyJob): Promise<void> {
    const { searchId, propertyId } = job.data;
    const log = deps.log.child({ queue: "notify", jobId: job.id, searchId, propertyId });

    const claimed = await claim(deps.db, job.data);
    if (claimed.kind === "sent") {
      log.info("skip: already notified");
      return;
    }
    if (claimed.kind === "dead") {
      log.info("skip: dead");
      return;
    }
    if (claimed.kind === "leased") {
      log.info("skip: claimed by another worker");
      return;
    }

    try {
      const { chatId, text } = await buildMessage(deps, job.data, now());
      await deps.sendTelegram(chatId, text);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const failure = await recordFailure(deps.db, claimed.id, error);
      if (failure?.dead) {
        log.error({ attempts: failure.attempts, error }, "notify dead: giving up");
        throw new UnrecoverableError(
          `notification dead after ${failure.attempts} failed sends: ${error}`,
        );
      }
      log.warn({ attempts: failure?.attempts, error }, "notify failed");
      throw err;
    }

    // Outside the try: the message is out. If this update fails the row stays
    // unsent and is sent again later — the one duplicate the schema cannot prevent.
    await deps.db
      .update(notifications)
      .set({ sentAt: now() })
      .where(eq(notifications.id, claimed.id));
    log.info("notified");
  };
}

/**
 * One atomic UPDATE: count the failure, then either release the lease so the
 * BullMQ retry seconds later can take it, or — on the MAX_SEND_ATTEMPTS-th
 * failure — set dead_at and keep the lease. SET expressions read the row as it
 * was, so `attempts + 1` is the count including this failure.
 *
 * Returns undefined if the row is gone. If this update itself fails, the lease
 * expires and the failure goes uncounted.
 */
async function recordFailure(
  db: Db,
  id: string,
  error: string,
): Promise<{ attempts: number; dead: boolean } | undefined> {
  const reachesCap = sql`${notifications.attempts} + 1 >= ${MAX_SEND_ATTEMPTS}`;
  const [row] = await db
    .update(notifications)
    .set({
      error,
      attempts: sql`${notifications.attempts} + 1`,
      deadAt: sql`case when ${reachesCap} then now() end`,
      claimedAt: sql`case when ${reachesCap} then ${notifications.claimedAt} end`,
    })
    .where(eq(notifications.id, id))
    .returning({ attempts: notifications.attempts, deadAt: notifications.deadAt });
  return row && { attempts: row.attempts, dead: row.deadAt !== null };
}

/**
 * Decides from the row whether this job may send.
 *
 * a. Insert with the lease already taken. A row back means we own it. (Taking
 *    the lease in the INSERT, not a later UPDATE, leaves no moment where the
 *    row exists unclaimed for a concurrent job to grab.)
 * b. Otherwise read the existing row. sent_at set: already delivered. dead_at
 *    set: gave up for good.
 * c. Unsent and live: take the lease if it is released or expired. The
 *    conditional UPDATE is atomic, so at most one job wins it.
 *
 * All lease times are the database's now(), the one clock every worker shares.
 */
async function claim(db: Db, { searchId, propertyId }: NotifyJobData): Promise<Claim> {
  const [inserted] = await db
    .insert(notifications)
    .values({ searchId, propertyId, channel: NOTIFY_CHANNEL, claimedAt: sql`now()` })
    .onConflictDoNothing({
      target: [notifications.searchId, notifications.propertyId, notifications.channel],
    })
    .returning({ id: notifications.id });
  if (inserted) return { kind: "owned", id: inserted.id };

  const [existing] = await db
    .select({ id: notifications.id, sentAt: notifications.sentAt, deadAt: notifications.deadAt })
    .from(notifications)
    .where(
      and(
        eq(notifications.searchId, searchId),
        eq(notifications.propertyId, propertyId),
        eq(notifications.channel, NOTIFY_CHANNEL),
      ),
    );
  // Conflicted but gone: deleted in between. Throw so BullMQ retries the insert.
  if (!existing) throw new Error("notification row conflicted on insert but was not found");
  if (existing.sentAt !== null) return { kind: "sent" };
  if (existing.deadAt !== null) return { kind: "dead" };

  const [leased] = await db
    .update(notifications)
    .set({ claimedAt: sql`now()`, error: null })
    .where(
      and(
        eq(notifications.id, existing.id),
        isNull(notifications.sentAt),
        isNull(notifications.deadAt),
        or(
          isNull(notifications.claimedAt),
          lt(notifications.claimedAt, sql`now() - ${LEASE_INTERVAL}::interval`),
        ),
      ),
    )
    .returning({ id: notifications.id });
  return leased ? { kind: "owned", id: leased.id } : { kind: "leased" };
}

async function buildMessage(
  deps: NotifyDeps,
  { searchId, propertyId }: NotifyJobData,
  now: Date,
): Promise<{ chatId: string; text: string }> {
  const [search] = await deps.db.select().from(savedSearches).where(eq(savedSearches.id, searchId));
  if (!search) throw new Error(`saved search ${searchId} not found`);
  if (!search.telegramChatId) throw new Error(`saved search ${searchId} has no telegram_chat_id`);

  const [row] = await deps.db
    .select({ listing: listings })
    .from(properties)
    .innerJoin(listings, eq(listings.id, properties.representativeListingId))
    .where(eq(properties.id, propertyId));
  if (!row) throw new Error(`property ${propertyId} has no representative listing`);

  const listing = listingFromRow(row.listing);
  const text = formatTelegram(listing, searchFromRow(search), {
    now,
    sourceName: deps.sourceName(listing.sourceId),
    firstSeenAt: row.listing.firstSeenAt,
  });
  return { chatId: search.telegramChatId, text };
}
