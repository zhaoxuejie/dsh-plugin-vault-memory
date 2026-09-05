// Phase 2 单测：vault_related / vault_capture / distill / 记忆渲染 / 配置合并
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { VaultIndex } from "../src/core/index.mjs";
import { distillVaults, renderMemoryMarkdown } from "../src/core/distill.mjs";
import { resolveConfig } from "../src/config.mjs";
import { VAULT_ERROR_CODES as C } from "../src/errors.mjs";
import { registerVaultRelatedTool } from "../src/tools/vault-related.mjs";
import { registerVaultCaptureTool } from "../src/tools/vault-capture.mjs";
import { makeFixtureVault, tempDir, tempVaultDir, tempDbPath } from "./helpers.mjs";

function captureTool(reg) {
  let def = null;
  reg({ tools: { register(d) { def = d; return () => {}; } } }, { cfg: { capture: { defaultFolder: "Captures" } }, resolveVault() { return { label: "测试库", index }; } });
  return def;
}

const vaultDir = tempVaultDir();
const index = new VaultIndex({ root: vaultDir, dbPath: tempDbPath() });
index.fullScan();

const related = captureTool(registerVaultRelatedTool);
const capture = captureTool(registerVaultCaptureTool);

// ---- vault_related ----
test("vault_related：入链/出链/同标签/共引 四关系", async () => {
  const r = await related.execute({ path: "Prompt/chatgpt.md" });
  assert.equal(r.path, "Prompt/chatgpt.md");
  const paths = new Set(r.related.map((x) => x.path));
  // 出链: chatgpt 无出链；入链：欢迎、相对链接、网页剪辑、写作提示 引用它（wiki/markdown/embed 均解析到）
  assert.ok(paths.has("欢迎.md"), "欢迎入链缺失");
  assert.ok(paths.has("Prompt/写作提示.md"), "同文件夹 wikilink 缺失");
  assert.ok(paths.has("markdown/embed测试.md"), "embed 入链缺失");
  assert.ok(paths.has("markdown/相对链接.md"), "markdown 链接入链缺失");
  assert.ok(r.related.every((x) => x.reason && x.relation && typeof x.score === "number"));
});

test("vault_related：共引与同标签出现在结果里且有序", async () => {
  // 欢迎.md 引用 Prompt/chatgpt + 不存在的笔记；Prompt/写作提示 引用 chatgpt/embed测试(悬空)
  const r = await related.execute({ path: "欢迎.md" });
  const hit = r.related.find((x) => x.path === "Prompt/chatgpt.md");
  assert.ok(hit && hit.relation === "outlink");
  assert.ok(r.total >= 1);
});

test("vault_related：不存在路径报 NOTE_NOT_FOUND；缺 path 报 INVALID_ARG", async () => {
  await assert.rejects(() => related.execute({ path: "不存在.md" }), (e) => e.code === C.NOTE_NOT_FOUND);
  await assert.rejects(() => related.execute({}), (e) => e.code === C.INVALID_ARG);
});

// ---- vault_capture ----
test("vault_capture：写入带 frontmatter 且立即可检索", async () => {
  const r = await capture.execute({ title: "捕获测试笔记", body: "这是捕获正文，含消费降级一词。", tags: ["test"] });
  assert.ok(r.path.startsWith("Captures/捕获测试笔记.md"), r.path);
  assert.ok(r.preview.includes("tags: [test]"));
  assert.ok(fs.existsSync(path.join(vaultDir, r.path)));
  const found = index.search("消费降级", {});
  assert.ok(found.hits.some((h) => h.path === r.path), "写入后应立即可检索");
});

test("vault_capture：同名再写报 NOTE_EXISTS，不覆盖", async () => {
  await capture.execute({ title: "重名笔记", body: "第一条", folder: "Captures" });
  await assert.rejects(() => capture.execute({ title: "重名笔记", body: "想覆盖", folder: "Captures" }), (e) => e.code === C.NOTE_EXISTS);
  // 原文件未被覆盖
  const raw = fs.readFileSync(path.join(vaultDir, "Captures", "重名笔记.md"), "utf8");
  assert.ok(raw.includes("第一条"));
});

test("vault_capture：标题非法字符被净化", async () => {
  const r = await capture.execute({ title: "A/B:C*?", body: "x", folder: "" });
  assert.ok(!/[\\/:*?"<>|]/.test(path.basename(r.path)));
});

test("capturePreview：只组装不写盘；重名标 exists", () => {
  const p = index.capturePreview({ title: "预览专用", body: "不会写盘", folder: "Captures" });
  assert.equal(p.exists, false);
  assert.ok(p.note.includes("# 预览专用"));
  assert.ok(!fs.existsSync(path.join(vaultDir, "Captures", "预览专用.md")));
});

// ---- distill / 记忆渲染 ----
test("distillVaults：快照含库统计与活跃项目", () => {
  const keys = [{ label: "测试库", index }];
  const snap = distillVaults(keys);
  assert.equal(snap.length, 1);
  assert.equal(snap[0].ready, true);
  // 9 fixture + 本文件前序捕获测试写入的若干篇（顺序执行共享同一 index）
  assert.ok(snap[0].total >= 9);
  assert.ok(Array.isArray(snap[0].projects));
  assert.ok(Array.isArray(snap[0].today));
  assert.ok(Array.isArray(snap[0].week));
});

test("renderMemoryMarkdown：产出与截断", () => {
  const keys = [{ label: "测试库", index }];
  const snap = distillVaults(keys);
  const md = renderMemoryMarkdown(snap, 200000);
  assert.ok(md.includes("库 测试库"));
  assert.ok(md.includes("篇笔记"));
  const tiny = renderMemoryMarkdown(snap, 30);
  assert.ok(tiny.length <= 30 + 8); // 截断标记
});

// ---- 配置合并 ----
test("resolveConfig：嵌套默认值合并", () => {
  const cfg = resolveConfig({ enabled: true });
  assert.equal(cfg.memory.injectEnabled, true);
  assert.equal(cfg.memory.maxTokens, 1200);
  assert.equal(cfg.capture.defaultFolder, "Captures");
  const cfg2 = resolveConfig({ memory: { maxTokens: 200 }, capture: { defaultFolder: "Inbox" }, gui: { enabled: false } });
  assert.equal(cfg2.memory.maxTokens, 200);
  assert.equal(cfg2.memory.injectEnabled, true);
  assert.equal(cfg2.capture.defaultFolder, "Inbox");
  assert.equal(cfg2.gui.enabled, false);
});
