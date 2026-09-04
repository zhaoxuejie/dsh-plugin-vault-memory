// dsh-plugin-vault-memory — vault 路径监狱
// 所有对 vault 的文件访问必须经这里的解析/校验：
//   1. 相对路径解析后必须落在 vault 根内（含大小写不敏感比较，Windows）。
//   2. 拒绝绝对路径、拒绝 `..` 逃逸。
//   3. realpath 复检：符号链接/junction 指向 vault 外 → 拒绝。

import path from "node:path";
import fs from "node:fs";
import { vaultError, VAULT_ERROR_CODES as C } from "../errors.mjs";

/** 规范化 vault 根：必须是已存在的目录。 */
export function normalizeVaultRoot(root) {
  const abs = path.resolve(root);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw vaultError(C.VAULT_UNREADABLE, `vault 目录不存在或不可读: ${abs}`);
  }
  if (!stat.isDirectory()) throw vaultError(C.VAULT_UNREADABLE, `vault 路径不是目录: ${abs}`);
  return abs;
}

/** 大小写不敏感的前缀包含判断（Windows 语义；Linux 上即大小写敏感）。 */
function isSameOrChild(rootAbs, targetAbs) {
  const r = process.platform === "win32" ? rootAbs.toLowerCase() : rootAbs;
  const t = process.platform === "win32" ? targetAbs.toLowerCase() : targetAbs;
  if (t === r) return true;
  return t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** 断言绝对路径在 vault 内；越界抛 VAULT_PATH_ESCAPE。 */
export function assertInside(rootAbs, targetAbs) {
  if (!isSameOrChild(rootAbs, targetAbs)) {
    throw vaultError(C.VAULT_PATH_ESCAPE, `路径越出 vault 边界被拒绝: ${targetAbs}`);
  }
  return targetAbs;
}

/**
 * 把 vault 内相对路径解析为绝对路径并做全部校验。
 * 相对路径接受 / 或 \ 分隔；拒绝绝对路径与 `..`。
 * @param {string} rootAbs 已规范化的 vault 根
 * @param {string} rel 相对路径（如 "Prompt/xx.md"）
 * @returns {string} 绝对路径
 */
export function resolveInside(rootAbs, rel) {
  if (typeof rel !== "string" || rel.trim() === "") {
    throw vaultError(C.VAULT_PATH_ESCAPE, "空路径被拒绝");
  }
  const norm = rel.replaceAll("\\", "/");
  if (path.isAbsolute(rel) || norm.startsWith("/") || /^[A-Za-z]:/.test(norm)) {
    throw vaultError(C.VAULT_PATH_ESCAPE, `绝对路径被拒绝: ${rel}`);
  }
  if (norm.split("/").includes("..")) {
    throw vaultError(C.VAULT_PATH_ESCAPE, `含 .. 的路径被拒绝: ${rel}`);
  }
  const abs = path.resolve(rootAbs, ...norm.split("/"));
  assertInside(rootAbs, abs);
  return abs;
}

/**
 * realpath 复检：符号链接/junction 穿透后仍在 root 内才放行。
 * 目标不存在时对最近存在的父目录做复检（写场景）。
 * @returns {string} 真实路径
 */
export function realpathChecked(rootAbs, abs) {
  let probe = abs;
  let real;
  for (;;) {
    try {
      real = fs.realpathSync(probe);
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) {
        // 一路到根都不存在（root 本身已校验存在，不会到这）
        return assertInside(rootAbs, abs);
      }
      probe = parent;
    }
  }
  assertInside(fs.realpathSync(rootAbs), real);
  return real;
}

/** 绝对路径 → vault 相对路径（posix 分隔），仅用于已知在库内的路径。 */
export function toVaultRel(rootAbs, abs) {
  const rel = path.relative(rootAbs, abs);
  return rel.split(path.sep).join("/");
}

/** 相对路径规范化（posix 分隔、去尾斜杠），供存储与比较。 */
export function normalizeRel(rel) {
  return rel.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}
