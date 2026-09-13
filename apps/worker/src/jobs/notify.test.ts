import { randomUUID } from "node:crypto";
import { notifications } from "@pounce/db";
import { UnrecoverableError } from "bullmq";
import { eq } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ago, createTestDb } from "../testing/db.js";
import { type NotifyJobData, type SendTelegram, createNotifyProcessor } from "./notify.js";
import { createSweepProcessor } from "./sweep.js";

const t = createTestDb();
const now = new Date("2026-09-13T10:00:40Z");

function job(data: NotifyJobData) {
  return { id: randomUUID(), data };
}

function setup() {
  const lines: { msg: string; level: number; [field: string]: unknown }[] = [];
  const log = pino({ level: "info" }, { write: (s: string) => lines.push(JSON.parse(s)) });
  const sendTelegram = vi.fn<SendTelegram>(async () => {});
  const run = createNotifyProcessor({
    db: t.db,
    log,
    sendTelegram,
    sourceName: () => "Fake source",
    now: () => now,
  });
  const logged = (msg: string) => lines.filter((l) => l.msg === msg).length;
  return { run, sendTelegram, logged, lines };
}

beforeEach(() => t.assertReachable());
afterAll(() => t.close());

describe("notify job", () => {
  it("adds the straight-line distance to work only when both sides have coordinates", async () => {
    const work = { workLat: 51.4105, workLng: 5.4577 }; // High Tech Campus
    const withCoords = await t.seed({ search: work, listing: { lat: 51.446, lng: 5.478 } });
    const noCoords = await t.seed({ search: work });
    const { run, sendTelegram } = setup();

    await run(job(withCoords));
    await run(job(noCoords));

    const [first, second] = sendTelegram.mock.calls.map(([, text]) => text.split("\n")[1]);
    expect(first).toBe("5612 CJ · 4.2 km to work");
    expect(second).toBe("5612 CJ");
  });

  it("sends the formatted message to the search's chat and sets claimed_at and sent_at", async () => {
    const data = await t.seed();
    const { run, sendTelegram } = setup();

    await run(job(data));

    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram).toHaveBeenCalledWith(
      "4242",
      [
        "Kruisstraat 112, Eindhoven",
        "5612 CJ",
        "",
        "€1,185 total  (€1,050 + €135 service)",
        "58 m² · 3 rooms · upholstered",
        "Registration ✓   Income: not stated",
        "",
        "Fake source · published 40 s ago",
        "https://fake.example/listing/1001",
      ].join("\n"),
    );
    const rows = await t.rowsFor(data);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.channel).toBe("telegram");
    expect(rows[0]?.claimedAt).not.toBeNull();
    expect(rows[0]?.sentAt).toEqual(now);
    expect(rows[0]?.error).toBeNull();
  });

  it("two concurrent jobs for the same (search, property) produce exactly one send", async () => {
    const data = await t.seed();
    const { run, sendTelegram } = setup();
    // Hold the first send open so the second job runs while it is in flight.
    let release = () => {};
    sendTelegram.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    let finished = 0;
    const both = Promise.all(
      [run(job(data)), run(job(data))].map((p) => p.then(() => void finished++)),
    );
    // Whichever job lost the insert finishes while the winner is still sending.
    await vi.waitFor(() => expect(finished).toBe(1));
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    release();
    await both;

    expect(sendTelegram).toHaveBeenCalledTimes(1);
    const rows = await t.rowsFor(data);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sentAt).not.toBeNull();
  });

  it("a send that fails releases the lease, so the retry sends: one row, one delivered message", async () => {
    const data = await t.seed();
    const { run, sendTelegram } = setup();
    sendTelegram.mockRejectedValueOnce(new Error("telegram sendMessage: HTTP 502"));
    const sameJob = job(data);

    await expect(run(sameJob)).rejects.toThrow("HTTP 502");
    let rows = await t.rowsFor(data);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sentAt).toBeNull();
    expect(rows[0]?.claimedAt).toBeNull();
    expect(rows[0]?.error).toBe("telegram sendMessage: HTTP 502");
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.deadAt).toBeNull();

    // BullMQ retries the same job seconds later, well inside the lease window.
    await run(sameJob);
    rows = await t.rowsFor(data);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sentAt).toEqual(now);
    expect(rows[0]?.error).toBeNull();
    expect(sendTelegram.mock.settledResults.map((r) => r.type)).toEqual(["rejected", "fulfilled"]);
  });

  it("picks up an unsent row whose lease expired (the worker that claimed it crashed)", async () => {
    const data = await t.seed();
    await t.insertNotification(data, { claimedAt: ago("3 minutes"), error: "stale" });
    const { run, sendTelegram } = setup();

    await run(job(data));

    expect(sendTelegram).toHaveBeenCalledTimes(1);
    const rows = await t.rowsFor(data);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sentAt).toEqual(now);
    expect(rows[0]?.error).toBeNull();
  });

  it("skips an unsent row whose lease is fresh (another worker is sending)", async () => {
    const data = await t.seed();
    await t.insertNotification(data, { claimedAt: ago("30 seconds") });
    const { run, sendTelegram, logged } = setup();

    await run(job(data));

    expect(sendTelegram).not.toHaveBeenCalled();
    const rows = await t.rowsFor(data);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sentAt).toBeNull();
    expect(logged("skip: claimed by another worker")).toBe(1);
  });

  it("skips a row that is already sent, even with an expired lease", async () => {
    const data = await t.seed();
    await t.insertNotification(data, {
      claimedAt: ago("1 day"),
      sentAt: new Date("2026-09-12T08:00:00Z"),
    });
    const { run, sendTelegram, logged } = setup();

    await run(job(data));
    await run(job(data));

    expect(sendTelegram).not.toHaveBeenCalled();
    expect(await t.rowsFor(data)).toHaveLength(1);
    expect(logged("skip: already notified")).toBe(2);
  });

  it("a row at 9 attempts that fails again goes dead, and is never swept or sent", async () => {
    const data = await t.seed();
    await t.insertNotification(data, {
      claimedAt: null,
      createdAt: ago("1 hour"),
      attempts: 9,
      error: "telegram sendMessage: HTTP 403 Forbidden: bot was blocked by the user",
    });
    // Control: stale and live, so an empty sweep can't pass the test by accident.
    const live = await t.seed();
    await t.insertNotification(live, { claimedAt: ago("11 minutes"), attempts: 3 });
    const { run, sendTelegram, logged, lines } = setup();
    sendTelegram.mockRejectedValue(
      new Error("telegram sendMessage: HTTP 403 Forbidden: bot was blocked by the user"),
    );

    // Unrecoverable, so BullMQ does not retry a dead row either.
    await expect(run(job(data))).rejects.toBeInstanceOf(UnrecoverableError);

    const [row] = await t.rowsFor(data);
    expect(row?.attempts).toBe(10);
    expect(row?.deadAt).not.toBeNull();
    expect(row?.claimedAt).not.toBeNull();
    expect(row?.sentAt).toBeNull();
    const dead = lines.filter((l) => l.level === 50);
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({
      searchId: data.searchId,
      propertyId: data.propertyId,
      attempts: 10,
      error: "telegram sendMessage: HTTP 403 Forbidden: bot was blocked by the user",
    });

    // Long after: the claim is stale, but dead_at keeps the row out of the sweep...
    await t.db
      .update(notifications)
      .set({ claimedAt: ago("1 hour") })
      .where(eq(notifications.searchId, data.searchId));
    const enqueued: NotifyJobData[] = [];
    await createSweepProcessor({
      db: t.db,
      log: pino({ level: "silent" }),
      enqueue: async (jobs) => void enqueued.push(...jobs),
    })();
    expect(enqueued).toContainEqual(live);
    expect(enqueued).not.toContainEqual(data);

    // ...and a job that arrives anyway (a later poll) sends nothing.
    await run(job(data));
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(logged("skip: dead")).toBe(1);
  });
});
