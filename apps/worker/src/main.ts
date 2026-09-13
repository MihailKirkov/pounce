import { createDb } from "@pounce/db";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { pino } from "pino";
import { createNotifyProcessor } from "./jobs/notify.js";
import { type PollJobData, createPollProcessor } from "./jobs/poll.js";
import { registry } from "./registry.js";

const log = pino({ name: "worker" });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    log.fatal({ env: name }, `missing required env ${name}`);
    process.exit(1);
  }
  return value;
}

const redisUrl = requireEnv("REDIS_URL");
const databaseUrl = requireEnv("DATABASE_URL");
// No default: every request we make carries it, and it must say who we are.
const userAgent = requireEnv("USER_AGENT");
const fixtureMode = process.env.FIXTURE_MODE === "1";

// BullMQ workers need maxRetriesPerRequest: null for their blocking commands.
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const db = createDb(databaseUrl);

const pollQueue = new Queue<PollJobData>("poll", { connection: redis });
const notifyQueue = new Queue("notify", { connection: redis });

for (const adapter of Object.values(registry)) {
  // Core may poll slower than the adapter asks, never faster than its floor.
  const everySeconds = Math.max(
    adapter.polling.intervalSeconds,
    adapter.polling.minIntervalSeconds,
  );
  await pollQueue.upsertJobScheduler(
    `poll:${adapter.id}`,
    { every: everySeconds * 1000 },
    { name: "poll", data: { sourceId: adapter.id } },
  );
  log.info({ source: adapter.id, everySeconds }, "poll scheduled");
}

// Concurrency 1: one poll at a time keeps the per-source request gap meaningful.
const pollWorker = new Worker<PollJobData>(
  "poll",
  createPollProcessor({ db, redis, log, userAgent, fixtureMode }),
  { connection: redis, concurrency: 1 },
);
const notifyWorker = new Worker("notify", createNotifyProcessor(log), { connection: redis });

for (const worker of [pollWorker, notifyWorker]) {
  worker.on("failed", (job, err) => {
    log.error({ queue: worker.name, jobId: job?.id, error: err.message }, "job failed");
  });
}

log.info({ fixtureMode }, "worker started");

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  try {
    // Workers first: lets an in-flight poll finish before its connections go.
    await Promise.all([pollWorker.close(), notifyWorker.close()]);
    await Promise.all([pollQueue.close(), notifyQueue.close()]);
    await redis.quit();
    await db.$client.end();
    process.exit(0);
  } catch (err) {
    log.error({ error: err instanceof Error ? err.message : String(err) }, "shutdown failed");
    process.exit(1);
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
