// dsh-plugin-vault-memory — 插件入口（Phase 1：索引 + 工具集 + 溯源段）
// 契约参照 dsh-daily-digest / dsh-tool-fs-search（已真源码校准）：
//   export const name/inject/Config + export function apply(ctx)
//   settings.register(name, schema, {applies:'live'}) 热更新；ctx.effect 清理。

import path from "node:path";
import os from "node:os";
import { configSchema, resolveConfig } from "./config.mjs";
import { VaultIndex, vaultDbPath } from "./core/index.mjs";
import { vaultError, VAULT_ERROR_CODES as C } from "./errors.mjs";
import { provenancePromptText } from "./prompt.mjs";
import { registerVaultSearchTool } from "./tools/vault-search.mjs";
import { registerVaultQueryTool } from "./tools/vault-query.mjs";
import { registerVaultReadTool } from "./tools/vault-read.mjs";

export const name = "dsh-plugin-vault-memory";
export const inject = ["tools", "settings", "systemPrompt"];
export const Config = configSchema;

export function apply(ctx) {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");

  const runtime = {
    cfg: resolveConfig(null),
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
  };

  function rebuildIndexes() {
    for (const idx of runtime.indexes.values()) idx.close();
    runtime.indexes.clear();
    runtime.vaultKeys = [];
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
        runtime.vaultKeys.push({ rootAbs, label: v.label || undefined, path: v.path });
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

  // --- 设置（settings 服务缺失时退回默认值，不崩） ---
  let unwatch = null;
  const settings = ctx.get("settings");
  if (settings && typeof settings.register === "function") {
    try {
      const scope = settings.register(name, Config, { applies: "live" });
      runtime.cfg = resolveConfig(scope.get());
      unwatch = scope.watch((next) => {
        runtime.cfg = resolveConfig(next);
        rebuildIndexes();
      });
    } catch {
      /* 注册失败 → 使用默认配置 */
    }
  }

  // --- 工具 + 溯源段（全部返回 dispose，统一进 effect 清理） ---
  const disposers = [];
  if (ctx.tools) {
    disposers.push(registerVaultSearchTool(ctx, runtime));
    disposers.push(registerVaultQueryTool(ctx, runtime));
    disposers.push(registerVaultReadTool(ctx, runtime));
  }
  if (ctx.systemPrompt && typeof ctx.systemPrompt.section === "function") {
    disposers.push(ctx.systemPrompt.section({
      name: "vault-memory-provenance",
      order: 120,
      text: provenancePromptText,
    }));
  }

  rebuildIndexes();

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
