// 极简 Toast：模块级事件总线 + <Toasts/> 渲染组件。
// 任意深处（结果行一键下载、批量行内下载）都可以直接 toast() 反馈，
// 不必层层传回调。tone: 'good' | 'warn' | 'info'。

import React, { useEffect, useState } from 'react';

const listeners = new Set();
let seq = 0;

/** 弹一条提示；ms 后自动消失 */
export function toast(msg, tone = 'good', ms = 3600) {
  const item = { id: ++seq, msg, tone };
  listeners.forEach((l) => l({ type: 'add', item }));
  setTimeout(() => listeners.forEach((l) => l({ type: 'del', id: item.id })), ms);
}

export function Toasts() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const l = (e) => {
      if (e.type === 'add') setItems((prev) => [...prev.slice(-3), e.item]);
      else setItems((prev) => prev.filter((i) => i.id !== e.id));
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  if (items.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((i) => (
        <div key={i.id} className={`toast toast-${i.tone}`}>
          {i.msg}
        </div>
      ))}
    </div>
  );
}
