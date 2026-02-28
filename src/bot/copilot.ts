import fs from 'fs';
import path from 'path';
import { sendMessage } from '../feishu/client';import { getStateByChatId, updateState } from '../state/store';
import {
  sessionExists, createSession, createWindow, killWindow,
  windowExists, sendKeys, capturePane, stripAnsi,
} from '../tmux/manager';
import { recordProgress } from './progress';

const COPILOT_WINDOW = 'copilot';
const POLL_INTERVAL_MS = 500;
const IDLE_THRESHOLD_MS = 2000;
const LOG_INTERVAL_MS = 5000;

// Per-chat log-tail tracker: last line written to log
const logTailMap: Map<string, string[]> = new Map();
// Per-chat log polling timer
const logTimers: Map<string, NodeJS.Timeout> = new Map();

// Per-chat: are we currently waiting for copilot output?
const waitingChats: Set<string> = new Set();

/**
 * Interactive prompt patterns that indicate Copilot is waiting for user choice.
 */
const INTERACTIVE_PATTERNS = [
  /\[Y\/n\]/i,
  /\[y\/N\]/i,
  /\(yes\/no\)/i,
  /press enter/i,
  /↑\/↓/,
  /^\s*\d+[.)]\s+/m,
];

function isInteractivePrompt(text: string): boolean {
  return INTERACTIVE_PATTERNS.some((p) => p.test(text));
}

/**
 * Start a Copilot CLI session in the project's tmux session.
 */
export async function startCopilot(chatId: string): Promise<void> {
  const state = getStateByChatId(chatId);
  if (!state) {
    await sendMessage(chatId, '❌ 项目尚未初始化。');
    return;
  }

  if (!sessionExists(state.project)) {
    createSession(state.project, state.workdir);
  }

  if (windowExists(state.project, COPILOT_WINDOW)) {
    await sendMessage(chatId, '⚠️ Copilot session 已在运行。');
    return;
  }

  createWindow(state.project, COPILOT_WINDOW);
  const baseline = capturePane(state.project, COPILOT_WINDOW);
  sendKeys(state.project, COPILOT_WINDOW, 'copilot');

  updateState(chatId, { copilot_running: true });
  startLogPoller(chatId, state.project, state.workdir);

  // Wait for initial prompt then relay
  const raw = await pollUntilIdle(state.project, COPILOT_WINDOW, 15_000, baseline);
  const initial = cleanCopilotOutput(raw);
  const msg = initial.trim() ? `🤖 Copilot session 已启动。\n${initial}` : '🤖 Copilot session 已启动。';
  await sendMessage(chatId, msg);
}

/**
 * Stop the Copilot CLI session.
 */
export async function stopCopilot(chatId: string): Promise<void> {
  const state = getStateByChatId(chatId);
  if (!state) {
    await sendMessage(chatId, '❌ 项目尚未初始化。');
    return;
  }

  if (!windowExists(state.project, COPILOT_WINDOW)) {
    await sendMessage(chatId, '⚠️ Copilot session 当前未运行。');
    return;
  }

  sendKeys(state.project, COPILOT_WINDOW, 'q');
  await sleep(500);
  killWindow(state.project, COPILOT_WINDOW);
  updateState(chatId, { copilot_running: false });
  stopLogPoller(chatId);

  await sendMessage(chatId, '🛑 Copilot session 已停止。');

  await recordProgress(state.workdir, chatId, 'Copilot session 停止', []);
}

/**
 * Forward a user message to the running Copilot session and relay output.
 * Returns true if a Copilot session was running and the message was forwarded.
 */
export async function forwardToCopilot(chatId: string, text: string): Promise<boolean> {
  const state = getStateByChatId(chatId);
  if (!state?.copilot_running) return false;
  if (!windowExists(state.project, COPILOT_WINDOW)) return false;

  if (waitingChats.has(chatId)) {
    await sendMessage(chatId, '⏳ Copilot 仍在执行，请稍候…');
    return true;
  }

  sendKeys(state.project, COPILOT_WINDOW, text);
  waitingChats.add(chatId);

  // Snapshot pane BEFORE sending so we can diff out old content
  const baseline = capturePane(state.project, COPILOT_WINDOW);

  try {
    const raw = await pollUntilIdle(state.project, COPILOT_WINDOW, 60_000, baseline);
    const output = cleanCopilotOutput(raw);
    if (output.trim()) {
      const prefix = isInteractivePrompt(output) ? '🔢 ' : '🤖 ';
      await sendMessage(chatId, prefix + output);
    }
  } finally {
    waitingChats.delete(chatId);
  }

  return true;
}

/**
 * Poll a tmux pane until output has been idle for IDLE_THRESHOLD_MS.
 * baseline: pane content snapshot taken BEFORE the command was sent.
 * Returns only the lines that are new since the baseline.
 */
async function pollUntilIdle(
  sessionName: string,
  windowName: string,
  timeoutMs: number,
  baseline = '',
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastContent = baseline;
  let lastChangeTime = Date.now();

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const current = capturePane(sessionName, windowName);
    if (current !== lastContent) {
      lastContent = current;
      lastChangeTime = Date.now();
    } else if (Date.now() - lastChangeTime >= IDLE_THRESHOLD_MS) {
      break;
    }
  }

  // Diff: extract lines that appeared after the baseline
  return diffPaneContent(baseline, lastContent);
}

/**
 * Return lines from `after` that were not present in `before`,
 * preserving order and deduplicating against the baseline set.
 */
function diffPaneContent(before: string, after: string): string {
  const beforeLines = new Set(before.split('\n').map((l) => l.trimEnd()));
  const newLines: string[] = [];
  for (const line of after.split('\n')) {
    const trimmed = line.trimEnd();
    if (!beforeLines.has(trimmed)) {
      newLines.push(trimmed);
    }
  }
  return newLines.join('\n');
}

/** Separator / box-drawing / noise patterns to strip from Copilot output. */
const SEPARATOR_RE = /^[\s─═━─╌╍┄┅┈┉╎╏─━╼╾\-=*~]{3,}$/;
const BOX_BORDER_RE = /^[╭╮╰╯│╔╗╚╝║╟╠╡╢╞╣╤╥╦╧╨╩╪╫┌┐└┘├┤┬┴┼][─│═ ╭╮╰╯║]*[╭╮╰╯│╔╗╚╝║╟╠╡╢╞╣╤╥╦╧╨╩╪╫┌┐└┘├┤┬┴┼]*$/;
const SPINNER_RE = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒⣾⣽⣻⢿⡿⣟⣯⣷]\s/;
const SHELL_PROMPT_RE = /^(\(base\)\s*)?\S+@\S+:.+[$#]\s*$/;

/**
 * Clean Copilot CLI output for Feishu relay:
 * - Strip separator lines, box borders, spinners, shell prompts
 * - Strip │ prefix from box content lines
 * - Collapse consecutive blank lines
 */
function cleanCopilotOutput(raw: string): string {
  const lines = raw.split('\n');
  const cleaned: string[] = [];
  let prevBlank = false;

  for (const rawLine of lines) {
    let line = rawLine.trimEnd();

    // Skip pure separators, box borders, spinners, shell prompts
    if (SEPARATOR_RE.test(line.trim())) continue;
    if (BOX_BORDER_RE.test(line.trim())) continue;
    if (SPINNER_RE.test(line.trim())) continue;
    if (SHELL_PROMPT_RE.test(line.trim())) continue;

    // Strip leading │ (box content border) while preserving indentation
    line = line.replace(/^(\s*)│\s?/, '$1');

    const isBlank = line.trim() === '';
    // Collapse consecutive blanks
    if (isBlank && prevBlank) continue;
    // Skip leading blank lines
    if (isBlank && cleaned.length === 0) continue;

    cleaned.push(line);
    prevBlank = isBlank;
  }

  // Trim trailing blank lines
  while (cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === '') {
    cleaned.pop();
  }

  return cleaned.join('\n');
}

/** Background log poller: append new pane lines to <workdir>/copilot_session.log */
function startLogPoller(chatId: string, sessionName: string, workdir: string): void {
  stopLogPoller(chatId);
  const logFile = path.join(workdir, 'copilot_session.log');
  let lastLines: string[] = logTailMap.get(chatId) ?? [];

  const timer = setInterval(() => {
    if (!windowExists(sessionName, COPILOT_WINDOW)) return;
    const raw = capturePane(sessionName, COPILOT_WINDOW);
    const lines = raw.split('\n');
    const newLines = lines.filter((l) => !lastLines.includes(l) && l.trim() !== '');
    if (newLines.length > 0) {
      const ts = new Date().toISOString();
      const entries = newLines.map((l) => `[${ts}] ${l}`).join('\n') + '\n';
      fs.appendFileSync(logFile, entries, 'utf-8');
      lastLines = lines;
      logTailMap.set(chatId, lastLines);
    }
  }, LOG_INTERVAL_MS);

  logTimers.set(chatId, timer);
}

function stopLogPoller(chatId: string): void {
  const timer = logTimers.get(chatId);
  if (timer) {
    clearInterval(timer);
    logTimers.delete(chatId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
