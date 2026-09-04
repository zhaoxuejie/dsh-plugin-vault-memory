// dsh-plugin-vault-memory — CJK bigram 分词（索引与查询共用）
// 依据 docs/step0-calibration.md §4 实测结论：
//   - FTS5 内置 trigram 对 2 字中文词漏检；unicode61 把连续中文整段当一个 token。
//   - 方案：中文连续段切重叠二元组（"知识库"→"知识 识库"），英文/数字保持原样，
//     索引与查询两侧同规则；FTS5 用默认 unicode61 存预分词结果。

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const SEG_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+|[A-Za-z0-9_]+/g;

/**
 * 把文本转成空格分隔的分词串（用于 FTS content_tok 列）。
 * - 中文连续段：长度>=2 → 重叠二元组；长度==1 → 单字 token。
 * - 英文/数字/下划线：连续序列整体为 token（小写）。
 * - 按文档顺序输出各段 token。
 * @param {string} text
 * @returns {string}
 */
export function tokenizeText(text) {
  if (!text) return "";
  const tokens = [];
  for (const seg of text.matchAll(SEG_RE)) {
    const s = seg[0];
    if (CJK_RE.test(s)) {
      if (s.length === 1) tokens.push(s);
      else for (let i = 0; i < s.length - 1; i++) tokens.push(s.slice(i, i + 2));
    } else {
      tokens.push(s.toLowerCase());
    }
  }
  return tokens.join(" ");
}

/**
 * 查询侧分词 + 生成安全 FTS 查询串。
 * 所有 token 双引号包裹（内部引号翻倍转义）后以 AND 连接，防 FTS 语法注入。
 * @param {string} query
 * @returns {{ ftsQuery: string | null, rawTokens: string[] }}
 *   ftsQuery 为 null 表示无有效 token（纯标点等），调用方应直接走 LIKE 兜底。
 */
export function buildFtsQuery(query) {
  const tokens = tokenizeText(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return { ftsQuery: null, rawTokens: [] };
  const quoted = tokens.map((t) => `"${t.replaceAll('"', '""')}"`);
  return { ftsQuery: quoted.join(" "), rawTokens: tokens };
}
