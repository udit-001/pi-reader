import { getJson } from "../handler.ts";
import { type Registry, fullFromArchive, metaBlock, seg } from "./common.ts";

export const rubygems: Registry = {
  name: "rubygems",
  match: (url) => {
    if (!/(^|\.)rubygems\.org$/.test(url.hostname)) return undefined;
    const s = seg(url);
    return s[0] === "gems" ? s[1] : undefined;
  },
  async light(pkg, ctx) {
    const d = await getJson<any>(`https://rubygems.org/api/v1/gems/${pkg}.json`, ctx.signal);
    const header = metaBlock(`${pkg} (RubyGems)`, {
      version: d.version,
      info: d.info,
      homepage: d.homepage_uri,
      repository: d.source_code_uri,
      downloads: d.downloads,
    });
    return { kind: "package-info", title: pkg, content: header };
  },
  async full(pkg, ctx) {
    const d = await getJson<any>(`https://rubygems.org/api/v1/gems/${pkg}.json`, ctx.signal);
    return fullFromArchive(
      `https://rubygems.org/downloads/${pkg}-${d.version}.gem`,
      `${pkg}.gem.tar`,
      ctx,
      metaBlock(`${pkg}@${d.version} (RubyGems)`, { info: d.info }),
    );
  },
};
