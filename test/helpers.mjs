// test 辅助：在临时目录生成确定性的样例 vault（9 篇 md + 干扰项）
// 设计覆盖：有无 frontmatter、tags 三种写法、wikilink/embed/md 相对链接、
// 代码块假链接、中文检索、悬空链接、隐藏目录、非 md 附件、Clippings 排除。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const FIXTURE_MD_COUNT = 9;

const FILES = {
  "欢迎.md": `---
tags: [入门, 首页]
created: 2025-01-01
---
# 欢迎
这是我的知识库入口。

相关：[[Prompt/chatgpt]] 和 [[不存在的笔记]]
`,
  "Prompt/chatgpt.md": `---
tags:
  - ai
  - prompt
source: web
---
# ChatGPT 提示词
一些提示词技巧。

\`\`\`python
# 这里不是真标签 [[假链接]] #假标签
print("hi")
\`\`\`

行内 \`[[代码]]\` 也不算。真实标签 #效率 在此。
`,
  "Prompt/写作提示.md": `---
tags: 写作, 效率
---
# 写作提示
写作建议，见 [[chatgpt]] 与 [[embed测试]]。
`,
  "markdown/相对链接.md": `# 相对链接
- [内部链接](../Prompt/chatgpt.md)
- [无扩展](chatgpt.md)
- [外部](https://example.com)
`,
  "markdown/embed测试.md": `# 嵌入
![[../Prompt/chatgpt]]
`,
  "other/空笔记.md": `只有一行内容。
`,
  "other/消费降级.md": `# 消费降级
如何省钱？答案是消费降级，少买不需要的东西。
`,
  "daily/2026-01-15.md": `---
tags: daily
---
# 2026-01-15
今天研究了大模型 embedding。
`,
  "Clippings/网页剪辑.md": `---
source: https://example.com/article
title: 剪辑标题
---
# 网页剪辑
剪辑的正文内容。提到 [[Prompt/chatgpt]]。
`,
  // ---- 干扰项（不应被索引）----
  ".hidden/秘密.md": `# 秘密\n不应该被扫描。\n`,
  "attachments/图.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  ".obsidian/app.json": `{"theme":"dark"}`,
};

/** 在 dir 下生成样例 vault；返回写入的 md 相对路径列表。 */
export function makeFixtureVault(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    if (rel.endsWith(".md") && !rel.split("/")[0].startsWith(".")) written.push(rel);
  }
  return written;
}

/** 生成一次性临时目录。 */
export function tempDir(prefix = "vault-mem-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function tempVaultDir() {
  const dir = tempDir("vault-mem-vault-");
  makeFixtureVault(dir);
  return dir;
}

export function tempDbPath() {
  return path.join(tempDir("vault-mem-db-"), "index.db");
}
