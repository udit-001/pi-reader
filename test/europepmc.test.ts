// Tests for the Europe PMC papers backend — index: "europepmc".
// Pure seams only: flag/author parsing, URL/OA choice, the normalizer (same
// PaperRecord shape as OpenAlex), request params, and the adapter's deps
// flow. Fixture is a trimmed live capture (2026-09-25,
// europepmc/webservices/rest/search?query=CRISPR base editing). No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isFlagY,
  parseAuthors,
  parsePubYear,
  chooseRecordUrl,
  chooseOaUrl,
  normalizeEuropePmcResults,
  buildEuropePmcParams,
  buildEuropePmcFilterQuery,
  isRetractedPubType,
  mergeRetractionClause,
  RETRACTION_EXCLUSION_CLAUSE,
  EUROPEPMC_PAGE_SIZE_MAX,
  EUROPEPMC_OPERATORS,
  EUROPEPMC_OPERATOR_LISTING,
  europePmcSortValue,
  unrecognisedEuropePmcOperators,
  europePmcQueryFaults,
  pubTypes,
  primaryPubType,
  parseAffiliations,
  parseOrcids,
  europePmcVenueType,
  retractionNoticeUrl,
  parseDataAvailability,
  parseFullTextUrls,
  parseSubjects,
  parseCompounds,
  parseFunding,
  isFreeFullTextCopy,
  planEuropePmcWalk,
  searchEuropePmc,
  type EuropePmcResult,
  type EuropePmcResponse,
} from "../search/europepmc.ts";
import { PaperError } from "../search/paper-backend.ts";

// ── Fixtures — trimmed live capture (2026-09-25) ─────────────────────────────

// PubMed record: PMID, doi, journal info, closed access, no PMC copy.
const PUBMED_REC: EuropePmcResult = {
  id: "42527584",
  source: "MED",
  pmid: "42527584",
  doi: "10.1038/s41551-026-01747-y",
  title: "In vivo CRISPR base editing for treatment of Huntington's disease.",
  authorString: "Shirguppe S, Gapinske M, Swami D, Gaj T, Perez-Pinera P.",
  journalTitle: "Nat Biomed Eng",
  journalInfo: { journal: { title: "Nature Biomedical Engineering" } },
  pubYear: "2026",
  pubType: "journal article",
  isOpenAccess: "N",
  inEPMC: "N",
  inPMC: "N",
  citedByCount: 0,
  firstPublicationDate: "2026-07-29",
};

// PMC record: full text in Europe PMC, OA tag Y, citedByCount present.
const PMC_REC: EuropePmcResult = {
  id: "42549577",
  source: "MED",
  pmid: "42549577",
  pmcid: "PMC13434336",
  doi: "10.1093/nar/gkag769",
  title: "BASELINE: a CRISPR base editing platform for mammalian-scale single-cell lineage tracing.",
  authorString: "Winter E, Emiliani F, McKenna A.",
  journalTitle: "Nucleic Acids Res",
  journalInfo: { journal: { title: "Nucleic Acids Research" } },
  pubYear: "2026",
  pubType: "research-article; journal article",
  isOpenAccess: "Y",
  inEPMC: "Y",
  inPMC: "Y",
  citedByCount: 3,
  firstPublicationDate: "2026-07-01",
};

// A patent-style record: no doi, no journal — Europe PMC record page by
// source+id is the only URL.
const PATENT_REC: EuropePmcResult = {
  id: "3540589",
  source: "PAT",
  title: "Base editing of genomic DNA",
  authorString: "Liu D.",
  pubYear: "2025",
  isOpenAccess: "Y",
  inEPMC: "Y",
  citedByCount: 0,
};

// A citation-walk entry (what /citations and /references return): abbreviated
// journal, numeric pubYear, no doi/pmcid/openAccess flags.
const WALK_REC: EuropePmcResult = {
  source: "MED",
  id: "42725849",
  title: "Integrative Long-Read Multi-Omics of a Patient With GPI Deficiency.",
  authorString: "Stolarek I, Delimata-Raczek J, Figlerowicz M.",
  journalAbbreviation: "J Cell Mol Med",
  pubYear: 2026,
  citedByCount: 0,
};

const RESPONSE: EuropePmcResponse = {
  hitCount: 53631,
  resultList: { result: [PUBMED_REC, PMC_REC, PATENT_REC] },
};

// ── isFlagY / parseAuthors — the shape-shifting primitives ───────────────────

test("isFlagY reads only the Y flag", () => {
  assert.equal(isFlagY("Y"), true);
  assert.equal(isFlagY(undefined), false);
  assert.equal(isFlagY("N"), false);
});

test("parseAuthors splits the comma string and drops empties", () => {
  assert.deepEqual(parseAuthors("Winter E, Emiliani F, Cook A"), ["Winter E", "Emiliani F", "Cook A"]);
  assert.deepEqual(parseAuthors("Liu D."), ["Liu D."]);
  assert.equal(parseAuthors(undefined), undefined);
  assert.equal(parseAuthors(""), undefined);
});

// ── chooseRecordUrl / chooseOaUrl — the two URL decisions ─────────────────────

test("europepmc chooseRecordUrl prefers the PMC copy, keeps doi.org for records without one, record page last", () => {
  assert.equal(chooseRecordUrl(PMC_REC), "https://europepmc.org/article/PMC13434336");
  // Closed PubMed record: no copy exists, the doi.org resolution stands.
  assert.equal(chooseRecordUrl(PUBMED_REC), "https://doi.org/10.1038/s41551-026-01747-y");
  assert.equal(chooseRecordUrl(PATENT_REC), "https://europepmc.org/article/PAT/3540589");
  assert.equal(chooseRecordUrl({}), null);
});

test("europepmc chooseOaUrl returns the PMC full-text body only when a copy exists", () => {
  assert.equal(chooseOaUrl(PMC_REC), "https://europepmc.org/article/PMC13434336");
  assert.equal(chooseOaUrl(PUBMED_REC), null);
  // inPMC=Y without inEPMC=Y → the NCBI copy.
  assert.equal(
    chooseOaUrl({ pmcid: "PMC123", inPMC: "Y" }),
    "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC123/",
  );
  // An OA-flagged record with no id at all — no URL anchor, no oaUrl.
  assert.equal(chooseOaUrl({ inEPMC: "Y" }), null);
});

// ── normalizeEuropePmcResults — same record shape as OpenAlex ─────────────────

test("europepmc normalizer maps the same flat keys the OpenAlex backend emits", () => {
  const [pubmed, pmc] = normalizeEuropePmcResults([PUBMED_REC, PMC_REC]);
  assert.deepEqual(
    { title: pmc!.title, url: pmc!.url, year: pmc!.year, authors: pmc!.authors, venue: pmc!.venue, citedBy: pmc!.citedBy, doi: pmc!.doi, oaUrl: pmc!.oaUrl },
    {
      title: "BASELINE: a CRISPR base editing platform for mammalian-scale single-cell lineage tracing.",
      url: "https://europepmc.org/article/PMC13434336",
      year: 2026,
      authors: ["Winter E", "Emiliani F", "McKenna A."],
      venue: "Nucleic Acids Research",
      citedBy: 3,
      doi: "10.1093/nar/gkag769",
      oaUrl: "https://europepmc.org/article/PMC13434336",
    },
  );
  // Closed record: year is a number, oaUrl absent, snippet says closed.
  assert.equal(pubmed!.year, 2026);
  assert.equal("oaUrl" in pubmed!, false);
});

test("europepmc normalizer builds the snippet from the shared builder — venue before journalTitle", () => {
  const [pubmed, pmc, patent] = normalizeEuropePmcResults([PUBMED_REC, PMC_REC, PATENT_REC]);
  assert.equal(
    pubmed!.snippet,
    "Nature Biomedical Engineering · 2026 · 0 citations · closed · Shirguppe S et al.",
  );
  assert.equal(
    pmc!.snippet,
    "Nucleic Acids Research · 2026 · 3 citations · open · Winter E et al.",
  );
  assert.equal(patent!.snippet, "2025 · 0 citations · open · Liu D.");
});

test("europepmc normalizer falls back to journalTitle when journalInfo carries no title", () => {
  const [r] = normalizeEuropePmcResults([{
    ...PUBMED_REC,
    journalInfo: undefined,
    doi: undefined,
    pmcid: undefined,
  }]);
  assert.equal(r!.venue, "Nat Biomed Eng");
  assert.equal(r!.url, "https://europepmc.org/article/MED/42527584");
});

test("europepmc normalizer tolerates missing fields — no invented keys", () => {
  const [r] = normalizeEuropePmcResults([{ title: "bare", id: "1", source: "MED" }]);
  assert.equal("year" in r!, false);
  assert.equal("authors" in r!, false);
  assert.equal("venue" in r!, false);
  assert.equal("citedBy" in r!, false);
  assert.equal("doi" in r!, false);
  assert.equal("oaUrl" in r!, false);
});

test("europepmc normalizer drops records with no record URL — no url, no action", () => {
  const results = normalizeEuropePmcResults([{ title: "no url anywhere" }, PATENT_REC]);
  assert.deepEqual(results.map((r) => r.title), [PATENT_REC.title]);
});

test("europepmc normalizer returns an empty array for empty input", () => {
  assert.deepEqual(normalizeEuropePmcResults([]), []);
});

// ── authority fields (PIWEB-36) — resultType=core ─────────────────────────────

// A core record: every author's affiliations, an aggregate ORCID list, the
// publication-type list, the nested journal block, language, status, abstract,
// evidence flags, and full-text copies. Trimmed live capture (2026-09-30).
const CORE_REC: EuropePmcResult = {
  id: "42527584",
  source: "MED",
  pmid: "42527584",
  doi: "10.1038/s41551-026-01747-y",
  title: "In vivo CRISPR base editing for treatment of Huntington's disease.",
  authorString: "Shirguppe S, Gapinske M, Swami D.",
  journalInfo: { journal: { title: "Nature biomedical engineering" } },
  journalTitle: "Nat Biomed Eng",
  pubYear: "2026",
  pubTypeList: { pubType: ["Journal Article"] },
  authorList: {
    author: [
      { fullName: "Shirguppe S", authorAffiliationDetailsList: { authorAffiliation: [{ affiliation: "Dept of Bioengineering, UIUC." }] } },
      { fullName: "Gapinske M", authorAffiliationDetailsList: { authorAffiliation: [
        { affiliation: "Dept of Bioengineering, UIUC." },
        { affiliation: "Carl R. Woese Institute for Genomic Biology, UIUC." },
      ] } },
    ],
  },
  authorIdList: { authorId: [
    { type: "ORCID", value: "0000-0001-6004-9664" },
    { type: "ORCID", value: "0000-0001-6004-9664" },
    { type: "Other", value: "not-an-orcid" },
  ] },
  language: "eng",
  publicationStatus: "aheadofprint",
  abstractText: "Huntington's disease is a fatal neurodegenerative disorder.",
  hasData: "N",
  hasSuppl: "Y",
  hasPDF: "Y",
  fullTextUrlList: { fullTextUrl: [{ site: "DOI", url: "https://doi.org/10.1038/s41551-026-01747-y", availability: "Subscription required" }] },
  isOpenAccess: "N",
  inEPMC: "N",
  citedByCount: 0,
};

const RETRACTED_CORE: EuropePmcResult = {
  id: "42550576",
  source: "MED",
  title: "Retracted trial.",
  authorString: "Doe J.",
  pubYear: "2026",
  pubTypeList: { pubType: ["Retracted Publication", "Editorial"] },
  commentCorrectionList: { commentCorrection: [{ type: "Retraction in", source: "MED", id: "42715445", reference: "J Psychosoc Nurs. doi: 10.3928/02793695-20260817-01." }] },
};

const PREPRINT_CORE: EuropePmcResult = {
  id: "PPR123456",
  source: "PPR",
  title: "Preprint: base editing.",
  authorString: "Roe R.",
  pubYear: "2025",
  pubTypeList: { pubType: ["Preprint"] },
  isOpenAccess: "Y",
};

// The subject/provenance block: MeSH headings (a heading-level major, a
// qualifier-starred one, and incidental ones), compounds with a registry
// number and the backend's "0" sentinel, and the funding block. Trimmed live
// capture (2026-09-30, DOI:"10.1038/nature12373").
const SUBJECT_CORE: EuropePmcResult = {
  id: "24553135",
  source: "MED",
  pmid: "24553135",
  pmcid: "PMC4221854",
  doi: "10.1038/nature12373",
  title: "Nanometre-scale thermometry in a living cell.",
  journalTitle: "Nature",
  pubYear: "2013",
  meshHeadingList: { meshHeading: [
    { majorTopic_YN: "N", descriptorName: "Fibroblasts", meshQualifierList: { meshQualifier: [{ majorTopic_YN: "Y", qualifierName: "cytology" }] } },
    { majorTopic_YN: "N", descriptorName: "Humans" },
    { majorTopic_YN: "Y", descriptorName: "Thermometers" },
    { majorTopic_YN: "N", descriptorName: "Nanodiamonds", meshQualifierList: { meshQualifier: [{ majorTopic_YN: "Y", qualifierName: "chemistry" }] } },
    { majorTopic_YN: "N", descriptorName: "Humans" },
  ] },
  chemicalList: { chemical: [
    { name: "Gold", registryNumber: "7440-57-5" },
    { name: "Nanodiamonds", registryNumber: "0" },
    { name: "Nitrogen", registryNumber: "N762921K75" },
  ] },
  grantsList: { grant: [
    { agency: "Swiss National Science Foundation", grantId: "143918", orderIn: 0 },
    { agency: "NIH HHS", acronym: "OD", grantId: "5DP1OD003893-03", orderIn: 0 },
    { agency: "NIH HHS", acronym: "OD", grantId: "5DP1OD003893-03", orderIn: 1 },
    { agency: "NIH HHS", acronym: "HG" },
  ] },
  fullTextUrlList: { fullTextUrl: [
    { site: "DOI", url: "https://doi.org/10.1038/nature12373", availability: "Subscription required" },
    { site: "Europe_PMC", url: "https://europepmc.org/articles/PMC4221854", availability: "Free" },
  ] },
  isOpenAccess: "Y",
  inEPMC: "Y",
  inPMC: "Y",
  citedByCount: 3859,
};

test("pubTypes reads the core list and the lite string alike", () => {
  assert.deepEqual(pubTypes({ pubTypeList: { pubType: ["Journal Article", "Editorial"] } }), ["Journal Article", "Editorial"]);
  assert.deepEqual(pubTypes({ pubType: "journal article; editorial" }), ["journal article", "editorial"]);
  assert.deepEqual(pubTypes({}), []);
});

test("primaryPubType picks the work type, not the retraction marker", () => {
  assert.equal(primaryPubType(["Retracted Publication", "Editorial"]), "Editorial");
  assert.equal(primaryPubType(["Journal Article"]), "Journal Article");
  assert.equal(primaryPubType([]), undefined);
});

test("parseAffiliations lists every author's institutions, deduped, both of a dual-affiliated author", () => {
  assert.deepEqual(parseAffiliations(CORE_REC)!.map((i) => i.name), [
    "Dept of Bioengineering, UIUC.",
    "Carl R. Woese Institute for Genomic Biology, UIUC.",
  ]);
  // The fallback: no author list, the flat corresponding-author affiliation.
  assert.deepEqual(parseAffiliations({ affiliation: "Harvard Medical School." }), [{ name: "Harvard Medical School." }]);
  assert.equal(parseAffiliations({}), undefined);
});

test("parseOrcids keeps ORCID identifiers only, deduped", () => {
  assert.deepEqual(parseOrcids(CORE_REC), ["0000-0001-6004-9664"]);
  assert.equal(parseOrcids({}), undefined);
});

test("europePmcVenueType: preprints are repositories, a journal is a journal, neither is absent", () => {
  assert.equal(europePmcVenueType({ source: "PPR" }, []), "repository");
  assert.equal(europePmcVenueType({}, ["Preprint"]), "repository");
  assert.equal(europePmcVenueType({ journalTitle: "Nature" }, ["Journal Article"]), "journal");
  assert.equal(europePmcVenueType({ source: "PAT" }, ["Patent"]), undefined);
});

test("retractionNoticeUrl prefers the notice record, then a DOI in the reference", () => {
  assert.equal(
    retractionNoticeUrl({ commentCorrectionList: { commentCorrection: [{ type: "Retraction in", source: "MED", id: "42715445" }] } }),
    "https://europepmc.org/article/MED/42715445",
  );
  assert.equal(
    retractionNoticeUrl({ commentCorrectionList: { commentCorrection: [{ type: "Retraction in", reference: "10.1016/j.jse.2026.06.002" }] } }),
    "https://doi.org/10.1016/j.jse.2026.06.002",
  );
  assert.equal(retractionNoticeUrl({}), undefined);
  // The reference is a citation string, so sentence punctuation must not ride
  // into the DOI.
  assert.equal(
    retractionNoticeUrl({ commentCorrectionList: { commentCorrection: [{ type: "Retraction in", reference: "J Psychosoc Nurs. doi: 10.3928/02793695-20260817-01." }] } }),
    "https://doi.org/10.3928/02793695-20260817-01",
  );
});

test("parseDataAvailability and parseFullTextUrls read the core evidence fields", () => {
  assert.deepEqual(parseDataAvailability(CORE_REC), ["supplementary", "pdf"]);
  assert.deepEqual(parseFullTextUrls(CORE_REC), [{ site: "DOI", url: "https://doi.org/10.1038/s41551-026-01747-y", availability: "Subscription required" }]);
  assert.equal(parseDataAvailability({}), undefined);
  assert.equal(parseFullTextUrls({}), undefined);
});

test("europepmc chooseRecordUrl ranks the backend's free full-text copies, never a paywalled one", () => {
  // The backend's own ranked free copy wins when there is no PMC copy to
  // synthesize — the improvement the ranking buys.
  assert.equal(
    chooseRecordUrl({ id: "1", source: "MED", fullTextUrlList: { fullTextUrl: [{ site: "Publisher", url: "https://example.org/paper", availability: "Free" }] } }),
    "https://example.org/paper",
  );
  // A "Subscription required" entry is not a copy the fetch chain can read, so
  // it must not take the publisher tier and outrank the Europe PMC record page.
  assert.equal(
    chooseRecordUrl({ id: "1", source: "MED", fullTextUrlList: { fullTextUrl: [{ site: "Publisher", url: "https://paywall.example.org/paper", availability: "Subscription required" }] } }),
    "https://europepmc.org/article/MED/1",
  );
  // The synthesized PMC copy keeps the top tier over a free publisher copy.
  assert.equal(
    chooseRecordUrl({ id: "1", source: "MED", pmcid: "PMC1", fullTextUrlList: { fullTextUrl: [{ site: "Europe_PMC", url: "https://europepmc.org/articles/PMC1", availability: "Open access" }] } }),
    "https://europepmc.org/article/PMC1",
  );
  // The live record's shape: a free copy beside a subscription DOI.
  assert.equal(chooseRecordUrl(SUBJECT_CORE), "https://europepmc.org/article/PMC4221854");
});

test("isFreeFullTextCopy vouches only for a copy the backend marked readable", () => {
  // Verified live 2026-09-30: all 75 entries in a sampled page carried a
  // marker, so an unmarked entry is not the backend saying "free".
  assert.equal(isFreeFullTextCopy({ site: "Europe_PMC", url: "https://europepmc.org/articles/PMC1", availability: "Free" }), true);
  assert.equal(isFreeFullTextCopy({ site: "Europe_PMC", url: "https://europepmc.org/articles/PMC1", availability: "Open access" }), true);
  assert.equal(isFreeFullTextCopy({ site: "DOI", url: "https://doi.org/10.1/x", availability: "Subscription required" }), false);
  assert.equal(isFreeFullTextCopy({ site: "Publisher", url: "https://example.org/x" }), false);
});

test("parseSubjects reads the curated vocabulary, starring a heading when it or a qualifier says major", () => {
  assert.deepEqual(parseSubjects(SUBJECT_CORE), [
    // Wire order preserved and the duplicated "Humans" collapsed. The star sits
    // on the descriptor for one heading and on the qualifier for another, and
    // PubMed sends both shapes — either one makes the term major.
    { term: "Fibroblasts", major: true },
    { term: "Humans" },
    { term: "Thermometers", major: true },
    { term: "Nanodiamonds", major: true },
  ]);
  assert.equal(parseSubjects({}), undefined);
  assert.equal(parseSubjects({ meshHeadingList: { meshHeading: [{ descriptorName: "  " }, { majorTopic_YN: "Y" }] } }), undefined);
});

test("parseCompounds reads names with registry numbers, dropping the backend's \"0\" sentinel", () => {
  assert.deepEqual(parseCompounds(SUBJECT_CORE), [
    { name: "Gold", registry: "7440-57-5" },
    { name: "Nanodiamonds" },
    { name: "Nitrogen", registry: "N762921K75" },
  ]);
  assert.equal(parseCompounds({}), undefined);
  assert.equal(parseCompounds({ chemicalList: { chemical: [{ registryNumber: "1" }] } }), undefined);
});

test("parseFunding dedupes the grant list and tolerates a missing identifier or acronym", () => {
  assert.deepEqual(parseFunding(SUBJECT_CORE), [
    { agency: "Swiss National Science Foundation", grantId: "143918" },
    // The same agency legitimately repeats for a different grant, so the dedup
    // key is the whole agency/acronym/grant triple, not the agency.
    { agency: "NIH HHS", grantId: "5DP1OD003893-03", acronym: "OD" },
    { agency: "NIH HHS", acronym: "HG" },
  ]);
  assert.equal(parseFunding({}), undefined);
  // An entry with no agency has nothing to anchor to.
  assert.equal(parseFunding({ grantsList: { grant: [{ grantId: "1" }] } }), undefined);
});

test("the core normalizer rails the subject and provenance block onto the record", () => {
  const [r] = normalizeEuropePmcResults([SUBJECT_CORE]);
  assert.deepEqual(r!.subjects!.filter((s) => s.major === true).map((s) => s.term), ["Fibroblasts", "Thermometers", "Nanodiamonds"]);
  assert.equal(r!.subjects!.length, 4);
  assert.deepEqual(r!.compounds!.map((c) => c.registry), ["7440-57-5", undefined, "N762921K75"]);
  assert.deepEqual(r!.funding!.map((g) => g.agency), ["Swiss National Science Foundation", "NIH HHS", "NIH HHS"]);
});

test("the core normalizer rails authority onto the record", () => {
  const [r] = normalizeEuropePmcResults([CORE_REC]);
  // The nested journal block the lite request never sends.
  assert.equal(r!.venue, "Nature biomedical engineering");
  assert.equal(r!.type, "Journal Article");
  assert.equal(r!.venueType, "journal");
  assert.deepEqual(r!.orcids, ["0000-0001-6004-9664"]);
  assert.deepEqual(r!.institutions!.map((i) => i.name), ["Dept of Bioengineering, UIUC.", "Carl R. Woese Institute for Genomic Biology, UIUC."]);
  assert.equal(r!.language, "eng");
  assert.equal(r!.publicationStatus, "aheadofprint");
  assert.deepEqual(r!.dataAvailability, ["supplementary", "pdf"]);
  assert.equal(r!.content, "Huntington's disease is a fatal neurodegenerative disorder.");
});

test("a retracted core record carries its notice; a preprint reads as a repository", () => {
  const [ret] = normalizeEuropePmcResults([RETRACTED_CORE]);
  assert.equal(ret!.retracted, true);
  assert.equal(ret!.retractionNotice, "https://europepmc.org/article/MED/42715445");
  assert.equal(ret!.type, "Editorial");

  const [pre] = normalizeEuropePmcResults([PREPRINT_CORE]);
  assert.equal(pre!.venueType, "repository");
  assert.equal(pre!.type, "Preprint");
  assert.equal(pre!.retracted, undefined);
});

test("a core record carrying no authority fields invents none", () => {
  const [r] = normalizeEuropePmcResults([{ id: "1", source: "MED", title: "bare" }]);
  for (const k of ["institutions", "orcids", "type", "venueType", "retractionNotice", "language", "publicationStatus", "dataAvailability", "fullTextUrls", "subjects", "compounds", "funding"] as const) {
    assert.equal(k in r!, false, `${k} was invented`);
  }
});

test("the search request rides resultType=core; the walk and the page builder default to lite", () => {
  assert.equal(buildEuropePmcParams("q", 10, {}, { resultType: "core" }).get("resultType"), "core");
  assert.equal(buildEuropePmcParams("q", 10).get("resultType"), null);
});

// ── buildEuropePmcParams — query, format, pageSize ────────────────────────────

test("europepmc params carry the query, json format, and page size", () => {
  const p = buildEuropePmcParams("CRISPR base editing", 10);
  assert.equal(p.get("query"), "CRISPR base editing");
  assert.equal(p.get("format"), "json");
  assert.equal(p.get("pageSize"), "10");
  // An unnamed page size is the API's default, not a sent 1.
  assert.equal(p.get("page"), null);
  assert.equal(p.get("cursorMark"), null);
});

test("europepmc params carry the paging mechanism the endpoint serves — offset or cursor, never both", () => {
  const walk = buildEuropePmcParams("", 30, { page: 2 });
  assert.equal(walk.get("page"), "2");
  assert.equal(walk.get("cursorMark"), null);
  const search = buildEuropePmcParams("malaria", 5, { cursor: "*" });
  assert.equal(search.get("cursorMark"), "*");
  assert.equal(search.get("page"), null);
});

test("the Europe PMC page-size ceiling is the tool's own — above it the API answers a silent empty", () => {
  // Verified live 2026-09-30: pageSize=1000 serves on /search, /references and
  // /citations; 1001 answers HTTP 200 with zero rows and no hitCount, which
  // would read as "no results". index.ts imports this constant as the tool's
  // numResults maximum, so the silent case cannot be requested at all.
  assert.equal(EUROPEPMC_PAGE_SIZE_MAX, 1000);
});

// ── the query language — operator table, validator, synonym, sort ────────────

test("the operator listing and the accepted set are the same set, in both directions", () => {
  // Parsed from the listing's own text, not from the table it was composed
  // from: a token added to the table without reaching the listing fails here.
  const listedTokens = EUROPEPMC_OPERATOR_LISTING.split("; ").map((s) => s.split(" ")[0]!);
  assert.ok(listedTokens.length > 0);
  // listed → accepted: every token the listing names passes the validator.
  for (const token of listedTokens) {
    assert.deepEqual(unrecognisedEuropePmcOperators(`${token}:"x"`), [], `listing names ${token}, validator declined it`);
  }
  // accepted → listed: a token no listing names is declined.
  assert.deepEqual(unrecognisedEuropePmcOperators('NOPE:"x"'), ["NOPE"], "the validator accepted a token no listing names");
  // accepted → listed: every table token actually appears in the listing text.
  for (const { token } of EUROPEPMC_OPERATORS) {
    assert.ok(listedTokens.includes(token), `table token ${token} is missing from the listing`);
  }
});

test("the validator reads field prefixes, not uppercase words inside a quoted value", () => {
  assert.deepEqual(unrecognisedEuropePmcOperators('TITLE:"MALARIA: A REVIEW"'), []);
  assert.deepEqual(unrecognisedEuropePmcOperators('TITLE:"MALARIA: A REVIEW" AND AUTHR:x'), ["AUTHR"]);
});

// ── silent repairs get names (PIWEB-40) — every fault, its own cause ──────────

test("a sound query has no faults — the structure scan does not fire on syntax", () => {
  for (const q of [
    "malaria AND tuberculosis",
    "(malaria OR tuberculosis)",
    "NOT malaria",
    "malaria NOT tuberculosis",
    "malaria AND NOT tuberculosis",
    "malaria OR NOT tuberculosis",
    'TITLE:"MALARIA: A REVIEW" AND AUTH:Venter',
    "PUB_YEAR:[2019 TO 2021]",
    "malaria* AND vaccine?",
  ]) {
    assert.deepEqual(europePmcQueryFaults(q), [], `sound query "${q}" was flagged`);
  }
});

test("the negation form X NOT Y is sound — only same-kind pairs are doubled", () => {
  assert.deepEqual(europePmcQueryFaults("malaria AND NOT tuberculosis"), []);
  assert.deepEqual(europePmcQueryFaults("malaria OR NOT tuberculosis"), []);
  const notNot = europePmcQueryFaults("malaria NOT NOT tuberculosis")[0]!;
  assert.match(notNot, /doubled "NOT NOT"/);
  assert.match(notNot, /reads it as AND/);
  assert.match(europePmcQueryFaults("malaria AND OR tuberculosis")[0]!, /doubled "AND OR"/);
});

test("an unclosed quote names the loose-term repair", () => {
  const [fault] = europePmcQueryFaults('TITLE:"heart attack');
  assert.match(fault!, /unclosed double quote/);
  assert.match(fault!, /separate terms/);
});

test("an unclosed parenthesis names the OR-to-AND flip", () => {
  const [fault] = europePmcQueryFaults("(malaria OR tuberculosis");
  assert.match(fault!, /unclosed parenthesis/);
  assert.match(fault!, /missing close as AND/);
});

test("an unmatched close parenthesis is named", () => {
  assert.match(europePmcQueryFaults("malaria)")[0]!, /unmatched "\)"/);
});

test("empty parentheses are named", () => {
  assert.match(europePmcQueryFaults("malaria AND ()")[0]!, /empty "\(\)"/);
});

test("a doubled OR names the AND it is read as; a doubled AND names the collapse", () => {
  const orFault = europePmcQueryFaults("malaria OR OR tuberculosis")[0]!;
  assert.match(orFault, /doubled "OR OR"/);
  assert.match(orFault, /reads it as AND/);
  const andFault = europePmcQueryFaults("malaria AND AND tuberculosis")[0]!;
  assert.match(andFault, /doubled "AND AND"/);
  assert.match(andFault, /collapses it/);
});

test("a dangling conjunction is named at either end; a leading NOT is sound", () => {
  assert.match(europePmcQueryFaults("malaria AND")[0]!, /ends with "AND"/);
  assert.match(europePmcQueryFaults("malaria NOT")[0]!, /ends with "NOT"/);
  assert.match(europePmcQueryFaults("OR malaria")[0]!, /starts with "OR"/);
  assert.deepEqual(europePmcQueryFaults("NOT malaria"), []);
});

test("the structure scan reads outside quoted values — syntax inside a phrase is data", () => {
  assert.deepEqual(europePmcQueryFaults('TITLE:"A AND B"'), []);
  assert.deepEqual(europePmcQueryFaults('TITLE:"(unclosed"'), []);
});

test("every operator the table names is accepted by the validator", () => {
  const query = EUROPEPMC_OPERATORS.map((o) => `${o.token}:"x"`).join(" AND ");
  assert.deepEqual(unrecognisedEuropePmcOperators(query), []);
});

test("the validator flags a field prefix outside the table, and only that", () => {
  assert.deepEqual(unrecognisedEuropePmcOperators("AUTHR:Venter"), ["AUTHR"]);
  assert.deepEqual(unrecognisedEuropePmcOperators("MESHH:malaria OR TITLE:malaria"), ["MESHH"]);
  // The table itself, booleans, parentheses, wildcards and ranges pass through.
  assert.deepEqual(unrecognisedEuropePmcOperators("malaria AND (vaccine OR vaccine*)"), []);
  assert.deepEqual(unrecognisedEuropePmcOperators("PUB_YEAR:[2019 TO 2021]"), []);
  // Lowercase prose is not a field prefix — EPMC's field convention is upper
  // case, so free text and URLs are not mistaken for operators.
  assert.deepEqual(unrecognisedEuropePmcOperators("see https://example.org/x and note: something"), []);
});

test("the sort mapping is one table, and a key outside it maps to nothing", () => {
  assert.equal(europePmcSortValue("citedBy"), "CITED desc");
  assert.equal(europePmcSortValue("date"), "P_PDATE_D desc");
  assert.equal(europePmcSortValue("bogus"), null);
  assert.equal(europePmcSortValue(undefined), null);
});

test("europepmc params carry the synonym lever and the backend sort only when asked", () => {
  const plain = buildEuropePmcParams("malaria", 10);
  assert.equal(plain.get("synonym"), null);
  assert.equal(plain.get("sort"), null);
  const levered = buildEuropePmcParams("malaria", 10, {}, { synonym: true, sort: "CITED desc" });
  assert.equal(levered.get("synonym"), "true");
  assert.equal(levered.get("sort"), "CITED desc");
});

// ── parsePubYear — numeric walk entries and string search entries ────────────

test("parsePubYear reads both entry shapes, invents nothing", () => {
  assert.equal(parsePubYear(2026), 2026);
  assert.equal(parsePubYear("2026"), 2026);
  assert.equal(parsePubYear("2026-07-01"), 2026);
  assert.equal(parsePubYear(undefined), undefined);
  assert.equal(parsePubYear("soon"), undefined);
});

// ── buildEuropePmcFilterQuery — filters ride inside the query string ──────────

// The retired lookup's replacement on this adapter: an identifier is a clause
// in Europe PMC's own query language, reached through the free-text query —
// verified live on all three forms (2026-09-30): DOI:"10.1038/nature12373" and
// EXT_ID:22955618 each return exactly the anchored record, PMCID:PMC4544277 too.
test("an identifier constraint rides the query language of this adapter — one call, the anchored record", async () => {
  const fetched: string[] = [];
  const deps = depsWith({
    fetchResults: async (params) => {
      fetched.push(params.get("query") ?? "");
      return { hitCount: 1, resultList: { result: [PUBMED_REC] } } as EuropePmcResponse;
    },
  });
  const { results } = await searchEuropePmc("EXT_ID:23812562 AND SRC:MED", {}, deps);
  assert.deepEqual(fetched, [`EXT_ID:23812562 AND SRC:MED AND ${RETRACTION_EXCLUSION_CLAUSE}`]);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.doi, "10.1038/s41551-026-01747-y");
});

test("an identifier matching nothing is the no-results error, not a malformed one", async () => {
  await assert.rejects(
    searchEuropePmc('DOI:"10.9999/nope"', {}, depsWith({
      fetchResults: async () => ({ hitCount: 0, resultList: { result: [] } } as EuropePmcResponse),
    })),
    (err: PaperError) => /returned no results/.test(err.message),
  );
});

// ── buildEuropePmcFilterQuery — filters ride inside the query string ──────────

// PIWEB-35 — the retraction clause folds into the agent's query, and the
// default exclusion is on unless explicitly opted out.
test("isRetractedPubType reads the marker from Europe PMC's ;-separated list", () => {
  assert.equal(isRetractedPubType("retracted publication; editorial"), true);
  assert.equal(isRetractedPubType("letter; retracted publication"), true);
  assert.equal(isRetractedPubType("Retracted Publication"), true);
  assert.equal(isRetractedPubType("journal article"), false);
  assert.equal(isRetractedPubType(undefined), false);
});

test("mergeRetractionClause appends the backend's own clause by default", () => {
  assert.equal(
    mergeRetractionClause("CRISPR base editing"),
    `CRISPR base editing AND ${RETRACTION_EXCLUSION_CLAUSE}`,
  );
  // A filters-only search (empty free text) still excludes server-side.
  assert.equal(mergeRetractionClause(""), RETRACTION_EXCLUSION_CLAUSE);
});

test("mergeRetractionClause never duplicates a clause the agent already wrote", () => {
  const authored = 'CRISPR AND NOT PUB_TYPE:"Retracted Publication"';
  assert.equal(mergeRetractionClause(authored), authored);
  assert.equal(mergeRetractionClause('NOT pub_type:retracted publication'), 'NOT pub_type:retracted publication');
  // An agent that asked FOR the type is not contradicted.
  assert.equal(mergeRetractionClause('PUB_TYPE:"Retracted Publication"'), 'PUB_TYPE:"Retracted Publication"');
});

test("mergeRetractionClause leaves the agent's clauses untouched and honours the opt-in", () => {
  assert.equal(mergeRetractionClause("A AND B", true), "A AND B");
  const authored = 'A AND (B OR C) AND PUB_YEAR:"2023"';
  assert.equal(
    mergeRetractionClause(authored),
    `${authored} AND ${RETRACTION_EXCLUSION_CLAUSE}`,
  );
});

test("europepmc filter query adds the retraction clause plus PUB_YEAR/OPEN_ACCESS conditions", () => {
  assert.equal(
    buildEuropePmcFilterQuery("CRISPR base editing", { year: 2023 }),
    `CRISPR base editing AND ${RETRACTION_EXCLUSION_CLAUSE} AND PUB_YEAR:"2023"`,
  );
  assert.equal(
    buildEuropePmcFilterQuery("CRISPR base editing", { openAccess: true }),
    `CRISPR base editing AND ${RETRACTION_EXCLUSION_CLAUSE} AND OPEN_ACCESS:y`,
  );
});

test("europepmc filter query renders the inclusive year range and joins with AND", () => {
  assert.equal(
    buildEuropePmcFilterQuery("q", { yearRange: [2019, 2021] }),
    `q AND ${RETRACTION_EXCLUSION_CLAUSE} AND (PUB_YEAR:[2019 TO 2021])`,
  );
  assert.equal(
    buildEuropePmcFilterQuery("q", { year: 2023, openAccess: true }),
    `q AND ${RETRACTION_EXCLUSION_CLAUSE} AND PUB_YEAR:"2023" AND OPEN_ACCESS:y`,
  );
});

test("europepmc filter query excludes retracted work on an unconstrained search", () => {
  assert.equal(buildEuropePmcFilterQuery("q"), `q AND ${RETRACTION_EXCLUSION_CLAUSE}`);
  assert.equal(buildEuropePmcFilterQuery("q", {}), `q AND ${RETRACTION_EXCLUSION_CLAUSE}`);
});

test("europepmc filter query drops the exclusion on the explicit opt-in", () => {
  assert.equal(buildEuropePmcFilterQuery("q", { includeRetracted: true }), "q");
  assert.equal(
    buildEuropePmcFilterQuery("q", { includeRetracted: true, year: 2023 }),
    'q AND PUB_YEAR:"2023"',
  );
});

test("europepmc filter query stands alone when the query is empty", () => {
  assert.equal(
    buildEuropePmcFilterQuery("", { year: 2023 }),
    `${RETRACTION_EXCLUSION_CLAUSE} AND PUB_YEAR:"2023"`,
  );
});

// ── planEuropePmcWalk — the documented approximation: REST routes, not query ──

test("europepmc walk plan: forward → /citations, backward → /references", () => {
  assert.equal(planEuropePmcWalk("MED", "32581362", "cites"), "MED/32581362/citations");
  assert.equal(planEuropePmcWalk("MED", "32581362", "citedBy"), "MED/32581362/references");
  assert.equal(planEuropePmcWalk("PMC", "PMC3166943", "cites"), "PMC/PMC3166943/citations");
});

// ── searchEuropePmc — deps flow, slicing, in-band error shaping ──────────────

function depsWith(overrides: Partial<EuropePmcDeps>): EuropePmcDeps {
  return {
    fetchResults: async () => RESPONSE,
    fetchRoute: async () => { throw new Error("Europe PMC walk route must not be fetched outside walk tests"); },
    ...overrides,
  };
}

test("searchEuropePmc returns normalized records on the happy path", async () => {
  const { results } = await searchEuropePmc("CRISPR base editing", {}, depsWith({}));
  assert.equal(results.length, 3);
  assert.equal(results[0]!.doi, "10.1038/s41551-026-01747-y");
  assert.equal(results[1]!.oaUrl, "https://europepmc.org/article/PMC13434336");
});

test("searchEuropePmc excludes retracted work server-side by default, and honours the opt-in", async () => {
  const queries: string[] = [];
  const capture = depsWith({
    fetchResults: async (params) => {
      queries.push(params.get("query") ?? "");
      return { hitCount: 1, resultList: { result: [PMC_REC] } } as EuropePmcResponse;
    },
  });
  await searchEuropePmc("malaria", {}, capture);
  assert.equal(queries[0], `malaria AND ${RETRACTION_EXCLUSION_CLAUSE}`);
  await searchEuropePmc("malaria", { filters: { includeRetracted: true } }, capture);
  assert.equal(queries[1], "malaria");
});

test("searchEuropePmc marks a retracted row when the opt-in returns one", async () => {
  const { results } = await searchEuropePmc("malaria", { filters: { includeRetracted: true } }, depsWith({
    fetchResults: async () => ({
      hitCount: 1,
      resultList: { result: [{ ...PUBMED_REC, pubType: "retracted publication; editorial" }] },
    }),
  }));
  assert.equal(results[0]!.retracted, true);
  assert.match(results[0]!.snippet, /retracted/);
});

test("searchEuropePmc passes the query, pageSize, and signal through to the fetch", async () => {
  const seen: Array<{ params: URLSearchParams; signal?: AbortSignal }> = [];
  const signal = new AbortController().signal;
  await searchEuropePmc("prime editing", { numResults: 7, signal, filters: { includeRetracted: true } }, depsWith({
    fetchResults: async (params, sig) => {
      seen.push({ params, signal: sig });
      return { hitCount: 1, resultList: { result: [PMC_REC] } };
    },
  }));
  assert.equal(seen[0]!.params.get("query"), "prime editing");
  assert.equal(seen[0]!.params.get("pageSize"), "7");
  assert.equal(seen[0]!.signal, signal);
});

test("searchEuropePmc asks the backend for synonym expansion and the whole-set sort", async () => {
  const seen: URLSearchParams[] = [];
  await searchEuropePmc("malaria", { filters: { synonym: true, sort: "date" } }, depsWith({
    fetchResults: async (params) => {
      seen.push(params);
      return { hitCount: 1, resultList: { result: [PMC_REC] } };
    },
  }));
  assert.equal(seen[0]!.get("synonym"), "true");
  assert.equal(seen[0]!.get("sort"), "P_PDATE_D desc");
});

test("searchEuropePmc asks for the full record — resultType=core", async () => {
  const seen: URLSearchParams[] = [];
  await searchEuropePmc("malaria", {}, depsWith({
    fetchResults: async (params) => {
      seen.push(params);
      return { hitCount: 1, resultList: { result: [CORE_REC] } };
    },
  }));
  assert.equal(seen[0]!.get("resultType"), "core");
});

test("searchEuropePmc declines an unrecognised query field in band, naming it — never a silent free-text search", async () => {
  await assert.rejects(
    searchEuropePmc("AUTHR:Venter", {}, depsWith({})),
    (err: unknown) => {
      assert.ok(err instanceof PaperError);
      const m = (err as Error).message;
      assert.match(m, /unrecognised query field "AUTHR"/);
      assert.match(m, /Accepted fields: .*\bAUTH\b/);
      // A one-character syntax fix is local — the other index is not a retry.
      assert.doesNotMatch(m, /Retry with index/);
      return true;
    },
  );
});

test("searchEuropePmc declines each silently-repaired expression, naming the cause — not no-results, not an outage", async () => {
  const cases: Array<[string, RegExp]> = [
    ["(malaria OR tuberculosis", /missing close as AND/],
    ["malaria)", /unmatched "\)"/],
    ["malaria AND ()", /empty "\(\)"/],
    ["malaria OR OR tuberculosis", /doubled "OR OR"/],
    ['TITLE:"heart attack', /unclosed double quote/],
    ["malaria AND", /ends with "AND"/],
  ];
  for (const [query, cause] of cases) {
    await assert.rejects(searchEuropePmc(query, {}, depsWith({})), (err: unknown) => {
      assert.ok(err instanceof PaperError);
      const m = (err as Error).message;
      assert.match(m, /rejected the query as malformed/);
      assert.match(m, cause);
      assert.doesNotMatch(m, /returned no results/, "a repaired query must not read as empty");
      assert.doesNotMatch(m, /unreachable/, "a repaired query must not read as an outage");
      assert.doesNotMatch(m, /Retry with index/, "a syntax fix is local, not a reroute");
      return true;
    });
  }
});

test("a genuine empty result set still reads as empty, not as a malformed expression", async () => {
  await assert.rejects(
    searchEuropePmc("malaria AND tuberculosis", {}, depsWith({
      fetchResults: async () => ({ hitCount: 0, resultList: { result: [] } }),
    })),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.match(m, /returned no results/);
      assert.doesNotMatch(m, /malformed/);
      return true;
    },
  );
});

test("an outage still reads as an outage, not as a malformed expression", async () => {
  await assert.rejects(
    searchEuropePmc("malaria", {}, depsWith({
      fetchResults: async () => { throw new Error("Europe PMC returned 503"); },
    })),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.match(m, /unreachable/);
      assert.doesNotMatch(m, /malformed/);
      return true;
    },
  );
});

test("searchEuropePmc declines a sort key outside the accepted set before sending it", async () => {
  await assert.rejects(
    searchEuropePmc("malaria", { filters: { sort: "bogus" as never } }, depsWith({})),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.match(m, /unrecognised sort "bogus"/);
      assert.match(m, /accepted: citedBy, date/);
      // An invalid argument is a local fix, not a reroute to the other index.
      assert.doesNotMatch(m, /Retry with index/);
      return true;
    },
  );
});

test("searchEuropePmc declines the synonym lever on a walk — the route takes no query", async () => {
  await assert.rejects(
    searchEuropePmc("", { filters: { citationGraph: { seed: "32581362" }, synonym: true } }, depsWith({})),
    (err: unknown) => {
      assert.match((err as Error).message, /filters\.synonym expands a free-text query/);
      return true;
    },
  );
});

test("searchEuropePmc slices results to numResults", async () => {
  const { results } = await searchEuropePmc("q", { numResults: 1 }, depsWith({}));
  assert.equal(results.length, 1);
});

test("searchEuropePmc wraps fetch failures as backend-down — retry index named", async () => {
  await assert.rejects(
    searchEuropePmc("q", {}, depsWith({
      fetchResults: async () => { throw new Error("Europe PMC returned 503"); },
    })),
    (err: unknown) => {
      assert.ok(err instanceof PaperError);
      const m = (err as Error).message;
      assert.match(m, /Europe PMC was unreachable/);
      assert.match(m, /index: "openalex"/);
      return true;
    },
  );
});

test("searchEuropePmc surfaces a 400 response as the malformed case, not backend-down", async () => {
  await assert.rejects(
    searchEuropePmc("q", {}, depsWith({
      fetchResults: async () => { throw new Error("Europe PMC returned 400"); },
    })),
    (err: unknown) => {
      assert.ok(err instanceof PaperError);
      const m = (err as Error).message;
      assert.match(m, /rejected the query as malformed \(Europe PMC returned 400\)/);
      assert.doesNotMatch(m, /unreachable/);
      assert.match(m, /index: "openalex"/);
      return true;
    },
  );
});

test("searchEuropePmc keeps 429 rate-limiting in the backend-down bucket, not malformed", async () => {
  await assert.rejects(
    searchEuropePmc("q", {}, depsWith({
      fetchResults: async () => { throw new Error("Europe PMC returned 429"); },
    })),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.match(m, /unreachable/);
      assert.doesNotMatch(m, /malformed/);
      return true;
    },
  );
});

// ── searchEuropePmcWalk — the citation-graph walk (PIWEB-16) ─────────────────

test("searchEuropePmc walks forward from a PMID seed through the citations route", async () => {
  const seen: Array<{ path: string; params: URLSearchParams }> = [];
  const { results } = await searchEuropePmc("", { filters: { citationGraph: { seed: "32581362", direction: "cites" } } }, depsWith({
    fetchRoute: async (path, params) => {
      seen.push({ path, params });
      return { hitCount: 445, citationList: { citation: [WALK_REC, PMC_REC] } };
    },
  }));
  assert.equal(seen[0]!.path, "MED/32581362/citations");
  assert.equal(seen[0]!.params.get("pageSize"), "10");
  // Walk entries normalize into the SAME shape — journalAbbreviation as venue.
  assert.equal(results.length, 2);
  assert.equal(results[0]!.venue, "J Cell Mol Med");
  assert.equal(results[0]!.year, 2026);
  assert.equal(results[0]!.url, "https://europepmc.org/article/MED/42725849");
});

test("searchEuropePmc resolves a DOI seed through the search endpoint before walking", async () => {
  const seen: Array<{ path: string; query?: string | null }> = [];
  await searchEuropePmc("", { filters: { citationGraph: { seed: "10.1038/s41587-020-0561-9", direction: "citedBy" } } }, depsWith({
    fetchResults: async (params) => {
      seen.push({ path: "search", query: params.get("query") });
      return { hitCount: 1, resultList: { result: [PUBMED_REC] } };
    },
    fetchRoute: async (path) => {
      seen.push({ path });
      return { hitCount: 59, referenceList: { reference: [WALK_REC] } };
    },
  }));
  assert.deepEqual(seen.map((s) => s.path), ["search", "MED/42527584/references"]);
  assert.match(seen[0]!.query!, /DOI:"10\.1038\/s41587-020-0561-9"/);
});

test("searchEuropePmc applies the year filter to walk results — the documented approximation", async () => {
  const { results } = await searchEuropePmc("", {
    filters: { citationGraph: { seed: "32581362" }, year: 2026 },
  }, depsWith({
    fetchRoute: async () => ({
      hitCount: 2,
      citationList: { citation: [WALK_REC, { ...PMC_REC, pubYear: 2019 }] },
    }),
  }));
  assert.deepEqual(results.map((r) => r.year), [2026]);
});

test("searchEuropePmc rejects an OpenAlex seed on the europepmc walk — the other index named", async () => {
  await assert.rejects(
    searchEuropePmc("", { filters: { citationGraph: { seed: "W3161425918" } } }, depsWith({})),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.match(m, /rejected the query as malformed .*OpenAlex id/);
      assert.match(m, /index: "openalex"/);
      return true;
    },
  );
});

test("searchEuropePmc reports an unreadable seed as malformed, not backend-down", async () => {
  await assert.rejects(
    searchEuropePmc("", { filters: { citationGraph: { seed: "not-a-seed" } } }, depsWith({})),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.match(m, /rejected the query as malformed .*unreadable seed/);
      return true;
    },
  );
});

test("searchEuropePmc walk route failures shape as backend-down with the retry index", async () => {
  await assert.rejects(
    searchEuropePmc("", { filters: { citationGraph: { seed: "32581362" } } }, depsWith({
      fetchRoute: async () => { throw new Error("Europe PMC returned 503"); },
    })),
    (err: unknown) => {
      const m = (err as Error).message;
      assert.match(m, /unreachable \(Europe PMC returned 503\)/);
      assert.match(m, /index: "openalex"/);
      return true;
    },
  );
});

test("searchEuropePmc throws no-results on an empty hitList — distinguished from backend-down", async () => {
  await assert.rejects(
    searchEuropePmc("q", {}, depsWith({ fetchResults: async () => ({ hitCount: 0, resultList: { result: [] } }) })),
    (err: unknown) => {
      assert.ok(err instanceof PaperError);
      const m = (err as Error).message;
      assert.match(m, /returned no results/);
      assert.match(m, /index: "openalex"/);
      return true;
    },
  );
});
