# dsh-plugin-vault-memory — Phase 2 接口实现规范（记忆注入 + Web GUI + 捕获）

> 依赖 Phase 1（`docs/phase1-interface-spec.md`）的 core 与工具层。Phase 2 交付：**会话记忆注入、vault_related / vault_capture 工具、client GUI（健康 + 审查队列 + 捕获）**。
> API 形状均经真源码校准；⚠️ 处为开工必复核点。

---

## 1. 会话记忆注入（Memory Injection）

### 1.1 目标与约束

- 新会话开始，agent 应"想起"用户：身份画像、活跃项目、近期相关笔记。
- 注入内容 = 只读快照，来自 Phase 1 的 SQLite（不需要新存储，新增**派生产物**）。
- 约束：默认开启但可关（`memory.injectEnabled`）；token 上限（默认 1200）；只注入与当前会话 scope 匹配的内容；subagent/派生代理默认不注入（避免每层都灌一遍）。

### 1.2 已核实机制（选型）

来自 `@deepseek-ai/dsh-system-prompt`（类型已读）：

| 机制 | 签名 | 用在哪 |
|---|---|---|
| 静态指引段 | `ctx.systemPrompt.section({ name, order, text })`，order 100–199 | Phase 1 溯源规则（已用）；此处补"记忆层使用说明" |
| **动态段 provider** | `text: string \| ((asm: AssembleContext) => string)`，每次组装求值，返回空串即不渲染 | **主选**：按 scope 决定是否注入画像 |
| 动态上下文快照 | `ctx.systemPrompt.context({ name, order, text })` → user 角色快照 | 备选/组合：画像作为"你的记忆片段"user 消息注入，比塞进 system 更不易被忽略 |
| 单 agent 作用域 | 在 `agent.ctx` 上注册则只对该 agent 生效 | 过滤 subagent 的途径（⚠️ 需确认拿到 agent.ctx 的时机/方式） |

### 1.3 派生产物（distill.ts，新模块）

```ts
type MemorySnapshot = {
  profile: string           // 画像 markdown（身份/领域/常驻偏好/常用约定）
  projects: string[]        // 活跃项目行（folder 聚类 + 近期 modified 热区）
  today: NoteRef[]          // 今日新建/修改笔记（path, title）
  recent: NoteRef[]         // 近 7 天高 score 笔记 top N
}
type NoteRef = { path: string; title: string; modified: string }

// core 新增只读方法：
//   core.distill(vaults, opts) -> MemorySnapshot
//     profile：取「欢迎.md / Home / 根级总览」+ 高频 folder 内 top 笔记 → 摘要
//     projects：按 folder 统计近 30 天 modified 的 md，取 top 3-5 个 folder 为活跃项目
// 实现为纯函数 + 缓存（TTL 10min），不每次组装都重算
```

### 1.4 注入器（memory-inject.ts）

```ts
// 全局注册一次（apply 内）：
ctx.systemPrompt.context({
  name: "vault-memory:user-memory",
  order: 60,                                        // 排在多数上下文前 ⚠️ 与既有 order 用法核对
  text: (asm) => {
    if (!cfg.memory.injectEnabled) return ""
    if (isDerivedScope(asm)) return ""              // subagent 不注入（scope 过滤 ⚠️ 见 1.6）
    const snap = distillCache.get()                  // TTL 内复用
    if (snap.empty) return ""
    return renderSnapshot(snap, cfg.memory.maxTokens) // 超限截断；返回 markdown
  },
})
```

渲染模板（草案）：

```md
## 用户本地知识库记忆快照（vault-memory）
以下来自用户 Obsidian 库的自动摘要，仅当与当前任务相关时参考；不确定的细节用 vault_* 工具核实，不要凭此编造。
- 画像：…
- 活跃项目：…
- 今日笔记：1. path 2. path …
```

### 1.5 触发增强（可选，不在严格最小内）

`ctx.on("agent/session-start", ...)`：source=startup 时预热 distill 缓存（异步先扫今日笔记），让首次组装不阻塞。

### 1.6 ⚠️ 开工复核点

1. `AssembleContext.scope` 的实际形状（`ScopeKey` 粒度：agent？session？）与"区分 root/subagent"的可靠方式。
2. provider 每次请求求值的频率与 KV cache 影响（README 提示 context 会进 model history，需控制在限内）。
3. `agent.ctx` 动态注册的可行时机（`agent/created` 事件？）。

---

## 2. vault_related / vault_capture 工具（Phase 2 新增）

### 2.1 `vault_related` — 链接邻居 + 语义候选（溯源关联）

```ts
parameters: {
  vault: { type: "string", ... },
  path:  { type: "string", required: true, description: "起点笔记路径（可省扩展名）" },
  mode:  { type: "string", enum: ["links", "tags", "hybrid"], default: "links" },  // hybrid 需 v1.1 嵌入
  limit: { type: "integer", default: 10 },
}
output items: { path, title, relation: "inlink"|"outlink"|"tag-shared"|"co-cited"|"semantic", reason: string, score }
// reason 必须可解释，如 "被 X、Y 共同引用" / "同标签 #linux"
```

实现（links 模式，纯链接图，无需嵌入）：
- inlink：`links.resolved_note = 本note` 的 from 集合
- outlink：本 note 的 links
- tag-shared：`tags` 表同 tag 且被链数相近的笔记
- co-cited：与另一笔记同时被 ≥2 篇第三方笔记引用的对
- 排序：共引权重 > 同标签；结果去重。

### 2.2 `vault_capture` — 会话产出落盘（写 vault 第一入口）

**写路径授权模型（沿用 DESIGN Q5：逐条 approve）**：capture 是"用户显式要求保存"的场景 → 走 agent 工具正常执行链，写入前**必须**经 DSH 审批/用户确认（实现层依赖既有 tools/execute 审批或 user-approval 服务 ⚠️ 开工复核 `dsh-user-approval` / `dsh-permission-presets` 对插件工具写盘的支持），不做静默写。

```ts
parameters: {
  vault:   { type: "string", ... },
  title:   { type: "string", required: true },
  body:    { type: "string", required: true, description: "markdown 正文" },
  folder:  { type: "string", description: "目标目录，默认 'Captures'" },
  tags:    { type: "array", items: { type: "string" } },
  add_links: { type: "boolean", default: true, description: "自动附加关联建议区（vault_related top3）" },
  source:  { type: "string", description: "来源标注（如会话标题/URL），写入 frontmatter source" },
}
output: { vault, path, created, related: [{path, reason}], note }
```

行为：
1. 校验：title/body 非空、路径监狱 resolve、目标文件不存在（存在 → 报 `NoteExists`，提示 vault_capture_append 语义或改用 vault_query 定位）。
2. 组装笔记：frontmatter（tags/source/created_at/updated_at）+ 正文 + （可选）"## 关联"区列出 related 建议供人工采纳。
3. 审批通过后原子写（.tmp → rename）；成功后触发该文件单篇重解析（索引立即跟上）。
4. 返回 note 内容回显给 agent 确认。

> `vault_capture_append`（追加到已有笔记）与 `vault_batch_capture`（多篇）推迟到 v1.1——单篇新建先验证写路径安全。

---

## 3. Web GUI（client 形态）

### 3.1 契约（已核实，dream-skin / daily-digest 同款）

- `package.json` 增加 `"dsh": { client: { platform: "web" } }` 与 `exports["./client"]`。
- `cordis.patch.yml` 不变（Phase 1 已 insert 插件）。
- `lib/client.js`：`window.__ModuleLoader__.load({ id: "dsh-plugin-vault-memory", factory })`；导出 `{ name, apply(ctx) }`；`apply` 幂等（检测已挂载实例则跳过，对齐 daily-digest），返回 dispose。
- UI 形态：**右下角悬浮胶囊/面板（独立 DOM + CSS，不侵入 shell DOM）**；与宿主数据交互全走 `fetch("/vault-memory/...")`（server 端 `webServer.register` 路由，同源 localhost）。
- 数据拉取：轮询（健康摘要 15s；审查队列在打开面板时拉取 + 操作后刷新），对齐 daily-digest POLL 模式。

### 3.2 服务端路由（server 端新增，webServer.register）

| 路由 | kind/path | 说明 |
|---|---|---|
| 摘要 | `/vault-memory/health` | `{ vaults:[{label,path,notes,orphans,brokenLinks,stale,dirty}], updatedAt }` |
| 队列 | `/vault-memory/review?kind=&vault=&status=open` | suggestions open 列表（含 reason/payload 预览） |
| 批准 | POST `/vault-memory/review/approve` | body `{id}` → 执行写回 → status=applied；失败回滚 |
| 忽略 | POST `/vault-memory/review/dismiss` | body `{id}` → status=dismissed |
| 回滚 | POST `/vault-memory/review/revert` | body `{id}` → 用 payload 内 backup 还原（Phase 3 写回启用后可用） |
| 捕获预览 | POST `/vault-memory/capture/preview` | body `{vault,title,body,...}` → `{path, note}`（只算不写） |
| 捕获提交 | POST `/vault-memory/capture/commit` | 预览通过后由用户在面板点"保存"（浏览器侧确认即用户授权；与工具侧审批并存） |

所有 POST 仅改**本插件自有状态**（suggestions 表 / 新增笔记 / 由本插件写入时留的 backup），不触碰其他用户笔记。

### 3.3 面板内容（客户端 DOM）

1. **胶囊**：`📚` + 未处理建议数角标（轮询 health）。
2. **展开面板** 三个 tab：
   - **健康**：各库 notes/orphans/断链/重复/过期计数 + 一句话趋势（health_snapshots 近 14 天）。
   - **审查**：列表逐条 = kind 徽标 + 主笔记 path + reason + [批准/忽略] 按钮 + 折叠查看 diff/草稿（payload JSON 渲染）。
   - **捕获**：textarea 粘贴标题/正文（或说明"让 agent 用 vault_capture"）→ 预览 → 提交；提交后显示路径 + "在 Obsidian 打开"链接（`obsidian://open?vault=…&file=…`）。
3. 国际化：中文优先（对齐用户环境），文案与 server 端 prompt 一致。

---

## 4. 设置项新增（Phase 2 增量）

| 键 | 类型/默认 | 说明 |
|---|---|---|
| `memory.injectEnabled` | boolean true | 记忆快照注入总开关 |
| `memory.maxTokens` | number 1200 | 快照截断上限 |
| `memory.includeSubagents` | boolean false | 是否给派生代理注入 |
| `memory.ttlMs` | number 600000 | distill 缓存 TTL |
| `capture.defaultFolder` | string "Captures" | 捕获默认目录 |
| `capture.tagSource` | string "capture" | 捕获笔记自动打的来源标签（可空=不打） |
| `gui.enabled` | boolean true | client 面板总开关 |

---

## 5. 测试与验收

- distill：给定 fixture 库 → 画像/项目/今日快照正确、空库返回 empty、超限截断生效。
- vault_related：构造 inlink/outlink/tag-shared/co-cited 各 ≥2 例断言 relation/排序；悬空起点报 `NoteNotFound`。
- vault_capture：正常新建（frontmatter/正文/关联区）；重名报 `NoteExists`；路径逃逸拒绝；写后索引立即可检索到（搜索该新笔记命中）。
- client：手工在 web profile 加载 → 胶囊出现 → health 有数 →（Phase 3 的）建议队列批准链路走通。
- 注入：新会话首轮能看到快照段；关闭 injectEnabled 后消失；subagent 默认看不到。
- 验收标准：新会话问"我最近在弄什么"→ agent 能基于快照 + vault_* 给出真实回答；GUI 能列出孤儿/断链并逐条批准（Phase 3 数据就绪后）。

---

## 6. Phase 2 任务清单

- [ ] Step 0：复核 1.6 三个复核点（scope 形状 / context 频率与 cache / agent.ctx 时机）
- [ ] core：distill.ts + NoteRef 查询 + TTL 缓存
- [ ] memory-inject.ts（dynamic context 注册 + 渲染 + 截断）
- [ ] tools/vault-related.ts（links 模式）
- [ ] tools/vault-capture.ts（含审批依赖确认）
- [ ] server：health/review/capture 路由
- [ ] client.js：胶囊 + 三 tab 面板 + 轮询
- [ ] 设置项增量 + 文档
- [ ] 单测 + web profile 手工验收
