// dsh-plugin-vault-memory — vault 文件扫描（只扫 .md，排除规则，diff 增量）
// 纯函数 + fs 只读，可独立单测。定时循环由 VaultIndex（core/index.mjs）驱动。

import fs from "node:fs";
import path from "node:path";

/** 简单 glob 匹配（支持 ** * ?），相对 vault 根的 posix 路径。 */
export function matchesIgnore(rel, pattern) {
  const p = pattern.replaceAll("\\", "/");
  const regexSrc = p
    .split("/")
    .map((seg) => {
      if (seg === "**") return "(?:.*)";
      return seg
        .split("*")
        .map((s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*")
        .replace(/\?/g, "[^/]");
    })
    .join("/");
  return new RegExp(`^${regexSrc}(?:/.*)?$`).test(rel);
}

/**
 * 全量扫描 vault 内所有 .md 文件。
 * @param {string} rootAbs 规范化 vault 根
 * @param {{ ignoreGlobs?: string[], ignoreDotDirs?: boolean }} opts
 * @returns {Map<string, { mtimeMs: number, size: number }>} rel(path) -> stat
 */
export function scanVaultFiles(rootAbs, opts = {}) {
  const ignoreGlobs = opts.ignoreGlobs || [];
  const ignoreDotDirs = opts.ignoreDotDirs !== false;
  const out = new Map();
  const walk = (dirAbs, relDir) => {
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return; // 无权限等 → 跳过该目录
    }
    for (const ent of entries) {
      const name = ent.name;
      if (ignoreDotDirs && name.startsWith(".")) continue;
      const abs = path.join(dirAbs, name);
      const rel = relDir ? `${relDir}/${name}` : name;
      if (ent.isDirectory()) {
        walk(abs, rel);
      } else if (ent.isFile() && name.toLowerCase().endsWith(".md")) {
        if (ignoreGlobs.some((g) => matchesIgnore(rel, g))) continue;
        try {
          const st = fs.statSync(abs);
          out.set(rel, { mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          /* 竞争删除 → 忽略 */
        }
      }
    }
  };
  walk(rootAbs, "");
  return out;
}

/**
 * 两次扫描 diff。
 * @returns {{ added: string[], changed: string[], removed: string[] }}
 */
export function diffScans(prev, next) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const [rel, st] of next) {
    const p = prev.get(rel);
    if (p === undefined) added.push(rel);
    else if (p.mtimeMs !== st.mtimeMs || p.size !== st.size) changed.push(rel);
  }
  for (const rel of prev.keys()) {
    if (!next.has(rel)) removed.push(rel);
  }
  return { added, changed, removed };
}
