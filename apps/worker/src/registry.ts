import { fakeAdapter } from "@pounce/adapter-fake";
import type { SourceAdapter } from "@pounce/core";

/** Adapter id → adapter. A source is polled iff it is in this map. */
export const registry: Readonly<Record<string, SourceAdapter>> = {
  [fakeAdapter.id]: fakeAdapter,
};
