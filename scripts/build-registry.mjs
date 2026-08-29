#!/usr/bin/env node
/**
 * 由 build/packs 下的 zip + 各插件的 plugin.json 重建 registry.json。
 * 必须在 pack.mjs 之后运行（需要 sha256）。
 *
 * 下载 URL 指向滚动 Release "latest" 的固定文件名直链：
 *   https://github.com/<owner>/<repo>/releases/latest/download/<id>-<version>.zip
 * 仓库 slug 优先取 GITHUB_REPOSITORY（CI），否则从 origin remote 解析。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS_DIR = path.join(ROOT, "plugins");
const PACKS_DIR = path.join(ROOT, "build", "packs");

function repoSlug() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = execSync("git remote get-url origin", { cwd: ROOT, encoding: "utf8" }).trim();
  const m = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
  if (!m) throw new Error(`无法从 origin 解析 GitHub 仓库: ${url}`);
  return m[1];
}

const slug = repoSlug();
const plugins = [];
for (const entry of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  const id = entry.name;
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, id, "plugin.json"), "utf8"));
  const zipPath = path.join(PACKS_DIR, `${id}-${manifest.version}.zip`);
  if (!fs.existsSync(zipPath)) {
    console.error(`skip ${id}: ${zipPath} 不存在（先跑 pack.mjs）`);
    continue;
  }
  plugins.push({
    id,
    name: manifest.name || id,
    version: manifest.version,
    description: manifest.description || "",
    download: `https://github.com/${slug}/releases/latest/download/${id}-${manifest.version}.zip`,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex"),
  });
}

fs.writeFileSync(path.join(ROOT, "registry.json"), JSON.stringify({ schema: 1, plugins }, null, 2) + "\n");
console.log(`registry.json: ${plugins.length} plugin(s)`);
