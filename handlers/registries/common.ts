import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type FetchContext,
  type HandlerResult,
  download,
  extractArchive,
  summarizeTree,
} from "../handler.ts";

/**
 * A registry entry: recognize a package URL, fetch its metadata/readme (light) or download+extract the actual package (full).
 * Adding a registry = adding one file exporting one of these.
 */
export interface Registry {
  name: string;
  match(url: URL): string | undefined; // returns package identifier
  light(pkg: string, ctx: FetchContext): Promise<HandlerResult>;
  full?(pkg: string, ctx: FetchContext): Promise<HandlerResult>;
}

export function seg(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean);
}

/** download -> extract -> readme + file listing. Shared "full" pipeline. */
export async function fullFromArchive(
  archiveUrl: string,
  filename: string,
  ctx: FetchContext,
  header: string,
): Promise<HandlerResult> {
  const treeDir = join(ctx.entryDir, "tree");
  mkdirSync(treeDir, { recursive: true });
  const archive = join(ctx.entryDir, filename);
  await download(archiveUrl, archive, ctx.signal);
  if (!ctx.exec) throw new Error("exec not available");
  await extractArchive(archive, treeDir, ctx.exec, ctx.signal);
  // gem/hex tarballs nest the real source in data.tar.gz / contents.tar.gz
  for (const inner of readdirSync(treeDir)) {
    if (/^(data|contents)\.tar\.gz$/.test(inner)) {
      const src = join(treeDir, "src");
      await extractArchive(join(treeDir, inner), src, ctx.exec, ctx.signal);
    }
  }
  const tree = summarizeTree(treeDir);
  const content = [
    header,
    "",
    tree.readme ?? "(no README in package)",
    `\n\n## Files (${tree.fileCount}${tree.fileCount >= 400 ? "+" : ""})\n`,
    tree.listing,
  ].join("\n");
  return { kind: "package", content, hasTree: true };
}

export function metaBlock(title: string, fields: Record<string, unknown>): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${v}`);
  return [`# ${title}`, ...lines].join("\n");
}
