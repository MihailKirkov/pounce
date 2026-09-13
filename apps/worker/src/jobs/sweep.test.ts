import { pino } from "pino";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ago, createTestDb } from "../testing/db.js";
import type { NotifyJobData } from "./notify.js";
import { createSweepProcessor } from "./sweep.js";

const t = createTestDb();

beforeEach(() => t.assertReachable());
afterAll(() => t.close());

describe("notify sweeper", () => {
  it("re-enqueues stale unsent rows and ignores sent and freshly-claimed ones", async () => {
    const stale = await t.seed();
    await t.insertNotification(stale, { claimedAt: ago("11 minutes"), error: "worker crashed" });
    // Retry chain exhausted: the last failure released the lease.
    const exhausted = await t.seed();
    await t.insertNotification(exhausted, {
      claimedAt: null,
      createdAt: ago("30 minutes"),
      error: "telegram sendMessage: HTTP 502",
    });
    const sent = await t.seed();
    await t.insertNotification(sent, { claimedAt: ago("1 day"), sentAt: new Date() });
    const fresh = await t.seed();
    await t.insertNotification(fresh, { claimedAt: ago("1 minute") });
    // Released moments ago; its own BullMQ retry is still pending.
    const retrying = await t.seed();
    await t.insertNotification(retrying, {
      claimedAt: null,
      error: "telegram sendMessage: HTTP 502",
    });

    const enqueued: NotifyJobData[] = [];
    const sweep = createSweepProcessor({
      db: t.db,
      log: pino({ level: "silent" }),
      enqueue: async (jobs) => void enqueued.push(...jobs),
    });
    const recovered = await sweep();

    // The dev database may hold other stale rows; assert on ours only.
    expect(enqueued).toContainEqual(stale);
    expect(enqueued).toContainEqual(exhausted);
    expect(enqueued).not.toContainEqual(sent);
    expect(enqueued).not.toContainEqual(fresh);
    expect(enqueued).not.toContainEqual(retrying);
    expect(recovered.staleNotifications + recovered.orphanMatches).toBe(enqueued.length);
  });

  it("enqueues matches older than the window that never got a notification row", async () => {
    // Ingest committed the match, then the enqueue failed: nothing else will alert it.
    const orphan = await t.seed();
    await t.insertMatch(orphan, { matchedAt: ago("11 minutes") });
    // Its notify job is most likely still queued or running.
    const recent = await t.seed();
    await t.insertMatch(recent, { matchedAt: ago("1 minute") });
    // Notified already (sent here; an unsent row is the stale-notification path's job).
    const notified = await t.seed();
    await t.insertMatch(notified, { matchedAt: ago("30 minutes") });
    await t.insertNotification(notified, { claimedAt: ago("29 minutes"), sentAt: new Date() });

    const batches: NotifyJobData[][] = [];
    const lines: Record<string, unknown>[] = [];
    const sweep = createSweepProcessor({
      db: t.db,
      log: pino({ level: "info" }, { write: (s: string) => lines.push(JSON.parse(s)) }),
      enqueue: async (jobs) => void batches.push(jobs),
    });
    const recovered = await sweep();

    const enqueued = batches.flat();
    expect(enqueued).toContainEqual(orphan);
    expect(enqueued).not.toContainEqual(recent);
    expect(enqueued).not.toContainEqual(notified);
    expect(recovered.orphanMatches).toBeGreaterThanOrEqual(1);
    expect(recovered.staleNotifications + recovered.orphanMatches).toBe(enqueued.length);
    // Logged as two separate counts.
    expect(lines).toContainEqual(
      expect.objectContaining({
        staleNotifications: recovered.staleNotifications,
        orphanMatches: recovered.orphanMatches,
      }),
    );
  });
});
