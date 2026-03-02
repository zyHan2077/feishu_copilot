import { sendMessage, sendToThread, addReaction } from '../feishu/client';
import { getStateByChatId, getSessionByThread } from '../state/store';
import { sendInitPrompt, handleInit, isInitialized } from './init';
import { startCopilot, exitCopilot, resumeCopilot, forwardToCopilot } from './copilot';
import { handleLogQuery } from './log';

export interface IncomingMessage {
  chatId: string;
  senderId: string;
  text: string;
  rawContent: string;
  messageId?: string;  // Feishu message_id of the incoming message (for reactions)
  threadId?: string;   // Feishu thread_id (omt_xxx), present when message is in a thread
  rootMsgId?: string;  // Feishu root_id — the anchor message that started the thread
}

/**
 * Top-level message router. Called for every verified group @mention event.
 */
export async function routeMessage(msg: IncomingMessage): Promise<void> {
  const { chatId, senderId, text, threadId, rootMsgId, messageId } = msg;
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

  // ── 3. Thread message → find session and dispatch ─────────────────────────
  const matchedSession = getSessionByThread(state, threadId, rootMsgId);

  if (matchedSession) {
    if (!isDev) return; // silently ignore non-devs in thread
    if (messageId) addReaction(messageId).catch(() => {}); // 👍 "read" receipt
    const lowerText = text.toLowerCase().trim();
    if (lowerText === '/exit') {
      if (!matchedSession.is_running) {
        await sendToThread(matchedSession.anchor_msg_id, '⚠️ 此 session 当前未运行。');
      } else {
        await exitCopilot(chatId, matchedSession);
      }
    } else if (lowerText === '/resume') {
      if (matchedSession.is_running) {
        await sendToThread(matchedSession.anchor_msg_id, '⚠️ 此 session 仍在运行，无需恢复。');
      } else {
        await resumeCopilot(chatId, matchedSession);
      }
    } else if (matchedSession.is_running) {
      await forwardToCopilot(chatId, matchedSession, text);
    } else {
      await sendToThread(matchedSession.anchor_msg_id, '⚠️ 此 session 已结束。发送 /resume 可恢复。');
    }
    return;
  }

  // ── 4. Main chat: ignore non-thread messages silently unless slash cmd ────
  // (Only slash commands are handled in the main chat after a session is running)
  if (!text.startsWith('/')) {
    return; // silently ignore plain text in main chat
  }

  if (!isDev) {
    await sendMessage(chatId, '⚠️ 抱歉，只有开发人员才能操作此机器人。');
    return;
  }

  if (messageId) addReaction(messageId).catch(() => {}); // 👍 "read" receipt

  // ── 5. Slash commands (main chat) ────────────────────────────────────────
  await handleSlashCommand(chatId, senderId, text, lower);
}

/** Dispatch a slash-command from a verified developer. */
async function handleSlashCommand(
  chatId: string,
  senderId: string,
  text: string,
  lower: string,
): Promise<void> {
  // /on [model=<name>] — start copilot
  if (lower === '/on' || lower === 'start copilot' || lower === '启动 copilot' || lower.startsWith('/on ')) {
    const modelMatch = text.match(/\bmodel=(\S+)/i);
    await startCopilot(chatId, undefined, modelMatch?.[1]);
    return;
  }

  // /resume session-id=<UUID> — resume a specific session in a new thread
  const resumeMatch = text.match(/^\/resume\s+session-id=([0-9a-f-]{36})$/i);
  if (resumeMatch) {
    await startCopilot(chatId, resumeMatch[1]);
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
      '📖 可用命令（在主聊天中发送）：\n' +
      '• /on [model=<模型名>] — 启动新 Copilot session（自动创建话题）\n' +
      '• /resume session-id=<UUID> — 新话题中恢复指定 session\n' +
      '• /log tail [N] — 日志尾部（默认50行）\n' +
      '• /log head [N] — 日志头部\n' +
      '• /log grep <关键字> — 搜索日志\n' +
      '• /log sed <表达式> — 日志范围\n' +
      '• /log awk/wc/cat [参数] — 其他日志操作\n' +
      '• /id — 查看自己的 open_id\n' +
      '• /h — 显示此帮助\n' +
      '💡 在话题（thread）中回复与 Copilot 交互；发送 /exit 退出并保存 resume ID；发送 /resume 在同一话题恢复'
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

  // Unknown slash command → show help
  await sendMessage(chatId, '⚠️ 未知命令。发送 /h 查看帮助。');
}
