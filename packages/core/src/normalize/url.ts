const TRACKING_PARAMS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid", "ref", "source"]);

function isTrackingParam(segment: string): boolean {
  const key = segment.split("=", 1)[0]?.toLowerCase() ?? "";
  return key.startsWith("utm_") || TRACKING_PARAMS.has(key);
}

/**
 * Canonical form used for `listings.canonical_url` and dedup layer 1.
 * Throws if `raw` is not an absolute http(s) URL.
 *
 * Query params are filtered as raw `&`-separated segments rather than through
 * URLSearchParams, so the surviving params keep their order *and* encoding.
 */
export function canonicalizeUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`Not an http(s) URL: ${raw}`);
  }

  url.protocol = "https:";
  // WHATWG URL already lowercases the host of http(s) URLs.
  url.hostname = url.hostname.replace(/^www\./, "");
  url.hash = "";

  const kept = url.search
    .slice(1)
    .split("&")
    .filter((segment) => segment !== "" && !isTrackingParam(segment));
  url.search = kept.length > 0 ? `?${kept.join("&")}` : "";

  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  return url.toString();
}
