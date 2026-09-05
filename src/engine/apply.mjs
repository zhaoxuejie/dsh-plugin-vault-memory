// dsh-plugin-vault-memory — 审查写回（唯一改 vault 的批准入口）
// 语义：引擎只出建议；这里在逐条 approve 时执行写盘，写前把原内容存进 payload.backup，
// revert 用 backup 还原（moc 新建文件则删除）。绝不自动删用户既有文件。
// 幂等：status !== 'open' 时 approve 直接返回已处理。

import { vaultError, VAULT_ERROR_CODES as C } from "../errors.mjs";

/**
 * 批准一条建议并写回。
 * @param {import("../core/index.mjs").VaultIndex} index
 * @param {object} sug suggestions 行（含 payload）
 * @param {{ links?: string[], target?: string }} opts orphan 勾选 / broken 指定目标
 */
export function applySuggestion(index, sug, opts = {}) {
  if (sug.status !== "open") {
    return { ok: false, message: `建议已是 ${sug.status}，跳过` };
  }
  switch (sug.kind) {
    case "orphan":
      return applyOrphan(index, sug, opts);
    case "broken_link":
      return applyBrokenLink(index, sug, opts);
    case "moc_draft":
      return applyMoc(index, sug);
    default:
      throw vaultError(C.INVALID_ARG, `不支持的建议类型: ${sug.kind}`);
  }
}

function applyOrphan(index, sug, opts) {
  const proposed = Array.isArray(sug.payload.proposedLinks) ? sug.payload.proposedLinks : [];
  const chosen = Array.isArray(opts.links) && opts.links.length > 0
    ? opts.links
    : proposed.slice(0, 3).map((p) => p.path);
  if (chosen.length === 0) throw vaultError(C.INVALID_ARG, "orphan 建议无可关联笔记，请忽略");
  const rel = sug.target;
  const { exists, text } = index.readRawNote(rel);
  if (!exists) throw vaultError(C.NOTE_NOT_FOUND, `笔记不存在: ${rel}`);
  const existing = new Set(text.split("\n").map((l) => l.trim()));
  const links = chosen.filter((p) => !existing.has(`- [[${p.replace(/\.md$/i, "")}]]`));
  const back = { text, path: rel };
  const addendum = ["", "## 相关", ...links.map((p) => `- [[${p.replace(/\.md$/i, "")}]]`)].join("\n");
  index.writeRawNote(rel, text.replace(/\s*$/, "") + addendum + "\n");
  index.ensureStore().setSuggestion(sug.id, { status: "applied", payload: { ...sug.payload, backup: back, applied: links } });
  return { ok: true, message: `已在 ${rel} 的「相关」区追加 ${links.length} 条链接` };
}

function applyBrokenLink(index, sug, opts) {
  const raw = sug.payload.rawTarget;
  const candidates = Array.isArray(sug.payload.candidates) ? sug.payload.candidates : [];
  const target = opts && opts.target ? opts.target : candidates[0];
  if (!target) throw vaultError(C.INVALID_ARG, `断链 [[${raw}]] 无候选目标，请人工处理或忽略`);
  const rel = sug.target;
  const { exists, text } = index.readRawNote(rel);
  if (!exists) throw vaultError(C.NOTE_NOT_FOUND, `笔记不存在: ${rel}`);
  let next = null;
  if (text.includes(`[[${raw}]]`)) next = text.replace(`[[${raw}]]`, `[[${target.replace(/\.md$/i, "")}]]`);
  else if (text.includes(`[[${raw}`)) next = text.replace(`[[${raw}`, `[[${target.replace(/\.md$/i, "")}`);
  if (next === null || next === text) {
    throw vaultError(C.INTERNAL, `在 ${rel} 中未找到引用 [[${raw}]]，可能已被处理`);
  }
  const back = { text, path: rel };
  index.writeRawNote(rel, next);
  index.ensureStore().setSuggestion(sug.id, {
    status: "applied",
    payload: { ...sug.payload, backup: back, appliedTarget: target },
  });
  return { ok: true, message: `${rel}: [[${raw}]] → [[${target.replace(/\.md$/i, "")}]]` };
}

function applyMoc(index, sug) {
  const rel = sug.target;
  const md = sug.payload.draftMd;
  if (!md) throw vaultError(C.INVALID_ARG, "moc_draft 缺草稿内容");
  const { exists } = index.readRawNote(rel);
  if (exists) throw vaultError(C.NOTE_EXISTS, `目标已存在: ${rel}`);
  index.writeRawNote(rel, md);
  index.ensureStore().setSuggestion(sug.id, {
    status: "applied",
    payload: { ...sug.payload, backup: { text: null, path: rel } },
  });
  return { ok: true, message: `已创建目录总览: ${rel}` };
}

/** 回滚一条已批准的建议。 */
export function revertSuggestion(index, sug) {
  if (sug.status !== "applied") return { ok: false, message: `仅 applied 可回滚（当前 ${sug.status}）` };
  const backup = sug.payload && sug.payload.backup;
  if (!backup || !backup.path) throw vaultError(C.INTERNAL, "建议无备份，无法回滚");
  if (backup.text === null) {
    // 新建文件（moc）：删除由本插件创建的文件
    index.removeRawNote(backup.path);
  } else {
    const { exists } = index.readRawNote(backup.path);
    if (!exists) throw vaultError(C.NOTE_NOT_FOUND, `笔记不存在: ${backup.path}`);
    index.writeRawNote(backup.path, backup.text);
  }
  index.ensureStore().setSuggestion(sug.id, { status: "reverted", payload: sug.payload });
  return { ok: true, message: `已回滚: ${backup.path}` };
}
