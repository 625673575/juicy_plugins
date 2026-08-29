# JuicyPlayer 插件 ↔ 宿主数据接口参考

插件页面运行在宿主创建的 WebView 窗口（`ToolWindow`，JUCE `WebBrowserComponent` + WebView2）里。按需求选通道：

| 通道 | 适用 | 说明 |
|---|---|---|
| **1. Native bridge + Resource provider** | 读写本地数据（曲库快照、音频文件、保存产物） | 无端口、无跨域；宿主注册的 native 函数与虚拟主机路由 |
| **2. Node backend** | 需要 CORS 代理 / 加解密 / 其他本地服务 | `plugin.json` 声明，宿主用内置 Node 拉起，端口注入页面 |
| **3. HTTP API `http://127.0.0.1:8080/api/v1`** | 曲库 / 播放 / 队列 / 歌词 / DSP | 宿主常驻 HTTP 服务，CORS 全开无鉴权，页面直接 `fetch` |

---

## 通道 1：Native bridge + Resource provider

工具窗口在虚拟主机根（Windows 上 `https://juce.backend/`）加载 `dist/index.html`，页面内的相对路径 `fetch` 与静态资源都由宿主 resource provider 服务；双向调用走 JUCE 注入的 `window.__JUCE__` 桥。

### 宿主为所有插件注册的 native 函数

```js
// 页面就绪信号（宿主仅 ack）
window.__JUCE__.backend.emitEvent('__juce__invoke', { name: 'pageReady', params: [] });

// 宿主日志：params = [level, message]
// 'toolLog' params: ['info', 'hello']

// 代抓外网页面（webview 直连受 CORS 限制时用）：
// params = [url]，仅 http/https；返回 {ok, status, contentType, body}
// body 截断 256KB；页面按内容自行嗅探
// 'toolFetchUrl' params: ['https://example.com/page']
```

经 `__juce__invoke` / `__juce__complete` 事件对调用，参考 `demucs-gui/src/lib/juce-bridge.js` 的封装方式。

### 参考实现：Demucs 的 bridge 契约

内置 Demucs 工具通过同一机制访问宿主数据（插件可按此模式与宿主协作，但 `demucs*` 函数为内置专用，插件不应直接调用；需要新 bridge 函数请提宿主侧 PR）：

| 函数 | 参数 | 返回 |
|---|---|---|
| `demucsGetLibrary` | — | `{folders:[绝对路径], tracks:[{path,title,artist,album,folder,dir,duration}]}` |
| `demucsGetPreselected` | — | `{path}`（当前播放曲） |
| `demucsSplitAudio` | path, chunkSeconds | `{dir, chunks[], sampleRate, channels, totalSamples, durationSec}`（C++ 切 30s WAV 块） |
| `demucsSaveBegin/Append/Finish/FinishWav/Abort` | 分块写盘令牌流 | `{token,target}` / `{ok}` / `{ok,path}` |

其音频读取走 resource provider 路由：`GET /audio/<base64url(绝对路径)>` 返回文件字节（URL-safe base64 无 padding，兼容空格/CJK；整文件返回，不支持 Range）。

> 插件如需访问音频文件，推荐直接用通道 3 的 `/api/v1/stream/{trackId}`（支持 Range、走曲库），无需宿主改动。

---

## 通道 2：Node backend

`plugin.json` 声明：

```json
{ "backend": { "type": "node", "entry": "server/server.mjs" } }
```

宿主行为（打开工具窗口时）：

1. 在本机找空闲端口，用**内置 Node** 启动 `node <toolsRoot>/<id>/server/server.mjs --port <port>`
2. 后端必须**只绑 `127.0.0.1`**；就绪后 stdout 打一行 `READY <port>`（可选，宿主以 `GET /api/healthz` 轮询为准）
3. 服务 `index.html` 时注入 `<script>window.__JUICY_API_PORT__=<port>;</script>`
4. 工具窗口关闭时结束进程

页面侧约定：

```js
const API_BASE = window.__JUICY_API_PORT__ ? `http://127.0.0.1:${window.__JUICY_API_PORT__}` : '';
fetch(`${API_BASE}/api/whatever`); // 后端需返回 CORS 头（Access-Control-Allow-Origin: *）
```

完整参考实现：`plugins/lyric-workshop`（`server/server.mjs` 独立入口 + `server/handlers.mjs` 与 vite dev 中间件共用业务）。安全约束：宿主不接受任意命令行，只接受 `type:"node"` + 插件目录内相对入口。

---

## 通道 3：HTTP API（`/api/v1` 全集）

- Base：`http://127.0.0.1:<httpPort>/api/v1`，默认端口 **8080**（设置项 `httpPort`，可被关闭）
- CORS：`Access-Control-Allow-Origin: *`，methods `GET, POST, PUT, DELETE, OPTIONS`；**无鉴权**（仅限本机/LAN 信任环境使用）
- 统一响应包：成功 `{"status":"ok","version":"1.0.0","data":<...>,"pagination":{...}}`；失败 `{"status":"error","code":<http码>,"message":"..."}`
- trackId = 曲目绝对路径 `hashCode64()` 的十六进制字符串；track JSON 含 `id,title,artist,album,duration,filePath,coverArtPath,...`
- 分页 query 通用：`limit`（默认 50，1..500）+ `offset`
- 发现：mDNS `_juicyplayer._tcp`（TXT: httpPort）

### System
| Method + Path | 说明 |
|---|---|
| GET `/api/v1/system/info` | 宿主信息 `{name,version,platform,httpPort,features}` |
| GET `/api/v1/system/ping` | `{time}` |
| GET `/api/v1/system/scan` | `{totalTracks,totalAlbums,totalArtists,scanning}` |

### Library
| Method + Path | 说明 |
|---|---|
| GET `/api/v1/library/tracks` | 全曲库 track[]（分页） |
| GET `/api/v1/library/tracks/{id}` | 单曲详情 |
| GET `/api/v1/library/tracks/{id}/lyrics` | `{trackId,hasLyrics,synced,content}`（LRC 原文） |
| GET `/api/v1/library/artists` / `artists/{id}` / `artists/{id}/albums` | 艺术家（分页） |
| GET `/api/v1/library/albums` / `albums/{id}` / `albums/{id}/tracks` | 专辑（分页；`albums/{id}` 内嵌 tracks） |
| GET `/api/v1/library/genres` / `genres/{name}/tracks` | 流派 |
| GET `/api/v1/library/stats` | `{totalTracks,totalAlbums,totalArtists,totalGenres,totalDuration,totalPlays}` |
| GET `/api/v1/library/recently-added?limit=` / `most-played?limit=` / `favorites` | 快捷列表 |
| GET `/api/v1/library/videos` | 视频曲目 |
| GET `/api/v1/search?q=&limit=` | `{tracks[],artists[],albums[]}` |
| GET `/api/v1/search/suggestions?q=&limit=` | `{type,id,name}[]` |

### Artwork / 音频流
| Method + Path | 说明 |
|---|---|
| GET `/api/v1/artwork/track/{id}`（亦 `album/{id}`、`artist/{id}`） | JPEG 封面（宿主 LRU 缓存） |
| GET `/api/v1/stream/{trackId}` | 原格式音频流；**支持 Range（206）**；`?download=1` 加下载头 |
| GET `/api/v1/download/{trackId}` | attachment 下载（CJK 文件名安全） |

### Player
| Method + Path | 说明 |
|---|---|
| GET `/api/v1/player/nowplaying` | `{track?,position,duration,isPlaying,volume,repeatMode,sampleRate,...}` |
| WS `/api/v1/player/nowplaying/ws` | 状态变更推送（连上先推快照） |
| GET `/api/v1/player/queue` | `{currentIndex,tracks[]}`（分页） |
| POST `/api/v1/player/queue/add` | `{"trackId"|"trackIds":[], "position":-1追加|-2下一首|>=0绝对}` |
| POST `/api/v1/player/queue/play` / `remove` / `move` / `clear` | `{"index"}` / `{"from","to"}` |
| POST `/api/v1/player/play|pause|toggle|stop|next|previous|rewind|forward` | `{}` |
| POST `/api/v1/player/seek` | `{"position":秒}` |
| POST `/api/v1/player/volume` | `{"volume":0.0-1.0}`；POST `/mute` 切换 |
| POST `/api/v1/player/playTrack` | `{"trackId"}` 立即播放 |
| POST `/api/v1/player/playTracks` | `{"trackIds":[],"shuffle":false,"startIndex"?}` |
| POST `/api/v1/player/playAlbum|playArtist|playPlaylist` | `{"albumId"|...,"shuffle"?}` |
| GET `/api/v1/player/lyrics[?full=1]` | `{hasLyrics,isSynced,activeIndex,lines:[{index,time,text}]}` |
| GET `/api/v1/player/favorite` / POST `/favorite/toggle` | `{isFavorite,trackId?}` |
| GET `/api/v1/player/history` | 播放历史 `{title,artist,trackId,playedAt}[]` |
| POST `/api/v1/player/mode` | `{"mode":0|1|2|"cycle"}` |

### Playlists
| Method + Path | 说明 |
|---|---|
| GET `/api/v1/playlists` / `playlists/{id}` | 列表（`{id}` 内嵌 tracks） |
| POST `/api/v1/playlists` | `{"name"}` 建列表 |
| DELETE `/api/v1/playlists/{id}` | 删除 |
| POST `/api/v1/playlists/{id}/tracks` | `{"trackIds":[]}` 追加 |
| DELETE `/api/v1/playlists/{id}/tracks/{index}` | 移除 |

### DSP
| Method + Path | 说明 |
|---|---|
| GET `/api/v1/dsp/status` | `{effects:[{name,enabled}],plugins:[{index,name,identifier,enabled}]}` |
| GET `/api/v1/dsp/schema` | 效果参数 schema |
| GET/PUT `/api/v1/dsp/{effect}/params` | 读写参数 |
| PUT `/api/v1/dsp/{effect}/param/{name}` | `{"value"}` |
| PUT `/api/v1/dsp/{effect}/bypass` / `plugins/{index}/bypass` | `{"bypassed":bool}` |
| POST `/api/v1/dsp/{effect}/preset/{index}` / `reset` | 预设/复位 |

### 快速自检

```js
const base = 'http://127.0.0.1:8080/api/v1';
const lib = await fetch(`${base}/library/stats`).then(r => r.json());
if (lib.status === 'ok') console.log('曲库曲目数:', lib.data.totalTracks);
```
