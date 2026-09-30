import {
  type FetchContext,
  type HandlerResult,
  FetchError,
  defineHandler,
  httpGet,
  readBodyCapped,
} from "./handler.ts";

/**
 * ORCID handler. orcid.org is a JavaScript app: plain HTTP clients get a
 * placeholder page, so profiles are served from the pub.orcid.org v3 REST API.
 * - markdown mode, orcid.org/{id}: rendered profile — name, affiliations,
 *   public works deduped and newest-first.
 * - raw mode: the API's exact JSON body (fetchRaw opt-in — the raw bypass
 *   would otherwise return the JS shell).
 * - pub.orcid.org URLs: served as-is with JSON content negotiation.
 */

const API = "https://pub.orcid.org/v3.0";
const BODY_CAP = 5 * 1024 * 1024;
const WORKS_CAP = 100;

/** The 16-digit id from a profile path, e.g. "/0000-0002-1122-5876" -> "0000-0002-1122-5876". */
export function orcidId(pathname: string): string | undefined {
  return pathname.match(/^\/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])(?:\/.*)?$/)?.[1];
}

/** orcid.org profile path -> API path. A bare profile maps to /record (person + works in one body). */
export function apiPath(pathname: string): string {
  const id = orcidId(pathname)!;
  const rest = pathname.slice(1 + id.length);
  return `/${id}${rest === "" || rest === "/" ? "/record" : rest}`;
}

/** pub.orcid.org path after /v3.0, or undefined when the URL is not an API resource. */
export function pubApiPath(pathname: string): string | undefined {
  return pathname.match(/^\/v3\.0(\/\d{4}-\d{4}-\d{4}-\d{3}[\dX](?:\/\w+)?)$/)?.[1];
}

/** The 16-digit id from either host's URL shape (orcid.org/{id}... or pub.orcid.org/v3.0/{id}...). */
export function profileId(url: URL): string | undefined {
  return orcidId(url.pathname) ?? pubApiPath(url.pathname)?.match(/\/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/)?.[1];
}

export interface OrcidWorkSummary {
  title?: { title?: { value?: string } | null } | null;
  type?: string;
  "publication-date"?: { year?: { value?: string } | null } | null;
  "journal-title"?: { value?: string } | null;
  url?: { value?: string } | null;
  "external-ids"?: { "external-id"?: Array<{ "external-id-type": string; "external-id-value": string }> } | null;
}

export interface OrcidWorkGroup {
  "work-summary"?: OrcidWorkSummary | OrcidWorkSummary[];
}

export interface OrcidWorksDoc {
  group?: OrcidWorkGroup[];
}

export interface OrcidPersonDoc {
  name?: {
    "given-names"?: { value?: string } | null;
    "family-name"?: { value?: string } | null;
    "credit-name"?: { value?: string } | null;
  } | null;
}

export interface OrcidEmploymentSummary {
  "role-title"?: string | null;
  "department-name"?: string | null;
  organization?: {
    name?: string | null;
    address?: { city?: string | null; region?: string | null; country?: string | null } | null;
  } | null;
  "start-date"?: { year?: { value?: string } | null } | null;
  "end-date"?: { year?: { value?: string } | null } | null;
}

export interface OrcidEmploymentsDoc {
  "affiliation-group"?: Array<{
    summaries?: Array<{ "employment-summary"?: OrcidEmploymentSummary }>;
  }>;
}

export interface WorkRow {
  title: string;
  type: string;
  venue: string;
  year: string;
  link: string | null;
}

/** DOI link for a work, or its stored url, or null. */
export function workDoi(w: OrcidWorkSummary): string | null {
  const ids = w["external-ids"]?.["external-id"] ?? [];
  const doi = ids.find((x) => x["external-id-type"] === "doi");
  return doi ? `https://doi.org/${doi["external-id-value"]}` : w.url?.value ?? null;
}

export function personName(p: OrcidPersonDoc, id: string): string {
  const n = p.name;
  const credit = n?.["credit-name"]?.value?.trim();
  if (credit) return credit;
  const full = [n?.["given-names"]?.value, n?.["family-name"]?.value].filter(Boolean).join(" ").trim();
  return full || `ORCID ${id}`;
}

/** One affiliation line per employment: role/dept, org, place, years. */
export function employmentLines(doc: OrcidEmploymentsDoc): string[] {
  const lines: string[] = [];
  for (const group of doc["affiliation-group"] ?? []) {
    for (const s of group.summaries ?? []) {
      const e = s["employment-summary"];
      if (!e) continue;
      const a = e.organization?.address;
      const where = [a?.city, a?.region, a?.country].filter(Boolean).join(", ");
      const role = [e["role-title"], e["department-name"]].filter(Boolean).join(", ");
      const org = [e.organization?.name, where].filter(Boolean).join(", ");
      const start = e["start-date"]?.year?.value;
      const end = e["end-date"]?.year?.value ?? (start ? "present" : "");
      const years = start ? ` (${start}-${end})` : "";
      const line = [role, org].filter(Boolean).join(" — ") + years;
      if (line.trim()) lines.push(line);
    }
  }
  return lines;
}

/**
 * Collapse each works group to one row: ORCID stores the same work once per
 * source (Crossref, Scopus, self-declared), so groups arrive with duplicates.
 * The first summary with a DOI wins; the rest are the same work re-registered.
 * Sorted newest first; undated works sink.
 */
export function collapseWorks(doc: OrcidWorksDoc): WorkRow[] {
  const rows: WorkRow[] = [];
  for (const g of doc.group ?? []) {
    const list = (Array.isArray(g["work-summary"]) ? g["work-summary"] : [g["work-summary"]])
      .filter((s): s is OrcidWorkSummary => s != null);
    const withDoi = list.find((s) =>
      (s["external-ids"]?.["external-id"] ?? []).some((x) => x["external-id-type"] === "doi")
    );
    const w = withDoi ?? list[0];
    const title = w?.title?.title?.value?.trim();
    if (!w || !title) continue;
    rows.push({
      title,
      type: w.type ?? "work",
      venue: w["journal-title"]?.value?.trim() ?? "",
      year: w["publication-date"]?.year?.value ?? "n.d.",
      link: workDoi(w),
    });
  }
  return rows.sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0));
}

export function renderProfile(opts: {
  name: string;
  id: string;
  affiliations: string[];
  works: WorkRow[];
  total: number;
}): string {
  const { name, id, affiliations, works, total } = opts;
  const lines = [`# ${name} (ORCID ${id})`, ""];
  if (affiliations.length > 0) {
    lines.push("Affiliations:", ...affiliations.map((a) => `- ${a}`), "");
  }
  if (works.length === 0) {
    lines.push("No public works registered on this ORCID record.");
    return lines.join("\n");
  }
  lines.push(`${works.length} of ${total} public works, newest first:`, "");
  works.forEach((w, i) => {
    const bits = [w.type, w.venue, w.year].filter(Boolean).join(" | ");
    lines.push(`${i + 1}. **${w.title}**`, `   ${bits}${w.link ? ` — ${w.link}` : ""}`);
  });
  if (total > works.length) {
    lines.push("", `(works capped at ${WORKS_CAP}; fetch ${API}/${id}/works for the full list)`);
  }
  return lines.join("\n");
}

async function apiText(path: string, ctx: FetchContext): Promise<string> {
  const res = await httpGet(`${API}${path}`, ctx.signal, { accept: "application/json" });
  if (res.status === 404) throw new FetchError(`ORCID record not found (or not public): ${path}`);
  if (!res.ok) throw new FetchError(`ORCID API returned ${res.status} for ${path}`);
  return await readBodyCapped(res, BODY_CAP);
}

async function apiJson(path: string, ctx: FetchContext): Promise<unknown> {
  const text = await apiText(path, ctx);
  try {
    return JSON.parse(text);
  } catch {
    throw new FetchError(`ORCID API returned a non-JSON body for ${path}`);
  }
}

export const orcidHandler = defineHandler({
  name: "orcid",
  description:
    "ORCID researcher profiles (orcid.org is a JS app): renders name, affiliations, and deduped public works. Structured access: fetch pub.orcid.org/v3.0/{id}/works, or mode:'raw' for the API's exact JSON.",
  match: (url) =>
    /(^|\.)orcid\.org$/.test(url.hostname) && orcidId(url.pathname) !== undefined ||
    url.hostname === "pub.orcid.org" && pubApiPath(url.pathname) !== undefined,
  async fetch(url, ctx): Promise<HandlerResult> {
    const id = orcidId(url.pathname)!;

    // pub.orcid.org is already the API: serve the JSON body as-is.
    if (url.hostname === "pub.orcid.org") {
      return { kind: "json", content: await apiText(pubApiPath(url.pathname)!, ctx) };
    }

    const [person, worksDoc, empDoc] = await Promise.all([
      apiJson(`/${id}/person`, ctx),
      apiJson(`/${id}/works`, ctx),
      apiJson(`/${id}/employments`, ctx),
    ]) as [OrcidPersonDoc, OrcidWorksDoc, OrcidEmploymentsDoc];

    const name = personName(person, id);
    const all = collapseWorks(worksDoc);
    return {
      kind: "orcid-profile",
      title: name,
      content: renderProfile({
        name,
        id,
        affiliations: employmentLines(empDoc),
        works: all.slice(0, WORKS_CAP),
        total: all.length,
      }),
    };
  },
  // Raw on an orcid.org URL serves the canonical API body, not the JS shell.
  async fetchRaw(url, ctx): Promise<HandlerResult> {
    const path = url.hostname === "pub.orcid.org" ? pubApiPath(url.pathname)! : apiPath(url.pathname);
    return { kind: "orcid-json", title: `ORCID ${profileId(url) ?? url.pathname}`, content: await apiText(path, ctx) };
  },
});
