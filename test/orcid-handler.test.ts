// Tests for the ORCID handler's pure seams: orcidId/apiPath/pubApiPath (which
// URLs map to which API calls), match, collapseWorks (per-source dedupe),
// employmentLines, and renderProfile. The HTTP layer stays behind the handler
// interface.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apiPath,
  collapseWorks,
  employmentLines,
  orcidHandler,
  orcidId,
  personName,
  profileId,
  pubApiPath,
  renderProfile,
} from "../fetch/handlers/orcid.ts";

const ID = "0000-0002-1122-5876";

test("orcidId extracts 16-digit ids and rejects everything else", () => {
  assert.equal(orcidId(`/${ID}`), ID);
  assert.equal(orcidId(`/${ID}/works`), ID);
  assert.equal(orcidId(`/${ID}/`), ID);
  // X check-digit is legal
  assert.equal(orcidId("/0000-0002-1694-233X"), "0000-0002-1694-233X");
  assert.equal(orcidId("/someone-else"), undefined);
  assert.equal(orcidId("/"), undefined);
  assert.equal(orcidId("/v3.0/0000-0002-1122-5876"), undefined);
});

test("apiPath maps a bare profile to /record and keeps subpaths", () => {
  assert.equal(apiPath(`/${ID}`), `/${ID}/record`);
  assert.equal(apiPath(`/${ID}/`), `/${ID}/record`);
  assert.equal(apiPath(`/${ID}/works`), `/${ID}/works`);
});

test("pubApiPath accepts v3.0 API resources only", () => {
  assert.equal(pubApiPath(`/v3.0/${ID}`), `/${ID}`);
  assert.equal(pubApiPath(`/v3.0/${ID}/works`), `/${ID}/works`);
  assert.equal(pubApiPath(`/${ID}/works`), undefined);
  assert.equal(pubApiPath("/v3.0/not-an-id"), undefined);
});

test("profileId reads the id from either host's URL shape", () => {
  assert.equal(profileId(new URL(`https://orcid.org/${ID}/works`)), ID);
  assert.equal(profileId(new URL(`https://pub.orcid.org/v3.0/${ID}/record`)), ID);
  assert.equal(profileId(new URL("https://orcid.org/someone-else")), undefined);
});

test("match serves orcid.org profiles and pub.orcid.org API urls", () => {
  const yes = (s: string) => orcidHandler.match(new URL(s));
  assert.equal(yes(`https://orcid.org/${ID}`), true);
  assert.equal(yes(`https://www.orcid.org/${ID}/works`), true);
  assert.equal(yes(`https://pub.orcid.org/v3.0/${ID}/works`), true);
  assert.equal(yes(`https://orcid.org/someone-else`), false);
  assert.equal(yes("https://example.com/orcid.org"), false);
});

test("collapseWorks keeps one row per group, preferring the DOI-bearing summary", () => {
  const selfDeclared = {
    title: { title: { value: "AN INVENTORY OF WEED DIVERSITY DATA" } },
    type: "journal-article",
    "publication-date": { year: { value: "2026" } },
    "journal-title": { value: "Data in Brief" },
  };
  const crossref = {
    ...selfDeclared,
    title: { title: { value: "An inventory of weed diversity data" } },
    "external-ids": {
      "external-id": [{ "external-id-type": "doi", "external-id-value": "10.1016/j.dib.2026.113179" }],
    },
  };
  const undated = {
    title: { title: { value: "Old work without dates" } },
    type: "conference-paper",
  };
  const rows = collapseWorks({
    group: [
      { "work-summary": [selfDeclared, crossref] }, // same work, two sources
      { "work-summary": undated },
      { "work-summary": [] }, // empty group drops out
      { "work-summary": [{ title: { title: { value: "   " } } }] }, // blank title drops out
    ],
  });
  assert.equal(rows.length, 2);
  // DOI-bearing summary won the dedupe, with its casing and link
  assert.equal(rows[0]?.title, "An inventory of weed diversity data");
  assert.equal(rows[0]?.link, "https://doi.org/10.1016/j.dib.2026.113179");
  assert.equal(rows[0]?.year, "2026");
  // undated work sorts last
  assert.equal(rows[1]?.title, "Old work without dates");
  assert.equal(rows[1]?.year, "n.d.");
});

test("collapseWorks sorts newest first and handles the empty record", () => {
  const mk = (year?: string) => ({
    title: { title: { value: `work ${year ?? "none"}` } },
    type: "journal-article",
    ...(year ? { "publication-date": { year: { value: year } } } : {}),
  });
  const rows = collapseWorks({ group: [{ "work-summary": mk("2019") }, { "work-summary": mk("2024") }, { "work-summary": mk() }] });
  assert.deepEqual(rows.map((r) => r.year), ["2024", "2019", "n.d."]);
  assert.deepEqual(collapseWorks({}), []);
});

test("employmentLines renders role/dept, org, place, and year range", () => {
  const lines = employmentLines({
    "affiliation-group": [
      {
        summaries: [
          {
            "employment-summary": {
              "department-name": "Department of Biotechnology",
              organization: {
                name: "Manipal Institute of Technology",
                address: { city: "Bengaluru", region: "Karnataka", country: "IN" },
              },
              "start-date": { year: { value: "2022" } },
              "end-date": null,
            },
          },
        ],
      },
      { summaries: [{ "employment-summary": {} }] }, // empty summary drops out
    ],
  });
  assert.deepEqual(lines, ["Department of Biotechnology — Manipal Institute of Technology, Bengaluru, Karnataka, IN (2022-present)"]);
});

test("personName prefers the credit name, falls back to given+family, then the id", () => {
  assert.equal(personName({ name: { "credit-name": { value: "Rashmi Shivanna" } } }, ID), "Rashmi Shivanna");
  assert.equal(
    personName({ name: { "given-names": { value: "Dr. Rashmi" }, "family-name": { value: "S" } } }, ID),
    "Dr. Rashmi S",
  );
  assert.equal(personName({}, ID), `ORCID ${ID}`);
});

test("renderProfile renders header, affiliations, and numbered works", () => {
  const out = renderProfile({
    name: "Rashmi Shivanna",
    id: ID,
    affiliations: ["Dept — Manipal Institute of Technology, Bengaluru (2022-present)"],
    works: [
      { title: "Lichen biomonitoring", type: "journal-article", venue: "Ecological Indicators", year: "2026", link: "https://doi.org/10.1016/j.ecolind.2026.115204" },
    ],
    total: 1,
  });
  assert.match(out, /^# Rashmi Shivanna \(ORCID 0000-0002-1122-5876\)$/m);
  assert.match(out, /^- Dept — Manipal Institute of Technology, Bengaluru \(2022-present\)$/m);
  assert.match(out, /^1\. \*\*Lichen biomonitoring\*\*$/m);
  assert.match(out, /journal-article \| Ecological Indicators \| 2026 — https:\/\/doi\.org\//);
  assert.doesNotMatch(out, /capped/);
});

test("renderProfile notes the cap and handles the empty record", () => {
  const capped = renderProfile({
    name: "A",
    id: ID,
    affiliations: [],
    works: [{ title: "t", type: "journal-article", venue: "V", year: "2026", link: null }],
    total: 300,
  });
  assert.match(capped, /capped at 100/);
  assert.match(capped, /pub\.orcid\.org\/v3\.0\/0000-0002-1122-5876\/works/);

  const empty = renderProfile({ name: "A", id: ID, affiliations: [], works: [], total: 0 });
  assert.match(empty, /No public works registered/);
});
