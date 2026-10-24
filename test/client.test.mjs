// dsh-file-tracker 客户端半边无头测试：微 DOM 桩 + React 桩，验证工厂/纯函数/插槽接线。
// 运行：node plugin-testing/client.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = 'C:/Users/word/.dsh/plugins/dsh-file-tracker/lib/client.js';
const code = fs.readFileSync(SRC, 'utf8');

let failures = 0;
function ok(cond, label) {
  if (cond) console.log('  PASS ' + label);
  else { failures++; console.log('  FAIL ' + label); }
}

/* ── 微 DOM 桩 ── */
function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    style: { setProperty() {}, removeProperty() {} },
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, v) { const on = v === undefined ? !this._s.has(c) : !!v; on ? this._s.add(c) : this._s.delete(c); return on; },
      contains(c) { return this._s.has(c); },
    },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {}, removeEventListener() {},
    setAttribute(k, v) { this['attr:' + k] = v; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 372, bottom: 460, width: 372, height: 460 }; },
    setPointerCapture() {}, releasePointerCapture() {},
    closest() { return null; },
    innerHTML: '', textContent: '', title: '', hidden: false, offsetWidth: 0, value: '',
  };
  return el;
}
const doc = {
  head: makeEl('head'),
  body: makeEl('body'),
  createElement: (t) => makeEl(t),
  querySelector: () => null,
  addEventListener() {},
};
const storage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};

/* ── React 桩 ── */
const effects = [];
const React = {
  createElement: (type, props, children) => ({ type, props: props || {}, children }),
  useEffect: (fn, deps) => { effects.push({ fn, deps }); },
};

/* ── window.__ModuleLoader__ ── */
let captured = null;
const window = {
  __ModuleLoader__: { load: (cfg) => { captured = cfg; } },
  innerWidth: 1280, innerHeight: 800,
  addEventListener() {},
};

/* ── fetch 桩：统计调用，默认空结果 ── */
const fetchCalls = [];
const fetchImpl = async (url) => {
  fetchCalls.push(String(url));
  return { ok: true, json: async () => ({ ok: true, events: [], sessions: [], dirs: [] }) };
};

const requireStub = (id) => {
  if (id === 'react') return React;
  throw new Error('unexpected require: ' + id);
};

// 执行客户端模块（非严格模式，参数显式传入）
const run = new Function('require', 'window', 'document', 'localStorage', 'fetch', 'console', 'setTimeout', 'clearTimeout', code);
run(requireStub, window, doc, storage, fetchImpl, console, (fn, ms) => 0, () => {});

ok(captured && captured.id === 'dsh-file-tracker', '模块工厂已注册且 id 正确');

const mod = captured.factory(requireStub);
// 0.2.1 加载器契约：工厂返回值本身即插件模块，apply 必须在顶层。
// （回归：曾因 `return module` 导致 apply 缺失、web 界面整体启动中止）
ok(mod && typeof mod.apply === 'function', '工厂返回值顶层有 apply（0.2.1 契约）');
ok(Array.isArray(mod.inject) && mod.inject.includes('slots'), 'inject 含 slots');

/* ── 纯函数：目录聚合 ── */
const { summarize, dirName, baseName, headKindOf, timeStr } = mod.__internals;
ok(baseName('src/a.ts') === 'a.ts', 'baseName');
ok(dirName('src/deep/b.ts') === 'src/deep', 'dirName');
ok(dirName('a.ts') === '.', 'dirName 无目录 → .');
ok(timeStr(0) === '', 'timeStr(0) 空');

const evs = [
  { fseq: 1, dir: 'src', file: 'src/a.ts', kind: 'write', time: 100 },
  { fseq: 2, dir: 'src', file: 'src/b.ts', kind: 'edit', time: 200 },
  { fseq: 3, dir: 'docs', file: 'docs/r.md', kind: 'edit', time: 150 },
  { fseq: 4, dir: 'lib', file: 'lib/x.js', kind: 'shell', time: 300, conf: 0.6 },
  { fseq: 5, dir: 'src', file: 'src/a.ts', kind: 'write', time: 400 },
];
const sum = summarize(evs);
ok(sum.length === 3, '聚合 3 个目录，实际 ' + sum.length);
ok(sum[0].dir === 'src' && sum[0].count === 3, 'src 最近优先且 3 次，实际 ' + sum[0].dir + '×' + sum[0].count);
ok(sum[1].dir === 'lib' && sum[2].dir === 'docs', '按最近时间排序 lib→docs，实际 ' + sum.map((s) => s.dir).join(','));
ok(headKindOf({ edit: 2, write: 1 }) === 'write', 'headKindOf 优先 write');
ok(headKindOf({ view: 3 }) === 'view', 'headKindOf 回退首个');
ok(sum[0].kinds.write === 2 && sum[0].kinds.edit === 1, 'kinds 计数正确');

/* ── 插槽接线 ── */
let registeredEntry = null;
const ctx = {
  slots: {
    inject(name, fn) { ok(name === 'conversation.input.right', '注入 official slot 名'); return fn(); },
    register(entry, comp) { registeredEntry = { entry, comp }; return { dispose() {} }; },
  },
};
mod.apply(ctx);
ok(!!registeredEntry, '插槽已注册');
ok(registeredEntry.entry.id === 'file-tracker-anchor', 'entry id 正确');
ok(registeredEntry.entry.order === 90, 'entry order = 90');
ok(typeof registeredEntry.entry.inject === 'function' && registeredEntry.entry.inject('s1').sessionId === 's1', 'entry.inject 传 sessionId');

const wrapper = registeredEntry.comp({ sessionId: 's1' });
ok(typeof wrapper.type === 'function', '插槽组件是包裹层');
const vnode = wrapper.type(wrapper.props);
ok(vnode && vnode.type === 'span' && vnode.props.hidden === true, '锚点渲染为不可见 span');

// 面板 DOM 是否建好（body 上有 panel；FAB 已按用户要求移除，入口改走三点菜单）
const bodyHtml = doc.body.children.map((c) => c.tagName).join(',');
ok(doc.body.children.length >= 1, 'body 挂载了 panel，实际 ' + bodyHtml);
ok(doc.querySelector('.ftt-fab') === null, 'FAB 已移除');

// 会话切换：effect 跑一次 → 触发全量 fetch
effects.forEach((e) => { try { e.fn(); } catch { } });
ok(fetchCalls.some((u) => u.includes('/ft/events?sessionId=s1')), '锚点 effect 触发 /ft/events 拉取');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
