/**
 * notify-sweep — recovers alerts that would otherwise be lost, in two ways:
 *
 * - stale notifications: claimed but never sent, so a crashed worker or an
 *   exhausted retry chain is retried. Dead rows (dead_at set) are left alone.
 * - orphan matches: a matches row with no notifications row at all, which is
 *   what ingest leaves behind if its enqueue fails after the commit.
 *
 * Both enqueue through notifyJob()'s deterministic jobId, so a pair swept while
 * its job is still pending is dropped by the queue. Should one slip through
 * anyway, the notify job decides from the row and sends at most once per lease.
 */
import { type Db, matches, notifications } from "@pounce/db";
import { and, asc, eq, isNull, lt, notExists, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { NOTIFY_CHANNEL, type NotifyJobData } from "./notify.js";

export const SWEEP_EVERY_MS = 5 * 60_000;
/** Per kind: up to this many stale notifications and this many orphan matches per run. */
export const SWEEP_BATCH = 50;

/**
 * How long before a pair counts as stuck. For a notification: untouched this
 * long, where a released lease (claimed_at null) counts from created_at, which
 * keeps a row out of the sweep while its first retry chain (~75 s) runs. For a
 * match: this long since matched_at without its notify job ever inserting a row.
 */
export const STALE_INTERVAL = "10 minutes";

export interface SweepDeps {
  db: Db;
  log: Logger;
  enqueue: (jobs: NotifyJobData[]) => Promise<void>;
}

export interface SweepResult {
  staleNotifications: number;
  orphanMatches: number;
}

const cutoff = sql`now() - ${STALE_INTERVAL}::interval`;

function findStaleNotifications(db: Db): Promise<NotifyJobData[]> {
  return db
    .select({ searchId: notifications.searchId, propertyId: notifications.propertyId })
    .from(notifications)
    .where(
      and(
        eq(notifications.channel, NOTIFY_CHANNEL),
        isNull(notifications.sentAt),
        isNull(notifications.deadAt),
        lt(sql`coalesce(${notifications.claimedAt}, ${notifications.createdAt})`, cutoff),
      ),
    )
    .orderBy(asc(notifications.createdAt))
    .limit(SWEEP_BATCH);
}

/** Disjoint from the stale set: those have a notifications row, these have none. */
function findOrphanMatches(db: Db): Promise<NotifyJobData[]> {
  return db
    .select({ searchId: matches.searchId, propertyId: matches.propertyId })
    .from(matches)
    .where(
      and(
        lt(matches.matchedAt, cutoff),
        notExists(
          db
            .select({ one: sql`1` })
            .from(notifications)
            .where(
              and(
                eq(notifications.searchId, matches.searchId),
                eq(notifications.propertyId, matches.propertyId),
                eq(notifications.channel, NOTIFY_CHANNEL),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(matches.matchedAt))
    .limit(SWEEP_BATCH);
}

export function createSweepProcessor(deps: SweepDeps) {
  return async function processSweep(): Promise<SweepResult> {
    const stale = await findStaleNotifications(deps.db);
    const orphans = await findOrphanMatches(deps.db);

    const jobs = [...stale, ...orphans];
    if (jobs.length > 0) await deps.enqueue(jobs);

    const result: SweepResult = { staleNotifications: stale.length, orphanMatches: orphans.length };
    const line = { queue: "notify-sweep", ...result, batch: SWEEP_BATCH };
    if (jobs.length > 0) deps.log.info(line, "sweep: re-enqueued lost alerts");
    else deps.log.debug(line, "sweep: nothing to recover");
    return result;
  };
}
