/**
 * 酷狗接口（移植自 SPlayer-Next electron/main/apis/kugou）
 *
 * - 搜索：mobilecdn /api/v3/search/song（公开）
 * - 歌词：两步 lyrics.kugou.com search → download（伪装 KuGou2012 PC 客户端 headers）
 *    - fmt=krc：base64 → 去头 4 字节 → 16 字节 key 循环 XOR → inflate
 *      内嵌 [language:base64(json)] 翻译/罗马音，按行序补时间戳输出
 */

import { inflate } from "node:zlib";
import { promisify } from "node:util";

const inflateAsync = promisify(inflate);

const KG_MOBILECDN_URL = "http://mobilecdn.kugou.com/api/v3/search/song";
const KG_SEARCH_FALLBACK_URL = "https://songsearch.kugou.com/song_search_v2";
const KG_LYRIC_SEARCH_URL = "http://lyrics.kugou.com/search";
const KG_LYRIC_DOWNLOAD_URL = "http://lyrics.kugou.com/download";
const TIMEOUT_MS = 10000;

const KG_LYRIC_HEADERS = {
  "KG-RC": "1",
  "KG-THash": "expand_search_manager.cpp:852736169:451",
  "User-Agent": "KuGou2012-9020-ExpandSearchManager",
};

const ENTITY_MAP = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#039;": "'",
};
const decodeName = (str) =>
  str ? str.replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&apos;|&#039;/g, (s) => ENTITY_MAP[s] ?? s) : "";

export async function searchKugou(keyword, limit = 25, page = 1) {
  const fetchJson = async (url) => {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.json();
  };
  let body;
  try {
    const url = `${KG_MOBILECDN_URL}?format=json&keyword=${encodeURIComponent(keyword)}&page=${page}&pagesize=${limit}`;
    body = await fetchJson(url);
  } catch {
    const url = `${KG_SEARCH_FALLBACK_URL}?keyword=${encodeURIComponent(keyword)}&page=${page}&pagesize=${limit}`;
    body = await fetchJson(url);
  }
  if (body.status !== 1 && body.error_code !== 0) throw new Error(`KG search status ${body.status}`);
  const info = body.data?.info ?? body.data?.lists ?? [];
  const songs = info.map((song) => ({
    id: String(song.AudioId ?? song.Audioid ?? song.album_id ?? ""),
    mid: "",
    hash: song.hash ?? song.FileHash ?? "",
    name: decodeName(song.songname ?? song.SongName ?? ""),
    artist: decodeName(song.singername ?? ""),
    album: decodeName(song.album_name ?? song.AlbumName ?? ""),
    durationMs: (song.duration ?? song.Duration ?? 0) * 1000,
  }));
  return { total: body.data?.total ?? songs.length, songs };
}

const KRC_KEY = Uint8Array.from([
  0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69,
]);

/** base64 → 去头 4 字节 → XOR → inflate */
async function decryptKrc(base64) {
  if (!base64) throw new Error("empty krc content");
  const buf = Buffer.from(base64, "base64").subarray(4);
  for (let i = 0; i < buf.length; i++) buf[i] ^= KRC_KEY[i % 16];
  return (await inflateAsync(buf)).toString("utf8");
}

const HEAD_ID_REG = /^.*\[id:\$\w+\]\n/;
const LANGUAGE_REG = /\[language:([\w=\\/+]+)\]/;
const LANGUAGE_LINE_REG = /\[language:[\w=\\/+]+\]\n/;
const LINE_TIME_REG = /\[((\d+),\d+)\].*/g;
const LINE_TIME_EACH_REG = /\[((\d+),\d+)\].*/;

const msToTimeTag = (ms) => {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const x = Math.floor(ms % 1000);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${x}`;
};

/** 解密后的 KRC 文本 → { krc, lrc, trans, roma } 四种文本 */
function parseKrcText(raw) {
  let text = raw.replace(/\r/g, "");
  if (HEAD_ID_REG.test(text)) text = text.replace(HEAD_ID_REG, "");

  let transLines;
  let romaLines;
  const langMatch = text.match(LANGUAGE_REG);
  if (langMatch) {
    text = text.replace(LANGUAGE_LINE_REG, "");
    try {
      const json = JSON.parse(Buffer.from(langMatch[1], "base64").toString("utf8"));
      for (const item of json.content ?? []) {
        const lines = item.lyricContent.map((arr) => arr.join(""));
        if (item.type === 0) romaLines = lines;
        else if (item.type === 1) transLines = lines;
      }
    } catch {
      /* 译文解析失败不影响主歌词 */
    }
  }

  let idx = 0;
  // 行首 [start,dur] → [MM:SS.xxx]，并同步给翻译/罗马音行补时间头
  let krcBody = text.replace(LINE_TIME_REG, (line) => {
    const match = line.match(LINE_TIME_EACH_REG);
    if (!match) return line;
    const startMs = parseInt(match[2], 10);
    const timeTag = msToTimeTag(startMs);
    if (romaLines && romaLines[idx] !== undefined) romaLines[idx] = `[${timeTag}]${romaLines[idx]}`;
    if (transLines && transLines[idx] !== undefined)
      transLines[idx] = `[${timeTag}]${transLines[idx]}`;
    idx++;
    return line.replace(match[1], timeTag);
  });

  // 字级 <offset,dur,0> → <offset,dur>
  krcBody = krcBody.replace(/<(\d+,\d+),\d+>/g, "<$1>");
  const krc = decodeName(krcBody);
  const lrc = krc.replace(/<\d+,\d+>/g, "");

  return {
    lrc,
    krc,
    trans: transLines ? transLines.join("\n") : "",
    roma: romaLines ? romaLines.join("\n") : "",
  };
}

/**
 * 歌词。酷狗硬要求 hash + name + duration(秒) 三者齐全。
 * 返回 variants（krc 优先，附 lrc）。
 */
export async function lyricKugou(song) {
  const { hash, name = "", durationMs = 0 } = song;
  if (!hash) throw new Error("kugou 需要 hash");
  const seconds = Math.round(durationMs / 1000);

  const searchUrl =
    `${KG_LYRIC_SEARCH_URL}?ver=1&man=yes&client=pc&lrctxt=1` +
    `&keyword=${encodeURIComponent(name)}` +
    `&hash=${encodeURIComponent(hash)}` +
    `&timelength=${seconds}`;
  const searchRes = await (
    await fetch(searchUrl, { headers: KG_LYRIC_HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) })
  ).json();

  const candidate = searchRes.candidates?.[0];
  if (!candidate) return null;

  const fmt = candidate.krctype === 1 && candidate.contenttype !== 1 ? "krc" : "lrc";
  const downloadUrl =
    `${KG_LYRIC_DOWNLOAD_URL}?ver=1&client=pc&charset=utf8` +
    `&id=${encodeURIComponent(candidate.id)}` +
    `&accesskey=${encodeURIComponent(candidate.accesskey)}` +
    `&fmt=${fmt}`;
  const dl = await (
    await fetch(downloadUrl, { headers: KG_LYRIC_HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) })
  ).json();
  if (!dl.content) return null;

  if (dl.fmt === "krc") {
    const parsed = parseKrcText(await decryptKrc(dl.content));
    const variants = [];
    if (parsed.krc.trim()) variants.push({ format: "krc", content: parsed.krc });
    if (parsed.lrc.trim()) variants.push({ format: "lrc", content: parsed.lrc });
    if (variants.length === 0) return null;
    return { variants, translation: parsed.trans, romaji: parsed.roma };
  }
  if (dl.fmt === "lrc") {
    const content = Buffer.from(dl.content, "base64").toString("utf8");
    return { variants: [{ format: "lrc", content }], translation: "", romaji: "" };
  }
  throw new Error(`unknown lyric fmt ${dl.fmt}`);
}
