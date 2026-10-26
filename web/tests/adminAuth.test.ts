import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ADMIN_WRITE_PATHS,
  FailThrottle,
  adminPasswordOk,
  isAdminRequest,
  presentedAdminPassword,
  requiresAdmin,
} from "../lib/adminAuth";

const hdrs = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null });

test("adminPasswordOk: exact + trimmed match opens", () => {
  const env = { ADMIN_PASSWORD: " hunter2 " };
  assert.equal(adminPasswordOk("hunter2", env), true);
  assert.equal(adminPasswordOk("hunter2 ", env), true);
});

test("adminPasswordOk: mismatch or blank refuses", () => {
  const env = { ADMIN_PASSWORD: "hunter2" };
  assert.equal(adminPasswordOk("hunter3", env), false);
  assert.equal(adminPasswordOk("", env), false);
  assert.equal(adminPasswordOk("   ", env), false);
});

test("adminPasswordOk: no configured password → refused (fail closed)", () => {
  assert.equal(adminPasswordOk("anything", {}), false);
  assert.equal(adminPasswordOk("", {}), false);
  assert.equal(adminPasswordOk("anything", { ADMIN_PASSWORD: "  " }), false);
});

test("presentedAdminPassword: x-admin-password header, then Bearer", () => {
  assert.equal(presentedAdminPassword(hdrs({ "x-admin-password": "a" })), "a");
  assert.equal(presentedAdminPassword(hdrs({ authorization: "Bearer b" })), "b");
  assert.equal(presentedAdminPassword(hdrs({ authorization: "Basic b" })), "");
  assert.equal(presentedAdminPassword(hdrs({})), "");
});

test("isAdminRequest: header must match the configured password", () => {
  const env = { ADMIN_PASSWORD: "pw" };
  assert.equal(isAdminRequest({ headers: hdrs({ "x-admin-password": "pw" }) }, env), true);
  assert.equal(isAdminRequest({ headers: hdrs({ authorization: "Bearer pw" }) }, env), true);
  assert.equal(isAdminRequest({ headers: hdrs({ "x-admin-password": "nope" }) }, env), false);
  assert.equal(isAdminRequest({ headers: hdrs({}) }, env), false);
});

test("requiresAdmin: writes to the protected paths only, reads always open", () => {
  for (const p of ADMIN_WRITE_PATHS) {
    assert.equal(requiresAdmin("POST", p), true, p);
    assert.equal(requiresAdmin("post", `${p}/`), true, `${p}/`);
    assert.equal(requiresAdmin("GET", p), false, p);
    assert.equal(requiresAdmin("OPTIONS", p), false, p);
  }
  // the kill switch and the HMAC webhook keep their own gates
  assert.equal(requiresAdmin("POST", "/api/trading"), false);
  assert.equal(requiresAdmin("POST", "/api/xt-alerts"), false);
});

test("requiresAdmin: the proxy matcher lists exactly the protected paths", () => {
  // Next requires a static literal matcher, so the list is duplicated in
  // proxy.ts — read it as text (importing it pulls in next/server)
  const src = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");
  const m = src.match(/matcher:\s*\[([^\]]*)\]/);
  assert.ok(m, "proxy.ts has a literal matcher array");
  const listed = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert.deepEqual(listed.sort(), [...ADMIN_WRITE_PATHS].sort());
});

test("FailThrottle: blocks after max failures, expires after the window, ok() clears", () => {
  const t = new FailThrottle(3, 1000);
  t.fail("ip", 0);
  t.fail("ip", 0);
  assert.equal(t.blocked("ip", 0), false);
  t.fail("ip", 0);
  assert.equal(t.blocked("ip", 500), true);
  assert.equal(t.blocked("ip", 1001), false);
  t.fail("x", 0);
  t.ok("x");
  assert.equal(t.blocked("x", 0), false);
});
