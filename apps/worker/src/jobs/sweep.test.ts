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
    expect(recovered).toBe(enqueued.length);
  });
});
