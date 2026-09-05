// dsh-plugin-vault-memory — 向量数学（纯函数）
// Float32 序列化与余弦相似度、RRF 融合。

/** Buffer 解码为 Float32Array（embeddings.vec BLOB 存小端 float32）。 */
export function decodeVec(buf) {
  const b = typeof buf === "object" && buf !== null && !Buffer.isBuffer(buf) ? Buffer.from(buf) : buf;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
}

/** Float32Array 序列化为 Buffer。 */
export function encodeVec(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** 余弦相似度（归一化向量点积）。 */
export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** L2 归一化（原地）。 */
export function normalize(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

/**
 * RRF 融合两组成绩（note path 为键）。每项: { path, score }（score 高者好）。
 * @returns Array<{ path, score, rank }>
 */
export function rrfFuse(listA, listB, k = 60) {
  const acc = new Map();
  const addRank = (list, weight) => {
    list.slice(0, 100).forEach((item, idx) => {
      const rank = idx + 1;
      const cur = acc.get(item.path) || { score: 0, fromA: false, fromB: false };
      cur.score += weight / (k + rank);
      acc.set(item.path, cur);
    });
  };
  if (listA) addRank(listA, 1);
  if (listB) addRank(listB, 1);
  return [...acc.entries()]
    .map(([path, { score }]) => ({ path, score }))
    .sort((a, b) => b.score - a.score);
}
