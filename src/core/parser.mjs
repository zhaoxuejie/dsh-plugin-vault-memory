// dsh-plugin-vault-memory — markdown 解析器（容错优先）
// 输入：文件文本 + vault 相对路径 → ParsedNote（结构 + 可检索纯文本）。
// 铁律：任何异常只影响单篇（返回降级结果/抛错由调用方跳过），绝不中断全库扫描。
// 不解析完整 YAML：只提取 flat `key: value` 与 `- item` 列表，失败容忍。

import path from "node:path";

const TAG_RE = /(^|[\s\p{P}])(#)([\p{L}\p{N}_\-/]+)/gu;
const WIKILINK_RE = /(!?)\[\[([^\[\]\n]+)\]\]/g;
const MDLINK_RE = /!?\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

/**
 * @param {string} text 笔记全文（UTF-8）
 * @param {string} relPath vault 相对路径（posix）
 * @returns {object} ParsedNote
 */
export function parseMarkdown(text, relPath) {
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");

  // --- frontmatter ---
  let fmLines = [];
  let bodyStart = 0;
  if (lines.length > 0 && lines[0].trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---" || lines[i].trim() === "...") {
        fmLines = lines.slice(1, i);
        bodyStart = i + 1;
        break;
      }
    }
  }
  const fm = parseMinimalYaml(fmLines);

  const bodyLines = lines.slice(bodyStart);

  // --- title：fm 之后首个 H1 ---
  let title = "";
  for (const line of bodyLines) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) {
      title = m[1];
      break;
    }
  }
  if (!title) title = path.basename(relPath).replace(/\.md$/i, "");

  // --- contentPlain：去代码块/图片/链接语法/格式符，供检索与摘要 ---
  const contentPlain = toPlainText(bodyLines.join("\n"));

  // --- tags：frontmatter tags + 行内 #tag（小写、去尾标点） ---
  const tags = new Set();
  for (const { key, value, isList } of fm) {
    if (key.toLowerCase() === "tags") {
      const parts = value.split(","); // 列表已在 parseMinimalYaml 用逗号 join；字符串形式也按逗号拆
      for (const p of parts) {
        const t = p.trim().replace(/^#/, "");
        if (t) tags.add(t.toLowerCase());
      }
    }
  }
  TAG_RE.lastIndex = 0;
  for (const m of contentPlain.matchAll(TAG_RE)) {
    const tag = m[3].replace(/[.,;:!?。，；：！？)\]}]+$/, "");
    if (tag) tags.add(tag.toLowerCase());
  }

  // --- links：wikilink / embed / markdown 相对链接（代码块/行内代码剥离后再提取） ---
  const linkSource = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`[^`\n]+`/g, "");
  const links = [];
  WIKILINK_RE.lastIndex = 0;
  for (const m of linkSource.matchAll(WIKILINK_RE)) {
    const inner = m[2].trim();
    if (!inner) continue;
    const hashIdx = inner.indexOf("#");
    const namePart = (hashIdx >= 0 ? inner.slice(0, hashIdx) : inner).trim();
    let target = namePart.split("|")[0].trim();
    if (!target) continue;
    links.push({ kind: m[1] === "!" ? "embed" : "wiki", raw: `[[${m[2]}]]`, target });
  }
  MDLINK_RE.lastIndex = 0;
  for (const m of linkSource.matchAll(MDLINK_RE)) {
    const url = m[2];
    if (/^(https?:\/\/|mailto:|data:|#)/i.test(url)) continue;
    let target = url.split("#")[0];
    if (!target || !/\.md$/i.test(target) && !/^[./]/.test(target) && !/^[^.\/]+$/.test(target)) {
      // 只有看起来像 vault 内文件（*.md / 相对路径 / 无扩展名）才入 links
      continue;
    }
    links.push({ kind: "markdown", raw: `[${m[1]}](${url})`, target });
  }

  // --- 统计 ---
  const cjkCount = (contentPlain.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  const wordCount = (contentPlain.match(/[A-Za-z0-9_]+/g) || []).length;
  const folder = path.posix.dirname(relPath) === "." ? "" : path.posix.dirname(relPath);

  return {
    path: relPath,
    title,
    contentPlain,
    folder,
    tags: [...tags],
    fm,
    links,
    wordCount: cjkCount + wordCount,
    lineCount: bodyLines.length,
  };
}

/** 最小 YAML：`key: value`、`[a, b]` 内联数组、`- item` 列表（允许空行间隔）；解析失败容忍（跳过坏行）。 */
function parseMinimalYaml(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) {
      i++;
      continue;
    }
    const m = /^([A-Za-z0-9_\-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    let value = m[2].trim();
    // 收集后续 `- item` 行（允许列表项间空行；遇到下一 key 停止）
    const items = [];
    let j = i + 1;
    while (j < lines.length) {
      const nl = lines[j].trim();
      if (nl.startsWith("- ")) {
        items.push(nl.slice(2).trim());
        j++;
        continue;
      }
      if (!nl) {
        let k = j + 1;
        while (k < lines.length && !lines[k].trim()) k++;
        if (k < lines.length && lines[k].trim().startsWith("- ")) {
          j++;
          continue;
        }
      }
      break;
    }
    if (items.length > 0) {
      out.push({ key, value: items.join(","), isList: true });
    } else if (value.startsWith("[") && value.endsWith("]")) {
      const arr = value.slice(1, -1).split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      out.push({ key, value: arr.join(","), isList: arr.length > 1 });
    } else {
      const v = value.replace(/^["']|["']$/g, "");
      out.push({ key, value: v, isList: false });
    }
    i = j;
  }
  return out;
}

/** 去除代码块/图片/链接语法/格式符，返回可检索纯文本。 */
function toPlainText(md) {
  let s = md;
  s = s.replace(/```[\s\S]*?```/g, "");          // 围栏代码块
  s = s.replace(/~~~[\s\S]*?~~~/g, "");
  s = s.replace(/^\s*```.*$/gm, "");             // 未闭合围栏残行
  s = s.replace(/`[^`\n]+`/g, "");               // 行内代码
  s = s.replace(/<!--[\s\S]*?-->/g, "");         // html 注释
  s = s.replace(/!\[\[([^\[\]]*)\]\]/g, "$1");   // 嵌入 wikilink 保留文件名
  s = s.replace(/\[\[([^\[\]]*?)(?:\|[^\[\]]*?)?\]\]/g, (_, inner) => inner.split("#")[0].split("|")[0].trim());
  s = s.replace(/!?\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, "$1"); // md 链接/图片 → 文本
  s = s.replace(/^#{1,6}\s+/gm, "");             // 标题符
  s = s.replace(/^\s*>\s?/gm, "");               // 引用
  s = s.replace(/^\s*[-*+]\s+/gm, "");           // 列表符
  s = s.replace(/^\s*\d+[.)]\s+/gm, "");
  s = s.replace(/(\*\*|__|~~)/g, "");            // 加粗/删除线
  s = s.replace(/(^|\s)[*_](?=\S)/g, "$1");      // 行内强调（粗略）
  return s;
}

export const _internal = { toPlainText, parseMinimalYaml };
