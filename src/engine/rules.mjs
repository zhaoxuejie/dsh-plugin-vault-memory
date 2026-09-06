// dsh-plugin-vault-memory — 巡检引擎：纯规则 → 建议草稿 → 入库
// 原则：引擎零写权限（只读 store 出建议），写盘只发生在审查队列逐条批准后（apply.mjs 的职责）。
// 规则 v1：orphan / broken_link / moc_draft；高级规则（复用语义嵌入）：
//   missing_link（语义相似但未互链）/ duplicate（疑似重复）/ stale（过期复审），
//   由 runAdvancedReview 计算（只读，不入库）。

import { cosine, normalize } from "../core/vector.mjs";

const ADV_KINDS = ["missing_link", "duplicate", "stale"];

/**
 * 运行一轮巡检，返回按 kind 的建议草稿（未入库）。
 * @param {import("./store.mjs").VaultStore} store
 * @param {{ kinds?: string[], mocThreshold?: number, caps?: Record<string, number> }} opts
 * @returns {{ drafts: Array<{kind, target, reason, payload}> }}
 */
export function runReview(store, opts = {}) {
  const kinds = new Set(opts.kinds && opts.kinds.length > 0 ? opts.kinds : ["orphan", "broken_link", "moc_draft"]);
  const mocThreshold = opts.mocThreshold ?? 8;
  const caps = { orphan: 50, broken_link: 100, moc_draft: 10, ...(opts.caps || {}) };
  const drafts = [];
  if (kinds.has("orphan")) drafts.push(...orphanDrafts(store, caps.orphan));
  if (kinds.has("broken_link")) drafts.push(...brokenLinkDrafts(store, caps.broken_link));
  if (kinds.has("moc_draft")) drafts.push(...mocDrafts(store, mocThreshold, caps.moc_draft));
  return { drafts };
}

/** 去重：与 store 中已 open 的建议按 kind+target(+peer) 去重。 */
export function dedupeOpen(store, drafts) {
  return drafts.filter((d) => store.findOpenSuggestion(d.kind, d.target, d.payload && d.payload.peer) === null);
}

// ---------- orphan ----------

function orphanDrafts(store, cap) {
  const notes = store.orphanCandidates();
  const drafts = [];
  for (const n of notes) {
    if (drafts.length >= cap) break;
    if (n.wordCount < 20) continue; // 空/极短占位不算孤儿（另列空笔记）
    const base = n.folder ? n.folder : "";
    const proposed = [];
    // 同目录近期笔记 top3
    const siblings = store.queryNotes({ folder: base, sort: "modified_desc", limit: 8 }).filter((x) => x.path !== n.path);
    for (const s of siblings.slice(0, 3)) proposed.push({ path: s.path, why: "同目录近期笔记" });
    // 标题检索 top2（排除同目录已推）
    if (proposed.length < 3) {
      const hits = searchTitles(store, n.title).filter((h) => h.path !== n.path && !proposed.some((p) => p.path === h.path));
      for (const h of hits.slice(0, 2)) proposed.push({ path: h.path, why: "标题相关" });
    }
    drafts.push({
      kind: "orphan",
      target: n.path,
      reason: `无任何笔记引用（${
        n.folder ? `位于 ${n.folder}/` : "位于根目录"
      }）${proposed.length > 0 ? `；建议关联: ${proposed.map((p) => p.path).join("、")}` : "；暂无同目录/相似候选"}`,
      payload: { proposedLinks: proposed },
    });
  }
  return drafts;
}

// ---------- broken_link ----------

function brokenLinkDrafts(store, cap) {
  const broken = store.brokenLinks();
  const drafts = [];
  const seen = new Set();
  for (const b of broken) {
    const key = `${b.fromPath}\u0000${b.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (drafts.length >= cap) break;
    const candidates = resolveCandidates(store, b.target).slice(0, 3);
    drafts.push({
      kind: "broken_link",
      target: b.fromPath,
      reason: `引用了不存在的 [[${b.target}]]${candidates.length > 0 ? `；疑似应为: ${candidates.join("、")}` : "；库内无近似笔记"}`,
      payload: { rawTarget: b.target, candidates },
    });
  }
  return drafts;
}

function resolveCandidates(store, target) {
  const want = target.toLowerCase().replace(/\.md$/i, "");
  const all = store.queryNotes({ sort: "title_asc", limit: 500 });
  const scored = [];
  for (const n of all) {
    const t = n.title.toLowerCase();
    const pathLower = n.path.toLowerCase();
    let score = 0;
    if (t === want) score = 100;
    else if (pathLower === want + ".md" || pathLower === want) score = 95;
    else if (want.length >= 2 && (t.includes(want) || want.includes(t) || pathLower.includes(want))) score = 60 - Math.abs(t.length - want.length);
    else if (want.length >= 2 && [...want].some((ch) => t.includes(ch)) && overlapRatio(t, want) > 0.5) score = 30;
    if (score > 0) scored.push({ path: n.path, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((x) => x.path);
}

function overlapRatio(a, b) {
  let same = 0;
  for (const ch of a) if (b.includes(ch)) same++;
  return same / Math.max(1, Math.max(a.length, b.length));
}

// ---------- moc_draft ----------

function mocDrafts(store, threshold, cap) {
  const drafts = [];
  for (const { folder, count } of store.folderCounts()) {
    if (drafts.length >= cap) break;
    if (count < threshold) continue;
    if (store.hasIndexNote(folder)) continue;
    const children = store.queryNotes({ folder, sort: "title_asc", limit: 200 }).map((n) => n.path);
    const name = folder.split("/").pop();
    const lines = [`# ${name} 目录总览`, "", `> 由 vault-memory 巡检生成草稿（${count} 篇），请人工整理。`, ""];
    for (const p of children) {
      const link = p.replace(/\.md$/i, "");
      lines.push(`- [[${link}]]`);
    }
    drafts.push({
      kind: "moc_draft",
      target: `${folder}/${name}.md`,
      reason: `目录 ${folder}/ 有 ${count} 篇笔记但无总览页`,
      payload: { folder, draftMd: lines.join("\n") + "\n" },
    });
  }
  return drafts;
}

function searchTitles(store, title) {
  const t = title.replace(/[^\p{L}\p{N}_\-/]+/gu, " ").trim();
  if (!t) return [];
  const words = t.split(/\s+/).filter(Boolean);
  const all = store.queryNotes({ sort: "modified_desc", limit: 200 });
  return all
    .filter((n) => words.some((w) => w.length >= 2 && (n.title.includes(w) || n.title.toLowerCase().includes(w.toLowerCase()))))
    .slice(0, 4);
}

// ================================================================
// 高级规则（复用语义嵌入；只读计算，需 store 已含该模型嵌入）
// ================================================================

/**
 * 语义向量辅助：每篇笔记 → 其分块均值单位向量；无嵌入的笔记跳过。
 */
function noteVectors(store, model) {
  const acc = new Map(); // path -> { sum, n, note }
  for (const c of store.embeddingChunks(model)) {
    const note = store.getNoteById(c.noteId);
    if (!note) continue;
    const e = acc.get(note.path) || { sum: new Float32Array(c.vec.length), n: 0, note };
    const v = c.vec;
    for (let i = 0; i < v.length; i++) e.sum[i] += v[i];
    e.n += 1;
    acc.set(note.path, e);
  }
  const out = new Map();
  for (const [path, e] of acc) {
    const mean = new Float32Array(e.sum.length);
    for (let i = 0; i < mean.length; i++) mean[i] = e.sum[i] / e.n;
    out.set(path, { vec: normalize(mean), note: e.note });
  }
  return out;
}

function areLinked(store, aPath, bPath) {
  const a = store.getNote(aPath);
  const b = store.getNote(bPath);
  if (!a || !b) return false;
  const out = store.outlinksOf(a.id).some((o) => o.path === bPath);
  const inl = store.inlinksOf(a.id).some((i) => i.path === bPath);
  return out || inl;
}

function similarPairs(vecs, minSim) {
  const paths = [...vecs.keys()];
  const pairs = [];
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      const sim = cosine(vecs.get(paths[i]).vec, vecs.get(paths[j]).vec);
      if (sim >= minSim) pairs.push({ a: paths[i], b: paths[j], sim });
    }
  }
  return pairs.sort((x, y) => y.sim - x.sim);
}

/**
 * 高级建议（只读）：missing_link / duplicate / stale。
 * @param {import("./store.mjs").VaultStore} store
 * @param {{ model?: string, caps?: Record<string, number> }} opts
 * @returns {{ drafts: Array<{kind, target, reason, payload}>, available: boolean }}
 */
export function runAdvancedReview(store, opts = {}) {
  const model = opts.model;
  if (!model || !store.hasEmbeddings(model)) return { drafts: [], available: false };
  const minSim = opts.minSim ?? 0.6;
  const targetCap = opts.targetCap ?? 3;
  const caps = { missing_link: 15, duplicate: 10, stale: 20, ...(opts.caps || {}) };
  const drafts = [];

  const vecs = noteVectors(store, model);
  if (vecs.size < 2) return { drafts: [], available: false };
  const now = Date.now();

  // ---- missing_link：语义相近（未互链），每篇至多 targetCap 条 ----
  const perTarget = new Map();
  const pairs = similarPairs(vecs, minSim);
  for (const { a, b, sim } of pairs) {
    if (drafts.filter((d) => d.kind === "missing_link").length >= caps.missing_link) break;
    if (areLinked(store, a, b)) continue;
    if ((perTarget.get(a) ?? 0) >= targetCap) continue;
    perTarget.set(a, (perTarget.get(a) ?? 0) + 1);
    drafts.push({
      kind: "missing_link",
      target: a,
      reason: `与 [[${b.replace(/\.md$/i, "")}]] 语义高度相近（相似度 ${sim.toFixed(2)}）但未互链`,
      payload: { peer: b, sim: Math.round(sim * 100) / 100, score: sim },
    });
  }

  // ---- duplicate：相似 ≥0.86 且规模相近 ----
  for (const { a, b, sim } of pairs) {
    if (drafts.filter((d) => d.kind === "duplicate").length >= caps.duplicate) break;
    if (sim < 0.86) break; // pairs 已降序
    const na = vecs.get(a).note;
    const nb = vecs.get(b).note;
    const ratio = Math.max(na.word_count, nb.word_count) / Math.max(1, Math.min(na.word_count, nb.word_count));
    if (ratio > 2.5) continue; // 规模差太多 → 大笔记引用小笔记场景，归 missing_link
    drafts.push({
      kind: "duplicate",
      target: a,
      reason: `与 [[${b.replace(/\.md$/i, "")}]] 高度重合（相似 ${sim.toFixed(2)}，字数 ${na.word_count}/${nb.word_count}），疑似重复`,
      payload: { peer: b, sim: Math.round(sim * 100) / 100, wordsA: na.word_count, wordsB: nb.word_count },
    });
  }

  // ---- stale：久未更新但被仍在活跃更新的笔记引用 ----
  for (const [path, { note }] of vecs) {
    if (drafts.filter((d) => d.kind === "stale").length >= caps.stale) break;
    if (!note.mtime_ms) continue;
    const lastMod = Number(note.mtime_ms);
    const ageDays = (now - lastMod) / 86400000;
    if (ageDays < 180) continue;
    if (note.word_count < 50) continue;
    const inlinkers = store.inlinksOf(note.id);
    const fresh = inlinkers.filter((i) => {
      const inNote = store.getNote(i.path);
      return inNote && now - Number(inNote.mtime_ms) < 30 * 86400000;
    });
    if (fresh.length === 0) continue;
    drafts.push({
      kind: "stale",
      target: path,
      reason: `${Math.round(ageDays)} 天未更新，但 ${fresh.length} 篇引用笔记（${fresh.map((f) => f.path).join("、")}）近 30 天有更新，建议复审`,
      payload: { ageDays: Math.round(ageDays), freshInlinks: fresh.map((f) => f.path) },
    });
  }

  return { drafts, available: true };
}

export { ADV_KINDS };
