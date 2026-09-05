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
  memory: Schema.object({
    injectEnabled: Schema.boolean().default(true),
    maxTokens: Schema.number().min(100).max(8000).default(1200),
    ttlMs: Schema.number().min(1000).default(600000),
  }).default(() => ({})),
  capture: Schema.object({
    defaultFolder: Schema.string().default("Captures"),
    sourceTag: Schema.string().default(""),
  }).default(() => ({})),
  gui: Schema.object({
    enabled: Schema.boolean().default(true),
  }).default(() => ({})),
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
  memory: { injectEnabled: true, maxTokens: 1200, ttlMs: 600000 },
  capture: { defaultFolder: "Captures", sourceTag: "" },
  gui: { enabled: true },
});

/** 把 settings 服务的解析结果归一为普通对象（兜底未注册时的默认值）。 */
export function resolveConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const mem = { ...DEFAULT_CONFIG.memory, ...(src.memory && typeof src.memory === "object" ? src.memory : {}) };
  const cap = { ...DEFAULT_CONFIG.capture, ...(src.capture && typeof src.capture === "object" ? src.capture : {}) };
  const gui = { ...DEFAULT_CONFIG.gui, ...(src.gui && typeof src.gui === "object" ? src.gui : {}) };
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
    memory: {
      injectEnabled: mem.injectEnabled !== false,
      maxTokens: clampInt(mem.maxTokens, DEFAULT_CONFIG.memory.maxTokens, 100, 8000),
      ttlMs: clampInt(mem.ttlMs, DEFAULT_CONFIG.memory.ttlMs, 1000, 3600000 * 24),
    },
    capture: {
      defaultFolder: typeof cap.defaultFolder === "string" ? cap.defaultFolder : DEFAULT_CONFIG.capture.defaultFolder,
      sourceTag: typeof cap.sourceTag === "string" ? cap.sourceTag : "",
    },
    gui: { enabled: gui.enabled !== false },
  };
}

function clampInt(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
