import { FetchError, getJson } from "../handler.ts";
import { type Registry, fullFromArchive, metaBlock, seg } from "./common.ts";

export const pypi: Registry = {
  name: "pypi",
  match: (url) => {
    if (!/(^|\.)pypi\.org$/.test(url.hostname)) return undefined;
    const s = seg(url);
    if (s[0] === "project" || s[0] === "pypi") return s[1];
    return undefined;
  },
  async light(pkg, ctx) {
    const d = await getJson<any>(`https://pypi.org/pypi/${pkg}/json`, ctx.signal);
    const header = metaBlock(`${pkg} (PyPI)`, {
      version: d.info?.version,
      summary: d.info?.summary,
      homepage: d.info?.home_page || d.info?.project_urls?.Homepage,
      repository: d.info?.project_urls?.Source || d.info?.project_urls?.Repository,
    });
    return { kind: "package-info", title: pkg, content: `${header}\n\n---\n\n${d.info?.description ?? "(no description)"}` };
  },
  async full(pkg, ctx) {
    const d = await getJson<any>(`https://pypi.org/pypi/${pkg}/json`, ctx.signal);
    const files: any[] = d.urls ?? [];
    const dist = files.find((f) => f.packagetype === "sdist") ?? files.find((f) => f.filename?.endsWith(".whl"));
    if (!dist) throw new FetchError(`No downloadable dist for ${pkg}`);
    return fullFromArchive(dist.url, dist.filename, ctx, metaBlock(`${pkg} ${d.info?.version} (PyPI)`, { summary: d.info?.summary }));
  },
};
