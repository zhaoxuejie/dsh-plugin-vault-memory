// 高级巡检规则单测：mock 嵌入下 missing_link / duplicate / stale 的产出与阈值/去重
import { test } from "node:test";
import assert from "node:assert/strict";
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
