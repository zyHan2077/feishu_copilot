import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { sendMessage, replyInThread, sendToThread, sendLongTextToThread, editMessage } from '../feishu/client';
import {
  getStateByChatId, updateState, CopilotSession,
} from '../state/store';
import { writeClaudeMcpConfig } from '../mcp/config';
import { setActiveRoute } from '../mcp/active-route';

// In-progress guard: keyed by session_label, prevents concurrent Claude calls per session
const busySessions: Set<string> = new Set();

// Active subprocess handles: keyed by session_label, used by /kill
const activeProcesses: Map<string, ChildProcess> = new Map();

// Idle timeout: if no output for this many ms, the subprocess is considered stuck
const CLAUDE_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes of silence = stuck

// Periodic progress update interval while Claude is running
const PROGRESS_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

// Feishu message limit for progress updates (conservative)
const PROGRESS_TEXT_LIMIT = 3800;

/** Generate a session label of the form "project-YYMMDD-HHMM-claude". */
function makeSessionLabel(project: string, now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${project}-${String(now.getFullYear()).slice(2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}-claude`;
}

interface ClaudeRunResult {
  sessionId: string;
  resultText: string;
  isError: boolean;
}

/**
 * Run a single Claude Code prompt in --print mode with stream-json output.
 * Uses an idle-based timeout: killed only if no output arrives for CLAUDE_IDLE_TIMEOUT_MS.
 * Long but active sessions (e.g. running bash tools) are NOT killed as long as output flows.
 * The child process is registered in activeProcesses for external /kill support.
 */
function runClaudeSubprocess(
  prompt: string,
  workdir: string,
  sessionId: string | undefined,
  sessionLabel: string,
  chatId: string,
  model?: string,
  anchorMsgId?: string,
): Promise<ClaudeRunResult> {
  return new Promise((resolve, reject) => {
    const args: string[] = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
    ];
    if (sessionId) args.push('--resume', sessionId);
    if (model) args.push('--model', model);
    args.push(prompt);

    const child = spawn('claude', args, {
      cwd: workdir,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'], // ignore stdin so Claude doesn't block waiting for input
    });

    // Register active route so MCP handler can route send_feishu_image to the right thread
    setActiveRoute(chatId, sessionLabel);

    activeProcesses.set(sessionLabel, child);

    // --- Session log file (all sessions centralised under bot's claude-logs/) ---
    const logDir = path.join(__dirname, '../../claude-logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `${sessionLabel}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    logStream.write(`=== Claude session ${sessionLabel} started at ${new Date().toISOString()} ===\n`);

    let stdout = '';
    let stderr = '';
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout>;

    // --- Periodic progress update setup ---
    const startTime = Date.now();
    const recentActivity: string[] = []; // rolling buffer for 3-min Feishu updates
    const logActivity: string[] = [];    // rolling buffer for 5-s log flushes
    let lineBuffer = '';                  // partial-line accumulator for incremental JSON parsing

    /** Extract a human-readable summary from one parsed stream-json event. Returns '' if not interesting. */
    function summariseEvent(event: Record<string, unknown>): string {
      if (event.type !== 'assistant') return '';
      const msg = event.message as Record<string, unknown> | undefined;
      const content = msg?.content;
      if (!Array.isArray(content)) return '';
      const parts: string[] = [];
      for (const item of content as Record<string, unknown>[]) {
        if (item.type === 'text') {
          const t = (item.text as string ?? '').trim();
          if (t) parts.push(t);
        } else if (item.type === 'tool_use') {
          const name = item.name as string ?? '?';
          const input = item.input as Record<string, unknown> | undefined;
          // Show first key-value pair as a hint (keep it short)
          let hint = '';
          if (input) {
            const firstKey = Object.keys(input)[0];
            if (firstKey) {
              const val = String(input[firstKey]).slice(0, 80);
              hint = ` ${firstKey}=${val}`;
            }
          }
          parts.push(`[${name}]${hint}`);
        }
      }
      return parts.join('\n');
    }

    /** Send accumulated activity to the Feishu thread (fire-and-forget). */
    function sendProgressUpdate() {
      if (!anchorMsgId) return;
      const elapsedMin = Math.round((Date.now() - startTime) / 60000);
      const header = `⏳ Claude 仍在处理中（已运行 ${elapsedMin} 分钟）`;
      let body = recentActivity.join('\n').trim();
      recentActivity.length = 0; // clear buffer
      if (!body) {
        sendToThread(anchorMsgId, header + '…').catch(() => {});
        return;
      }
      // Truncate to limit
      if (body.length > PROGRESS_TEXT_LIMIT) {
        body = '…' + body.slice(body.length - PROGRESS_TEXT_LIMIT);
      }
      sendToThread(anchorMsgId, `${header}\n\n最近动态：\n${body}`).catch(() => {});
    }

    const progressInterval = setInterval(sendProgressUpdate, PROGRESS_INTERVAL_MS);

    // Flush log activity every 5 s (only if new content arrived)
    const logFlushInterval = setInterval(() => {
      if (logActivity.length === 0) return;
      const ts = new Date().toISOString();
      const lines = logActivity.splice(0).join('\n');
      logStream.write(`[${ts}]\n${lines}\n\n`);
    }, 5000);

    /** Stop progress timer and mark settled. */
    function stopProgress() {
      clearInterval(progressInterval);
      clearInterval(logFlushInterval);
      clearTimeout(idleTimer);
    }

    // Reset idle timer on every output chunk — process is alive as long as it produces data
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          stopProgress();
          activeProcesses.delete(sessionLabel);
          child.kill('SIGTERM');
          logStream.end(`=== session idle-killed at ${new Date().toISOString()} ===\n`);
          reject(new Error(`Claude 长时间无输出（${CLAUDE_IDLE_TIMEOUT_MS / 60000} 分钟），进程已自动终止`));
        }
      }, CLAUDE_IDLE_TIMEOUT_MS);
    };

    resetIdleTimer(); // start the initial idle timer

    child.stdout.on('data', (chunk: Buffer) => {
      resetIdleTimer(); // activity detected — reset
      const text = chunk.toString();
      stdout += text;

      // Incremental line parsing for progress updates and log
      lineBuffer += text;
      const parts = lineBuffer.split('\n');
      lineBuffer = parts.pop() ?? ''; // last part may be incomplete
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as Record<string, unknown>;
          const summary = summariseEvent(event);
          if (summary) {
            recentActivity.push(summary);
            logActivity.push(summary);
          }
        } catch { /* non-JSON — ignore */ }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      resetIdleTimer();
      const text = chunk.toString().trim();
      if (text) stderr += text + '\n';
    });

    child.on('close', () => {
      if (settled) return;
      settled = true;
      stopProgress();
      activeProcesses.delete(sessionLabel);

      const lines = stdout.split('\n').filter((l) => l.trim());
      let outSessionId = sessionId ?? '';
      let resultText = '';
      let isError = false;

      for (const line of lines) {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          const type = event.type as string;
          const subtype = event.subtype as string | undefined;

          if (type === 'system' && subtype === 'init') {
            outSessionId = (event.session_id as string) ?? outSessionId;
          } else if (type === 'result') {
            isError = !!(event.is_error);
            resultText = (event.result as string) ?? '';
          }
        } catch {
          // Non-JSON line (debug noise) — skip
        }
      }

      if (!resultText && stderr.trim()) {
        isError = true;
        resultText = stderr.trim();
      }

      logStream.end(`=== session ended at ${new Date().toISOString()} ===\n`);
      resolve({ sessionId: outSessionId, resultText, isError });
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        stopProgress();
        activeProcesses.delete(sessionLabel);
        logStream.end(`=== session error at ${new Date().toISOString()}: ${err.message} ===\n`);
        reject(err);
      }
    });
  });
}

/**
 * Force-kill the active Claude subprocess for a session.
 * Returns true if a process was found and killed, false if none was registered.
 */
export function killClaudeSession(sessionLabel: string): boolean {
  const child = activeProcesses.get(sessionLabel);
  if (!child) return false;
  activeProcesses.delete(sessionLabel);
  child.kill('SIGTERM');
  return true;
}


/**
 * Start a new Claude Code session. Creates a Feishu thread for all I/O.
 * resumeId: optional claude_session_id to resume a previous conversation.
 */
export async function startClaude(chatId: string, resumeId?: string, model?: string): Promise<void> {
  const state = getStateByChatId(chatId);
  if (!state) { await sendMessage(chatId, '❌ 项目尚未初始化。'); return; }

  const now = new Date();
  const sessionLabel = makeSessionLabel(state.project, now);

  writeClaudeMcpConfig();

  const anchorMsgId = await sendMessage(chatId, `🤖 Claude session 启动中… [${sessionLabel}]`);

  let threadId = '';
  let threadFirstMsgId = '';
  const readyText = `✅ Claude 已就绪，在此话题中回复即可交互。${resumeId ? `\n（恢复自会话 ${resumeId}）` : ''}`;

  try {
    const result = await replyInThread(anchorMsgId, readyText);
    threadId = result.threadId;
    threadFirstMsgId = result.messageId;
  } catch (err) {
    console.error('[startClaude] failed to create thread:', err);
    await sendMessage(chatId, '❌ 创建话题失败，请稍后重试。');
    return;
  }

  const session: CopilotSession = {
    session_label: sessionLabel,
    session_type: 'claude',
    model: model,
    thread_id: threadId,
    anchor_msg_id: anchorMsgId ?? '',
    thread_first_msg_id: threadFirstMsgId,
    ready_text: readyText,
    claude_session_id: resumeId,   // undefined if brand-new; will be set on first forwardToClaude
    started_at: now.toISOString(),
    is_running: true,
  };

  const fresh = getStateByChatId(chatId)!;
  updateState(chatId, { sessions: [...fresh.sessions, session] });
}

/**
 * Forward a user message to Claude and relay output back to the thread.
 * Context is automatically maintained via claude_session_id (--resume).
 */
export async function forwardToClaude(chatId: string, session: CopilotSession, text: string): Promise<boolean> {
  const state = getStateByChatId(chatId);
  if (!state || !session.is_running) return false;

  const key = session.session_label;
  if (busySessions.has(key)) {
    return true; // silently ignore — concurrent message while Claude is processing
  }

  busySessions.add(key);

  try {
    // Re-read session from state to get the latest claude_session_id
    const freshState = getStateByChatId(chatId);
    const freshSession = freshState?.sessions.find((s) => s.session_label === session.session_label);
    const currentSessionId = freshSession?.claude_session_id;

    const result = await runClaudeSubprocess(text, state.workdir, currentSessionId, key, chatId, freshSession?.model, session.anchor_msg_id);

    // Save claude_session_id if this was the first message
    if (!currentSessionId && result.sessionId) {
      const latest = getStateByChatId(chatId)!;
      updateState(chatId, {
        sessions: latest.sessions.map((s) =>
          s.session_label === session.session_label
            ? { ...s, claude_session_id: result.sessionId }
            : s,
        ),
      });
    }

    const prefix = result.isError ? '❌ ' : '🤖 ';

    // Check if session was killed (via /kill) while we were waiting for the subprocess
    const postRunSession = getStateByChatId(chatId)?.sessions.find((s) => s.session_label === key);
    if (postRunSession && !postRunSession.is_running) return true; // session was killed — discard result silently

    if (result.resultText.trim()) {
      const fullText = prefix + result.resultText;
      if (session.anchor_msg_id) {
        await sendLongTextToThread(session.anchor_msg_id, fullText);
      } else {
        await sendMessage(chatId, fullText);
      }
    } else {
      await sendToThread(session.anchor_msg_id, '🤖 （无输出）');
    }
  } catch (err) {
    console.error('[forwardToClaude] error:', err);
    if (session.anchor_msg_id) {
      await sendToThread(session.anchor_msg_id, `❌ Claude 调用失败：${String(err)}`);
    }
  } finally {
    busySessions.delete(key);
  }

  return true;
}

/**
 * End a Claude session gracefully (no TUI to exit — just mark as done).
 * Also kills any active subprocess if one is running.
 */
export async function exitClaude(chatId: string, session: CopilotSession): Promise<void> {
  const state = getStateByChatId(chatId);
  if (!state) return;

  // Kill active subprocess if any (e.g. user /exit while Claude is still thinking)
  killClaudeSession(session.session_label);

  const now = new Date().toISOString();
  const fresh = getStateByChatId(chatId)!;
  updateState(chatId, {
    sessions: fresh.sessions.map((s) =>
      s.session_label === session.session_label
        ? { ...s, is_running: false, ended_at: now }
        : s,
    ),
  });

  if (session.anchor_msg_id) {
    const resumeHint = session.claude_session_id
      ? `\n\n💡 如需继续此对话，可在主聊天中发送：\n/on --claude resume-id=${session.claude_session_id}`
      : '';
    await sendToThread(session.anchor_msg_id, `🛑 Session 已结束。${resumeHint}`);
    await editMessage(
      session.anchor_msg_id,
      `🤖 [${session.session_label}] 已结束${session.claude_session_id ? `\n🔑 Resume ID: ${session.claude_session_id}` : ''}`,
    );
  }
}


