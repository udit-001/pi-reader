import { FetchError, getJson } from "../handler.ts";
import { type Registry, fullFromArchive, metaBlock, seg } from "./common.ts";

export const maven: Registry = {
  name: "maven",
  match: (url) => {
    const s = seg(url);
    if (/(^|\.)mvnrepository\.com$/.test(url.hostname) && s[0] === "artifact" && s.length >= 3)
      return `${s[1]}:${s[2]}${s[3] ? `:${s[3]}` : ""}`;
    if (url.hostname === "central.sonatype.com" && s[0] === "artifact" && s.length >= 3)
      return `${s[1]}:${s[2]}${s[3] ? `:${s[3]}` : ""}`;
    return undefined;
  },
  async light(pkg, ctx) {
    const parts = pkg.split(":");
    const g = parts[0] ?? "";
    const a = parts[1] ?? "";
    const d = await getJson<any>(
      `https://search.maven.org/solrsearch/select?q=g:%22${g}%22+AND+a:%22${a}%22&rows=1&wt=json`,
      ctx.signal,
    );
    const doc = d.response?.docs?.[0];
    if (!doc) throw new FetchError(`Artifact ${pkg} not found on Maven Central`);
    const header = metaBlock(`${g}:${a} (Maven Central)`, {
      latestVersion: doc.latestVersion,
      repository: `https://repo1.maven.org/maven2/${g.replace(/\./g, "/")}/${a}/`,
    });
    return { kind: "package-info", title: pkg, content: header };
  },
  async full(pkg, ctx) {
    const parts = pkg.split(":");
    const g = parts[0] ?? "";
    const a = parts[1] ?? "";
    const vIn = parts[2];
    let v = vIn;
    if (!v) {
      const d = await getJson<any>(
        `https://search.maven.org/solrsearch/select?q=g:%22${g}%22+AND+a:%22${a}%22&rows=1&wt=json`,
        ctx.signal,
      );
      v = d.response?.docs?.[0]?.latestVersion;
    }
    if (!v) throw new FetchError(`No version found for ${pkg}`);
    const base = `https://repo1.maven.org/maven2/${g.replace(/\./g, "/")}/${a}/${v}/${a}-${v}`;
    // sources jar is the useful one for an LLM; fall back to the main jar
    try {
      return await fullFromArchive(`${base}-sources.jar`, "sources.jar.zip", ctx, metaBlock(`${g}:${a}@${v}`, {}));
    } catch {
      return await fullFromArchive(`${base}.jar`, "artifact.jar.zip", ctx, metaBlock(`${g}:${a}@${v}`, {}));
    }
  },
};
