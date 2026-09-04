import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenizeText, buildFtsQuery } from "../src/core/tokenize.mjs";

test("中文连续段切成重叠二元组", () => {
  assert.equal(tokenizeText("如何省钱"), "如何 何省 省钱");
  assert.equal(tokenizeText("知识库"), "知识 识库");
});

test("单字中文独立成 token", () => {
  assert.equal(tokenizeText("单"), "单");
});

test("英文/数字保持整词且小写", () => {
  assert.equal(tokenizeText("Hello World 42"), "hello world 42");
});

test("中英混合", () => {
  assert.equal(tokenizeText("hello 知识库"), "hello 知识 识库");
});

test("标点分割中文串", () => {
  assert.equal(tokenizeText("如何省钱？答案是消费降级"), "如何 何省 省钱 答案 案是 是消 消费 费降 降级");
});

test("查询 token 全部双引号包裹", () => {
  assert.equal(buildFtsQuery("消费降级").ftsQuery, '"消费" "费降" "降级"');
  assert.equal(buildFtsQuery("he llo").ftsQuery, '"he" "llo"');
});

test("纯标点查询返回 null ftsQuery", () => {
  const r = buildFtsQuery("!!!。。。");
  assert.equal(r.ftsQuery, null);
  assert.deepEqual(r.rawTokens, []);
});

test("空查询", () => {
  assert.equal(buildFtsQuery("").ftsQuery, null);
  assert.equal(buildFtsQuery("  ").ftsQuery, null);
});
