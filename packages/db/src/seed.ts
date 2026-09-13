/**
 * Upserts the sprint 1 saved search. Idempotent: matched by name, so running it
 * again updates the one row instead of adding another.
 *
 *   pnpm --filter @pounce/db run seed
 */
import { eq } from "drizzle-orm";
import { createDb } from "./client.js";
import { savedSearches } from "./schema.js";

const NAME = "Eindhoven apartment";

const chatId = process.env.TELEGRAM_CHAT_ID;
if (!chatId) {
  console.error("seed: TELEGRAM_CHAT_ID is not set (see docs/sprint-1.md, 'Before starting')");
  process.exit(1);
}

const search = {
  name: NAME,
  cities: ["Eindhoven"],
  priceTotalMinCents: 70000,
  priceTotalMaxCents: 130000,
  areaSqmMin: 40,
  roomsMin: 2,
  propertyTypes: ["apartment", "studio"],
  furnished: ["bare", "upholstered", "furnished", "not_stated"],
  registration: "any",
  telegramChatId: chatId,
  active: true,
} satisfies typeof savedSearches.$inferInsert;

const db = createDb(process.env.DATABASE_URL ?? "postgres://pounce:pounce@localhost:5432/pounce");
try {
  // saved_searches has no unique name, so find-then-write inside one transaction.
  const { id, action } = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: savedSearches.id })
      .from(savedSearches)
      .where(eq(savedSearches.name, NAME));
    if (existing) {
      await tx.update(savedSearches).set(search).where(eq(savedSearches.id, existing.id));
      return { id: existing.id, action: "updated" };
    }
    const [inserted] = await tx
      .insert(savedSearches)
      .values(search)
      .returning({ id: savedSearches.id });
    if (!inserted) throw new Error("insert returned no row");
    return { id: inserted.id, action: "inserted" };
  });
  console.log(`seed: ${action} saved search "${NAME}" (${id})`);
} finally {
  await db.$client.end();
}
