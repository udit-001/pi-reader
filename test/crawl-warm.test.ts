// crawl-warm.test.ts — pins the cold-start decisions from
// docs/specs/crawl-cold-start.md, as revised after the live end-user test:
// the note is gated on a persisted once-per-machine marker, NOT on a
// stopwatch (a fast first download must still announce). Plus the degrade
// notice's metastate (degrade is real only when uv was available).

import { test } from "node:test";
import assert from "node:assert/strict";
import { crawlWarmFlow, warmProbeCommand, WARM_TIMEOUT_MS } from "../fetch/crawl-uv.ts";
import { withCrawlDegradeNotice, type CrawlResult } from "../fetch/crawl.ts";

function makeResult(source: CrawlResult["source"]): CrawlResult {
  return {
    source,
    capped: false,
    found: 2,
    pages: [
      { url: "https://a.test/", title: "A", content: "alpha", error: null },
      { url: "https://b.test/", title: "B", content: "beta", error: null },
    ],
  };
}

test("warm: probe command is argv-array with --with trafilatura", () => {
  const plan = warmProbeCommand("/opt/uv/bin/uvx");
  assert.equal(plan.length, 6);
  assert.equal(plan[0], "/opt/uv/bin/uvx");
  assert.deepEqual(plan.slice(1, 3), ["--with", "trafilatura"]);
  // No shell string: every slot is a single argument.
  assert.ok(plan.every((slot) => !slot.includes(" && ")));
});

test("warm: marker set (not first ever) — silence, runs nothing", async () => {
  let ran = 0;
  let notes = 0;
  let warmed = 0;
  await crawlWarmFlow(
    warmProbeCommand("uvx"),
    false, // marker set — already announced on this machine
    async () => { ran++; },
    () => { notes++; },
    () => { warmed++; },
  );
  assert.equal(ran, 0);
  assert.equal(notes, 0);
  assert.equal(warmed, 0);
});

test("warm: first ever — note always fires, even though the download may be fast", async () => {
  // Regression: the stopwatch gate (5s fast probe) once hid this note from a
  // first-time user whose 7MB download finished in under 5s. The marker is
  // the gate now — note fires unconditionally on firstEver.
  const notes: string[] = [];
  let warmed = 0;
  await crawlWarmFlow(
    warmProbeCommand("uvx"),
    true,
    async () => {}, // fast success
    (n) => notes.push(n),
    () => { warmed++; },
  );
  assert.deepEqual(notes, ["Downloading crawl backend (trafilatura) — one-time"]);
  assert.equal(warmed, 1);
});

test("warm: full text pinned — user-facing copy is contractual", async () => {
  const notes: string[] = [];
  await crawlWarmFlow(warmProbeCommand("uvx"), true, async () => {}, (n) => notes.push(n));
  assert.match(notes[0]!, /^Downloading crawl backend \(trafilatura\) — one-time$/);
});

test("warm: budget failure stays silent, marker NOT set — later crawl announces again", async () => {
  const notes: string[] = [];
  let warmed = 0;
  await crawlWarmFlow(
    warmProbeCommand("uvx"),
    true,
    async (_args, timeout) => {
      assert.equal(timeout, WARM_TIMEOUT_MS); // download rides the warm budget, not the crawl's
      throw new Error("network down");
    },
    (n) => notes.push(n),
    () => { warmed++; },
  );
  // The wait note fired (it was real); onWarmed did not (still unwarmed).
  assert.equal(notes.length, 1);
  assert.equal(warmed, 0);
});

test("degrade: notice appended only when uv was available and source is js", () => {
  const uvRan = makeResult("links");
  const noticed = withCrawlDegradeNotice(uvRan, true);
  assert.deepEqual(noticed.pages, uvRan.pages); // uv adapter result: untouched

  const jsDegraded = withCrawlDegradeNotice(makeResult("js"), true);
  assert.match(jsDegraded.pages[jsDegraded.pages.length - 1]!.content, /\[crawl: uv backend/);
  assert.match(jsDegraded.pages[jsDegraded.pages.length - 1]!.content, /retry after it completes/);
  // Notice is additive — the page body survives.
  assert.match(jsDegraded.pages[0]!.content, /^alpha$/);

  // uv was never available: js is the chosen adapter, not a degrade.
  const jsNormal = withCrawlDegradeNotice(makeResult("js"), false);
  assert.deepEqual(jsNormal.pages, makeResult("js").pages);
});
