// dsh-file-tracker — 宿主半边（Cordis 双端插件的 node 半）。
//
// 职责只有两件事：
//  1. 监听 `session/event` 里的 `tool/call` / `tool/result`，从工具参数里解析出
//     **动了哪些文件 / 哪些目录**，按会话聚成内存环 + 追加落盘。
//  2. 在 web server 上挂一个同源 `/ft/*` JSON RPC（loopback 信任栅栏），
//     给客户端半边轮询：事件增量和"动过的目录"聚合。
//
// 设计纪律（沿 dsh-session-manager / meow-memory 的成熟约定）：
//  · inject 声明的服务裸访问（cordis 红线 #1）；webServer 不可用时**不崩不挂路由**，
//    收集照常继续（fail-open）——下次重启后路由自然补上。
//  · 每一路解析都包 try/catch：任何一条怪事件都不能打断宿主 turn。
//  · 持久化用逐行 JSON 追加（~/.dsh/file-tracker/events.jsonl），启动时只回读
//    尾部区段复原内存；文件超限从头截断。零第三方依赖。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'dsh-file-tracker';

// webServer 不可用时插件照常 activate（事件收集不依赖它）；路由挂载才需要它。
// settings / sessions 等 service 这里都用不到，少声明少风险。
export const inject = ['webServer'];

/** 宿主 DSH 家目录：与 dsh-session-manager 同优先级（$DSH_HOME > ~/.dsh）。 */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME?.trim();
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), '.dsh');
}

const MAX_MEMORY_EVENTS = 2000;          // 内存环上限（跨会话总和）
const MAX_DONE_SIZE = 8 * 1024 * 1024;   // 落盘超这个体积时截断重来
const KEEP_ON_TRUNCATE = 1000;           // 截断时保留最近这么多行

/* ════════════════════════ 路径解析（把工具调用提成"动了什么"） ════════════════════════ */

/**
 * 已知文件面工具的形参名 → 动作类别。
 * kind: write/edit/delete/move/read/view/shell —— 客户端按这个挑图标与分组。
 */
const TOOL_RULES = [
  { test: /^write$/, kind: 'write', pick: ['file_path'] },
  { test: /^edit$/, kind: 'edit', pick: ['file_path'] },
  { test: /^(read|read_image)$/, kind: 'read', pick: ['file_path'] },
  { test: /^(glob|ops_glob|grep|ops_grep)$/, kind: 'view', pick: ['path'], dirPath: true },
  { test: /^move$/, kind: 'move', pick: ['file_path', 'source_path', 'path'], dest: ['destination', 'to'] },
  { test: /^copy$/, kind: 'copy', pick: ['file_path', 'source_path', 'path'], dest: ['destination', 'file_path'] },
  { test: /^delete$/, kind: 'delete', pick: ['file_path', 'path'] },
];

function pickPathsFor(toolName, args) {
  const name = String(toolName || '').toLowerCase().split('/').pop();
  if (!name) return [];
  const rule = TOOL_RULES.find((r) => r.test.test(name));
  if (rule) {
    const paths = [];
    const src = rule.pick.map((k) => args?.[k]).find((v) => typeof v === 'string' && v.trim());
    if (src) paths.push({ p: src.trim(), role: 'src', conf: 1 });
    const dst = (rule.dest ?? []).map((k) => args?.[k]).find((v) => typeof v === 'string' && v.trim());
    if (dst) paths.push({ p: dst.trim(), role: 'dst', conf: 1 });
    return paths;
  }
  return null; // 没有规则 → 交给 shell 启发式
}

/**
 * shell 类工具启发式：从命令串里抓"像路径"的片段。
 * 收两类形状（Windows 盘符绝对路径 / 带扩展名的文件路径），置信标 0.6，
 * 客户端用弱色显示 —— 主要用途是回答"agent 动了哪个目录"。
 */
const WIN_PATH_RE = /[A-Za-z]:[\\/](?:[^<>|:*?"'\r\n;]+?[\\/])*[^<>|:*?"'\r\n;]*/g;
const REL_FILE_RE = /(?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+-]+\.[A-Za-z0-9]{1,10}(?![\w.-])/g;

function shellPathCandidates(command) {
  const abs = [];
  for (const m of String(command ?? '').matchAll(WIN_PATH_RE)) {
    const s = m[0].replace(/[\s.,;:'")\]}]+$/, '').replace(/[\\/]+$/, '');
    if (s.length > 4) abs.push(s);
  }
  const found = new Set(abs);
  for (const m of String(command ?? '').matchAll(REL_FILE_RE)) {
    const s = m[0].replace(/[\s.,;:'")\]}]+$/, '');
    // 已被某条绝对路径包含 → 跳过（同一文件不要记两次）
    if (s.length > 3 && !abs.some((a) => a.toLowerCase().includes(s.toLowerCase()))) found.add(s);
  }
  return [...found].slice(0, 6); // 单条命令最多记 6 个，防刷屏
}

const SHELL_TOOL_RE = /^(pwsh|powershell|shell|bash|sh|cmd|terminal)$/i;

/* ════════════════════════ 存储 ════════════════════════ */

class Tracker {
  constructor(file, logger) {
    this.file = file;
    this.logger = logger;
    /** @type {Array<object>} 全局内存环（按 fseq 升序），新事件永远尾插 */
    this.events = [];
    this.seq = 0;
    this.callState = new Map(); // callId → { evIdx: number[], done: boolean }
    this.titles = new Map();    // 会话 id → 标题

    const restored = this.#boot();
    if (restored > 0) logger?.info?.(`dsh-file-tracker: restored ${restored} events from disk`);
  }

  #boot() {
    try {
      if (!fs.existsSync(this.file)) return 0;
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      const tail = lines.slice(-KEEP_ON_TRUNCATE);
      let count = 0;
      for (const line of tail) {
        try {
          const e = JSON.parse(line);
          if (typeof e.fseq === 'number' && e.fseq > this.seq) this.seq = e.fseq;
          this.events.push(e);
          count++;
        } catch { /* 坏行略过 */ }
      }
      this.events = this.events.slice(-MAX_MEMORY_EVENTS);
      this.#compactIfNeeded();
      return count;
    } catch {
      return 0;
    }
  }

  #compactIfNeeded(sizeHint) {
    try {
      const size = sizeHint ?? fs.statSync(this.file).size;
      if (size <= MAX_DONE_SIZE) return;
      const all = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(this.file, all.slice(-KEEP_ON_TRUNCATE).join('\n') + '\n');
      this.logger?.info?.('dsh-file-tracker: compacted events.jsonl');
    } catch { /* 落盘失败不影响内存路径 */ }
  }

  /** 追加一组记录并落盘；返回它们在 events[] 的下标，供 tool/result 回填 err。 */
  append(base) {
    const idxs = [];
    for (const rec of base.recs) {
      this.seq += 1;
      const ev = {
        fseq: this.seq,
        sid: base.sid,
        cwd: base.cwd,
        title: this.titles.get(base.sid) || '',
        time: base.time,
        tool: base.tool,
        turn: base.turn,
        step: base.step,
        kind: rec.kind,
        file: rec.file,
        dir: rec.dir,
        conf: rec.conf,
      };
      idxs.push(this.events.length);
      this.events.push(ev);
      try {
        fs.appendFileSync(this.file, JSON.stringify(ev) + '\n');
      } catch { /* 磁盘不可写不致命，内存环仍在 */ }
    }
    if (this.events.length > MAX_MEMORY_EVENTS) this.events.splice(0, this.events.length - MAX_MEMORY_EVENTS);
    this.#compactIfNeeded();
    return idxs;
  }

  markResult(callId, isError) {
    if (!isError) return;
    const st = this.callState.get(String(callId));
    if (!st || st.done) return;
    st.done = true;
    for (const i of st.evIdx) {
      const e = this.events[i];
      if (e) e.err = true;
    }
  }

  read(sessionId, after, limit = 300) {
    const list = this.events.filter((e) => e.sid === sessionId && e.fseq > (after ?? 0));
    return list.slice(-limit);
  }

  /** 目录聚合：返回 [{ dir, count, kinds:{kind:n}, last, lastFile }] 按最近时间排序。 */
  summarize(sessionId) {
    const dirs = new Map();
    for (const e of this.events) {
      if (e.sid !== sessionId || !e.dir) continue;
      let row = dirs.get(e.dir);
      if (!row) { row = { dir: e.dir, count: 0, kinds: {}, last: 0, lastFile: '' }; dirs.set(e.dir, row); }
      row.count += 1;
      row.kinds[e.kind] = (row.kinds[e.kind] ?? 0) + 1;
      if (e.time >= row.last) { row.last = e.time; row.lastFile = e.file ?? ''; }
    }
    return [...dirs.values()].sort((a, b) => b.last - a.last);
  }

  /** 会话清单（跨会话视图）： seen session id 全集。 */
  sessionList() {
    const map = new Map();
    for (const e of this.events) {
      if (!map.has(e.sid)) map.set(e.sid, { id: e.sid, title: e.title ?? '', cwd: e.cwd ?? '', time: e.time, n: 0 });
      const row = map.get(e.sid);
      row.n += 1;
      row.time = Math.max(row.time, e.time);
      if (e.title) row.title = e.title;
    }
    return [...map.values()].sort((a, b) => b.time - a.time);
  }
}

/* ════════════════════════ 事件 → 记录 ════════════════════════ */

function shortenPath(p, cwd) {
  if (typeof p !== 'string' || !p) return { short: '', dir: '.' };
  let out = p.replace(/\\/g, '/');
  let short = out;
  if (cwd) {
    const c = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
    const low = out.toLowerCase();
    const cl = c.toLowerCase();
    if (low.startsWith(cl + '/')) short = out.slice(cl.length + 1);
    else if (low === cl || low === cl + '/') short = out; // 整个 cwd 本身被引用
  }
  if (short.length > 120) short = '…' + short.slice(-118);
  const i = short.lastIndexOf('/');
  let dir = i > 0 ? short.slice(0, i) : (i === 1 && short[1] === ':' ? short/* "C:/" 显式根 */ : '.');
  dir = dir.replace(/\\+$/, '');
  if (/^[A-Za-z]:[\\/]?$/.test(dir)) dir = dir[0] + ':/';
  return { short, dir };
}

/* ════════════════════════ apply（entrypoint） ════════════════════════ */

export function apply(ctx, config) {
  const logger = ctx.logger;
  const home = resolveDshHome();
  const dir = path.join(home, 'file-tracker');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 建目录失败不致命 */ }
  const tracker = new Tracker(path.join(dir, 'events.jsonl'), logger);

  /** loopback 信任栅栏（与官方 predicate 同形）：非本机 / 跨源一律 403。 */
  function isTrustedRequest(req) {
    try {
      const host = req.headers['host'];
      if (typeof host !== 'string' || host.length === 0) return false;
      const i = host.lastIndexOf(':');
      const hostname = i > 0 ? host.slice(0, i).replace(/^\[|\]$/g, '') : host;
      if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname.toLowerCase())) return false;
      const site = req.headers['sec-fetch-site'];
      if (typeof site === 'string' && site.toLowerCase() === 'cross-site') return false;
      const origin = req.headers['origin'];
      if (origin == null) return true;
      return new URL(String(origin)).host === host;
    } catch {
      return false;
    }
  }

  const SHELL_TOOL_RE = /^(pwsh|powershell|shell|bash|sh|cmd|terminal)$/i;

  ctx.on('session/event', (session, event) => {
    try {
      const sid = session?.id;
      if (!sid || !event) return;
      const t = event.type;

      if (t === 'session/title') {
        const title = event?.data?.title;
        if (typeof title === 'string' && title) tracker.titles.set(sid, title);
        return;
      }
      if (t !== 'tool/call' && t !== 'tool/result') return;

      const time = typeof event.time === 'number' ? event.time : Date.now();

      if (t === 'tool/call') {
        const d = event.data ?? {};
        let args = {};
        if (typeof d.arguments === 'string') {
          try { args = JSON.parse(d.arguments); } catch { args = { _raw: String(d.arguments).slice(0, 200) }; }
        } else if (d.arguments && typeof d.arguments === 'object') {
          args = d.arguments;
        }
        const toolName = String(d.name ?? '');
        const bare = toolName.toLowerCase().split('/').pop();
        const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : '';
        const callId = typeof d.callId === 'string' ? d.callId : `nolid-${event.seq}`;

        const picked = pickPathsFor(toolName, args);
        let recs = [];
        if (picked !== null) {
          // 规则工具：kind 来自规则（write/edit/read/view/move/copy/delete）
          const rule = TOOL_RULES.find((r) => r.test.test(bare)) ?? { kind: 'write' };
          for (const { p, role, conf } of picked) {
            const pos = shortenPath(p, cwd);
            if (rule.dirPath) {
              // glob / grep 的 path 本身是目录：目录行记它，文件标成 "目录/"
              const d = pos.short.replace(/[\\/]+$/, '') || '.';
              recs.push({ kind: rule.kind, file: d + '/', dir: d, conf });
              continue;
            }
            const dstMove = role === 'dst' && rule.kind === 'move';
            recs.push({ kind: dstMove ? 'move' : rule.kind, file: pos.short, dir: pos.dir, conf });
          }
        } else if (SHELL_TOOL_RE.test(bare)) {
          // shell/PowerShell 类：命令串里爬路径，conf=0.6
          const cmd = typeof args?.command === 'string' ? args.command : JSON.stringify(args ?? {});
          recs = shellPathCandidates(cmd).map((p) => {
            const pos = shortenPath(p, cwd);
            return { kind: 'shell', file: pos.short, dir: pos.dir, conf: 0.6 };
          });
        } else {
          // 非文件面工具（web 搜索 / 聊天类 / 图像生成等）不记
          return;
        }
        if (recs.length === 0) return;

        const evIdx = tracker.append({ sid, cwd, time, tool: toolName, turn: d.turn, step: d.step, recs });
        tracker.callState.set(callId, { evIdx, done: false });
        if (tracker.callState.size > 600) {
          for (const k of [...tracker.callState.keys()].slice(0, tracker.callState.size - 480)) tracker.callState.delete(k);
        }
        return;
      }

      // tool/result：把失败状态回填到对应记录
      const d = event.data ?? {};
      const callId = d?.message?.source?.callId;
      if (typeof callId === 'string' && d?.message?.isError === true) tracker.markResult(callId, true);
    } catch (e) {
      try { logger?.warn?.(`dsh-file-tracker: event skipped: ${e?.message ?? e}`); } catch {}
    }
  });

  // `/ft/*` RPC（客户端轮询面）。webServer 不可用 → 不挂路由，收集照常（fail-open）。
  const webServer = ctx.webServer;
  if (webServer && typeof webServer.register === 'function') {
    try {
      const dispose = webServer.register({
        kind: 'prefix',
        path: '/ft',
        handler: (req, res) => {
          if (!isTrustedRequest(req)) {
            res.writeHead(403);
            res.end('forbidden');
            return;
          }
          const u = new URL(req.url, 'http://127.0.0.1');
          const q = u.searchParams;
          const send = (status, body) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(body));
          };
          if (req.method === 'GET' && u.pathname === '/ft/events') {
            const sid = q.get('sessionId') ?? '';
            const after = Number(q.get('after')) || 0;
            const list = sid ? tracker.read(sid, after) : [];
            send(200, { ok: true, seq: tracker.seq, events: list });
            return;
          }
          if (req.method === 'GET' && u.pathname === '/ft/summary') {
            const sid = q.get('sessionId') ?? '';
            send(200, { ok: true, dirs: sid ? tracker.summarize(sid) : [] });
            return;
          }
          if (req.method === 'GET' && u.pathname === '/ft/sessions') {
            send(200, { ok: true, sessions: tracker.sessionList() });
            return;
          }
          send(404, { ok: false, code: 'not-found' });
        },
      });
      ctx.effect(() => dispose);
      logger.info?.('dsh-file-tracker: /ft/* routes mounted');
    } catch (e) {
      logger.warn?.(`dsh-file-tracker: /ft mount failed (collect-only mode): ${e?.message ?? e}`);
    }
  } else {
    logger.info?.('dsh-file-tracker: webServer unavailable; collect-only mode');
  }
}
