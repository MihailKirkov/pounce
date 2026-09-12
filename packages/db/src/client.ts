import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

/** Typed Drizzle instance. Close the pool with `await db.$client.end()`. */
export function createDb(url: string) {
  return drizzle(postgres(url), { schema });
}

export type Db = ReturnType<typeof createDb>;
