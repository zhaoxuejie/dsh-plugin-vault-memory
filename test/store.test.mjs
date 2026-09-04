import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseMarkdown } from "../src/core/parser.mjs";
import { VaultStore } from "../src/core/store.mjs";
import { buildFtsQuery } from "../src/core/tokenize.mjs";
import { makeFixtureVault, tempDir, tempDbPath } from "./helpers.mjs";

function indexAll(store, dir) {
  const files = makeFixtureVault(dir);
  for (const rel of files) {
    const text = fs.readFileSync(dir + "/" + rel, "utf8");
    store.upsertNote(parseMarkdown(text, rel), 1700000000000);
  }
  return files;
}

function setup() {
  const dir = tempDir("vault-store-vault-");
  const store = new VaultStore(tempDbPath());
  const files = indexAll(store, dir);
  return { dir, store, files };
}

test("全量入库计数与幂等重插", () => {
  const { store } = setup();
  assert.equal(store.noteCount(), 9);
  // 同内容重插不产生重复行
  const note = store.getNote("Prompt/chatgpt.md");
  assert.ok(note);
  store.upsertNote(
    parseMarkdown("---\ntags:\n  - ai\n---\n# ChatGPT 提示词\n内容", "Prompt/chatgpt.md"),
    1700000000000,
  );
  assert.equal(store.noteCount(), 9);
});

test("结构化查询：目录/标签/frontmatter 键", () => {
  const { store } = setup();
  const folder = store.queryNotes({ folder: "Prompt" });
  assert.equal(folder.length, 2);
  const tag = store.queryNotes({ tag: "效率" });
  assert.deepEqual(tag.map((n) => n.path).sort(), ["Prompt/chatgpt.md", "Prompt/写作提示.md"]);
  const src = store.queryNotes({ hasFmKey: "source" });
  assert.deepEqual(src.map((n) => n.path).sort(), ["Clippings/网页剪辑.md", "Prompt/chatgpt.md"]);
});

test("结构化查询：时间上下界与排序", () => {
  const { store } = setup();
  assert.equal(store.queryNotes({ modifiedSince: new Date(0) }).length, 9);
  assert.equal(store.queryNotes({ modifiedUntil: new Date(0) }).length, 0);
  const byTitle = store.queryNotes({ sort: "title_asc" });
  assert.equal(byTitle.length, 9);
});

test("FTS：中文 bigram 命中 + LIKE 单字兜底", () => {
  const { store } = setup();
  const q1 = buildFtsQuery("提示词");
  const hits1 = store.searchFts(q1.ftsQuery, 10);
  const paths1 = hits1.map((h) => store.getNoteById(Number(h.rowid)).path);
  assert.ok(paths1.includes("Prompt/chatgpt.md"));
  const q2 = buildFtsQuery("省钱");
  const hits2 = store.searchFts(q2.ftsQuery, 10);
  assert.ok(hits2.map((h) => store.getNoteById(Number(h.rowid)).path).includes("other/消费降级.md"));
  const like = store.searchLike("省", 10);
  assert.ok(like.map((h) => store.getNoteById(Number(h.id)).path).includes("other/消费降级.md"));
});

test("链接解析：库内解析 / 悬空 NULL / 越库 NULL", () => {
  const { store } = setup();
  store.refreshLinks();
  const rows = store.db.prepare(
    "SELECT l.target, l.kind, l.resolved_note, n.path AS from_path FROM links l JOIN notes n ON n.id = l.from_note",
  ).all();
  const find = (from, target) => rows.find((r) => r.from_path === from && r.target === target);
  assert.ok(find("欢迎.md", "Prompt/chatgpt").resolved_note !== null);
  assert.equal(find("欢迎.md", "不存在的笔记").resolved_note, null);
  assert.equal(find("Prompt/写作提示.md", "chatgpt").resolved_note, find("欢迎.md", "Prompt/chatgpt").resolved_note);
  assert.equal(find("Prompt/写作提示.md", "embed测试").resolved_note, null);
  assert.equal(find("markdown/embed测试.md", "../Prompt/chatgpt").resolved_note, find("欢迎.md", "Prompt/chatgpt").resolved_note);
  assert.ok(find("markdown/相对链接.md", "../Prompt/chatgpt.md").resolved_note !== null);
  assert.equal(find("markdown/相对链接.md", "chatgpt.md").resolved_note, null);
});

test("removeNote 级联删除", () => {
  const { store } = setup();
  assert.equal(store.removeNote("Prompt/chatgpt.md"), true);
  assert.equal(store.noteCount(), 8);
  assert.equal(store.getNote("Prompt/chatgpt.md"), undefined);
  const orphanLinks = store.db.prepare("SELECT COUNT(*) AS n FROM links WHERE from_note NOT IN (SELECT id FROM notes)").get();
  assert.equal(Number(orphanLinks.n), 0);
  assert.equal(store.removeNote("Prompt/chatgpt.md"), false);
});
