// dsh-plugin-vault-memory — SQLite 存储层（node:sqlite，零原生依赖）
// 驱动选型依据 docs/step0-calibration.md §3：与一方 dsh-session-query-sqlite 同款。
// 职责：DDL/迁移、单篇 upsert/remove（事务内幂等）、结构化查询、FTS/LIKE 检索、
//       路径→id 映射（解析 wikilink 用）。不含 DSH 依赖。

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { tokenizeText } from "./tokenize.mjs";
import { encodeVec as encodeVecBuf, decodeVec as decodeVecBuf } from "./vector.mjs";

const SCHEMA_VERSION = 2;

const DDL = `
CREATE TABLE IF NOT EXISTS notes (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  content_plain TEXT NOT NULL DEFAULT '',
  folder        TEXT NOT NULL DEFAULT '',
  mtime_ms      INTEGER NOT NULL,
  word_count    INTEGER NOT NULL DEFAULT 0,
  line_count    INTEGER NOT NULL DEFAULT 0,
  has_fm        INTEGER NOT NULL DEFAULT 0,
  indexed_at    INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title_tok, content_tok, tokenize='unicode61'
);
CREATE TABLE IF NOT EXISTS fm_kv (
  note_id INTEGER NOT NULL,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  is_list INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (note_id, key, value)
);
CREATE INDEX IF NOT EXISTS fm_kv_key_idx ON fm_kv(key);
CREATE TABLE IF NOT EXISTS tags (
  note_id INTEGER NOT NULL,
  tag     TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
);
CREATE INDEX IF NOT EXISTS tags_tag_idx ON tags(tag);
CREATE TABLE IF NOT EXISTS links (
  id            INTEGER PRIMARY KEY,
  from_note     INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  target        TEXT NOT NULL,
  resolved_note INTEGER
);
CREATE INDEX IF NOT EXISTS links_from_idx ON links(from_note);
CREATE INDEX IF NOT EXISTS links_resolved_idx ON links(resolved_note);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

-- Phase 3：巡检建议 / 健康快照 /（预留）章节与向量
CREATE TABLE IF NOT EXISTS suggestions (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,                 -- orphan | broken_link | moc_draft | ...
  target      TEXT NOT NULL,                 -- 主对象 vault 相对路径（写回定位用）
  reason      TEXT NOT NULL,
  payload     TEXT NOT NULL,                 -- JSON（结构性载荷；写回前塞入 backup）
  status      TEXT NOT NULL DEFAULT 'open',  -- open|approved|dismissed|applied|reverted
  run_at      INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS suggestions_open_idx ON suggestions(status, kind);
CREATE TABLE IF NOT EXISTS health_snapshots (
  id      INTEGER PRIMARY KEY,
  at      INTEGER NOT NULL,
  metrics TEXT NOT NULL                      -- JSON
);
CREATE INDEX IF NOT EXISTS health_snapshots_at_idx ON health_snapshots(at);
CREATE TABLE IF NOT EXISTS sections (
  note_id    INTEGER NOT NULL,
  seq        INTEGER NOT NULL,
  heading    TEXT NOT NULL DEFAULT '',
  text       TEXT NOT NULL,
  PRIMARY KEY (note_id, seq)
);
CREATE TABLE IF NOT EXISTS embeddings (
  note_id    INTEGER NOT NULL,
  seq        INTEGER NOT NULL,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vec        BLOB NOT NULL,
  PRIMARY KEY (note_id, seq, model)
);
`;

export class VaultStore {
  /** @param {string} dbPath SQLite 文件绝对路径 */
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(DDL);
    const schemaVer = this.#metaGet("schema_version");
    if (!schemaVer) this.#metaSet("schema_version", String(SCHEMA_VERSION));
    this.pathMap = new Map(); // lowercase(win) path -> id
    this.#reloadPathMap();
  }

  #metaGet(k) {
    const row = this.db.prepare("SELECT v FROM meta WHERE k = ?").get(k);
    return row ? row.v : null;
  }
  #metaSet(k, v) {
    this.db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }
  #key(rel) {
    return process.platform === "win32" ? rel.toLowerCase() : rel;
  }

  #reloadPathMap() {
    this.pathMap.clear();
    for (const row of this.db.prepare("SELECT id, path FROM notes").all()) {
      this.pathMap.set(this.#key(row.path), Number(row.id));
    }
  }

  /**
   * 幂等 upsert 一篇笔记（事务内：先删旧行及其关联，再全量重插）。
   * @param {object} parsed parseMarkdown 的返回
   * @param {number} mtimeMs 文件 mtime
   */
  upsertNote(parsed, mtimeMs) {
    const db = this.db;
    const oldId = this.pathMap.get(this.#key(parsed.path));
    db.exec("BEGIN");
    try {
      if (oldId !== undefined) {
        this.#deleteNoteRows(oldId);
      }
      const res = db.prepare(
        `INSERT INTO notes (path, title, content_plain, folder, mtime_ms, word_count, line_count, has_fm, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        parsed.path,
        parsed.title,
        parsed.contentPlain,
        parsed.folder,
        mtimeMs,
        parsed.wordCount,
        parsed.lineCount,
        parsed.fm.length > 0 ? 1 : 0,
        Date.now(),
      );
      const id = Number(res.lastInsertRowid);
      this.pathMap.set(this.#key(parsed.path), id);

      db.prepare("INSERT INTO notes_fts (rowid, title_tok, content_tok) VALUES (?, ?, ?)").run(
        id,
        tokenizeText(parsed.title),
        tokenizeText(parsed.contentPlain),
      );
      const fmStmt = db.prepare("INSERT OR IGNORE INTO fm_kv (note_id, key, value, is_list) VALUES (?, ?, ?, ?)");
      for (const { key, value, isList } of parsed.fm) {
        if (value === "") continue;
        fmStmt.run(id, key, value, isList ? 1 : 0);
      }
      const tagStmt = db.prepare("INSERT OR IGNORE INTO tags (note_id, tag) VALUES (?, ?)");
      for (const t of parsed.tags) tagStmt.run(id, t);
      const linkStmt = db.prepare("INSERT INTO links (from_note, kind, target, resolved_note) VALUES (?, ?, ?, ?)");
      for (const l of parsed.links) {
        linkStmt.run(id, l.kind, l.target, this.#resolveTarget(parsed.folder, l.target));
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  /** 删除一篇笔记及其关联行。 */
  removeNote(relPath) {
    const id = this.pathMap.get(this.#key(relPath));
    if (id === undefined) return false;
    this.db.exec("BEGIN");
    try {
      this.#deleteNoteRows(id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.pathMap.delete(this.#key(relPath));
    return true;
  }

  /**
   * 全量重解析链接（扫描/增量结束后调用）：
   * 入库时先入的笔记引用后入的笔记会暂判悬空，统一在这里修正。
   */
  refreshLinks() {
    const rows = this.db.prepare(
      "SELECT l.id AS link_id, l.target AS target, n.folder AS folder FROM links l JOIN notes n ON n.id = l.from_note",
    ).all();
    const update = this.db.prepare("UPDATE links SET resolved_note = ? WHERE id = ?");
    this.db.exec("BEGIN");
    try {
      for (const r of rows) {
        update.run(this.#resolveTarget(r.folder, r.target), Number(r.link_id));
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  #deleteNoteRows(id) {
    const db = this.db;
    db.prepare("DELETE FROM notes WHERE id = ?").run(id);
    db.prepare("DELETE FROM notes_fts WHERE rowid = ?").run(id);
    db.prepare("DELETE FROM fm_kv WHERE note_id = ?").run(id);
    db.prepare("DELETE FROM tags WHERE note_id = ?").run(id);
    db.prepare("DELETE FROM links WHERE from_note = ?").run(id);
    db.prepare("DELETE FROM sections WHERE note_id = ?").run(id);
    db.prepare("DELETE FROM embeddings WHERE note_id = ?").run(id);
  }

  /**
   * 解析 wikilink/md 链接目标 → notes.id；悬空返回 null。
   * 相对目标先按来源笔记所在目录归一（支持 ../）；越出库外即悬空。
   */
  #resolveTarget(fromFolder, target) {
    let t = target.replace(/^\.\//, "").replaceAll("\\", "/");
    t = path.posix.normalize(path.posix.join(fromFolder || "", t));
    if (t.startsWith("../")) return null;
    const candidates = [t];
    if (!t.toLowerCase().endsWith(".md")) candidates.push(t + ".md");
    else candidates.push(t.replace(/\.md$/i, ""));
    for (const c of candidates) {
      const id = this.pathMap.get(this.#key(c));
      if (id !== undefined) return id;
    }
    return null;
  }

  /** FTS 命中（bm25 负值，越小越相关）。 */
  searchFts(ftsQuery, limit) {
    return this.db.prepare(
      `SELECT rowid, bm25(notes_fts) AS score FROM notes_fts
       WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts), rowid LIMIT ?`,
    ).all(ftsQuery, limit);
  }

  /** LIKE 兜底：短查询零命中时保证召回。 */
  searchLike(q, limit) {
    const esc = q.replace(/[\\%_]/g, (ch) => "\\" + ch);
    return this.db.prepare(
      `SELECT id, 0 AS score FROM notes WHERE content_plain LIKE ? ESCAPE '\\' LIMIT ?`,
    ).all(`%${esc}%`, limit);
  }

  /**
   * 结构化查询。
   * @param {object} f { folder?, tag?, modifiedSince?: Date, modifiedUntil?: Date, hasFmKey?, sort?, limit?, fields? }
   */
  queryNotes(f) {
    const where = [];
    const params = [];
    if (f.folder !== undefined && f.folder !== null && f.folder !== "") {
      where.push("folder = ?");
      params.push(f.folder);
    }
    if (f.modifiedSince) {
      where.push("mtime_ms >= ?");
      params.push(f.modifiedSince.getTime());
    }
    if (f.modifiedUntil) {
      where.push("mtime_ms <= ?");
      params.push(f.modifiedUntil.getTime());
    }
    if (f.hasFmKey) {
      where.push("EXISTS (SELECT 1 FROM fm_kv WHERE fm_kv.note_id = notes.id AND fm_kv.key = ?)");
      params.push(f.hasFmKey);
    }
    if (f.tag) {
      where.push("EXISTS (SELECT 1 FROM tags WHERE tags.note_id = notes.id AND tags.tag = ?)");
      params.push(f.tag.toLowerCase());
    }
    const sort = f.sort === "title_asc"
      ? "title COLLATE NOCASE ASC"
      : f.sort === "modified_asc"
        ? "mtime_ms ASC"
        : "mtime_ms DESC";
    const sql = `SELECT * FROM notes ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${sort} LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, f.limit ?? 50);
    const fields = f.fields && f.fields.length > 0 ? f.fields : [];
    const fmStmt = this.db.prepare("SELECT key, value, is_list FROM fm_kv WHERE note_id = ?");
    const tagStmt = this.db.prepare("SELECT tag FROM tags WHERE note_id = ?");
    return rows.map((r) => ({
      path: r.path,
      title: r.title,
      folder: r.folder,
      mtime_ms: Number(r.mtime_ms),
      word_count: Number(r.word_count),
      tags: tagStmt.all(Number(r.id)).map((t) => t.tag),
      fm: this.#pickFm(fmStmt.all(Number(r.id)), fields),
    }));
  }

  #pickFm(rows, fields) {
    const out = {};
    for (const { key, value, is_list } of rows) {
      if (fields.includes(key)) out[key] = is_list ? value.split(",") : value;
    }
    return out;
  }

  /** 取单篇笔记行（无则 undefined）。 */
  getNote(relPath) {
    const id = this.pathMap.get(this.#key(relPath));
    if (id === undefined) return undefined;
    return this.getNoteById(id);
  }

  /** 按 id 取笔记行。 */
  getNoteById(id) {
    const r = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(Number(id));
    return r ? { ...r, id: Number(r.id), mtime_ms: Number(r.mtime_ms) } : undefined;
  }

  /** 取某笔记全部标签（小写）。 */
  noteTags(noteId) {
    return this.db.prepare("SELECT tag FROM tags WHERE note_id = ?").all(Number(noteId)).map((t) => t.tag);
  }

  /** 指向该笔记的入链（已解析）：[{ path }] */
  inlinksOf(noteId) {
    return this.db.prepare(
      "SELECT n.path FROM links l JOIN notes n ON n.id = l.from_note WHERE l.resolved_note = ? ORDER BY n.path",
    ).all(Number(noteId)).map((r) => ({ path: r.path }));
  }

  /** 该笔记的出链（已解析目标）：[{ path }] */
  outlinksOf(noteId) {
    return this.db.prepare(
      "SELECT n.path FROM links l JOIN notes n ON n.id = l.resolved_note WHERE l.from_note = ? AND l.resolved_note IS NOT NULL ORDER BY n.path",
    ).all(Number(noteId)).map((r) => ({ path: r.path }));
  }

  /** 与目标共享标签的笔记（排除自身）：[{ noteId, path, count }]（count=共享标签数） */
  sharedTagNotes(noteId) {
    return this.db.prepare(
      `SELECT t2.note_id AS noteId, n.path, COUNT(*) AS count
       FROM tags t1
       JOIN tags t2 ON t2.tag = t1.tag AND t2.note_id <> t1.note_id
       JOIN notes n ON n.id = t2.note_id
       WHERE t1.note_id = ? GROUP BY t2.note_id ORDER BY count DESC, n.path`,
    ).all(Number(noteId)).map((r) => ({ noteId: Number(r.noteId), path: r.path, count: Number(r.count) }));
  }

  /** 与目标共引（同一第三方引用两者）的笔记：[{ noteId, path, shared }]（shared=共同引用方数量） */
  coCitedNotes(noteId) {
    return this.db.prepare(
      `SELECT l2.resolved_note AS noteId, n.path, COUNT(*) AS shared
       FROM links l1
       JOIN links l2 ON l2.from_note = l1.from_note AND l2.resolved_note <> l1.resolved_note
       JOIN notes n ON n.id = l2.resolved_note
       WHERE l1.resolved_note = ? AND l2.resolved_note IS NOT NULL
       GROUP BY l2.resolved_note ORDER BY shared DESC, n.path`,
    ).all(Number(noteId)).map((r) => ({ noteId: Number(r.noteId), path: r.path, shared: Number(r.shared) }));
  }

  /** 列出悬空链接（断链）供健康面板：[{ fromPath, target }] */
  brokenLinks() {
    return this.db.prepare(
      "SELECT n.path AS fromPath, l.target FROM links l JOIN notes n ON n.id = l.from_note WHERE l.resolved_note IS NULL ORDER BY n.path",
    ).all();
  }

  /** 孤儿候选：无任何入链（resolved 指向它）的非空笔记路径。 */
  orphanCandidates() {
    return this.db.prepare(
      `SELECT n.path, n.title, n.folder, n.word_count, n.mtime_ms FROM notes n
       WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.resolved_note = n.id)
       ORDER BY n.mtime_ms DESC`,
    ).all().map((r) => ({ path: r.path, title: r.title, folder: r.folder, wordCount: Number(r.word_count) }));
  }

  /** 每文件夹笔记数（MOC 判定用）：[{ folder, count }]（folder 非空）。 */
  folderCounts() {
    return this.db.prepare(
      `SELECT folder, COUNT(*) AS count FROM notes WHERE folder <> '' GROUP BY folder HAVING count > 0 ORDER BY count DESC`,
    ).all().map((r) => ({ folder: r.folder, count: Number(r.count) }));
  }

  /** 该目录下已有同名/README 索引笔记？ */
  hasIndexNote(folder) {
    const candidates = [`${folder}.md`, `${folder}/README.md`, `${folder}/index.md`];
    for (const c of candidates) {
      if (this.getNote(c)) return c;
    }
    return null;
  }

  // ---- suggestions 表 ----
  /** 已 open 的同 kind+target 建议数（防重复）；返回 id 或 null。 */
  findOpenSuggestion(kind, target) {
    const row = this.db.prepare(
      "SELECT id FROM suggestions WHERE kind = ? AND target = ? AND status = 'open' LIMIT 1",
    ).get(kind, target);
    return row ? Number(row.id) : null;
  }

  /** 批量插入建议（事务）。 */
  insertSuggestions(drafts) {
    if (drafts.length === 0) return 0;
    const stmt = this.db.prepare(
      "INSERT INTO suggestions (kind, target, reason, payload, run_at) VALUES (?, ?, ?, ?, ?)",
    );
    const now = Date.now();
    this.db.exec("BEGIN");
    try {
      for (const d of drafts) stmt.run(d.kind, d.target, d.reason, JSON.stringify(d.payload ?? {}), now);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return drafts.length;
  }

  /** 打开的建议列表。 */
  openSuggestions({ kind, limit = 100 } = {}) {
    const where = ["status = 'open'"];
    const params = [];
    if (kind) {
      where.push("kind = ?");
      params.push(kind);
    }
    return this.db.prepare(
      `SELECT * FROM suggestions WHERE ${where.join(" AND ")} ORDER BY run_at DESC, id LIMIT ?`,
    ).all(...params, limit).map(rowToSuggestion);
  }

  /** 取单条建议（任意状态）。 */
  getSuggestion(id) {
    const row = this.db.prepare("SELECT * FROM suggestions WHERE id = ?").get(Number(id));
    return row ? rowToSuggestion(row) : undefined;
  }

  /** 更新建议状态与载荷（approve 时写入 payload.backup）。 */
  setSuggestion(id, { status, payload }) {
    const cur = this.getSuggestion(id);
    if (!cur) return false;
    this.db.prepare("UPDATE suggestions SET status = ?, payload = ?, resolved_at = ? WHERE id = ?")
      .run(status ?? cur.status, JSON.stringify(payload ?? cur.payload), Date.now(), Number(id));
    return true;
  }

  /** 清空 open 建议（重建巡检用）。 */
  clearOpenSuggestions() {
    this.db.prepare("DELETE FROM suggestions WHERE status = 'open'").run();
  }

  // ---- health_snapshots ----
  addHealthSnapshot(metrics) {
    this.db.prepare("INSERT INTO health_snapshots (at, metrics) VALUES (?, ?)").run(Date.now(), JSON.stringify(metrics));
  }

  recentHealthSnapshots(limit = 14) {
    return this.db.prepare("SELECT * FROM health_snapshots ORDER BY at DESC LIMIT ?")
      .all(limit).map((r) => ({ at: Number(r.at), metrics: JSON.parse(r.metrics) }));
  }

  // ---- sections / embeddings（语义检索） ----

  /** 整表替换某笔记的章节（无则删旧插新）。 */
  replaceSections(noteId, sections) {
    const del = this.db.prepare("DELETE FROM sections WHERE note_id = ?");
    const ins = this.db.prepare("INSERT OR REPLACE INTO sections (note_id, seq, heading, text) VALUES (?, ?, ?, ?)");
    this.db.exec("BEGIN");
    try {
      del.run(Number(noteId));
      sections.forEach((s, i) => ins.run(Number(noteId), i, s.heading || "", s.text));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** 该模型是否已有任何嵌入。 */
  hasEmbeddings(model) {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM embeddings WHERE model = ?").get(model);
    return Number(row.n) > 0;
  }

  /** 需要补嵌入的笔记 id 列表（有章节但该模型无嵌入）。 */
  notesMissingEmbeddings(model) {
    return this.db.prepare(
      `SELECT DISTINCT s.note_id AS id FROM sections s
       WHERE NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.note_id = s.note_id AND e.model = ?)`,
    ).all(model).map((r) => Number(r.id));
  }

  /** 单笔记章节文本（分块入向量用）。 */
  sectionTexts(noteId) {
    return this.db.prepare("SELECT seq, heading, text FROM sections WHERE note_id = ? ORDER BY seq")
      .all(Number(noteId)).map((r) => ({ seq: Number(r.seq), heading: r.heading, text: r.text }));
  }

  /** 批量写嵌入。rows: [{ noteId, seq, vec: Float32Array }] */
  storeEmbeddings(model, rows, dim) {
    if (rows.length === 0) return;
    const ins = this.db.prepare(
      "INSERT OR REPLACE INTO embeddings (note_id, seq, model, dim, vec) VALUES (?, ?, ?, ?, ?)",
    );
    this.db.exec("BEGIN");
    try {
      for (const r of rows) ins.run(Number(r.noteId), r.seq, model, dim, encodeVecBuf(r.vec));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** 读该模型全部向量（分块级），decode 为 Float32Array。 */
  embeddingChunks(model) {
    return this.db.prepare(
      "SELECT note_id AS noteId, seq, vec FROM embeddings WHERE model = ? ORDER BY note_id, seq",
    ).all(model).map((r) => ({ noteId: Number(r.noteId), seq: Number(r.seq), vec: decodeVecBuf(r.vec) }));
  }

  /** 该模型嵌入覆盖的笔记数。 */
  embeddedNoteCount(model) {
    const row = this.db.prepare("SELECT COUNT(DISTINCT note_id) AS n FROM embeddings WHERE model = ?").get(model);
    return Number(row.n);
  }

  /** 全部笔记轻量行（嵌入分块用）。 */
  allNotesLight() {
    return this.db.prepare("SELECT id, path, content_plain FROM notes ORDER BY id").all()
      .map((r) => ({ id: Number(r.id), path: r.path, contentPlain: r.content_plain }));
  }

  noteCount() {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM notes").get().n);
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* 已关闭 */
    }
  }
}

function rowToSuggestion(r) {
  return {
    id: Number(r.id),
    kind: r.kind,
    target: r.target,
    reason: r.reason,
    payload: JSON.parse(r.payload),
    status: r.status,
    runAt: Number(r.run_at),
    resolvedAt: r.resolved_at === null ? null : Number(r.resolved_at),
  };
}
