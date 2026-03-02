import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * One copilot session (one /on → /exit lifecycle).
 * session_label is the human-readable ID generated at /on time and used as tmux window name.
 * copilot_resume_id is the UUID extracted from copilot's exit output (only set after /exit).
 */
export interface CopilotSession {
  session_label: string;          // "project-YYMMDD-HHMM" — tmux window name (copilot) or state key (claude)
  thread_id: string;              // Feishu thread_id (omt_xxx)
  anchor_msg_id: string;          // message_id of the "启动中" anchor (main chat)
  thread_first_msg_id: string;    // message_id of the "已就绪" message (edited after exit)
  ready_text: string;             // original "已就绪" text (needed for the edit)
  session_type?: 'copilot' | 'claude'; // default: 'copilot' for backward compat
  model?: string;                 // model override (claude: used per-call; copilot: used at start)
  copilot_resume_id?: string;     // UUID from copilot --resume= (only after /exit, copilot only)
  claude_session_id?: string;     // UUID from claude stream-json init event (claude only, for --resume)
  started_at: string;             // ISO-8601
  ended_at?: string;              // ISO-8601
  is_running: boolean;
}

export interface BotState {
  chat_id: string;
  workdir: string;
  project: string;
  devs: string[];
  initialized_at: string;
  sessions: CopilotSession[];     // all sessions for this chat, newest last
}

const STATE_FILENAME = '.feishu_copilot_state.json';

/** Central registry: chat_id → workdir, persisted across restarts */
const REGISTRY_FILE = path.join(os.homedir(), '.feishu_copilot_registry.json');

function loadRegistry(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveRegistry(registry: Record<string, string>): void {
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');
}

/**
 * Derive the state file path for a given workdir.
 */
export function stateFilePath(workdir: string): string {
  return path.join(workdir, STATE_FILENAME);
}

/**
 * Load state from disk. Returns null if not found or unreadable.
 */
export function loadState(workdir: string): BotState | null {
  const file = stateFilePath(workdir);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    return migrateState(raw);
  } catch {
    return null;
  }
}

/**
 * Migrate old single-session flat fields (pre-sessions[]) to the new sessions[] schema.
 */
function migrateState(raw: Record<string, unknown>): BotState {
  let sessions: CopilotSession[] = (raw.sessions as CopilotSession[]) ?? [];
  if (!raw.sessions && (raw.copilot_thread_id || raw.copilot_anchor_msg_id || raw.copilot_running)) {
    const legacy: CopilotSession = {
      session_label: (raw.session_id as string) ?? 'legacy',
      thread_id: (raw.copilot_thread_id as string) ?? '',
      anchor_msg_id: (raw.copilot_anchor_msg_id as string) ?? '',
      thread_first_msg_id: '',
      ready_text: '✅ Copilot 已就绪，在此话题中回复即可交互。',
      copilot_resume_id: (raw.copilot_resume_id as string) ?? undefined,
      started_at: (raw.initialized_at as string) ?? new Date().toISOString(),
      is_running: !!(raw.copilot_running),
    };
    sessions = [legacy];
  }
  return {
    chat_id: raw.chat_id as string,
    workdir: raw.workdir as string,
    project: raw.project as string,
    devs: (raw.devs as string[]) ?? [],
    initialized_at: (raw.initialized_at as string) ?? new Date().toISOString(),
    sessions,
  };
}

/**
 * Persist state to disk (creates workdir if needed).
 */
export function saveState(state: BotState): void {
  fs.mkdirSync(state.workdir, { recursive: true });
  fs.writeFileSync(stateFilePath(state.workdir), JSON.stringify(state, null, 2), 'utf-8');
}

/** In-memory index: chat_id → workdir, populated from registry on startup */
const chatIndex: Map<string, string> = new Map(Object.entries(loadRegistry()));

/**
 * Register a chat_id → workdir mapping in both memory and the persistent registry.
 */
export function registerChat(chatId: string, workdir: string): void {
  chatIndex.set(chatId, workdir);
  const registry = loadRegistry();
  registry[chatId] = workdir;
  saveRegistry(registry);
}

/**
 * Look up state by chat_id using the in-memory index.
 */
export function getStateByChatId(chatId: string): BotState | null {
  const workdir = chatIndex.get(chatId);
  if (!workdir) return null;
  return loadState(workdir);
}

/**
 * Update a subset of fields for a given chat_id and persist.
 */
export function updateState(chatId: string, patch: Partial<BotState>): BotState | null {
  const state = getStateByChatId(chatId);
  if (!state) return null;
  const updated = { ...state, ...patch };
  saveState(updated);
  return updated;
}

/**
 * Find a session that matches the given Feishu thread_id or root message id (anchor).
 */
export function getSessionByThread(
  state: BotState,
  threadId: string | undefined,
  rootMsgId: string | undefined,
): CopilotSession | undefined {
  return state.sessions.find(
    (s) =>
      (threadId && s.thread_id && threadId === s.thread_id) ||
      (rootMsgId && s.anchor_msg_id && rootMsgId === s.anchor_msg_id),
  );
}

/**
 * Return the most recently ended (non-running) session, if any.
 */
export function getLastEndedSession(state: BotState): CopilotSession | undefined {
  return [...state.sessions].reverse().find((s) => !s.is_running && s.ended_at);
}
