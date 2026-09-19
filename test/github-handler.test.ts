// Tests for the GitHub handler's pure formatting seam: repoHeader (metadata
// block rendered above the README) and formatRelease/formatReleases. The
// HTTP layer (api.github.com calls) stays behind the handler interface.

import { test } from "node:test";
import assert from "node:assert/strict";
import { repoHeader, formatRelease, formatReleases, parseReleasesPath } from "../fetch/handlers/github.ts";

test("repoHeader renders the full metadata block the API already returns", () => {
  const header = repoHeader({
    full_name: "udit-001/Collaboration-For-Beginners",
    description: "A Beginner's Guide to Contributing in an Open Source Project.",
    default_branch: "master",
    stargazers_count: 236,
    forks_count: 274,
    language: null,
    license: { spdx_id: "MIT" },
    homepage: "https://udit-001.github.io/Collaboration-For-Beginners/",
    topics: ["hacktoberfest", "good-first-issue"],
    archived: false,
    pushed_at: "2026-09-17T13:45:11Z",
  });
  assert.match(header, /^# udit-001\/Collaboration-For-Beginners$/m);
  assert.match(header, /A Beginner's Guide/);
  assert.match(header, /stars: 236 \| forks: 274 \| language: \? \| default branch: master \| license: MIT/);
  assert.match(header, /^homepage: https:\/\/udit-001\.github\.io/m);
  assert.match(header, /^topics: hacktoberfest, good-first-issue$/m);
  assert.match(header, /^last push: 2026-09-17/m);
  assert.ok(!header.includes("ARCHIVED"));
});

test("repoHeader omits absent fields and flags archived repos", () => {
  const header = repoHeader({
    full_name: "o/r",
    description: null,
    default_branch: "main",
    stargazers_count: 0,
    forks_count: 0,
    language: null,
    license: null,
    homepage: "",
    topics: null,
    archived: true,
    pushed_at: null,
  });
  assert.ok(!header.includes("license:"));
  assert.ok(!header.includes("homepage:"));
  assert.ok(!header.includes("topics:"));
  assert.ok(!header.includes("last push:"));
  assert.match(header, /^ARCHIVED$/m);
});

test("repoHeader skips meaningless license placeholders (NOASSERTION, OTHER)", () => {
  const base = {
    full_name: "o/r",
    description: null,
    default_branch: "main",
    stargazers_count: 1,
    forks_count: 0,
    language: null,
    homepage: null,
    topics: null,
    archived: false,
    pushed_at: null,
  };
  for (const spdx of ["NOASSERTION", "OTHER"]) {
    const header = repoHeader({ ...base, license: { spdx_id: spdx } });
    assert.ok(!header.includes("license:"), `${spdx} should not render`);
  }
});

test("formatRelease renders tag, publish date, assets, and release notes", () => {
  const out = formatRelease({
    tag_name: "v3.21.12",
    name: "Cursor 3.21.12",
    published_at: "2026-09-18T03:57:32Z",
    prerelease: false,
    body: "Mirrors official Cursor AppImages.",
    assets: [
      { name: "Cursor-3.21.12-x86_64.AppImage", size: 329_900_000 },
      { name: "Cursor-3.21.12-aarch64.AppImage", size: 301_800_000 },
    ],
  });
  assert.match(out, /^## Cursor 3\.21\.12 \(v3\.21\.12\)$/m);
  assert.match(out, /^published: 2026-09-18T03:57:32Z$/m);
  assert.match(out, /Cursor-3\.21\.12-x86_64\.AppImage \(314\.6 MB\)/);
  assert.match(out, /Cursor-3\.21\.12-aarch64\.AppImage \(287\.8 MB\)/);
  assert.match(out, /Mirrors official Cursor AppImages\./);
  assert.ok(!out.includes("pre-release"));
});

test("formatRelease marks pre-releases and truncates long notes", () => {
  const out = formatRelease({
    tag_name: "v1.0.0-rc1",
    name: null,
    published_at: null,
    prerelease: true,
    body: "x".repeat(3000),
    assets: [],
  });
  assert.match(out, /v1\.0\.0-rc1/); // name falls back to tag
  assert.match(out, /published: unknown \| pre-release/);
  assert.ok(out.includes("[...truncated...]"));
  assert.ok(!out.includes("x".repeat(2001)));
});

test("parseReleasesPath is the single routing decision for /releases URLs", () => {
  assert.deepEqual(parseReleasesPath(["releases"]), { kind: "list" });
  assert.deepEqual(parseReleasesPath(["releases", "latest"]), { kind: "single", apiPath: "latest" });
  assert.deepEqual(parseReleasesPath(["releases", "tag", "v1.2.3"]), { kind: "single", apiPath: "tags/v1.2.3" });
});

test("parseReleasesPath leaves other paths to the plain-page fetch", () => {
  assert.equal(parseReleasesPath(["actions"]), undefined);
  assert.equal(parseReleasesPath(["releases", "atom"]), undefined);
  assert.equal(parseReleasesPath(["releases", "tag"]), undefined); // tag path with no tag
  assert.equal(parseReleasesPath([]), undefined);
});

test("formatReleases joins releases and handles the empty list", () => {
  const empty = formatReleases([]);
  assert.equal(empty, "No releases found.");
  const two = formatReleases([
    { tag_name: "v2", name: null, published_at: null, prerelease: false, body: null, assets: [] },
    { tag_name: "v1", name: null, published_at: null, prerelease: false, body: null, assets: [] },
  ]);
  assert.match(two, /^## v2 \(v2\)$/m);
  assert.match(two, /^## v1 \(v1\)$/m);
  assert.match(two, /---/);
});
