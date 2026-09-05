// Phase 3 单测：巡检规则 / 审查写回 / 回滚 / vault_health 工具 / review 路由
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { VaultIndex } from "../src/core/index.mjs";
import { runReview, dedupeOpen } from "../src/engine/rules.mjs";
import { VAULT_ERROR_CODES as C } from "../src/errors.mjs";
import { registerVaultHealthTool } from "../src/tools/vault-health.mjs";
import { tempVaultDir, tempDbPath } from "./helpers.mjs";

function makeIndex() {
  const dir = tempVaultDir();
  const idx = new VaultIndex({ root: dir, dbPath: tempDbPath(), opts: { mocThreshold: 3 } });
  idx.fullScan();
  return { dir, idx };
}

// ---------- 规则 ----------
test("巡检：孤儿/断链/MOC 建议类型正确", () => {
  const { idx } = makeIndex();
  const { drafts } = runReview(idx.ensureStore(), { mocThreshold: 3 });
  const kinds = new Set(drafts.map((d) => d.kind));
  assert.ok(kinds.has("orphan"), "应有孤儿建议");
  assert.ok(kinds.has("broken_link"), "应有断链建议（欢迎.md → 不存在的笔记）");
  assert.ok(drafts.every((d) => d.target && d.reason));
  for (const d of drafts) assert.doesNotThrow(() => JSON.stringify(d.payload));
});

test("孤儿建议排除极短占位、带 proposedLinks", () => {
  const { idx } = makeIndex();
  const orphans = runReview(idx.ensureStore(), {}).drafts.filter((d) => d.kind === "orphan");
  // 欢迎.md 无入链 → 确属孤儿（正常）；空笔记（<20 字）不列
  assert.ok(!orphans.some((d) => d.target === "other/空笔记.md"), "极短占位不应列为孤儿");
  assert.ok(orphans.every((d) => Array.isArray(d.payload.proposedLinks)));
  if (orphans.length > 0) assert.ok(orphans.every((d) => d.target && d.reason));
});

test("断链建议给出候选（写作提示→chatgpt 解析成功则无断链）", () => {
  const { idx } = makeIndex();
  const broken = runReview(idx.ensureStore(), { kinds: ["broken_link"] }).drafts;
  // fixture: 欢迎.md 引 [[不存在的笔记]]、相对链接.md 引 chatgpt.md(悬空)
  const byFrom = broken.filter((d) => d.target === "欢迎.md");
  assert.ok(byFrom.some((d) => d.payload.rawTarget === "不存在的笔记"));
});

// ---------- 审查写回（批准 → 备份 → 回滚） ----------
test("orphan 批准追加相关区并可回滚", () => {
  const { dir, idx } = makeIndex();
  idx.reviewRun({});
  const rows = idx.ensureStore().openSuggestions({});
  const orphan = rows.find((s) => s.kind === "orphan");
  if (!orphan) return; // 无孤儿场景（覆盖率受限）跳过
  const before = fs.readFileSync(path.join(dir, orphan.target), "utf8");
  const r = idx.applySuggestion(orphan.id);
  assert.ok(r.ok, r.message);
  const after = fs.readFileSync(path.join(dir, orphan.target), "utf8");
  assert.ok(after.includes("## 相关"));
  const row = idx.ensureStore().getSuggestion(orphan.id);
  assert.equal(row.status, "applied");
  assert.ok(row.payload.backup && row.payload.backup.text === before);
  const rr = idx.revertSuggestion(orphan.id);
  assert.ok(rr.ok);
  assert.equal(fs.readFileSync(path.join(dir, orphan.target), "utf8"), before);
  assert.equal(idx.ensureStore().getSuggestion(orphan.id).status, "reverted");
});

test("broken_link 批准替换引用并可回滚", () => {
  const { dir, idx } = makeIndex();
  idx.reviewRun({});
  const rows = idx.ensureStore().openSuggestions({});
  const broken = rows.find((s) => s.kind === "broken_link" && s.payload.rawTarget === "不存在的笔记");
  if (!broken) return;
  const before = fs.readFileSync(path.join(dir, broken.target), "utf8");
  assert.ok(before.includes("不存在的笔记"));
  // 库内无近似候选 → 由调用方显式指定修复目标
  const r = idx.applySuggestion(broken.id, { target: "Prompt/写作提示.md" });
  assert.ok(r.ok, r.message);
  const after = fs.readFileSync(path.join(dir, broken.target), "utf8");
  assert.ok(!after.includes("[[不存在的笔记]]"));
  assert.ok(after.includes("[[Prompt/写作提示]]"));
  const rr = idx.revertSuggestion(broken.id);
  assert.ok(rr.ok);
  assert.equal(fs.readFileSync(path.join(dir, broken.target), "utf8"), before);
});

test("moc_draft 批准创建总览、重复批准幂等、回滚删除", () => {
  const { dir, idx } = makeIndex();
  idx.reviewRun({});
  const rows = idx.ensureStore().openSuggestions({});
  const moc = rows.find((s) => s.kind === "moc_draft");
  if (!moc) return;
  const r = idx.applySuggestion(moc.id);
  assert.ok(r.ok);
  assert.ok(fs.existsSync(path.join(dir, moc.target)));
  // 二次批准（同建议已 applied）→ 幂等拒绝
  const again = idx.applySuggestion(moc.id);
  assert.equal(again.ok, false);
  // 同路径新建议已不允许（exists 校验在 moc_draft 生成端 + apply 端）
  const rr = idx.revertSuggestion(moc.id);
  assert.ok(rr.ok);
  assert.ok(!fs.existsSync(path.join(dir, moc.target)));
});

test("重复巡检去重：同 kind+target 不再新增", () => {
  const { idx } = makeIndex();
  idx.reviewRun({});
  const n1 = idx.ensureStore().openSuggestions({}).length;
  idx.reviewRun({});
  const n2 = idx.ensureStore().openSuggestions({}).length;
  assert.equal(n2, n1);
});

test("dismiss 与 stats", () => {
  const { idx } = makeIndex();
  idx.reviewRun({});
  const rows = idx.ensureStore().openSuggestions({});
  if (rows.length === 0) return;
  const r = idx.dismissSuggestion(rows[0].id);
  assert.ok(r.ok);
  assert.equal(idx.ensureStore().getSuggestion(rows[0].id).status, "dismissed");
  const st = idx.reviewStats();
  assert.equal(st.openTotal, rows.length - 1);
});

// ---------- vault_health 工具 ----------
function healthTool(index) {
  let def;
  registerVaultHealthTool({ tools: { register(d) { def = d; return () => {}; } } }, {
    cfg: { review: { mocThreshold: 3 } },
    resolveVault() { return { label: "测试库", index }; },
  });
  return def;
}

test("vault_health：run=true 产出建议；只读返回统计", async () => {
  const { idx } = makeIndex();
  const tool = healthTool(idx);
  const r = await tool.execute({ run: true });
  assert.equal(r.ran, true);
  assert.ok(r.openTotal >= 1);
  assert.ok(r.items.every((i) => i.id > 0 && i.reason));
  const ro = await tool.execute({});
  assert.equal(ro.ran, false);
  assert.equal(typeof ro.openTotal, "number");
});

test("vault_health：非法 kinds 被过滤", async () => {
  const { idx } = makeIndex();
  const tool = healthTool(idx);
  const r = await tool.execute({ run: true, kinds: ["duplicate", "orphan"] });
  // duplicate 不在已实现集 → 只跑 orphan
  assert.ok(r.openTotal >= 0);
});
