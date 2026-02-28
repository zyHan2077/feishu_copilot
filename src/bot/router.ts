import { sendMessage } from '../feishu/client';
import { getStateByChatId } from '../state/store';
import { sendInitPrompt, handleInit, isInitialized } from './init';
import { startCopilot, stopCopilot, forwardToCopilot } from './copilot';
import { handleLogQuery } from './log';

export interface IncomingMessage {
  chatId: string;
  senderId: string;
  text: string;
  rawContent: string;
}

/**
 * Top-level message router. Called for every verified group @mention event.
 */
export async function routeMessage(msg: IncomingMessage): Promise<void> {
  const { chatId, senderId, text } = msg;
  const lower = text.toLowerCase().trim();

  // ── 1. Not yet initialised ───────────────────────────────────────────────
  if (!isInitialized(chatId)) {
    if (text.startsWith('/init ')) {
      await handleInit(chatId, senderId, text);
    } else {
      await sendInitPrompt(chatId);
    }
    return;
  }

  // ── 2. Developer access control ──────────────────────────────────────────
  const state = getStateByChatId(chatId)!;
  const isDev = state.devs.includes(senderId);

  if (!isDev) {
    // Only respond to slash-commands from non-devs to avoid noise
    if (text.startsWith('/')) {
      await sendMessage(chatId, '⚠️ 抱歉，只有开发人员才能操作此机器人。');
    }
    return;
  }

  // ── 3. Slash commands ────────────────────────────────────────────────────
  if (text.startsWith('/')) {
    await handleSlashCommand(chatId, senderId, text, lower);
    return;
  }

  // ── 4. No slash prefix → forward to Copilot directly ────────────────────
  const forwarded = await forwardToCopilot(chatId, text);
  if (!forwarded) {
    await sendMessage(chatId, '⚠️ Copilot session 未运行。请先发送 /on 启动。');
  }
}

/** Dispatch a slash-command from a verified developer. */
async function handleSlashCommand(
  chatId: string,
  senderId: string,
  text: string,
  lower: string,
): Promise<void> {
  // /on — start copilot
  if (lower === '/on' || lower === 'start copilot' || lower === '启动 copilot') {
    await startCopilot(chatId);
    return;
  }

  // /off — stop copilot
  if (lower === '/off' || lower === 'stop copilot' || lower === '停止 copilot') {
    await stopCopilot(chatId);
    return;
  }

  // /id — whoami
  if (lower === '/id' || lower === 'whoami') {
    await sendMessage(chatId, `🪪 你的 open_id：\n${senderId}`);
    return;
  }

  // /h or /help — help
  if (lower === '/h' || lower === '/help' || lower === 'help' || lower === '帮助') {
    await sendMessage(
      chatId,
      '📖 可用命令（无需 @bot，直接发送）：\n' +
      '• /on — 启动 Copilot session\n' +
      '• /off — 停止 Copilot session\n' +
      '• /log tail [N] — 日志尾部（默认50行）\n' +
      '• /log head [N] — 日志头部\n' +
      '• /log grep <关键字> — 搜索日志\n' +
      '• /log sed <表达式> — 日志范围\n' +
      '• /id — 查看自己的 open_id\n' +
      '• /h — 显示此帮助\n' +
      '• 其他任意文字（无 / 前缀）→ 直接转发给 Copilot'
    );
    return;
  }

  // /log — log queries (also supports legacy 查看日志)
  if (lower.startsWith('/log ') || lower.startsWith('查看日志')) {
    // Normalize /log → 查看日志 for handleLogQuery
    const normalized = lower.startsWith('/log ')
      ? '查看日志 ' + text.slice(5).trim()
      : text;
    if (await handleLogQuery(chatId, normalized)) return;
  }

  // /init — allow re-init from a dev
  if (text.startsWith('/init ')) {
    await handleInit(chatId, senderId, text);
    return;
  }

  // Unknown slash command — forward to copilot as-is
  const forwarded = await forwardToCopilot(chatId, text);
  if (!forwarded) {
    await sendMessage(chatId, '⚠️ 未知命令。发送 /h 查看帮助。');
  }
}
