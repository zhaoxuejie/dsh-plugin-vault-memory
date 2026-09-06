// dsh-plugin-vault-memory — 宿主 webServer 路由（GUI 浮卡数据通道）
// 对齐 daily-digest 的 webServer.register({ kind:"exact", path, handler })。
// 端点全部走 JSON；写 vault 的 commit 仅由用户侧明确操作触发。

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJson(req, cap = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > cap) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function vaultSummary(runtime, key) {
  const idx = runtime.indexes.get(key.rootAbs);
  const base = { label: key.label || key.path, path: key.path };
  if (key.error) return { ...base, ready: false, error: key.error, notes: 0, brokenLinks: 0, recent: [] };
  if (!idx) return { ...base, ready: false, error: "index missing", notes: 0, brokenLinks: 0, recent: [] };
  try {
    const h = idx.health();
    let reviewOpen = 0;
    let trend = [];
    let embed = null;
    try {
      const rs = idx.reviewStats();
      reviewOpen = rs.openTotal;
      trend = rs.snapshots.slice(0, 7).map((s) => ({ at: s.at, metrics: s.metrics }));
    } catch {
      /* 老库无建议表等：忽略 */
    }
    try {
      embed = idx.semanticState();
    } catch {
      embed = null;
    }
    return { ...base, ...h, reviewOpen, trend, embed, error: idx.scanErrors.length > 0 ? `${idx.scanErrors.length} 篇解析失败` : null };
  } catch (e) {
    return { ...base, ready: false, error: String(e && e.message ? e.message : e), notes: 0, brokenLinks: 0, recent: [] };
  }
}

/** 在已配库中定位建议所属的 index 与行。 */
function findSuggestion(runtime, id) {
  for (const k of runtime.vaultKeys) {
    if (k.error || !k.index) continue;
    const sug = k.index.ensureStore().getSuggestion(id);
    if (sug) return { label: k.label || k.path, index: k.index, sug };
  }
  return null;
}

/** 注册全部 /vault-memory/* 路由。 */
export function registerVaultRoutes(webServer, runtime) {
  const cfgView = () => ({
    enabled: runtime.cfg.enabled,
    vaults: runtime.vaultKeys.map((k) => ({ path: k.path, label: k.label, error: k.error || null })),
    memory: runtime.cfg.memory,
    capture: runtime.cfg.capture,
    review: runtime.cfg.review,
    embed: runtime.cfg.embed,
    gui: runtime.cfg.gui,
  });

  webServer.register({
    kind: "exact",
    path: "/vault-memory/health",
    handler: async (_req, res) => {
      const vaults = runtime.vaultKeys.map((k) => vaultSummary(runtime, k));
      json(res, 200, { enabled: runtime.cfg.enabled, vaults, updatedAt: new Date().toISOString() });
    },
  });

  webServer.register({
    kind: "exact",
    path: "/vault-memory/settings",
    handler: async (req, res) => {
      if (req.method === "POST" || req.method === "PUT") {
        let body;
        try {
          body = await readJson(req);
        } catch {
          return json(res, 400, { error: { code: "INVALID_ARG", message: "请求体不是合法 JSON" } });
        }
        try {
          await runtime.applySettingsPatch(body);
          return json(res, 200, { ok: true, config: cfgView() });
        } catch (e) {
          return json(res, 400, { ok: false, error: { code: e.code || "INVALID_ARG", message: e.message } });
        }
      }
      json(res, 200, { config: cfgView() });
    },
  });

  const handleCapture = async (req, res, commit) => {
    let body;
    try {
      body = await readJson(req);
    } catch {
      return json(res, 400, { error: { code: "INVALID_ARG", message: "请求体不是合法 JSON" } });
    }
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const content = typeof body.body === "string" ? body.body.trim() : "";
    if (!title || !content) {
      return json(res, 400, { error: { code: "INVALID_ARG", message: "title 与 body 不能为空" } });
    }
    let target;
    try {
      target = runtime.resolveVault(body.vault);
    } catch (e) {
      return json(res, 404, { error: { code: e.code, message: e.message } });
    }
    const folder = typeof body.folder === "string" && body.folder.trim() !== "" ? body.folder.trim() : runtime.cfg.capture.defaultFolder;
    try {
      const c = {
        title,
        body: content,
        folder,
        tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
        source: typeof body.source === "string" ? body.source : undefined,
        addRelated: body.add_related !== false,
      };
      if (!commit) {
        const p = target.index.capturePreview(c);
        if (p.exists) {
          return json(res, 409, { ok: false, error: { code: "NOTE_EXISTS", message: `笔记已存在: ${p.rel}` }, path: p.rel });
        }
        return json(res, 200, { ok: true, preview: true, vault: target.label, path: p.rel, note: p.note });
      }
      const r = target.index.capture(c);
      return json(res, 200, { ok: true, preview: false, vault: target.label, path: r.path, note: r.note });
    } catch (e) {
      const code = e.code || "INTERNAL";
      const status = code === "NOTE_EXISTS" ? 409 : code === "INVALID_ARG" ? 400 : 500;
      return json(res, status, { ok: false, error: { code, message: e.message } });
    }
  };

  webServer.register({
    kind: "exact",
    path: "/vault-memory/capture/preview",
    handler: (req, res) => handleCapture(req, res, false),
  });
  webServer.register({
    kind: "exact",
    path: "/vault-memory/capture/commit",
    handler: (req, res) => handleCapture(req, res, true),
  });

  // ---------- 审查队列（Phase 3） ----------

  webServer.register({
    kind: "exact",
    path: "/vault-memory/review",
    handler: async (req, res) => {
      if (req.method === "POST") {
        let body;
        try {
          body = await readJson(req);
        } catch {
          return json(res, 400, { error: { code: "INVALID_ARG", message: "请求体不是合法 JSON" } });
        }
        const action = body.action;
        if (action === "run") {
          const kinds = Array.isArray(body.kinds) ? body.kinds.map(String) : undefined;
          const targets = body.vault
            ? [(() => { try { return runtime.resolveVault(body.vault); } catch { return null; } })()].filter(Boolean)
            : runtime.vaultKeys.filter((k) => !k.error && k.index && k.index.ready).map((k) => ({ label: k.label || k.path, index: k.index }));
          const results = [];
          for (const t of targets) {
            try {
              const r = t.index.reviewRun({ kinds, mocThreshold: runtime.cfg.review.mocThreshold });
              results.push({ vault: t.label, ...r });
            } catch (e) {
              results.push({ vault: t.label, error: e.message });
            }
          }
          return json(res, 200, { ok: true, results });
        }
        const id = Number(body.id);
        if (!Number.isFinite(id)) return json(res, 400, { error: { code: "INVALID_ARG", message: "缺 id" } });
        const found = findSuggestion(runtime, id);
        if (!found) return json(res, 404, { error: { code: "NOTE_NOT_FOUND", message: `建议不存在: ${id}` } });
        try {
          let out;
          if (action === "approve") {
            out = found.index.applySuggestion(id, {
              links: Array.isArray(body.links) ? body.links.map(String) : undefined,
              target: typeof body.target === "string" ? body.target : undefined,
            });
          } else if (action === "dismiss") {
            out = found.index.dismissSuggestion(id, typeof body.reason === "string" ? body.reason : undefined);
          } else if (action === "revert") {
            out = found.index.revertSuggestion(id);
          } else {
            return json(res, 400, { error: { code: "INVALID_ARG", message: `未知 action: ${action}` } });
          }
          return json(res, 200, { ok: true, vault: found.label, ...out });
        } catch (e) {
          const code = e.code || "INTERNAL";
          const status = code === "NOTE_EXISTS" || code === "NOTE_NOT_FOUND" ? 409 : code === "INVALID_ARG" ? 400 : 500;
          return json(res, status, { ok: false, error: { code, message: e.message } });
        }
      }
      // GET：open 建议列表
      const kind = typeof req.url === "string" ? null : null; // 参数在 path 上；默认全部
      const limit = 100;
      const out = [];
      for (const k of runtime.vaultKeys) {
        if (k.error || !k.index) continue;
        try {
          const rows = k.index.ensureStore().openSuggestions({ kind: kind || undefined, limit });
          for (const s of rows) {
            out.push({
              id: s.id,
              vault: k.label || k.path,
              kind: s.kind,
              target: s.target,
              reason: s.reason,
              payload: s.payload,
              runAt: s.runAt,
            });
          }
        } catch {
          /* 单库失败跳过 */
        }
      }
      json(res, 200, { ok: true, items: out });
    },
  });
}
