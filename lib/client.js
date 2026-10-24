/**
 * dsh-file-tracker — 客户端半边（web GUI）。
 *
 * 入口不再用右下角浮标：官方侧栏/会话行的"⋯"三点菜单由 primitives.Menu 渲染
 * （源码里 IconEllipsisOutlineRegular 只有一处三个圆点的 svg），我们在用户点开
 * 三点菜单时把"文件活动"一项插进菜单列表，点它弹出悬浮面板：
 *   · "动过的目录"页：agent 动过的目录聚合 —— 每行目录 + 次数 + 最近动的文件，
 *     点行展开该目录下文件明细（这正是"看到动了什么目录"的主视图）。
 *   · "时间线"页：逐条事件按时间倒序（写/改/读/看/移/删/壳），失败带红点。
 * 数据来自宿主半边同源 RPC `/ft/events`、`/ft/sessions`（1.2s 轮询）。
 *
 * 三点菜单注入手法（DOM，不碰 React 状态树）：
 *   · capture 阶段监听点击，记住"最近一次点在三点按钮上"的时刻（svg 三条小圆弧
 *     path 为特征）；官方 IconEllipsisOutlineRegular/Medium 同源。
 *   · MutationObserver 盯 body，新出现的 [role="menu"] 若在时间窗内且带菜单项，
 *     就克隆现有 menuItem 改文案塞进去 —— 类名/结构完全继承官方样式；
 *     点它时事件照常冒泡到菜单根节点，官方处理器会顺手把菜单收起。
 *   · 旁边不相关的菜单（下拉选择等）因没有"刚点过三点"的门槛不会被打扰。
 *
 * 会话锚点（conversation.input.right，不可见）仍用于每会话拿 sessionId。
 *
 * 纪律（沿 dsh-codex-effort-slider / dsh-session-manager / dsh-session-delete）：
 *   · fail-open：锚点没就绪 / 菜单没匹配上 / RPC 挂了 → 静默退回，控制台不刷屏。
 */
window.__ModuleLoader__.load({
  id: "dsh-file-tracker",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");

    var PACKAGE_ID = "dsh-file-tracker";
    var SLOT_NAME = "conversation.input.right";
    var ENTRY_ID = "file-tracker-anchor";
    var ENTRY_ORDER = 90;
    var POLL_OK_MS = 1200;
    var POLL_ERR_MS = 4000;
    var STORE_KEY = "dsh-file-tracker/state-v1";

    /* ── 样式：一律走 --dsw-* 令牌，浅深主题自动跟随 ── */
    var CSS = [
      // 菜单项兜底样式（正常情况下克隆官方 item，用不到这套）
      ".ftt-menu-item{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;cursor:pointer;",
      "font-size:13px;color:var(--dsw-alias-label-primary,var(--dsw-static-gray-950,#0f1115));",
      "user-select:none;-webkit-user-select:none;white-space:nowrap}",
      ".ftt-menu-item:hover{background:var(--dsw-alias-bg-hover,rgba(15,17,21,.06))}",
      ".ftt-menu-item svg{width:16px;height:16px;flex:none}",

      ".ftt-panel{position:fixed;width:372px;height:460px;max-height:calc(100vh - 40px);display:none;flex-direction:column;",
      "background:var(--dsw-alias-bg-primary,var(--dsw-static-gray-0,#fff));",
      "border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.25),0 0 0 1px var(--dsw-alias-border-l1,rgba(15,17,21,.08));",
      "z-index:2147483001;overflow:hidden;font-size:12px;color:var(--dsw-alias-label-primary,var(--dsw-static-gray-950,#0f1115))}",
      ".ftt-panel.open{display:flex}",
      ".ftt-head{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:move;flex:none;",
      "border-bottom:1px solid var(--dsw-alias-border-l1,rgba(15,17,21,.06))}",
      ".ftt-title{font-weight:600;font-size:12.5px}",
      ".ftt-session{font-size:11px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#8a8f99)}",
      ".ftt-close{margin-left:auto;width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--dsw-alias-label-secondary,#8a8f99)}",
      ".ftt-close:hover{background:var(--dsw-alias-bg-hover,rgba(15,17,21,.06));color:var(--dsw-alias-label-primary,#0f1115)}",

      ".ftt-tabs{display:flex;gap:4px;padding:8px 12px 6px;flex:none}",
      ".ftt-tab{padding:4px 10px;border-radius:999px;cursor:pointer;font-size:11.5px;",
      "color:var(--dsw-alias-label-secondary,#8a8f99);border:1px solid var(--dsw-alias-border-l1,rgba(15,17,21,.08));user-select:none}",
      ".ftt-tab.on{color:var(--dsw-alias-label-primary,#0f1115);background:var(--dsw-alias-bg-hover,rgba(15,17,21,.06));font-weight:600}",

      ".ftt-body{flex:1;overflow-y:auto;overflow-x:hidden;padding:6px 10px 12px;scrollbar-width:thin}",
      ".ftt-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px}",
      ".ftt-row.click{cursor:pointer}",
      ".ftt-row.click:hover{background:var(--dsw-alias-bg-hover,rgba(15,17,21,.05))}",
      ".ftt-dir-name{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;font-weight:600;",
      "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".ftt-meta{color:var(--dsw-alias-label-tertiary,#9aa0aa);font-size:10.5px;flex:none;white-space:nowrap;font-variant-numeric:tabular-nums}",
      ".ftt-sub{padding:2px 6px 6px 26px}",

      ".ftt-k{width:18px;height:18px;border-radius:5px;flex:none;display:flex;align-items:center;justify-content:center;",
      "font-size:10px;font-weight:700;color:#fff;box-sizing:border-box}",
      ".ftt-k.write{background:#2ea043}.ftt-k.edit{background:#d29922}.ftt-k.move{background:#1f88c5}",
      ".ftt-k.delete{background:#e5484d}.ftt-k.read{background:#4d93f8}.ftt-k.view{background:#57606a}",
      ".ftt-k.shell{background:#8250df}.ftt-k.copy{background:#1f88c5}.ftt-k.dim{opacity:.55}",

      ".ftt-file{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".ftt-file .ftt-dir{color:var(--dsw-alias-label-tertiary,#9aa0aa)}",
      ".ftt-err{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-error-primary,#e5484d);flex:none}",
      ".ftt-detail{font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary,#8a8f99);",
      "padding:0 8px 6px 30px;word-break:break-all}",
      ".ftt-empty{padding:30px 14px;text-align:center;color:var(--dsw-alias-label-tertiary,#9aa0aa);font-size:11.5px;line-height:1.8;white-space:pre-line}",

      ".ftt-foot{flex:none;padding:5px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(15,17,21,.06));",
      "display:flex;gap:6px;align-items:center;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#9aa0aa);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}",
      ".ftt-dot{width:7px;height:7px;border-radius:50%;background:#2ea043;flex:none}",
      ".ftt-dot.err{background:var(--dsw-alias-state-error-primary,#e5484d)}",
    ].join(" ");

    /* ── 可读性补丁：不依赖宿主的语义令牌（那些令牌在部分表面里对比度极低），
          改为自持调色板 --ftt-*，并按当前界面明暗由 syncTheme() 注入具体值 ── */
    var CSS_TUNE = [
      ".ftt-panel{width:400px;height:520px;font-size:13px;line-height:1.45;",
      "background:var(--ftt-bg,#fff);color:var(--ftt-fg,#16181d);",
      "box-shadow:0 16px 48px rgba(0,0,0,.30),0 0 0 1px var(--ftt-line,rgba(15,17,21,.12))}",
      ".ftt-head{padding:11px 14px;border-bottom-color:var(--ftt-line,rgba(15,17,21,.10))}",
      ".ftt-title{font-size:14px}",
      ".ftt-session{font-size:11.5px;max-width:200px;color:var(--ftt-fg2,#5b626d)}",
      ".ftt-close{color:var(--ftt-fg2,#5b626d)}",
      ".ftt-close:hover{background:var(--ftt-hover,rgba(15,17,21,.06));color:var(--ftt-fg,#16181d)}",
      ".ftt-tab{padding:5px 12px;font-size:12.5px;color:var(--ftt-fg2,#5b626d);",
      "border-color:var(--ftt-line,rgba(15,17,21,.12))}",
      ".ftt-tab.on{color:var(--ftt-fg,#16181d);background:var(--ftt-hover,rgba(15,17,21,.06));border-color:transparent}",
      ".ftt-body{padding:8px 12px 14px}",
      ".ftt-row{padding:8px 10px}",
      ".ftt-row.click:hover{background:var(--ftt-hover,rgba(15,17,21,.06))}",
      ".ftt-dir-name{font-size:13px;line-height:1.5}",
      ".ftt-meta{font-size:11.5px;color:var(--ftt-fg3,#838a95)}",
      ".ftt-sub{padding:3px 8px 8px 28px}",
      ".ftt-k{width:19px;height:19px;font-size:10.5px}",
      ".ftt-file{font-size:12.5px;line-height:1.55}",
      ".ftt-file .ftt-dir{color:var(--ftt-fg3,#838a95)}",
      ".ftt-detail{font-size:11.5px;line-height:1.5;color:var(--ftt-fg2,#5b626d)}",
      ".ftt-empty{font-size:12.5px;color:var(--ftt-fg3,#838a95)}",
      ".ftt-foot{font-size:11.5px;color:var(--ftt-fg3,#838a95);",
      "border-top-color:var(--ftt-line,rgba(15,17,21,.10))}",
    ].join(" ");

    var PALETTE = {
      light: { bg: "#ffffff", fg: "#16181d", fg2: "#5b626d", fg3: "#838a95",
               line: "rgba(15,17,21,.12)", hover: "rgba(15,17,21,.06)" },
      dark:  { bg: "#1d1f24", fg: "#eceef2", fg2: "#adb4bf", fg3: "#868e9b",
               line: "rgba(255,255,255,.12)", hover: "rgba(255,255,255,.08)" }
    };

    /* 判断当前界面是亮还是暗：优先采样真实背景色亮度，再退到属性/meta */
    function appIsDark() {
      try {
        var nodes = [document.body, document.documentElement];
        for (var i = 0; i < nodes.length; i++) {
          if (!nodes[i]) continue;
          var bg = getComputedStyle(nodes[i]).backgroundColor || "";
          var m = bg.match(/rgba?\(([^)]+)\)/);
          if (!m) continue;
          var p = m[1].split(",").map(function (s) { return parseFloat(s); });
          var a = p.length > 3 ? p[3] : 1;
          if (a < 0.5) continue;
          var lum = 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
          return lum < 128;
        }
        var de = document.documentElement;
        var dt = (de.dataset && (de.dataset.theme || de.dataset.colorMode)) || "";
        var cls = de.className || "";
        if (/dark/i.test(dt) || /(^|\s)(dark|theme-dark)(\s|$)/i.test(cls)) return true;
        if (/light/i.test(dt)) return false;
        if (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches) return true;
      } catch (e) { /* fail-open：亮色 */ }
      return false;
    }

    function syncTheme(panel) {
      try {
        var p = appIsDark() ? PALETTE.dark : PALETTE.light;
        panel.style.setProperty("--ftt-bg", p.bg);
        panel.style.setProperty("--ftt-fg", p.fg);
        panel.style.setProperty("--ftt-fg2", p.fg2);
        panel.style.setProperty("--ftt-fg3", p.fg3);
        panel.style.setProperty("--ftt-line", p.line);
        panel.style.setProperty("--ftt-hover", p.hover);
      } catch (e) { /* fail-open */ }
    }

    var KIND_LABEL = { write: "写", edit: "改", move: "移", copy: "写", delete: "删", read: "读", view: "看", shell: "壳" };

    /* 官方 IconEllipsisOutlineRegular：三个小圆点 path，首条以此开头（Medium 同源） */
    var DOTS_PATH_HEAD = "M3 9C3.55228 9 4 8.55228 4 8";
    var FOLDER_SVG =
      '<svg viewBox="0 0 16 16" fill="none"><path d="M2.4 2h3.6l1.2 1.5h6.4c.7 0 1.3.6 1.3 1.3v7.4c0 .7-.6 1.3-1.3 1.3H2.4c-.7 0-1.3-.6-1.3-1.3V3.3C1.1 2.6 1.7 2 2.4 2Z" fill="var(--dsw-alias-state-business-primary,#4d93f8)" opacity=".92"/></svg>';
    var MENU_ITEM_LABEL = "文件活动";
    var MENU_WINDOW_MS = 1200;

    /* ══════════════════ 状态 ══════════════════ */

    var state = {
      open: false,
      tab: "dirs",
      sessionId: null,   // 当前锚点会话
      viewSid: null,     // null = 跟随当前会话
      sessionList: [],
      events: [],        // 当前视图会话的事件（fseq 升序）
      connOk: true,
      lastErr: "",
      expandedDir: null,
      expandedEv: null,
    };
    var els = null;
    var pollTimer = null;

    /* ══════════════════ 纯函数（离线可测） ══════════════════ */

    function timeStr(t) {
      if (!t) return "";
      var d = new Date(t);
      return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2);
    }

    function esc(s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    }

    function baseName(shortPath) {
      var i = shortPath.lastIndexOf("/");
      return i >= 0 ? shortPath.slice(i + 1) : shortPath;
    }

    function dirName(shortPath) {
      var i = shortPath.lastIndexOf("/");
      return i > 0 ? shortPath.slice(0, i) : i === 0 ? "/" : ".";
    }

    /** 目录聚合（客户端口径）：[{ dir, count, kinds, last, lastFile, files }] 按最近时间排序 */
    function summarize(events) {
      var dirs = new Map();
      for (var _i = 0, events_1 = events; _i < events_1.length; _i++) {
        var e = events_1[_i];
        if (!e || !e.dir) continue;
        var row = dirs.get(e.dir);
        if (!row) {
          row = { dir: e.dir, count: 0, kinds: {}, last: 0, lastFile: "", files: [] };
          dirs.set(e.dir, row);
        }
        row.count++;
        row.kinds[e.kind] = (row.kinds[e.kind] || 0) + 1;
        if (e.time >= row.last) { row.last = e.time; row.lastFile = e.file || ""; }
        row.files.push(e);
      }
      return Array.from(dirs.values()).sort(function (a, b) { return b.last - a.last; });
    }

    /** 目录行首徽标的 kind：有写显写、有改显改、其余取第一个 */
    function headKindOf(kinds) {
      var keys = Object.keys(kinds);
      if (keys.indexOf("write") >= 0) return "write";
      if (keys.indexOf("edit") >= 0) return "edit";
      if (keys.indexOf("delete") >= 0) return "delete";
      if (keys.indexOf("move") >= 0) return "move";
      return keys.length ? keys[0] : "view";
    }

    /* ══════════════════ 渲染 ══════════════════ */

    function kindBadge(kind, dim) {
      var el = document.createElement("span");
      el.className = "ftt-k " + kind + (dim ? " dim" : "");
      el.textContent = KIND_LABEL[kind] || "?";
      return el;
    }

    function eventRow(e, ctxDir) {
      var line = document.createElement("div");
      line.className = "ftt-row";
      line.appendChild(kindBadge(e.kind, e.conf < 1));
      var f = document.createElement("div");
      f.className = "ftt-file";
      var base = baseName(e.file || "");
      var dir = dirName(e.file || "");
      f.innerHTML = '<span class="ftt-dir">' + esc(dir === ctxDir ? "" : dir + "/") + "</span>" + esc(base);
      f.title = e.file || "";
      line.appendChild(f);
      if (e.err) {
        var erd = document.createElement("span");
        erd.className = "ftt-err";
        erd.title = "该次调用返回错误";
        line.appendChild(erd);
      }
      var t = document.createElement("span");
      t.className = "ftt-meta";
      t.textContent = timeStr(e.time);
      line.appendChild(t);
      return line;
    }

    function renderDirs() {
      var root = els.body;
      root.textContent = "";
      if (!state.events.length) {
        var emp = document.createElement("div");
        emp.className = "ftt-empty";
        emp.textContent = "本会话还没有文件活动记录。\nagent 使用 write / edit / pwsh 等工具动过文件后，\n这里会按目录聚合显示。";
        root.appendChild(emp);
        return;
      }
      var ctxDir = curSessionCwd();
      var sum = summarize(state.events);
      for (var _i = 0, sum_1 = sum; _i < sum_1.length; _i++) {
        var row = sum_1[_i];
        var j = _i;
        var line = document.createElement("div");
        line.className = "ftt-row click";
        line.appendChild(kindBadge(headKindOf(row.kinds)));
        var n = document.createElement("div");
        n.className = "ftt-dir-name";
        n.textContent = row.dir;
        n.title = row.dir;
        line.appendChild(n);
        var meta = document.createElement("div");
        meta.className = "ftt-meta";
        meta.textContent = row.count + " · " + timeStr(row.last);
        line.appendChild(meta);
        line.addEventListener("click", function () {
          state.expandedDir = state.expandedDir === sum[j].dir ? null : sum[j].dir;
          render();
        });
        root.appendChild(line);

        if (state.expandedDir === row.dir) {
          var sub = document.createElement("div");
          sub.className = "ftt-sub";
          row.files.slice(-30).forEach(function (e) { sub.appendChild(eventRow(e, ctxDir)); });
          root.appendChild(sub);
        }
      }
    }

    function renderTimeline() {
      var root = els.body;
      root.textContent = "";
      if (!state.events.length) {
        var emp = document.createElement("div");
        emp.className = "ftt-empty";
        emp.textContent = "本会话还没有文件活动记录。";
        root.appendChild(emp);
        return;
      }
      var ctxDir = curSessionCwd();
      for (var i = state.events.length - 1; i >= 0; i--) {
        var e = state.events[i];
        var line = eventRow(e, ctxDir);
        line.classList.add("click");
        line.addEventListener("click", function () {
          state.expandedEv = state.expandedEv === e.fseq ? null : e.fseq;
          render();
        });
        root.appendChild(line);
        if (state.expandedEv === e.fseq) {
          var d = document.createElement("div");
          d.className = "ftt-detail";
          d.textContent = e.tool + (e.turn != null ? " · turn " + e.turn : "") + (e.conf < 1 ? " · shell 启发式" : "");
          root.appendChild(d);
        }
      }
    }

    function curSessionCwd() {
      var sid = state.viewSid || state.sessionId;
      if (sid && state.sessionList) {
        for (var _i = 0, state_1 = state.sessionList; _i < state_1.length; _i++) {
          if (state_1[_i].id === sid) return (state_1[_i].cwd || "").replace(/[\\/]$/, "");
        }
      }
      return "";
    }

    function renderHead() {
      var cur = state.viewSid || state.sessionId;
      var sessionRow = state.sessionList.filter(function (s) { return s.id === cur; })[0];
      els.session.textContent = sessionRow && sessionRow.title
        ? sessionRow.title
        : cur ? cur.replace(/^session-/, "").slice(0, 12) : "等待会话…";
      els.session.title = sessionRow ? (sessionRow.cwd || "") : "";
    }

    function renderFoot() {
      els.dot.className = "ftt-dot" + (state.connOk ? "" : " err");
      els.footText.textContent = state.connOk
        ? "已连接 · 记录 " + state.events.length + " 条"
        : state.lastErr ? "连接失败：" + state.lastErr : "连接中…";
    }

    function render() {
      if (!els) return;
      els.panel.classList.toggle("open", state.open);
      els.tabDirs.classList.toggle("on", state.tab === "dirs");
      els.tabTl.classList.toggle("on", state.tab === "timeline");
      renderHead();
      if (state.tab === "dirs") renderDirs(); else renderTimeline();
      renderFoot();
    }

    /* ══════════════════ 数据轮询 ══════════════════ */

    function afterSeq() {
      return state.events.length ? state.events[state.events.length - 1].fseq : 0;
    }

    async function pollOnce() {
      clearTimeout(pollTimer);
      var cur = state.viewSid || state.sessionId;
      if (!cur) {
        pollTimer = setTimeout(pollOnce, POLL_ERR_MS);
        return;
      }
      try {
        var res = await fetch("/ft/events?sessionId=" + encodeURIComponent(cur) + "&after=" + afterSeq(), { cache: "no-store" });
        if (!res.ok) throw new Error("http-" + res.status);
        var json = await res.json();
        if (!json.ok) throw new Error(json.error || "bad response");
        state.connOk = true;
        state.lastErr = "";
        var fresh = json.events || [];
        if (fresh.length) {
          for (var _i = 0, fresh_1 = fresh; _i < fresh_1.length; _i++) state.events.push(fresh_1[_i]);
        }
        if (fresh.length || !state.open) {
          render();
        } else {
          renderFoot();
        }
      } catch (err) {
        state.connOk = false;
        state.lastErr = err && err.message ? err.message : String(err);
        renderFoot();
      } finally {
        pollTimer = setTimeout(pollOnce, state.connOk ? POLL_OK_MS : POLL_ERR_MS);
      }
    }

    async function pollSessions() {
      try {
        var res = await fetch("/ft/sessions", { cache: "no-store" });
        if (!res.ok) return;
        var json = await res.json();
        if (!json.ok) return;
        state.sessionList = json.sessions || [];
        render();
      } catch { /* 会话列表拿不到不致命 */ }
    }

    /** 切换视图会话：作废本地缓存,全量重拉一次。 */
    function resetView(sid) {
      state.events = [];
      state.expandedDir = null;
      state.expandedEv = null;
      clearTimeout(pollTimer);
      fetch("/ft/events?sessionId=" + encodeURIComponent(sid) + "&after=0", { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (json) {
          if (json && json.ok) {
            state.events = json.events || [];
            render();
          }
        })
        .catch(function () { });
      pollTimer = setTimeout(pollOnce, POLL_OK_MS);
    }

    function setOpen(v) {
      state.open = v;
      if (v) {
        if (els.panel) syncTheme(els.panel);
        var target = state.viewSid || state.sessionId;
        if (target && !state.events.length) resetView(target);
        pollSessions();
      }
      render();
      clearTimeout(pollTimer);
      pollTimer = setTimeout(pollOnce, POLL_OK_MS);
    }

    /* ══════════════════ DOM 构建（vanilla，直挂 body） ══════════════════ */

    function buildDom() {
      var style = document.createElement("style");
      style.setAttribute("data-marker", PACKAGE_ID);
      style.textContent = CSS + " " + CSS_TUNE;
      document.head.appendChild(style);

      var panel = document.createElement("div");
      panel.className = "ftt-panel";

      var head = document.createElement("div");
      head.className = "ftt-head";
      var title = document.createElement("div");
      title.className = "ftt-title";
      title.textContent = "文件活动";
      var session = document.createElement("div");
      session.className = "ftt-session";
      var close = document.createElement("div");
      close.className = "ftt-close";
      close.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4.28 3.22a.75.75 0 0 0-1.06 1.06L6.94 8l-3.72 3.72a.75.75 0 1 0 1.06 1.06L8 9.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L9.06 8l3.72-3.72a.75.75 0 0 0-1.06-1.06L8 6.94 4.28 3.22Z"/></svg>';
      close.addEventListener("click", function () { setOpen(false); });
      head.appendChild(title); head.appendChild(session); head.appendChild(close);

      var tabs = document.createElement("div");
      tabs.className = "ftt-tabs";
      var tabDirs = document.createElement("div");
      tabDirs.className = "ftt-tab";
      tabDirs.textContent = "动过的目录";
      var tabTl = document.createElement("div");
      tabTl.className = "ftt-tab";
      tabTl.textContent = "时间线";
      tabDirs.addEventListener("click", function () { state.tab = "dirs"; saveTab(); render(); });
      tabTl.addEventListener("click", function () { state.tab = "timeline"; saveTab(); render(); });
      tabs.appendChild(tabDirs); tabs.appendChild(tabTl);

      var body = document.createElement("div");
      body.className = "ftt-body";

      var foot = document.createElement("div");
      foot.className = "ftt-foot";
      var dot = document.createElement("span");
      dot.className = "ftt-dot";
      var footText = document.createElement("span");
      foot.appendChild(dot); foot.appendChild(footText);

      panel.appendChild(head); panel.appendChild(tabs); panel.appendChild(body); panel.appendChild(foot);
      document.body.appendChild(panel);

      // 主题跟随：给面板自己的 --ftt-* 变量赋值，界面明暗切换时重算
      syncTheme(panel);
      try {
        var themeObs = new MutationObserver(function () { syncTheme(panel); });
        themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
        if (window.matchMedia) {
          var mq = matchMedia("(prefers-color-scheme: dark)");
          if (mq.addEventListener) mq.addEventListener("change", function () { syncTheme(panel); });
        }
      } catch (e) { /* fail-open */ }

      // 面板拖动（按头柄）
      var drag = null;
      head.addEventListener("pointerdown", function (ev) {
        if (ev.target !== head && ev.target !== title && ev.target !== session) return;
        var r = panel.getBoundingClientRect();
        drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top };
        head.setPointerCapture(ev.pointerId);
      });
      head.addEventListener("pointermove", function (ev) {
        if (!drag) return;
        var L = Math.max(4, Math.min(window.innerWidth - 80, ev.clientX - drag.dx));
        var T = Math.max(4, Math.min(window.innerHeight - 60, ev.clientY - drag.dy));
        panel.style.left = L + "px";
        panel.style.top = T + "px";
      });
      head.addEventListener("pointerup", function () {
        if (!drag) return;
        drag = null;
        try {
          var r = panel.getBoundingClientRect();
          var st = readStore();
          st.left = r.left + "px";
          st.top = r.top + "px";
          localStorage.setItem(STORE_KEY, JSON.stringify(st));
        } catch { }
      });

      els = { panel: panel, tabDirs: tabDirs, tabTl: tabTl, body: body, dot: dot, footText: footText, session: session };

      try {
        var st = readStore();
        if (st.tab) state.tab = st.tab;
        if (st.left) {
          panel.style.left = st.left;
          panel.style.top = st.top;
        } else {
          // 没存过位置：默认贴右上角（三点菜单所在的那一带），首次拖动后记住。
          panel.style.left = Math.max(4, window.innerWidth - 396) + "px";
          panel.style.top = "52px";
        }
      } catch { }
    }

    function readStore() {
      try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {}; } catch { return {}; }
    }
    function saveTab() {
      try {
        var st = readStore();
        st.tab = state.tab;
        localStorage.setItem(STORE_KEY, JSON.stringify(st));
      } catch { }
    }

    /* ══════════════════ 三点菜单注入（DOM，不碰 React 状态树） ══════════════════ */

    var lastDotsAt = 0;
    var menuObs = null;

    /** 判断按钮是否官方"⋯"三点按钮：svg 里出现三个圆点 path（首条特征前缀）。 */
    function isDotsButton(btn) {
      try {
        var paths = btn.querySelectorAll("svg path");
        for (var i = 0; i < paths.length; i++) {
          var d = paths[i].getAttribute("d") || "";
          if (d.indexOf(DOTS_PATH_HEAD) === 0) return true;
        }
      } catch { }
      return false;
    }

    function onCaptureClick(ev) {
      try {
        var t = ev.target instanceof Element ? ev.target : null;
        var btn = t && t.closest ? t.closest("button") : null;
        if (btn && isDotsButton(btn)) lastDotsAt = Date.now();
      } catch { }
    }

    function scanMenus() {
      try {
        if (!document.body || Date.now() - lastDotsAt > MENU_WINDOW_MS) return;
        var menus = document.querySelectorAll('[role="menu"]');
        for (var i = 0; i < menus.length; i++) injectIntoMenu(menus[i]);
      } catch { }
    }

    function injectIntoMenu(menu) {
      try {
        if (menu.getAttribute("data-ftt-menu") === "1") return;
        if (menu.getAttribute("data-dockkit-tab-menu") === "true") return; // dockkit 标签菜单不掺和
        if (menu.querySelector("[data-ftt-item]")) { menu.setAttribute("data-ftt-menu", "1"); return; }
        var sample = menu.querySelector('button[role="menuitem"]');
        if (!sample) return; // 没有官方菜单项可借用样式就不硬塞

        var item = sample.cloneNode(true);
        item.removeAttribute("id");
        item.removeAttribute("disabled");
        item.removeAttribute("aria-keyshortcuts");
        item.setAttribute("data-ftt-item", "1");
        item.innerHTML = "";

        var spans = sample.querySelectorAll("span");
        var icon = document.createElement("span");
        icon.className = spans.length ? spans[0].className : "";
        icon.innerHTML = FOLDER_SVG;
        var label = document.createElement("span");
        label.className = spans.length > 1 ? spans[1].className : "";
        label.textContent = MENU_ITEM_LABEL;
        item.appendChild(icon);
        item.appendChild(label);
        item.addEventListener("click", function () {
          try { setOpen(true); } catch { }
          // 菜单根节点的官方 onClick 会找到 role=menuitem 并收起菜单；万一没生效再补一下 Escape。
          setTimeout(function () {
            try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); } catch { }
          }, 30);
        });

        if (sample.parentElement) sample.parentElement.appendChild(item);
        else menu.appendChild(item);
        menu.setAttribute("data-ftt-menu", "1");
      } catch { }
    }

    function installMenuHook() {
      try {
        if (menuObs || !window.MutationObserver || !document.body) return;
        document.addEventListener("click", onCaptureClick, true);
        menuObs = new MutationObserver(scanMenus);
        menuObs.observe(document.body, { childList: true, subtree: true });
        scanMenus();
      } catch (e) {
        try { console.warn("[dsh-file-tracker] 三点菜单注入初始化失败（不致命）：", e); } catch (_e) { }
        menuObs = null;
      }
    }

    /* ══════════════════ 会话锚点（React，不可见） ══════════════════ */

    function AnchorComponent(props) {
      React.useEffect(function () {
        var sid = typeof props.sessionId === "string" && props.sessionId ? props.sessionId : null;
        if (sid === state.sessionId) return;
        state.sessionId = sid;
        setOpen(false);
        if (sid) resetView(sid);
      }, [props.sessionId]);
      return React.createElement("span", { hidden: true, "aria-hidden": "true", "data-ftt-anchor": "1" });
    }

    var inject = ["slots"];

    function apply(ctx) {
      try {
        if (!els) buildDom();
      } catch (e) {
        try { console.error("[dsh-file-tracker] 面板构建失败：", e); } catch (_e2) { }
        return;
      }
      installMenuHook();
      try {
        ctx.slots.inject(SLOT_NAME, function () {
          return ctx.slots.register(
            {
              name: SLOT_NAME,
              id: ENTRY_ID,
              order: ENTRY_ORDER,
              label: function () { return "file tracker"; },
              inject: function (sessionId) { return { sessionId: sessionId }; },
            },
            function SlotComponent(props) {
              return React.createElement(AnchorComponent, props);
            },
          );
        });
      } catch (e) {
        // 注册失败只意味着锚点拿不到 sessionId：面板还能通过菜单入口打开，等会话回来自然接上。
        try { console.error("[dsh-file-tracker] 插槽注册失败：", e); } catch (_e3) { }
      }
      clearTimeout(pollTimer);
      pollTimer = setTimeout(pollOnce, POLL_OK_MS);
    }

    try {
      installStylesOnce();
    } catch (e) {
      try { console.error("[dsh-file-tracker] 样式安装失败（不致命）：", e); } catch (_e4) { }
    }
    function installStylesOnce() {
      if (document.querySelector('style[data-marker="' + PACKAGE_ID + '"]')) return;
      try {
        var s = document.createElement("style");
        s.setAttribute("data-marker", PACKAGE_ID);
        s.textContent = CSS;
        document.head.appendChild(s);
      } catch { }
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__internals = { state: state, summarize: summarize, timeStr: timeStr, dirName: dirName, baseName: baseName, headKindOf: headKindOf, isDotsButton: isDotsButton, scanMenus: scanMenus, injectIntoMenu: injectIntoMenu, CSS: CSS };

    // 新加载器（0.2.1）直接以工厂返回值为插件模块，apply 必须在这一层。
    // 旧写法 `return module`（apply 藏在 .exports 里）被判为"没有 apply"，会中止整个 web 界面启动。
    return module.exports;
  },
});
