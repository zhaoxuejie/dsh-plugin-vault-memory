import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { normalizeVaultRoot, resolveInside, assertInside, realpathChecked } from "../src/core/vault-root.mjs";
import { VAULT_ERROR_CODES as C } from "../src/errors.mjs";
import { tempDir } from "./helpers.mjs";

function setup() {
  const root = tempDir("vault-root-");
  fs.mkdirSync(path.join(root, "sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "sub", "a.md"), "x");
  return root;
}

test("normalizeVaultRoot 拒绝不存在/非目录", () => {
  assert.throws(() => normalizeVaultRoot(path.join(tempDir(), "nope")), (e) => e.code === C.VAULT_UNREADABLE);
});

test("resolveInside 正常解析（正反斜杠）", () => {
  const root = setup();
  assert.equal(resolveInside(root, "sub/a.md"), path.join(root, "sub", "a.md"));
  assert.equal(resolveInside(root, "sub\\a.md"), path.join(root, "sub", "a.md"));
});

test("resolveInside 拒绝 .. 逃逸", () => {
  const root = setup();
  assert.throws(() => resolveInside(root, "../outside.md"), (e) => e.code === C.VAULT_PATH_ESCAPE);
  assert.throws(() => resolveInside(root, "sub/../../x.md"), (e) => e.code === C.VAULT_PATH_ESCAPE);
});

test("resolveInside 拒绝绝对路径与空路径", () => {
  const root = setup();
  assert.throws(() => resolveInside(root, "C:\\Windows\\win.ini"), (e) => e.code === C.VAULT_PATH_ESCAPE);
  assert.throws(() => resolveInside(root, "/etc/passwd"), (e) => e.code === C.VAULT_PATH_ESCAPE);
  assert.throws(() => resolveInside(root, ""), (e) => e.code === C.VAULT_PATH_ESCAPE);
});

test("assertInside 边界判断", () => {
  const root = setup();
  assert.equal(assertInside(root, root), root);
  assert.throws(() => assertInside(root, path.join(root, "..")), (e) => e.code === C.VAULT_PATH_ESCAPE);
  // 前缀相似但不同目录（root-1 vs root）不可混
  assert.throws(() => assertInside(root, root + "1"), (e) => e.code === C.VAULT_PATH_ESCAPE);
});

test("realpathChecked 拒绝指向库外的链接", (t) => {
  const root = setup();
  const outside = tempDir("vault-root-out-");
  fs.writeFileSync(path.join(outside, "secret.md"), "secret");
  let linked = false;
  try {
    fs.symlinkSync(outside, path.join(root, "evil"), "junction");
    linked = true;
  } catch {
    // 环境不支持创建 junction → 跳过该断言
    t.diagnostic("junction 创建失败，跳过链接逃逸断言");
  }
  if (linked) {
    assert.throws(
      () => realpathChecked(root, path.join(root, "evil", "secret.md")),
      (e) => e.code === C.VAULT_PATH_ESCAPE,
    );
  }
});
