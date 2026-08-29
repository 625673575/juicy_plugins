// 解析器自测：用 SPlayer parse.spec.ts 的样例思路 + 各格式最小样本
// 用法: node src/lib/parser/_selftest.mjs
import { parseLRC } from "./parseLRC.js";
import { parseQRC } from "./parseQRC.js";
import { parseYRC } from "./parseYRC.js";
import { parseKRC } from "./parseKRC.js";
import { parseLyric, detectFormat } from "./parse.js";
import { buildDownloadLyric } from "./serialize.js";

let failed = 0;
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) console.log("ok   ", label);
  else {
    failed++;
    console.log("FAIL ", label, "\n  got     :", a, "\n  expected:", b);
  }
};
const ok = (label, cond) => {
  if (cond) console.log("ok   ", label);
  else {
    failed++;
    console.log("FAIL ", label);
  }
};

// ---- LRC 多时间戳展开 ----
{
  const lines = parseLRC("[00:01.00][00:05.00]hello");
  eq("lrc expand count", lines.length, 2);
  eq("lrc times sorted", lines.map((l) => l.startTime), [1000, 5000]);
}

// ---- 翻译对齐（±300ms）----
{
  const main = parseLRC("[00:10.000]歌詞一行\n[00:20.000]次の行");
  parseLyric(
    {
      content: main ? "" : "", // 不走这个分支
    },
    undefined,
  );
}
{
  const lines = parseLyric(
    { content: "[00:10.000]任賢斉\n[00:20.000]伤心太平洋", translation: "[00:09.800]richie jen\n[00:20.100]sad pacific" },
    "lrc",
  );
  eq("trans paired", lines.map((l) => l.translatedLyric), ["richie jen", "sad pacific"]);
}

// ---- ESLRC 逐字 ----
{
  const lines = parseLyric({ content: "[00:00.00]<00:00.00>You<00:01.00>raise<00:02.00>me<00:03.00>up" }, "lrc");
  ok("eslrc detected as lrc format (single track)", lines.length >= 1);
  const words = lines[0]?.words ?? [];
  eq("eslrc word count", words.length, 4);
  eq("eslrc first word", [words[0]?.word, words[0]?.startTime], ["You", 0]);
  eq("eslrc last word end", words[words.length - 1]?.endTime > 3000 || words[words.length - 1]?.endTime === 4000, true);
}

// ---- YRC ----
{
  ok("detect yrc", detectFormat("[1000,500](1000,500,0)歌词") === "yrc");
  const lines = parseYRC("[4200,900](4200,300,0)天(4500,300,0)青(4800,300,0)色");
  eq("yrc line start/end", [lines[0].startTime, lines[0].endTime], [4200, 5100]);
  eq("yrc words", lines[0].words.map((w) => w.word), ["天", "青", "色"]);
  eq("yrc last word span", [lines[0].words[2].startTime, lines[0].words[2].endTime], [4800, 5100]);
}

// ---- QRC ----
{
  ok("detect qrc", detectFormat("[1000,500]歌词(1000,500)") === "qrc");
  const lines = parseQRC("[3000,1200]天空(3000,600)之城(3600,600)");
  eq("qrc words", lines[0].words.map((w) => w.word), ["天空", "之城"]);
  eq("qrc spans", lines[0].words.map((w) => [w.startTime, w.endTime]), [[3000, 3600], [3600, 4200]]);
}
// QRC 含普通括号文本（非时间标记）
{
  const lines = parseQRC("[1000,1500]笑(1000,700)忘书(1700,800)");
  eq("qrc paren in text", lines[0].words.map((w) => w.word), ["笑", "忘书"]);
}

// ---- KRC（已解密形态）----
{
  const krc =
    "[ti:test]\n[00:10.000]<0,200>晴天<200,300>下的<500,700>约定";
  const lines = parseKRC(krc);
  eq("krc skips meta", lines.length, 1);
  eq("krc line start (abs ms)", lines[0].startTime, 10000);
  eq("krc words", lines[0].words.map((w) => w.word), ["晴天", "下的", "约定"]);
  eq("krc word abs times", lines[0].words[2].startTime, 10500);
}

// ---- 背景行括号拆分（YRC 整行全角括号包裹；半角括号文本按设计不参与逐字正则）----
{
  const lines = parseYRC("[8000,2000](8000,1000,0)（和声啦）");
  ok("bg detected", lines[0].isBG === true && lines[0].words.map((w) => w.word).join("") === "和声啦");
}

// ---- 序列化 ----
{
  const lines = parseLyric(
    { content: "[1000,1600](1000,800,0)天(1800,800,0)青", translation: "[00:01.00]sky blue" },
    "yrc",
  );
  const elrc = buildDownloadLyric(lines, "enhanced-lrc");
  ok("enhanced-lrc has inline tags", /^<\d{2}:\d{2}\.\d{2}>/.test(elrc.split("\n")[0].slice(10)));
  ok("enhanced-lrc keeps translation", elrc.includes("[00:01.00]sky blue"));
  const lrc = buildDownloadLyric(lines, "lrc");
  ok("lrc joined per line", lrc.includes("天青"));
  const ttml = buildDownloadLyric(lines, "ttml");
  ok("ttml has <tt", ttml.includes("<tt xmlns="));
  ok("ttml spans timed", ttml.includes('begin="00:01.000"'));
}

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
