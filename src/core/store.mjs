// dsh-plugin-vault-memory — SQLite 存储层（node:sqlite，零原生依赖）
// 驱动选型依据 docs/step0-calibration.md §3：与一方 dsh-session-query-sqlite 同款。
// 职责：DDL/迁移、单篇 upsert/remove（事务内幂等）、结构化查询、FTS/LIKE 检索、
//       路径→id 映射（解析 wikilink 用）。不含 DSH 依赖。

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { tokenizeText } from "./tokenize.mjs";

const SCHEMA_VERSION = 1;

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
