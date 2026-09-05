// dsh-plugin-vault-memory — 插件入口（Phase 1+2：索引、工具集、记忆注入、GUI 路由）
// 契约参照 dsh-daily-digest / dsh-tool-fs-search（已真源码校准）：
//   export const name/inject/Config + export function apply(ctx, entryConfig)
//   settings.register(name, schema, {applies:'live', base}) 三层解析；ctx.effect 清理。

import path from "node:path";
import os from "node:os";
import { configSchema, resolveConfig } from "./config.mjs";
import { VaultIndex, vaultDbPath } from "./core/index.mjs";
import { vaultError, VAULT_ERROR_CODES as C } from "./errors.mjs";
import { provenancePromptText } from "./prompt.mjs";
import { registerVaultSearchTool } from "./tools/vault-search.mjs";
import { registerVaultQueryTool } from "./tools/vault-query.mjs";
import { registerVaultReadTool } from "./tools/vault-read.mjs";
import { registerVaultRelatedTool } from "./tools/vault-related.mjs";
import { registerVaultCaptureTool } from "./tools/vault-capture.mjs";
import { registerVaultHealthTool } from "./tools/vault-health.mjs";
import { registerMemoryInject, invalidateMemoryCache } from "./memory-inject.mjs";
import { registerVaultRoutes } from "./server/routes.mjs";

export const name = "dsh-plugin-vault-memory";
export const inject = ["tools", "settings", "systemPrompt"];
export const Config = configSchema;

export function apply(ctx, entryConfig) {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  let settingsScope = null;

  const runtime = {
    cfg: resolveConfig(entryConfig),
    dshHome,
    indexes: new Map(), // rootAbs -> VaultIndex
    vaultKeys: [],      // [{ rootAbs, label, path, error? }]
    resolveVault(vaultSel) {
      if (!runtime.cfg.enabled) {
        throw vaultError(C.VAULT_NOT_CONFIGURED, "vault-memory 插件未启用（设置 enabled=false）；请先在插件设置中启用并配置 vault 路径。");
      }
      if (runtime.vaultKeys.length === 0) {
        throw vaultError(C.VAULT_NOT_CONFIGURED, "未配置任何 vault：请在设置里为 dsh-plugin-vault-memory 添加 vaults[].path（本地 Obsidian 库路径）。");
      }
      let hit = runtime.vaultKeys[0];
      if (vaultSel !== undefined && vaultSel !== null && vaultSel !== "") {
        const sel = String(vaultSel).toLowerCase();
        const found = runtime.vaultKeys.find((k) =>
          (k.label && k.label.toLowerCase().includes(sel)) ||
          k.path.toLowerCase().includes(sel) ||
          k.rootAbs.toLowerCase().includes(sel));
        if (!found) throw vaultError(C.VAULT_NOT_FOUND, `找不到匹配的 vault: ${vaultSel}（已配置: ${runtime.vaultKeys.map((k) => k.label || k.path).join(", ")}）`);
        hit = found;
      }
      if (hit.error) throw vaultError(C.VAULT_UNREADABLE, `vault 不可用: ${hit.path}（${hit.error}）`);
      const idx = runtime.indexes.get(hit.rootAbs);
      if (!idx) throw vaultError(C.INDEX_NOT_READY, `vault 索引实例未就绪: ${hit.path}`);
      return { label: hit.label || hit.path, index: idx };
    },
    /** GUI 配置写入：经 settings 用户层（scope.update 持久化并触发 watch） */
    async applySettingsPatch(patch) {
      if (!settingsScope || typeof settingsScope.update !== "function") {
        throw vaultError(C.INVALID_ARG, "settings 服务不可用，无法在线修改配置");
      }
      // 只接受白名单键，防注入无关字段
      const allowed = new Set(["enabled", "vaults", "ignoreGlobs", "ignoreDotDirs", "watchIntervalMs", "dbDir", "memory", "capture", "review", "gui"]);
      const clean = {};
      for (const k of Object.keys(patch)) {
        if (!allowed.has(k)) throw vaultError(C.INVALID_ARG, `不支持的配置键: ${k}`);
      }
      if (patch.vaults !== undefined) {
        if (!Array.isArray(patch.vaults)) throw vaultError(C.INVALID_ARG, "vaults 必须是数组");
        const norm = [];
        for (const v of patch.vaults) {
          if (!v || typeof v.path !== "string" || v.path.trim() === "") {
            throw vaultError(C.INVALID_ARG, "vaults 每项需含非空 path");
          }
          path.resolve(v.path); // 提前解析校验格式
          norm.push({ path: v.path.trim(), label: v.label ? String(v.label).trim() : undefined });
        }
        clean.vaults = norm;
      }
      if (patch.enabled !== undefined) clean.enabled = patch.enabled === true;
      if (patch.memory && typeof patch.memory === "object") clean.memory = patch.memory;
      if (patch.capture && typeof patch.capture === "object") clean.capture = patch.capture;
      if (patch.review && typeof patch.review === "object") clean.review = patch.review;
      if (patch.gui && typeof patch.gui === "object") clean.gui = patch.gui;
      await settingsScope.update(name, clean);
      // watch 回调里已 rebuildIndexes；此处同步兜底（如无 watch）
      invalidateMemoryCache(runtime);
    },
  };

  function rebuildIndexes() {
    for (const idx of runtime.indexes.values()) idx.close();
    runtime.indexes.clear();
    runtime.vaultKeys = [];
    invalidateMemoryCache(runtime);
    const cfg = runtime.cfg;
    if (!cfg.enabled) return;
    for (const v of cfg.vaults) {
      const rootAbs = path.resolve(v.path);
      try {
        const idx = new VaultIndex({
          root: v.path,
          dbPath: vaultDbPath(cfg.dbDir, dshHome, rootAbs),
          opts: cfg,
        });
        runtime.indexes.set(rootAbs, idx);
        runtime.vaultKeys.push({ rootAbs, label: v.label || undefined, path: v.path, index: idx });
        idx.startWatcher(cfg.watchIntervalMs);
        // 后台首扫：不阻塞宿主启动；首个工具调用另有 ensureReady 同步兜底
        setImmediate(() => {
          try {
            idx.fullScan();
          } catch {
            /* 扫描失败在工具调用时报出 */
          }
        });
      } catch (e) {
        runtime.vaultKeys.push({
          rootAbs,
          label: v.label || undefined,
          path: v.path,
          error: e && e.message ? e.message : String(e),
        });
      }
    }
  }

  // --- 设置（settings 服务缺失时退回默认值/入口 config，不崩） ---
  // 分层：schema 默认 → entry config（base）→ 用户 settings.yaml（user），settings 服务负责合并。
  let unwatch = null;
  const settings = ctx.get("settings");
  if (settings && typeof settings.register === "function") {
    try {
      const scope = settings.register(name, Config, {
        applies: "live",
        base: entryConfig && typeof entryConfig === "object" ? entryConfig : undefined,
      });
      settingsScope = scope;
      runtime.cfg = resolveConfig(scope.get());
      unwatch = scope.watch((next) => {
        runtime.cfg = resolveConfig(next);
        rebuildIndexes();
      });
    } catch {
      /* 注册失败 → 使用入口 config/默认配置 */
    }
  }

  // --- 工具 + 溯源段 + 记忆注入（全部返回 dispose，统一进 effect 清理） ---
  const disposers = [];
  if (ctx.tools) {
    disposers.push(registerVaultSearchTool(ctx, runtime));
    disposers.push(registerVaultQueryTool(ctx, runtime));
    disposers.push(registerVaultReadTool(ctx, runtime));
    disposers.push(registerVaultRelatedTool(ctx, runtime));
    disposers.push(registerVaultCaptureTool(ctx, runtime));
    disposers.push(registerVaultHealthTool(ctx, runtime));
  }
  if (ctx.systemPrompt) {
    if (typeof ctx.systemPrompt.section === "function") {
      disposers.push(ctx.systemPrompt.section({
        name: "vault-memory-provenance",
        order: 120,
        text: provenancePromptText,
      }));
      disposers.push(registerMemoryInject(ctx, runtime)); // 记忆快照段（动态 provider）
    }
  }

  // --- 每日定时巡检（review.enabled 时；ctx.interval 优先，缺失退回原生 setInterval） ---
  function scheduleDailyReview() {
    const HOUR_MS = 3600 * 1000;
    const tick = () => {
      const cfg = runtime.cfg;
      if (!cfg.enabled || !cfg.review.enabled) return;
      if (new Date().getHours() !== cfg.review.hour) return;
      for (const k of runtime.vaultKeys) {
        if (k.error || !k.index || !k.index.ready) continue;
        try {
          k.index.reviewRun({ mocThreshold: cfg.review.mocThreshold });
        } catch {
          /* 单库巡检失败不影响其他库 */
        }
      }
    };
    try {
      // ctx.interval 由 @cordisjs/plugin-timer 提供；未挂载时读取会抛 "without inject"
      return ctx.interval(tick, HOUR_MS);
    } catch {
      const t = setInterval(tick, HOUR_MS);
      if (t.unref) t.unref();
      return () => clearInterval(t);
    }
  }

  // --- GUI 数据路由（web profile；webServer 缺失时跳过） ---
  const webServer = ctx.get("webServer");
  if (webServer && typeof webServer.register === "function") {
    try {
      registerVaultRoutes(webServer, runtime);
      disposers.push(() => {
        // webServer.register 的生命周期归 Loader；无独立 dispose
      });
    } catch {
      /* 路由注册失败不影响核心功能 */
    }
  }

  rebuildIndexes();
  disposers.push(scheduleDailyReview());

  ctx.effect(() => () => {
    if (typeof unwatch === "function") unwatch();
    for (const d of disposers) {
      try {
        d();
      } catch {
        /* 忽略清理异常 */
      }
    }
    for (const idx of runtime.indexes.values()) idx.close();
    runtime.indexes.clear();
  });
}
