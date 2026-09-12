/**
 * The only network access an adapter gets. Core constructs it with the user
 * agent, per-source rate limit, robots.txt check and timeout already applied,
 * so an adapter cannot be impolite by accident. In tests it is replaced by a
 * fixture-backed implementation (see ./testing.ts).
 */
export interface HttpResponse {
  status: number;
  url: string;
  headers: Record<string, string>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

export interface HttpRequestOptions {
  headers?: Record<string, string>;
  /** Override the adapter's default timeout for this request, in ms. */
  timeoutMs?: number;
}

export interface HttpClient {
  get(url: string, options?: HttpRequestOptions): Promise<HttpResponse>;
}

/** Thrown by core's HttpClient when the source's robots.txt disallows the path. */
export class RobotsDisallowedError extends Error {
  constructor(public readonly url: string) {
    super(`robots.txt disallows ${url}`);
    this.name = "RobotsDisallowedError";
  }
}
