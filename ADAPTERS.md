# Writing a source adapter

An adapter turns one listing website into `CanonicalListingInput` objects. It knows nothing about the database, queues, dedup, matching or Telegram. If you find yourself importing anything other than `@pounce/core`, stop.

The contract lives in `packages/core/src/adapter.ts`. Read it; it is short. This document is the *why*.

## The shape

```ts
export const myAdapter = defineAdapter<MyRaw>({
  id: "mysource",                 // lowercase, becomes listings.source_id
  displayName: "My Source",
  homepage: "https://…",
  transport: "http",              // "browser" only if HTML is JS-rendered; expensive, avoid
  polling:  { intervalSeconds, minIntervalSeconds, minRequestGapMs, backoff },
  capabilities: { coordinates, publishedAt, cityFilter, registrationOnDetail },

  async list(scope, ctx)  { … },  // one cheap index fetch → Raw[]
  async detail(raw, ctx)  { … },  // optional; enrich one Raw from its detail page
  toCanonical(raw)        { … },  // pure mapping, no I/O
});
```

## Rules

**1. Use `ctx.http`, never `fetch`.** Core builds the client with the honest user agent, the per-source request gap, the robots.txt check and timeouts. This is how the project stays a polite client without relying on every contributor remembering. A PR that imports `node-fetch`, `axios`, `undici` or calls global `fetch` will be closed.

**2. `list()` is one request per page and nothing else.** Core calls it every `intervalSeconds`. If your index has 10 pages, fetch 10 pages — but do not fetch detail pages from `list()`. Return `complete: true` only if you are sure you saw the whole index, because core will mark listings you didn't return as gone.

**3. `detail()` is called by core only for listings it hasn't seen.** That is where registration (*inschrijving*), deposit and income requirements usually live. Return the enriched raw; `toCanonical()` runs on the result. If the detail page 404s, return the original raw.

**4. Extract, don't interpret.** `toCanonical()` maps what the source says into canonical field names. It does not guess:
- If the source shows "€1.180 per maand" with no breakdown, set `priceTotalCents` and leave `priceBaseCents` undefined. Core decides how to compare it.
- Set `registrationAllowed`, `petsAllowed`, `incomeRequirementMultiple` **only when the page states it**. Unknown is `undefined`. `false` means the source said no. Core treats those very differently.
- Postcodes, URLs and whitespace go through as-is. Core normalizes them.

**5. Never return content.** No description text, no image URLs, no agent phone numbers. Facts and a link (DECISIONS #004). `extra` is for structured leftovers like the source's own category id.

**6. Fail loudly when the markup changes.** Throw `AdapterParseError` with a short `sample` of the HTML that didn't match. A silent empty list looks like "no new flats" to a user who is refreshing every minute; a thrown error shows up red on the Sources page within one poll.

**7. Fixtures, not the network, in tests.** Record real responses into `fixtures/` and test against them with `testing.createTestContext()` and `testing.assertAdapterContract()`. Your test must pass with the network unplugged. See `packages/adapters/fake` for the reference.

## Recording fixtures

```sh
mkdir -p fixtures
curl -sA "pounce/0.1 (+https://github.com/YOUR_USER/pounce)" \
  -o fixtures/list.html "https://source.example/huur/eindhoven"
echo '{ "url": "https://source.example/huur/eindhoven" }' > fixtures/list.meta.json
```

Then in `src/index.test.ts`:

```ts
const ctx = await testing.createTestContext({ fixturesDir });
const { canon } = await testing.assertAdapterContract(myAdapter, ctx, { cities: ["Eindhoven"] });
expect(canon[0]?.priceTotalCents).toBe(118500);
```

Fixtures go stale when the site changes. That's the point — the test failing *is* the alert.

## Sources that are out of scope

Anything that needs login, a CAPTCHA, a paywall, or an explicit ToS ban on automated access is not accepted into this repository. Fork it, run it yourself, don't send the PR.

## Checklist for a PR

- [ ] `id` matches the package name (`@pounce/adapter-<id>`)
- [ ] `polling.minIntervalSeconds` ≥ 30 and justified in the PR description
- [ ] `capabilities` are honest (if `coordinates: true`, every listing has them)
- [ ] fixture-based test passes offline
- [ ] no `fetch`, no description text, no image URLs
- [ ] robots.txt of the source checked manually and the paths you hit are allowed
