// dsh-plugin-vault-memory — 章节分块（语义检索用）
// 以标题为界切分；单块超长按段落二次切割并截断到 maxChars。
// 输入用去格式纯文本即可，标题保留供展示/上下文。

const HEADING_RE = /^#{1,6}\s+(.*)$/;

/**
 * @param {string} text 纯文本（可含标题行）
 * @param {{ maxChars?: number }} opts
 * @returns {Array<{ heading: string, text: string }>}
 */
export function splitSections(text, opts = {}) {
  const maxChars = opts.maxChars || 800;
  const lines = String(text || "").split("\n");
  const blocks = []; // { heading, lines: [] }
  let cur = { heading: "", lines: [] };
  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      if (cur.lines.length > 0 || cur.heading) blocks.push(cur);
      cur = { heading: m[1].trim(), lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  if (cur.lines.length > 0 || cur.heading) blocks.push(cur);

  const out = [];
  for (const b of blocks) {
    const text = b.lines.join("\n").trim();
    if (!text) continue;
    // 超长块按段落切
    const paras = text.length > maxChars ? text.split(/\n{2,}/) : [text];
    let buf = "";
    for (const p of paras) {
      if ((buf + "\n" + p).trim().length > maxChars && buf) {
        out.push({ heading: b.heading, text: trimTo(buf, maxChars) });
        buf = p;
      } else {
        buf = buf ? buf + "\n" + p : p;
      }
    }
    if (buf) out.push({ heading: b.heading, text: trimTo(buf, maxChars) });
  }
  // 无标题时仍应至少有一块
  if (out.length === 0 && text.trim()) out.push({ heading: "", text: trimTo(text, maxChars) });
  return out;
}

function trimTo(s, maxChars) {
  const t = s.trim();
  return t.length > maxChars ? t.slice(0, maxChars) : t;
}
