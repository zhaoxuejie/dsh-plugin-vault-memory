# dsh-plugin-vault-memory — Phase 3 接口实现规范（巡检引擎 + 语义检索）

> 依赖 Phase 1/2。Phase 3 交付：**巡检建议引擎（host 定时器 + 按需工具）、审查队列写回、语义嵌入 + hybrid 检索**。
> 调度修正：**不用 dsh-schedule**（其定位为会话内 agent 提醒：session 级投递、≥5min、冷会话不触发），改用**宿主定时器**（Cordis ctx.setInterval 类）驱动巡检 + `vault_health` 工具按需触发。
> ⚠️ 处为开工复核点。

---

## 1. 巡检引擎（review-engine.ts，纯函数优先）

### 1.1 触发方式

| 触发 | 实现 | 说明 |
|---|---|---|
| 定时 | `ctx.setInterval(每 1h) + 本地时刻到点检查`（每日 03:00 默认，可配 `review.cronHour`）| ⚠️ Cordis ctx 定时器签名开工复核（ctx.setInterval/setTimeout 返回 dispose 为准）|
| 按需 | `vault_health` 工具调 `engine.run(vault)` | 同一管线，前端加"立即巡检"按钮亦可 |
| 手动 | GUI"立即巡检" | POST `/vault-memory/review/run` |

去重与风暴控制：同 kind+同主键对在 `status=open` 时不再重复产生；每轮每 kind 上限（默认 orphan 100 / broken_link 200 / missing_link 20 / moc_draft 10 / duplicate 10 / stale 50）；产出行先写 suggestions 表（含 run_id/时间），绝不直接改笔记。

### 1.2 规则引擎契约

```ts
type SuggestInput = {
  notes: NoteRow[]            // 索引行
  links: LinkRow[]            // 全链接
  fm?: ...                    // 需要的 frontmatter 子集
}
type Rule = {
  kind: ReviewKind
  run(ctx: RuleCtx): SuggestionDraft[]   // 纯函数，无副作用
}
type SuggestionDraft = {
  kind: ReviewKind
  notePath: string           // 主对象
  targetPath?: string        // 对偶（duplicate/missing_link）
  reason: string             // 可解释理由（渲染给用户/agent）
  payload: Record<string, unknown>  // 结构性载荷，如 { draftMd } / { diff, backup }
  score: number
}
```

存储沿用 Phase 1 DDL 的 `suggestions` 表（已含 kind/reason/payload/status）。

### 1.3 各规则细节

| kind | 判定（草案阈值） | payload | reason 示例 |
|---|---|---|---|
| `orphan` | 入链数=0 且非 daily 且非"索引类"笔记（文件夹根 README/同名 md）| `{ proposedLinks: [{path, why}] }` | "无任何笔记引用它；同目录有 X、Y 可能相关" |
| `broken_link` | `links.resolved_note IS NULL` | `{ raw, candidates: [{path, score}] }` | "引用了不存在的 [[abc]]；疑似改为 X" |
| `missing_link` | 语义/共引相似对但无直接链接（v1.1 起嵌入参与）| `{ a, b, basis }` | "A 与 B 被 C、D 共同引用但互不链接" |
| `moc_draft` | folder 内 md>8 且无该目录同名/README 索引 | `{ draftMd }` | "Prompt/ 下 23 篇无总览，已生成 MOC 草稿" |
| `duplicate` | 标题归一化相似 + 内容 Jaccard≥0.8（v1.1 加嵌入）| `{ diff, backup: 旧内容快照, mergeProposal }` | "与 [[X]] 内容重叠度 0.91，疑似重复" |
| `stale` | score 高但 >180 天未改，且其入链笔记近 30 天有更新 | `{ lastModified, inlinkUpdates }` | "2024-03 后未更新，但 3 篇引用笔记近月有改动" |

引擎骨架：`run(vaultId) { for rule of rules: drafts=rule(ctx); batchInsert(dedup, caps) ; snapshotHealth() }`；每规则独立 try/catch（单规则崩溃不影响其他）；记录 `health_snapshots` 行供 GUI 趋势。

---

## 2. 审查队列写回（apply 语义，安全核心）

**铁律**：写回只发生在 GUI 逐条 approve 或 agent 显式执行且用户确认之后；引擎与规则本身零写权限。

| 操作 | 实现 | 失败处理 |
|---|---|---|
| approve(orphan) | 在目标笔记尾部/适当处**追加** proposedLinks 中用户勾选项的 `- [[x]]` 到"相关"区（若该笔记有 `## 相关` 则并入）| 单笔记写失败 → status 不变 + error 字段 |
| approve(broken_link) | 按 candidates[0] 重写引用处文本（payload 存原文 `backup`，**可 revert**）| 同上 |
| approve(missing_link) | 在 A 的"相关"区追加 B（B 反向同理由不追加，防对称双写）| 同上 |
| approve(moc_draft) | 新建 `<folder>/<folder>.md`（或 README.md，可配）；文件已存在 → 转 duplicate 语义报错 | 已存在 → `MocExists`，不覆盖 |
| approve(duplicate) | **只做合并草稿不自动删**：默认动作 = 把 backup 内容写入主笔记的"归档段"并给副笔记标 `#archive`（不删除任何文件）| 先备份至 payload.backup |
| approve(stale) | 不动文件：生成"复审问答"草稿供用户填写更新 | — |

写盘统一走 `writeNoteAtomic(vault, path, content)`（.tmp→rename + 触发重解析 + 记 backup 到 suggestion.payload.backup）。revert = 用 backup 原样还原并 status=reverted。

并发：同一 suggestion 的 approve 请求幂等（status≠open 直接返回已处理）。

---

## 3. 语义嵌入 + hybrid 检索（v1.1，依赖本地模型）

### 3.1 嵌入服务契约（embeddings/embedder.ts）

```ts
interface Embedder {
  embed(texts: string[]): Promise<{ vecs: number[][]; dim: number }>
  // 批量、顺序保证与 texts 一致
}
// 实现：
//  - OllamaEmbedder（默认）：GET/POST http://127.0.0.1:11434/api/embed
//      body { model, input: texts[] }；默认模型 nomic-embed-text（bge-m3 可配）
//  - OpenAICompatEmbedder（可选）：POST {baseUrl}/embeddings，OpenAI 兼容
//      body { model, input }；baseUrl 可配（siliconflow/火山/any）——⚠️ DeepSeek 官方目前无 embedding
//      端点，默认推荐仍是 Ollama；选 API 时 GUI 明示"将发送 vault 片段到第三方"
```

网络访问 ⚠️：插件向 localhost:11434 / 外部 API 发 HTTP —— 需复核沙箱对插件出网的限制（node fetch 直连 vs ctx.web 服务）。

### 3.2 分块与入库

- 分块：按 Phase 1 `sections` 表（章节），标题+正文；每块 ≤ 512 token（中英文按字符粗切，超长截断）；块元信息记 `(note_id, seq, heading)`。
- 表：Phase 1 DDL 已有 `embeddings(note_id, block_type, block_id, model, dim, vec BLOB)`；`vec` 存 float32 小端。索引全量重算按模型分版本（model 列区分，避免混版本检索）。
- 增量：文件重解析时，旧块删除、新块异步补嵌（后台队列，避免工具调用阻塞）。

### 3.3 检索融合

```
fts 命中（BM25）        ─┐
                          ├─ RRF 融合（k=60）→ topK → 按块回溯 note 层聚合
向量命中（块级余弦 topK）─┘
```
- 查询向量：同一 embedder 对 query 嵌入。
- `vault_search` 增加参数 `mode: "fts" | "semantic" | "hybrid"`（默认 fts，保持 Phase 1 语义；v1.1 默认仍 fts，用户在设置/请求里开 hybrid）。
- 片段：命中块 → 用块文本生成 snippet；语义命中给"为什么像"的可解释信号（同标签/同章节主题词可后补）。

### 3.4 设置项新增

| 键 | 默认 | 说明 |
|---|---|---|
| `embed.enabled` | false | v1.1 起可开；false 时 semantic/hybrid 报 `EmbedNotEnabled` |
| `embed.provider` | "ollama" | ollama \| openai-compatible |
| `embed.baseUrl` | "http://127.0.0.1:11434" | ollama 或兼容端点 |
| `embed.model` | "nomic-embed-text" | |
| `embed.apiKey` | "" | 仅 openai-compatible 用；secret 角色（不进响应/日志）|
| `embed.chunkTokens` | 512 | |
| `embed.batchSize` | 16 | |

---

## 4. vault_health 工具

```ts
parameters: {
  vault: { type: "string", ... },
  run:   { type: "boolean", description: "true 则立即跑一轮巡检（默认 false 只读报告）" },
  kinds: { type: "array", items: { type: "string", enum: [...] }, description: "限定 kind" },
}
output: {
  vault, updatedAt,
  health: { notes, orphans, brokenLinks, duplicates, stale, missingLinks, mocNeeded },  // open 计数
  open:   [{ id, kind, path, reason, score, created_at }],   // 只给元数据，正文 payload 走 GUI
  ran: boolean
}
```

描述强调：只读报告默认不写库；巡检只生成建议；任何库内改动需用户批准。

---

## 5. 路由增量（GUI 用，webServer.register）

| 路由 | 说明 |
|---|---|
| GET `/vault-memory/review/run?kinds=` | 立即巡检（同步等待 or 202 + 轮询 ⚠️ 选同步简单版：小库秒级） |
| POST `/vault-memory/review/approve` `{id, options?}` | options 如 orphan 勾选哪些 proposedLinks |
| POST `/vault-memory/review/dismiss` `{id, reason?}` | |
| POST `/vault-memory/review/revert` `{id}` | 用 payload.backup 还原 |
| GET `/vault-memory/review/item` `?id=` | 单条详情（payload 全文，diff 渲染）|

面板审查 tab 于 Phase 2 已建，Phase 3 接真数据 + 批准按钮生效。

---

## 6. 测试与验收

- 规则纯函数：fixture 构造孤儿/断链/共引对/超阈值目录/近似重复 → 断言 draft 集与理由；阈值边界。
- 写回：approve 后文件内容正确、备份可 revert、status 流转 open→applied→reverted；重复 approve 幂等。
- 嵌入：mock embedder（固定向量）验证入库/删除/查询；真实 Ollama 冒烟（未装则 skip 标记 ⚠️ 视用户环境）。
- hybrid：在含语义同义（词面不同意思相同）的 fixture 上 hybrid 命中率 > 纯 fts。
- 定时：缩短周期测试环境触发一次巡检、去重生效、风暴上限生效。
- 验收：真实库跑一轮 vault_health → GUI 队列出现孤儿/断链 → 逐条批准 → vault 内出现预期改动且可 revert；语义检索 demo 查询（用户提供真实问题）质量可感知优于纯关键词。

---

## 7. Phase 3 任务清单

- [ ] Step 0：复核 Cordis 定时器 API、插件出网约束、Ollama 环境（用户机器是否装/模型名）
- [ ] review-engine 纯函数规则（orphan/broken_link/moc_draft → missing_link/duplicate/stale 标记 v1.1）
- [ ] vault_health 工具（run 开关 + kinds）
- [ ] 定时触发 + health_snapshots
- [ ] apply/revert 写回 + backup + 幂等
- [ ] GUI 审查 tab 真数据接入 + approve/dismiss/revert 按钮
- [ ] embedder 双实现 + sections/embeddings 入库 + RRF hybrid（`vault_search.mode`）
- [ ] 单测 + 真实库验收

---

## 8. 明确不做（Phase 3 边界）

- ❌ 自动删除任何用户笔记（duplicate 只归档标记，永不删）
- ❌ 无人确认的自动写盘（引擎零写权限）
- ❌ 日历/cron 表达式（宿主定时器只做小时级检查 + 到点执行）
- ❌ 多机同步 / vault 之外第二存储源
- ❌ RAG 长文问答管道（那是 obsidian-copilot 的领地；DSH 侧由 agent 用工具自取上下文）
