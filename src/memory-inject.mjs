// dsh-plugin-vault-memory — 会话记忆注入（memory-inject）
// 机制说明（真机校准，见 docs/step0-calibration.md §9）：
//   1) ctx.systemPrompt.context()（user 角色动态上下文快照）在 headless preset 下未物化；
//      改走 ctx.systemPrompt.section() 的 provider 形态 —— 函数型 text 每次组装求值，
//      空串即不渲染，所有 preset 稳定渲染（已真机验证：函数型与静态 section 均可见）。
//   2) provider 可能早于后台全扫完成 → waitReady 确保索引就绪后再蒸馏，避免空注入。
//   3) runtime.vaultKeys 的每项必须携带 index 引用（否则蒸馏拿不到索引 → 永远空注入）。
// 缓存：TTL 内复用蒸馏结果；注入上限受 memory.maxTokens 约束。

import { distillVaults, renderMemoryMarkdown } from "./core/distill.mjs";

const INJECT_NAME = "vault-memory:user-memory";
const INJECT_ORDER = 60; // persona(0) 之后、工具指引(100-199) 之前

const WRAPPER_HEAD = `## 用户本地知识库记忆快照（vault-memory）
以下来自用户 Obsidian 库的自动摘要，仅当与当前任务相关时参考；不确定的细节用 vault_search / vault_query / vault_read 核实，不要凭此编造。`;

/**
 * 等索引就绪：先尝试同步 ensureReady；若后台扫描在跑（busy），短轮询等待。
 * @returns {boolean} 全部已配置（无 error）库就绪
 */
function waitReady(runtime, timeoutMs = 3000) {
  if (!Array.isArray(runtime.vaultKeys) || runtime.vaultKeys.length === 0) return false;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pending = runtime.vaultKeys.filter((k) => !k.error && (!k.index || !k.index.ready));
    if (pending.length === 0) return true;
    if (Date.now() > deadline) return false;
    for (const k of pending) {
      if (k.index && !k.index.busy && !k.index.ready) {
        try {
          k.index.ensureReady();
        } catch {
          /* 单库失败跳过 */
        }
      }
    }
    if (pending.every((k) => k.index && k.index.ready)) return true;
    // 粗等待后复查
    const pauseUntil = Date.now() + 15;
    while (Date.now() < pauseUntil) {
      /* busy-wait */
    }
  }
}

/**
 * 注册记忆快照段（动态 text provider；空库/未启用时返回空串不渲染）。
 * @param {object} ctx plugin context（需含 systemPrompt）
 * @param {object} runtime { cfg, vaultKeys }
 * @returns dispose
 */
export function registerMemoryInject(ctx, runtime) {
  runtime.__memoryCache = { at: 0, rendered: "" };
  return ctx.systemPrompt.section({
    name: INJECT_NAME,
    order: INJECT_ORDER,
    text: () => {
      const cfg = runtime.cfg;
      if (!cfg.enabled || !cfg.memory.injectEnabled) return "";
      if (!Array.isArray(runtime.vaultKeys) || runtime.vaultKeys.length === 0) return "";
      const cache = runtime.__memoryCache;
      const now = Date.now();
      if (now - cache.at < cfg.memory.ttlMs && cache.rendered !== "") return cache.rendered;
      if (!waitReady(runtime)) return "";
      const vaults = distillVaults(runtime.vaultKeys);
      if (!vaults.some((v) => v.ready)) return "";
      const maxChars = cfg.memory.maxTokens * 1; // 保守：1 字符 ≈ 1 token 上限
      const body = renderMemoryMarkdown(vaults, maxChars);
      if (!body) return "";
      cache.at = now;
      cache.rendered = `${WRAPPER_HEAD}\n\n${body}`;
      return cache.rendered;
    },
  });
}

/** 配置变更后使缓存失效（由插件入口在 rebuildIndexes 时调用）。 */
export function invalidateMemoryCache(runtime) {
  if (runtime.__memoryCache) runtime.__memoryCache.at = 0;
}
