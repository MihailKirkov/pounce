/**
 * Test fixtures against the compose Postgres. The notify guarantees are a
 * unique constraint and a conditional UPDATE, so a mocked database would test
 * nothing.
 *
 *   docker compose up -d && pnpm db:migrate
 */
import { randomUUID } from "node:crypto";
import {
  type Db,
  createDb,
  listings,
  notifications,
  properties,
  propertyListings,
  savedSearches,
} from "@pounce/db";
import { type SQL, eq, sql } from "drizzle-orm";
import type { NotifyJobData } from "../jobs/notify.js";

export interface TestDb {
  db: Db;
  /** One saved search and one property with a representative listing. */
  seed(): Promise<NotifyJobData>;
  /** A notifications row for the pair, in whatever state the test needs. */
  insertNotification(
    data: NotifyJobData,
    state: {
      claimedAt?: SQL | null;
      createdAt?: SQL;
      sentAt?: Date;
      error?: string;
      attempts?: number;
      deadAt?: SQL;
    },
  ): Promise<void>;
  rowsFor(data: NotifyJobData): Promise<(typeof notifications.$inferSelect)[]>;
  /** Fails with a hint if Postgres is not reachable. */
  assertReachable(): Promise<void>;
  /** Deletes every row seed() created, then closes the pool. */
  close(): Promise<void>;
}

/** `now() - interval '<text>'`, on the database clock the lease logic uses. */
export const ago = (interval: string): SQL => sql`now() - ${interval}::interval`;

export function createTestDb(): TestDb {
  const db = createDb(process.env.DATABASE_URL ?? "postgres://pounce:pounce@localhost:5432/pounce");
  const created = {
    searchIds: [] as string[],
    propertyIds: [] as string[],
    listingIds: [] as string[],
  };

  return {
    db,

    async seed() {
      const [search] = await db
        .insert(savedSearches)
        .values({ name: "notify test", cities: ["Eindhoven"], telegramChatId: "4242" })
        .returning({ id: savedSearches.id });
      const [listing] = await db
        .insert(listings)
        .values({
          sourceId: "fake",
          sourceListingId: `notify-test-${randomUUID()}`,
          canonicalUrl: "https://fake.example/listing/1001",
          publishedAt: new Date("2026-09-13T10:00:00Z"),
          street: "Kruisstraat",
          houseNumber: "112",
          postcode: "5612CJ",
          city: "Eindhoven",
          priceBaseCents: 105000,
          priceTotalCents: 118500,
          areaSqm: 58,
          rooms: 3,
          furnished: "upholstered",
          registrationAllowed: true,
        })
        .returning({ id: listings.id });
      if (!search || !listing) throw new Error("seed insert returned no row");
      const [property] = await db
        .insert(properties)
        .values({ fingerprintKind: "url", representativeListingId: listing.id })
        .returning({ id: properties.id });
      if (!property) throw new Error("seed insert returned no row");
      await db.insert(propertyListings).values({ propertyId: property.id, listingId: listing.id });

      created.searchIds.push(search.id);
      created.propertyIds.push(property.id);
      created.listingIds.push(listing.id);
      return { searchId: search.id, propertyId: property.id };
    },

    async insertNotification(data, state) {
      await db.insert(notifications).values({ ...data, channel: "telegram", ...state });
    },

    rowsFor(data) {
      return db.select().from(notifications).where(eq(notifications.searchId, data.searchId));
    },

    async assertReachable() {
      try {
        await db.execute(sql`select 1`);
      } catch (err) {
        throw new Error(
          `worker DB tests need Postgres (docker compose up -d && pnpm db:migrate): ${String(err)}`,
        );
      }
    },

    async close() {
      for (const id of created.searchIds) {
        await db.delete(notifications).where(eq(notifications.searchId, id));
      }
      for (const id of created.propertyIds) {
        await db.delete(propertyListings).where(eq(propertyListings.propertyId, id));
        await db.delete(properties).where(eq(properties.id, id));
      }
      for (const id of created.listingIds) await db.delete(listings).where(eq(listings.id, id));
      for (const id of created.searchIds) {
        await db.delete(savedSearches).where(eq(savedSearches.id, id));
      }
      await db.$client.end();
    },
  };
}
