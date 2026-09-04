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
import { vaultError, VAULT_ERROR_CODES as C } from "../errors.mjs";

export class VaultIndex {
  /**
   * @param {object} p
   * @param {string} p.root vault 绝对路径
   * @param {string} p.dbPath SQLite 文件路径
   * @param {object} [p.opts] { ignoreGlobs, ignoreDotDirs, watchIntervalMs, searchMaxResults, snippetChars }
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
    };
    this.store = null;
    this.lastScan = new Map();
    this.timer = null;
    this.busy = false;
    this.pending = false;
    this.ready = false;
    this.scanErrors = [];
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
      store.refreshLinks();
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

  stats() {
    if (!this.ready) return { notes: 0, ready: false, errors: this.scanErrors.length };
    return { notes: this.ensureStore().noteCount(), ready: true, errors: this.scanErrors.length };
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

/** 由 vault 路径计算 db 文件名（dbDir 为空时用 DSH_HOME 默认目录）。 */
export function vaultDbPath(dbDir, dshHome, rootAbs) {
  const hash = createHash("sha1").update(rootAbs).digest("hex").slice(0, 16);
  const dir = dbDir && dbDir.trim() !== "" ? dbDir : path.join(dshHome, "data", "vault-memory");
  return path.join(dir, `${hash}.db`);
}
