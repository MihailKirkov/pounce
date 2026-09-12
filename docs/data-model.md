# Data model

Source of truth for the canonical listing shape and the tables around it. Every field is nullable unless marked **req**. A missing field must never fail ingestion — it may only fail *matching*.

## Pipeline objects

```
RawListing   — adapter output, source-specific shape, opaque to core
CanonicalListing — one normalized row per (source, sourceListingId)
Property     — one row per deduplicated physical property; N listings → 1 property
Match        — (property, savedSearch) pair that passed the matcher
Notification — (property, savedSearch) that was sent; unique, ever
```

## `listings` (CanonicalListing)

| Field | Type | Notes / mapping guidance |
|---|---|---|
| `id` **req** | uuid | |
| `source_id` **req** | text | adapter key, e.g. `pararius`, `huurwoningen` |
| `source_listing_id` **req** | text | source's own id; `(source_id, source_listing_id)` unique |
| `canonical_url` **req** | text | tracking params stripped, https, no fragment |
| `first_seen_at` **req** | timestamptz | our clock, set on first insert |
| `published_at` | timestamptz | source's claim; Pararius exposes "aangeboden sinds", Huurwoningen exposes a date badge. Fall back to `first_seen_at` for age display, and flag which one is being shown |
| `title` | text | |
| `address_raw` | text | exactly as the source shows it |
| `street` | text | parsed; house number kept in street |
| `house_number` | text | separate for dedup fingerprint; includes suffix (`12a`, `12-2`) |
| `postcode` | text | normalized `1234AB` (no space, upper) |
| `city` | text | |
| `lat`, `lng` | double | only if the source provides it; never geocode in MVP |
| `price_base_cents` | int | *kale huur* |
| `price_total_cents` | int | what you actually pay monthly; if source only gives all-in, base is null and total is set |
| `price_includes` | text[] | `gas`, `water`, `electricity`, `internet`, `service_costs`, `municipal_taxes` |
| `deposit_cents` | int | *borg* |
| `area_sqm` | int | |
| `rooms` | int | *kamers* — total rooms, NL convention |
| `bedrooms` | int | *slaapkamers* |
| `property_type` | enum | `apartment`, `house`, `studio`, `room` |
| `furnished` | enum | `bare` (kaal), `upholstered` (gestoffeerd), `furnished` (gemeubileerd) |
| `available_from` | date | |
| `min_contract_months` | int | |
| `registration_allowed` | bool | *inschrijving mogelijk*. Usually only in free text. Adapters may set `true`/`false` only when explicit; otherwise null. **Null is not false** — the matcher decides how to treat unknown |
| `pets_allowed` | bool | same rule as above |
| `income_requirement_multiple` | numeric | e.g. `3.5`; only when explicit |
| `agency_name` | text | |
| `agency_fee_flagged` | bool | true if *bemiddelingskosten* appears — illegal, surface as a warning |
| `raw_payload` | jsonb | structured fields only, see DECISIONS #004 |
| `last_seen_at` **req** | timestamptz | bumped every poll; listing considered gone after N misses |
| `gone_at` | timestamptz | |

## `properties`

| Field | Notes |
|---|---|
| `id` | uuid |
| `fingerprint_kind` | `url` / `address` / `fuzzy` — which layer matched |
| `postcode`, `house_number` | copied from the representative listing |
| `representative_listing_id` | the listing shown in the UI (earliest `published_at`) |

`property_listings(property_id, listing_id)` is the join. Dedup decisions are rows in `dedup_decisions(listing_id, property_id, kind, score, decided_at, reversed_at)` so they can be audited and undone.

### Fingerprint layers (in order, first hit wins)
1. `canonical_url` equal
2. `postcode + house_number` equal (both non-null)
3. `postcode` equal AND `price_total` within ±5% AND `area_sqm` within ±10% AND `rooms` equal — logged as a near-miss for weekly review, **and** auto-merged

## `saved_searches`

| Field | Notes |
|---|---|
| `id`, `name` | |
| `cities` | text[] |
| `price_total_max_cents`, `price_total_min_cents` | matched on total, not base |
| `area_sqm_min` | |
| `rooms_min` | |
| `furnished` | enum[] — any of |
| `property_types` | enum[] |
| `registration` | `required` / `preferred` / `any`. `required` drops `null`; `preferred` keeps `null` but sorts `true` first |
| `telegram_chat_id` | one channel, MVP |
| `active` | bool |

## `matches` and `notifications`

```sql
matches(id, search_id, property_id, matched_at, status)  -- status: new | seen | rejected
  unique (search_id, property_id)

notifications(id, search_id, property_id, channel, created_at, sent_at, error)
  unique (search_id, property_id, channel)   -- the idempotency rule, in the schema
```

## `source_runs`

One row per poll: `source_id, started_at, finished_at, listings_seen, listings_new, error`. Drives the source-health strip in the UI and the "median time to alert" metric. Keep 30 days.

## Addendum (map lane, DECISIONS #008)

- `listings.lat`/`lng`: adapters set these when the source provides them. When absent, the normalizer fills them from a bundled PC4 postcode-centroid table and sets `geo_precision = 'postcode'` (vs `'exact'`). Pins render either way; precision is shown in the detail.
- `saved_searches.work_address`, `work_lat`, `work_lng`: optional. Used only to compute `distance_km` per match for display. No routing, no isochrone.
