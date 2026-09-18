import { FetchError, getJson } from "../handler.ts";
import { type Registry, fullFromArchive, metaBlock, seg } from "./common.ts";

export const npm: Registry = {
  name: "npm",
  match: (url) => {
    if (url.hostname === "registry.npmjs.org") return seg(url).slice(0, 2).join("/");
    if (/(^|\.)npmjs\.com$/.test(url.hostname)) {
      const s = seg(url);
      if (s[0] === "package") return s.slice(1, s[1]?.startsWith("@") ? 3 : 2).join("/");
    }
    // pi.dev's catalog is npm's "pi-package" keyword slice, so /packages/<name> is that npm package.
    // Going to the registry skips the rendered page, which strips readme images and carries the site chrome.
    // Scoped names 404 there, so one segment is the whole identifier.
    if (/^(www\.)?pi\.dev$/.test(url.hostname)) {
      const s = seg(url);
      if (s[0] === "packages" && s[1]) return s[1];
    }
    return undefined;
  },
  async light(pkg, ctx) {
    const d = await getJson<any>(`https://registry.npmjs.org/${pkg}`, ctx.signal);
    const latest = d["dist-tags"]?.latest;
    const header = metaBlock(`${pkg} (npm)`, {
      version: latest,
      description: d.description,
      homepage: d.homepage,
      repository: d.repository?.url,
    });
    return {
      kind: "package-info",
      title: pkg,
      content: `${header}\n\n---\n\n${d.readme ?? "(no readme in registry)"}`,
    };
  },
  async full(pkg, ctx) {
    const d = await getJson<any>(`https://registry.npmjs.org/${pkg}`, ctx.signal);
    const latest = d["dist-tags"]?.latest;
    const tarball = d.versions?.[latest]?.dist?.tarball;
    if (!tarball) throw new FetchError(`No tarball found for ${pkg}`);
    return fullFromArchive(tarball, "pkg.tgz", ctx, metaBlock(`${pkg}@${latest} (npm)`, { description: d.description }));
  },
};
