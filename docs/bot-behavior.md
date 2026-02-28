# Bot Behavior — Detailed Rules (§5-§7)

This document contains the detailed behavioral specifications for message forwarding, log persistence, and progress tracking. See `copilot-instructions.md` §4 for the command table overview.

---

## §5 Forwarding Messages to Copilot

When the Copilot session is running and a developer sends any text that is **not** a slash-command:

1. Strip any @mention prefix from the message.
2. Snapshot pane content as baseline **before** sending (critical — see [copilot-cli-tmux.md](./copilot-cli-tmux.md#4-基线捕获顺序重要)).
3. Send the text as keystrokes to the Copilot pane:
   ```bash
   tmux send-keys -t <project>:copilot "<user message>" Enter
   ```
4. If a previous forward is still pending, reply: `⏳ Copilot 仍在执行，请稍候…` and do not re-send.
5. **Do not echo the user's message back to the group.**
6. Poll the tmux pane output (every 500 ms) until idle for ≥ 2 s (or 60 s timeout):
   - Capture: `tmux capture-pane -t <project>:copilot -p -e`
   - Diff against the pre-send snapshot to extract only new lines.
   - Strip ANSI escape codes, separator lines, box borders, spinners, shell prompts.
   - Relay cleaned output to the thread (or group if no thread active).

### §5.1 Interactive / Keyboard-Choice Prompts

Copilot CLI sometimes presents a numbered or Y/N menu. When new pane output contains a recognised prompt pattern:

- Detect lines matching: `^\s*[\d]+[.)]\s+`, `\[Y/n\]`, `\[y/N\]`, `(yes/no)`, `Press enter`, `↑/↓`, or similar.
- Forward the prompt text to the group as-is.
- The next message from the developer in the group is treated as the raw keystroke(s) to send:
  - Single digit → send that digit + Enter.
  - `y` / `yes` → send `y` + Enter.
  - `n` / `no` → send `n` + Enter.
  - Any other text → send verbatim + Enter.
- This normalises all interactive prompts to standard IM input.

### §5.2 Output Cleaning Patterns

Strip the following from captured pane output before relaying:

| Pattern | Regex / description |
|---|---|
| Separator lines | `/^[\s─═━╌┄┈╎\-=*~]{3,}$/` |
| Box borders | Lines consisting only of `╭╮╰╯│╔╗╚╝║` etc. |
| Spinners | `/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒⣾…]\s/` |
| Shell prompts | `/^(\(base\)\s*)?\S+@\S+:.+[$#]\s*/` (note: NO end anchor, prompt may have trailing text) |
| Box content border | Strip leading `│ ` while preserving indentation |
| Consecutive blank lines | Collapse to single blank |
| Leading / trailing blank lines | Remove |

---

## §6 Log Persistence

- All tmux pane output is continuously appended to `<workdir>/copilot_session.log`.
- A background loop runs every 5 s, captures the full pane, and appends new lines to the log file.
- Log lines are prefixed with an ISO-8601 timestamp: `[2026-02-24T03:51:00Z] <line>`.

### Developer Log-Query Commands

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
Output is truncated to ≤ 4000 chars to stay within Feishu message limits.

---

## §7 Progress Tracking

After every significant state change (**init**, **copilot stop**), the bot appends an entry to `<workdir>/progress.md`:

```markdown
## 26-02-24-03-51  初始化完成
工作目录: /home/ubuntu/projects/myapp
项目名称: myapp
开发人员: ou_alice, ou_bob
tmux session: myapp
```

The incremental update content is also **sent to the Feishu group** immediately after being written.
