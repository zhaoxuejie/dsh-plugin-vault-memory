// dsh-plugin-vault-memory — vault_query 工具（结构化查询）

import { vaultError, VAULT_ERROR_CODES as C } from "../errors.mjs";

const DESCRIPTION = `在已配置的本地 Obsidian 知识库（vault）里做结构化查询：按目录、标签、修改时间、frontmatter 键过滤笔记，返回清单。
结果必带 vault 内相对路径 path；引用笔记内容时必须给出该 path。找不到就说没有，禁止编造。`;

const SORTS = ["modified_desc", "modified_asc", "title_asc"];

export function registerVaultQueryTool(ctx, runtime) {
  ctx.tools.register({
    name: "vault_query",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        vault: { type: "string", description: "限定某个库（label 或路径片段）；缺省用第一个已配置库" },
        folder: { type: "string", description: "目录精确匹配（vault 内相对路径），空=全部" },
        tag: { type: "string", description: "限定标签（不带 #，忽略大小写）" },
        modified_since: { type: "string", description: "修改时间下限，如 2026-01-01 或 2026-01-01T08:00:00" },
        modified_until: { type: "string", description: "修改时间上限，格式同上" },
        has_fm_key: { type: "string", description: '只返回带某 frontmatter 键的笔记，如 "tags"' },
        sort: { type: "string", description: "modified_desc（默认）| modified_asc | title_asc" },
        limit: { type: "number", description: "返回上限（默认 50）" },
        fields: { type: "array", items: { type: "string" }, description: "额外返回的 frontmatter 键值列表" },
      },
    },
    timeoutMs: 15000,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          vault: { type: "string" },
          total: { type: "number" },
          notes: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                title: { type: "string" },
                folder: { type: "string" },
                mtime: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
                fm: { type: "object" },
              },
              required: ["path", "title", "folder", "mtime", "tags", "fm"],
            },
          },
        },
        required: ["vault", "total", "notes"],
      },
      render: (_args, value) => [{ type: "text", text: renderNotes(value) }],
    },
    async execute(args) {
      const { label, index } = runtime.resolveVault(args.vault);
      const sort = typeof args.sort === "string" && args.sort !== "" ? args.sort : "modified_desc";
      if (!SORTS.includes(sort)) {
        throw vaultError(C.INVALID_ARG, `vault_query: 不支持的 sort: ${args.sort}（可选 ${SORTS.join("/")}）`);
      }
      const fields = Array.isArray(args.fields) ? args.fields.map(String).slice(0, 20) : [];
      const notes = index.query({
        folder: normStr(args.folder),
        tag: normStr(args.tag),
        modifiedSince: parseDateArg(args.modified_since, "modified_since"),
        modifiedUntil: parseDateArg(args.modified_until, "modified_until"),
        hasFmKey: normStr(args.has_fm_key),
        sort,
        limit: clampLimit(args.limit, runtime.cfg.searchMaxResults),
        fields,
      }).map((n) => ({
        path: n.path,
        title: n.title,
        folder: n.folder,
        mtime: new Date(n.mtime_ms).toISOString(),
        tags: n.tags,
        fm: n.fm,
      }));
      return { vault: label, total: notes.length, notes };
    },
  });
}

function normStr(v) {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function parseDateArg(v, name) {
  if (v === undefined || v === null || v === "") return null;
  const d = new Date(typeof v === "string" ? v : "");
  if (Number.isNaN(d.getTime())) {
    throw vaultError(C.INVALID_ARG, `vault_query: ${name} 时间格式无效（期望 YYYY-MM-DD 或 ISO 时间）: ${v}`);
  }
  return d;
}

function clampLimit(v, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return dflt;
  return Math.min(500, Math.floor(n));
}

function renderNotes(value) {
  if (value.total === 0) {
    return `vault_query 无结果（库: ${value.vault}）。库里没有符合条件的笔记，请如实告知用户，不要编造。`;
  }
  const lines = [`vault_query 返回 ${value.total} 条（库: ${value.vault}）：`];
  value.notes.forEach((n, i) => {
    const tags = n.tags.length > 0 ? ` [${n.tags.join(", ")}]` : "";
    const fm = Object.keys(n.fm).length > 0 ? ` fm=${JSON.stringify(n.fm)}` : "";
    lines.push(`${i + 1}. ${n.path} — ${n.title} (${n.folder || "根目录"}, ${n.mtime.slice(0, 10)})${tags}${fm}`);
  });
  return lines.join("\n");
}
