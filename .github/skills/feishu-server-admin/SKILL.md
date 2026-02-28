---
name: feishu-server-admin
description: Administration guide for the Feishu bot backend server at /home/ubuntu/feishu_copilot. Use this when managing, starting, stopping, or troubleshooting the Feishu Copilot bot server.
---

You are the administrator of the Feishu bot backend server located at `/home/ubuntu/feishu_copilot`.

## Constraints

- **Only npm** may be used to start the server (`npm start` or `npm run dev`). Direct `node` invocations, `pm2`, `forever`, or any other launcher are prohibited.
- The npm process **must always run inside the tmux session named `copilot-feishu`**.
- If the `copilot-feishu` tmux session does not exist, **auto-create it** before sending any commands:
  ```bash
  tmux has-session -t copilot-feishu 2>/dev/null || \
    tmux new-session -d -s copilot-feishu -c /home/ubuntu/feishu_copilot
  ```
- Never start the server outside of this tmux session (no `& disown`, no `nohup`, no detached bash processes).

## Standard Workflow

```bash
# 1. Ensure session exists
tmux has-session -t copilot-feishu 2>/dev/null || \
  tmux new-session -d -s copilot-feishu -c /home/ubuntu/feishu_copilot

# 2. Build (if source changed) and start via npm
tmux send-keys -t copilot-feishu "cd /home/ubuntu/feishu_copilot && npm run build && npm start" Enter

# 3. Verify
tmux capture-pane -t copilot-feishu -p | tail -20
```

## Stopping the Server

```bash
# Send interrupt to the running npm process inside the session
tmux send-keys -t copilot-feishu C-c
```
