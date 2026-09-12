# Pounce

Self-hosted rental-listing watcher. Polls sources, dedupes, filters on what actually gets you accepted, pings your phone in seconds.

**Status:** pre-scaffold. See `docs/` and `DECISIONS.md`.

```
pnpm install
cp .env.example .env
docker compose up -d
pnpm dev
```

Layout:

```
apps/api        Fastify HTTP API + admin auth
apps/worker     BullMQ workers: poll sources, normalize, dedup, match, notify
apps/web        Next.js dashboard
packages/core   Adapter contract, canonical model, normalizer, dedup, matcher  ← the engine
packages/db     Drizzle schema, migrations, client
packages/adapters/*   One package per source. See ADAPTERS.md to add one.
```
