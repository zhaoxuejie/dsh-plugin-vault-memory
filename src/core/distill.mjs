// dsh-plugin-vault-memory — 记忆蒸馏：把各库状态压成"用户记忆快照"
// 只读产物，供会话注入（systemPrompt.context）与未来面板使用。
// 轻量版：画像=欢迎笔记开头；活跃项目=近 7 天高频目录；今日/近期=修改笔记清单。

const DAY_MS = 24 * 3600 * 1000;

/**
 * @param {Array<{label: string, index: import("./index.mjs").VaultIndex}>} keys
 * @returns {Array<object>} 每库快照
 */
export function distillVaults(keys) {
  const out = [];
  for (const k of keys) {
    const idx = k.index;
    if (!idx || !idx.ready) {
      out.push({ label: k.label, ready: false });
      continue;
    }
    const store = idx.ensureStore();
    const total = store.noteCount();
    const startToday = new Date();
    startToday.setHours(0, 0, 0, 0);
    const start7 = new Date(Date.now() - 7 * DAY_MS);
    const recent = store.queryNotes({ sort: "modified_desc", limit: 60 });
    const today = recent.filter((n) => n.mtime_ms >= startToday.getTime()).slice(0, 10);
    const week = recent.filter((n) => n.mtime_ms >= start7.getTime()).slice(0, 12);

    const byFolder = new Map();
    for (const n of week) {
      if (!n.folder) continue;
      const e = byFolder.get(n.folder) || { count: 0, last: 0, titles: [] };
      e.count += 1;
      e.last = Math.max(e.last, n.mtime_ms);
      e.titles.push(n.title);
      byFolder.set(n.folder, e);
    }
    const projects = [...byFolder.entries()]
      .sort((a, b) => b[1].last - a[1].last)
      .slice(0, 5)
      .map(([folder, e]) => ({ folder, count: e.count, titles: e.titles.slice(0, 3) }));

    let profile = "";
    const welcome = store.getNote("欢迎.md");
    if (welcome && welcome.content_plain) {
      profile = welcome.content_plain.replace(/\s+/g, " ").trim().slice(0, 400);
    }
    out.push({
      label: k.label,
      ready: true,
      total,
      profile,
      projects,
      today: today.map((n) => ({ path: n.path, title: n.title, mtime: new Date(n.mtime_ms).toISOString() })),
      week: week.map((n) => ({ path: n.path, title: n.title })),
    });
  }
  return out;
}

/** 渲染注入用 markdown（整体限长，超限从次要部分截断）。 */
export function renderMemoryMarkdown(vaults, maxChars) {
  const parts = [];
  for (const v of vaults) {
    if (!v.ready) continue;
    const lines = [`### 库 ${v.label}（${v.total} 篇笔记）`];
    if (v.profile) lines.push(`- 库简介：${v.profile}`);
    if (v.projects.length > 0) {
      lines.push(`- 活跃项目（近 7 天）：${v.projects.map((p) => `${p.folder}（${p.count} 篇）`).join("、")}`);
    }
    if (v.today.length > 0) {
      lines.push(`- 今日笔记：${v.today.map((n) => n.path).join("、")}`);
    } else if (v.week.length > 0) {
      lines.push(`- 近期笔记：${v.week.map((n) => n.path).join("、")}`);
    }
    parts.push(lines.join("\n"));
  }
  let md = parts.join("\n\n");
  if (md.length > maxChars) md = md.slice(0, maxChars) + "\n…（已截断）";
  return md;
}
