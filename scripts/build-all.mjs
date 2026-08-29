#!/usr/bin/env node
/**
 * 一条龙构建：发现 plugins/* →（有 package.json 的）npm install + build + 自测
 * → pack.mjs 全量打包。CI 与本地共用同一条命令。
 *
 * 用法：node scripts/build-all.mjs [pluginId ...]
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS_DIR = path.join(ROOT, "plugins");

const run = (cmd, cwd) => {
  console.log(`\n> ${cmd}  (cwd: ${path.relative(ROOT, cwd) || "."})`);
  execSync(cmd, { cwd, stdio: "inherit" });
};

const args = process.argv.slice(2);
const ids = args.length
  ? args
  : fs.readdirSync(PLUGINS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

for (const id of ids) {
  const dir = path.join(PLUGINS_DIR, id);
  if (!fs.existsSync(path.join(dir, "plugin.json"))) {
    console.error(`skip ${id}: 没有 plugin.json（不是插件目录）`);
    continue;
  }
  console.log(`\n==== ${id} ====`);

  // parser 纯 JS 自测（若存在）
  if (fs.existsSync(path.join(dir, "src", "lib", "parser", "_selftest.mjs")))
    run("node src/lib/parser/_selftest.mjs", dir);

  if (fs.existsSync(path.join(dir, "package.json"))) {
    run("npm install --no-audit --no-fund", dir);
    run("npm run build", dir);
  }

  run("node scripts/pack.mjs " + id, ROOT);
}
