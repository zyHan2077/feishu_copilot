# Feishu Copilot Bot

一个飞书（Lark）企业群聊机器人，将开发者的群聊消息桥接到服务器上运行的 **GitHub Copilot CLI** 或 **Claude Code** 会话，实现团队共同操控 AI 编程助手。

---

## 功能特性

- 📨 接收飞书群消息，转发给 AI 助手，并将响应回传到同一话题（thread）
- 🪟 支持多个并发会话，每个会话对应独立的 tmux 窗口/子进程和飞书话题
- 🔒 开发者白名单访问控制
- 📝 会话日志持久化，支持 `/log` 命令查询
- 🔁 会话恢复（`/resume`），通过 CLI 的 `--resume` 机制续接历史对话
- 🛠️ 持久 HTTP MCP Server，为 AI CLI 提供飞书消息推送工具
- 🤖 **双引擎支持**：GitHub Copilot CLI + Claude Code

---

## 架构

```
飞书群聊
  │  (Webhook / 事件订阅)
  ▼
feishu_copilot server  (Node.js / TypeScript, Express)
  │
  ├── 状态存储 (per-group JSON, 存储于工作目录)
  │
  ├── POST /mcp  ← 持久 HTTP MCP 服务（所有会话共享）
  │     └── 通过 ?chat_id=&session= 路由到目标话题
  │
  └── tmux session (以项目名命名)
        │
        ├── GitHub Copilot CLI 窗口 (Copilot 会话)
        │     └── HTTP POST /mcp?chat_id=...&session=...
        │
        └── Claude Code 子进程 (Claude 会话，无 tmux)
              └── HTTP POST /mcp?chat_id=...&session=...
```

**MCP Server 设计：**
- MCP 服务作为持久 HTTP 服务运行在主 Express 服务器上（`POST /mcp`）
- Copilot CLI 或 Claude Code 通过配置文件调用此 HTTP 端点
- 通过 `chat_id` + `session` 查询参数路由到正确的飞书话题

---

## 快速开始

### 1. 前置条件

- Node.js 20+
- [tmux](https://github.com/tmux/tmux)
- [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line) (`copilot` 命令已登录)
- [Claude Code](https://claude.ai/code) (`claude` 命令已登录)
- 飞书开放平台应用（需要以下权限）：
  - `im:message`、`im:message:send_as_bot`
  - `im:chat`、`im:chat:update`
  - `im:message.reactions:write_only`
  - `contact:user.base:readonly`

### 2. 安装依赖

```bash
git clone <repo-url>
cd feishu_copilot
npm install
```

### 3. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，填入真实值：

```env
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
FEISHU_VERIFICATION_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# FEISHU_ENCRYPT_KEY=xxxxxxxx   # 若启用了加密则取消注释
PORT=8888
```

> ⚠️ **请勿将 `.env` 提交到 git**，该文件已被 `.gitignore` 排除。

### 4. 启动服务器

服务器**必须**在 tmux session `copilot-feishu` 中通过 npm 启动：

```bash
# 确保 tmux session 存在
tmux has-session -t copilot-feishu 2>/dev/null || \
  tmux new-session -d -s copilot-feishu -c /home/ubuntu/feishu_copilot

# 构建并启动
tmux send-keys -t copilot-feishu \
  "cd /home/ubuntu/feishu_copilot && npm run build && npm start" Enter
```

健康检查：

```bash
curl http://localhost:8888/health
```

### 5. 配置飞书 Webhook

在飞书开放平台 → 事件订阅中，将 **Request URL** 设置为：

```
https://<your-domain>/webhook/event
```

需订阅事件：
- `im.message.receive_v1`（群消息）
- `im.chat.member.bot.added_v1`（机器人入群）

---

## 使用方法

### 初始化群组

将机器人添加到飞书群后，发送：

```
/init <工作目录> <项目名称> <开发者open_id1,开发者open_id2>
```

示例：

```
/init /home/ubuntu/myapp myapp ou_alice123,ou_bob456
```

### 主要命令

#### 主聊天命令

| 命令 | 说明 |
|------|------|
| `/on [model=<name>]` | 启动新的 Copilot 会话，创建飞书话题 |
| `/on --claude [model=<name>]` | 启动新的 Claude Code 会话 |
| `/on --claude resume-id=<UUID>` | 恢复指定 Claude 会话 |
| `/resume session-id=<UUID>` | 恢复指定 Copilot 会话 |
| `/id` / `whoami` | 查看自己的飞书 open_id |
| `/h` / `help` | 显示帮助 |
| `/log <子命令>` | 查询会话日志 |

#### Copilot 话题内命令

| 命令 | 说明 |
|------|------|
| 任意文本 | 转发给 Copilot CLI |
| `/exit` | 结束当前会话，保存 resume ID |
| `/resume` | 续接最近一次结束的会话 |

#### Claude 话题内命令

| 命令 | 说明 |
|------|------|
| 任意文本 | 转发给 Claude Code（自动保持上下文） |
| `/exit` | 结束当前会话 |
| `/kill` | 强制终止卡住的进程 |

### 日志查询

```bash
/log tail [N]          # 日志尾部（默认50行）
/log head [N]          # 日志头部
/log grep <关键字>     # 搜索日志
/log sed <表达式>      # 日志范围
/log awk/wc/cat [参数] # 其他日志操作
```

---

## 项目结构

```
feishu_copilot/
├── src/
│   ├── index.ts              # HTTP 服务器入口
│   ├── feishu/
│   │   ├── client.ts         # 飞书 API 封装
│   │   └── webhook.ts        # 事件接收与验证
│   ├── bot/
│   │   ├── router.ts         # 命令路由
│   │   ├── init.ts           # /init 流程
│   │   ├── copilot.ts        # Copilot 会话管理
│   │   ├── claude.ts         # Claude 会话管理
│   │   ├── log.ts            # 日志查询
│   │   └── progress.ts       # 进度记录
│   ├── mcp/
│   │   ├── server.ts         # MCP HTTP 服务
│   │   ├── handler.ts        # MCP 工具实现
│   │   ├── config.ts         # MCP 配置写入
│   │   └── active-route.ts   # 会话路由注册
│   ├── tmux/
│   │   └── manager.ts        # tmux 操作封装
│   └── state/
│       └── store.ts          # 状态持久化
├── docs/                     # 详细技术文档
├── .env.example              # 环境变量模板
├── package.json
└── tsconfig.json
```

---

## 状态文件

初始化后，状态持久化为工作目录下的 `.feishu_copilot_state.json`（已被 `.gitignore` 排除）：

```jsonc
{
  "chat_id": "oc_xxx",
  "workdir": "/home/ubuntu/myapp",
  "project": "myapp",
  "devs": ["ou_alice", "ou_bob"],
  "initialized_at": "2026-02-24T03:51:00Z",
  "sessions": [
    {
      "session_label": "myapp-260301-0133",       // tmux 窗口名
      "session_type": "copilot",                  // "copilot" | "claude"
      "thread_id": "omt_xxx",
      "anchor_msg_id": "om_xxx",
      "thread_first_msg_id": "om_yyy",
      "model": "gpt-5-mini",
      "copilot_resume_id": "9610b4bb-...",
      "started_at": "2026-03-01T01:33:00Z",
      "ended_at": "2026-03-01T01:35:00Z",
      "is_running": false
    },
    {
      "session_label": "myapp-260301-0200-claude",
      "session_type": "claude",
      "thread_id": "omt_yyy",
      "anchor_msg_id": "om_bbb",
      "thread_first_msg_id": "om_ccc",
      "model": "opus",
      "claude_session_id": "a8f2881e-...",
      "started_at": "2026-03-01T02:00:00Z",
      "ended_at": "2026-03-01T02:10:00Z",
      "is_running": false
    }
  ]
}
```

---

## 文档

| 文档 | 说明 |
|------|------|
| [CLAUDE.md](CLAUDE.md) | Claude Copilot 完整指令文档 |
| [docs/bot-behavior.md](docs/bot-behavior.md) | 消息转发、输出清洗、并发处理详解 |
| [docs/copilot-cli-tmux.md](docs/copilot-cli-tmux.md) | tmux + Copilot CLI PTY 交互细节 |
| [docs/feishu-thread-api.md](docs/feishu-thread-api.md) | 飞书话题 API 使用说明 |
| [docs/feishu-webhook.md](docs/feishu-webhook.md) | 飞书 Webhook 事件结构参考 |

---

## 安全注意事项

- `.env` 包含真实密钥，**绝对不能提交到 git**
- `.feishu_copilot_state.json` 包含群组 ID 和用户 ID，**不应提交到 git**
- 两个文件均已添加到 `.gitignore`
