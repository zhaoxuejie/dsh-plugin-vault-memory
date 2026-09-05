// dsh-plugin-vault-memory — 会话记忆注入（memory-inject）
// 机制（已核实，见 docs/phase2-interface-spec.md §1.2）：
//   ctx.systemPrompt.context({ name, order, text }) → user 角色动态上下文快照，
//   text 为 provider（每次组装求值）；返回空串即不注入。
// 缓存：TTL 内复用蒸馏结果，避免每次请求重扫；注入上限受 memory.maxTokens 约束。

import { distillVaults, renderMemoryMarkdown } from "./core/distill.mjs";

const INJECT_NAME = "vault-memory:user-memory";
const INJECT_ORDER = 60;

const WRAPPER_HEAD = `## 用户本地知识库记忆快照（vault-memory）
以下来自用户 Obsidian 库的自动摘要，仅当与当前任务相关时参考；不确定的细节用 vault_search / vault_query / vault_read 核实，不要凭此编造。`;

/**
 * 注册动态上下文（user 角色快照，按次组装求值）。
 * @param {object} ctx plugin context（需含 systemPrompt）
 * @param {object} runtime { cfg, vaultKeys }
 * @returns dispose
 */
export function registerMemoryInject(ctx, runtime) {
  runtime.__memoryCache = { at: 0, rendered: "" };
  return ctx.systemPrompt.context({
    name: INJECT_NAME,
    order: INJECT_ORDER,
    text: () => {
      const cfg = runtime.cfg;
      if (!cfg.enabled || !cfg.memory.injectEnabled) return "";
      if (!Array.isArray(runtime.vaultKeys) || runtime.vaultKeys.length === 0) return "";
      const cache = runtime.__memoryCache;
      const now = Date.now();
      if (now - cache.at < cfg.memory.ttlMs && cache.rendered !== "") return cache.rendered;
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
