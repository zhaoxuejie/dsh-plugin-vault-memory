// dsh-plugin-vault-memory — 巡检引擎：纯规则 → 建议草稿 → 入库
// 原则：引擎零写权限（只读 store 出建议），写盘只发生在审查队列逐条批准后（apply.mjs 的职责）。
// 已实现规则：orphan（孤儿）/ broken_link（断链）/ moc_draft（缺目录总览）；
// missing_link / duplicate / stale 依赖语义或需更多启发，留待 v1.1（见 docs/phase3-interface-spec.md §1.3）。

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

/** 去重：与 store 中已 open 的建议按 kind+target 去重。 */
export function dedupeOpen(store, drafts) {
  return drafts.filter((d) => store.findOpenSuggestion(d.kind, d.target) === null);
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
