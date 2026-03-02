import fs from 'fs';
import path from 'path';
import { sendMessage, replyInThread, sendToThread, editMessage } from '../feishu/client';
import {
  getStateByChatId, updateState, CopilotSession, getLastEndedSession,
} from '../state/store';
import {
  sessionExists, createSession, createWindow, killWindow,
  windowExists, sendKeys, capturePane, captureFullPane,
} from '../tmux/manager';
import { writeMcpConfig } from '../mcp/config';
import { setActiveRoute } from '../mcp/active-route';
const POLL_INTERVAL_MS = 500;
const IDLE_THRESHOLD_MS = 5000;
const ACTIVITY_CHECK_DELAY_MS = 500;
const CONTINUATION_IDLE_MS = 3000;
const CONTINUATION_TIMEOUT_MS = 10 * 60_000; // 10 min safety net for long-running tasks
const LOG_INTERVAL_MS = 5000;

// Per-session trackers keyed by "${project}:${session_label}"
const logTailMap: Map<string, string[]> = new Map();
const logTimers: Map<string, NodeJS.Timeout> = new Map();
const waitingWindows: Set<string> = new Set();

function winKey(project: string, sessionLabel: string): string {
  return `${project}:${sessionLabel}`;
}

const INTERACTIVE_PATTERNS = [
  /\[Y\/n\]/i, /\[y\/N\]/i, /\(yes\/no\)/i,
  /press enter/i, /↑\/↓/, /^\s*\d+[.)]\s+/m,
];

function isInteractivePrompt(text: string): boolean {
  return INTERACTIVE_PATTERNS.some((p) => p.test(text));
}

/**
 * Detect whether the Copilot CLI is currently busy (thinking or executing a tool).
 * During execution the bottom bar shows "ctrl+q enqueue" and the response area
 * contains "(Esc to cancel)". Neither is present when Copilot is idle at the prompt.
 */
function isCopilotBusy(sessionName: string, windowName: string): boolean {
  const pane = capturePane(sessionName, windowName);
  // "ctrl+q enqueue" appears in the bottom bar during execution
  if (pane.includes('ctrl+q')) return true;
  // "Esc to cancel" appears in the response area during thinking/tool execution
  if (pane.includes('Esc to cancel')) return true;
  return false;
}

/** Generate a session label of the form "project-YYMMDD-HHMM". Used as tmux window name. */
function makeSessionLabel(project: string, now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${project}-${String(now.getFullYear()).slice(2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/**
 * Start a new (or resumed) Copilot CLI session. Creates a Feishu thread for all I/O.
 * resumeId: optional UUID for copilot --resume=<UUID>.
 */
export async function startCopilot(chatId: string, resumeId?: string, model?: string): Promise<void> {
  const state = getStateByChatId(chatId);
  if (!state) { await sendMessage(chatId, '❌ 项目尚未初始化。'); return; }

  const now = new Date();
  const sessionLabel = makeSessionLabel(state.project, now);

  if (windowExists(state.project, sessionLabel)) {
    await sendMessage(chatId, '⚠️ Copilot session 已在运行。'); return;
  }

  if (!sessionExists(state.project)) {
    createSession(state.project, state.workdir, sessionLabel);
  } else {
    createWindow(state.project, sessionLabel);
  }

  const startCmd = resumeId
    ? `copilot --resume=${resumeId}${model ? ` --model ${model}` : ''}`
    : model ? `copilot --model ${model}` : 'copilot';
  writeMcpConfig();
  sendKeys(state.project, sessionLabel, startCmd);
  await sleep(200);
  const baselineLineCount = captureFullPane(state.project, sessionLabel).split('\n').length;

  const anchorMsgId = await sendMessage(chatId, `🤖 Copilot session 启动中… [${sessionLabel}]`);

  const raw = await pollUntilIdle(state.project, sessionLabel, 15_000, baselineLineCount);
  const initial = cleanCopilotOutput(raw);

  let threadId = '';
  let threadFirstMsgId = '';
  let readyText = `✅ Copilot 已就绪，在此话题中回复即可交互。${resumeId ? `\n（恢复自 ${resumeId}）` : ''}`;
  if (initial.trim()) readyText += `\n\n${initial}`;

  try {
    const result = await replyInThread(anchorMsgId, readyText);
    threadId = result.threadId;
    threadFirstMsgId = result.messageId;
  } catch (err) {
    console.error('[startCopilot] failed to create thread:', err);
    if (initial.trim()) await sendMessage(chatId, `🤖 Copilot 已就绪。\n${initial}`);
  }

  const session: CopilotSession = {
    session_label: sessionLabel,
    thread_id: threadId,
    anchor_msg_id: anchorMsgId ?? '',
    thread_first_msg_id: threadFirstMsgId,
    ready_text: readyText,
    started_at: now.toISOString(),
    is_running: true,
  };

  const fresh = getStateByChatId(chatId)!;
  updateState(chatId, { sessions: [...fresh.sessions, session] });
  startLogPoller(state.project, sessionLabel, state.workdir);
}

/**
 * Gracefully exit a Copilot session via /exit, extract the resume UUID,
 * edit the "已就绪" message to show it, and clean up.
 */
export async function exitCopilot(chatId: string, session: CopilotSession): Promise<void> {
  const state = getStateByChatId(chatId);
  if (!state) return;

  if (!windowExists(state.project, session.session_label)) {
    if (session.anchor_msg_id) await sendToThread(session.anchor_msg_id, '⚠️ tmux 窗口不存在，session 可能已退出。');
    return;
  }

  const key = winKey(state.project, session.session_label);
  const baselineLineCount = captureFullPane(state.project, session.session_label).split('\n').length;
  sendKeys(state.project, session.session_label, '/exit');
  waitingWindows.add(key);

  try {
    const raw = await pollUntilIdle(state.project, session.session_label, 15_000, baselineLineCount);
    const output = cleanCopilotOutput(raw);

    const uuidMatch = raw.match(/copilot --resume=([0-9a-f-]{36})/);
    const uuid = uuidMatch?.[1];

    if (session.anchor_msg_id) {
      await sendToThread(session.anchor_msg_id, output.trim() ? `🛑 Session 已结束\n\n${output}` : '🛑 Session 已结束。');
    }
    if (uuid && session.anchor_msg_id) {
      await editMessage(session.anchor_msg_id, `🤖 [${session.session_label}] 已结束\n🔑 Resume: copilot --resume=${uuid}`);
    }

    killWindow(state.project, session.session_label);

    const now = new Date().toISOString();
    const fresh = getStateByChatId(chatId)!;
    updateState(chatId, {
      sessions: fresh.sessions.map((s) =>
        s.session_label === session.session_label
          ? { ...s, is_running: false, ended_at: now, copilot_resume_id: uuid ?? undefined }
          : s,
      ),
    });
    stopLogPoller(key);
  } finally {
    waitingWindows.delete(key);
  }
}

/**
 * Resume the most-recently-ended session within the same thread.
 * Only allowed if existingSession IS the last ended session for this chat.
 */
export async function resumeCopilot(chatId: string, existingSession: CopilotSession): Promise<void> {
  const state = getStateByChatId(chatId);
  if (!state) return;

  if (!existingSession.copilot_resume_id) {
    if (existingSession.anchor_msg_id) await sendToThread(existingSession.anchor_msg_id, '⚠️ 此 session 没有 resume ID，无法恢复。');
    return;
  }
  const lastEnded = getLastEndedSession(state);
  if (!lastEnded || lastEnded.session_label !== existingSession.session_label) {
    if (existingSession.anchor_msg_id) await sendToThread(existingSession.anchor_msg_id, '⚠️ 只能在最近一次结束的 session 话题中使用 /resume。');
    return;
  }

  const now = new Date();
  const newLabel = makeSessionLabel(state.project, now);

  if (!sessionExists(state.project)) {
    createSession(state.project, state.workdir, newLabel);
  } else {
    createWindow(state.project, newLabel);
  }

  sendKeys(state.project, newLabel, `copilot --resume=${existingSession.copilot_resume_id}`);
  await sleep(200);
  const baselineLineCount = captureFullPane(state.project, newLabel).split('\n').length;
  if (existingSession.anchor_msg_id) await sendToThread(existingSession.anchor_msg_id, '🔄 正在恢复 session…');

  const raw = await pollUntilIdle(state.project, newLabel, 15_000, baselineLineCount);
  const initial = cleanCopilotOutput(raw);
  const resumeText = `✅ Session 已恢复（${existingSession.copilot_resume_id}）${initial.trim() ? `\n\n${initial}` : ''}`;
  if (existingSession.anchor_msg_id) await sendToThread(existingSession.anchor_msg_id, resumeText);

  const newSession: CopilotSession = {
    session_label: newLabel,
    thread_id: existingSession.thread_id,
    anchor_msg_id: existingSession.anchor_msg_id,
    thread_first_msg_id: existingSession.thread_first_msg_id,
    ready_text: resumeText,
    started_at: now.toISOString(),
    is_running: true,
  };
  const fresh = getStateByChatId(chatId)!;
  updateState(chatId, { sessions: [...fresh.sessions, newSession] });
  startLogPoller(state.project, newLabel, state.workdir);
}

/**
 * Forward a user message to the Copilot session and relay output back to the thread.
 */
export async function forwardToCopilot(chatId: string, session: CopilotSession, text: string): Promise<boolean> {
  const state = getStateByChatId(chatId);
  if (!state || !session.is_running) return false;
  if (!windowExists(state.project, session.session_label)) return false;

  const key = winKey(state.project, session.session_label);
  if (waitingWindows.has(key)) {
    if (session.anchor_msg_id) await sendToThread(session.anchor_msg_id, '⏳ Copilot 仍在执行，请稍候…');
    return true;
  }

  const baselineLineCount = captureFullPane(state.project, session.session_label).split('\n').length;
  console.log(`[forward] baseline=${baselineLineCount}, sending text to ${key}`);
  setActiveRoute(chatId, session.session_label);
  sendKeys(state.project, session.session_label, text);
  waitingWindows.add(key);

  try {
    // First batch: wait for Copilot to finish (with activity-indicator check)
    const raw = await pollUntilIdle(state.project, session.session_label, 60_000, baselineLineCount, { requireIdle: true });
    const output = cleanCopilotOutput(raw);
    console.log(`[forward] pollUntilIdle returned, output length=${output.length}, trimmed=${output.trim().length}`);
    if (output.trim()) {
      const prefix = isInteractivePrompt(output) ? '🔢 ' : '🤖 ';
      if (session.anchor_msg_id) {
        await sendToThread(session.anchor_msg_id, prefix + output);
      } else {
        await sendMessage(chatId, prefix + output);
      }
      console.log('[forward] first batch sent');
    }

    // If the task already completed during pollUntilIdle, skip the continuation.
    // When the task is still running, we need to wait for busy→idle and capture the
    // visible-pane output. The Copilot TUI renders in-place (response replaces thinking
    // text at the same scrollback positions), so scrollback line-count alone cannot
    // detect the final response.
    const stillBusy = windowExists(state.project, session.session_label)
      && isCopilotBusy(state.project, session.session_label);
    if (stillBusy) {
      let continuationLastActivity = Date.now();
      let continuationLastChange = Date.now();
      let continuationLastVisible = capturePane(state.project, session.session_label);
      console.log('[forward] continuation start (task still running)');

      while (Date.now() - continuationLastActivity < CONTINUATION_TIMEOUT_MS) {
        await sleep(POLL_INTERVAL_MS);
        if (!windowExists(state.project, session.session_label)) { console.log('[forward] window gone'); break; }
        const current = capturePane(state.project, session.session_label);
        if (current !== continuationLastVisible) {
          continuationLastVisible = current;
          continuationLastChange = Date.now();
          continuationLastActivity = Date.now();
        } else if (Date.now() - continuationLastChange >= CONTINUATION_IDLE_MS) {
          const busy = isCopilotBusy(state.project, session.session_label);
          if (!busy) {
            // Task completed — capture visible pane as final output
            console.log('[forward] task done (not busy), capturing final output');
            const finalPane = capturePane(state.project, session.session_label);
            const finalOutput = cleanCopilotOutput(finalPane);
            if (finalOutput.trim()) {
              const prefix = isInteractivePrompt(finalOutput) ? '🔢 ' : '🤖 ';
              if (session.anchor_msg_id) {
                await sendToThread(session.anchor_msg_id, prefix + finalOutput);
              } else {
                await sendMessage(chatId, prefix + finalOutput);
              }
              console.log(`[forward] final output sent (${finalOutput.length} chars)`);
            }
            break;
          }
          // Still busy — keep monitoring
          continuationLastActivity = Date.now();
          continuationLastChange = Date.now();
          continuationLastVisible = capturePane(state.project, session.session_label);
        }
      }
    } else {
      console.log('[forward] task already complete, skipping continuation');
    }
    console.log('[forward] monitoring complete');
  } finally {
    waitingWindows.delete(key);
  }
  return true;
}

async function pollUntilIdle(sessionName: string, windowName: string, timeoutMs: number, baselineLineCount: number, options?: { requireIdle?: boolean }): Promise<string> {
  const requireIdle = options?.requireIdle ?? false;
  const deadline = Date.now() + timeoutMs;
  let lastVisible = capturePane(sessionName, windowName);
  let lastChangeTime = Date.now();
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const current = capturePane(sessionName, windowName);
    if (current !== lastVisible) { lastVisible = current; lastChangeTime = Date.now(); }
    else if (Date.now() - lastChangeTime >= IDLE_THRESHOLD_MS) {
      // Confirm no activity indicator (spinner) in bottom 3 lines
      await sleep(ACTIVITY_CHECK_DELAY_MS);
      const recheck = capturePane(sessionName, windowName);
      const bottomBefore = lastVisible.split('\n').slice(-3).join('\n');
      const bottomAfter = recheck.split('\n').slice(-3).join('\n');
      if (bottomBefore !== bottomAfter) {
        // Bottom lines still changing — activity indicator present, keep waiting
        lastVisible = recheck;
        lastChangeTime = Date.now();
      } else if (requireIdle && isCopilotBusy(sessionName, windowName)) {
        // Pane stable but Copilot still executing (tool running silently) — keep waiting
        console.log(`[poll] pane stable but busy, continuing (elapsed=${Math.round((Date.now() - (deadline - timeoutMs)) / 1000)}s)`);
        lastChangeTime = Date.now();
      } else {
        console.log(`[poll] idle confirmed (requireIdle=${requireIdle}), breaking`);
        break;
      }
    }
  }
  const full = captureFullPane(sessionName, windowName);
  return extractNewLines(full, baselineLineCount);
}

/** Extract lines beyond baselineLineCount from a full scrollback capture. */
function extractNewLines(full: string, baselineLineCount: number): string {
  const lines = full.split('\n');
  return lines.slice(baselineLineCount).join('\n');
}

const SEPARATOR_RE = /^[\s─═━─╌╍┄┅┈┉╎╏─━╼╾\-=*~]{3,}$/;
const BOX_BORDER_RE = /^[╭╮╰╯│╔╗╚╝║╟╠╡╢╞╣╤╥╦╧╨╩╪╫┌┐└┘├┤┬┴┼][─│═ ╭╮╰╯║]*[╭╮╰╯│╔╗╚╝║╟╠╡╢╞╣╤╥╦╧╨╩╪╫┌┐└┘├┤┬┴┼]*$/;
const SPINNER_RE = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒◎⣾⣽⣻⢿⡿⣟⣯⣷]\s/;
const SHELL_PROMPT_RE = /^(\(base\)\s*)?\S+@\S+:.+[$#]\s*/;
const INPUT_ECHO_RE = /^\s*❯\s/;
const UI_HINT_RE = /shift\+tab\s+switch\s+mode/i;
const COPILOT_STATUS_RE = /^\s*[~\/]\S.*\[⎇/;   // e.g. " ~/project [⎇ main*]  gpt-5-mini (medium)"
const REMAINING_REQ_RE = /Remaining reqs\./i;
const COPILOT_BANNER_RE = /GitHub Copilot v\d/;
const COPILOT_ART_RE = /^[│╭╮╰╯\s█▘▝▔]*$/;  // ASCII art from the Copilot logo
const COPILOT_BOILERPLATE_RE = /Copilot uses AI\. Check for mistakes\.|● Environment loaded:|● All permissions are now enabled\./;

function cleanCopilotOutput(raw: string): string {
  const lines = raw.split('\n');
  const cleaned: string[] = [];
  let prevBlank = false;
  for (const rawLine of lines) {
    let line = rawLine.trimEnd();
    if (SEPARATOR_RE.test(line.trim())) continue;
    if (BOX_BORDER_RE.test(line.trim())) continue;
    if (SPINNER_RE.test(line.trim())) continue;
    if (SHELL_PROMPT_RE.test(line.trim())) continue;
    if (INPUT_ECHO_RE.test(line)) continue;
    if (UI_HINT_RE.test(line)) continue;
    if (COPILOT_STATUS_RE.test(line)) continue;
    if (REMAINING_REQ_RE.test(line)) continue;
    if (COPILOT_BANNER_RE.test(line)) continue;
    if (COPILOT_ART_RE.test(line.trim()) && line.trim().length < 30) continue;
    if (COPILOT_BOILERPLATE_RE.test(line)) continue;
    line = line.replace(/^(\s*)│\s?/, '$1');
    const isBlank = line.trim() === '';
    if (isBlank && prevBlank) continue;
    if (isBlank && cleaned.length === 0) continue;
    cleaned.push(line);
    prevBlank = isBlank;
  }
  while (cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === '') cleaned.pop();
  return cleaned.join('\n');
}

function startLogPoller(sessionName: string, windowName: string, workdir: string): void {
  const key = winKey(sessionName, windowName);
  stopLogPoller(key);
  const logFile = path.join(workdir, 'copilot_session.log');
  let lastLines: string[] = logTailMap.get(key) ?? [];
  const timer = setInterval(() => {
    if (!windowExists(sessionName, windowName)) return;
    const raw = capturePane(sessionName, windowName);
    const lines = raw.split('\n');
    const newLines = lines.filter((l) => !lastLines.includes(l) && l.trim() !== '');
    if (newLines.length > 0) {
      const ts = new Date().toISOString();
      fs.appendFileSync(logFile, newLines.map((l) => `[${ts}] ${l}`).join('\n') + '\n', 'utf-8');
      lastLines = lines;
      logTailMap.set(key, lastLines);
    }
  }, LOG_INTERVAL_MS);
  logTimers.set(key, timer);
}

function stopLogPoller(key: string): void {
  const timer = logTimers.get(key);
  if (timer) { clearInterval(timer); logTimers.delete(key); }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
