import { defineHandler } from "../handler.ts";
import type { Registry } from "./common.ts";
import { crates } from "./crates.ts";
import { go } from "./go.ts";
import { hex } from "./hex.ts";
import { maven } from "./maven.ts";
import { npm } from "./npm.ts";
import { packagist } from "./packagist.ts";
import { pypi } from "./pypi.ts";
import { rubygems } from "./rubygems.ts";

export type { Registry } from "./common.ts";

export const REGISTRIES: Registry[] = [npm, pypi, crates, go, rubygems, packagist, hex, maven];

function resolve(url: URL): { registry: Registry; pkg: string } | undefined {
  for (const registry of REGISTRIES) {
    const pkg = registry.match(url);
    if (pkg) return { registry, pkg };
  }
  return undefined;
}

export const registryHandler = defineHandler({
  name: "packages",
  description: `Package registries (${REGISTRIES.map((r) => r.name).join(", ")}): metadata+readme (light) or download+extract (full)`,
  match: (url) => resolve(url) !== undefined,
  async fetch(url, ctx) {
    const { registry, pkg } = resolve(url)!;
    if (ctx.mode === "full" && registry.full) return registry.full(pkg, ctx);
    return registry.light(pkg, ctx);
  },
});
