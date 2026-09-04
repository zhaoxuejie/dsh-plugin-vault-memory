import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown } from "../src/core/parser.mjs";

test("frontmatter 三种 tags 写法 + 标题", () => {
  const p = parseMarkdown(`---\ntags:\n  - ai\n  - prompt\n---\n# 标题啊\n正文`, "Prompt/x.md");
  assert.equal(p.title, "标题啊");
  assert.deepEqual(p.tags.sort(), ["ai", "prompt"]);
  assert.equal(p.folder, "Prompt");
});

test("无 frontmatter + 无 H1 → 文件名作标题", () => {
  const p = parseMarkdown("只有一行内容。\n", "other/空笔记.md");
  assert.equal(p.title, "空笔记");
  assert.equal(p.fm.length, 0);
});

test("行内数组 tags 与行内 #tag", () => {
  const p = parseMarkdown("---\ntags: [入门, 首页]\n---\n# 欢迎\n真实标签 #效率 在此。\n", "x.md");
  assert.deepEqual(p.tags.sort(), ["入门", "效率", "首页"]);
});

test("代码块/行内代码中的假链接假标签不提取", () => {
  const p = parseMarkdown(
    "# T\n```python\n[[假链接]] #假标签\n```\n行内 `[[代码]]` 不算。真实标签 #效率。\n",
    "t.md",
  );
  assert.equal(p.links.length, 0);
  assert.deepEqual(p.tags, ["效率"]);
});

test("wikilink 目标剥离锚点与别名", () => {
  const p = parseMarkdown("[[a/b|别名]] [[c#^block]] [[d#标题]]", "x.md");
  assert.deepEqual(p.links.map((l) => ({ kind: l.kind, target: l.target })), [
    { kind: "wiki", target: "a/b" },
    { kind: "wiki", target: "c" },
    { kind: "wiki", target: "d" },
  ]);
});

test("embed 与 markdown 相对链接；外部链接跳过", () => {
  const p = parseMarkdown(
    "![[../Prompt/chatgpt]]\n[内部](../Prompt/chatgpt.md)\n[外部](https://example.com)\n[锚点](#x)\n",
    "markdown/x.md",
  );
  assert.deepEqual(p.links.map((l) => l.kind), ["embed", "markdown"]);
  assert.equal(p.links[0].target, "../Prompt/chatgpt");
  assert.equal(p.links[1].target, "../Prompt/chatgpt.md");
});

test("contentPlain 去除格式符/标题符/列表符", () => {
  const p = parseMarkdown("# 标题\n> 引用\n- 列表项\n**加粗** `代码`\n![图](img.png)\n", "x.md");
  assert.ok(!p.contentPlain.includes("#"));
  assert.ok(!p.contentPlain.includes("**"));
  assert.ok(!p.contentPlain.includes(">"));
  assert.ok(!p.contentPlain.includes("`"));
});

test("坏 frontmatter 容错：YAML 解析失败不影响正文", () => {
  const p = parseMarkdown("---\ntags: [未闭合\n---\n# 正文标题\n内容", "x.md");
  assert.equal(p.title, "正文标题");
  assert.equal(p.contentPlain.includes("内容"), true);
});
