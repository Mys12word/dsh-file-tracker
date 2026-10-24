# dsh-file-tracker · 文件活动监视器

[![version](https://img.shields.io/github/package-json/v/Mys12word/dsh-file-tracker?color=2ea043)](https://github.com/Mys12word/dsh-file-tracker)
[![license](https://img.shields.io/github/license/Mys12word/dsh-file-tracker?color=4d93f8)](LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-plugin-8250df)](https://github.com/Mys12word/dsh-file-tracker)

> 一个 DSH 双端插件：**让 agent 动过的文件，你当场就能看见。**

agent 说"我改好了"，到底改了哪几个文件？`dsh-file-tracker` 把每一轮里 write / edit / shell 调用碰过的路径抓出来，按「目录」和「时间线」两种视角摊开在 web GUI 里。不用翻日志，不用问它。

```
···  →  文件活动
        ┌──────────────────────────────┐
        │ 动过的目录 │ 时间线           │
        │ 📁 nvidia-driver/x64   2 次   │
        │    7za.exe          14:03:11 │
        │ 📁 src                  5 次   │
        │    client.js        14:05:02 │
        └──────────────────────────────┘
```

## 它做什么

**宿主半边**（Cordis host）监听 `session/event` 的 `tool/call`，把工具参数里的路径解析出来，按「会话 → 目录 → 文件」聚合，并逐行落盘。

| 识别方式 | 工具 | 置信度 |
|---|---|---|
| 精确参数解析 | `write` `edit` `read` `read_image` `move` `copy` `delete` `glob` `grep` `ops_glob` `ops_grep` | 1.0 |
| 命令串启发式 | `pwsh` `powershell` `shell` `bash` `sh` `cmd` `terminal` | 0.6（半透明徽章） |

**客户端半边**在 web GUI 里挂一个面板，两个视图：

- **动过的目录** — 每个被碰过的目录一行，带改动次数、最近一次动的文件与时间；点开看该目录下的文件明细。
- **时间线** — 逐条事件倒序，失败的调用标红点；点开看工具名与 turn/step 号。

徽章含义：

| 写 | 改 | 读 | 看 | 移 | 删 | 壳 |
|---|---|---|---|---|---|---|
| `write` | `edit` | `read` | `glob`/`grep` | `move` | `delete` | `pwsh` 等命令 |

## 安装

前置：DSH Desktop，Node ≥ 22。

```powershell
git clone https://github.com/Mys12word/dsh-file-tracker "$HOME\.dsh\plugins\dsh-file-tracker"
powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\.dsh\plugins\dsh-file-tracker\install-profile.ps1"
```

脚本只做三件事，都可手动完成：

1. 往 profile `package.json` 的 `dependencies` 写 `"dsh-file-tracker": "link:<插件绝对路径>"`
2. 往 `dsh.profile.bundles` 数组里加 `dsh-file-tracker`
3. 在 `~/.dsh/profiles/<profile>/node_modules/` 建 junction

**完全退出并重启 DSH Desktop 后生效。** 只刷新页面不够——bundle 列表在启动时读取。

## 数据面 API

同源 HTTP，loopback 信任栅栏：非 `127.0.0.1` Host 或跨站 Origin 一律 403。

| 端点 | 说明 |
|---|---|
| `GET /ft/events?sessionId=<id>&after=<fseq>` | 增量拉事件，`after` 为游标 |
| `GET /ft/summary?sessionId=<id>` | 目录聚合视图 |
| `GET /ft/sessions` | 会话列表（含 cwd、标题） |

## 数据文件

`~/.dsh/file-tracker/events.jsonl` — 追加式 JSONL，单行一条：

```json
{"fseq":387,"sid":"session-…","cwd":"C:\\…","tool":"pwsh","turn":13,"step":1,"kind":"shell","file":"nvidia-driver/x64","dir":"nvidia-driver","conf":0.6}
```

超过 **8 MB** 自动截断，保留最近 1000 行。删掉整个 `~/.dsh/file-tracker/` 目录即可重置，不影响任何其他功能。

## 设计要点

- **fail-open**：每条事件的解析、每个客户端 DOM 副作用都包在 `try/catch` 里。插件自身出问题绝不打断宿主 turn，也绝不弄白你的界面。
- **壳类是启发式**：它只回答"大概动了哪个目录"，别拿它当审计证据。要精确就让工具用 `file_path` 参数。
- **配色自持**：不依赖宿主的语义令牌（那些令牌在浮层里对比度很低），面板自带 `--ftt-*` 调色板，按当前界面背景亮度自动选亮/暗，并用 `MutationObserver` 跟随主题切换。
- **零配置**：没有设置项，装完就有。

## 已知限制

- 面板锚定**当前对话**的会话。从侧边栏其他会话行打开，看到的仍是当前会话的事件（v1 行为）。
- 目录/路径是从**命令原文**里抠出来的，所以注册表键（`HKLM:\…`）、URL 之类偶尔也会入列——那是 agent 敲过的字面串，不代表真的碰了文件系统。
- 只记录**当前进程生命周期**内新发生的事件，不回溯历史会话的事件流（历史 JSONL 仍在磁盘上）。

## FAQ

**「壳」是什么意思？**
shell 类事件的缩写徽章——这次操作是**执行命令**，不是读写文件，所以它带的路径是启发式猜出来的（0.6 置信度，半透明显示）。

**为什么面板里出现了 `HKLM:\SYSTEM\…`？**
同上：那是命令文本里的字面路径，被"壳类"启发式抓到了。它可能只是 `Get-ItemProperty` 在读注册表。

**面板为什么不刷新？**
宿主侧 webServer 不可用时会退化为"只收集不路由"，重启后自动补齐。客户端每 1.2 s 轮询一次，失败退避到 4 s。

## 开发

```powershell
node --check lib/index.js
node --check lib/client.js
node test/client.test.mjs    # 19 项断言
node test/host.test.mjs      # 24 项断言
```

客户端是 vanilla DOM（不引 React），打包契约：`window.__ModuleLoader__.load({ id, factory })` 的 **factory 返回值本身就是模块体**，`apply` / `inject` 必须在顶层，文件以 `return module.exports;` 结尾。

## License

MIT
