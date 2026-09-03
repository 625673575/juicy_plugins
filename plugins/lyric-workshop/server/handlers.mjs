/**
 * API 处理核心（平台无关的 HTTP 逻辑之外的全部业务）
 *
 * 三种挂法共用这一个实现，保证开发 / 预览 / 插件后端不分叉：
 *   1. vite dev / preview 中间件   —— server/middleware.mjs（同源 /api，无 CORS）
 *   2. 独立 node 后端（插件形态）—— server/server.mjs（127.0.0.1:<port>，带 CORS）
 *
 *   search  平台搜索        GET /api/search?platform=netease|qq|kugou&keyword=..&limit=..&page=..
 *   lyric   拉取歌词原文    GET /api/lyric?platform=..&id=..&mid=..&hash=..&name=..&durationMs=..
 *           返回 variants[]（各格式原始文本）+ translation + romaji + ttml(AMLL DB 覆盖)
 *   healthz 可用性探测      GET /api/healthz
 *   config  目标文件夹      GET /api/config；POST/PUT /api/config {targetDir}（持久化到 server/.settings.json）
 *   save    保存歌词文本    POST /api/save {filename, content, dir?}——WebView2 里 <a download>
 *           只会落进系统下载文件夹，写回音乐文件夹必须由后端完成
 *
 * 全部 Node 原生实现（crypto/zlib/fetch/fs），零第三方依赖。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { searchNetease, lyricNetease } from "./netease.mjs";
import { searchQQ, lyricQQ } from "./qqmusic.mjs";
import { searchKugou, lyricKugou } from "./kugou.mjs";
import { fetchTTML } from "./ttml.mjs";

// ---------------------------------------------------------------------------
// 目标文件夹持久化（server/.settings.json，随插件目录走）

// Settings live OUTSIDE the plugin folder: a plugin update replaces the
// whole directory (atomic swap), which would wipe a .settings.json stored
// next to the server. Legacy files are migrated on first read.
const CONFIG_DIR = process.env.APPDATA
  ? path.join(process.env.APPDATA, "JuicyPlayer", "Plugins")
  : path.join(os.homedir(), ".config", "JuicyPlayer");
const SETTINGS_FILE = path.join(CONFIG_DIR, "lyric-workshop.settings.json");
const LEGACY_SETTINGS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), ".settings.json");

let settingsCache = null;
function loadSettings() {
  if (settingsCache) return settingsCache;
  for (const file of [SETTINGS_FILE, LEGACY_SETTINGS_FILE]) {
    try {
      settingsCache = JSON.parse(fs.readFileSync(file, "utf8"));
      break;
    } catch {
      /* try next */
    }
  }
  settingsCache = settingsCache || {};
  // Persist at the new location immediately so the legacy copy (inside the
  // plugin dir, wiped by updates) is no longer the source of truth.
  saveSettings();
  return settingsCache;
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settingsCache, null, 2), "utf8");
  } catch {
    /* 设置写不进去不致命：仅影响“记住目标文件夹” */
  }
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** 读取并解析 JSON 请求体（限制大小，防误用） */
function readJsonBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// /api/config 目标文件夹

function handleConfigGet(res) {
  const s = loadSettings();
  sendJson(res, 200, { ok: true, targetDir: typeof s.targetDir === "string" ? s.targetDir : "" });
}

async function handleConfigSet(req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const dir = typeof body.targetDir === "string" ? body.targetDir.trim() : "";
  if (!dir) return sendJson(res, 400, { ok: false, error: "targetDir required" });
  if (!isDirectory(dir)) return sendJson(res, 400, { ok: false, error: `not a directory: ${dir}` });
  loadSettings().targetDir = dir;
  saveSettings();
  sendJson(res, 200, { ok: true, targetDir: dir });
}

// ---------------------------------------------------------------------------
// /api/save 把歌词文本写入本地文件夹
//
// 安全面：服务只绑 127.0.0.1，但 CORS 全开，任意网页都可能打到本端口。
// 因此这里只允许「纯文件名 + 歌词类扩展名 + 文本内容」，目录必须已存在，
// 把最坏情况限制为“往音乐文件夹写一个 .lrc 文本”。

const SAVE_EXTS = new Set(["lrc", "elrc", "ttml", "krc", "qrc", "yrc", "lys", "trc", "txt"]);

async function handleSave(req, res) {
  const body = await readJsonBody(req);
  const filename = typeof body.filename === "string" ? body.filename.trim() : "";
  const content = typeof body.content === "string" ? body.content : null;
  const dir = typeof body.dir === "string" ? body.dir.trim() : "";

  if (
    !filename ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename !== path.basename(filename)
  ) {
    return sendJson(res, 400, { ok: false, error: "filename must be a plain file name" });
  }
  const ext = path.extname(filename).slice(1).toLowerCase();
  if (!SAVE_EXTS.has(ext)) {
    return sendJson(res, 400, { ok: false, error: `extension .${ext || "?"} not allowed` });
  }
  if (content == null) return sendJson(res, 400, { ok: false, error: "content required" });

  const targetDir = dir || loadSettings().targetDir || "";
  if (!targetDir) {
    return sendJson(res, 400, { ok: false, error: "no target folder configured", code: "no-target" });
  }
  if (!isDirectory(targetDir)) {
    return sendJson(res, 400, { ok: false, error: `target folder not found: ${targetDir}` });
  }

  const target = path.join(targetDir, filename);
  fs.writeFileSync(target, content, "utf8");
  sendJson(res, 200, { ok: true, path: target });
}

/** 简单 TTL 缓存，避免重复打接口 */
const CACHE_TTL_MS = 2 * 60 * 1000;
const cache = new Map();
const cacheGet = (key) => {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expireAt) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
};
const cacheSet = (key, value) => cache.set(key, { value, expireAt: Date.now() + CACHE_TTL_MS });

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

async function handleSearch(query, res) {
  const platform = query.get("platform") || "netease";
  const keyword = (query.get("keyword") || "").trim();
  const limit = Math.min(Math.max(parseInt(query.get("limit") || "25", 10) || 25, 1), 50);
  const page = Math.max(parseInt(query.get("page") || "1", 10) || 1, 1);
  if (!keyword) return sendJson(res, 400, { ok: false, error: "keyword required" });

  const key = `search:${platform}:${keyword}:${limit}:${page}`;
  const cached = cacheGet(key);
  if (cached) return sendJson(res, 200, cached);

  const runners = { netease: searchNetease, qq: searchQQ, kugou: searchKugou };
  const run = runners[platform];
  if (!run) return sendJson(res, 400, { ok: false, error: `unknown platform ${platform}` });

  try {
    const { total, songs } = await run(keyword, limit, page);
    const payload = { ok: true, platform, total, songs };
    cacheSet(key, payload);
    sendJson(res, 200, payload);
  } catch (err) {
    sendJson(res, 502, { ok: false, error: err?.message || String(err) });
  }
}

async function handleLyric(query, res) {
  const platform = query.get("platform") || "netease";
  const id = (query.get("id") || "").trim();
  if (!id) return sendJson(res, 400, { ok: false, error: "id required" });

  const song = {
    id,
    mid: (query.get("mid") || "").trim(),
    hash: (query.get("hash") || "").trim(),
    name: (query.get("name") || "").trim(),
    artist: (query.get("artist") || "").trim(),
    album: (query.get("album") || "").trim(),
    durationMs: parseInt(query.get("durationMs") || "0", 10) || 0,
  };

  // key 不含 artist/album——两者只是 QQ 匹配的辅助参数
  const key = `lyric:${platform}:${id}:${song.mid}:${song.hash}:${song.name}`;
  const cached = cacheGet(key);
  if (cached) return sendJson(res, 200, cached);

  try {
    let result;
    if (platform === "netease") result = await lyricNetease(id);
    else if (platform === "qq") result = await lyricQQ(song);
    else if (platform === "kugou") result = await lyricKugou(song);
    else return sendJson(res, 400, { ok: false, error: `unknown platform ${platform}` });

    if (!result || !result.variants?.length) {
      const miss = { ok: true, platform, song, data: null };
      cacheSet(key, miss);
      return sendJson(res, 200, miss);
    }

    // AMLL TTML DB 覆盖源：网易按数字 id，QQ 按 mid 与数字 id
    let ttml = null;
    try {
      ttml =
        platform === "netease"
          ? await fetchTTML("netease", [id])
          : await fetchTTML("qqmusic", [song.mid, id]);
    } catch {
      /* TTML 失败不影响主歌词 */
    }

    const payload = {
      ok: true,
      platform,
      song,
      data: {
        variants: result.variants,
        translation: result.translation || "",
        romaji: result.romaji || "",
        ttml: ttml || "",
      },
    };
    cacheSet(key, payload);
    sendJson(res, 200, payload);
  } catch (err) {
    sendJson(res, 502, { ok: false, error: err?.message || String(err) });
  }
}

/**
 * 处理一条 /api/* 请求。
 * @returns {Promise<boolean>} 命中 API 路由返回 true（调用方不得再往下处理）；
 *          非 /api/* 返回 false（vite 中间件继续 next()）。
 */
export async function handleApiRequest(req, res, { cors = false } = {}) {
  const url = new URL(req.url || "/", "http://localhost");
  if (!url.pathname.startsWith("/api/")) return false;

  if (cors) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return true;
    }
  }

  try {
    if (url.pathname === "/api/healthz") {
      sendJson(res, 200, { ok: true, ts: Date.now() });
      return true;
    }
    if (url.pathname === "/api/search") return (await handleSearch(url.searchParams, res), true);
    if (url.pathname === "/api/lyric") return (await handleLyric(url.searchParams, res), true);
    if (url.pathname === "/api/config") {
      if (req.method === "GET") return (handleConfigGet(res), true);
      if (req.method === "POST" || req.method === "PUT") {
        return (await handleConfigSet(req, res), true);
      }
    }
    if (url.pathname === "/api/save" && req.method === "POST") {
      return (await handleSave(req, res), true);
    }
    sendJson(res, 404, { ok: false, error: `no route ${url.pathname}` });
    return true;
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err?.message || String(err) });
    return true;
  }
}
