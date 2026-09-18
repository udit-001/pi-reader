import { getJson } from "../handler.ts";
import { type Registry, fullFromArchive, metaBlock, seg } from "./common.ts";

export const hex: Registry = {
  name: "hex",
  match: (url) => {
    if (!/(^|\.)hex\.pm$/.test(url.hostname)) return undefined;
    const s = seg(url);
    return s[0] === "packages" ? s[1] : undefined;
  },
  async light(pkg, ctx) {
    const d = await getJson<any>(`https://hex.pm/api/packages/${pkg}`, ctx.signal);
    const header = metaBlock(`${pkg} (Hex)`, {
      version: d.releases?.[0]?.version,
      description: d.meta?.description,
      docs: d.docs_html_url,
      repository: d.meta?.links?.GitHub ?? d.meta?.links?.Github,
    });
    return { kind: "package-info", title: pkg, content: header };
  },
  async full(pkg, ctx) {
    const d = await getJson<any>(`https://hex.pm/api/packages/${pkg}`, ctx.signal);
    const v = d.releases?.[0]?.version;
    return fullFromArchive(
      `https://repo.hex.pm/tarballs/${pkg}-${v}.tar`,
      `${pkg}.tar`,
      ctx,
      metaBlock(`${pkg}@${v} (Hex)`, { description: d.meta?.description }),
    );
  },
};
