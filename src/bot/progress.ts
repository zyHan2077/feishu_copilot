import fs from 'fs';
import path from 'path';
import { sendMessage } from '../feishu/client';

/**
 * Append an incremental entry to <workdir>/progress.md and notify the group.
 *
 * @param workdir  Absolute path to the project working directory
 * @param chatId   Feishu group chat ID
 * @param title    Short title for this update (e.g. "初始化完成")
 * @param details  Body lines to append under the heading
 */
export async function recordProgress(
  workdir: string,
  chatId: string,
  title: string,
  details: string[]
): Promise<void> {
  const ts = formatTimestamp(new Date());
  const heading = `## ${ts}  ${title}`;
  const body = details.map((d) => `${d}`).join('\n');
  const entry = `\n${heading}\n${body}\n`;

  const file = path.join(workdir, 'progress.md');
  fs.appendFileSync(file, entry, 'utf-8');

  // Notify Feishu group with the incremental update
  const msg = `📋 *进展更新 ${ts}*\n${title}\n${body}`;
  await sendMessage(chatId, msg);
}

/**
 * Format a Date as YY-MM-DD-HH-MM (e.g. 26-02-24-11-55).
 */
function formatTimestamp(d: Date): string {
  const yy = String(d.getFullYear()).slice(2).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${yy}-${mo}-${dd}-${hh}-${mm}`;
}
