# Copilot CLI + tmux 交互指南

本文档记录了通过 tmux 以编程方式驱动 GitHub Copilot CLI 交互式会话时，调试过程中发现的所有关键细节与陷阱。

---

## 1. Copilot CLI 的终端模式

Copilot CLI 在启动后会将 PTY 设置为 **RAW 模式**：

```
speed 38400 baud; line = 0;
min = 1; time = 0;
-brkint -icrnl -imaxbel iutf8
-isig -icanon -iexten -echo
```

关键标志含义：

| 标志 | 含义 |
|---|---|
| `-icanon` | 关闭行缓冲（raw mode），字符逐字节交付给进程 |
| `-icrnl` | **CR（`\r`，0x0D）不会被映射为 NL（`\n`，0x0A）**，原样传递 |
| `-echo` | 终端驱动不回显输入字符，TUI 自行负责渲染 |
| `-isig` | 禁用 `Ctrl+C` 等信号快捷键的自动转换 |

这意味着：
- 每个字符都**立即**交付给 Copilot 进程的 stdin
- `\r`（Enter 键）原样传递，Copilot TUI 内部识别 `\r` 为「提交」
- 字符不会被终端自动回显到屏幕，必须由 TUI 自行渲染

---

## 2. 正确的 tmux 输入方式

### ✅ 推荐做法

使用 `spawnSync`（Node.js）直接调用 tmux，避免 shell 解析：

```typescript
import { spawnSync } from 'child_process';

// 发送文字 + Enter
spawnSync('tmux', ['send-keys', '-t', `${session}:${window}`, text, 'Enter']);
```

或命令行：

```bash
tmux send-keys -t <session>:<window> "text to send" Enter
```

- `text` 中的每个字符按顺序发送到 PTY master
- `Enter` 是 tmux 的内置键名，会发送 `\r`（0x0D）给进程
- **在全新启动的 Copilot 会话中**，text 会出现在 `❯` 输入框，Enter 会触发提交

### ✅ 验证 send-keys 是否生效

发送文字后，立即用 `capture-pane` 检查是否出现在输入框：

```bash
tmux send-keys -t bot_test:copilot 'hello'
sleep 0.5
tmux capture-pane -t bot_test:copilot -p | grep '❯'
# 应输出: ❯ hello
```

如果文字出现在 `❯ ` 后面，说明 send-keys 正常工作。

---

## 3. ⚠️ 绝对禁止：直接写入 PTY 从设备

```bash
# ❌ 绝对不要这样做
printf "some text\r" > /dev/pts/12
```

**原因**：`/dev/pts/N` 是 PTY 的**从设备（slave）**。向从设备写入的数据会发送到 PTY **主设备（master）的读缓冲区**——也就是说，这些字节会被 tmux 当作「终端输出」来显示，而**不会**进入 Copilot 进程的 stdin。

这会导致：
1. 写入的文字以原始字节形式出现在终端底部（像是乱码或脱离 TUI 的字符）
2. Copilot TUI 的 ANSI 光标定位状态被破坏，后续所有 `send-keys` 的渲染失效
3. 即使发送的是正常字符，也不会出现在 `❯` 输入框

> **调试历史**：一次通过 `printf "hello tty\r" > /dev/pts/12` 进行实验后，该 Copilot pane 的输入渲染完全失效，必须 kill 进程后重新启动才能恢复。

---

## 4. 基线捕获顺序（重要！）

在向 Copilot 发送消息之前，**必须先**捕获当前 pane 内容作为基线，之后通过 diff 提取新增输出：

```typescript
// ✅ 正确顺序
const baseline = capturePane(session, window);  // 先捕获基线
sendKeys(session, window, text);                 // 再发送

const newOutput = await pollUntilIdle(...);      // 等待新输出稳定
const diff = diffPaneContent(baseline, newOutput);
```

```typescript
// ❌ 错误顺序（基线会包含刚发送的文字，导致 diff 漏掉部分输出）
sendKeys(session, window, text);
const baseline = capturePane(session, window);
```

---

## 5. pane 内容捕获与 ANSI 处理

### 捕获命令

```bash
tmux capture-pane -t <target> -p -e
```

- `-p`：输出到 stdout 而非粘贴缓冲区
- `-e`：**保留 ANSI 转义序列**（颜色、光标定位等）

> ⚠️ 不加 `-e` 时，tmux 会剥离颜色转义，但**光标定位序列仍可能导致内容显示异常**。加 `-e` 后再用代码主动 strip ANSI，结果更可靠。

### Strip ANSI（TypeScript）

```typescript
function stripAnsi(str: string): string {
  return str
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')   // CSI 序列
    .replace(/\x1B\][^\x07]*\x07/g, '');      // OSC 序列
}
```

### diff 提取新增行

```typescript
function diffPaneContent(before: string, after: string): string {
  const beforeLines = new Set(before.split('\n').map(l => l.trimEnd()));
  return after.split('\n')
    .filter(l => !beforeLines.has(l.trimEnd()))
    .join('\n');
}
```

> 注意：diff 基于行集合，同一行内容出现多次时只会出现一次。对于 Copilot 输出这已足够，因为回复行内容通常唯一。

---

## 6. tmux session 初始化（避免多余 bash 窗口）

### 问题

`tmux new-session -d -s <name> -c <workdir>` 默认创建一个名为 `bash` 的窗口（window 0）。  
随后 `tmux new-window -t <name> -n copilot` 会再创建 window 1。  
结果：每个 Copilot 会话都有两个窗口（window 0 = 空 bash，window 1 = copilot）。

### 解决方案

在 `new-session` 时直接用 `-n` 命名第一个窗口：

```bash
tmux new-session -d -s <name> -c <workdir> -n copilot
```

这样 window 0 就是 `copilot`，无需额外创建。

代码示意：

```typescript
if (!sessionExists(project)) {
  createSession(project, workdir, 'copilot');  // 一步到位
} else {
  createWindow(project, 'copilot');            // session 已存在才另建窗口
}
```

---

## 7. 调试 Copilot CLI 交互的最佳实践

### 优先使用快速命令验证

调试 tmux ↔ Copilot 输入输出时，**优先使用不需要 LLM API 调用的命令**：

```bash
# 这些命令执行快（本地处理，无 API 调用），适合验证 send-keys 是否生效
/model                # 列出可用模型（纯本地）
/context              # 显示当前 context（纯本地）
/help                 # 帮助信息（纯本地）
```

### ⚠️ 测试 LLM 响应时先切换到 gpt-5-mini

如果需要测试与 LLM 的实际对话（验证输出内容、响应时机等），**先执行**：

```bash
tmux send-keys -t <session>:copilot '/model gpt-5-mini' Enter
```

原因：`gpt-5-mini` 在 Copilot Pro 计划中**免费**（不消耗 premium request 配额），而其他模型（如 `claude-sonnet-4.6`）会消耗付费配额。调试完毕后再切回所需模型。

---

## 8. 轮询等待输出稳定

Copilot 输出是流式的（边生成边渲染），需要轮询直到输出稳定：

```typescript
async function pollUntilIdle(
  session: string,
  window: string,
  timeoutMs = 60_000,
  baseline = '',
): Promise<string> {
  const POLL_MS = 500;
  const IDLE_MS = 2000;    // 连续 2s 无变化则认为输出完成
  const deadline = Date.now() + timeoutMs;

  let lastContent = baseline;
  let lastChangeTime = Date.now();

  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const current = capturePane(session, window);
    if (current !== lastContent) {
      lastContent = current;
      lastChangeTime = Date.now();
    } else if (Date.now() - lastChangeTime >= IDLE_MS) {
      break;  // 输出已稳定
    }
  }

  return diffPaneContent(baseline, lastContent);
}
```

参数建议：
- 启动等待（`/on`）：`timeoutMs = 15_000`
- 用户输入响应：`timeoutMs = 60_000`（复杂任务可能更长）
- `IDLE_MS = 2000`：对大多数响应足够；若 Copilot 分段输出需适当增大

---

## 9. 确认 Copilot 进程正常运行的快速检查

```bash
# 确认 pane 中的进程
tmux list-panes -t <session>:copilot -F "#{pane_pid} #{pane_tty}"
# → 3213649 /dev/pts/12

# 确认前台子进程（copilot CLI 本身）
ps --ppid <pane_pid> -o pid,stat,comm
# → 3213683 Sl+ copilot   （Sl+ = sleeping, multi-threaded, 前台进程组）

# 确认进程正在监听 stdin（fd 0 = PTY slave）
ls -la /proc/<copilot_pid>/fd/0
# → lrwx... 0 -> /dev/pts/12
```

所有 `fd/0`、`fd/1` 都指向同一个 PTY slave，`send-keys` 通过 PTY master 写入，进程从 slave 的 stdin 读取——这是标准的 tmux 键盘输入路径。
