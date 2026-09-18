import { htmlToMarkdown } from "../html.ts";
import { getJson, getText } from "../handler.ts";
import { type Registry, fullFromArchive, metaBlock, seg } from "./common.ts";

export const crates: Registry = {
  name: "crates.io",
  match: (url) => {
    if (!/(^|\.)crates\.io$/.test(url.hostname)) return undefined;
    const s = seg(url);
    return s[0] === "crates" ? s[1] : undefined;
  },
  async light(pkg, ctx) {
    const d = await getJson<any>(`https://crates.io/api/v1/crates/${pkg}`, ctx.signal);
    const c = d.crate;
    const header = metaBlock(`${pkg} (crates.io)`, {
      version: c?.newest_version,
      description: c?.description,
      repository: c?.repository,
      docs: c?.documentation ?? `https://docs.rs/${pkg}`,
      downloads: c?.downloads,
    });
    let readme = "(no readme)";
    try {
      const r = await getText(`https://crates.io/api/v1/crates/${pkg}/${c.newest_version}/readme`, ctx.signal);
      readme = /html/i.test(r.contentType) ? htmlToMarkdown(r.text).markdown : r.text;
    } catch {
      // readme endpoint missing for some crates; metadata alone is fine
    }
    return { kind: "package-info", title: pkg, content: `${header}\n\n---\n\n${readme}` };
  },
  async full(pkg, ctx) {
    const d = await getJson<any>(`https://crates.io/api/v1/crates/${pkg}`, ctx.signal);
    const v = d.crate?.newest_version;
    return fullFromArchive(
      `https://crates.io/api/v1/crates/${pkg}/${v}/download`,
      `${pkg}.crate.tgz`,
      ctx,
      metaBlock(`${pkg}@${v} (crates.io)`, { description: d.crate?.description }),
    );
  },
};
