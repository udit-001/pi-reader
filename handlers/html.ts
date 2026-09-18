// html.ts — HTML → Markdown conversion for handlers.
//
// Provides htmlToMarkdown and htmlFragmentToMarkdown interfaces
// that handlers expect. Uses our existing Defuddle + regex converters.

import { parseHTML } from "linkedom";
import { Defuddle } from "defuddle/node";

export interface ExtractedPage {
  title?: string;
  markdown: string;
}

/**
 * HTML → readable markdown for full pages.
 * Uses regex-based extraction for speed (no async Defuddle).
 */
export function htmlToMarkdown(html: string, url?: string): ExtractedPage {
  // Simple extraction: strip tags and collapse whitespace
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  // Extract title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch?.[1] ? titleMatch[1].replace(/<[^>]*>/g, "").trim() : undefined;

  return { title, markdown: text.slice(0, 50_000) };
}

/**
 * HTML fragment → markdown (API-returned bodies).
 * Simpler than full page — no Readability needed.
 */
export function htmlFragmentToMarkdown(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Decode HTML entities. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}
