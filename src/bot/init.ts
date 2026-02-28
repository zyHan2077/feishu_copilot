import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { sendMessage, renameChat } from '../feishu/client';
import { saveState, registerChat, getStateByChatId } from '../state/store';
import { createSession } from '../tmux/manager';
import { recordProgress } from './progress';

/**
 * Send the initialisation prompt to a group that has no state yet.
 */
export async function sendInitPrompt(chatId: string): Promise<void> {
  await sendMessage(
    chatId,
    '👋 请设置以下信息来初始化项目：\n' +
    '1. 服务器工作目录（绝对路径）\n' +
    '2. 项目名称（英文，无空格）\n' +
    '3. 开发人员（飞书 open_id，逗号分隔）\n\n' +
    '格式：/init <工作目录> <项目名称> <开发人员1,开发人员2>'
  );
}

/**
 * Parse and execute an /init command.
 * Returns true if the message matched the /init pattern (even on error).
 */
export async function handleInit(chatId: string, senderId: string, text: string): Promise<boolean> {
  if (!text.startsWith('/init ')) return false;

  const parts = text.slice(6).trim().split(/\s+/);
  if (parts.length < 3) {
    await sendMessage(chatId, '❌ 格式错误。用法：/init <工作目录> <项目名称> <开发人员1,开发人员2>');
    return true;
  }

  const [workdir, project, devsRaw] = parts;
  const devs = devsRaw.split(',').map((d) => d.trim()).filter(Boolean);

  if (!/^[a-zA-Z0-9_-]+$/.test(project)) {
    await sendMessage(chatId, '❌ 项目名称只能包含英文字母、数字、下划线或连字符。');
    return true;
  }

  // Create workdir if needed
  fs.mkdirSync(workdir, { recursive: true });

  // Persist state
  const state = {
    chat_id: chatId,
    workdir,
    project,
    devs,
    initialized_at: new Date().toISOString(),
    sessions: [],
  };
  saveState(state);
  registerChat(chatId, workdir);

  // Rename Feishu group
  try {
    await renameChat(chatId, `${project}开发群`);
  } catch (err) {
    console.error('renameChat failed:', err);
    // Non-fatal — continue
  }

  // Create tmux session
  createSession(project, workdir);

  // tree output (fall back to Node.js implementation if tree not installed)
  let treeOutput: string;
  try {
    treeOutput = execSync(`tree -L 1 ${shellEsc(workdir)}`, { encoding: 'utf-8', timeout: 5000 });
  } catch {
    treeOutput = nodeTree(workdir);
  }

  await sendMessage(
    chatId,
    `✅ 初始化完成！\n工作目录：${workdir}\ntmux session：${project}\n开发人员：${devs.join(', ')}\n\n目录结构：\n\`\`\`\n${treeOutput}\`\`\``
  );

  await recordProgress(workdir, chatId, '初始化完成', [
    `工作目录: ${workdir}`,
    `项目名称: ${project}`,
    `开发人员: ${devs.join(', ')}`,
    `tmux session: ${project}`,
  ]);

  return true;
}

/**
 * Check whether the group has been initialised.
 */
export function isInitialized(chatId: string): boolean {
  return getStateByChatId(chatId) !== null;
}

function shellEsc(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Pure Node.js tree-like listing (depth=1), mimics `tree -L 1` output. */
function nodeTree(dir: string): string {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    const lines: string[] = [dir];
    entries.forEach((e, i) => {
      const isLast = i === entries.length - 1;
      const prefix = isLast ? '└── ' : '├── ';
      const suffix = e.isDirectory() ? '/' : '';
      lines.push(`${prefix}${e.name}${suffix}`);
    });
    const dirs = entries.filter((e) => e.isDirectory()).length;
    const files = entries.filter((e) => !e.isDirectory()).length;
    lines.push(`\n${dirs} directories, ${files} files`);
    return lines.join('\n');
  } catch {
    return '（无法获取目录列表）';
  }
}
