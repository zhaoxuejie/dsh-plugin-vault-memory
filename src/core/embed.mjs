// dsh-plugin-vault-memory — Ollama 嵌入客户端（默认本地，零外发）
// API（实测 2026）：POST {baseUrl}/api/embed  body {model, input: string[]}
//   → { embeddings: number[][] }（bge-m3 dim 1024）。批量 + 超时 + 幂等降级。

import { vaultError, VAULT_ERROR_CODES as C } from "../errors.mjs";

/**
 * 创建 Ollama embedder。
 * @param {{ baseUrl?: string, model?: string, batchSize?: number, timeoutMs?: number }} cfg
 */
export function createOllamaEmbedder(cfg = {}) {
  const baseUrl = (cfg.baseUrl || "http://127.0.0.1:11434").replace(/\/+$/, "");
  const model = cfg.model || "bge-m3";
  const batchSize = cfg.batchSize || 16;
  const timeoutMs = cfg.timeoutMs || 60000;
  return {
    model,
    /** @param {string[]} texts 返回与输入同序向量数组 */
    async embed(texts) {
      const out = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const slice = texts.slice(i, i + batchSize);
        let res;
        try {
          res = await fetch(`${baseUrl}/api/embed`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model, input: slice }),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (e) {
          throw vaultError(C.EMBED_UNAVAILABLE, `Ollama 不可达（${baseUrl}）: ${e.message}`, e);
        }
        if (!res.ok) {
          throw vaultError(C.EMBED_UNAVAILABLE, `Ollama 嵌入失败 HTTP ${res.status}（模型 ${model}？用 ollama pull ${model}）`);
        }
        let data;
        try {
          data = await res.json();
        } catch (e) {
          throw vaultError(C.EMBED_UNAVAILABLE, "Ollama 返回非 JSON", e);
        }
        const list = data.embeddings;
        if (!Array.isArray(list) || list.length !== slice.length) {
          throw vaultError(C.EMBED_UNAVAILABLE, "Ollama 返回向量数量与输入不符");
        }
        for (const v of list) {
          if (!Array.isArray(v) || v.length === 0) {
            throw vaultError(C.EMBED_UNAVAILABLE, "Ollama 返回空向量");
          }
          out.push(Float32Array.from(v));
        }
      }
      return out;
    },
  };
}

/** 探测可用性（不抛错）。 */
export async function probeEmbedder(embedder) {
  try {
    const vecs = await embedder.embed(["ping"]);
    return { ok: vecs.length === 1, dim: vecs[0] ? vecs[0].length : 0 };
  } catch {
    return { ok: false, dim: 0 };
  }
}
