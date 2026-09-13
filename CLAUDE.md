# Pounce — instructions for Claude Code

Read `README.md`, `DECISIONS.md`, `ADAPTERS.md` and `docs/data-model.md` before changing anything. Decisions in `DECISIONS.md` are settled; if a task needs one reversed, stop and say so instead of working around it.

## Non-negotiables
- **pnpm only.** Never run `npm` or `yarn`. Never create `package-lock.json`.
- **TypeScript strict, ESM, NodeNext.** No `any`, no `// @ts-ignore`, no CommonJS.
- **`packages/core` imports nothing from `apps/*` or `packages/db`.** It has no database, network or queue dependencies. If you need I/O in core, you are in the wrong package.
- **Adapters never use `fetch`, `undici`, `axios` or `node-fetch`.** They use `ctx.http` only. This is enforced by review, not by tooling — do not add a fetch import "just for now".
- **Never store or render listing descriptions, photos or image URLs** (DECISIONS #004). Facts and a link.
- **Notification idempotency is a unique constraint** on `notifications(search_id, property_id, channel)`. Insert before send. Do not add application-level "already sent" checks that duplicate it.
- **Every field on a listing is nullable.** Missing data may fail matching, never ingestion.
- **`null` is not `false`** for `registration_allowed`, `pets_allowed`, `income_requirement_multiple`.

## Where things go
- Engine logic (normalize, dedup, match, notify formatting, http client): `packages/core/src/<area>/`
- Schema + migrations + db client: `packages/db`
- Queue processors: `apps/worker/src/jobs/`
- HTTP routes: `apps/api/src/routes/`
- One source = one package under `packages/adapters/<id>` with `fixtures/` and a contract test

## Working style
- Small commits, one task each. Run `pnpm typecheck && pnpm lint && pnpm test` before declaring a task done; paste the output.
- Write the test first when the task is in `packages/core`.
- The owner reviews normalize, dedup, matcher and the notify idempotency path line by line before commit. Implement them fully, but write tests first and keep each function small and pure.
- Do not add features not in the current sprint file under `docs/`. If something seems missing, add a line to `docs/backlog.md` instead of building it.
- Do not install a dependency without saying why in the commit message. Prefer the standard library.

## Commands
```
docker compose up -d      # Postgres 16 + Redis 7, dev only
pnpm install
pnpm db:migrate
pnpm dev                  # all apps in watch mode
pnpm test                 # builds core first, then runs every package's tests
```
