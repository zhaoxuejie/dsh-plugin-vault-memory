// dsh-plugin-vault-memory — vault_health 工具（巡检报告 + 可选立即巡检）

import { vaultError, VAULT_ERROR_CODES as C } from "../errors.mjs";

const KINDS = ["orphan", "broken_link", "moc_draft"];

const DESCRIPTION = `查看知识库健康与巡检建议：孤儿笔记、断链、缺目录总览等（按 kind 过滤，默认全部）。
巡检只生成带理由的建议清单，不会改动任何笔记；run=true 时才执行一轮巡检入库建议。
任何库内改动需你逐条批准（GUI 审查队列或明确指示），本工具绝不静默写盘。`;

export function registerVaultHealthTool(ctx, runtime) {
  ctx.tools.register({
    name: "vault_health",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        vault: { type: "string", description: "限定某个库（label 或路径片段）；缺省用第一个已配置库" },
        run: { type: "boolean", description: "true 则立即执行一轮巡检（默认 false 只读当前报告）" },
        kinds: {
          type: "array",
          items: { type: "string" },
          description: `限定建议类型：${KINDS.join(" | ")}（默认全部）`,
        },
        limit: { type: "number", description: "返回建议条数上限（默认 50）" },
      },
    },
    timeoutMs: 30000,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          vault: { type: "string" },
          ran: { type: "boolean" },
          inserted: { type: "number" },
          openTotal: { type: "number" },
          open: {
            type: "object",
            additionalProperties: true,
          },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "number" },
                kind: { type: "string" },
                target: { type: "string" },
                reason: { type: "string" },
                candidates: { type: "array", items: { type: "string" } },
              },
              required: ["id", "kind", "target", "reason"],
            },
          },
        },
        required: ["vault", "ran", "inserted", "openTotal", "open", "items"],
      },
      render: (_args, value) => [{ type: "text", text: renderHealth(value) }],
    },
    async execute(args) {
      const { label, index } = runtime.resolveVault(args.vault);
      const kinds = Array.isArray(args.kinds)
        ? args.kinds.filter((k) => KINDS.includes(String(k)))
        : undefined;
      let ran = false;
      let inserted = 0;
      if (args.run === true) {
        const r = index.reviewRun({ kinds, mocThreshold: runtime.cfg.review.mocThreshold });
        ran = true;
        inserted = r.inserted;
      }
      const stats = index.reviewStats();
      const openRows = index.ensureStore().openSuggestions({ limit: clampInt(args.limit, 50) });
      const items = openRows.map((s) => {
        const it = { id: s.id, kind: s.kind, target: s.target, reason: s.reason };
        const cand = s.payload && Array.isArray(s.payload.candidates) ? s.payload.candidates : undefined;
        if (cand) it.candidates = cand; // 避免显式 undefined 属性（无损 JSON 校验会拒绝）
        return it;
      });
      return {
        vault: label,
        ran,
        inserted,
        openTotal: stats.openTotal,
        open: stats.open,
        items,
      };
    },
  });
}

function clampInt(v, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return dflt;
  return Math.floor(n);
}

function renderHealth(value) {
  const head = value.ran
    ? `vault_health 巡检完成（库: ${value.vault}），新增建议 ${value.inserted} 条；当前 open ${value.openTotal} 条`
    : `vault_health 报告（库: ${value.vault}，只读）；当前 open ${value.openTotal} 条`;
  const lines = [head];
  if (value.openTotal > 0) {
    const parts = [];
    for (const [kind, count] of Object.entries(value.open)) if (count > 0) parts.push(`${kind} ${count}`);
    lines.push(`分布：${parts.join("，") || "无"}`);
    for (const it of value.items) {
      lines.push(`- [#${it.id} ${it.kind}] ${it.target} — ${it.reason}`);
    }
    lines.push("批准/忽略/回滚请经 GUI 审查队列，或明确指示 agent 用 vault_health 配套操作。");
  } else {
    lines.push("没有待处理建议。");
  }
  return lines.join("\n");
}
