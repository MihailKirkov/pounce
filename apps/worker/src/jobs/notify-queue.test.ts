/**
 * Runs against the compose Redis: what is being tested is how BullMQ treats a
 * repeated jobId, which only the real queue can answer.
 */
import { randomUUID } from "node:crypto";
import { Queue, UnrecoverableError, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { type NotifyJobData, notifyJob, notifyJobOptions } from "./notify.js";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});
const queue = new Queue<NotifyJobData>(`notify-test-${randomUUID()}`, {
  connection: redis,
  defaultJobOptions: notifyJobOptions,
});

afterAll(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
  await redis.quit();
});

const pending = () => queue.getJobCountByTypes("waiting", "delayed", "active");

describe("notify jobs on the queue", () => {
  it("drop a duplicate while one is pending, and accept the pair again once that job has failed", async () => {
    const data = { searchId: randomUUID(), propertyId: randomUUID() };

    // Two consecutive sweeps find the same row.
    await queue.addBulk([notifyJob(data)]);
    await queue.addBulk([notifyJob(data)]);
    expect(await pending()).toBe(1);

    // The job fails for good. Without removeOnFail its id would stay taken and
    // every later sweep of this row would be silently dropped.
    const worker = new Worker<NotifyJobData>(
      queue.name,
      async () => {
        throw new UnrecoverableError("telegram sendMessage: HTTP 502");
      },
      { connection: redis },
    );
    await new Promise((resolve) => worker.once("failed", resolve));
    await worker.close();
    expect(await pending()).toBe(0);

    await queue.addBulk([notifyJob(data)]);
    expect(await pending()).toBe(1);
  });
});
