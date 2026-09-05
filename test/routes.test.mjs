// 宿主路由单测：mock webServer 捕获注册，直调 handler 验证契约。
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { registerVaultRoutes } from "../src/server/routes.mjs";
import { VaultIndex } from "../src/core/index.mjs";
import { resolveConfig } from "../src/config.mjs";
import { tempVaultDir, tempDbPath } from "./helpers.mjs";

function makeRes() {
  const res = {
    status: 0,
    body: "",
    writeHead(s) {
      this.status = s;
    },
    end(b) {
      this.body = b;
    },
  };
  return res;
}
function makeReq(method, payload) {
  const req = {
    method,
    listeners: {},
    on(evt, cb) {
      this.listeners[evt] = cb;
    },
    destroy() {},
  };
  // 立即交付 body
  queueMicrotask(() => {
    if (payload !== undefined) {
      req.listeners.data && req.listeners.data(Buffer.from(JSON.stringify(payload), "utf8"));
    }
    req.listeners.end && req.listeners.end();
  });
  return req;
}

const vaultDir = tempVaultDir();
const index = new VaultIndex({ root: vaultDir, dbPath: tempDbPath() });
index.fullScan();
const runtime = {
  cfg: resolveConfig({ vaults: [{ path: vaultDir, label: "测试库" }] }),
  vaultKeys: [{ rootAbs: path.resolve(vaultDir), label: "测试库", path: vaultDir }],
  indexes: new Map([[path.resolve(vaultDir), index]]),
  resolveVault() {
    return { label: "测试库", index };
  },
  async applySettingsPatch() {
    throw Object.assign(new Error("settings 服务不可用"), { code: "INVALID_ARG" });
  },
};

function routes() {
  const table = {};
  const webServer = {
    register({ path: p, handler }) {
      table[p] = handler;
    },
  };
  registerVaultRoutes(webServer, runtime);
  return table;
}

test("health：返回库概览", async () => {
  const t = routes();
  const res = makeRes();
  await t["/vault-memory/health"](makeReq("GET"), res);
  assert.equal(res.status, 200);
  const j = JSON.parse(res.body);
  assert.equal(j.enabled, true);
  assert.equal(j.vaults.length, 1);
  assert.equal(j.vaults[0].label, "测试库");
  assert.ok(j.vaults[0].ready);
  assert.ok(j.vaults[0].notes >= 9);
});

test("capture preview→commit→重名 409", async () => {
  const t = routes();
  const payload = { title: "路由捕获", body: "由路由写入的正文", folder: "Captures" };
  const p1 = makeRes();
  await t["/vault-memory/capture/preview"](makeReq("POST", payload), p1);
  assert.equal(p1.status, 200);
  const j1 = JSON.parse(p1.body);
  assert.equal(j1.preview, true);
  assert.ok(j1.path.startsWith("Captures/路由捕获.md"));
  // 尚未写盘
  const c0 = makeRes();
  await t["/vault-memory/capture/commit"](makeReq("POST", payload), c0);
  assert.equal(c0.status, 200);
  const jc = JSON.parse(c0.body);
  assert.equal(jc.ok, true);
  // 再次 preview → 409 NOTE_EXISTS
  const p2 = makeRes();
  await t["/vault-memory/capture/preview"](makeReq("POST", payload), p2);
  assert.equal(p2.status, 409);
  const j2 = JSON.parse(p2.body);
  assert.equal(j2.error.code, "NOTE_EXISTS");
});

test("capture：缺 title/body → 400", async () => {
  const t = routes();
  const res = makeRes();
  await t["/vault-memory/capture/preview"](makeReq("POST", { title: "" }), res);
  assert.equal(res.status, 400);
});

test("settings POST 非法键 → 400（服务缺失时）", async () => {
  const t = routes();
  const res = makeRes();
  await t["/vault-memory/settings"](makeReq("POST", { evil: true }), res);
  assert.equal(res.status, 400);
  const j = JSON.parse(res.body);
  assert.equal(j.error.code, "INVALID_ARG");
});

test("review：run 产出建议、GET 列表、approve/dismiss 流转", async () => {
  const t = routes();
  const run = makeRes();
  await t["/vault-memory/review"](makeReq("POST", { action: "run" }), run);
  assert.equal(run.status, 200);
  const jr = JSON.parse(run.body);
  assert.equal(jr.ok, true);
  assert.ok(Array.isArray(jr.results) && jr.results.length === 1);
  const list = makeRes();
  await t["/vault-memory/review"](makeReq("GET"), list);
  assert.equal(list.status, 200);
  const jl = JSON.parse(list.body);
  assert.ok(Array.isArray(jl.items));
  if (jl.items.length > 0) {
    const first = jl.items[0];
    const dis = makeRes();
    await t["/vault-memory/review"](makeReq("POST", { action: "dismiss", id: first.id }), dis);
    assert.equal(dis.status, 200);
    const jd = JSON.parse(dis.body);
    assert.equal(jd.ok, true);
  }
});
