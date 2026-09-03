// JuicyPlayer WebView 共用原生桥（workspace 包，各 gui 经 npm workspaces 引用）。
//
// 协议与 JUCE 官方前端模块（juce_gui_extra/native/javascript/index.js）一致：
// C++ 宿主开启 native integration 后注入 window.__JUCE__.backend；页面用
// emitEvent('__juce__invoke', {name, params, resultId}) 调用 withNativeFunction
// 注册的原生函数，结果经 '__juce__complete' 事件按 resultId 回配。
//
// 离线（纯浏览器 / vite dev）时 backend 不存在：waitForNative() 超时返回
// false，callNative() reject，页面自行降级（文件选择器 / 下载 / mock）。
//
// 注意：llm-gui 的 callNativeRpc 走的是另一条自定义回包通道
// （requestId 首参 + window.__llmRpcResult 回调，由 AIChatWindow 驱动），
// 不在本包范围；本包的 callNative 对应 C++ 端 complete(var) 的标准回包。

const pending = new Map();
let nextResultId = 1;
let listenerInstalled = false;

export function backendReady() {
  return (
    typeof window !== 'undefined' &&
    typeof window.__JUCE__ !== 'undefined' &&
    !!window.__JUCE__.backend
  );
}

function installListenerOnce() {
  if (listenerInstalled || !backendReady()) return;
  window.__JUCE__.backend.addEventListener('__juce__complete', ({ promiseId, result }) => {
    const resolve = pending.get(promiseId);
    if (resolve) {
      pending.delete(promiseId);
      resolve(result);
    }
  });
  listenerInstalled = true;
}

// 轮询直到 backend 出现（resolve true），或超时（resolve false）。
export function waitForNative(timeoutMs = 8000) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const check = () => {
      if (backendReady()) {
        installListenerOnce();
        resolve(true);
        return;
      }
      if (performance.now() - t0 > timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

// 永不超时的就绪等待:backend 出现即回调一次。各 gui 页面桥的 init()
// 轮询就是这个语义(慢冷启动不误判离线)——waitForNative 是给"探测性"
// 场景(可选宿主,超时即降级)用的,别拿它做页面初始化。
export function onNativeReady(cb) {
  const check = () => {
    if (backendReady()) {
      installListenerOnce();
      cb();
      return;
    }
    setTimeout(check, 50);
  };
  check();
}

export function isNativeReady() {
  return listenerInstalled;
}

// 调用 C++ 原生函数，Promise 在 complete(var) 回包时 resolve。
// 带兜底超时:未注册的 native 名 / C++ 侧死链不会让调用方永久 pending
//（对齐 llm-gui 自研 RPC 的 5 分钟兜底;demucs 分块/分裂可能真得很慢）。
const CALL_TIMEOUT_MS = 5 * 60 * 1000;

export function callNative(name, ...args) {
  // 必须无条件装回包监听（幂等）：backend 已就绪的页面（自行轮询 init，不走
  // waitForNative/onNativeReady）如果只在未就绪分支安装，invoke 发出后
  // __juce__complete 无人接收，Promise 会挂到超时。
  installListenerOnce();
  if (!listenerInstalled)
    return Promise.reject(new Error('JUCE 后端不可用'));
  const resultId = nextResultId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.has(resultId)) {
        pending.delete(resultId);
        reject(new Error('native call timed out: ' + name));
      }
    }, CALL_TIMEOUT_MS);
    pending.set(resultId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    window.__JUCE__.backend.emitEvent('__juce__invoke', {
      name,
      params: args,
      resultId,
    });
  });
}

// 单向调用（resultId:-1，不等回包）——nowplaying/home 等页面桥的
// callNative 风格；适合 fire-and-forget 的 UI 动作。
export function callNativeFireAndForget(name, ...args) {
  if (!backendReady()) return false;
  window.__JUCE__.backend.emitEvent('__juce__invoke', {
    name,
    params: args,
    resultId: -1,
  });
  return true;
}

// Blob → 纯 base64 字符串（无 data: 前缀），分块保存上行用。
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('读取数据失败'));
    reader.readAsDataURL(blob);
  });
}

// 分块保存四件套的通用上行循环（C++ 端为共享的 ChunkedFileSaver）：
// names = {begin, append, finish, abort}（各窗口的原生函数名），
// beginArgs 是 begin 的入参（如 [originalPath] 或 [sourcePath, fileName]）。
// 返回最终落盘路径；任一步失败会 best-effort abort 半写会话。
export async function chunkedSave(names, beginArgs, blob, {
  onProgress,
  chunkBytes = 3 * 1024 * 1024, // 3MB raw ≈ 4MB base64 per call
  messages = {},
} = {}) {
  const say = (key, fallback) => messages[key] || fallback;
  const begin = await callNative(names.begin, ...beginArgs);
  if (!begin || !begin.token)
    throw new Error((begin && begin.error) || say('begin', '无法创建保存会话'));

  try {
    for (let off = 0; off < blob.size; off += chunkBytes) {
      const b64 = await blobToBase64(blob.slice(off, off + chunkBytes));
      const r = await callNative(names.append, begin.token, b64);
      if (!r || r.ok !== true)
        throw new Error((r && r.error) || say('append', '写入数据失败'));
      if (onProgress) onProgress(Math.min(1, (off + chunkBytes) / blob.size));
    }
    const done = await callNative(names.finish, begin.token);
    if (!done || done.ok !== true)
      throw new Error((done && done.error) || say('finish', '写入文件失败'));
    if (onProgress) onProgress(1);
    return done.path;
  } catch (e) {
    callNative(names.abort, begin.token).catch(() => {});
    throw e;
  }
}
