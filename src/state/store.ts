import fs from 'fs';
import os from 'os';
import path from 'path';

export interface BotState {
  chat_id: string;
  workdir: string;
  project: string;
  devs: string[];           // open_id list
  copilot_running: boolean;
  initialized_at: string;
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
    const raw = fs.readFileSync(file, 'utf-8');
    return JSON.parse(raw) as BotState;
  } catch {
    return null;
  }
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
