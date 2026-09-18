// Tests for the curl fetch tier's pure seams: buildCurlArgs (argv construction)
// and parseCurlResponse (-i output → status/headers/body). The execFile
// boundary and binary detection stay behind the module interface.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCurlArgs, parseCurlResponse } from "../curl-fetch.ts";

test("curl: argv carries the Chrome profile, timeout, and the URL last", () => {
  const args = buildCurlArgs("https://example.com/page", { timeoutMs: 12_345 });
  assert.equal(args[args.length - 1], "https://example.com/page"); // after "--", never shell-interpolated
  assert.ok(args.includes("--"));
  assert.ok(args.includes("--http2"));
  assert.ok(args.includes("--compressed"));
  assert.ok(args.includes("--location"));
  const maxTime = args[args.indexOf("--max-time") + 1];
  assert.equal(maxTime, "12"); // rounded to whole seconds
  const uaIdx = args.indexOf("--user-agent");
  assert.match(args[uaIdx + 1]!, /Chrome\/131/);
  assert.ok(args.some((a) => a.startsWith("sec-ch-ua:")));
});

test("curl: parses -i output into status, content type, and body", () => {
  const raw = "HTTP/2 200\r\ncontent-type: text/html; charset=utf-8\r\nserver: vercel\r\n\r\n<html>body</html>";
  const out = parseCurlResponse(raw);
  assert.ok(out);
  assert.equal(out.status, 200);
  assert.equal(out.contentType, "text/html; charset=utf-8");
  assert.equal(out.text, "<html>body</html>");
});

test("curl: handles LF-only header blocks and non-200 statuses", () => {
  const raw = "HTTP/1.1 403 Forbidden\nserver: nginx\n\nblocked";
  const out = parseCurlResponse(raw);
  assert.ok(out);
  assert.equal(out.status, 403);
  assert.equal(out.text, "blocked");
  assert.equal(parseCurlResponse("garbage without headers"), null);
});

test("curl: redirect chains keep the final response, not the hop", () => {
  const raw = [
    "HTTP/1.1 307 Temporary Redirect",
    "location: https://example.com/final",
    "",
    "",
    "HTTP/2 200",
    "content-type: text/html; charset=utf-8",
    "",
    "<html>final body</html>",
  ].join("\r\n");
  const out = parseCurlResponse(raw);
  assert.ok(out);
  assert.equal(out.status, 200);
  assert.equal(out.contentType, "text/html; charset=utf-8");
  assert.equal(out.text, "<html>final body</html>");
});
