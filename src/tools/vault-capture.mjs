// dsh-plugin-vault-memory — vault_capture 工具（会话产出落盘，唯一写入口）
// 授权语义：仅在用户明确要求保存时由 agent 调用（对话层即授权）；
// 写入经路径监狱 + 原子写（.tmp→rename）+ 立即重解析入库；不静默改/删既有笔记。

import { vaultError, VAULT_ERROR_CODES as C } from "../errors.mjs";

const DESCRIPTION = `把会话产出保存为知识库新笔记：自动 frontmatter（tags/source/created/updated），可附加库内关联建议。
只在用户明确要求保存时调用；同名已存在会报错（不要覆盖），可换标题或改 folder 重试。写入路径会返回给用户确认。`;

export function registerVaultCaptureTool(ctx, runtime) {
  ctx.tools.register({
    name: "vault_capture",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        vault: { type: "string", description: "限定某个库（label 或路径片段）；缺省用第一个已配置库" },
        title: { type: "string", description: "笔记标题（将作为文件名）" },
        body: { type: "string", description: "markdown 正文" },
        folder: { type: "string", description: '目标目录（vault 内相对路径），默认 "Captures"' },
        tags: { type: "array", items: { type: "string" }, description: "标签列表（不带 #）" },
        source: { type: "string", description: "来源标注（如会话主题/URL），写入 frontmatter source" },
        add_related: { type: "boolean", description: "是否按标题检索附加「关联」区（默认 true）" },
      },
      required: ["title", "body"],
    },
    timeoutMs: 15000,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          vault: { type: "string" },
          path: { type: "string" },
          folder: { type: "string" },
          preview: { type: "string" },
        },
        required: ["vault", "path", "folder", "preview"],
      },
      render: (_args, value) => [{ type: "text", text: `已保存到 ${value.path}（库: ${value.vault}）：\n\n${value.preview}` }],
    },
    async execute(args) {
      const { label, index } = runtime.resolveVault(args.vault);
      const folder = typeof args.folder === "string" && args.folder.trim() !== "" ? args.folder.trim() : runtime.cfg.capture.defaultFolder;
      const r = index.capture({
        title: args.title,
        body: args.body,
        folder,
        tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
        source: typeof args.source === "string" && args.source.trim() !== "" ? args.source.trim() : undefined,
        addRelated: args.add_related !== false,
      });
      return { vault: label, path: r.path, folder: folder || "", preview: r.note };
    },
  });
}
