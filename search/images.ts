// images.ts — the images vertical adapter: `provider: "images"`, backed by the
// ddgs images subcommand (free, keyless). Explicit-only: never chosen by
// auto-routing (fuzzy "image of" intent hijacking text searches is a
// determinism risk).
//
// Normalization is agent-POV: every field the agent can act on survives, every
// no-op is dropped. The link target is the direct, hotlinkable image URL
// (`image`, not the thumbnail and not the source page); dims and source domain
// collapse into the snippet so the default renderer needs no changes. There is
// no degrade-to-text: text results cannot substitute for images, so failure
// surfaces as an in-band error and the agent retries or rephrases.

import type { SearchOptions, SearchResult } from "./search.ts";
import { hasUvx, imagesViaDdgs, type DdgsRawRow } from "./ddgs-uv.ts";

// ── Normalization (pure seam) ─────────────────────────────────────────────────

export type DdgsImageRow = DdgsRawRow;

/** ddgs images rows → SearchResult. `url`←`image` (the hotlinkable origin —
 *  thumbnail and source-page url are dropped), `title` verbatim,
 *  `snippet`←`"W×H · via source"` (dims only when both parse; tokens join
 *  with " · "; missing dims/source tolerated). Rows without an image url are
 *  dropped. Pure; exported for tests. */
export function normalizeImageResults(rows: DdgsImageRow[]): SearchResult[] {
  const results: SearchResult[] = [];
  for (const r of rows) {
    if (!r.image) continue;
    const tokens: string[] = [];
    const w = Number(r.width);
    const h = Number(r.height);
    // Truthy check first: an empty-string dim is missing, never 0 — the
    // snippet must not invent a value the engines didn't emit.
    if (r.width && r.height && Number.isFinite(w) && Number.isFinite(h)) {
      tokens.push(`${w}×${h}`);
    }
    if (r.source) tokens.push(`via ${r.source}`);
    results.push({
      title: r.title ?? "",
      url: r.image,
      snippet: tokens.join(" · "),
    });
  }
  return results;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

/** Injectable seams so the adapter is testable without network. */
export interface ImagesDeps {
  hasUvx: () => boolean;
  runImages: (query: string, options: SearchOptions) => SearchResult[];
}

export const defaultImagesDeps: ImagesDeps = {
  hasUvx,
  runImages: (query, options) => normalizeImageResults(imagesViaDdgs(query, options)),
};

/** Search the images vertical. Throws when the images path is unavailable —
 *  no text substitute exists, so the entry surfaces the error as an
 *  actionable in-band message instead of fake results. */
export async function searchImages(
  query: string,
  options: SearchOptions = {},
  deps: ImagesDeps = defaultImagesDeps,
): Promise<SearchResult[]> {
  if (!deps.hasUvx()) {
    throw new Error("uvx unavailable — the images vertical needs uv/ddgs; install uv or use a different provider");
  }
  return deps.runImages(query, options);
}
