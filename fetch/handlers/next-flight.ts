// Next.js App Router flight extractor — the local tier for client-rendered
// Next pages. RSC pages embed their content as JSON rows in inline
// <script>self.__next_f.push([1,"..."])</script> chunks; Readability finds an
// empty body on those, so this decodes the payloads and walks the serialized
// element tree to Markdown before the page is handed to remote fallbacks.
//
// Adapted from pi-web-access (MIT) © nicobailon, with two changes: the script
// regex tolerates attributes and surrounding whitespace, and a thin main chunk
// falls through to the sweep over the remaining chunks instead of giving up.
//
// Interface: extractNextFlightContent(html) → { title, content } | null.
// Null means "not a flight page / nothing usable" — the caller keeps its
// fallback chain. Pure function; tests cross this same seam
// (test/next-flight.test.ts).

const MIN_CONTENT_LENGTH = 100;
const MIN_FALLBACK_CHUNK_LENGTH = 50;

export interface NextFlightContent {
  title: string;
  content: string;
}

/** Entry point. Returns null fast for pages without flight data. */
export function extractNextFlightContent(html: string): NextFlightContent | null {
  if (!html.includes("self.__next_f.push")) return null;

  const chunkMap = collectFlightChunks(html);
  if (chunkMap.size === 0) return null;

  const title = /<title[^>]*>([^<]+)<\/title>/.exec(html)?.[1]?.split("|")[0]?.trim() ?? "";

  const parsedCache = new Map<string, unknown | null>();
  const visitedRefs = new Set<string>();

  const getParsedChunk = (id: string): unknown | null => {
    if (parsedCache.has(id)) return parsedCache.get(id);
    const chunk = chunkMap.get(id);
    let parsed: unknown | null = null;
    if (chunk?.startsWith("[")) {
      try {
        parsed = JSON.parse(chunk);
      } catch {
        parsed = null;
      }
    }
    parsedCache.set(id, parsed);
    return parsed;
  };

  // Main content chunk first (the conventional root-layout id), then a sweep
  // over every other chunk in payload order, deduped by leading text.
  const mainChunk = getParsedChunk("23");
  if (mainChunk !== null) {
    const content = flightNodeToMarkdown(mainChunk, getParsedChunk, visitedRefs).trim();
    if (content.length > MIN_CONTENT_LENGTH) {
      return { title, content: collapseBlankLines(content) };
    }
  }

  const parts: { order: number; text: string }[] = [];
  for (const [id] of chunkMap) {
    if (id === "23") continue;
    const parsed = getParsedChunk(id);
    if (parsed === null) continue;
    visitedRefs.clear();
    const text = flightNodeToMarkdown(parsed, getParsedChunk, visitedRefs).trim();
    if (text.length > MIN_FALLBACK_CHUNK_LENGTH && !/page was not found|404/.test(text)) {
      parts.push({ order: Number.parseInt(id, 16), text });
    }
  }
  parts.sort((a, b) => a.order - b.order);

  const seen = new Set<string>();
  const content = parts
    .filter((p) => {
      const key = p.text.slice(0, 150);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((p) => p.text)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return content.length > MIN_CONTENT_LENGTH ? { title, content } : null;
}

// ── Chunk collection ─────────────────────────────────────────────────────────
// Each inline script pushes a JSON-string-escaped fragment; fragments decode
// to lines of "hexId:payload". Duplicate ids keep the longest payload (later
// stream updates win).

function collectFlightChunks(html: string): Map<string, string> {
  const chunkMap = new Map<string, string>();
  const scriptRegex = /<script[^>]*>\s*self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)\s*<\/script>/g;
  for (const match of html.matchAll(scriptRegex)) {
    let decoded: string;
    try {
      decoded = JSON.parse(`"${match[1]}"`) as string;
    } catch {
      continue;
    }
    for (const line of decoded.split("\n")) {
      if (!line.trim()) continue;
      const colonIdx = line.indexOf(":");
      if (colonIdx <= 0 || colonIdx > 4) continue;
      const id = line.slice(0, colonIdx);
      if (!/^[0-9a-f]+$/i.test(id)) continue;
      const payload = line.slice(colonIdx + 1);
      if (!payload) continue;
      const existing = chunkMap.get(id);
      if (!existing || payload.length > existing.length) chunkMap.set(id, payload);
    }
  }
  return chunkMap;
}

function collapseBlankLines(content: string): string {
  return content.replace(/\n{3,}/g, "\n\n").trim();
}

// ── Flight tree → Markdown ───────────────────────────────────────────────────
// A parsed chunk is either an element ["$", tag, key, props] or an array of
// nodes. Strings like "$L<id>" reference other chunks and resolve recursively
// with cycle protection; "$<Something>" protocol strings are dropped.

type FlightNode = unknown;

const SKIP_TAGS = new Set([
  "script", "style", "svg", "path", "circle", "link", "meta", "template",
  "button", "input", "nav", "footer", "aside",
]);

function flightNodeToMarkdown(
  node: FlightNode,
  getParsedChunk: (id: string) => unknown | null,
  visitedRefs: Set<string>,
  ctx = { inTable: false, inCode: false },
): string {
  if (node === null || node === undefined) return "";

  if (typeof node === "string") {
    const refMatch = node.match(/^\$L([0-9a-f]+)$/i);
    if (refMatch) {
      const refId = refMatch[1]!;
      if (visitedRefs.has(refId)) return "";
      visitedRefs.add(refId);
      const refNode = getParsedChunk(refId);
      const result = refNode !== null ? flightNodeToMarkdown(refNode, getParsedChunk, visitedRefs, ctx) : "";
      visitedRefs.delete(refId);
      return result;
    }
    if (!ctx.inCode && (node === "$undefined" || node === "$" || /^\$[A-Z]/.test(node))) return "";
    return node.trim() ? node : "";
  }

  if (typeof node === "number") return String(node);
  if (typeof node === "boolean") return "";
  if (!Array.isArray(node)) return "";

  // Element: ["$", tag, key, props]
  if (node[0] === "$" && typeof node[1] === "string") {
    const tag = node[1];
    const props = (node[3] ?? {}) as Record<string, unknown>;
    if (SKIP_TAGS.has(tag)) return "";

    if (tag.startsWith("$L")) {
      const refId = tag.slice(2);
      if (visitedRefs.has(refId)) return "";
      if (props.baseId && props.children) return `## ${String(props.children)}\n\n`;
      visitedRefs.add(refId);
      const refNode = getParsedChunk(refId);
      const result = refNode !== null
        ? flightNodeToMarkdown(refNode, getParsedChunk, visitedRefs, ctx)
        : props.children !== undefined
          ? flightNodeToMarkdown(props.children, getParsedChunk, visitedRefs, ctx)
          : "";
      visitedRefs.delete(refId);
      return result;
    }

    const children = props.children;
    const content = children !== undefined ? flightNodeToMarkdown(children, getParsedChunk, visitedRefs, ctx) : "";

    switch (tag) {
      case "h1": return `# ${content.trim()}\n\n`;
      case "h2": return `## ${content.trim()}\n\n`;
      case "h3": return `### ${content.trim()}\n\n`;
      case "h4": return `#### ${content.trim()}\n\n`;
      case "h5": return `##### ${content.trim()}\n\n`;
      case "h6": return `###### ${content.trim()}\n\n`;
      case "p": return ctx.inTable ? content : `${content.trim()}\n\n`;
      case "code": {
        const code = children !== undefined ? flightNodeToMarkdown(children, getParsedChunk, visitedRefs, { ...ctx, inCode: true }) : "";
        return ctx.inCode ? code : `\`${code}\``;
      }
      case "pre": {
        const pre = children !== undefined ? flightNodeToMarkdown(children, getParsedChunk, visitedRefs, { ...ctx, inCode: true }) : "";
        return `\`\`\`\n${pre}\n\`\`\`\n\n`;
      }
      case "strong": case "b": return `**${content}**`;
      case "em": case "i": return `*${content}*`;
      case "li": return `- ${content.trim()}\n`;
      case "ul": case "ol": return `${content}\n`;
      case "blockquote": return `> ${content.trim()}\n\n`;
      case "table": return `${flightTableToMarkdown(node, getParsedChunk, visitedRefs)}\n`;
      case "thead": case "tbody": case "tr": case "th": case "td":
        return content;
      case "div":
        if (props.role === "alert" || props["data-slot"] === "alert") return `> ${content.trim()}\n\n`;
        return content;
      case "a": {
        const href = props.href;
        return typeof href === "string" && !href.startsWith("#") ? `[${content}](${href})` : content;
      }
      default: return content;
    }
  }

  // Array of child nodes
  return (node as FlightNode[])
    .map((child) => flightNodeToMarkdown(child, getParsedChunk, visitedRefs, ctx))
    .join("");
}

function flightTableToMarkdown(
  tableNode: FlightNode[],
  getParsedChunk: (id: string) => unknown | null,
  visitedRefs: Set<string>,
): string {
  const props = (tableNode[3] ?? {}) as Record<string, unknown>;
  const rows: string[][] = [];
  let headerRowCount = 0;

  const walk = (node: FlightNode, isHeader: boolean): void => {
    if (node === null || node === undefined) return;

    if (typeof node === "string") {
      const refId = /^\$L([0-9a-f]+)$/i.exec(node)?.[1];
      if (refId && !visitedRefs.has(refId)) {
        visitedRefs.add(refId);
        walk(getParsedChunk(refId), isHeader);
        visitedRefs.delete(refId);
      }
      return;
    }
    if (!Array.isArray(node)) return;

    if (node[0] === "$") {
      const tag = node[1];
      if (typeof tag !== "string") return;
      const nodeProps = (node[3] ?? {}) as Record<string, unknown>;
      if (tag === "thead") walk(nodeProps.children, true);
      else if (tag === "tbody") walk(nodeProps.children, false);
      else if (tag === "tr") {
        const cells: string[] = [];
        walkCells(nodeProps.children, cells);
        if (cells.length > 0) {
          rows.push(cells);
          if (isHeader) headerRowCount++;
        }
      } else if (tag.startsWith("$L")) {
        const refId = tag.slice(2);
        if (!visitedRefs.has(refId)) {
          visitedRefs.add(refId);
          walk(getParsedChunk(refId), isHeader);
          visitedRefs.delete(refId);
        }
      } else walk(nodeProps.children, isHeader);
    } else {
      for (const child of node) walk(child, isHeader);
    }
  };

  const walkCells = (node: FlightNode, cells: string[]): void => {
    if (node === null || node === undefined) return;

    if (typeof node === "string") {
      const refId = /^\$L([0-9a-f]+)$/i.exec(node)?.[1];
      if (refId && !visitedRefs.has(refId)) {
        visitedRefs.add(refId);
        walkCells(getParsedChunk(refId), cells);
        visitedRefs.delete(refId);
      }
      return;
    }
    if (!Array.isArray(node)) return;

    if (node[0] === "$") {
      const tag = node[1];
      if (typeof tag !== "string") return;
      const nodeProps = (node[3] ?? {}) as Record<string, unknown>;
      if (tag === "td" || tag === "th") {
        const cellProps = (node[3] ?? {}) as Record<string, unknown>;
        const text = flightNodeToMarkdown(cellProps.children, getParsedChunk, visitedRefs, { inTable: true, inCode: false })
          .trim()
          .replace(/\n/g, " ")
          .replace(/\\/g, "\\\\")
          .replace(/\|/g, "\\|");
        cells.push(text);
      } else if (tag.startsWith("$L")) {
        const refId = tag.slice(2);
        if (!visitedRefs.has(refId)) {
          visitedRefs.add(refId);
          const refNode = getParsedChunk(refId);
          walkCells(refNode ?? nodeProps.children, cells);
          visitedRefs.delete(refId);
        }
      } else {
        walkCells(nodeProps.children, cells);
      }
    } else {
      for (const child of node) walkCells(child, cells);
    }
  };

  walk(props.children, false);
  if (rows.length === 0) return "";

  const colCount = Math.max(...rows.map((r) => r.length));
  let md = "";
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!.concat(Array(colCount - rows[i]!.length).fill(""));
    md += `| ${row.join(" | ")} |\n`;
    if (i === headerRowCount - 1 || (headerRowCount === 0 && i === 0)) {
      md += `| ${Array(colCount).fill("---").join(" | ")} |\n`;
    }
  }
  return md;
}
