import { FetchError, getJson } from "../handler.ts";
import { type Registry, fullFromArchive, metaBlock, seg } from "./common.ts";

export const packagist: Registry = {
  name: "packagist",
  match: (url) => {
    if (!/(^|\.)packagist\.org$/.test(url.hostname)) return undefined;
    const s = seg(url);
    return s[0] === "packages" && s.length >= 3 ? `${s[1]}/${s[2]}` : undefined;
  },
  async light(pkg, ctx) {
    const d = await getJson<any>(`https://packagist.org/packages/${pkg}.json`, ctx.signal);
    const p = d.package;
    const header = metaBlock(`${pkg} (Packagist)`, {
      description: p?.description,
      repository: p?.repository,
      downloads: p?.downloads?.total,
    });
    return { kind: "package-info", title: pkg, content: header };
  },
  async full(pkg, ctx) {
    const d = await getJson<any>(`https://packagist.org/packages/${pkg}.json`, ctx.signal);
    const versions = d.package?.versions ?? {};
    const keys = Object.keys(versions);
    const stable = keys.find((v) => !v.startsWith("dev-")) ?? keys[0];
    if (!stable) throw new FetchError(`No versions found for ${pkg}`);
    const dist = versions[stable]?.dist;
    if (!dist?.url) throw new FetchError(`No dist archive for ${pkg}`);
    return fullFromArchive(dist.url, "pkg.zip", ctx, metaBlock(`${pkg}@${stable} (Packagist)`, { description: d.package?.description }));
  },
};
