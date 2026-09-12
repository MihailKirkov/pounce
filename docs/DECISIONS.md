# Decisions

Append-only. One entry per decision that would be expensive to reverse. Newest at the bottom.
Format: context → decision → why → what we gave up. Keep each under ~150 words.

---

## 001 — Two MVP adapters: Pararius and Huurwoningen.nl (2026-09-12)

**Context.** Brief caps MVP at two sources. Candidates: Pararius, Huurwoningen.nl, Kamernet, Funda.

**Decision.** Pararius first, Huurwoningen.nl second. Kamernet is adapter #3, after the contract is proven.

**Why.** Both are apartment portals with comparable, stable server-rendered markup and structured fields (price, m², rooms, furnished, availability). That gives the normalizer real variance without a second listing *model*. Kamernet is rooms — shared facilities, roommate selection, different qualification semantics — and would force canonical-shape decisions before the shape exists. Funda actively blocks non-browser clients and is the most likely to generate a complaint; it is community-adapter territory, not core.

**Gave up.** Room coverage in January. Acceptable: the acceptance test is Mihail's apartment search.

---

## 002 — Fastify + Drizzle + Postgres, single TypeScript monorepo (2026-09-12)

**Context.** Owner is strongest in Node/TS/Express. Options considered: Express, Fastify, NestJS; Prisma, Drizzle; Postgres, MySQL, Supabase.

**Decision.** Fastify for the API and worker bootstrap, Drizzle for schema and queries, Postgres 16, BullMQ on Redis. pnpm workspaces monorepo: `apps/api`, `apps/worker`, `apps/web`, `packages/core` (adapter contract, canonical model, normalizer, dedup, matcher), `packages/adapters/*`.

**Why.** Fastify is Express-shaped enough to be immediately productive, with first-class TypeScript, schema validation, and better throughput for free. Nest adds a DI framework nobody needs at this size and is harder to explain in an interview. Drizzle keeps SQL visible — dedup fingerprints and idempotency constraints are SQL problems and should look like SQL. Postgres over MySQL for `jsonb` (raw payloads), partial unique indexes, and expression indexes on fingerprints. Supabase is rejected because the self-host promise is `docker-compose up` with zero external accounts.

**Gave up.** Express familiarity (marginal); Nest's structure for a larger team (not the situation).

---

## 003 — Notification idempotency lives in the database (2026-09-12)

**Context.** Brief: a listing is alerted at most once per saved search, ever.

**Decision.** `notifications(search_id, property_id)` with a unique constraint. The notifier inserts *before* sending; on conflict it skips. Send failures are retried against the same row (status column), never re-inserted.

**Why.** Application-level "have I sent this" checks race under concurrent workers and die on redeploys. A unique index cannot.

**Gave up.** Nothing meaningful.

---

## 004 — Store facts and a link, never content (2026-09-12)

**Context.** Legal posture from brief §8.

**Decision.** Canonical listings store structured fields, `canonical_url`, and a `raw_payload` jsonb that is **truncated to structured data only** — no description text, no image URLs beyond the first thumbnail URL (not the image). The UI never renders listing photos; it renders a link.

**Why.** Descriptive text and photos are the protectable parts. Facts aren't. This also keeps storage near zero and makes the hosted version defensible: disable an adapter server-side, nothing else changes.

**Gave up.** A prettier UI. Correct trade at this stage.

---

## 005 — Web UI is a utilitarian admin, dark, desktop-first with a usable phone width (2026-09-12)

**Context.** Owner chose "plain utilitarian, self-hosted admin vibe."

**Decision.** Dense row-based feed, one left rail, detail as a side panel, no marketing surface in the app. Telegram is the primary consumption channel; the web UI exists to *configure* and to *triage* (seen / rejected). Mobile is a narrow layout of the same screens, not a separate design.

**Why.** Every hour on UI polish is an hour not spent on the adapter boundary. The self-host audience judges the README GIF and the Telegram message, not the dashboard.

**Gave up.** First-impression wow. Revisit if/when there is a hosted landing page.

---

## 006 — Many saved searches per instance; still single-user (2026-09-12)

**Context.** Brief §5 said "one saved search." Owner wants several.

**Decision.** N searches per instance, each with its own filters, Telegram target, active flag and match history. Matching, idempotency and the UI are keyed per search. No accounts, no auth beyond a single admin password; that stays out of MVP.

**Why.** The schema was already per-search, so the marginal cost is one list page and a switcher. Running a strict and a loose variant side by side is the fastest way to tune the registration filter and the noise level. Multi-*user* is the thing that would pull in auth, billing and tenancy — that line holds.

**Gave up.** Nothing in effort terms; slightly more UI in session 5.

---

## 007 — No listing images in MVP; hotlinked thumbnail is the only future option (2026-09-12)

**Context.** Owner asked whether the feed should show photos.

**Decision.** No images anywhere in MVP. If added later: store one thumbnail URL, render it hotlinked in the web UI only (`referrerpolicy="no-referrer"`, never proxied or cached), default off in any hosted build. Telegram alerts stay text-only permanently — sending a photo makes Telegram fetch and host it, which is republishing.

**Why.** Photos are the most clearly protected part of a listing and the thing most likely to draw a complaint. Hotlinking is also operationally flaky (blocked referers, rotating CDN URLs). The five-second decision the feed supports is made on price, size, registration and age; the photo is made on the source's page, one tap away.

**Gave up.** A visibly nicer feed. Deliberate.

---

## 008 — Map lane for the web UI; supersedes #005 (2026-09-12)

**Context.** Five design directions were mocked (terminal, classifieds, map, focus, timeline). Owner chose map.

**Decision.** Light theme, Figtree, one action blue, orange reserved for "under 15 min old". Matches is a split view: schematic SVG map with numbered pins on the left, card stack with an inline detail on the right. Every other page (Searches, editor, Sources, Settings) uses the same chrome; the editor shows a live map of selected cities and the work marker.

**Why.** Location is the first filter a renter applies mentally; putting it first matches how people actually triage. The schematic map is hand-drawn SVG — no tile provider, no API key, no photos — so the self-host promise and the no-republishing posture are untouched.

**Consequences.** `lat`/`lng` become important instead of optional. Pararius exposes coordinates; if Huurwoningen doesn't, pins for its listings fall back to postcode centroid (a static NL postcode table, PC4 level, is fine for MVP). The work address is stored and used for straight-line distance only; isochrones remain out of scope. Mobile is map-on-top, sheet-below, same components.

**Gave up.** The dark utilitarian look. One more adapter requirement (coordinates or postcode) — acceptable.

---

## 003a — Amendment to 003: idempotency key includes channel (2026-09-13)

**Context.** 003 specified `notifications(search_id, property_id)` with a status column. When the schema was written (sprint 1, T1), `channel` was added to the key and retry state became `sent_at` / `error`.

**Decision.** The unique constraint is `notifications(search_id, property_id, channel)`. Retry state lives in `sent_at` and `error` on the same row; a retry updates that row, never inserts another.

**Why.** Keying on channel lets a second channel be added later without a constraint change. The rule itself is unchanged: one notification per search, per property, per channel, ever. Insert before send; on conflict, skip.

**Gave up.** Nothing. With a single channel (Telegram) the behaviour is identical to 003 as written.
