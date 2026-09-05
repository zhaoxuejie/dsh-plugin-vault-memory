// dsh-plugin-vault-memory — vault_related 工具（链接邻居 + 标签/共引关联，溯源）

import { vaultError, VAULT_ERROR_CODES as C } from "../errors.mjs";

const DESCRIPTION = `返回与某篇笔记关联的其他笔记及理由：入链/出链/同标签/共引。
结果带 vault 内相对路径 path 与可解释 reason。找不到就说没有，不要编造。`;

export function registerVaultRelatedTool(ctx, runtime) {
  ctx.tools.register({
    name: "vault_related",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        vault: { type: "string", description: "限定某个库（label 或路径片段）；缺省用第一个已配置库" },
        path: { type: "string", description: '起点笔记路径（可省 .md），如 "Prompt/xx"' },
        limit: { type: "number", description: "返回上限（默认 10，最多 20）" },
      },
      required: ["path"],
    },
    timeoutMs: 15000,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          vault: { type: "string" },
          path: { type: "string" },
          total: { type: "number" },
          related: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                relation: { type: "string" },
                reason: { type: "string" },
                score: { type: "number" },
              },
              required: ["path", "relation", "reason", "score"],
            },
          },
        },
        required: ["vault", "path", "total", "related"],
      },
      render: (_args, value) => [{ type: "text", text: renderRelated(value) }],
    },
    async execute(args) {
      const rel = typeof args.path === "string" ? args.path.trim().replace(/\.md$/i, "") + ".md" : "";
      if (!rel || rel === ".md") throw vaultError(C.INVALID_ARG, "vault_related: path 不能为空");
      const { label, index } = runtime.resolveVault(args.vault);
      const limit = clampInt(args.limit, 10);
      const r = index.related(rel, { limit: Math.min(20, limit) });
      return { vault: label, path: r.path, total: r.total, related: r.related };
    },
  });
}

function clampInt(v, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return dflt;
  return Math.floor(n);
}

function renderRelated(value) {
  if (value.total === 0) {
    return `vault_related 无关联（${value.path}，库: ${value.vault}）。该笔记暂无其他链接/同标签笔记。`;
  }
  const lines = [`vault_related ${value.path} → ${value.total} 条关联（库: ${value.vault}）：`];
  value.related.forEach((r, i) => {
    const tag = { inlink: "入链", outlink: "出链", "tag-shared": "同标签", "co-cited": "共引" }[r.relation] || r.relation;
    lines.push(`${i + 1}. ${r.path} [${tag}] — ${r.reason}`);
  });
  return lines.join("\n");
}
