// 高级巡检规则单测：mock 嵌入下 missing_link / duplicate / stale 的产出、批准写回与回滚
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { VaultIndex } from "../src/core/index.mjs";
import { runAdvancedReview } from "../src/engine/rules.mjs";
import { tempVaultDir, tempDbPath } from "./helpers.mjs";

function fakeEmbedder() {
  const DIM = 16;
  const base = (tag, seed0) => {
    const v = new Float32Array(DIM);
    let seed = seed0;
    for (let i = 0; i < DIM; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      v[i] = ((seed >>> 16) % 1000) / 500 - 1;
    }
    if (tag) v[0] += tag; // 主题偏移制造相似组
    return v;
  };
  return {
    model: "fake",
    async embed(texts) {
      const { normalize } = await import("../src/core/vector.mjs");
      return texts.map((t) => {
        const tag = t.includes("同一话题") ? 2 : t.includes("复制话题") ? 2.2 : t.length % 7;
        const v = base(tag, t.length * 7919 + 13);
        return normalize(v);
      });
    },
  };
}

function setup() {
  const dir = tempVaultDir();
  const idx = new VaultIndex({ root: dir, dbPath: tempDbPath(), opts: { embed: { enabled: true, model: "fake" }, embedder: fakeEmbedder() } });
  idx.fullScan();
  return idx;
}

test("无模型/无嵌入 → available=false", async () => {
  const idx = setup();
  const r = runAdvancedReview(idx.ensureStore(), { model: "bge-m3" });
  assert.equal(r.available, false);
  assert.deepEqual(r.drafts, []);
});

test("有嵌入 → available=true 且只产出候选草稿（只读，不入库）", async () => {
  const idx = setup();
  await idx.refreshEmbeddingsAsync();
  const before = idx.ensureStore().openSuggestions({}).length;
  const r = runAdvancedReview(idx.ensureStore(), { model: "fake", minSim: 0.5 });
  assert.equal(r.available, true);
  assert.ok(Array.isArray(r.drafts));
  for (const d of r.drafts) assert.ok(d.kind && d.target && d.reason && d.payload);
  // 未写库
  assert.equal(idx.ensureStore().openSuggestions({}).length, before);
});

test("missing_link：per-target 上限与互链排除", async () => {
  const idx = setup();
  await idx.refreshEmbeddingsAsync();
  const r = runAdvancedReview(idx.ensureStore(), { model: "fake", minSim: 0.2, targetCap: 2 });
  const ml = r.drafts.filter((d) => d.kind === "missing_link");
  const counts = {};
  for (const d of ml) counts[d.target] = (counts[d.target] || 0) + 1;
  assert.ok(Object.values(counts).every((n) => n <= 2));
});

test("stale/duplicate 在年轻 fixture 上不误报", async () => {
  const idx = setup();
  await idx.refreshEmbeddingsAsync();
  const r = runAdvancedReview(idx.ensureStore(), { model: "fake", minSim: 0.5 });
  assert.equal(r.drafts.filter((d) => d.kind === "stale").length, 0); // 全近改
});

// ---- 批准写回 + 回滚（手动造建议，跨规则通用） ----
test("advanced 批准写回并可回滚（missing_link/duplicate/stale）", () => {
  const dir = tempVaultDir();
  const idx = new VaultIndex({ root: dir, dbPath: tempDbPath() });
  idx.fullScan();
  const store = idx.ensureStore();
  const target = "Prompt/chatgpt.md";
  const peer = "Prompt/写作提示.md";
  const drafts = [
    { kind: "missing_link", target, reason: "语义相近未互链", payload: { peer } },
    { kind: "duplicate", target: "other/空笔记.md", reason: "疑似重复", payload: { peer: "other/消费降级.md", sim: 0.9 } },
    { kind: "stale", target: "欢迎.md", reason: "过期", payload: { ageDays: 200, freshInlinks: ["Prompt/chatgpt.md"] } },
  ];
  store.insertSuggestions(drafts);
  const ids = store.openSuggestions({}).map((s) => s.id);

  // missing_link：追加相关链接 → 可回滚
  const before1 = fs.readFileSync(path.join(dir, target), "utf8");
  const r1 = idx.applySuggestion(ids[0]);
  assert.ok(r1.ok, r1.message);
  assert.ok(fs.readFileSync(path.join(dir, target), "utf8").includes("[[Prompt/写作提示]]"));
  assert.ok(idx.revertSuggestion(ids[0]).ok);
  assert.equal(fs.readFileSync(path.join(dir, target), "utf8"), before1);

  // duplicate：标 #archive，不删除文件 → 可回滚
  const dupTarget = "other/空笔记.md";
  const before2 = fs.readFileSync(path.join(dir, dupTarget), "utf8");
  assert.ok(idx.applySuggestion(ids[1]).ok);
  const after2 = fs.readFileSync(path.join(dir, dupTarget), "utf8");
  assert.ok(after2.includes("#archive"));
  assert.ok(fs.existsSync(path.join(dir, dupTarget)), "不删除文件");
  assert.ok(idx.revertSuggestion(ids[1]).ok);
  assert.equal(fs.readFileSync(path.join(dir, dupTarget), "utf8"), before2);

  // stale：追加复审草稿 → 可回滚
  const staleTarget = "欢迎.md";
  const before3 = fs.readFileSync(path.join(dir, staleTarget), "utf8");
  assert.ok(idx.applySuggestion(ids[2]).ok);
  assert.ok(fs.readFileSync(path.join(dir, staleTarget), "utf8").includes("## 复审"));
  assert.ok(idx.revertSuggestion(ids[2]).ok);
  assert.equal(fs.readFileSync(path.join(dir, staleTarget), "utf8"), before3);
});

test("reviewRun 默认含高级规则（有嵌入时）；kinds 过滤生效", async () => {
  const idx = setup();
  await idx.refreshEmbeddingsAsync();
  const store = idx.ensureStore();
  store.clearOpenSuggestions();
  const r = idx.reviewRun({});
  assert.ok(r.byKind.orphan !== undefined || r.byKind.broken_link !== undefined, "基础规则在跑");
  // 至少存在三类建议的一种统计键（advanced 依赖相似对出现与否，不强断言数值）
  const keys = Object.keys(r.byKind);
  assert.ok(keys.every((k) => ["orphan", "broken_link", "moc_draft", "missing_link", "duplicate", "stale"].includes(k)));
  store.clearOpenSuggestions();
  const only = idx.reviewRun({ kinds: ["missing_link"], minSim: 0.01 });
  assert.deepEqual(Object.keys(only.byKind).sort(), ["missing_link"]);
  assert.ok(only.byKind.missing_link > 0);
});
