// Tests for the SSRF guard's allowPrivateNetwork seam: explicit flag in,
// verdict out. No config file is touched — the flag's default (config read)
// is exercised by callers, the boolean here is the pure path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPublicTarget } from "../fetch/handlers/handler.ts";

test("ssrf: blocks loopback and private literals by default", async () => {
  for (const url of [
    "http://127.0.0.1:8080/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://[::1]:3000/",
  ]) {
    await assert.rejects(() => assertPublicTarget(new URL(url), false), /Blocked/);
  }
});

test("ssrf: allowPrivateNetwork skips private-address checks", async () => {
  // Resolve succeeds: the guard returns without a DNS lookup for literal IPs.
  await assert.doesNotReject(() => assertPublicTarget(new URL("http://127.0.0.1:8080/"), true));
  await assert.doesNotReject(() => assertPublicTarget(new URL("http://169.254.169.254/"), true));
});

test("ssrf: scheme check applies even when private networks are allowed", async () => {
  await assert.rejects(() => assertPublicTarget(new URL("file:///etc/passwd"), true), /Unsupported scheme/);
});

// ── guardedLookup: connect-time enforcement (the rebinding closure) ──────────

import { guardedLookup, type LookupFn } from "../fetch/handlers/handler.ts";

function fakeLookup(
  map: Record<string, Array<{ address: string; family: number }>>,
  error?: Error,
): LookupFn {
  return ((hostname: string, _o: unknown, cb: (err: unknown, a?: unknown, f?: number) => void) => {
    if (error) return cb(error);
    cb(null, map[hostname] ?? []);
  }) as unknown as LookupFn;
}

test("ssrf: guardedLookup rejects private answers at connect time", async () => {
  const lookup = guardedLookup(fakeLookup({
    "rebind.example": [{ address: "169.254.169.254", family: 4 }],
  }));
  await new Promise<void>((resolve) => {
    lookup("rebind.example", { all: true }, (err) => {
      assert.ok(err instanceof Error && /private address/.test(err.message));
      resolve();
    });
  });
});

test("ssrf: guardedLookup passes public answers in both callback forms", async () => {
  const lookup = guardedLookup(fakeLookup({
    "ok.example": [{ address: "1.2.3.4", family: 4 }],
  }));
  await new Promise<void>((resolve) => {
    lookup("ok.example", { all: true }, (err, addr) => {
      assert.ifError(err);
      assert.deepEqual(addr, [{ address: "1.2.3.4", family: 4 }]);
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    lookup("ok.example", {}, (err, addr, family) => {
      assert.ifError(err);
      assert.equal(addr, "1.2.3.4");
      assert.equal(family, 4);
      resolve();
    });
  });
});

test("ssrf: guardedLookup honors allowPrivateNetwork passthrough", async () => {
  const lookup = guardedLookup(fakeLookup({
    "local.example": [{ address: "127.0.0.1", family: 4 }],
  }), true);
  await new Promise<void>((resolve) => {
    lookup("local.example", { all: true }, (err) => {
      assert.ifError(err);
      resolve();
    });
  });
});

test("ssrf: guardedLookup propagates base lookup errors", async () => {
  const lookup = guardedLookup(fakeLookup({}, new Error("boom")));
  await new Promise<void>((resolve) => {
    lookup("x.example", { all: true }, (err) => {
      assert.ok(err instanceof Error && err.message === "boom");
      resolve();
    });
  });
});
