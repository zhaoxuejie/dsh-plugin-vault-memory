// 工具层测试：通过 fake ctx 捕获 tool 定义，直接调 execute 验证契约与错误码。
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { VaultIndex } from "../src/core/index.mjs";
import { VAULT_ERROR_CODES as C } from "../src/errors.mjs";
import { registerVaultSearchTool } from "../src/tools/vault-search.mjs";
import { registerVaultQueryTool } from "../src/tools/vault-query.mjs";
import { registerVaultReadTool } from "../src/tools/vault-read.mjs";
import { tempVaultDir, tempDbPath } from "./helpers.mjs";

function captureTool(registerFn) {
  let def = null;
  const ctx = {
    tools: {
      register(d) {
        def = d;
        return () => {};
      },
    },
  };
  registerFn(ctx, runtime);
  return def;
}

const vaultDir = tempVaultDir();
const index = new VaultIndex({ root: vaultDir, dbPath: tempDbPath() });
index.fullScan();
const runtime = {
  cfg: { searchMaxResults: 50, snippetChars: 200 },
  resolveVault(sel) {
    return { label: "测试库", index };
  },
};

const search = captureTool(registerVaultSearchTool);
const query = captureTool(registerVaultQueryTool);
const read = captureTool(registerVaultReadTool);

test("vault_search：中文命中 + 溯源 path + snippet", async () => {
  const r = await search.execute({ q: "提示词" });
  assert.equal(r.vault, "测试库");
  assert.ok(r.total >= 1);
  assert.ok(r.hits.some((h) => h.path === "Prompt/chatgpt.md"));
  const hit = r.hits.find((h) => h.path === "Prompt/chatgpt.md");
  assert.ok(hit.snippet.includes("提示词"));
  assert.ok(hit.score >= 0);
});

test("vault_search：2 字中文词命中（bigram）", async () => {
  const r = await search.execute({ q: "省钱" });
  assert.ok(r.hits.some((h) => h.path === "other/消费降级.md"));
});

test("vault_search：单字短查询 LIKE 兜底", async () => {
  const r = await search.execute({ q: "省" });
  assert.ok(r.hits.some((h) => h.path === "other/消费降级.md"));
});

test("vault_search：零命中不编造", async () => {
  const r = await search.execute({ q: "绝对不存在的词条XYZ" });
  assert.equal(r.total, 0);
  assert.deepEqual(r.hits, []);
});

test("vault_search：folder 与 tag 过滤", async () => {
  const byFolder = await search.execute({ q: "提示", folder: "Prompt" });
  assert.ok(byFolder.hits.every((h) => h.path.startsWith("Prompt/")));
  const byTag = await search.execute({ q: "提示", tag: "效率" });
  assert.ok(byTag.hits.some((h) => h.path === "Prompt/chatgpt.md"));
});

test("vault_search：空 q 报 INVALID_ARG", async () => {
  await assert.rejects(() => search.execute({ q: "  " }), (e) => e.code === C.INVALID_ARG);
});

test("vault_query：目录/标签/时间/fm 键", async () => {
  const folder = await query.execute({ folder: "Prompt" });
  assert.equal(folder.total, 2);
  assert.ok(folder.notes.every((n) => n.path.startsWith("Prompt/")));
  const tag = await query.execute({ tag: "效率" });
  assert.equal(tag.total, 2);
  const src = await query.execute({ has_fm_key: "source", fields: ["source"] });
  assert.equal(src.total, 2);
  const withFm = src.notes.find((n) => n.path === "Clippings/网页剪辑.md");
  assert.ok(withFm.fm.source.startsWith("https://"));
  const since = await query.execute({ modified_since: "2000-01-01" });
  assert.equal(since.total, 9);
});

test("vault_query：非法 sort 报 INVALID_ARG", async () => {
  await assert.rejects(() => query.execute({ sort: "nope" }), (e) => e.code === C.INVALID_ARG);
});

test("vault_read：正常读取 + 行窗口 + 截断标记", async () => {
  const r = await read.execute({ path: "Prompt/chatgpt.md", limit: 3 });
  assert.equal(r.path, "Prompt/chatgpt.md");
  assert.equal(r.lines.length, 3);
  assert.equal(r.lines[0].n, 1);
  assert.equal(r.truncated, true);
  const r2 = await read.execute({ path: "Prompt/chatgpt", offset: 2, limit: 2 });
  assert.equal(r2.resolvedPath, "Prompt/chatgpt.md");
  assert.equal(r2.lines[0].n, 2);
});

test("vault_read：路径逃逸拒绝 / 不存在报 NOTE_NOT_FOUND", async () => {
  await assert.rejects(() => read.execute({ path: "../secret.md" }), (e) => e.code === C.VAULT_PATH_ESCAPE);
  await assert.rejects(() => read.execute({ path: "C:\\x.md" }), (e) => e.code === C.VAULT_PATH_ESCAPE);
  await assert.rejects(() => read.execute({ path: "nope.md" }), (e) => e.code === C.NOTE_NOT_FOUND);
});

test("未配置 vault 时 resolveVault 报 VAULT_NOT_CONFIGURED", async () => {
  const emptyRuntime = { cfg: { searchMaxResults: 50 }, resolveVault() { throw Object.assign(new Error("未配置"), { code: C.VAULT_NOT_CONFIGURED }); } };
  const ctx = { tools: { register(d) { this.d = d; return () => {}; } } };
  registerVaultSearchTool(ctx, emptyRuntime);
  await assert.rejects(() => ctx.tools.d.execute({ q: "x" }), (e) => e.code === C.VAULT_NOT_CONFIGURED);
});
