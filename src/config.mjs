// dsh-plugin-vault-memory — 设置 schema（schemastery）+ 默认值
// 唯一 import schemastery 的模块之一（core 保持零依赖）。

import Schema from "schemastery";

export const configSchema = Schema.object({
  enabled: Schema.boolean().default(true),
  vaults: Schema.array(
    Schema.object({
      path: Schema.string().required(),
      label: Schema.string(),
    }),
  ).default([]),
  ignoreGlobs: Schema.array(Schema.string()).default([]),
  ignoreDotDirs: Schema.boolean().default(true),
  watchIntervalMs: Schema.number().min(1000).max(3600000).default(10000),
  searchMaxResults: Schema.number().min(1).max(500).default(50),
  snippetChars: Schema.number().min(40).max(2000).default(200),
  dbDir: Schema.string().default(""),
});

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  vaults: [],
  ignoreGlobs: [],
  ignoreDotDirs: true,
  watchIntervalMs: 10000,
  searchMaxResults: 50,
  snippetChars: 200,
  dbDir: "",
});

/** 把 settings 服务的解析结果归一为普通对象（兜底未注册时的默认值）。 */
export function resolveConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: src.enabled !== false,
    vaults: Array.isArray(src.vaults)
      ? src.vaults.filter((v) => v && typeof v.path === "string" && v.path.trim() !== "")
          .map((v) => ({ path: v.path.trim(), label: typeof v.label === "string" ? v.label.trim() : undefined }))
      : [],
    ignoreGlobs: Array.isArray(src.ignoreGlobs) ? src.ignoreGlobs.map(String) : [],
    ignoreDotDirs: src.ignoreDotDirs !== false,
    watchIntervalMs: clampInt(src.watchIntervalMs, DEFAULT_CONFIG.watchIntervalMs, 1000, 3600000),
    searchMaxResults: clampInt(src.searchMaxResults, DEFAULT_CONFIG.searchMaxResults, 1, 500),
    snippetChars: clampInt(src.snippetChars, DEFAULT_CONFIG.snippetChars, 40, 2000),
    dbDir: typeof src.dbDir === "string" ? src.dbDir : "",
  };
}

function clampInt(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
