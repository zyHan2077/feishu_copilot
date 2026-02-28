# Feishu Copilot Bot — Copilot Instructions

## Copilot Role: Server Administrator

**You (Copilot) are the administrator of this Feishu bot backend server** (`/home/ubuntu/feishu_copilot`).

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
      └── tmux session (named after project)
            └── GitHub Copilot CLI  (`gh copilot` / `copilot` session)
```

---

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

Primary developer commands (slash-prefixed; no @mention required):

| User message | Bot action |
|---|---|
| `/on` (alias: `启动 copilot` / `start copilot`) | Start a Copilot session inside the tmux session (see §4.1). Only one session per workdir allowed. |
| `/off` (alias: `停止 copilot` / `stop copilot`) | Send `q` + Enter to the Copilot pane, then kill the pane. |
| `/id` / `whoami` | Reply with the sender's `open_id`. |
| `/h` / `/help` / `help` / `帮助` | Show command reference. |
| `/log <subcmd>` (or `查看日志 <subcmd>`) | Query the session log (see §6). |
| `/init <workdir> <project> <devs>` | Re-initialise (allowed from existing devs). |
| Any other `/` command | Forwarded verbatim to the Copilot pane. |

Non-slash text from a developer (no `/` prefix) is **forwarded directly to the Copilot pane** without any command matching.

#### 4.1 Starting a Copilot session
```bash
# Inside the named tmux session, create a new window called "copilot"
tmux new-window -t <project> -n copilot
tmux send-keys -t <project>:copilot "copilot" Enter
```
- If a window named `copilot` already exists in the session, reply: `⚠️ Copilot session 已在运行。`
- After starting, poll the pane until the first prompt appears (timeout 15 s), then relay output to the group.

### 5. Forwarding messages to Copilot

When the Copilot session is running and a developer sends any text that is **not** a slash-command:
1. Strip any @mention prefix from the message.
2. Send the text as keystrokes to the Copilot pane:
   ```bash
   tmux send-keys -t <project>:copilot "<user message>" Enter
   ```
3. If a previous forward is still pending, reply: `⏳ Copilot 仍在执行，请稍候…` and do not re-send.
4. **Do not echo the user's message back to the group.**
5. Poll the tmux pane output (every 500 ms) until idle for ≥ 2 s (or 60 s timeout):
   - Capture: `tmux capture-pane -t <project>:copilot -p`
   - Diff against the pre-send snapshot to extract only new lines.
   - Strip ANSI escape codes, separator lines, box borders, spinners, shell prompts.
   - Relay cleaned output to the group.

#### 5.1 Interactive / keyboard-choice prompts
Copilot CLI sometimes presents a numbered or Y/N menu. When new pane output contains a recognised prompt pattern:
- Detect lines matching: `^\s*[\d]+[.)]\s+`, `\[Y/n\]`, `\[y/N\]`, `(yes/no)`, `Press enter`, `↑/↓`, or similar.
- Forward the prompt text to the group as-is.
- The next message from the developer in the group is treated as the raw keystroke(s) to send:
  - Single digit → send that digit + Enter.
  - `y` / `yes` → send `y` + Enter.
  - `n` / `no` → send `n` + Enter.
  - Any other text → send verbatim + Enter.
- This normalises all interactive prompts to standard IM input.

### 6. Log persistence

- All tmux pane output is continuously appended to `<workdir>/copilot_session.log`.
- Implement a background loop (every 5 s) that captures the full pane and appends new lines to the log file.
- Log lines are prefixed with an ISO-8601 timestamp: `[2026-02-24T03:51:00Z] <line>`.

Developer log-query commands:
```
/log tail [N]           → tail -n N  <workdir>/copilot_session.log  (default 50)
/log head [N]           → head -n N  <workdir>/copilot_session.log  (default 50)
/log grep <pattern>     → grep <pattern> <workdir>/copilot_session.log
/log sed <expr>         → sed <expr> <workdir>/copilot_session.log
/log awk <expr>         → awk <expr> <workdir>/copilot_session.log
/log wc [flags]         → wc <flags> <workdir>/copilot_session.log
/log cat                → cat <workdir>/copilot_session.log
```
Legacy prefix `查看日志 <subcmd>` is normalised to `/log <subcmd>` internally.
The bot executes the command and returns its stdout (truncated to ≤ 4000 chars to stay within Feishu message limits).

### 7. Progress tracking

- After every significant state change (**init**, **copilot stop**), the bot appends an entry to `<workdir>/progress.md`:

  ```markdown
  ## 26-02-24-03-51  初始化完成
  工作目录: /home/ubuntu/projects/myapp
  项目名称: myapp
  开发人员: ou_alice, ou_bob
  tmux session: myapp
  ```

- The incremental update content is also **sent to the Feishu group** immediately after being written.

---

## State File Schema (`<workdir>/.feishu_copilot_state.json`)

```jsonc
{
  "chat_id": "oc_xxxxxxxx",        // Feishu group chat ID
  "workdir": "/absolute/path",
  "project": "myapp",
  "devs": ["ou_alice", "ou_bob"],  // open_id list
  "copilot_running": false,
  "initialized_at": "2026-02-24T03:51:00Z"
}
```

---

## Feishu API Reference (key endpoints)

| Action | Endpoint |
|---|---|
| Send group message | `POST /im/v1/messages?receive_id_type=chat_id` |
| Rename group | `PUT /im/v1/chats/{chat_id}` body `{ "name": "..." }` |
| Get user info | `GET /contact/v3/users/{user_id}` |
| Receive events | Webhook POST to `/webhook/event` (configured in Feishu Open Platform) |

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

### Webhook 验签说明（加密模式）

飞书开启 Encrypt Key 后，事件以 `{ "encrypt": "..." }` 形式到达。解密流程：

1. `key = SHA256(encryptKey)` 的前 32 字节
2. `buf = base64decode(encrypted)`
3. `iv = buf[0:16]`，`ciphertext = buf[16:]`
4. AES-256-CBC 解密 → JSON

解密成功后，用**解密后的 body** 做 token 验证：
- v1 事件：`body.token === FEISHU_VERIFICATION_TOKEN`
- v2 事件：`body.header.token === FEISHU_VERIFICATION_TOKEN`

> ⚠️ **常见 Bug**：用加密原文（`req.body = { encrypt: "..." }`）做 token 验证，永远失败 → 返回 401 → 事件丢弃。
> **正确做法**：解密后将 decryptedBody 传入验签函数，用 decryptedBody 的 token 字段比对。

飞书 X-Lark-Signature 的正确算法是 **SHA256**（非 HMAC）：
```
signature = sha256(timestamp + nonce + encryptKey + rawBody).hexdigest()
```

### 订阅事件类型

飞书开放平台需订阅以下事件，机器人才能正常工作：

| 事件 | 用途 |
|---|---|
| `im.message.receive_v1` | 收到群消息（@mention） |
| `im.chat.member.bot.added_v1` | 机器人被邀请进群 → 自动发初始化提示 |

---

## Coding Guidelines

- Language: **TypeScript** (Node.js ≥ 20).
- Use `child_process.execSync` / `spawnSync` for tmux commands (synchronous is fine for short commands; use async `spawn` for polling loops).
- Feishu event webhook uses **signature verification** — always validate `X-Lark-Signature` before processing.
- Never log `APP_SECRET` or tokens to files or console.
- All user-facing strings default to **Simplified Chinese**; keep English as code comments.
- Keep each source file under 300 lines; split if larger.
- Write JSDoc for all exported functions.
