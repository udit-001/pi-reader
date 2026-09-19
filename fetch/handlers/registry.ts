import type { MagpiHandler } from "./handler.ts";
import { arxivHandler } from "./arxiv.ts";
import { feedHandler } from "./feed.ts";
import { defaultHandler } from "./default.ts";
import { githubHandler } from "./github.ts";
import { gitlabHandler } from "./gitlab.ts";
import { hackerNewsHandler } from "./hackernews.ts";
import { redditHandler } from "./reddit.ts";
import { registryHandler } from "./registries/index.ts";
import { stackExchangeHandler } from "./stackexchange.ts";
import { wikipediaHandler } from "./wikipedia.ts";

// Order matters: specific handlers first, catch-all webpage last.
const handlers: MagpiHandler[] = [
  githubHandler,
  gitlabHandler,
  wikipediaHandler,
  stackExchangeHandler,
  redditHandler,
  hackerNewsHandler,
  arxivHandler,
  registryHandler,
  feedHandler,
  defaultHandler,
];

/** External handlers (from other extensions via pi.events "pi-reader:register-handler") are prepended so they can shadow built-ins for their domains. */
export function registerHandler(h: MagpiHandler): void {
  if (!h || typeof h.name !== "string" || typeof h.match !== "function" || typeof h.fetch !== "function") {
    throw new Error("handler must have { name, match(url), fetch(url, ctx) }; build it with defineHandler()");
  }
  const existing = handlers.findIndex((x) => x.name === h.name);
  if (existing !== -1) handlers.splice(existing, 1);
  handlers.unshift(h);
}

export function resolveHandler(url: URL): MagpiHandler {
  return handlers.find((h) => h.match(url)) ?? defaultHandler;
}

export function listHandlers(): MagpiHandler[] {
  return [...handlers];
}

export async function fetchWithHandler(
  url: URL,
  ctx: { mode: "light" | "full"; entryDir: string; signal?: AbortSignal },
): Promise<import("./handler.ts").HandlerResult | null> {
  const handler = resolveHandler(url);
  if (!handler) return null;
  return handler.fetch(url, ctx);
}
