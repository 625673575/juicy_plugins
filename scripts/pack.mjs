#!/usr/bin/env node
/**
 * 打包插件为 zip —— 零依赖（Node 原生，store 模式不压缩；产物里主要是
 * 已压缩的 js/css 文本，收益有限，换来的是无第三方依赖、跨平台、可重现）。
 *
 * 用法：
 *   node scripts/pack.mjs [pluginId ...]     # 缺省打包 plugins/ 下全部
 *
 * 产物：build/packs/<id>-<version>.zip
 *   zip 根即插件根（宿主解压到 <toolsRoot>/<id>/ 即被自动扫描识别）：
 *     plugin.json
 *     dist/**        前端构建产物（宿主识别契约 dist/index.html）
 *     server/**      node 后端（plugin.json backend.entry）
 *   zip 内时间戳固定为 0 —— 同一源码两次打包 sha256 一致，registry 可增量更新。
 *
 * 输出：每行一个 JSON 摘要 { id, version, file, sha256 }，供 CI / build-registry 消费。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS_DIR = path.join(ROOT, "plugins");
const OUT_DIR = path.join(ROOT, "build", "packs");

// ---------------------------------------------------------------- CRC32
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

// ---------------------------------------------------------------- zip(store)
/** 收集目录下全部文件，返回 { rel(正斜杠), abs }，按路径排序保证确定性 */
function collectFiles(dir, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...collectFiles(abs, rel));
    else if (entry.isFile()) out.push({ rel, abs });
  }
  return out;
}

class ZipWriter {
  constructor() {
    this.chunks = [];
    this.size = 0;
    this.entries = []; // { nameBuf, crc, size, offset }
  }
  push(buf) {
    this.chunks.push(buf);
    this.size += buf.length;
  }
  add(rel, abs) {
    const content = fs.readFileSync(abs);
    const nameBuf = Buffer.from(rel, "utf8");
    const crc = crc32(content);
    const offset = this.size;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed (2.0 — store)
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(0, 10); // dos time (固定)
    local.writeUInt16LE(0x21, 12); // dos date (1980-01-01, 固定)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    this.push(local);
    this.push(nameBuf);
    this.push(content);

    this.entries.push({ nameBuf, crc, size: content.length, offset });
  }
  finish() {
    const centralStart = this.size;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4); // version made by
      c.writeUInt16LE(20, 6); // version needed
      c.writeUInt16LE(0x0800, 8); // flags: UTF-8 names
      c.writeUInt16LE(0, 10); // method: store
      c.writeUInt16LE(0, 12);
      c.writeUInt16LE(0x21, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.size, 20);
      c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(e.nameBuf.length, 28);
      // extra/comment/disk/attrs 全 0
      c.writeUInt32LE(e.offset, 42);
      this.push(c);
      this.push(e.nameBuf);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.size - centralStart, 12);
    end.writeUInt32LE(centralStart, 16);
    this.push(end);
    return Buffer.concat(this.chunks);
  }
}

// ---------------------------------------------------------------- pack
function packPlugin(id) {
  const dir = path.join(PLUGINS_DIR, id);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "plugin.json"), "utf8"));
  if (manifest.id !== id) throw new Error(`${id}: plugin.json id 与目录名不一致 (${manifest.id})`);

  const includeDirs = ["dist", "server"].filter((d) => fs.existsSync(path.join(dir, d)));
  if (!fs.existsSync(path.join(dir, "dist", "index.html")))
    throw new Error(`${id}: dist/index.html 不存在 —— 先构建（node scripts/build-all.mjs 或在插件目录 npm run build）`);

  const files = [{ rel: "plugin.json", abs: path.join(dir, "plugin.json") }];
  for (const d of includeDirs) files.push(...collectFiles(path.join(dir, d), d));

  const zip = new ZipWriter();
  for (const f of files) zip.add(f.rel, f.abs);
  const buf = zip.finish();

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outName = `${id}-${manifest.version}.zip`;
  const outPath = path.join(OUT_DIR, outName);
  fs.writeFileSync(outPath, buf);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  console.log(JSON.stringify({ id, version: manifest.version, file: path.relative(ROOT, outPath).replace(/\\/g, "/"), sha256 }));
}

const args = process.argv.slice(2);
const ids = args.length
  ? args
  : fs.readdirSync(PLUGINS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
if (!ids.length) {
  console.error("plugins/ 下没有插件");
  process.exit(1);
}
for (const id of ids) packPlugin(id);
