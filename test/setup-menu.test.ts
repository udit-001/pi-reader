// Tests for the /search-setup menu seams (search/setup-menu.ts): the pure
// seams only — the arg parser, the status reads, and the spec-driven row
// mapping. The overlay itself (SelectList surgery, wizard place-swapping)
// is browser-of-one TUI behavior; its parts are tested where they live:
// the wizard phases in key-setup.test.ts, the import extras in
// exa-setup.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSetupProvider, menuStatuses, menuRows, footerFor } from "../search/setup-menu.ts";

// parseSetupProvider — the arg seam 
test("parseSetupProvider maps the arg to a provider, tolerant of case, spaces, and a slash", () => {
  assert.equal(parseSetupProvider("exa"), "exa");
  assert.equal(parseSetupProvider("  Parallel "), "parallel");
  assert.equal(parseSetupProvider("/openalex"), "openalex");
  assert.equal(parseSetupProvider("OPENALEX"), "openalex");
});

test("parseSetupProvider returns undefined for empty, unknown, and wishlist args", () => {
  assert.equal(parseSetupProvider(""), undefined);
  assert.equal(parseSetupProvider("   "), undefined);
  assert.equal(parseSetupProvider("duckduckgo"), undefined); // keyless: no setup exists
  assert.equal(parseSetupProvider("exaa"), undefined);
});

// menuStatuses — the status seam (same reads the wizard intros make) 
test("menuStatuses: config field wins over env var, env wins over none", () => {
  const s = menuStatuses(
    { version: 1, exa: { url: "https://mcp.exa.ai/mcp", apiKey: "cfg-key" } },
    { EXA_API_KEY: "env-key" },
  );
  assert.equal(s.exa, "set (config)");
  assert.equal(s.parallel, "none configured");
  assert.equal(s.openalex, "none configured");

  const envOnly = menuStatuses(null, { PARALLEL_API_KEY: "p-env" });
  assert.equal(envOnly.parallel, "set (environment)");
});

test("menuStatuses: blank config values and blank env strings read as none", () => {
  const s = menuStatuses(
    { version: 1, papers: { openalexApiKey: "   " }, parallel: { url: "x", apiKey: "" } },
    { OPENALEX_API_KEY: "", PARALLEL_API_KEY: undefined },
  );
  assert.equal(s.openalex, "none configured");
  assert.equal(s.parallel, "none configured");
});

// menuRows — the spec-driven row seam (order and copy live here) 
test("menuRows: three rows in provider order, dashboard URL from the spec, status interpolated", () => {
  const rows = menuRows({ exa: "set (config)", parallel: "none configured", openalex: "set (environment)" });
  assert.deepEqual(rows.map((r) => r.value), ["exa", "parallel", "openalex"]);
  assert.equal(rows[0]!.label, "Exa ✓");
  assert.equal(rows[1]!.label, "Parallel"); // no key, no mark
  assert.equal(rows[1]!.description, "key: none configured — https://platform.parallel.ai");
  assert.equal(rows[2]!.label, "OpenAlex ✓");
  assert.equal(rows[2]!.description, "key: set (environment) — https://openalex.org/settings/api");
});

// footerFor — the selection-aware affordance 
test("footerFor: a set key is replaced, a missing one is set up", () => {
  assert.equal(footerFor("set (config)"), "enter replace key · esc close");
  assert.equal(footerFor("set (environment)"), "enter replace key · esc close");
  assert.equal(footerFor("none configured"), "enter set up · esc close");
});
