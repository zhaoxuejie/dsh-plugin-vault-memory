// v1.1 语义检索单测：fake embedder（确定性向量）验证分块/入库/semantic/hybrid/回退
import { test } from "node:test";
import assert from "node:assert/strict";
import { VaultIndex } from "../src/core/index.mjs";
import { splitSections } from "../src/core/sections.mjs";
import { cosine, normalize, rrfFuse, encodeVec, decodeVec } from "../src/core/vector.mjs";
import { tempVaultDir, tempDbPath } from "./helpers.mjs";

/** 确定性伪向量：按文本特征哈希到 32 维单位向量（带主题偏移，可制造相似）。 */
function fakeEmbedder() {
  const DIM = 32;
  const vecOf = (text) => {
    const v = new Float32Array(DIM);
    let seed = 0;
    for (const ch of String(text)) seed = (seed * 31 + ch.codePointAt(0)) >>> 0;
    for (let i = 0; i < DIM; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      v[i] = ((seed >>> 16) % 1000) / 500 - 1;
    }
    // 使含"消费"的文本向量前两维偏向 +1（语义相近组）
    const bias = String(text).includes("消费") ? 1 : String(text).includes("预算") ? 0.9 : 0;
    v[0] += bias;
    v[1] += bias;
    return normalize(v);
  };
  return {
    model: "fake",
    async embed(texts) {
      return texts.map(vecOf);
    },
  };
}

function setup() {
  const dir = tempVaultDir(); // fixture：消费降级/预算类两篇 + 其他
  const idx = new VaultIndex({ root: dir, dbPath: tempDbPath(), opts: { embed: { enabled: true, model: "fake" }, embedder: fakeEmbedder() } });
  idx.fullScan();
  return idx;
}

test("分块：纯文本切成可嵌入章节", () => {
  const s = splitSections("# 标题\n正文甲\n## 小节\n正文乙\n\n段落二", { maxChars: 200 });
  assert.ok(s.length >= 2);
  assert.ok(s[0].heading.includes("标题"));
});

test("向量工具：编码往返与余弦对称", () => {
  const a = new Float32Array([1, 2, 3, 0]);
  const b = new Float32Array([2, 4, 6, 0]);
  assert.ok(cosine(a, b) > 0.99);
  const buf = encodeVec(a);
  const back = decodeVec(buf);
  assert.equal(back.length, 4);
  assert.equal(back[0], 1);
});

test("refreshEmbeddings：分块入库、缺补满、幂等", async () => {
  const idx = setup();
  const r1 = await idx.refreshEmbeddingsAsync();
  assert.equal(r1.ok, true);
  assert.ok(r1.embedded > 0);
  const store = idx.ensureStore();
  assert.ok(store.hasEmbeddings("fake"));
  assert.ok(store.embeddedNoteCount("fake") >= 9);
  const r2 = await idx.refreshEmbeddingsAsync();
  assert.equal(r2.ok, true);
  assert.equal(r2.embedded, 0); // 已补满
});

test("semantic 检索：词面不同但语义相近可命中（预算→消费主题）", async () => {
  const idx = setup();
  await idx.refreshEmbeddingsAsync();
  const r = await idx.searchSmart("个人预算与开支计划", { mode: "semantic" });
  assert.equal(r.engine, "semantic");
  assert.ok(r.hits.some((h) => h.path.includes("消费降级")), "语义相似笔记应命中");
});

test("hybrid：引擎标记 + RRF 结果非空且含 path", async () => {
  const idx = setup();
  await idx.refreshEmbeddingsAsync();
  const r = await idx.searchSmart("消费降级", { mode: "hybrid" });
  assert.equal(r.engine, "hybrid");
  assert.ok(r.total >= 1);
  assert.ok(r.hits.every((h) => h.path && h.title && typeof h.snippet === "string"));
});

test("fts 模式不受嵌入影响；embedder 抛错时回退 fts", async () => {
  const idx = setup();
  const rfts = await idx.searchSmart("提示词", { mode: "fts" });
  assert.equal(rfts.engine, "fts");
  // 让 embedder 失效（换一个必然抛错的）
  idx.embedder = { async embed() { throw new Error("down"); } };
  const r = await idx.searchSmart("提示词", { mode: "hybrid" });
  assert.equal(r.engine, "fts");
  assert.ok(r.total >= 1);
});

test("RRF 融合纯函数", () => {
  const a = [{ path: "x" }, { path: "y" }];
  const b = [{ path: "y" }, { path: "z" }];
  const fused = rrfFuse(a, b, 60);
  assert.deepEqual(fused.map((f) => f.path), ["y", "x", "z"]);
});
