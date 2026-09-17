// Tests for the ddgs-uv module — uvx availability detection and path resolution.
// No network calls; tests the detection logic only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { hasUvx } from "../ddgs-uv.ts";

test("ddgs-uv: hasUvx returns a boolean", () => {
  const result = hasUvx();
  assert.equal(typeof result, "boolean");
});

test("ddgs-uv: hasUvx is consistent across calls", () => {
  const first = hasUvx();
  const second = hasUvx();
  assert.equal(first, second);
});
