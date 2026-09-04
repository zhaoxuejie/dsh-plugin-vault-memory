// dsh-plugin-vault-memory — vault_read 工具（按行读单篇，溯源阅读）

import { vaultError, VAULT_ERROR_CODES as C } from "../errors.mjs";

const DESCRIPTION = `读取本地 Obsidian 知识库（vault）中的单篇笔记，带行号，可指定行窗口。
直接读磁盘最新内容；路径不存在会报错。引用该笔记内容时用返回的 path。`;

export function registerVaultReadTool(ctx, runtime) {
  ctx.tools.register({
    name: "vault_read",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        vault: { type: "string", description: "限定某个库（label 或路径片段）；缺省用第一个已配置库" },
        path: { type: "string", description: 'vault 相对路径，如 "Prompt/xx.md"（可省略 .md 扩展名）' },
        offset: { type: "number", description: "起始行号（1 基，默认 1）" },
        limit: { type: "number", description: "返回行数（默认 200，上限 500）" },
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
          resolvedPath: { type: "string" },
          totalLines: { type: "number" },
          offset: { type: "number" },
          truncated: { type: "boolean" },
          lines: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                n: { type: "number" },
                text: { type: "string" },
              },
              required: ["n", "text"],
            },
          },
        },
        required: ["vault", "path", "resolvedPath", "totalLines", "offset", "truncated", "lines"],
      },
      render: (_args, value) => [{ type: "text", text: renderLines(value) }],
    },
    async execute(args) {
      const pathArg = typeof args.path === "string" ? args.path.trim() : "";
      if (!pathArg) throw vaultError(C.INVALID_ARG, "vault_read: path 不能为空");
      const { label, index } = runtime.resolveVault(args.vault);
      const offset = clampInt(args.offset, 1);
      const limit = clampInt(args.limit, 200);
      const r = index.readNote(pathArg, { offset, limit: Math.min(500, limit) });
      return { vault: label, path: r.path, resolvedPath: r.resolvedPath, totalLines: r.totalLines, offset: r.offset, truncated: r.truncated, lines: r.lines };
    },
  });
}

function clampInt(v, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return dflt;
  return Math.floor(n);
}

function renderLines(value) {
  const head = `vault_read ${value.path}（共 ${value.totalLines} 行，展示 ${value.offset}-${value.offset + value.lines.length - 1}${value.truncated ? "，后续未展示" : ""}）：`;
  const body = value.lines.map((l) => `${String(l.n).padStart(4, " ")}| ${l.text}`).join("\n");
  return value.lines.length === 0 ? `${head}\n（该行区间无内容）` : `${head}\n${body}`;
}
