/**
 * notify-sweep — re-enqueues notifications that were claimed but never sent,
 * so a crashed worker or an exhausted retry chain is recovered, not lost.
 * Dead rows (dead_at set) are left alone.
 *
 * The enqueue passes a deterministic jobId, so a row swept while its job is
 * still pending is dropped by the queue. Should one slip through anyway, the
 * notify job decides from the row and sends at most once per lease.
 */
import { type Db, notifications } from "@pounce/db";
import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { NOTIFY_CHANNEL, type NotifyJobData } from "./notify.js";

export const SWEEP_EVERY_MS = 5 * 60_000;
export const SWEEP_BATCH = 50;

/**
 * An unsent row untouched for this long is stuck. A released lease
 * (claimed_at null) counts from created_at, which keeps a row out of the sweep
 * while its first retry chain (~75 s) is still running.
 */
export const STALE_INTERVAL = "10 minutes";

export interface SweepDeps {
  db: Db;
  log: Logger;
  enqueue: (jobs: NotifyJobData[]) => Promise<void>;
}

export function createSweepProcessor(deps: SweepDeps) {
  /** Returns how many notifications were re-enqueued. */
  return async function processSweep(): Promise<number> {
    const stale = await deps.db
      .select({ searchId: notifications.searchId, propertyId: notifications.propertyId })
      .from(notifications)
      .where(
        and(
          eq(notifications.channel, NOTIFY_CHANNEL),
          isNull(notifications.sentAt),
          isNull(notifications.deadAt),
          lt(
            sql`coalesce(${notifications.claimedAt}, ${notifications.createdAt})`,
            sql`now() - ${STALE_INTERVAL}::interval`,
          ),
        ),
      )
      .orderBy(asc(notifications.createdAt))
      .limit(SWEEP_BATCH);

    if (stale.length > 0) await deps.enqueue(stale);

    const line = { queue: "notify-sweep", recovered: stale.length, batch: SWEEP_BATCH };
    if (stale.length > 0) deps.log.info(line, "sweep: re-enqueued stale notifications");
    else deps.log.debug(line, "sweep: nothing stale");
    return stale.length;
  };
}
