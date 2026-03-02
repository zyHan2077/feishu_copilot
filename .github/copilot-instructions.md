# Feishu Copilot Bot — Copilot Instructions

## Copilot Role: Server Administrator and Developer

**You (Copilot) are the administrator and Developer of this Feishu bot backend server** (`/home/ubuntu/feishu_copilot`). Everytime you make meaningful or substantial change to the server code, configuration, deployment process, or you learned anything that is relevant and important to memorize, you must update this instruction file with the new rules, commands, and procedures. This file serves as the main source of truth for how to operate and maintain the server, so it must be kept up-to-date and accurate at all times.

### Server Startup Rules (MANDATORY — no exceptions)

1. **Always use npm** to start or restart the server — never run `node dist/index.js` directly, never use `pm2`, `forever`, or any other process manager.
2. **Always run inside tmux session `copilot-feishu`** — the npm process MUST live in that session.
3. **Auto-create the tmux session if it does not exist**:
   ```bash
   tmux has-session -t copilot-feishu 2>/dev/null || tmux new-session -d -s copilot-feishu -c /home/ubuntu/feishu_copilot
   ```
4. **Start/restart the server**:
   ```bash
   # Build first if source has changed
   tmux send-keys -t copilot-feishu "cd /home/ubuntu/feishu_copilot && npm run build && npm start" Enter
   ```
5. **Do NOT use any other method** (background `&`, `nohup`, `disown`, direct `node`, etc.) to launch the npm process.  
   The only permitted launch path is: tmux session `copilot-feishu` → npm script.

### Quick Reference

| Task | Command |
|---|---|
| Ensure tmux session exists | `tmux has-session -t copilot-feishu 2>/dev/null \|\| tmux new-session -d -s copilot-feishu -c /home/ubuntu/feishu_copilot` |
| Start server | `tmux send-keys -t copilot-feishu "npm run build && npm start" Enter` |
| View server output | `tmux attach -t copilot-feishu` (or capture-pane) |
| Check if running | `tmux list-windows -t copilot-feishu` |

---

## Project Overview

This project implements a Feishu (Lark) enterprise group-chat bot that bridges developer conversations to a GitHub Copilot CLI session running on the host server. The bot manages tmux sessions, persists logs, and relays Copilot output back to the group chat.

---

## Architecture

```
Feishu Group Chat
      │  (webhook / event subscription)
      ▼
feishu_copilot server  (Node.js / TypeScript, runs on host)
      │
      ├── State store  (per-group JSON, stored in workdir)
      │
      ├── POST /mcp  ← Persistent HTTP MCP server (shared by all Copilot sessions)
      │     └── Resolves target thread via ?chat_id=&session= query params
      │
      └── tmux session (named after project)
            └── GitHub Copilot CLI  (`copilot` session)
                  └── HTTP POST /mcp?chat_id=...&session=...
```

### MCP Server Design

The MCP server is **persistent** — it runs as part of the main Express server on `POST /mcp`, not as a per-session subprocess.

**Thread routing logic:**
- When `/on` is called, `writeMcpConfig(chatId, sessionLabel)` writes `~/.copilot/mcp-config.json` with `{ "mcpServers": { "feishu": { "url": "http://localhost:<PORT>/mcp?chat_id=<chat_id>&session=<session_label>" } } }`
- Copilot CLI reads this config and sends all MCP tool calls as HTTP POSTs to that URL
- The `/mcp` handler reads `chat_id` + `session` from query params → calls `getStateByChatId()` → finds the session → uses `anchor_msg_id` to send to the right Feishu thread
- **No `FEISHU_WORKDIR` env var needed** — routing is precise via chat_id + session_label


## Core Rules

### 1. Group-only operation
- The bot **must ignore all direct/private messages**. Only events from group chats (`chat_type == "group"`) are processed.
- On receiving any direct message, the bot does nothing (no reply).

### 2. Group initialisation flow

When the bot is first added to a group (or when it receives the first `@mention` in a group with no saved state), it must:

1. Reply asking the user to provide:
   - **Working directory** (absolute path on the server, e.g. `/home/ubuntu/projects/myapp`)
   - **Project name** (single word / slug, used as tmux session name and chat title suffix)
   - **Developer list** (comma-separated Feishu `open_id` values)

   Example prompt:
   ```
   👋 请设置以下信息来初始化项目：
   1. 服务器工作目录（绝对路径）
   2. 项目名称（英文，无空格）
   3. 开发人员（飞书 open_id，逗号分隔）

   格式：/init <工作目录> <项目名称> <开发人员1,开发人员2>
   ```

2. On receiving `/init <workdir> <project> <devs>`:
   - Persist `{ workdir, project, devs, chat_id }` to `<workdir>/.feishu_copilot_state.json`.
   - Create `<workdir>` if it does not exist (`mkdir -p`).
   - Rename the Feishu group to `<project>开发群` via the Feishu API.
   - Create a tmux session named `<project>`: `tmux new-session -d -s <project> -c <workdir>`.
   - Run `tree -L 1 <workdir>` and return the output to the group.
   - Reply: `✅ 初始化完成！工作目录：<workdir>，tmux session：<project>`

### 3. Developer-only access control

After initialisation:
- The bot processes **all group messages** (not just @mentions — @mention prefixes are stripped but not required).
- **Only users listed in `devs`** receive functional responses.
- If a non-developer sends a slash-command, the bot replies:
  ```
  ⚠️ 抱歉，只有开发人员才能操作此机器人。
  ```
- Non-slash messages from non-developers are **silently ignored** (no reply).
- The bot extracts the sender's `open_id` from the event and compares it against the stored `devs` list.

### 4. Copilot session management

The bot supports **multiple concurrent Copilot sessions** per group, each with its own tmux window and Feishu thread.

Primary developer commands:

| Context | Command | Bot action |
|---|---|---|
| Main chat | `/on [model=<name>]` (alias: `启动 copilot` / `start copilot`) | Start a new Copilot session; creates a new Feishu thread. Optional `model=` sets `copilot --model <name>`. |
| Main chat | `/resume session-id=<UUID>` | Create a new thread and resume the given session via `copilot --resume=<UUID>`. |
| Main chat | `/id` / `whoami` | Reply with the sender's `open_id`. |
| Main chat | `/h` / `/help` / `help` / `帮助` | Show command reference. |
| Main chat | `/log <subcmd>` (or `查看日志 <subcmd>`) | Query the session log (see §6). |
| Main chat | `/init <workdir> <project> <devs>` | Re-initialise (allowed from existing devs). |
| Thread | Any non-slash text | Forwarded verbatim to the Copilot TUI. |
| Thread | `/exit` | Gracefully exit the session (see §4.2). |
| Thread | `/resume` | Resume the most-recently-ended session in this same thread (see §4.3). |

#### 4.1 Starting a Copilot session (`/on`)

- A `session_label` of the form `"<project>-YYMMDD-HHMM"` is generated **before** copilot starts. This becomes the **tmux window name**.
- Start command: `copilot` (or `copilot --resume=<UUID>` if a resume ID was provided).
- After starting, poll the pane until the first prompt appears (timeout 15 s), then create a Feishu thread (话题).

```bash
# First /on: create session with first window named after session_label
tmux new-session -d -s <project> -c <workdir> -n <session_label>
tmux send-keys -t <project>:<session_label> -l "copilot"
tmux send-keys -t <project>:<session_label> Enter

# Subsequent /on (session exists, create new window):
tmux new-window -t <project> -n <session_label>
tmux send-keys -t <project>:<session_label> -l "copilot"
tmux send-keys -t <project>:<session_label> Enter
```

> ⚠️ **send-keys must use two separate calls** (text with `-l` flag, then `Enter` separately). Combining them in one spawnSync call silently drops the Enter keystroke in TUI mode.

#### 4.2 Exiting a session (`/exit` in thread)

1. Send `/exit` to the Copilot TUI.
2. Poll for idle output (15 s).
3. Extract UUID: regex `/copilot --resume=([0-9a-f-]{36})/` from the raw output.
4. Post exit summary to the thread: `🛑 Session 已结束\n\n<output>`.
5. If UUID found, call `editMessage(thread_first_msg_id, ready_text + '\n🔑 Resume: copilot --resume=<UUID>')` to append the resume ID to the "已就绪" message.
6. Kill the tmux window.
7. Update state: `is_running=false`, `ended_at`, `copilot_resume_id=uuid`.

#### 4.3 Resuming a session (`/resume` in thread)

Allowed only if the session for this thread is the **most recently ended** session for the chat (determined by `ended_at` order in `sessions[]`). Starts a new tmux window with a new `session_label` and sends `copilot --resume=<UUID>`; I/O continues in the same thread.
- See **[docs/copilot-cli-tmux.md](../docs/copilot-cli-tmux.md)** for full details on PTY mode, send-keys usage, and pitfalls.

### 5. Forwarding Messages to Copilot

Non-slash developer messages → strip @mention → snapshot baseline → `sendKeys(text)` + separate `sendKeys(Enter)` → poll until idle (500 ms interval, 2 s idle threshold, 60 s timeout) → diff output → clean → relay to thread.

> ⚠️ **send-keys critical rule**: always use **two separate `spawnSync` calls** — one for the text (with `-l` literal flag), one for `Enter`. Combining them as `['send-keys', ..., text, 'Enter']` silently drops the Enter keystroke when targeting a TUI (verified on Copilot CLI). This affects every message forwarded to Copilot.

See **[docs/bot-behavior.md §5](../docs/bot-behavior.md)** for full details: interactive prompt handling, output cleaning patterns, and concurrent-request guard.

### 6. Log Persistence

Background loop (every 5 s) appends new pane lines (ISO-8601 prefixed) to `<workdir>/copilot_session.log`. Developer commands: `/log tail|head|grep|sed|awk|wc|cat [args]` (output truncated to 4000 chars). See **[docs/bot-behavior.md §6](../docs/bot-behavior.md#6-log-persistence)**.

### 7. Progress Tracking

On significant state changes (init, copilot stop), append a timestamped entry to `<workdir>/progress.md` and send it to the group. See **[docs/bot-behavior.md §7](../docs/bot-behavior.md#7-progress-tracking)**.

---

## State File Schema (`<workdir>/.feishu_copilot_state.json`)

```jsonc
{
  "chat_id": "oc_xxxxxxxx",
  "workdir": "/absolute/path",
  "project": "myapp",
  "devs": ["ou_alice", "ou_bob"],
  "initialized_at": "2026-02-24T03:51:00Z",
  "sessions": [
    {
      "session_label": "myapp-260301-0133",   // tmux window name; generated at /on time
      "thread_id": "omt_xxx",
      "anchor_msg_id": "om_xxx",              // "启动中" message in main chat
      "thread_first_msg_id": "om_yyy",        // "已就绪" message (edited after /exit)
      "ready_text": "✅ Copilot 已就绪…",     // original text for edit reconstruction
      "copilot_resume_id": "9610b4bb-…",      // UUID from exit output (only after /exit)
      "started_at": "2026-03-01T01:33:00Z",
      "ended_at": "2026-03-01T01:35:00Z",
      "is_running": false
    }
  ]
}
```

---

## Feishu API Reference (key endpoints)

| Action | Endpoint |
|---|---|
| Send group message | `POST /im/v1/messages?receive_id_type=chat_id` |
| Reply & create thread | `POST /im/v1/messages/{message_id}/reply` (body: `reply_in_thread: true`) |
| Send to thread | `POST /im/v1/messages?receive_id_type=thread_id` |
| Update thread name | `PATCH /im/v1/threads/{thread_id}` (body: `{ "name": "..." }`) — **⛔ returns 404, not supported** |
| Edit message content | `PUT /im/v1/messages/{message_id}` (body: `{ msg_type, content }`) — supports **text** and **post** (rich text) only; card messages use a different API |
| Rename group | `PUT /im/v1/chats/{chat_id}` body `{ "name": "..." }` |
| Add emoji reaction | `POST /im/v1/messages/{message_id}/reactions` (body: `{ reaction_type: { emoji_type: "Get" } }`) |
| Get user info | `GET /contact/v3/users/{user_id}` |
| Receive events | Webhook POST to `/webhook/event` (configured in Feishu Open Platform) |

> ⚠️ **Emoji reactions require** the `im:message.reactions:write_only` scope on the bot app (Feishu Open Platform → app → Auth → 机器人 scopes). Emoji type strings are **case-sensitive**: `"Get"` = 了解, `"THUMBSUP"` = 👍, `"OK"` = OK.

> ⚠️ **Thread API response quirk**: `POST /im/v1/messages/{id}/reply` returns the new message at `resp.data.data` directly — there is **no** `resp.data.data.message` nesting layer. See **[docs/feishu-thread-api.md](../docs/feishu-thread-api.md)** for full thread API details and the thread-detection strategy.

All API calls require a tenant access token obtained via:
```
POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal
{ "app_id": "<APP_ID>", "app_secret": "<APP_SECRET>" }
```

---

## Environment Variables

```
FEISHU_APP_ID=cli_xxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx
FEISHU_VERIFICATION_TOKEN=xxxxxxxx   # event verification
FEISHU_ENCRYPT_KEY=xxxxxxxx          # optional, if encryption enabled
PORT=3000                             # HTTP server port
```

---

## File Layout

```
feishu_copilot/
├── .github/
│   └── copilot-instructions.md   # ← this file
├── src/
│   ├── index.ts          # HTTP server entry point
│   ├── feishu/
│   │   ├── client.ts     # Feishu API wrapper (send message, rename chat, etc.)
│   │   └── webhook.ts    # Incoming event handler & verification
│   ├── bot/
│   │   ├── router.ts     # Route @mention commands to handlers
│   │   ├── init.ts       # /init flow
│   │   ├── copilot.ts    # Start/stop Copilot session, forward messages
│   │   ├── log.ts        # Log query handler
│   │   └── progress.ts   # progress.md writer + Feishu notifier
│   ├── tmux/
│   │   └── manager.ts    # tmux create/send/capture helpers
│   └── state/
│       └── store.ts      # Read/write .feishu_copilot_state.json
├── progress.md           # project-level progress log (this repo)
├── package.json
├── tsconfig.json
└── .env.example
```

---

## Server Management (运维指南)

### 启动 Server

```bash
# Ensure tmux session exists
tmux has-session -t copilot-feishu 2>/dev/null || tmux new-session -d -s copilot-feishu -c /home/ubuntu/feishu_copilot

# Build (if source changed) and start
tmux send-keys -t copilot-feishu "cd /home/ubuntu/feishu_copilot && npm run build && npm start" Enter
```

- 健康检查：`curl http://localhost:8888/health`
- 端口由 `.env` 中 `PORT` 控制，默认 `8888`

> ⚠️ **必须**在 tmux session `copilot-feishu` 内通过 npm 脚本启动，**禁止**直接运行 `node dist/index.js`、使用 `nohup`、`disown`、`pm2` 或其他方式。

### 查看日志

```bash
tmux capture-pane -t copilot-feishu -p | tail -50
# 或 attach 实时查看
tmux attach -t copilot-feishu
```

### 查找并重启 Server

```bash
# 查看 tmux session 中运行的进程
tmux list-windows -t copilot-feishu

# 重新构建并启动（会覆盖 tmux 窗口中的旧进程）
tmux send-keys -t copilot-feishu "C-c" ""   # 先停止旧进程
tmux send-keys -t copilot-feishu "cd /home/ubuntu/feishu_copilot && npm run build && npm start" Enter
```

> ⚠️ **禁止**使用 `pkill` / `killall`，若需要 kill 进程必须用 `kill <PID>`（数字 PID）。

> ⚠️ **禁止**向 PTY 从设备（`/dev/pts/N`）写入任何内容来驱动 Copilot CLI 输入——这会破坏 TUI 渲染状态，导致 `tmux send-keys` 失效。正确方法是始终通过 `tmux send-keys -t <target> text Enter`。
> 详见 **[docs/copilot-cli-tmux.md](../docs/copilot-cli-tmux.md)**。

### 调试 Copilot CLI 交互时的注意事项

- 优先使用**快速命令**（`/model`、`/context`、`/help`）验证 send-keys 通路，避免等待 LLM 响应。
- 测试 LLM 实际响应时，先执行 `/model gpt-5-mini`——该模型在 Copilot Pro 计划中**免费**（不消耗 premium 配额）。
- **⚠️ 直接调用 `copilot` 命令时**，必须加 `--model gpt-5-mini` 参数（`copilot --model gpt-5-mini`）以节省费用。
- 每次 `/on` 产生**一个 tmux 窗口**，窗口名 = `session_label`（形如 `project-YYMMDD-HHMM`）。`new-session` 时传 `-n <session_label>` 来避免额外的空 bash 窗口。

### 架构变更后的必做清理（Schema/tmux 管理方式变动后）

每次对 tmux session 管理方式或 state schema 进行重大变更（如重命名窗口命名规则、新增/删除 state 字段、改变 session 生命周期），必须执行以下清理步骤，确保用户有 fresh start：

1. **列出并杀掉所有由程序创建的 project tmux session**（保留 `copilot-feishu`、`qinji`、`web` 等基础设施 session）：
   ```bash
   # 查找所有 project session（不是 copilot-feishu / qinji / web）
   tmux list-sessions
   # 按需 kill：
   tmux kill-session -t <project_name>
   ```

2. **检查并重写所有 state 文件到新 schema**（删除废弃字段，确保符合当前 `BotState` 接口）：
   ```bash
   find /home -name '.feishu_copilot_state.json' 2>/dev/null
   # 用 python3 重写成新格式，保留 chat_id/workdir/project/devs/initialized_at，sessions=[]
   ```

3. **重启 server**（使新 dist 生效）：
   ```bash
   tmux send-keys -t copilot-feishu "C-c" ""
   tmux send-keys -t copilot-feishu "npm run build && npm start" Enter
   ```

### Webhook 验签 & 事件订阅

加密模式下用 AES-256-CBC 解密后再做 token 验证；签名算法是 `sha256(timestamp+nonce+encryptKey+rawBody)`。  
需订阅事件：`im.message.receive_v1`（群消息）、`im.chat.member.bot.added_v1`（bot 入群）。  
详见 **[docs/feishu-webhook.md](../docs/feishu-webhook.md)**（含常见验签 Bug 说明和消息字段参考）。

---

## Coding Guidelines

- Language: **TypeScript** (Node.js ≥ 20).
- Use `child_process.execSync` / `spawnSync` for tmux commands (synchronous is fine for short commands; use async `spawn` for polling loops).
- Feishu event webhook uses **signature verification** — always validate `X-Lark-Signature` before processing.
- Never log `APP_SECRET` or tokens to files or console.
- All user-facing strings default to **Simplified Chinese**; keep English as code comments.
- Keep each source file under 300 lines; split if larger.
- Write JSDoc for all exported functions.
