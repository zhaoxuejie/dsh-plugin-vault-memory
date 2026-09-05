# dsh-plugin-vault-memory 使用教程

> 一句话：**装好后，把 DSH 当"会翻你 Obsidian 库的助手"用**——查笔记、存笔记、让它记得你、定期帮你整理。

---

## 0. 一次性准备

```bash
# 1) 安装插件（装进 web profile；已装过可跳过）
dsh plugin --profile web add D:\projectDsh\dsh-plugin-obsidian

# 2) 完全重启 dsh web（不是刷新页面）
#    → 右下角出现「📚 知识库」胶囊 = 插件生效

# 3) 可选：语义检索（词面不同也能搜到）需本机 Ollama
ollama pull bge-m3    # 已装则跳过；在 settings.yaml 的 embed.enabled: true（已为你开启）
```

配置存放在 `C:\Users\Lenovo\.dsh\settings.yaml` 的 `dsh-plugin-vault-memory:` 段（当前已配好 work 库 + 语义开启）。也可以浮卡「配置」tab 在线增删库。

---

## 1. 最常用：直接跟 AI 说话（不用碰任何按钮）

打开一个新会话，把 AI 当"知道你库的助手"问即可：

| 你想做什么 | 直接说 | 背后发生的 |
|---|---|---|
| 翻旧笔记 | "我库里有没有 Docker 相关的笔记？" | `vault_search` 检索并给路径 |
| 按条件找 | "查 tools/ 目录下、近 30 天改过的笔记" | `vault_query` 结构化查询 |
| 看某篇全文 | "把《Git 分支合并》笔记内容读给我" | `vault_read` 带行号读 |
| 意思相近的 | "搜一下跟'Windows 命令行'相关的（语义搜）" | `vault_search mode=semantic/hybrid` |
| 关联推荐 | "这篇笔记跟哪些笔记有关联？" | `vault_related` 给理由 |
| **保存成果** | "把刚才这段整理成笔记存到库，标题《…》" | `vault_capture` 自动 frontmatter + 关联建议 |
| 体检 | "我库里有哪些孤儿笔记/断链？" | `vault_health` 只读报告 |
| 立即整理 | "跑一次巡检，列出建议" | `vault_health run=true` → 建议入队列 |

规则：AI 引用笔记必带路径；找不到就说没有、不编造——你可放心让它干活。

**新会话开头**，AI 会自动收到一段"记忆快照"（你的库名、笔记数、最近在忙的目录），不用每次自我介绍背景。

---

## 2. 右下角浮卡（📚 知识库）四个 tab

| Tab | 干嘛 | 怎么用 |
|---|---|---|
| **概览** | 看各库健康 | 打开即看：笔记数/断链/待审数/待审趋势/语义状态/近期更新；点胶囊收起 |
| **捕获** | 手动存笔记 | 填标题→正文→（可选）目录/标签→**预览**（先看效果，没写盘）→**保存到库**→点"在 Obsidian 打开 ↗" |
| **审查** | 批准巡检建议（唯一让 AI 改你笔记的地方） | 「立即巡检」扫描孤儿/断链/缺总览 → 每条建议看理由 → **孤儿**勾选要关联的笔记、**断链**下拉选修复目标 → 批准（自动备份）/ 忽略 |
| **配置** | 管理库 | 加/删 vault 路径、启用开关 → 保存即写 settings.yaml 生效 |

---

## 3. 审查写回是安全的

- 巡检引擎**只生成建议，绝不直接改笔记**
- 批准时才写盘，且**写前自动备份**——改错了随时可回滚
- 每日 **03:00** 自动巡检一轮（想改时间/关掉：设置 review.hour / enabled）
- duplicate 场景只标记归档，**永不自动删你的文件**

---

## 4. 常见问题

| 现象 | 原因/解法 |
|---|---|
| 没看到浮卡 | 要**完全重启** dsh web（bundle 启动时注册）；还不行就 `localStorage.removeItem('dsh-plugin-vault-memory:hidden')` 后刷新 |
| 检索返回"未配置 vault" | settings.yaml 的 vaults 为空 → 浮卡「配置」加库路径 |
| 语义搜无感/回退全文 | 首次全量嵌入要跑一会（概览显示覆盖进度）；确认 Ollama 在跑、`embed.enabled: true` |
| 保存提示"同名已存在" | 不覆盖是设计——换标题或目录重试 |
| 改了代码不生效 | web 插件加载在启动时：改完源码需重启（link 模式代码是活的，重启即新版） |

---

## 5. 开发 / 测试

```bash
pnpm install    # link 安装模式必需
npm test        # 76 项单测（node:test，无外部依赖）
```

架构速记：`src/core/`（纯数据：扫描/解析/SQLite/分词/嵌入）、`src/tools/`（DSH 工具薄壳）、`src/engine/`（巡检规则+写回）、`src/server/`+`src/client.js`（GUI 浮卡）、`src/memory-inject.mjs`（记忆快照段）。设计文档见 DESIGN.md 与 docs/phase1-3-interface-spec.md。

---

## 6. 安全边界（设计铁律）

- 默认全本地：索引、检索、巡检都在本机；语义嵌入只连本机 Ollama
- 工具写 vault 只有两条口子：`vault_capture`（你叫它存才存）+ 审查批准（逐条点）
- 路径监狱：任何读写都拒绝越出已配置 vault 根目录
