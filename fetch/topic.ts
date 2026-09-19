/**
 * Return the sections of a document that answer a question, instead of its first N lines.
 * Reference pages open with navigation and a preamble, so the head of the document is reliably the least useful part of it.
 *
 * Scoring is deliberately in memory rather than through the FTS index: that index stores one row per document, so it ranks documents against each other and cannot rank sections within one.
 * Moving to per-section rows is a schema change this does not need.
 */

/**
 * A term in a heading counts far more than the same term in a body.
 * Long sections mention everything, so without this weight a big overview section beats the precise section that actually answers the question.
 */
const HEADING_WEIGHT = 8;

/**
 * Body mentions saturate: the second mention of a term says much less than the first, and the hundredth says nothing.
 * Without this a long overview outscores the precise section simply by repeating the words more times.
 */
const TF_SATURATION = 1.2;

/** Runners-up below this share of the top score are padding, not answers. */
const RELEVANCE_FLOOR = 0.25;

/** Words that carry no topic signal; short words are dropped by length anyway. */
const STOP = new Set([
  "the", "and", "for", "with", "how", "does", "did", "you", "your", "use", "using", "from",
  "that", "this", "what", "when", "where", "which", "why", "can", "has", "have", "are", "was",
  "get", "set", "its", "into", "than", "then", "them", "they", "not", "but", "all", "any", "one",
]);

function terms(topic: string): string[] {
  const found = topic.toLowerCase().match(/[a-z0-9_.-]+/g) ?? [];
  return [...new Set(found.filter((t) => t.length > 2 && !STOP.has(t)))];
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Split on markdown headings; the leading chunk before any heading is a section too. */
export function splitSections(markdown: string): string[] {
  return markdown.split(/\n(?=#{1,6} )/).filter((s) => s.trim());
}

function score(section: string, wanted: string[]): number {
  const cut = section.indexOf("\n");
  const heading = (cut === -1 ? section : section.slice(0, cut)).toLowerCase();
  const whole = section.toLowerCase();
  let points = 0;
  for (const t of wanted) {
    if (heading.includes(t)) points += HEADING_WEIGHT;
    const tf = occurrences(whole, t);
    points += tf / (tf + TF_SATURATION);
  }
  return points;
}

/** Headings go into the tool result for the model to read, so strip the anchor furniture real docs leave behind: the marker prefix, permalink wrappers, and trailing pilcrows or hashes. */
function cleanHeading(line: string): string {
  return line
    .replace(/^#+\s*/, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[¶#\s]+$/, "")
    .trim();
}

export interface TopicMatch {
  content: string;
  /** First line of each section returned, in the order returned. */
  headings: string[];
}

/**
 * Best-scoring sections that fit the budget, highest first.
 * Returns undefined when the topic is empty or nothing matches, which is the caller's signal to fall back to the head of the document: a bad topic must never return less than no topic at all.
 */
export function matchTopic(markdown: string, topic: string, budget: number): TopicMatch | undefined {
  const wanted = terms(topic);
  if (wanted.length === 0) return undefined;

  const ranked = splitSections(markdown)
    .map((body) => ({ body, points: score(body, wanted) }))
    .filter((s) => s.points > 0)
    .sort((a, b) => b.points - a.points);
  if (ranked.length === 0) return undefined;

  // Budget alone would pad the answer with whatever happens to fit; a weak match is worse than nothing, because it displaces the file path advice.
  const floor = (ranked[0]?.points ?? 0) * RELEVANCE_FLOOR;
  const picked: string[] = [];
  let used = 0;
  for (const s of ranked.filter((r) => r.points >= floor)) {
    if (picked.length > 0 && used + s.body.length > budget) continue;
    // The top section always goes in, truncated if it alone overruns the budget.
    const section = picked.length === 0 && s.body.length > budget ? s.body.slice(0, budget) : s.body;
    picked.push(section);
    used += section.length;
    if (used >= budget) break;
  }

  return {
    content: picked.join("\n\n"),
    headings: picked.map((s) => cleanHeading(s.split("\n")[0] ?? "")),
  };
}
