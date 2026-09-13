# Sprint 1 — prove the pipeline

**Goal.** The fake adapter produces a Telegram message on Mihail's phone, end to end, through the real queue and the real database. No real website is touched.

**Done when:** `docker compose up -d && pnpm db:migrate && pnpm dev` runs, and within 60 s of adding a saved search via the seed script, a Telegram message arrives for each fake listing that matches — and running the seed again sends nothing.

**Before starting (by hand, 15 min):**
1. @BotFather → `/newbot` → token into `.env` as `TELEGRAM_BOT_TOKEN`.
2. Message the bot once. Open `https://api.telegram.org/bot<TOKEN>/getUpdates`, copy `message.chat.id` into `.env` as `TELEGRAM_CHAT_ID`.
3. `docker compose up -d`, confirm `docker compose ps` shows both healthy.

Each task below is one Claude Code prompt. Paste the block verbatim. Commit after each.

---

## T1 — Schema and migrations (delegate)

```
Implement packages/db from docs/data-model.md using Drizzle + postgres-js.
- src/schema.ts: tables listings, properties, property_listings, dedup_decisions, saved_searches, matches, notifications, source_runs. Money in integer cents. Enums for property_type, furnished, registration mode, match status.
- Unique constraints exactly as in the doc: (source_id, source_listing_id); matches(search_id, property_id); notifications(search_id, property_id, channel).
- src/client.ts: createDb(url) returning a typed drizzle instance; src/index.ts re-exports schema and client.
- Generate the first migration into packages/db/migrations with drizzle-kit and make `pnpm db:migrate` apply it.
Run pnpm typecheck && pnpm db:migrate against the compose Postgres and paste the output.
```

Check: `docker compose exec postgres psql -U pounce -c '\d notifications'` shows the unique index.

## T2 — Real HttpClient (delegate, read the robots part)

```
Add packages/core/src/http/client.ts exporting createHttpClient(opts: { userAgent: string; minGapMs: number; timeoutMs?: number }): HttpClient.
- Uses global fetch. Sets User-Agent on every request.
- Enforces minGapMs between requests to the same host (simple in-memory last-request timestamp per host).
- Fetches and caches <origin>/robots.txt once per origin (cache 1h). If the path is disallowed for our user agent or for *, throw RobotsDisallowedError before making the request. Parse only User-agent / Disallow / Allow; ignore everything else.
- Returns HttpResponse; status >= 400 is NOT thrown — adapters decide.
Write vitest tests with a mocked global fetch: gap is respected, disallowed path throws, allowed path proceeds, robots.txt is fetched once.
Export it from packages/core/src/index.ts.
```

## T3 — Worker bootstrap + poll job (delegate)

```
Implement apps/worker:
- src/main.ts: connect Redis from REDIS_URL, create BullMQ queues "poll" and "notify", register a repeatable job poll:fake every 60s, start workers for both, graceful shutdown on SIGINT/SIGTERM.
- src/registry.ts: map of adapter id → SourceAdapter, currently { fake: fakeAdapter } from @pounce/adapter-fake.
- src/jobs/poll.ts: for the adapter, build an AdapterContext (createHttpClient from core with USER_AGENT env, a pino logger, a Redis-backed AdapterState keyed adapter:<id>:state:<key>), call list() with scope { cities: ["Eindhoven"] }, then for each raw: toCanonical(); if (source_id, source_listing_id) exists → bump last_seen_at; else call detail() if present, toCanonical() again, insert into listings with first_seen_at = now. Write one source_runs row per poll with counts and error.
- Structured logging: one line per poll with seen/new/durationMs.
Do NOT implement normalize, dedup, match or notify in this task. Insert canonical fields as-is.
Run it: pnpm --filter @pounce/worker dev. Paste two consecutive poll log lines showing 3 new then 0 new.
Also: build the HttpClient with minGapMs taken from adapter.polling.minRequestGapMs, not a hardcoded value. On a 429 or 5xx from list(), apply the adapter's polling.backoff (initialSeconds, factor, maxSeconds) to the next poll of that source and record the reason in source_runs.error. Honour a Retry-After header when present.
```

Note: the fake adapter's `ctx.http` will be the real client hitting `fake.example`, which doesn't exist. For sprint 1, add a `FIXTURE_MODE=1` env check in `poll.ts` that uses `testing.createTestContext()` pointing at the adapter package's fixtures instead. Remove in sprint 2.

## T4 — Normalizer skeleton (Mihail writes; Claude Code scaffolds tests)

```
Scaffold only, do not implement:
- packages/core/src/normalize/index.ts exporting normalize(input: CanonicalListingInput, sourceId: string): NormalizedListing
- files price.ts, postcode.ts, url.ts with exported function signatures and TODO bodies that return input unchanged
- normalize.test.ts with failing tests for: "5612 cj" → "5612CJ"; house number "208A" split from street; utm_* stripped from url; base 105000 + service 13500 → total 118500; all-in keeps total, base undefined.
Mark the tests it.todo so the suite passes.
```

Then Mihail un-todos them one by one and makes them pass.

## T5 — Notify job with DB idempotency (delegate, then read every line)

```
Implement apps/worker/src/jobs/notify.ts and packages/core/src/notify/format.ts.
- format.ts: formatTelegram(listing, search): string — plain text, matches the layout in pounce-mockups.html (address, postcode, total with breakdown, m²/rooms/furnishing, available from, registration/income lines, source + published-ago, canonical url). No HTML, no images.
- notify.ts job input { searchId, propertyId }. Steps: INSERT INTO notifications (search_id, property_id, channel='telegram') ON CONFLICT DO NOTHING RETURNING id. If no row returned → log "skip: already notified" and finish. Else send via Telegram Bot API sendMessage (TELEGRAM_BOT_TOKEN, chat id from the saved search), on success set sent_at, on failure set error and throw so BullMQ retries the same job (attempts 5, exponential backoff). Never insert a second row on retry.
Test with a mocked Telegram call: two concurrent jobs for the same (search, property) produce exactly one send.
```

## T6 — Seed + wire it through (delegate the seed, Mihail wires)

```
Add packages/db/src/seed.ts (pnpm --filter @pounce/db run seed): upsert one saved search "Eindhoven apartment" with cities ["Eindhoven"], price_total_max_cents 130000, area_sqm_min 40, rooms_min 2, registration 'any', telegram_chat_id from TELEGRAM_CHAT_ID env, active true.
```

Then wire `poll.ts` through. The plan here was a throwaway — every new listing its own property, `notify` enqueued for every active saved search, no dedup, no matching. **As built**, T6 wired the real pipeline instead: each new listing is normalized, deduplicated into a property, matched against every active saved search, and a notify job is enqueued for each new match.

Phone buzzes **twice**, not three times. Three assumed every listing alerted every search. With the matcher in place, fake-1003 (Blaarthemseweg 74) is in Veldhoven, outside the seeded search's `cities: ["Eindhoven"]`, so it gets a property but no match and no alert. Kruisstraat 112 and Hoogstraat 208A both match. Restart the worker: phone does not buzz. That's the acceptance test.

## T7 — API skeleton (delegate)

```
Implement apps/api with Fastify: src/main.ts listening on PORT (default 3001), GET /health returning { ok: true, db: <ping result>, redis: <ping result> }, pino logging. Nothing else.
```

---

## Out of scope for this sprint
Pararius, Huurwoningen, any HTML parsing, dedup, matching, the web UI, Docker images for the apps, CI. If any of these feels necessary to finish a task above, the task is wrong — say so.

## Backlog captured during the sprint
Append to `docs/backlog.md`, one line each, no discussion.
