# dsh-plugin-vault-memory — Phase 1 接口实现规范

> 依据：DESIGN.md（决策已定）。Phase 1 = **严格最小：索引 + 工具集**，不做记忆注入/GUI/定时。
> 所有 API 形状以真源码校准（dsh-tool-fs-search / dsh-daily-digest），文档内标注 ⚠️ 处为开工第 0 步必须复核点。

---

## 1. 包结构与文件清单

**代码形态决策（2026-xx 已定）：A 路线 —— 零构建纯 ESM（`.mjs`）**。源码即产物，无 lib/、无 tsconfig/tsdown；写完即装即测，与 dsh-daily-digest 同款风格。目录按"层"组织，不按 Phase 分目录。

```
D:\projectDsh\dsh-plugin-obsidian\        ← git 仓库 = npm 包源码
├── package.json                # 插件元数据 + dsh.bundle.patch
├── cordis.patch.yml            # Cordis 挂载声明
├── README.md                   # 价值/痛点总览（已存在）
├── DESIGN.md                   # 总设计（已存在）
├── LICENSE                     # MIT（代码落地时补）
├── docs\                       # 三份 Phase 规范（已存在）
├── test\
│   ├── fixtures\vault-a\       # 样例库（10 篇，覆盖解析全形态；入库为测试资产）
│   ├── parser.test.mjs
│   ├── vault-root.test.mjs
│   ├── store.test.mjs
│   ├── search.test.mjs
│   └── tools.test.mjs
└── src\
    ├── index.mjs               # 插件入口：export name/inject/Config/apply
    ├── config.mjs              # schemastery 设置 schema + 默认值
    ├── errors.mjs              # 统一错误词汇（VaultError 子类 + code，不依赖 @deepseek-ai/*）
    ├── prompt.mjs              # 溯源约束 systemPrompt section 文案
    ├── core\                   # 纯数据层：不依赖 DSH，node:test 直测
    │   ├── vault-root.mjs      # 路径监狱（resolve/assertInside/symlink 复检）
    │   ├── parser.mjs          # md → 结构化（frontmatter/标题/标签/链接/纯文本）
    │   ├── store.mjs           # SQLite 打开/迁移/读写（含 DDL）
    │   ├── scanner.mjs         # 启动全扫 + 轮询增量 watcher（零依赖）
    │   ├── search.mjs          # FTS5 查询 + snippet
    │   └── index.mjs           # VaultIndex 门面：懒初始化，组合以上
    └── tools\                  # DSH 胶水薄壳：注册工具 + 参数校验，逻辑调 core
        ├── vault-search.mjs
        ├── vault-query.mjs
        └── vault-read.mjs
```

后续 Phase 追加（不预建空目录）：Phase 2 → `core/distill.mjs`、`memory-inject.mjs`、`tools/vault-related.mjs|vault-capture.mjs`、`server/routes.mjs`、`client.js`（浏览器端）；Phase 3 → `engine/rules/*.mjs`、`engine/apply.mjs`、`embeddings/embedder.mjs`。

---

## 2. package.json 要点

```jsonc
{
  "name": "dsh-plugin-vault-memory",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.mjs",                  // 零构建：源码即产物
  "exports": { ".": "./src/index.mjs", "./package.json": "./package.json" },
  "files": ["src", "cordis.patch.yml", "README.md", "LICENSE"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "dependencies": {
    "schemastery": "^3.18.0"          // ⚠️ 与 dsh-daily-digest 同款；或 @deepseek-ai/schemastery
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.0"   // ⚠️ 精确版本开工时看已装 cordis
  },
  "license": "MIT"
}
```

**依赖策略（Phase 1）**：
- 不用 chokidar → 自研轮询 watcher（周期 10s 默认，只 stat `.md`，59 篇量级开销可忽略；增量解析单篇）。
- SQLite 驱动：⚠️ 第 0 步定 —— 宿主 Node v22.23 的 `node:sqlite` 仍属实验（需 `--experimental-sqlite` 且宿主进程未必开），优先评估 better-sqlite3（预编译、FTS5 齐）；参考 `dsh-session-query-sqlite` 的实现选型保持一致。
- 不引入 LLM/嵌入依赖（Phase 2 语义再进）。

---

## 3. cordis.patch.yml

对齐 dsh-daily-digest（web profile 全组合挂载；无需 `inject: [webServer]` 字段，入口声明即可）：

```yaml
# dsh-plugin-vault-memory bundle patch: 挂载 vault 记忆层插件
- insert:
    - id: dsh-plugin-vault-memory
      name: dsh-plugin-vault-memory
```

安装验证：`dsh plugin --profile web add .`（profile 名与用户环境一致，可能是 web/desktop；以 `dsh plugin` 可用 profile 为准 ⚠️）。

---

## 4. 插件入口契约（index.ts 骨架）

```ts
import Schema from "schemastery"            // 或 @deepseek-ai/schemastery
import { configSchema } from "./config"

export const name = "dsh-plugin-vault-memory"
// Phase 1 注入的服务：tools（注册工具）、settings（配置）、systemPrompt（溯源 section）
export const inject = ["tools", "settings", "systemPrompt"]

export const Config = configSchema

export async function apply(ctx, config) {
  const settings = ctx.get("settings")
  let cfg = config
  if (settings && typeof settings.register === "function") {
    const scope = settings.register(name, Config, { applies: "live" })
    cfg = scope.get()
    scope.watch((next) => { cfg = next; core?.reconfigure(next) })
  }

  // core 生命周期：懒初始化（首个 vault 工具调用或事件触发时才开库/建索引），
  // 避免"没配 vault 路径就崩启动"。
  const core = createVaultCore({ dshHome: process.env.DSH_HOME })

  ctx.effect(() => {
    const disposers = []
    // vault 路径在 settings 里配好且可达时，启动后台索引（一次性 full scan 在 setImmediate 里跑）
    const id = core.scheduleInitialIndex(cfg)   // 失败静默，等工具调用时报"未索引"
    if (id) disposers.push(() => core.stop(id))
    // 轮询 watcher 周期变更也走 reconfigure
    disposers.push(() => core.dispose())
    return disposers
  })

  registerVaultSearchTool(ctx, core, cfg)
  registerVaultQueryTool(ctx, core, cfg)
  registerVaultReadTool(ctx, core, cfg)
  ctx.systemPrompt.section({
    name: "vault-memory-provenance",
    order: 120,                                   // ⚠️ order 语义开工校准（参考既有 prompt section 注册）
    text: provenancePromptText,
  })
}
```

要点：
- 与 `ctx.get` 读可选服务；必需的放 `inject`。
- `ctx.effect` 里注册监听并返回 disposers（对齐 daily-digest 模式）。
- core 对象作为模块闭包（工厂函数返回），不挂 ctx 服务——Phase 1 无其他消费者，挂 ctx 服务留到 GUI 阶段。

---

## 5. 设置项（config.ts，schemastery）

| 键 | 类型/默认 | 说明 |
|---|---|---|
| `vaults` | `array`（默认空）| 每个 `{ path: string, label?: string }`；支持多库（note/work）|
| `ignoreGlobs` | `string[]` 默认 `[]` | 额外排除（相对 vault 的 glob，如 `Clippings/**`）|
| `ignoreDotDirs` | `boolean` 默认 `true` | 排除 `.` 开头目录（.obsidian/.trash/.claudian/.opencode…）|
| `watchIntervalMs` | `number` 默认 `10000` | 轮询周期；0 = 关 |
| `searchMaxResults` | `number` 默认 `50` | 工具单次返回上限 |
| `snippetChars` | `number` 默认 `200` | 命中片段截断 |
| `dbDir` | `string` 默认 `""` | 空 → `<DSH_HOME>/data/vault-memory/` |
| `enabled` | `boolean` 默认 `true` | 总开关 |

多库设计：一个 vault = 一个 `<dbDir>/<sha1(vaultPath)前16位>.db`，检索工具入参可带 `vault`（label 或 path 片段）限定，缺省扫全部已配置库（Phase 1 先实现单库语义完整，多库遍历 v1.1；moqian-work 阶段只配一个）。

---

## 6. SQLite DDL（store.ts，逐库）

```sql
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS notes (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,          -- vault 相对路径，正斜杠，UTF-8
  title         TEXT NOT NULL,
  content_plain TEXT NOT NULL DEFAULT '',      -- 去 frontmatter/代码块/链接语法后的纯文本
  folder        TEXT NOT NULL DEFAULT '',
  mtime_ms      INTEGER NOT NULL,              -- 文件 mtime，增量依据
  ctime_ms      INTEGER,
  word_count    INTEGER NOT NULL DEFAULT 0,
  line_count    INTEGER NOT NULL DEFAULT 0,
  has_fm        INTEGER NOT NULL DEFAULT 0,
  indexed_at    INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title, content_plain, content='notes', content_rowid='id', tokenize='unicode61'
);
CREATE TABLE IF NOT EXISTS fm_kv (
  note_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, is_list INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (note_id, key, value)
);
CREATE INDEX IF NOT EXISTS fm_kv_key_idx ON fm_kv(key);
CREATE TABLE IF NOT EXISTS tags (
  note_id INTEGER NOT NULL, tag TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
);
CREATE INDEX IF NOT EXISTS tags_tag_idx ON tags(tag);
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY,
  from_note INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('wiki','embed','markdown')),
  target TEXT NOT NULL,                        -- 解析后 vault 相对路径（无扩展名时补 .md）
  resolved_note INTEGER                        -- NULL = 悬空（断链）
);
CREATE INDEX IF NOT EXISTS links_from_idx ON links(from_note);
CREATE INDEX IF NOT EXISTS links_resolved_idx ON links(resolved_note);
CREATE INDEX IF NOT EXISTS links_target_idx ON links(target);

-- 元信息
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);  -- schema_version, last_full_scan
```

FTS 同步策略：fts5 外置表 content=notes 需触发器同步 ⚠️ 或选择"每次 upsert 后手动 `INSERT INTO notes_fts(rowid,...)`/`DELETE`"（简单、可控，Phase 1 用后者，59 篇量级无性能问题；外置表 + 手写同步避免触发器维护）。

**单篇重解析 = 事务内 `DELETE` 该 note 相关行（fts/fm/tags/links）+ 重插**，保证幂等。

---

## 7. 解析器契约（parser.ts）

输入：绝对路径 + UTF-8 文本（坏字节替换符兜底）。输出：

```ts
type ParsedNote = {
  path: string            // vault 相对
  title: string           // 首个 H1 文本；无 H1 → 文件名去 .md
  contentPlain: string    // 去除 frontmatter/```代码块```/行内链接语法 后的纯文本
  folder: string
  tags: string[]          // #tag 行内 + frontmatter tags；规范化（去 #、小写）
  fm: { key: string; value: string; isList: boolean }[]
  links: { kind: 'wiki'|'embed'|'markdown'; raw: string; target: string }[]
  mtimeMs: number; size: number
}
```

链接 target 解析规则：
- `[[x]]` / `[[x|alias]]` / `[[x#^block]]` / `[[x#标题]]`：取 `x`，剥 `#…`；相对当前文件目录解析；无扩展名先试 `x.md`、再试 `x` 目录下同名；都无 → `resolved=null`（悬空）。
- `[t](url)`：`url` 以 `./`/`../` 开头的相对 md 路径才入 links；http(s)/锚点/anchor 忽略。
- `![[x]]` 记 kind=embed。

容错铁律：单文件任何解析异常 → 记该篇 warning（日志计数），不中断扫描；frontmatter YAML 失败 → `has_fm=0`，正文照常。

---

## 8. 路径监狱（vault-root.ts）

```ts
function resolveVaultPath(vaultRoot: string, rel: string): string  // 规范化 + 拼 + 校验
function assertInside(root: string, abs: string): void
```

规则：
- 所有对外路径先 `path.resolve` + 大小写归一（Windows），再校验 `startsWith(root + sep)`。
- 禁止 `..` 逃逸、禁止符号链接指向 vault 外（`realpath` 后复检 ⚠️ Windows junction 也算）。
- 工具层所有读写经此函数；越界 → 抛 `VaultPathError`（错误码 `VAULT_PATH_ESCAPE`），绝不落到 fs 调用。
- 读取白名单：只读 `.md`；附件/二进制路径即使 inside 也拒绝内容读取（防大文件拖垮上下文）。

---

## 9. 工具接口规范（tools/*）

统一约定：
- 错误用 `VaultError`（`src/errors.mjs`，普通 Error 子类）携带稳定 code：`VAULT_NOT_CONFIGURED` / `VAULT_UNREADABLE` / `VAULT_PATH_ESCAPE` / `NOTE_NOT_FOUND` / `INDEX_NOT_READY` / `SEARCH_FAILED` / `INVALID_ARG`。插件不可 import `@deepseek-ai/dsh-llm` 的 HarnessError（profile 无此包）。
- **`parameters` 与 `output.schema` 必须为标准 JSON Schema 子集**（真机校准，见 step0-calibration §8）：根 `type: "object"`、`required` 为顶层数组、`items` 只挂 array、`additionalProperties` 只挂 object。**不支持 per-property `required: true`**——那是 `defineTool` 的规格语法；普通对象 `register` 不做转换、原样直传。
- 所有结果项必带 `path`（溯源硬约束）。
- 返回值截断：`searchMaxResults`/`snippetChars` 受 config 控制；render 函数内拼文本，内容超限提示"结果已截断，收窄查询"。

### 9.1 `vault_search` — 全文检索

```ts
defineTool({
  name: "vault_search",
  description: "在已配置的本地 Obsidian 知识库（vault）里做全文检索，返回按相关度排序的命中笔记及上下文片段。" +
    "命中必带 vault 内相对路径 path；引用笔记内容时必须给出该 path。找不到就说没有，禁止编造笔记内容。",
  parameters: {
    q:        { type: "string", required: true,  description: "检索词（支持空格分词，按 FTS5 语法；多个词默认 AND）" },
    vault:    { type: "string", description: "限定某个库（配置的 label 或路径片段）；缺省检索全部已配置库" },
    folder:   { type: "string", description: "限定目录前缀，如 \"Prompt\"" },
    tag:      { type: "string", description: "限定标签（不带 #，忽略大小写）" },
    limit:    { type: "integer", description: `单库返回上限（默认 ${D.searchMaxResults}）` },
  },
  timeoutMs: 15000,
  output: { schema: { type:"object", additionalProperties:false, properties:{
      vault: { type:"string", required:true },
      total: { type:"integer", required:true },
      hits:  { type:"array", required:true, items:{ type:"object", additionalProperties:false, properties:{
                path:{ type:"string", required:true },
                title:{ type:"string", required:true },
                score:{ type:"number", required:true },
                snippet:{ type:"string", required:true } } } } } },
    render: (a,v) => [{ type:"text", text: renderHits(v) }] },
  async execute(args, exec) {
    // 1. resolve 目标库（未配置 → VaultNotConfigured）
    // 2. IndexNotReady 时触发一次前台 quick scan（小库 <1s）再查
    // 3. FTS5 MATCH 查询 → 按 bm25 排序 → 取 limit → 由 content_plain 生成 snippet（命中词前后窗口）
    // 4. 返回 { vault, total, hits }
  }
})
```

### 9.2 `vault_query` — 结构化查询

```ts
parameters: {
  vault:    { type:"string", ... },
  folder:   { type:"string", description:"目录前缀精确匹配（空=全部）" },
  tag:      { type:"string", ... },
  modified_since: { type:"string", description:"ISO 日期/时间，如 2026-01-01 或 2026-01-01T08:00:00" },
  modified_until: { type:"string", ... },
  has_fm_key: { type:"string", description:"只返回带某 frontmatter 键的笔记，如 \"tags\"" },
  sort:     { type:"string", enum:["modified_desc","created_asc","title_asc"], default:"modified_desc" },
  limit:    { type:"integer", default:50 },
  fields:   { type:"array", items:{ type:"string" }, description:"额外返回的 frontmatter 键值" },
}
// 结果 items: { path, title, folder, modified, tags:[], fm:{...fields 请求的键} }
```

### 9.3 `vault_read` — 读取单篇（溯源阅读）

```ts
parameters: {
  vault: { type:"string", ... },
  path:  { type:"string", required:true, description:"vault 相对路径，如 \"Prompt/xx.md\"；可省略扩展名" },
  offset:{ type:"integer", description:"起始行（1 基）" },
  limit: { type:"integer", description:"行数（默认 200，上限 500）" },
}
// 输出 { vault, path, resolvedPath, title, totalLines, lines:[{n, text}] }
// 行为：优先读索引缓存 content 定位行区间；mtime 落后于磁盘时先重解析再读（保证新鲜）。
```

> `vault_related`（链接邻居）、`vault_capture`（写）、`vault_health` 明确推迟：related 是 Phase 2 记忆/GUI 的输入，capture 需要 approval 链（Phase 2），health 需要巡检（Phase 3）。

---

## 10. 溯源约束 prompt section（文案草案）

```md
## 本地知识库（vault-memory）
你可以用 vault_search / vault_query / vault_read 检索用户的本地 Obsidian 知识库。
- 引用 vault 内容时必须给出笔记路径（如 `Prompt/xx.md`），能引用原文片段就引用。
- 检索无结果或不确定时，明说"库里没有找到相关内容"，禁止编造笔记、笔记路径或内容。
- 库未配置/未索引时提示用户，不要假设内容存在。
```

---

## 11. 生命周期与容错

| 场景 | 行为 |
|---|---|
| 未配置 vault | 工具调用报 `VaultNotConfigured`（带设置指引文案）；启动照常，绝不崩 |
| 配置路径不存在/被删 | 该库标 error 状态，日志警告，其他库不受影响 |
| vault 文件被 Obsidian 正在写 | mtime 已变但读失败 → 下轮重试，不误删索引行 |
| 扫描/解析异常 | 单篇跳过 + 计数告警；后台扫描整体 try/catch |
| 首查触发索引 | 前台 quick scan 完成后返回结果（小库 <1s）；大库提示"正在后台索引" |
| watcher | 轮询 diff（mtime+size）→ 变则单篇重解析；删除 → 级联清行；10s 周期可配 |

多库：db 文件按 vault path hash 隔离；一处损坏不影响其他库（打开失败只标该库 error）。

---

## 12. 测试计划（node:test + 临时 vault fixture）

fixture 构造 `docs/fixtures/vault-a/`（10 篇，覆盖：有/无 frontmatter、中文标题、wikilink 悬空与命中、embed、markdown 相对链接、代码块含假标签、子目录嵌套、.obsidian 隐藏目录、附件 .png 混入）。测试清单：

1. parser：各形态解析正确 + 坏 frontmatter/坏 UTF-8 容错
2. 路径监狱：`../`、绝对路径、symlink/junction 逃逸拒绝（Windows 上 junction ⚠️ 以 realpath 复检）
3. scanner：初始全扫计数、增量 add/change/delete、mtime 回拨不丢更新
4. store：幂等重解析、fts 行同步、级联删除
5. search/query：中文分词命中、folder/tag 过滤、sort、空结果
6. tools：直接调 execute(args,{})（绕过 agent）校验输出 schema 与错误码；render 输出含 path
7. 集成（手工）：`dsh plugin --profile <p> add <repo 路径>` → 起 dsh → 会话里问"moqian-work 里有什么" → agent 调 vault_* 返回真实结果

---

## 13. Phase 1 任务清单（验收即打勾）

**Step 0 — 环境校准（半天）**
- [ ] 确认 dsh CLI profile 名与 `dsh plugin add` 用法（现有 web/desktop 两 profile 均装有插件）
- [ ] 复核 `defineTool`/`ctx.tools.register` 精确签名（读 `@deepseek-ai/dsh-tools` 源码）
- [ ] 定 SQLite 驱动（node:sqlite vs better-sqlite3；查宿主 Node 版本与 dsh-session-query-sqlite 选型）
- [ ] 复核沙箱对插件读 vault 目录（`D:\projectObsidian\moqian-work`）的约束与解法
- [ ] 在 `D:\projectDsh\dsh-plugin-obsidian` 初始化包骨架（package.json/cordis.patch.yml/README）

**Step 1 — core（2–3 天）**
- [ ] config.ts 设置 schema
- [ ] vault-root.ts 路径监狱 + 单测
- [ ] parser.ts + 单测（fixture 全形态）
- [ ] store.ts DDL/迁移/upsert/级联删除
- [ ] scanner.ts 全扫 + 轮询增量
- [ ] search.ts FTS5 + snippet
- [ ] core/index.ts VaultIndex 门面 + 懒初始化 + 容错

**Step 2 — 工具层（1–2 天）**
- [ ] tools/vault-search.ts / vault-query.ts / vault-read.ts（defineTool + execute + render）
- [ ] 错误码词汇 + prompt section 注册
- [ ] 工具单测（直调 execute）

**Step 3 — 真机验证（1 天）**
- [ ] `dsh plugin add` 装入 profile，会话手测：对 `moqian-work` 检索/查询/读取
- [ ] 用真实库验证后再切 `moqian-note` 做一次只读检索冒烟（不写库内容）

**验收标准**
- [ ] 配置好 vault 后，新会话直接说"查我库里关于 X 的笔记"→ agent 用 vault_* 返回带路径的真实结果
- [ ] 无结果场景 agent 明说没有，不编造笔记/路径
- [ ] `dsh plugin remove` 干净卸载：无残留监听、db 可删、启动无报错

---

## 14. 明确不做（Phase 1 边界）

- ❌ 会话记忆注入 / profile 蒸馏（Phase 2）
- ❌ GUI 面板 / client.js（Phase 2）
- ❌ 语义嵌入 / hybrid（v1.1）
- ❌ 定时巡检 / 写 vault / approval 链（Phase 3）
- ❌ 附件、PDF、非 md 文件索引
- ❌ 多库并行检索的完整语义（单库先全，多库 v1.1 遍历）
