import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { scanVaultFiles, diffScans, matchesIgnore } from "../src/core/scanner.mjs";
import { makeFixtureVault, tempDir, FIXTURE_MD_COUNT } from "./helpers.mjs";

test("glob 匹配", () => {
  assert.equal(matchesIgnore("Clippings/a.md", "Clippings/**"), true);
  assert.equal(matchesIgnore("Clippings/x/y.md", "Clippings/**"), true);
  assert.equal(matchesIgnore("other/a.md", "Clippings/**"), false);
  assert.equal(matchesIgnore("a.md", "*.md"), true);
  assert.equal(matchesIgnore("sub/a.md", "*.md"), false);
});

test("全量扫描：只收 .md、排除隐藏目录与非 md", () => {
  const dir = tempDir("vault-scan-");
  makeFixtureVault(dir);
  const files = scanVaultFiles(dir);
  assert.equal(files.size, FIXTURE_MD_COUNT);
  const bad = [...files.keys()].filter(
    (p) => p.split("/").some((seg) => seg.startsWith(".")) || !p.endsWith(".md"),
  );
  assert.deepEqual(bad, []);
});

test("ignoreGlobs 排除", () => {
  const dir = tempDir("vault-scan-");
  makeFixtureVault(dir);
  const files = scanVaultFiles(dir, { ignoreGlobs: ["Clippings/**"] });
  assert.equal(files.size, FIXTURE_MD_COUNT - 1);
  assert.ok(![...files.keys()].some((p) => p.startsWith("Clippings/")));
});

test("diffScans：增/改/删", () => {
  const dir = tempDir("vault-scan-");
  makeFixtureVault(dir);
  const prev = scanVaultFiles(dir);
  // 改
  fs.appendFileSync(path.join(dir, "other", "空笔记.md"), "\n新增一行");
  // 增
  fs.writeFileSync(path.join(dir, "new.md"), "# new\n");
  // 删
  fs.unlinkSync(path.join(dir, "Prompt", "chatgpt.md"));
  const next = scanVaultFiles(dir);
  const { added, changed, removed } = diffScans(prev, next);
  assert.deepEqual(added, ["new.md"]);
  assert.deepEqual(changed, ["other/空笔记.md"]);
  assert.deepEqual(removed, ["Prompt/chatgpt.md"]);
});

test("VaultIndex 增量 reconcile 增改删同步", async () => {
  const { VaultIndex } = await import("../src/core/index.mjs");
  const dir = tempDir("vault-scan-");
  makeFixtureVault(dir);
  const idx = new VaultIndex({ root: dir, dbPath: path.join(tempDir("db-"), "i.db") });
  assert.deepEqual(idx.fullScan(), { indexed: FIXTURE_MD_COUNT, errors: [] });
  assert.equal(idx.stats().notes, FIXTURE_MD_COUNT);
  // 增 + 删 + 改
  fs.writeFileSync(path.join(dir, "new.md"), "# 新笔记\n包含特殊词 消费降级\n");
  fs.unlinkSync(path.join(dir, "Prompt", "chatgpt.md"));
  fs.appendFileSync(path.join(dir, "other", "空笔记.md"), "\n修改过");
  idx.reconcile();
  assert.equal(idx.stats().notes, FIXTURE_MD_COUNT); // 9 +1 -1
  assert.ok(idx.search("消费降级", {}).hits.some((h) => h.path === "new.md"));
  assert.ok(!idx.search("消费降级", {}).hits.some((h) => h.path === "Prompt/chatgpt.md"));
  idx.close();
});
