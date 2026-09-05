// dsh-plugin-vault-memory — vault_search 工具（全文/语义/hybrid 检索 + 溯源）

import { vaultError, VAULT_ERROR_CODES as C } from "../errors.mjs";

const DESCRIPTION = `在已配置的本地 Obsidian 知识库（vault）里做检索，返回按相关度排序的命中笔记及上下文片段。
命中必带 vault 内相对路径 path；引用笔记内容时必须给出该 path。找不到就说没有，禁止编造笔记内容。
支持中文（bigram 分词）与英文；短查询零命中时自动子串兜底。
mode：fts（全文，默认）| semantic（语义）| hybrid（融合）；语义/hybrid 依赖本地 Ollama（设置 embed.enabled），不可用时自动回退 fts。`;

export function registerVaultSearchTool(ctx, runtime) {
  ctx.tools.register({
    name: "vault_search",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        q: { type: "string", description: "检索词（多个词默认 AND 匹配）" },
        vault: { type: "string", description: "限定某个库（配置的 label 或路径片段）；缺省用第一个已配置库" },
        folder: { type: "string", description: '限定目录前缀，如 "Prompt"' },
        tag: { type: "string", description: "限定标签（不带 #，忽略大小写）" },
        mode: { type: "string", description: "fts（默认）| semantic | hybrid" },
        limit: { type: "number", description: `返回上限（默认 ${50}）` },
      },
      required: ["q"],
    },
    timeoutMs: 60000,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          vault: { type: "string" },
          query: { type: "string" },
          engine: { type: "string" },
          total: { type: "number" },
          hits: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                title: { type: "string" },
                score: { type: "number" },
                snippet: { type: "string" },
              },
              required: ["path", "title", "score", "snippet"],
            },
          },
        },
        required: ["vault", "query", "engine", "total", "hits"],
      },
      render: (_args, value) => [{ type: "text", text: renderHits(value) }],
    },
    async execute(args) {
      const q = typeof args.q === "string" ? args.q.trim() : "";
      if (!q) throw vaultError(C.INVALID_ARG, "vault_search: q 不能为空");
      const mode = typeof args.mode === "string" ? args.mode : "fts";
      if (!["fts", "semantic", "hybrid"].includes(mode)) {
        throw vaultError(C.INVALID_ARG, `vault_search: 不支持的 mode: ${args.mode}（可选 fts/semantic/hybrid）`);
      }
      const { label, index } = runtime.resolveVault(args.vault);
      const limit = clampLimit(args.limit, runtime.cfg.searchMaxResults);
      let res;
      try {
        res = await index.searchSmart(q, {
          limit,
          mode,
          folder: typeof args.folder === "string" && args.folder !== "" ? args.folder : null,
          tag: typeof args.tag === "string" ? args.tag : null,
        });
      } catch (e) {
        if (e instanceof Error && e.code) throw e;
        throw vaultError(C.SEARCH_FAILED, `vault_search 执行失败: ${e.message}`, e);
      }
      return { vault: label, query: q, engine: res.engine, total: res.total, hits: res.hits };
    },
  });
}

function clampLimit(v, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return dflt;
  return Math.min(500, Math.floor(n));
}

function renderHits(value) {
  const engineTag = value.engine && value.engine !== "fts" ? ` [${value.engine}]` : "";
  if (value.total === 0) {
    return `vault_search 无命中（库: ${value.vault}，查询: "${value.query}"）${engineTag}。库里没有找到相关内容，请如实告知用户，不要编造笔记。`;
  }
  const lines = [`vault_search 命中 ${value.total} 条（库: ${value.vault}，查询: "${value.query}"${engineTag}）：`];
  value.hits.forEach((h, i) => {
    lines.push(`${i + 1}. ${h.path} — ${h.title} (score ${h.score})`);
    lines.push(`   ${h.snippet}`);
  });
  return lines.join("\n");
}
