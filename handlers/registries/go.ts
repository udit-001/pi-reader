import { htmlToMarkdown } from "../html.ts";
import { getText } from "../handler.ts";
import { type Registry, fullFromArchive, metaBlock, seg } from "./common.ts";

export const go: Registry = {
  name: "go",
  match: (url) => (url.hostname === "pkg.go.dev" ? seg(url).join("/") : undefined),
  async light(pkg, ctx) {
    // pkg.go.dev renders full docs server-side; the article extract is genuinely good
    const { text } = await getText(`https://pkg.go.dev/${pkg}`, ctx.signal);
    return { kind: "package-info", title: pkg, content: htmlToMarkdown(text).markdown };
  },
  async full(pkg, ctx) {
    const mod = pkg.replace(/@.*$/, "");
    const esc = mod.replace(/[A-Z]/g, (c) => "!" + c.toLowerCase());
    const info = JSON.parse((await getText(`https://proxy.golang.org/${esc}/@latest`, ctx.signal)).text);
    return fullFromArchive(
      `https://proxy.golang.org/${esc}/@v/${info.Version}.zip`,
      "mod.zip",
      ctx,
      metaBlock(`${mod}@${info.Version} (Go)`, {}),
    );
  },
};
