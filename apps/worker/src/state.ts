import type { AdapterState } from "@pounce/core";
import type { Redis } from "ioredis";

/** AdapterState persisted in Redis under adapter:<id>:state:<key>. */
export function createRedisAdapterState(redis: Redis, adapterId: string): AdapterState {
  const k = (key: string) => `adapter:${adapterId}:state:${key}`;
  return {
    async get(key) {
      return (await redis.get(k(key))) ?? undefined;
    },
    async set(key, value) {
      await redis.set(k(key), value);
    },
  };
}

/**
 * Per-source backoff, kept outside the adapter's own state namespace so an
 * adapter cannot clear it. Deleted on the first unthrottled list().
 */
export interface SourceBackoff {
  /** Consecutive polls whose list() hit a 429/5xx. */
  failures: number;
  /** Epoch ms; polls scheduled before this are skipped. */
  until: number;
  reason: string;
}

const backoffKey = (sourceId: string) => `source:${sourceId}:backoff`;

export async function readBackoff(
  redis: Redis,
  sourceId: string,
): Promise<SourceBackoff | undefined> {
  const raw = await redis.get(backoffKey(sourceId));
  return raw === null ? undefined : (JSON.parse(raw) as SourceBackoff);
}

export async function writeBackoff(
  redis: Redis,
  sourceId: string,
  backoff: SourceBackoff,
): Promise<void> {
  await redis.set(backoffKey(sourceId), JSON.stringify(backoff));
}

export async function clearBackoff(redis: Redis, sourceId: string): Promise<void> {
  await redis.del(backoffKey(sourceId));
}
