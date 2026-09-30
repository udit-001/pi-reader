// Live smoke test for the papers vertical — asserts the parse seam against
// the REAL OpenAlex API. Skipped by default (network tests in CI are flaky
// and metered); run explicitly when wire drift is suspected:
//
//   PIWEB_LIVE_SMOKE=1 node --test test/papers-live-smoke.test.ts
//
// Why this exists: fixture tests verify what we believe the wire sends —
// they pass even when OpenAlex changes a field name (the normalizer then
// silently omits the key, absent-tolerant, no test fails). This test is the
// only place wire drift surfaces as a failure instead of a silent gap.
// It asserts the minimum viable record — the keys a reading-list pass
// cannot do without — never the full projection, so projection tuning
// doesn't break it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { searchPapers, OPENALEX_FILTER_FAMILIES, OPENALEX_NAME_FALLBACK_FIELD, OPENALEX_CITATION_EDGES, OPENALEX_FILTER_PROBE } from "../search/papers.ts";

const live = process.env.PIWEB_LIVE_SMOKE === "1";

test("live: searchPapers returns the deep-research keys the agent reads off a plain search", { skip: !live }, async () => {
  const { results } = await searchPapers("scikit-learn machine learning", { numResults: 5 });
  assert.ok(results.length > 0, "no results — check connectivity or the backend's status");
  const r = results[0]!;

  // The record core — a row missing any of these cannot be cited.
  for (const key of ["title", "url", "snippet", "doi", "year"] as const) {
    assert.notEqual(r[key], undefined, `record missing ${key} — the wire shape drifted`);
  }

  // The deep-research keys, present on a work that carries them. scikit-learn
  // (W2101234009) is the stable anchor: top hit, fully-populated row, free
  // singleton lookup — the same record the fixture tests were trimmed from.
  assert.equal(r.openalexId, "W2101234009", "anchor work changed — pick a new stable record");
  for (const key of ["fwci", "refs", "related", "citationTrend", "field"] as const) {
    assert.notEqual(r[key], undefined, `deep-research key ${key} missing — projection or normalizer drifted`);
  }
  assert.ok((r.refs?.length ?? 0) > 0, "refs empty — referenced_works projection lost");

  // Authority (PIWEB-27): the same guard for the fields that make a company lab
  // distinguishable from a university. A renamed wire field empties every
  // record silently, so the presence check has to live here.
  for (const key of ["institutions", "venue", "refCount"] as const) {
    assert.notEqual(r[key], undefined, `authority key ${key} missing — projection or normalizer drifted`);
  }
  assert.ok((r.institutions?.length ?? 0) > 0, "institutions empty — authorships.institutions lost");
  const inst = r.institutions![0]!;
  for (const k of ["name", "id", "type", "country", "ror"] as const) {
    assert.notEqual(inst[k], undefined, `institution missing ${k} — the authority mapping drifted`);
  }
  // Dedupe is the invariant that cannot drift falsely: the anchor's raw
  // authorships collapse to unique institutions, whatever their count.
  const names = r.institutions!.map((x) => x.name);
  assert.equal(new Set(names).size, names.length, "institutions came back duplicated — dedupe drifted");
  assert.ok((r.refCount ?? 0) > 0, "refCount empty — referenced_works lost");

  // The entity ids — the two-step filter vocabulary. Each must reach the
  // agent, so a projection or normalizer drop fails here rather than silently
  // narrowing what the agent can filter on.
  assert.notEqual(r.authors?.[0]?.id, undefined, "author id missing — authorships.author.id dropped");
  assert.notEqual(r.institutions?.[0]?.id, undefined, "institution id missing — authorships.institutions.id dropped");
  assert.notEqual(r.venue?.id, undefined, "venue id missing — primary_location.source.id dropped");
  assert.notEqual(r.topic?.id, undefined, "topic id missing — primary_topic.id dropped");

  // Abstracts are genuinely absent for many works in the REST index — the
  // contract is absent-tolerant, so absence here is correct, not drift.
  if (r.content) assert.ok(r.content.length > 0);
});

test("live: a genuinely rejected expression surfaces the API's own complaint", { skip: !live }, async () => {
  // readErrorDetail is the only reader of the wire's {"message": …} body, so a
  // renamed field would degrade every malformed error to "the request was
  // rejected" — silently, everywhere, which is the drift class this file
  // exists to catch. An unknown filter field is a real 400 from the real API.
  await assert.rejects(
    searchPapers("q", { filters: { expression: "publication_yearx:2020" } }),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.match(m, /rejected the query as malformed/, "the 400 stopped reading as malformed");
      assert.match(m, /publication_yearx is not a valid field/, "the API's own complaint stopped arriving — the error body's field name drifted");
      assert.ok(m.length < 600, `the complaint should stay bounded, got ${m.length} chars`);
      return true;
    },
  );
});

test("live: each backend reports the match count behind its page", { skip: !live }, async () => {
  // The envelope prints "showing N of M" off this number, so a renamed wire
  // field (OpenAlex `meta.count`, Europe PMC `hitCount`) would silently drop it
  // everywhere at once. A broad query is the guard: the index matches far more
  // than one page carries.
  const oa = await searchPapers("malaria", { numResults: 3 });
  assert.equal(typeof oa.total, "number", "OpenAlex meta.count stopped arriving");
  assert.ok(oa.total! > oa.results.length, `expected a count above one page, got ${oa.total} for ${oa.results.length} rows`);

  const epmc = await searchPapers("malaria", { index: "europepmc", numResults: 3 });
  assert.equal(typeof epmc.total, "number", "Europe PMC hitCount stopped arriving");
  assert.ok(epmc.total! > epmc.results.length, `expected a count above one page, got ${epmc.total} for ${epmc.results.length} rows`);
});

test("live: a paper already identified comes back as a clause on each adapter", { skip: !live }, async () => {
  // The retired `filters.lookup` mode; its replacement is the identifier
  // constraint, so this is the wire guard for both spellings. The DOI is the
  // anchor: a work whose identifier form the API stops accepting returns an
  // empty page here instead of failing anywhere else.
  const oa = await searchPapers("", { numResults: 5, filters: { expression: "doi:10.1038/nature12373" } });
  assert.equal(oa.results.length, 1, "the identifier clause did not anchor exactly one work");
  assert.equal(oa.results[0]!.doi, "10.1038/nature12373", "the anchored work's DOI drifted");

  // The other clause form the description names — `doi:` and `ids.pmid:` are
  // the two identifier spellings OpenAlex accepts (it has no `ids.pmcid:`: a
  // PMCID filter matches nothing, which is why the description does not name it).
  const pmid = await searchPapers("", { numResults: 5, filters: { expression: "ids.pmid:22955618" } });
  assert.equal(pmid.results.length, 1, "the ids.pmid: clause did not anchor exactly one work");
  assert.equal(pmid.results[0]!.doi, "10.1038/nature11212", "the PMID anchored the wrong work");

  const epmc = await searchPapers('DOI:"10.1038/nature12373"', { index: "europepmc", numResults: 5 });
  assert.equal(epmc.results.length, 1, "Europe PMC's identifier query did not anchor exactly one record");
  assert.equal(epmc.results[0]!.doi, "10.1038/nature12373", "Europe PMC's anchored record drifted");
});

test("live: a multi-seed expression returns rows in one request", { skip: !live }, async () => {
  // The pipe is the API's own or-operator, so expanding two seeds is one
  // request rather than a loop the interface runs (verified live 2026-09-30:
  // 65,591 works cite either anchor).
  const { results } = await searchPapers("", {
    numResults: 5,
    filters: { expression: "cites:W2101234009|W2066783444" },
  });
  assert.ok(results.length > 0, "the pipe or-list returned nothing — the expression path or the filter drifted");
  for (const row of results) {
    for (const key of ["title", "url", "snippet"] as const) {
      assert.notEqual(row[key], undefined, `expression result missing ${key}`);
    }
  }
});

test("live: every filter field the description names is one the API still accepts", { skip: !live }, async () => {
  // The description names a family per field; the API's own catalogue is the
  // source of truth for all 214 it accepts, and the description points at that
  // catalogue rather than copying it. A renamed field would silently narrow
  // what the agent can ask for — this is where that drift fails.
  const res = await fetch("https://api.openalex.org/works?filter=unknown:1&per_page=1");
  const body = (await res.json()) as { message?: string };
  const tail = (body.message ?? "").split("versions of: ")[1] ?? "";
  const catalogue = new Set(tail.split(", ").map((f) => f.trim()));
  assert.ok(catalogue.size > 100, `the API's catalogue did not arrive — got ${catalogue.size} fields`);
  for (const { family, field } of OPENALEX_FILTER_FAMILIES) {
    assert.ok(catalogue.has(field), `family ${family} names ${field}, which the API no longer accepts`);
  }
  assert.ok(catalogue.has(OPENALEX_NAME_FALLBACK_FIELD), `the by-name fallback ${OPENALEX_NAME_FALLBACK_FIELD} is no longer a filter field`);
  for (const { token } of OPENALEX_CITATION_EDGES) {
    assert.ok(catalogue.has(token), `citation edge ${token} is no longer a filter field`);
  }
});

test("live: every study design the description names is one the API still offers", { skip: !live }, async () => {
  // A wrong `study_designs.id` value answers a silent zero, not an error, so
  // the named vocabulary is the only guard: a renamed design would turn the
  // filter into an empty result the agent reads as "no such evidence".
  const evidence = OPENALEX_FILTER_FAMILIES.find((f) => f.family === "evidence");
  assert.ok(evidence && evidence.values && evidence.values.length > 0, "the evidence family lost its value set");
  const res = await fetch("https://api.openalex.org/study-designs?per_page=50");
  const body = (await res.json()) as { results?: Array<{ id?: string }> };
  const offered = new Set((body.results ?? []).map((r) => (r.id ?? "").split("/").pop() ?? ""));
  for (const design of evidence.values) {
    assert.ok(offered.has(design), `study design ${design} is no longer offered`);
  }
});

test("live: every filter operator the grammar names is one the API still accepts", { skip: !live }, async () => {
  // The probe exercises every operator in OPENALEX_FILTER_GRAMMAR; a dropped
  // operator or a renamed field makes the API 400 here instead of silently
  // narrowing what the agent can write. The unit test pins the probe against
  // the grammar; this pins it against the wire.
  const { results } = await searchPapers("", { numResults: 3, filters: { expression: OPENALEX_FILTER_PROBE } });
  assert.ok(results.length > 0, "the operator probe returned nothing — an operator or field drifted");
});

test("live: a cursor enumerates a result set past one page with no duplicates", { skip: !live }, async () => {
  const first = await searchPapers("scikit-learn machine learning", { numResults: 3, filters: { cursor: "*" } });
  assert.ok(first.nextCursor, "no meta.next_cursor returned — OpenAlex pagination drifted");
  const second = await searchPapers("scikit-learn machine learning", {
    numResults: 3,
    filters: { cursor: first.nextCursor },
  });
  assert.ok(second.results.length > 0, "the second page came back empty — cursor lost or stale");
  const firstIds = new Set(first.results.map((x) => x.openalexId));
  for (const r2 of second.results) {
    assert.equal(firstIds.has(r2.openalexId), false, `row ${r2.openalexId} repeated across pages`);
  }
  // The point of the walk: two pages carry more rows than one. A cursor that
  // silently stopped advancing would still pass the no-duplicates check.
  const union = new Set([...first.results, ...second.results].map((x) => x.openalexId));
  assert.ok(union.size > first.results.length, "the second page added no rows — enumeration is not advancing");
});

// The Europe PMC half of the same guard: its walk endpoints page by offset and
// its search endpoint by cursor, and both were verified live on 2026-09-30
// (pageSize 1000 serves, 1001 returns HTTP 200 with zero rows and no hitCount;
// `page` is ignored outright on /search). PMID 32581362 is the stable anchor —
// a 59-entry reference list, long enough to cross a page boundary without
// asking for a page size the tool's ceiling would reject.
test("live: a Europe PMC reference list enumerates past one page by offset", { skip: !live }, async () => {
  const walk = (page: number) => searchPapers("", {
    index: "europepmc",
    numResults: 30,
    page,
    filters: { citationGraph: { seed: "32581362", direction: "citedBy" } },
  });
  const first = await walk(1);
  assert.equal(first.results.length, 30, "the first page came up short — the walk lost its pageSize");
  const second = await walk(2);
  assert.ok(second.results.length > 0, "page 2 is empty — offset paging drifted");
  const firstTitles = new Set(first.results.map((x) => x.title));
  for (const r2 of second.results) {
    assert.equal(firstTitles.has(r2.title), false, `entry "${r2.title}" repeated across pages — page is not reaching the API`);
  }
});

test("live: Europe PMC's search cursor continues the enumeration it opened", { skip: !live }, async () => {
  const first = await searchPapers("malaria", { index: "europepmc", numResults: 5, filters: { cursor: "*" } });
  assert.ok(first.nextCursor, "no nextCursorMark returned — Europe PMC's cursor drifted");
  const second = await searchPapers("malaria", { index: "europepmc", numResults: 5, filters: { cursor: first.nextCursor } });
  assert.ok(second.results.length > 0, "the cursor's second page came back empty");
  const firstUrls = new Set(first.results.map((x) => x.url));
  for (const r2 of second.results) {
    assert.equal(firstUrls.has(r2.url), false, `row ${r2.url} repeated across pages`);
  }
});

test("live: an ordinary Europe PMC search is not handed a cursor", { skip: !live }, async () => {
  // Europe PMC ships nextCursorMark on every search response, cursor mode or
  // not — so this pins the adapter's gate, not the API's shape. Without it
  // every ordinary search prints a Next cursor line and, because a
  // cursor-bearing response is never cached, loses the search cache.
  const plain = await searchPapers("malaria", { index: "europepmc", numResults: 5 });
  assert.equal("nextCursor" in plain, false, "the adapter leaked the wire's always-present cursorMark");
});

// The Europe PMC query-language half of PIWEB-38: synonym expansion is the
// backend's recall lever, and both sorts are the index's rather than the
// fetched page's. Verified live 2026-09-30 — `"heart attack"` returns 54,785
// with synonyms off and 755,190 with them on; `CITED desc` on malaria puts the
// 14,722-citation row first where relevance returns uncited ones.
test("live: Europe PMC's synonym expansion widens the set by an order of magnitude", { skip: !live }, async () => {
  const exact = await searchPapers('"heart attack"', { index: "europepmc", numResults: 5 });
  const expanded = await searchPapers('"heart attack"', { index: "europepmc", numResults: 5, filters: { synonym: true } });
  assert.ok(
    (expanded.total ?? 0) > (exact.total ?? 0),
    `synonym expansion did not widen the set — exact ${exact.total}, expanded ${expanded.total}`,
  );
  assert.ok(
    (expanded.total ?? 0) > 100_000,
    `the order-of-magnitude difference is gone (expanded ${expanded.total}) — the synonym wire changed`,
  );
});

test("live: Europe PMC's sort orders the whole index, not the fetched page", { skip: !live }, async () => {
  const cited = await searchPapers("malaria", { index: "europepmc", numResults: 10, filters: { sort: "citedBy" } });
  const counts = cited.results.map((r) => r.citedBy ?? -1);
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i - 1]! >= counts[i]!, `citedBy sort is not descending at ${i}: ${counts.join(", ")}`);
  }
  assert.ok((counts[0] ?? 0) > 0, "the top row carries no citation count — the sort or the citedByCount field drifted");

  const newest = await searchPapers("malaria", { index: "europepmc", numResults: 10, filters: { sort: "date" } });
  const years = newest.results.map((r) => r.year ?? 0);
  for (let i = 1; i < years.length; i++) {
    assert.ok(years[i - 1]! >= years[i]!, `date sort is not newest-first at ${i}: ${years.join(", ")}`);
  }
});

// The silent repairs PIWEB-40 names are pinned against the real backend. The
// adapter declines these before sending, so each repair is falsifiable only by
// a direct probe: the malformed form returns the same set as the form Europe
// PMC repaired it into.
test("live: Europe PMC's silent repairs are real", { skip: !live }, async () => {
  const count = async (query: string): Promise<number> => {
    const url = "https://www.ebi.ac.uk/europepmc/webservices/rest/search?"
      + new URLSearchParams({ query, pageSize: "1", resultType: "idlist", format: "json" });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const body = (await res.json()) as { hitCount?: number };
        if (typeof body.hitCount === "number") return body.hitCount;
      } catch { /* Europe PMC throws transient 502/503 — retry */ }
    }
    return -1;
  };

  const malaria = await count("malaria");
  const and = await count("malaria AND tuberculosis");
  const or = await count("malaria OR tuberculosis");
  assert.ok(malaria > 0 && and > 0 && or > and, `controls did not separate: ${malaria}/${and}/${or}`);

  const repairs: Array<[string, number, string]> = [
    ["(malaria OR tuberculosis", and, "unclosed parenthesis reads as AND"],
    ["malaria)", malaria, "unmatched close is discarded"],
    ["malaria AND ()", malaria, "empty parentheses are discarded"],
    ["malaria AND AND tuberculosis", and, "doubled AND collapses"],
    ["malaria OR OR tuberculosis", and, "doubled OR reads as AND"],
    ["malaria NOT NOT tuberculosis", and, "doubled NOT reads as AND"],
    ["AND malaria", malaria, "leading AND is discarded"],
    ["malaria AND", malaria, "trailing AND is discarded"],
    ["malaria NOT", malaria, "trailing NOT is discarded"],
  ];
  for (const [query, expected, why] of repairs) {
    assert.equal(await count(query), expected, `${why}: "${query}"`);
  }

  // The unclosed quote drops the phrase and searches the words loosely, so the
  // two forms separate — the reason the fault is declined rather than sent.
  const phrase = await count('TITLE:"heart attack"');
  const loose = await count("TITLE:heart attack");
  assert.ok(phrase > 0 && loose > phrase, `phrase/loose forms did not separate: ${phrase}/${loose}`);
  assert.equal(await count('TITLE:"heart attack'), loose, "unclosed quote no longer searches as loose terms");

  // The unrecognised-prefix drop the error contract names: the typo returns a
  // count of its own, not the query's.
  assert.equal(await count("AUTHR:Venter"), 0, "the typo'd prefix no longer drops to zero");
  assert.ok(await count("AUTH:Venter") > 0, "the correct prefix no longer returns a set");

  // The sort decline's premise: an invalid sort fails on the wire as a 5xx,
  // which would read as an outage rather than an argument error.
  const badSort = await fetch("https://www.ebi.ac.uk/europepmc/webservices/rest/search?"
    + new URLSearchParams({ query: "malaria", pageSize: "1", resultType: "idlist", format: "json", sort: "bogus" }));
  assert.equal(badSort.ok, false, "an invalid sort no longer fails on the wire — the sort decline's premise changed");
});

// PIWEB-33's identifiers-only tier: the cheap page of a large enumeration. The
// wire returns source-scoped ids only, and the tier is the search endpoint's —
// the walk routes ignore resultType, so the adapter declines it there.
// PIWEB-24 story 4: rank by field-normalized impact rather than raw citation
// count, so a slow field's hub does not outrank a young paper's hit. The
// ordering is only useful if the wire honours it, and only trustworthy if the
// rows arrive in that order.
test("live: the field-normalized ordering ranks by fwci, not by raw citations", { skip: !live }, async () => {
  const { results } = await searchPapers("CRISPR", { numResults: 5, filters: { sort: "fwci" } });
  assert.ok(results.length > 1, "the fwci ordering returned too few rows to compare");
  const fwcis = results.map((r) => r.fwci);
  assert.ok(fwcis.every((f) => f !== undefined), "a row carried no fwci — the projection or the sort drifted");
  for (let i = 1; i < fwcis.length; i++) {
    assert.ok(fwcis[i - 1]! >= fwcis[i]!, `fwci ordering broke at row ${i}: ${fwcis[i - 1]} then ${fwcis[i]}`);
  }
  // The point of the ordering: it is not the citation ranking. If these ever
  // coincide, the backend started ignoring `sort=fwci:desc` and answering with
  // the relevance page, which the descending check above cannot detect.
  const { results: byCitations } = await searchPapers("CRISPR", { numResults: 5, filters: { sort: "citedBy" } });
  assert.notDeepEqual(results.map((r) => r.url), byCitations.map((r) => r.url), "the fwci ordering returned the citation ordering");
});

// PIWEB-32 AC 12: a citation result set pages like any other works query. The
// adapter used to drop `filters.cursor` on the walk leg, so a 807-row `cites:`
// set was capped at one page with no way to ask for the next.
test("live: an OpenAlex citation walk pages with the agent's cursor", { skip: !live }, async () => {
  const first = await searchPapers("", {
    numResults: 3,
    filters: { citationGraph: { seed: "W3161425918" }, cursor: "*" },
  });
  assert.ok(first.results.length > 0, "the walk's first page came back empty");
  assert.ok(first.nextCursor, "no meta.next_cursor on a citation walk — the cursor was dropped again");
  const second = await searchPapers("", {
    numResults: 3,
    filters: { citationGraph: { seed: "W3161425918" }, cursor: first.nextCursor },
  });
  assert.ok(second.results.length > 0, "the walk's second page came back empty — cursor lost or stale");
  const seen = new Set(first.results.map((r) => r.openalexId));
  for (const r of second.results) {
    assert.equal(seen.has(r.openalexId), false, `row ${r.openalexId} repeated across walk pages`);
  }
});

test("live: a Europe PMC search enumerates identifiers-only, past one page", { skip: !live }, async () => {
  const first = await searchPapers("malaria", {
    index: "europepmc",
    numResults: 5,
    filters: { idsOnly: true, cursor: "*" },
  });
  assert.equal(first.results.length, 5, "the ids-only page came up short — pageSize did not ride the request");
  for (const r of first.results) {
    assert.ok(r.europepmcId, "an ids-only row carried no id — resultType=idlist drifted");
    assert.ok(r.europepmcSource, "an ids-only row carried no source");
    assert.equal(r.title, "", "an ids-only row carried a title — the lite record leaked back in");
    assert.equal("venue" in r, false, "an ids-only row carried a heavy field");
  }
  assert.ok(first.nextCursor, "no cursor on an ids-only enumeration — the tier must compose with the cursor");
  const second = await searchPapers("malaria", {
    index: "europepmc",
    numResults: 5,
    filters: { idsOnly: true, cursor: first.nextCursor },
  });
  const seen = new Set(first.results.map((r) => r.europepmcId));
  for (const r of second.results) {
    assert.equal(seen.has(r.europepmcId), false, `${r.europepmcId} repeated across pages — the cursor is not advancing`);
  }
});

// PIWEB-36: the core request is what supplies affiliations, ORCIDs, the work
// type and the abstract — the lite form carried none of them. A renamed wire
// field empties every record silently, so the presence check lives here.
test("live: Europe PMC core records carry the authority fields", { skip: !live }, async () => {
  const { results } = await searchPapers("CRISPR base editing", { index: "europepmc", numResults: 5 });
  assert.ok(results.length > 0, "no Europe PMC rows");
  const withAffiliations = results.find((r) => (r.institutions?.length ?? 0) > 0);
  assert.ok(withAffiliations, "no record carried affiliations — the core request or the authorList mapping drifted");
  assert.ok(
    withAffiliations!.institutions!.every((i) => i.name.length > 0),
    "an affiliation entry arrived with no name",
  );
  assert.ok(results.some((r) => r.type !== undefined), "no record carried a work type — pubTypeList drifted");
  assert.ok(results.some((r) => r.venue?.type !== undefined), "no venue kind arrived — europePmcVenueType drifted");
  assert.ok(results.some((r) => typeof r.content === "string" && r.content.length > 0), "no abstract arrived — abstractText drifted or the request went back to lite");
  assert.ok(results.some((r) => (r.venue?.name ?? "").length > 0), "no venue arrived — journalInfo.journal.title stopped parsing");
});

// PIWEB-37: the subject and provenance block rides the same core record. MeSH
// headings, compounds and a funding list are absent on plenty of records
// (patents, preprints, editorials), so the anchor is a paper that carries all
// three — and a renamed wire field empties every record silently, which is the
// drift this guards.
test("live: Europe PMC core records carry the subject and provenance block", { skip: !live }, async () => {
  const { results } = await searchPapers('DOI:"10.1038/nature12373"', { index: "europepmc", numResults: 1 });
  assert.equal(results.length, 1, "the anchored record did not come back");
  const r = results[0]!;
  assert.ok((r.subjects?.length ?? 0) > 0, "no subject tags — meshHeadingList drifted or the request went back to lite");
  assert.ok(r.subjects!.some((s) => s.major === true), "no subject carried the major flag — the meshHeadingList flags drifted");
  assert.ok(r.subjects!.every((s) => s.term.length > 0), "a subject tag arrived with no term");
  const terms = r.subjects!.map((s) => s.term);
  assert.equal(new Set(terms).size, terms.length, "subject tags came back duplicated — dedupe drifted");
  assert.ok((r.compounds?.length ?? 0) > 0, "no compounds — chemicalList drifted");
  assert.ok((r.funding?.length ?? 0) > 0, "no funding — grantsList drifted");
  assert.ok(r.funding!.every((g) => g.agency.length > 0), "a grant arrived with no agency");
  // The full-text candidates now choose the row's URL, so a record with a free
  // PMC copy must point at that copy rather than at the doi.org resolution.
  assert.equal(r.url, "https://europepmc.org/article/PMC4221854", "the free PMC copy no longer wins the URL choice");
});

// The matcher table names two wire parameters, each with a signature that
// survives a rename check: a wildcard is accepted only by `search.exact`, and
// the 50-result cap belongs to `search.semantic` alone. A rename would silently
// fall back to the stemmed default and answer both wrongly.
test("live: both search matchers the table names reach the wire", { skip: !live }, async () => {
  const exact = await searchPapers("machin*", { filters: { searchMode: "exact" } });
  assert.ok(exact.results.length > 0, "search.exact returned nothing — the matcher drifted");
  await assert.rejects(
    searchPapers("machin*", {}),
    (err: unknown) => /exact|stemmed/i.test((err as Error).message),
    "a wildcard outside exact mode was not rejected — the default matcher drifted",
  );
  await assert.rejects(
    searchPapers("drug toxicity prediction", { numResults: 100, filters: { searchMode: "semantic" } }),
    (err: unknown) => /50/.test((err as Error).message),
    "semantic's result cap did not answer — the matcher drifted to the stemmed default",
  );
});
