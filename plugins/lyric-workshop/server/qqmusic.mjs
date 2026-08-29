/**
 * QQ 音乐接口（移植自 SPlayer-Next electron/main/apis/qqmusic）
 *
 * - 搜索：公开 CGI client_search_cp（c.y.qq.com），无需鉴权
 * - 歌词：musicu.fcg GetPlayLyricInfo，返回 hex 密文
 *    → Triple DES（LDDC 实现，ECB / 不去填充）解密
 *    → 文本可能是两种形态：
 *        a) 直接就是 QRC/LRC 明文（老版本服务端）
 *        b) XML 包裹，LyricContent="hex" 里是 zlib 压缩的 QRC/LRC（新版本）→ 需第二段 hex+inflate
 */

import { inflateRawSync, inflateSync, unzipSync } from "node:zlib";
import { qrcDecrypt } from "./tripledes.mjs";

const QM_API_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg";
const SEARCH_URL = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp";
const TIMEOUT_MS = 10000;

const QM_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "okhttp/3.14.9",
  Referer: "https://y.qq.com",
  Cookie: "tmeLoginType=-1;",
};

/** comm 字段：伪装 Android 客户端 */
export const commonParams = () => ({
  ct: 11,
  cv: "1003006",
  v: "1003006",
  os_ver: "15",
  phonetype: "24122RKC7C",
  tmeAppID: "qqmusiclight",
  nettype: "NETWORK_WIFI",
  udid: "0",
  OpenUDID: "0",
  QIMEI36: "0",
  uin: "0",
});

const b64 = (text) => Buffer.from(String(text ?? ""), "utf8").toString("base64");

async function postFcg(module, method, param) {
  const res = await fetch(QM_API_URL, {
    method: "POST",
    headers: QM_HEADERS,
    body: JSON.stringify({ comm: commonParams(), request: { module, method, param } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json();
  if ((json.code ?? 0) !== 0 || (json.request?.code ?? 0) !== 0) {
    throw new Error(`QM outer=${json.code} inner=${json.request?.code}`);
  }
  return json.request.data;
}

const QRC_KEY = Buffer.from("!@#)(*$%123ZXC!@!@#)(NHL", "utf8");

function tryInflate(buf) {
  for (const fn of [inflateSync, inflateRawSync, unzipSync]) {
    try {
      return fn(buf).toString("utf8");
    } catch {
      /* 下一种 */
    }
  }
  return null;
}

/**
 * 解密一段 QRC 密文（hex）。
 * 先 3DES 得到文本；若是 XML 包裹则再抽 LyricContent 的 hex 做 zlib inflate；
 * 若直接是压缩二进制（3DES 输出非文本）则先尝试 inflate。
 */
function decryptQrc(hex) {
  if (!hex || !hex.trim()) throw new Error("empty qrc payload");
  const encrypted = Buffer.from(hex, "hex");
  // 关键：不去填充。输出是后续要 inflate 的二进制或 XML 明文
  const decrypted = Buffer.from(qrcDecrypt(new Uint8Array(encrypted), new Uint8Array(QRC_KEY)));
  const text = decrypted.toString("utf8");

  if (text.startsWith("<") || /\bLyricContent=/.test(text.slice(0, 200))) {
    // 形态 b：XML 包裹，内容在 LyricContent 属性里（greedy 到末尾引号）
    const m =
      text.match(/LyricContent="([\s\S]*)"\s*\/?>/) ||
      text.match(/LyricContent="([^"]*)"/) ||
      text.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
    if (m && m[1]) {
      const inner = tryInflate(Buffer.from(m[1], "hex"));
      if (inner) return inner;
      return m[1];
    }
    if (text.includes("[") ) return text;
    throw new Error("qrc xml 无可解内容");
  }

  // 形态 a：3DES 输出即压缩流，先试 inflate；失败当明文
  const inflated = tryInflate(decrypted);
  if (inflated) return inflated;
  if (text.includes("[") || text.includes("<")) return text;
  throw new Error("qrc 无法解压");
}

/** 单曲搜索 */
export async function searchQQ(keyword, limit = 25, page = 1) {
  const url = new URL(SEARCH_URL);
  url.search = new URLSearchParams({
    format: "json",
    n: String(limit),
    p: String(page),
    w: keyword,
    cr: "1",
    g_tk: "5381",
    t: "0",
  }).toString();
  const res = await fetch(url, { headers: QM_HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.json();
  if (body.code !== 0) throw new Error(`QM search code ${body.code}`);
  const list = body.data?.song?.list ?? [];
  const songs = list.map((song) => ({
    id: String(song.songid ?? ""),
    mid: song.songmid ?? "",
    hash: "",
    name: song.songname ?? "",
    artist: (song.singer ?? []).map((s) => s.name).filter(Boolean).join(" / "),
    album: song.albumname ?? "",
    durationMs: (song.interval ?? 0) * 1000,
  }));
  return { total: body.data?.song?.totalnum ?? songs.length, songs };
}

/**
 * 歌词。第一次请求 qrc:1 拿逐字；若没有 LRC 再用 qrc:0 补一次行级版本。
 * 翻译 trans 是 LRC 行级；罗马音 roma 与主请求同形态（QRC 时是逐字）。
 */
export async function lyricQQ(song) {
  const { id, name = "", artist = "", album = "", durationMs = 0 } = song;
  const baseParam = {
    albumName: b64(album),
    crypt: 1,
    ct: 19,
    cv: 2111,
    interval: Math.round(durationMs / 1000),
    lrc_t: 0,
    qrc: 1,
    qrc_t: 0,
    roma: 1,
    roma_t: 0,
    singerName: b64(artist),
    songID: Number(id),
    songName: b64(name),
    trans: 1,
    trans_t: 0,
    type: 0,
  };

  const dec = (hex) => {
    try {
      return decryptQrc(hex);
    } catch {
      return "";
    }
  };

  const resp = await postFcg(
    "music.musichallSong.PlayLyricInfo",
    "GetPlayLyricInfo",
    baseParam,
  );
  if (resp.code !== undefined && resp.code !== 200) throw new Error(`QM lyric code ${resp.code}`);

  const variants = [];
  const mainText = dec(resp.lyric);
  const isPlainLrcMain = resp.qrc_t === 0;
  if (mainText.trim()) variants.push(isPlainLrcMain ? { format: "lrc", content: mainText } : { format: "qrc", content: mainText });

  // 只有 QRC 时补一次 LRC 行级请求（同时拿它的翻译/罗马音兜底）
  let altResp = null;
  if (!isPlainLrcMain && mainText.trim()) {
    try {
      altResp = await postFcg("music.musichallSong.PlayLyricInfo", "GetPlayLyricInfo", {
        ...baseParam,
        qrc: 0,
        qrc_t: 0,
      });
      const altText = dec(altResp.lyric);
      if (altText.trim()) variants.push({ format: "lrc", content: altText });
    } catch {
      /* 补拉失败不影响主结果 */
    }
  }

  if (variants.length === 0) return null;

  const translation = dec(resp.trans) || (altResp ? dec(altResp.trans) : "");
  const romaji = dec(resp.roma) || (altResp ? dec(altResp.roma) : "");

  return { variants, translation, romaji };
}
