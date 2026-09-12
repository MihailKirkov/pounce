import type { HttpClient } from "./http.js";
import type { CanonicalListingInput } from "./listing.js";

/**
 * SourceAdapter — the contract between a listing source and the Pounce core.
 *
 * Design rules (see ADAPTERS.md for the long version):
 *  - An adapter knows nothing about queues, storage, dedup, matching or notification.
 *  - An adapter never opens a socket itself; it uses `ctx.http`.
 *  - An adapter extracts; core interprets. Return fields as the source states them.
 *  - `list()` must be cheap: one request per page, no detail fetches.
 *  - `detail()` is optional and is called by core only for listings it has not seen.
 *  - Everything must be reproducible from recorded fixtures (see ./testing.ts).
 */
export interface SourceAdapter<Raw = unknown> {
  /** Stable key, lowercase, used as `listings.source_id`. e.g. "pararius" */
  readonly id: string;
  readonly displayName: string;
  readonly homepage: string;

  readonly polling: PollingPolicy;
  readonly transport: "http" | "browser";
  readonly capabilities: SourceCapabilities;

  /**
   * Fetch the current index of listings for a search scope. Return every
   * listing visible on the index page(s); core decides which are new.
   */
  list(scope: SearchScope, ctx: AdapterContext): Promise<ListResult<Raw>>;

  /**
   * Optionally enrich a raw listing with data only present on its detail page
   * (registration, deposit, income requirement). Return the enriched raw.
   * Core calls this at most once per new listing, within the same rate limit.
   */
  detail?(raw: Raw, ctx: AdapterContext): Promise<Raw>;

  /** Map a raw listing to canonical fields. Pure; no I/O. */
  toCanonical(raw: Raw): CanonicalListingInput;
}

export interface PollingPolicy {
  /** How often core should call list(). Core may poll slower, never faster. */
  intervalSeconds: number;
  /** Hard floor. Core refuses to configure anything below this. */
  minIntervalSeconds: number;
  /** Minimum gap between any two requests to this source, in ms. */
  minRequestGapMs: number;
  /** Backoff when the source returns 403/429/5xx. */
  backoff: { initialSeconds: number; maxSeconds: number; factor: number };
}

export interface SourceCapabilities {
  /** Source exposes lat/lng per listing. If false, core falls back to postcode centroid. */
  coordinates: boolean;
  /** Source exposes its own publication timestamp. */
  publishedAt: boolean;
  /** Source can filter by city server-side; if false, core filters after list(). */
  cityFilter: boolean;
  /** detail() yields registration info at least sometimes. */
  registrationOnDetail: boolean;
}

/** The union of all active saved searches' geography, so one poll serves all of them. */
export interface SearchScope {
  /** Cities as the source spells them. Empty means "whatever the source's default index is". */
  cities: string[];
  /** Upper bound in cents, if the source can filter on it. Advisory. */
  priceTotalMaxCents?: number;
}

export interface AdapterContext {
  http: HttpClient;
  logger: AdapterLogger;
  /** Injected clock so fixtures replay deterministically. */
  now(): Date;
  /** Key/value scratch that survives between polls of the same source (e.g. an ETag). */
  state: AdapterState;
}

export interface AdapterLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface AdapterState {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

export interface ListResult<Raw> {
  listings: Raw[];
  /**
   * Set when the adapter can tell the index was complete (e.g. it paged to the
   * end). Core uses this to mark listings absent from the index as gone.
   * If false or omitted, core only ever adds, never expires.
   */
  complete?: boolean;
  /** Free-form diagnostics for the source-health page: pages fetched, etc. */
  diagnostics?: Record<string, number | string>;
}

/** Thrown by an adapter when the source's markup no longer matches. Loud on purpose. */
export class AdapterParseError extends Error {
  constructor(
    public readonly adapterId: string,
    message: string,
    public readonly sample?: string,
  ) {
    super(`[${adapterId}] ${message}`);
    this.name = "AdapterParseError";
  }
}

/** Identity helper so adapter packages get type inference without importing generics. */
export function defineAdapter<Raw>(adapter: SourceAdapter<Raw>): SourceAdapter<Raw> {
  return adapter;
}
