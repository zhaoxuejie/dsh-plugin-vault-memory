// dsh-plugin-vault-memory — VaultIndex 门面：单库索引生命周期
// 组合 vault-root / scanner / parser / store / search；提供 tools 层调用的全部能力。
// 懒初始化：未配库/未首次扫描时不崩；索引任务互斥；轮询 watcher 归此类管。

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { normalizeVaultRoot, resolveInside, toVaultRel } from "./vault-root.mjs";
import { scanVaultFiles, diffScans } from "./scanner.mjs";
import { parseMarkdown } from "./parser.mjs";
import { VaultStore } from "./store.mjs";
import { searchVault } from "./search.mjs";
import { splitSections } from "./sections.mjs";
import { createOllamaEmbedder } from "./embed.mjs";
import { cosine, normalize, rrfFuse } from "./vector.mjs";
import { makeSnippet } from "./search.mjs";
import { runReview, dedupeOpen } from "../engine/rules.mjs";
import { applySuggestion as applySuggestionImpl, revertSuggestion as revertSuggestionImpl } from "../engine/apply.mjs";
import { vaultError, VAULT_ERROR_CODES as C } from "../errors.mjs";

export class VaultIndex {
  /**
   * @param {object} p
   * @param {string} p.root vault 绝对路径
   * @param {string} p.dbPath SQLite 文件路径
   * @param {object} [p.opts] { ignoreGlobs, ignoreDotDirs, watchIntervalMs, searchMaxResults, snippetChars, embed, embedder }
   * @param {object} [p.opts.embed] { enabled, baseUrl, model, batchSize, timeoutMs }（embedder 注入时覆盖）
   */
  constructor({ root, dbPath, opts = {} }) {
    this.rootAbs = normalizeVaultRoot(root);
    this.dbPath = dbPath;
    this.opts = {
      ignoreGlobs: opts.ignoreGlobs ?? [],
      ignoreDotDirs: opts.ignoreDotDirs ?? true,
      watchIntervalMs: opts.watchIntervalMs ?? 10000,
      searchMaxResults: opts.searchMaxResults ?? 50,
      snippetChars: opts.snippetChars ?? 200,
      embed: opts.embed && typeof opts.embed === "object" ? opts.embed : {},
    };
    this.store = null;
    this.lastScan = new Map();
    this.timer = null;
    this.busy = false;
    this.pending = false;
    this.ready = false;
    this.scanErrors = [];
    this.embedder = opts.embedder || null;
    this.embedBusy = false;
    this.embedReady = false;
    this.embedError = null;
    if (!this.embedder && this.opts.embed.enabled === true) {
      try {
        this.embedder = createOllamaEmbedder(this.opts.embed);
      } catch {
        this.embedder = null;
      }
    }
  }

  ensureStore() {
    if (!this.store) this.store = new VaultStore(this.dbPath);
    return this.store;
  }

  /** 全量扫描 + 入库。返回 { indexed, errors }。 */
  fullScan() {
    if (this.busy) {
      this.pending = true;
      return { indexed: -1, errors: [] };
    }
    this.busy = true;
    const errors = [];
    try {
      const store = this.ensureStore();
      const files = scanVaultFiles(this.rootAbs, this.opts);
      let indexed = 0;
      for (const [rel, st] of files) {
        try {
          const abs = resolveInside(this.rootAbs, rel);
          const text = fs.readFileSync(abs, "utf8");
          const parsed = parseMarkdown(text, rel);
          store.upsertNote(parsed, st.mtimeMs);
          indexed++;
        } catch (e) {
          errors.push({ path: rel, error: String(e && e.message ? e.message : e) });
        }
      }
      this.lastScan = files;
      this.ready = true;
      this.scanErrors = errors;
      store.db.prepare(
        "INSERT INTO meta (k, v) VALUES ('last_full_scan', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      ).run(String(Date.now()));
      store.refreshLinks();
      if (this.embedder) this.refreshEmbeddingsAsync();
      return { indexed, errors };
    } finally {
      this.busy = false;
      if (this.pending) {
        this.pending = false;
        setImmediate(() => this.fullScan());
      }
    }
  }

  /** 增量 reconcile：比对上次扫描。 */
  reconcile() {
    if (this.busy || !this.ready) return { indexed: 0, removed: 0 };
    this.busy = true;
    let indexed = 0;
    let removed = 0;
    try {
      const store = this.ensureStore();
      const next = scanVaultFiles(this.rootAbs, this.opts);
      const { added, changed, removed: gone } = diffScans(this.lastScan, next);
      for (const rel of [...added, ...changed]) {
        const st = next.get(rel);
        try {
          const abs = resolveInside(this.rootAbs, rel);
          const text = fs.readFileSync(abs, "utf8");
          const parsed = parseMarkdown(text, rel);
          store.upsertNote(parsed, st.mtimeMs);
          indexed++;
        } catch {
          /* 单篇失败跳过，下轮重试 */
        }
      }
      for (const rel of gone) {
        if (store.removeNote(rel)) removed++;
      }
      this.lastScan = next;
      store.refreshLinks();
      if (this.embedder) this.refreshEmbeddingsAsync();
      return { indexed, removed };
    } finally {
      this.busy = false;
    }
  }

  /** 启动轮询 watcher（重复调用先停旧的）。 */
  startWatcher(intervalMs) {
    this.stopWatcher();
    if (!intervalMs || intervalMs < 1000) return;
    this.timer = setInterval(() => this.reconcile(), intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stopWatcher() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 工具入口兜底：未索引则先同步全扫（小库毫秒级）。 */
  ensureReady() {
    if (!this.ready) this.fullScan();
    if (!this.ready) throw vaultError(C.INDEX_NOT_READY, `vault 索引未就绪: ${this.rootAbs}`);
  }

  search(q, opts = {}) {
    this.ensureReady();
    return searchVault(this.ensureStore(), q, {
      limit: opts.limit ?? this.opts.searchMaxResults,
      folder: opts.folder ?? null,
      tag: opts.tag ?? null,
      snippetChars: this.opts.snippetChars,
    });
  }

  // ============ 语义检索（v1.1，Ollama；不可用时优雅回退 fts） ============

  /** 异步补分块与嵌入（幂等；embedBusy 防并发）。 */
  refreshEmbeddingsAsync() {
    if (!this.embedder || this.embedBusy) return this.embeddingPromise || Promise.resolve({ skipped: true });
    const store = this.ensureStore();
    const model = this.opts.embed.model;
    this.embedBusy = true;
    this.embeddingPromise = (async () => {
      const st = store;
      try {
        // 1) 缺章节的笔记先分块
        for (const n of st.allNotesLight()) {
          if (st.sectionTexts(n.id).length > 0) continue;
          if (!n.contentPlain || !n.contentPlain.trim()) continue;
          const sections = splitSections(n.contentPlain, {});
          st.replaceSections(n.id, sections);
        }
        // 2) 缺嵌入的笔记批量调用 embedder
        const missing = st.notesMissingEmbeddings(model);
        const jobs = [];
        for (const id of missing) {
          for (const s of st.sectionTexts(id)) jobs.push({ noteId: id, seq: s.seq, text: s.text });
        }
        let embedded = 0;
        for (let i = 0; i < jobs.length; i += 16) {
          const slice = jobs.slice(i, i + 16);
          const vecs = await this.embedder.embed(slice.map((j) => j.text));
          st.storeEmbeddings(model, slice.map((j, k) => ({ noteId: j.noteId, seq: j.seq, vec: normalize(vecs[k]) })), vecs[0] ? vecs[0].length : 0);
          embedded += slice.length;
        }
        this.embedReady = st.hasEmbeddings(model);
        this.embedError = null;
        return { ok: true, embedded };
      } catch (e) {
        this.embedReady = st.hasEmbeddings(model);
        this.embedError = e && e.message ? e.message : String(e);
        return { ok: false, error: this.embedError };
      } finally {
        this.embedBusy = false;
      }
    })();
    return this.embeddingPromise;
  }

  /** 语义状态（供工具/UI 提示）。 */
  semanticState() {
    if (!this.embedder) return { available: false, reason: "未启用（设置 embed.enabled）" };
    const store = this.ensureStore();
    const model = this.opts.embed.model;
    const ready = store.hasEmbeddings(model);
    return { available: ready, model, coveredNotes: ready ? store.embeddedNoteCount(model) : 0, error: this.embedError };
  }

  /**
   * 智能检索：mode fts | semantic | hybrid。返回 { total, hits, engine }。
   */
  async searchSmart(q, opts = {}) {
    this.ensureReady();
    const store = this.ensureStore();
    const limit = opts.limit ?? this.opts.searchMaxResults;
    const folder = opts.folder ?? null;
    const tag = opts.tag ?? null;
    const snip = this.opts.snippetChars;
    const mode = opts.mode === "semantic" || opts.mode === "hybrid" ? opts.mode : "fts";
    const ftsResult = () => searchVault(store, q, { limit: limit * 2, folder, tag, snippetChars: snip });

    if (mode === "fts" || !this.embedder) return { ...ftsResult(), engine: "fts" };
    const model = this.opts.embed.model;
    // 嵌入未就绪先尝试补（只补一次，短小 vault 秒级；失败回退 fts）
    if (!store.hasEmbeddings(model)) {
      const res = await this.refreshEmbeddingsAsync();
      if (!res.ok) return { ...ftsResult(), engine: "fts" };
    }
    if (!store.hasEmbeddings(model)) return { ...ftsResult(), engine: "fts" };

    let qvec;
    try {
      const [v] = await this.embedder.embed([q]);
      qvec = normalize(v);
    } catch {
      return { ...ftsResult(), engine: "fts" };
    }

    // 分块余弦 → 每笔记取最高分
    const best = new Map(); // path -> score
    for (const chunk of store.embeddingChunks(model)) {
      const note = store.getNoteById(chunk.noteId);
      if (!note) continue;
      if (folder && note.folder !== folder) continue;
      if (tag && !store.noteTags(note.id).includes(tag.toLowerCase())) continue;
      const sim = cosine(qvec, normalize(chunk.vec));
      const prev = best.get(note.path);
      if (prev === undefined || sim > prev) best.set(note.path, sim);
    }
    const vecList = [...best.entries()].map(([path, score]) => ({ path, score })).sort((a, b) => b.score - a.score);

    if (mode === "semantic") {
      const hits = vecList.slice(0, limit).map(({ path, score }) => {
        const note = store.getNote(path);
        return { path, title: note.title, score: round2(score * 100), snippet: makeSnippet(note.content_plain, q, snip) };
      });
      return { total: hits.length, hits, engine: "semantic" };
    }

    // hybrid：RRF 融合 fts + 向量
    const ftsBase = ftsResult();
    const fused = rrfFuse(ftsBase.hits.map((h) => ({ path: h.path, score: h.score })), vecList, 60);
    const hits = fused.slice(0, limit).map(({ path, score }) => {
      const note = store.getNote(path);
      return { path, title: note.title, score: round2(score * 100), snippet: makeSnippet(note.content_plain, q, snip) };
    });
    return { total: hits.length, hits, engine: "hybrid" };
  }

  query(f = {}) {
    this.ensureReady();
    return this.ensureStore().queryNotes(f);
  }

  /**
   * 读单篇（直接磁盘按行读，天然新鲜）。
   * @param {string} rel vault 相对路径（可省 .md）
   * @param {{ offset?: number, limit?: number }} w 行窗口
   */
  readNote(rel, w = {}) {
    let target = rel;
    const abs0 = resolveInside(this.rootAbs, target);
    let abs = abs0;
    if (!fs.existsSync(abs)) {
      if (!target.toLowerCase().endsWith(".md")) {
        abs = resolveInside(this.rootAbs, target + ".md");
        target = target + ".md";
      }
      if (!fs.existsSync(abs)) {
        throw vaultError(C.NOTE_NOT_FOUND, `笔记不存在: ${rel}`);
      }
    }
    let text;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch (e) {
      throw vaultError(C.VAULT_UNREADABLE, `笔记读取失败: ${target} (${e.message})`);
    }
    const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
    const offset = Math.max(1, w.offset ?? 1);
    const limit = Math.min(500, w.limit ?? 200);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    return {
      path: normalizeTarget(target),
      resolvedPath: target,
      totalLines: lines.length,
      offset,
      lines: slice.map((text, i) => ({ n: offset + i, text })),
      truncated: offset - 1 + slice.length < lines.length,
    };
  }

  /**
   * 关联笔记：入链/出链/同标签/共引（共引与多标签权重高）。
   * @param {string} rel 起点笔记相对路径
   * @param {{ limit?: number }} opts
   */
  related(rel, opts = {}) {
    this.ensureReady();
    const store = this.ensureStore();
    const note = store.getNote(rel);
    if (!note) throw vaultError(C.NOTE_NOT_FOUND, `笔记不存在: ${rel}`);
    const limit = Math.min(20, Math.max(1, opts.limit ?? 10));
    const byPath = new Map(); // path -> { relation, reason, score }
    const add = (path, relation, reason, score) => {
      if (path === note.path) return;
      const cur = byPath.get(path);
      if (!cur || score > cur.score) byPath.set(path, { path, relation, reason, score });
    };
    for (const { path: p } of store.inlinksOf(note.id)) add(p, "inlink", `被 ${p} 引用`, 3);
    for (const { path: p } of store.outlinksOf(note.id)) add(p, "outlink", `引用 ${p}`, 2);
    for (const { path: p, count } of store.sharedTagNotes(note.id)) {
      if (count >= 2) add(p, "tag-shared", `同标签 ${store.noteTags(Number(store.getNote(p).id)).join("、")}`, count);
    }
    for (const { path: p, shared } of store.coCitedNotes(note.id)) {
      if (shared >= 2) add(p, "co-cited", `被 ${shared} 篇笔记共同引用`, 3 + shared);
    }
    const list = [...byPath.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    return { path: note.path, total: list.length, related: list };
  }

  /**
   * 健康摘要（供 GUI/巡检）：笔记数、断链、近期新增。
   */
  health() {
    const store = this.ensureStore();
    const broken = store.brokenLinks().length;
    const weekMs = 7 * 24 * 3600 * 1000;
    const recent = store.queryNotes({ modifiedSince: new Date(Date.now() - weekMs), sort: "modified_desc", limit: 10 })
      .map((n) => ({ path: n.path, title: n.title, mtime: new Date(n.mtime_ms).toISOString() }));
    return {
      ready: this.ready,
      notes: store.noteCount(),
      brokenLinks: broken,
      indexedAt: this.ready ? new Date(this.lastIndexedAt() ?? Date.now()).toISOString() : null,
      recent,
    };
  }

  lastIndexedAt() {
    if (!this.store) return null;
    const row = this.store.db.prepare("SELECT v FROM meta WHERE k = 'last_full_scan'").get();
    if (!row) return null;
    const ms = Number(row.v);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }

  /**
   * 捕获预览（只组装不写盘）。
   * @param {object} c 同 capture
   * @returns {{ rel: string, exists: boolean, note: string }}
   */
  capturePreview(c) {
    const { rel, note } = this.#composeCapture(c);
    let exists = false;
    try {
      exists = fs.existsSync(resolveInside(this.rootAbs, rel));
    } catch {
      exists = false;
    }
    return { rel, exists, note };
  }

  /**
   * 捕获新笔记（唯一写 vault 的原子入口）：
   * 组装 frontmatter+正文 → 原子写盘（.tmp→rename）→ 立即重解析入库。
   * @param {object} c { title, body, folder?, tags?: string[], source?, addRelated?: boolean }
   * @returns {{ path: string, note: string }}
   */
  capture(c) {
    const { rel, note } = this.#composeCapture(c);
    const abs = resolveInside(this.rootAbs, rel);
    if (fs.existsSync(abs)) {
      throw vaultError(C.NOTE_EXISTS, `笔记已存在: ${rel}（如需覆盖请先处理或换标题）`);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = abs + ".tmp";
    fs.writeFileSync(tmp, note, "utf8");
    fs.renameSync(tmp, abs);
    const stat = fs.statSync(abs);
    const parsed = parseMarkdown(note, rel);
    this.ensureStore().upsertNote(parsed, stat.mtimeMs);
    if (this.lastScan) this.lastScan.set(rel, { mtimeMs: stat.mtimeMs, size: stat.size });
    return { path: rel, note };
  }

  /** 组装捕获笔记（纯函数：frontmatter+正文+关联区），不碰磁盘。 */
  #composeCapture(c) {
    const title = (c.title || "").trim();
    const body = (c.body || "").trim();
    if (!title) throw vaultError(C.INVALID_ARG, "capture: title 不能为空");
    if (!body) throw vaultError(C.INVALID_ARG, "capture: body 不能为空");
    const folder = normalizeTarget(c.folder || "").replace(/^\/+|\/+$/g, "");
    const rel = folder ? `${folder}/${sanitizeFileName(title)}.md` : `${sanitizeFileName(title)}.md`;
    const tags = Array.isArray(c.tags) ? c.tags.map(String).filter(Boolean) : [];
    const now = new Date();
    const iso = now.toISOString();
    const fmLines = ["---"];
    if (tags.length > 0) fmLines.push(`tags: [${tags.map((t) => t.replace(/[",\]]/g, "")).join(", ")}]`);
    if (c.source) fmLines.push(`source: ${String(c.source).replace(/"/g, "'")}`);
    fmLines.push(`created: ${iso.slice(0, 10)}`);
    fmLines.push(`updated: ${iso.slice(0, 10)}`);
    fmLines.push("---");
    const lines = [...fmLines, "", `# ${title}`, "", body];
    if (c.addRelated) {
      // 新笔记尚未入库，无法用链接图；改按标题全文检索建议关联（排除自身路径）
      const rels = this.search(title, { limit: 5 }).hits.filter((h) => h.path !== rel).slice(0, 3);
      if (rels.length > 0) {
        lines.push("", "## 关联");
        for (const r of rels) lines.push(`- [[${r.path.replace(/\.md$/i, "")}]]`);
      }
    }
    return { rel, note: lines.join("\n") + "\n" };
  }

  stats() {
    if (!this.ready) return { notes: 0, ready: false, errors: this.scanErrors.length };
    return { notes: this.ensureStore().noteCount(), ready: true, errors: this.scanErrors.length };
  }

  // ============ 原文件读写（审查写回用；全部经路径监狱） ============

  /** 读原始 md（含路径校验）。返回 { exists, text }。 */
  readRawNote(rel) {
    const abs = resolveInside(this.rootAbs, rel);
    if (!fs.existsSync(abs)) return { exists: false, text: "" };
    return { exists: true, text: fs.readFileSync(abs, "utf8") };
  }

  /** 原子写 md 并立即重解析入库（审查写回与捕获共用语义）。 */
  writeRawNote(rel, text) {
    const abs = resolveInside(this.rootAbs, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = abs + ".tmp";
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, abs);
    const stat = fs.statSync(abs);
    const parsed = parseMarkdown(text, rel);
    this.ensureStore().upsertNote(parsed, stat.mtimeMs);
    if (this.lastScan) this.lastScan.set(rel, { mtimeMs: stat.mtimeMs, size: stat.size });
    this.ensureStore().refreshLinks();
  }

  /** 删除由本插件创建的文件（仅 moc 回滚用）。 */
  removeRawNote(rel) {
    const abs = resolveInside(this.rootAbs, rel);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
    this.ensureStore().removeNote(rel);
    if (this.lastScan) this.lastScan.delete(rel);
  }

  // ============ 巡检（Phase 3） ============

  /**
   * 跑一轮巡检并入库建议。
   * @param {{ kinds?: string[] }} opts
   * @returns {{ inserted: number, drafts: number, byKind: Record<string, number> }}
   */
  reviewRun(opts = {}) {
    this.ensureReady();
    const store = this.ensureStore();
    const { drafts } = runReview(store, opts);
    const fresh = dedupeOpen(store, drafts);
    const inserted = store.insertSuggestions(fresh);
    const byKind = {};
    for (const d of fresh) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
    store.addHealthSnapshot({ notes: store.noteCount(), inserted });
    return { inserted, drafts: fresh.length, byKind };
  }

  /** open 建议统计 + 最近健康快照。 */
  reviewStats() {
    const store = this.ensureStore();
    const rows = store.openSuggestions({ limit: 1000 });
    const open = {};
    for (const r of rows) open[r.kind] = (open[r.kind] ?? 0) + 1;
    return { open, openTotal: rows.length, snapshots: store.recentHealthSnapshots(14) };
  }

  /** 批准一条建议（写回）。 */
  applySuggestion(id, opts) {
    this.ensureReady();
    const sug = this.ensureStore().getSuggestion(id);
    if (!sug) throw vaultError(C.NOTE_NOT_FOUND, `建议不存在: ${id}`);
    return applySuggestionImpl(this, sug, opts);
  }

  /** 回滚一条建议。 */
  revertSuggestion(id) {
    this.ensureReady();
    const sug = this.ensureStore().getSuggestion(id);
    if (!sug) throw vaultError(C.NOTE_NOT_FOUND, `建议不存在: ${id}`);
    return revertSuggestionImpl(this, sug);
  }

  /** 忽略/驳回一条建议。 */
  dismissSuggestion(id, reason) {
    const store = this.ensureStore();
    const sug = store.getSuggestion(id);
    if (!sug) throw vaultError(C.NOTE_NOT_FOUND, `建议不存在: ${id}`);
    if (sug.status !== "open") return { ok: false, message: `建议已是 ${sug.status}` };
    store.setSuggestion(id, { status: "dismissed", payload: { ...sug.payload, dismissReason: reason || null } });
    return { ok: true, message: `已忽略: ${sug.target}` };
  }

  close() {
    this.stopWatcher();
    if (this.store) {
      this.store.close();
      this.store = null;
    }
  }
}

function normalizeTarget(rel) {
  return rel.replaceAll("\\", "/");
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** 文件名净化：去非法字符、压缩空白、限长；空则回退 untitled。 */
function sanitizeFileName(name) {
  let s = String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim().replace(/\s+/g, " ");
  if (!s) throw vaultError(C.INVALID_ARG, "标题无法生成合法文件名");
  if (s.length > 120) s = s.slice(0, 120).trim();
  return s;
}

/** 由 vault 路径计算 db 文件名（dbDir 为空时用 DSH_HOME 默认目录）。 */
export function vaultDbPath(dbDir, dshHome, rootAbs) {
  const hash = createHash("sha1").update(rootAbs).digest("hex").slice(0, 16);
  const dir = dbDir && dbDir.trim() !== "" ? dbDir : path.join(dshHome, "data", "vault-memory");
  return path.join(dir, `${hash}.db`);
}
