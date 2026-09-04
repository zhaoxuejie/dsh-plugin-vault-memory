// 测试运行器：按序 import 所有测试文件（同进程执行）。
// 原因：沙箱内 node --test 默认逐文件 spawn 子进程（管道 stdio）会 EPERM；
// node:test 文件直接 import 时自动运行，无子进程。

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort();

for (const f of files) {
  await import(new URL(f, import.meta.url));
}
