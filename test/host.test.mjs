// dsh-file-tracker 宿主半边无头测试：mock cordis ctx + 直调 /ft handler。
// 运行：node plugin-testing/host.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP_HOME = path.join(HERE, 'tmp-home');
fs.rmSync(TMP_HOME, { recursive: true, force: true });
fs.mkdirSync(TMP_HOME, { recursive: true });
process.env.DSH_HOME = TMP_HOME;

const PLUGIN = 'C:/Users/word/.dsh/plugins/dsh-file-tracker/lib/index.js';
const mod = await import(pathToFileURL(PLUGIN).href);

let failures = 0;
function ok(cond, label) {
  if (cond) console.log('  PASS ' + label);
  else { failures++; console.log('  FAIL ' + label); }
}

// ── mock ctx ──────────────────────────────────────────────
const listeners = [];
let registered = null;
const logs = [];
const ctx = {
  logger: {
    info: (m) => logs.push('info: ' + m),
    warn: (m) => logs.push('warn: ' + m),
  },
  on(type, fn) { listeners.push([type, fn]); },
  effect(fn) { this._dispose = fn; return () => {}; },
  webServer: {
    register(route) { registered = route; return () => { registered = null; }; },
  },
};

ok(mod.name === 'dsh-file-tracker', '导出 name');
ok(Array.isArray(mod.inject) && mod.inject.includes('webServer'), '导出 inject 含 webServer');
mod.apply(ctx, {});
ok(registered && registered.kind === 'prefix' && registered.path === '/ft', '挂载 /ft 前缀路由');
ok(listeners.some(([t]) => t === 'session/event'), '监听 session/event');

const emit = (event) => { for (const [t, fn] of listeners) if (t === 'session/event') fn(session, event); };

const CWD = 'C:/Users/word/Documents/默认项目';
const session = { id: 'session-test', header: { cwd: CWD } };
const t0 = Date.now();

// 1) write 精确路径（cwd 内 → 相对化）
emit({
  type: 'tool/call', seq: 1, time: t0,
  data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: JSON.stringify({ file_path: CWD + '/src/a.ts' }) },
});
// 2) edit 另一层目录
emit({
  type: 'tool/call', seq: 2, time: t0 + 1000,
  data: { turn: 1, step: 2, callId: 'c2', name: 'edit', arguments: JSON.stringify({ file_path: CWD + '/docs/readme.md' }) },
});
// 3) pwsh shell 启发式（反斜杠绝对路径）
emit({
  type: 'tool/call', seq: 3, time: t0 + 2000,
  data: { turn: 1, step: 3, callId: 'c3', name: 'pwsh', arguments: JSON.stringify({ command: 'New-Item -Force "C:\\Users\\word\\Documents\\默认项目\\lib\\b.js"; Get-ChildItem' }) },
});
// 4) glob 查看（view）
emit({
  type: 'tool/call', seq: 4, time: t0 + 3000,
  data: { turn: 1, step: 4, callId: 'c4', name: 'glob', arguments: JSON.stringify({ path: CWD + '/src' }) },
});
// 5) 非文件工具 → 应被忽略
emit({
  type: 'tool/call', seq: 5, time: t0 + 3500,
  data: { turn: 1, step: 5, callId: 'c5', name: 'web_search', arguments: JSON.stringify({ query: 'hello' }) },
});
// 6) tool/result 失败 → c1 记 err
emit({
  type: 'tool/result', seq: 6, time: t0 + 4000,
  data: { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'c1' }, isError: true, content: [] } },
});
// 7) 空 cwd 会话 → 不崩
const sessionNoCwd = { id: 'session-nocwd', header: {} };
for (const [t, fn] of listeners) if (t === 'session/event') fn(sessionNoCwd, { type: 'tool/call', seq: 9, time: t0, data: { name: 'write', callId: 'cx', arguments: '{"file_path":"rel/x.txt"}' } });

// ── RPC 验证 ─────────────────────────────────────────────
function call(url) {
  return new Promise((resolve) => {
    const res = {
      status: 0, headers: null, body: '',
      writeHead(s, h) { res.status = s; res.headers = h; },
      end(b) { res.body = b || ''; resolve(res); },
    };
    registered.handler({ method: 'GET', url, headers: { host: '127.0.0.1:19387' } }, res);
  });
}

const r1 = await call('/ft/events?sessionId=session-test&after=0');
const j1 = JSON.parse(r1.body);
ok(r1.status === 200 && j1.ok === true, '/ft/events 200');
ok(j1.events.length === 4, 'events 4 条（忽略非文件工具），实际 ' + j1.events.length);
ok(j1.events[0].file === 'src/a.ts', 'write 相对化 src/a.ts，实际 ' + j1.events[0].file);
ok(j1.events[0].dir === 'src', 'write dir=src');
ok(j1.events[0].kind === 'write' && j1.events[0].err === true, 'write 失败回填 err');
ok(j1.events[1].kind === 'edit' && j1.events[1].dir === 'docs', 'edit docs/readme.md');
ok(j1.events[2].kind === 'shell' && j1.events[2].conf === 0.6, 'pwsh → shell 低置信');
ok(j1.events[2].file === 'lib/b.js' && j1.events[2].dir === 'lib', 'pwsh 路径干净 lib/b.js，实际 ' + j1.events[2].file);
ok(j1.events[3].kind === 'view' && j1.events[3].dir === 'src' && j1.events[3].file === 'src/', 'glob → view src（目录型），实际 ' + j1.events[3].file + ' / ' + j1.events[3].dir);

const r2 = await call('/ft/summary?sessionId=session-test');
const j2 = JSON.parse(r2.body);
ok(j2.ok && j2.dirs.length >= 3, 'summary 至少 3 个目录，实际 ' + j2.dirs.length);
const dirNames = j2.dirs.map((d) => d.dir).sort();
console.log('   dirs =', JSON.stringify(dirNames));
ok(dirNames.includes('src') && dirNames.includes('docs'), 'summary 含 src/docs');

const r3 = await call('/ft/sessions');
const j3 = JSON.parse(r3.body);
ok(j3.ok && j3.sessions.some((s) => s.id === 'session-test' && s.n === 4), 'sessions 清单含 session-test(4)');

// 空 cwd 会话也能查到（相对路径不崩）
const r4 = await call('/ft/events?sessionId=session-nocwd&after=0');
const j4 = JSON.parse(r4.body);
ok(j4.ok && j4.events.length === 1 && j4.events[0].file === 'rel/x.txt', '空 cwd 相对路径正常');

// 未知路径 404
const r5 = await call('/ft/nope');
ok(r5.status === 404, '未知路径 404');
// 非本机 Host → 403
const r6 = await new Promise((resolve) => {
  const res = { writeHead(s) { res.status = s; }, end(b) { res.body = b; resolve(res); } };
  registered.handler({ method: 'GET', url: '/ft/events', headers: { host: 'evil.example:80' } }, res);
});
ok(r6.status === 403, '非 loopback Host → 403');

// 落盘验证
const file = path.join(TMP_HOME, 'file-tracker', 'events.jsonl');
ok(fs.existsSync(file), 'events.jsonl 已生成');
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
ok(lines.length === 5, '落盘 5 行（4 + 空cwd 1），实际 ' + lines.length);
const first = JSON.parse(lines[0]);
ok(first.sid === 'session-test' && typeof first.fseq === 'number', '落盘行含 fseq/sid');

// 重启复原：重新 apply 一次（同一 DSH_HOME），事件应被回读
const listeners2 = [];
const registered2 = { v: null };
const ctx2 = {
  logger: { info: (m) => logs.push('info2: ' + m), warn: () => {} },
  on(t, fn) { listeners2.push([t, fn]); },
  effect(fn) { return () => {}; },
  webServer: { register(r) { registered2.v = r; return () => {}; } },
};
mod.apply(ctx2, {});
const r7 = await new Promise((resolve) => {
  const res = { writeHead(s) { res.status = s; }, end(b) { res.body = b; resolve(res); } };
  registered2.v.handler({ method: 'GET', url: '/ft/events?sessionId=session-test&after=0', headers: { host: '127.0.0.1:1' } }, res);
});
const j7 = JSON.parse(r7.body);
ok(j7.ok && j7.events.length === 4, '重启回读 4 条（历史复原），实际 ' + j7.events.length);

console.log('\n日志片段:');
for (const l of logs.slice(0, 6)) console.log('  ' + l);
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
