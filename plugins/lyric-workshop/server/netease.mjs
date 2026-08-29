/**
 * 网易云音乐接口（移植自 SPlayer-Next electron/main/apis/netease）
 *
 * 实测结论：weapi 通道（music.163.com）在本网络环境下返回 404/风控码，
 * eapi 通道（interface.music.163.com）匿名即可用——搜索 cloudsearch/pc、歌词 song/lyric/v1
 * 都返回 code=200。故这里只走 eapi。
 */

import { createCipheriv, createHash, randomBytes } from "node:crypto";

const EAPI_KEY = "e82ckenh8dichen8";
const API_DOMAIN = "https://interface.music.163.com";
const UA_ANDROID =
  "NeteaseMusic/9.1.65.240927161425(9001065);Dalvik/2.1.0 (Linux; U; Android 14; 23013RK75C Build/UKQ1.230804.001)";
const TIMEOUT_MS = 10000;

/** eapi 加密：url+明文+md5 拼串后 AES-ECB(hex 大写) */
const eapi = (uri, object) => {
  const text = JSON.stringify(object);
  const digest = createHash("md5")
    .update(`nobody${uri}use${text}md5forencrypt`)
    .digest("hex");
  const data = `${uri}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(EAPI_KEY, "utf8"), Buffer.alloc(0));
  const params = Buffer.concat([cipher.update(Buffer.from(data, "utf8")), cipher.final()])
    .toString("hex")
    .toUpperCase();
  return { params };
};

/** 设备 cookie：进程内固定一套随机值，避免每次请求变化 */
const DEVICE_COOKIE = (() => {
  const nuid = randomBytes(8).toString("hex");
  return [
    `__remember_me=true`,
    `_ntes_nuid=${nuid}`,
    `_ntes_nnid=${nuid},${Date.now()}`,
    `WEVNSM=1.0.0`,
    `os=android`,
    `osver=14`,
    `channel=xiaomi`,
    `appver=9.1.65`,
    `deviceId=${randomBytes(16).toString("hex")}`,
  ].join("; ");
})();

/** 发送一次 eapi 调用，code !== 200 抛错 */
async function callEapi(uri, data) {
  const res = await fetch(`${API_DOMAIN}/eapi${uri.slice(4)}`, {
    method: "POST",
    headers: {
      Cookie: DEVICE_COOKIE,
      Referer: API_DOMAIN,
      "User-Agent": UA_ANDROID,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(eapi(uri, { ...data, e_r: false })).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`netease HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== undefined && Number(json.code) !== 200) {
    throw new Error(`netease code ${json.code}`);
  }
  return json;
}

/** 云搜（type=1 单曲），offset 按 page-1 折算 */
export async function searchNetease(keyword, limit = 25, page = 1) {
  const body = await callEapi("/api/cloudsearch/pc", {
    s: keyword,
    type: 1,
    limit,
    offset: (page - 1) * limit,
    total: true,
  });
  const songs = (body.result?.songs ?? []).map((song) => ({
    id: String(song.id ?? ""),
    mid: "",
    hash: "",
    name: song.name ?? "",
    artist: (song.ar ?? song.artists ?? []).map((a) => a.name).join(" / "),
    album: song.album?.name ?? song.al?.name ?? "",
    durationMs: song.duration ?? song.dt ?? 0,
  }));
  return { total: body.result?.songCount ?? songs.length, songs };
}

/**
 * eapi 新版返回会把部分行包成 JSON：{"t":ms,"c":[{"tx":".."},..]}
 * - 对 lrc/翻译/罗马音：转换成标准 [mm:ss.xxx]text 行
 * - 对 yrc：正文行本来就是原生 [start,dur](start,dur,0)字 格式，
 *   JSON 行都是「作词/作曲」类元数据（无逐字时长），直接丢弃避免污染解析
 */
const fmtLrcStamp = (ms) => {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const x = Math.floor(ms % 1000);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(x).padStart(3, "0")}`;
};

const cleanNeteaseLyric = (text, { dropJsonLines }) => {
  if (!text) return "";
  const outLines = [];
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.includes('"c"')) {
      if (dropJsonLines) continue;
      try {
        const obj = JSON.parse(trimmed);
        const txt = (obj.c ?? []).map((item) => item.tx ?? "").join("").trim();
        if (!txt) continue;
        outLines.push(`[${fmtLrcStamp(obj.t ?? 0)}]${txt}`);
      } catch {
        /* 解析失败丢弃该行 */
      }
      continue;
    }
    outLines.push(line);
  }
  return outLines.join("\n");
};

/** 歌词：yrc > lrc；翻译 ytlrc > tlyric；罗马音 yromalrc > romalrc */
export async function lyricNetease(id) {
  const body = await callEapi("/api/song/lyric/v1", {
    id,
    cp: false,
    tv: 0,
    lv: 0,
    rv: 0,
    kv: 0,
    yv: 0,
    ytv: 0,
    yrv: 0,
  });
  const pick = (...pairs) => {
    for (const value of pairs) {
      if (value?.lyric?.trim()) return value.lyric;
    }
    return "";
  };
  const yrcRaw = body.yrc?.lyric?.trim() ? cleanNeteaseLyric(body.yrc.lyric, { dropJsonLines: true }).trim() : "";
  const lrcRaw = body.lrc?.lyric?.trim()
    ? cleanNeteaseLyric(body.lrc.lyric, { dropJsonLines: false }).trim()
    : "";

  const variants = [];
  if (yrcRaw) variants.push({ format: "yrc", content: yrcRaw });
  if (lrcRaw) variants.push({ format: "lrc", content: lrcRaw });
  if (variants.length === 0) return null;

  return {
    variants,
    translation: cleanNeteaseLyric(pick(body.ytlrc, body.tlyric), { dropJsonLines: false }),
    romaji: cleanNeteaseLyric(pick(body.yromalrc, body.romalrc), { dropJsonLines: false }),
  };
}
