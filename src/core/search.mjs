// dsh-plugin-vault-memory — 检索层：FTS(主) + LIKE(兜底) + 自研 snippet
// 依据 docs/step0-calibration.md §4：bigram 分词下不用 fts5 snippet/highlight，
// 片段在 content_plain 原文上按查询串定位截窗。

import { buildFtsQuery } from "./tokenize.mjs";

/**
 * 在单个库上执行全文检索。
 * @param {import("./store.mjs").VaultStore} store
 * @param {string} q 原始查询串
 * @param {{ limit?: number, folder?: string, tag?: string, snippetChars?: number }} opts
 * @returns {{ total: number, hits: Array<{path,title,score,snippet}> }}
 */
export function searchVault(store, q, opts = {}) {
  const limit = opts.limit ?? 50;
  const folder = opts.folder ?? null;
  const tag = typeof opts.tag === "string" && opts.tag !== "" ? opts.tag.toLowerCase() : null;
  const snippetChars = opts.snippetChars ?? 200;
  const qs = (q || "").trim();
  if (!qs) return { total: 0, hits: [] };

  const { ftsQuery } = buildFtsQuery(qs);
  let raw = [];
  let usedFts = false;
  if (ftsQuery) {
    try {
      raw = store.searchFts(ftsQuery, limit * 3);
      usedFts = true;
    } catch {
      raw = []; // FTS 语法/状态异常 → 兜底
    }
  }
  if (!usedFts || raw.length === 0) {
    raw = store.searchLike(qs, limit * 3);
  }

  const hits = [];
  for (const h of raw) {
    const id = h.rowid !== undefined ? Number(h.rowid) : Number(h.id);
    const note = store.getNoteById(id);
    if (!note) continue;
    if (folder && note.folder !== folder) continue;
    if (tag && !store.noteTags(note.id).includes(tag)) continue;
    hits.push({
      path: note.path,
      title: note.title,
      score: normalizeScore(h.score),
      snippet: makeSnippet(note.content_plain, qs, snippetChars),
    });
    if (hits.length >= limit) break;
  }
  return { total: hits.length, hits };
}

/** bm25 为负值（越小越相关）→ 归一为非负相关分（越大越相关，保留 2 位）。 */
function normalizeScore(bm25) {
  const v = typeof bm25 === "number" ? -bm25 : 0;
  return Math.round(v * 100) / 100;
}

/** 在原文上定位查询串（或任一 2 字以上 token）截取片段。 */
export function makeSnippet(contentPlain, q, snippetChars) {
  const text = contentPlain || "";
  if (!text) return "";
  const qs = q.trim();
  const needle = (() => {
    const lower = text.toLowerCase();
    if (qs) {
      const idx = lower.indexOf(qs.toLowerCase());
      if (idx >= 0) return { idx, len: qs.length };
    }
    const { rawTokens } = buildFtsQuery(qs);
    for (const t of rawTokens) {
      if (t.length < 2) continue;
      const idx = lower.indexOf(t.toLowerCase());
      if (idx >= 0) return { idx, len: t.length };
    }
    return { idx: 0, len: 0 };
  })();
  const head = Math.floor(snippetChars / 3);
  const start = Math.max(0, needle.idx - head);
  const end = Math.min(text.length, start + snippetChars);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return prefix + text.slice(start, end).replace(/\s+/g, " ").trim() + suffix;
}
