import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { sendMessage } from '../feishu/client';
import { getStateByChatId } from '../state/store';

const LOG_QUERY_RE =
  /^查看日志\s+(tail|head|grep|sed|awk|cat|wc)\s*(.*)$/i;

/**
 * Handle a log-query command from a developer.
 * Supports: 查看日志 tail 50 | head 20 | grep "err" | sed -n '10,30p'
 */
export async function handleLogQuery(chatId: string, text: string): Promise<boolean> {
  const match = text.match(LOG_QUERY_RE);
  if (!match) return false;

  const state = getStateByChatId(chatId);
  if (!state) {
    await sendMessage(chatId, '❌ 项目尚未初始化，无法查看日志。');
    return true;
  }

  const logFile = path.join(state.workdir, 'copilot_session.log');
  if (!fs.existsSync(logFile)) {
    await sendMessage(chatId, '⚠️ 日志文件尚不存在（Copilot 尚未运行过）。');
    return true;
  }

  const cmd = match[1].toLowerCase();
  const args = (match[2] ?? '').trim();

  // Build safe shell command — only allow whitelisted tools
  let shellCmd: string;
  switch (cmd) {
    case 'tail':
      shellCmd = `tail ${/^-?n?\s*\d+$/.test(args) ? `-n ${args.replace(/^-?n?\s*/, '')}` : '-n 50'} ${shellEsc(logFile)}`;
      break;
    case 'head':
      shellCmd = `head ${/^-?n?\s*\d+$/.test(args) ? `-n ${args.replace(/^-?n?\s*/, '')}` : '-n 50'} ${shellEsc(logFile)}`;
      break;
    case 'grep':
      // args expected: "pattern" or -i "pattern"
      shellCmd = `grep ${args} ${shellEsc(logFile)}`;
      break;
    case 'sed':
      shellCmd = `sed ${args} ${shellEsc(logFile)}`;
      break;
    case 'awk':
      shellCmd = `awk ${args} ${shellEsc(logFile)}`;
      break;
    case 'wc':
      shellCmd = `wc ${args} ${shellEsc(logFile)}`;
      break;
    case 'cat':
      shellCmd = `cat ${shellEsc(logFile)}`;
      break;
    default:
      await sendMessage(chatId, '❌ 不支持的命令。');
      return true;
  }

  let output: string;
  try {
    output = execSync(shellCmd, { encoding: 'utf-8', timeout: 10_000 });
  } catch (err: unknown) {
    output = (err as { stdout?: string }).stdout ?? String(err);
  }

  // Feishu message limit ≈ 4000 chars
  const trimmed = output.length > 3900
    ? output.slice(0, 3900) + '\n…（输出已截断）'
    : output;

  await sendMessage(chatId, `📄 日志查询结果：\n\`\`\`\n${trimmed}\n\`\`\``);
  return true;
}

function shellEsc(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
