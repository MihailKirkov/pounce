import { describe, expect, it } from "vitest";
import { canonicalizeUrl } from "./url.js";

describe("canonicalizeUrl", () => {
  it("strips utm_* and fbclid while a real query param survives", () => {
    expect(
      canonicalizeUrl(
        "https://fake.example/listing/1002?utm_source=x&page=2&fbclid=abc&utm_medium=y",
      ),
    ).toBe("https://fake.example/listing/1002?page=2");
  });

  it("strips every tracking param, case-insensitively, and drops an empty query", () => {
    expect(
      canonicalizeUrl(
        "https://fake.example/l?UTM_Campaign=a&gclid=1&mc_cid=2&mc_eid=3&ref=home&source=mail",
      ),
    ).toBe("https://fake.example/l");
  });

  it("keeps the remaining params in their original order and encoding", () => {
    expect(canonicalizeUrl("https://fake.example/l?z=1&utm_source=x&a=b%2Cc&m=%20")).toBe(
      "https://fake.example/l?z=1&a=b%2Cc&m=%20",
    );
  });

  it("does not treat params that merely contain a tracking name as tracking", () => {
    expect(canonicalizeUrl("https://fake.example/l?referrer=1&sources=2&utm=3")).toBe(
      "https://fake.example/l?referrer=1&sources=2&utm=3",
    );
  });

  it("forces https, lowercases the host and strips a leading www.", () => {
    expect(canonicalizeUrl("http://WWW.Pararius.NL/huurwoningen/eindhoven")).toBe(
      "https://pararius.nl/huurwoningen/eindhoven",
    );
  });

  it("only strips www. as a leading label", () => {
    expect(canonicalizeUrl("https://wwwx.example/a")).toBe("https://wwwx.example/a");
    expect(canonicalizeUrl("https://shop.www.example/a")).toBe("https://shop.www.example/a");
  });

  it("drops the fragment", () => {
    expect(canonicalizeUrl("https://fake.example/listing/1?id=1#photos")).toBe(
      "https://fake.example/listing/1?id=1",
    );
  });

  it("strips a trailing slash on non-root paths but keeps the root slash", () => {
    expect(canonicalizeUrl("https://fake.example/listing/1/")).toBe(
      "https://fake.example/listing/1",
    );
    expect(canonicalizeUrl("https://fake.example/listing/1/?a=1")).toBe(
      "https://fake.example/listing/1?a=1",
    );
    expect(canonicalizeUrl("https://fake.example/")).toBe("https://fake.example/");
    expect(canonicalizeUrl("https://fake.example")).toBe("https://fake.example/");
  });

  it("is idempotent", () => {
    const once = canonicalizeUrl("http://www.fake.example/l/?utm_source=x&a=1#f");
    expect(canonicalizeUrl(once)).toBe(once);
  });

  it("throws on input that is not an absolute http(s) URL", () => {
    expect(() => canonicalizeUrl("")).toThrow();
    expect(() => canonicalizeUrl("not a url")).toThrow();
    expect(() => canonicalizeUrl("/listing/1")).toThrow();
    expect(() => canonicalizeUrl("ftp://fake.example/listing/1")).toThrow();
    expect(() => canonicalizeUrl("mailto:someone@fake.example")).toThrow();
  });
});
