# DSH × 本地 Obsidian 知识库插件 — 详细设计（v0.1 草案）

> 定位一句话：**让本机 Obsidian vault 成为 DeepSeek Harness agent 的长期记忆层与工作台**——agent 可检索/溯源你的第二大脑，会话产出回流成笔记，定时维护库的健康。
> 状态：设计阶段，未开工。本文以真实 vault 勘察结论为输入。

---

## 0. 输入与约束（来自勘察与决策）

### 0.1 真实环境勘察结论

目标库（开发/测试主库）：`D:\projectObsidian\moqian-note`
备选库（后期验证）：`D:\projectObsidian\moqian-work`

| 项 | 结论 | 对设计的影响 |
|---|---|---|
| md 笔记数 | 59（moqian-note） | 规模小，索引毫秒级；但设计要能线性扩展到 1 万+ 篇 |
| 附件 | 3742 文件 / 70MB | **默认不索引附件**，只索引 `.md`；附件目录需排除扫描 |
| frontmatter | 仅 ~17% 笔记有 | 解析器要容错；检索策略不能依赖 frontmatter 完整 |
| 社区插件 | 仅 realclaudian | 不假设 Dataview/Templater/日记约定存在 |
| 目录习惯 | `Agent/`、`.claudian/`、`.opencode/`、`Prompt/`、`Clippings/`、`Dsh-Plugin/` | AI 相关笔记已自成体系；隐藏目录（`.` 开头）应默认排除 |
| 既有系列 | 《插件01【dsh-plugin-feihualing】》设计笔记在库内 | 本插件为该系列延续，命名/风格对齐 |

### 0.2 已确认的产品决策（与用户讨论结果）

1. **目标用户**：个人知识管理重度用户（笔记债严重、vault 有多年积累）。
2. **形态**：全形态 —— Agent 工具集 + Web GUI 面板 + 定时/后台工作流 + 会话钩子。分阶段交付。
3. **嵌入取向**：默认全本地（Ollama 嵌入），提供开关切换到 DeepSeek API。语义检索是 v1.1+，Phase 1 以结构化 + 全文检索起步。
4. **包名**：`dsh-plugin-vault-memory`（已定）。
5. **开发库顺序**：先用小库 `D:\projectObsidian\moqian-work` 验证管线，跑通后再切主库 `D:\projectObsidian\moqian-note` 真机验证（避免开发期干扰真实库）。
6. **Phase 1 范围**：严格最小 —— 只做「索引 + 工具集」，不做会话记忆注入（记忆注入推迟到 Phase 2）。
7. **索引落盘**：`~/.dsh/data/vault-memory/<vaultHash>.db`（不污染 vault、不进 Obsidian 同步）。
8. **巡检写入授权**：逐条 approve（经 GUI 审查队列/工具确认流），无目录级预授权。
9. **代码形态**（开工前定稿）：A 路线 —— 零构建纯 ESM（`.mjs`），源码即产物，无 lib/tsconfig/tsdown 构建链；目录按层组织（core 纯数据层 / tools 胶水层 / 后续 engine·embeddings·client），详见 phase1 规范 §1。

### 0.4 已校准的 DSH 插件 API 事实（真源码反查，2026 会话时点）

参考实现：`dsh-tool-fs-search`（工具插件）、`dsh-daily-digest`（bundle 插件，settings/事件/webserver）、`dsh-dream-skin`（client UI）。

- 插件入口：`export const name` / `export const inject = [...]` / `export function apply(ctx, config)`；可选服务用 `ctx.get("svc")`，不存在返回 undefined。
- 配置：schemastery `Schema.object({...})`，`settings.register(name, CONFIG_SCHEMA, { applies: "live" })` → `scope.get()` / `scope.watch(cb)`；热更新。
- 事件：`ctx.effect(() => { return [ctx.on(...), ...] })`；已见事件 `agent/request-error`、`agent/session-start`、`session/event`、`jobs.onJobDone`、`tools/post-execute`。
- 工具：`defineTool`（`@deepseek-ai/dsh-tools`），形状 = `{ name, description, parameters, timeoutMs, output:{ schema, render, presentationMeta }, execute(args, exec), presentCall, presentResult }`；注册 `ctx.tools.register(tool)`。
- Web：`webServer.register({ kind: "exact", path, handler })`。
- 文件访问：bundle 插件可用 `node:fs` 直读（daily-digest 直读 `<DSH_HOME>/data` 先例）；DSH_HOME = `process.env.DSH_HOME ?? <harness 根>`。
- 数据落盘范式：`<DSH_HOME>/data/<插件名>/` + `.tmp` 写入后 `rename` 原子替换。
- 依赖 `@deepseek-ai/schemastery`（或裸 `schemastery`）、`@deepseek-ai/cordis` peer。
- **Client 插件契约**（dream-skin / daily-digest 同款）：`package.json` 声明 `dsh.client: { platform: "web" }` + `exports["./client"]`；`lib/client.js` 用 `window.__ModuleLoader__.load({ id, factory })` 打包，模块导出 `{ name, apply(ctx) }`，`apply` 挂 UI 并返回 dispose；宿主 `dsh-client-modules` 依 `dsh.client` 声明自动拾取。第三方 UI 走「纯 DOM overlay + `fetch` 轮询服务端 `webServer.register` 的路由」，不依赖 shell 内部（daily-digest 浮卡先例）。
- **systemPrompt 动态能力**（`@deepseek-ai/dsh-system-prompt` 类型已核实）：`ctx.systemPrompt.section({name, order, text})`，`text` 可为 `string | (ctx: AssembleContext) => string`（provider 每次组装求值，空字符串即不渲染）；`ctx.systemPrompt.context({name, order, text})` 产出**user 角色动态上下文快照**；`agent.ctx` 上注册即单 agent 作用域（遮蔽同名全局段）。section order 约定：-100 身份 / 0 persona / 100–199 工具指引。
- **dsh-schedule 的真实定位**：会话内 agent 提醒工具（`schedule_create/list/delete`），Session 级投递、`every_seconds` ≥ 5 分钟、冷会话不触发——**不是插件守护定时器**，Phase 3 巡检不用它，改宿主定时器 + 按需工具。

> 校准点（开工第 0 步核对，勿假设）：`ctx.tools.register` 与 `defineTool` 精确签名以 `dsh-tools` 源码为准；SQLite 驱动选型（node:sqlite 内建 vs better-sqlite3）以 dsh-session-query-sqlite 与宿主 Node 版本为准；vault 目录在沙箱外的读权限约束以 dsh-sandbox-policy 为准。

---

## 1. 命名

候选（与 `dsh-plugin-feihualing` 系列风格对齐）：

| 候选 | 说明 |
|---|---|
| `dsh-plugin-vault-memory`（推荐） | 直指核心价值：vault 即记忆 |
| `dsh-plugin-obsidian-kb` | 直白，SEO 友好 |
| `dsh-plugin-second-brain` | 概念性强，营销向 |

最终名待用户拍板（见文末开放问题）。本文暂用 `dsh-plugin-vault-memory`。

---

## 2. 架构总览

```
┌────────────────────────── DSH host（Cordis）──────────────────────────┐
│                                                                       │
│  dsh-plugin-vault-memory  (bundle)                                    │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │ core  ── ctx.vaultIndex 服务（唯一事实源）                         │  │
│  │  · 扫描器 Scanner（chokidar 监听 + 启动全扫）                      │  │
│  │  · 解析器 Parser（markdown/frontmatter/链接/标签/章节）             │  │
│  │  · 存储 Store（SQLite：FTS5 全文 + 链接图 + KV + 健康指标）          │  │
│  │  · 检索器 Retriever（结构查询 + 全文 + [v1.1 语义向量]）             │  │
│  │  · 蒸馏器 Distiller（画像/项目地图/复习队列 等派生产物）             │  │
│  └───────┬───────────────┬───────────────┬──────────────────────────┘  │
│          │ ctx.tools 注册 │ 会话钩子        │ ctx.settings 注册          │
│   ┌──────▼──────┐ ┌──────▼──────┐ ┌───────▼────────┐                 │
│   │ agent 工具层 │ │ 记忆注入层    │ │ 配置层          │                 │
│   │ vault_query │ │ · 会话开始    │ │ vault.path(s)   │                 │
│   │ vault_search│ │ · 画像/地图   │ │ 排除/包含规则    │                 │
│   │ vault_notes │ │ · 捕获命令    │ │ 嵌入引擎/API key │                 │
│   │ vault_health│ └──────┬──────┘ │ 定时开关         │                 │
│   └──────┬──────┘        │        └───────┬────────┘                 │
│          │              │ dsh-schedule    │                          │
│          │      ┌───────▼───────┐  ┌──────▼───────┐                  │
│          │      │ 维护工作流层    │  │ client UI    │  web profile       │
│          │      │ · 巡检任务      │  │ (lib/client.js)│ 注入 webServer    │
│          └──────┴───────────────┴──┴──────────────┘                  │
└───────────────────────────────────────────────────────────────────────┘
```

**分层原则**：core 只依赖 SQLite/chokidar，不依赖 agent/UI；工具层/UI/定时层只消费 core 的服务契约 → 任何一层可单独拆卸（headless 无 UI、只装工具不装定时…）。

---

## 3. 核心数据模型（SQLite）

单库文件存放位置：**默认放 vault 之外**（见开放问题 Q4）。建议 `%USERPROFILE%\.dsh\data\vault-memory\<vaultHash>.db`，避免污染 vault、避免被 Obsidian 同步。

### 表设计（草案）

```sql
-- 笔记本体（每次变更整行刷新，或事件式增量）
CREATE TABLE notes (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,   -- vault 相对路径，正斜杠
  title         TEXT NOT NULL,          -- 首 H1 / 文件名
  content_md    TEXT,                   -- 原始 md（可空：只存解析结果，减体积）
  content_plain TEXT,                   -- 去 frontmatter/代码块 的纯文本（供 FTS 与蒸馏）
  folder        TEXT,
  created_at    TEXT, modified_at TEXT, -- 来自文件 mtime + frontmatter 兜底
  word_count    INTEGER,
  line_count    INTEGER,
  is_daily      INTEGER DEFAULT 0,
  score         REAL DEFAULT 0,         -- 蒸馏用的启发分（新鲜度/被链数/size 加权）
  indexed_at    TEXT
);
CREATE VIRTUAL TABLE notes_fts USING fts5(content_plain, title, content='notes', content_rowid='id');

-- frontmatter KV（无 frontmatter 笔记不产生行）
CREATE TABLE fm_kv (note_id INTEGER, key TEXT, value TEXT, is_list INTEGER);
CREATE INDEX fm_idx ON fm_kv(note_id, key);

-- 标签（含 #tag 行内标签与 frontmatter tags，去重）
CREATE TABLE tags (note_id INTEGER, tag TEXT);           -- tag 存小写规范化

-- 链接图：wikilink [[x]]、markdown [t](path)、embed ![[x]]；x 解析为 vault 内目标
CREATE TABLE links (from_note INTEGER, kind TEXT, target TEXT, resolved_note INTEGER);
CREATE INDEX links_target ON links(target);
CREATE TABLE mentions (note_id INTEGER, mention TEXT);   -- 未解析目标（悬空链接）单独记，供孤儿/断链巡检

-- 章节（v1.1 语义分块用，先建表不填）
CREATE TABLE sections (note_id INTEGER, seq INTEGER, heading TEXT, text TEXT, char_start INTEGER);

-- 向量（v1.1，本地/API 嵌入完成后写；先建表）
CREATE TABLE embeddings (note_id INTEGER, block_type TEXT, block_id INTEGER, model TEXT, dim INTEGER, vec BLOB);

-- 巡检/建议（维护管家的产出，UI 面板直接读）
CREATE TABLE suggestions (
  id INTEGER PRIMARY KEY, kind TEXT,          -- orphan | duplicate | stale | missing_link | moc_draft
  note_id INTEGER, target_note INTEGER,       -- 视 kind 使用
  reason TEXT, payload TEXT,                  -- payload=JSON（如合并 diff）
  status TEXT DEFAULT 'open',                 -- open | approved | dismissed | applied
  created_at TEXT
);

-- 库健康度快照（每日/每次巡检一行，面板画趋势）
CREATE TABLE health_snapshots (at TEXT, metrics TEXT);  -- metrics=JSON
```

### 派生产物（内存/缓存，不落 vault）

- **画像 profile**：从「欢迎.md」、`Agent/`、`Dsh-Plugin/` 等高频文件夹 + 高 score 笔记蒸馏的要点清单（供记忆注入，可落 vault 或只进会话）。
- **项目地图**：folder 聚类 + 链接子图 + 近期 modified 热区。

---

## 4. 扫描与解析管线

1. **启动**：全量扫一次（59 篇 <1s；1 万篇量级全扫也 <30s），之后 chokidar 增量（add/change/unlink → 单篇重解析，200ms 节流）。
2. **排除规则**（默认，可配置）：
   - 目录 `.` 开头（`.obsidian`、`.trash`、`.claudian`、`.opencode`…）
   - 非 `.md`（附件 70MB 不碰）
   - 可配置 extra ignore globs（如 `Clippings/` 若不想入索引）
3. **解析**（容错优先，绝不因单篇坏 md 崩索引）：
   - frontmatter：`---` 包裹的 YAML，解析失败仅记 warning，KV 照常
   - 标题树 → title（首个 H1，否则文件名）
   - 行内标签 `#tag`、wikilink `[[x]]` / embed `![[x]]`、markdown 链接、代码块剥离
   - 编码：按 UTF-8 读，坏字节用替换符兜底（勘察显示库内存在编码脏数据风险）
4. **FTS5**：内容存 `content='notes'` 外置表，保持单写源。

---

## 5. 检索设计（Phase 1：结构 + 全文；语义 v1.1+）

### 5.1 Agent 工具契约（草案）

| 工具 | 入参（示意） | 语义 |
|---|---|---|
| `vault_query` | `{filter:{folder, tag, has_fm:{key,op,val}, modified_since, is_daily}, sort, limit}` | 结构化查询：目录/标签/frontmatter/时间 → 笔记清单（path+title+摘要行） |
| `vault_search` | `{q, mode:"fts"\|"hybrid", limit, folder?}` | 全文检索；v1.1 hybrid 加语义重排 |
| `vault_related` | `{path, hops, include_unresolved}` | 链接邻居 + 反向链接 + [v1.1] 向量相似，返回理由 |
| `vault_read` | `{path, window?}` | 读取单篇（复用 ctx.fs 语义 + 行号），对 FTS 命中片段自动定位 |
| `vault_capture` | `{title, body, folder?, tags?, links?}` | 写新笔记（经用户确认流），自动建议关联 |
| `vault_health` | `{}` | 孤儿/断链/重复/过期摘要（读 suggestions 表） |
| `vault_plan` *(v1.2)* | `{objective}` | 给子代理编排用的"读哪些笔记"建议 |

**溯源硬约束**（防幻觉，核心卖点）：`vault_*` 返回一律带 `path`；工具描述与 prompt section 里强制 agent"引用 vault 内容必须给出笔记路径，找不到就明说没有，禁止编造"。LLM 检索到证据后回填原文片段。

### 5.2 语义检索（v1.1，Phase 2 排期）

- 嵌入引擎：**默认本地 Ollama**（`nomic-embed-text` 或 `bge-m3`），设置项切 DeepSeek API。
- 分块：按章节（sections 表）切，标题+正文 <512 token。
- 索引：纯本地库用 SQLite 内嵌向量（简单起见按 chunk 存 BLOB + 暴力余弦；库规模 ≤1 万 chunk 时毫秒级，够用），**v2 若库大再换 sqlite-vec / hnsw**。
- 混合：FTS5 BM25 与向量分数 RRF 融合。
- 私隐：默认本地嵌入，内容不出本机；切 API 时在 UI 明示"将发送 vault 片段到云端"。

---

## 6. 会话记忆注入（Phase 2）

场景：新会话开始时，agent 对用户一无所知 → 浪费首轮在"自我介绍/贴背景"。

机制（轻量起步，避免过度注入污染上下文）：
1. 会话开始事件 → 读 `profile` 摘要（<1.5k tokens：身份/领域/活跃项目/常用约定）+ 当日相关笔记清单（`vault_query modified_since=today` 或按项目 folder）。
2. 经 `ctx.systemPrompt.section`（对齐用户库内既有设计笔记里的模式）注入，但**标记为"记忆层，仅当任务相关时引用"**，不强迫 agent 使用。
3. 开关：`inject_on_session_start: true/false`、注入 token 上限。

反方向（捕获，Phase 2）：
- `vault_capture` 工具 + client 端"保存为笔记"动作：把当前会话的决策/产出总结 → 结构化落盘，自动 frontmatter（tags/folder/来源 session id）、自动附"关联建议"（vault_related 命中提示，人工确认才写链接）。

---

## 7. Web GUI 面板（Phase 2，client 形态）

参照 dsh-daily-digest / dsh-dream-skin 的 client 注入方式（`dsh.client.platform: web` + `lib/client.js`，cordis.patch 挂 `webServer`）。

面板候选（都在左侧栏/独立 tab）：
1. **库健康 Dashboard**：孤儿/断链/近似重复/过期数 + 趋势图（health_snapshots）+ 一键"生成巡检报告"。
2. **审查队列**：suggestions 表 open 项 → 逐条 show reason/diff → approve / dismiss / 直接跳 Obsidian 打开原文（用 Obsidian URI `obsidian://open?vault=...&file=...`）。
3. **捕获**：会话快照 → 预览生成笔记 → 确认落盘。
4. 设置页即 schemastery 自动渲染（vault 路径、开关、嵌入引擎），无需自绘。

---

## 8. 定时维护工作流（Phase 3，宿主定时器 + 按需工具；不用 dsh-schedule）

巡检任务（默认每周/可配置）产出 suggestions，**绝不直接改用户笔记**——全部经审查队列人工批准（写 vault 唯一入口是显式工具调用 + approval）。巡检项：

| kind | 规则（启发式，草案） | 产物 |
|---|---|---|
| `orphan` | 入链=0 且无父目录索引/MOC 引用的笔记 | 建议去处/建议新链接 |
| `broken_link` | mentions 解析失败（悬空 wikilink） | 修复建议（改名/建 stub/删除引用） |
| `duplicate` | 标题相似 + 内容 Jaccard/emb 相似 > 阈值 | 合并 diff（payload） |
| `stale` | 高 score 但 modified > N 月且被链笔记已更新 | 复审队列 |
| `missing_link` | 语义/共引相似笔记对但无链接 | 加链建议（附理由：共引了 X、同标签 Y） |
| `moc_draft` | 每 folder > 8 篇且无索引页 | MOC 草稿 markdown |

**v1 先做 orphan + missing_link + moc_draft**（纯链接图启发，无需嵌入），duplicate/stale 放 v1.1 语义上线后。

---

## 9. 安全与隐私（贯穿所有 Phase）

- **路径监狱**：所有文件读写经一个 resolve 层，拒绝越出 `vault.path`（含符号链接穿透检查）；附件/隐藏目录默认不读。
- **默认不出网**：索引、检索、巡检全本地。唯一出网点 = 语义嵌入切 API（明示开关）+ Obsidian URI 打开（本地）。
- **写 vault 三重门**：工具层只建议不写 → 写经 DSH approval → 只写新笔记或审查队列批准的变更，从不静默改/删用户笔记。
- 敏感 vault：`~/.dsh` 的 db 里不存密钥；settings 里 vault 路径是本地配置。

---

## 10. 分阶段计划与验收

### Phase 1 — 地基（MVP，可安装可用）
交付：
- [ ] npm 包骨架 + `cordis.patch.yml` + 设置注册（vault 路径/排除规则/开关）
- [ ] core：扫描器 + 解析器 + SQLite（FTS5 + tags + links + fm_kv）
- [ ] 工具：`vault_query` / `vault_search`(fts) / `vault_read`
- [ ] 溯源 prompt section
- [ ] `dsh plugin --profile web add .` 装进 web profile 真机验证（对着 moqian-note）
- [ ] 单元测试：解析器（frontmatter 容错/标签/链接）、检索、路径监狱
- 验收：新会话中直接说"查一下我库里关于 X 的笔记"→ agent 给出带路径结果；无幻觉场景下不编造。

### Phase 2 — 记忆注入 + GUI + 捕获
- [ ] profile/project-map 蒸馏 + 会话开始注入开关
- [ ] client.js：健康 Dashboard + 审查队列 + 捕获面板
- [ ] `vault_capture` + 关联建议
- 验收：打开新会话无需自我介绍背景即可被 agent"想起"；面板能列孤儿并批准链接。

### Phase 3 — 维护管家 + 语义
- [ ] `vault_health` 巡检（orphan/broken/missing_link/moc_draft）+ dsh-schedule
- [ ] 语义嵌入（Ollama 默认/API 可选）+ hybrid 检索 + duplicate/stale
- 验收：巡检产出带理由建议，批准后落盘；语义检索在样例问题上优于纯 FTS。

---

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| frontmatter 缺失/不规整（已实测 ~83% 无） | 检索以全文+结构为主，fm 只是加分项 |
| 附件 3742 文件拖慢扫描 | 只扫 `.md`；隐藏目录排除；增量监听 |
| Obsidian 正在写文件/独占锁 | chokidar 事件合并节流；解析失败单篇跳过重试 |
| 记忆注入污染上下文 | token 上限 + 开关 + "仅相关时用"措辞 |
| 编码脏数据 | UTF-8 + 替换符容错，逐篇不崩全局 |
| 双 vault（note/work）切换 | 配置支持多 path；db 按 vault hash 分文件 |
| DSH API 签名与本文假设有出入 | 开工第 0 步：反查 `dsh-tool-fs` / `dsh-daily-digest` / `dsh-schedule` 源码校准 |

---

## 12. 决策记录（Q1–Q5 已拍板）

| # | 问题 | 决策 |
|---|---|---|
| Q1 | 包名 | `dsh-plugin-vault-memory` |
| Q2 | 开发主库 | 先 `moqian-work` 验证管线 → 再切 `moqian-note` 真机验证 |
| Q3 | Phase 1 范围 | 严格最小：索引 + 工具集（记忆注入推迟到 Phase 2） |
| Q4 | 索引落盘 | `~/.dsh/data/vault-memory/<vaultHash>.db` |
| Q5 | 写入授权 | 逐条 approve，无预授权 |

> 接口级实现细节见各 Phase 规范：
> - [docs/phase1-interface-spec.md](docs/phase1-interface-spec.md) — 索引 + 工具集（工具契约、DDL、设置项、任务清单）
> - [docs/phase2-interface-spec.md](docs/phase2-interface-spec.md) — 记忆注入 + Web GUI + 捕获
> - [docs/phase3-interface-spec.md](docs/phase3-interface-spec.md) — 巡检引擎 + 审查队列写回 + 语义检索
