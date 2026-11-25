/**
 * Token Cost Calculator — backend server.
 *
 * Serves preset model pricing data, performs cost calculations,
 * and reads Claude session transcript files to auto-detect token usage.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

// ── Preset model pricing (per 1M tokens, USD) ─────────────────────────

interface ModelPricing {
  name: string;
  provider: string;
  inputPrice: number;
  outputPrice: number;
  /** Cache read (cache hit) price. */
  cachedInputPrice: number;
  /** Cache write price, 5-minute TTL. */
  cacheWrite5mPrice: number;
  /** Cache write price, 1-hour TTL. */
  cacheWrite1hPrice: number;
}

// Anthropic bills cache writes at 1.25x (5-minute TTL) or 2x (1-hour TTL) the
// input price. The other providers below charge nothing extra for writing to
// the cache, so their write prices equal the input price.
const PRESETS: ModelPricing[] = [
  {
    name: 'Claude Opus 5.5',
    provider: 'Anthropic',
    inputPrice: 4.0,
    outputPrice: 20.0,
    cachedInputPrice: 0.2,
    cacheWrite5mPrice: 5.0,
    cacheWrite1hPrice: 8.0,
  },
  {
    name: 'Claude Sonnet 5.5',
    provider: 'Anthropic',
    inputPrice: 2.0,
    outputPrice: 10.0,
    cachedInputPrice: 0.1,
    cacheWrite5mPrice: 2.5,
    cacheWrite1hPrice: 4.0,
  },
  {
    name: 'Claude Haiku 5.5',
    provider: 'Anthropic',
    inputPrice: 0.1,
    outputPrice: 0.5,
    cachedInputPrice: 0.01,
    cacheWrite5mPrice: 0.125,
    cacheWrite1hPrice: 0.2,
  },
  {
    name: 'Claude Opus 4.7',
    provider: 'Anthropic',
    inputPrice: 5.0,
    outputPrice: 25.0,
    cachedInputPrice: 0.5,
    cacheWrite5mPrice: 6.25,
    cacheWrite1hPrice: 10.0,
  },
  {
    name: 'Claude Sonnet 4.6',
    provider: 'Anthropic',
    inputPrice: 3.0,
    outputPrice: 15.0,
    cachedInputPrice: 0.3,
    cacheWrite5mPrice: 3.75,
    cacheWrite1hPrice: 6.0,
  },
  {
    name: 'Claude Haiku 4.5',
    provider: 'Anthropic',
    inputPrice: 1.0,
    outputPrice: 5.0,
    cachedInputPrice: 0.1,
    cacheWrite5mPrice: 1.25,
    cacheWrite1hPrice: 2.0,
  },
  {
    name: 'GPT-4o',
    provider: 'OpenAI',
    inputPrice: 2.5,
    outputPrice: 10.0,
    cachedInputPrice: 1.25,
    cacheWrite5mPrice: 2.5,
    cacheWrite1hPrice: 2.5,
  },
  {
    name: 'GPT-4o-mini',
    provider: 'OpenAI',
    inputPrice: 0.15,
    outputPrice: 0.6,
    cachedInputPrice: 0.075,
    cacheWrite5mPrice: 0.15,
    cacheWrite1hPrice: 0.15,
  },
  {
    name: 'Gemini 2.5 Pro',
    provider: 'Google',
    inputPrice: 1.25,
    outputPrice: 10.0,
    cachedInputPrice: 0.313,
    cacheWrite5mPrice: 1.25,
    cacheWrite1hPrice: 1.25,
  },
  {
    name: 'Gemini 2.5 Flash',
    provider: 'Google',
    inputPrice: 0.15,
    outputPrice: 0.6,
    cachedInputPrice: 0.038,
    cacheWrite5mPrice: 0.15,
    cacheWrite1hPrice: 0.15,
  },
  {
    name: 'DeepSeek V4 Pro',
    provider: 'DeepSeek',
    inputPrice: 0.6,
    outputPrice: 2.4,
    cachedInputPrice: 0.06,
    cacheWrite5mPrice: 0.6,
    cacheWrite1hPrice: 0.6,
  },
];

// ── Session token reader ───────────────────────────────────────────────

/** Token counts split by how each kind is priced. */
interface Tokens {
  inputTokens: number;
  outputTokens: number;
  /** Cache read tokens. */
  cachedInputTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

interface SessionUsage extends Tokens {
  turnCount: number;
  sessionId: string;
  projectPath: string;
  model: string;
  error?: string;
}

interface SessionSummary extends Tokens {
  sessionId: string;
  turnCount: number;
  model: string;
}

interface ProjectUsage extends Tokens {
  projectPath: string;
  turnCount: number;
  sessionCount: number;
  sessions: SessionSummary[];
  error?: string;
}

interface AllUsage extends Tokens {
  turnCount: number;
  sessionCount: number;
  projectCount: number;
  projects: (Tokens & {
    projectPath: string;
    turnCount: number;
    sessionCount: number;
  })[];
  error?: string;
}

interface DailyUsage extends Tokens {
  turnCount: number;
  sessionCount: number;
  days: (Tokens & {
    date: string;
    turnCount: number;
    sessionCount: number;
  })[];
  error?: string;
}

interface UsageFields {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

function emptyTokens(): Tokens {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 };
}

function addTokens(acc: Tokens, t: Tokens): void {
  acc.inputTokens += t.inputTokens;
  acc.outputTokens += t.outputTokens;
  acc.cachedInputTokens += t.cachedInputTokens;
  acc.cacheWrite5mTokens += t.cacheWrite5mTokens;
  acc.cacheWrite1hTokens += t.cacheWrite1hTokens;
}

function totalTokens(t: Tokens): number {
  return t.inputTokens + t.outputTokens + t.cachedInputTokens + t.cacheWrite5mTokens + t.cacheWrite1hTokens;
}

/** Split one API call's usage into the kinds of tokens that are priced differently. */
function usageTokens(u: UsageFields): Tokens {
  const writes = u.cache_creation_input_tokens ?? 0;
  // Transcripts without the TTL breakdown count every write as a 5-minute write.
  const writes1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cachedInputTokens: u.cache_read_input_tokens ?? 0,
    cacheWrite5mTokens: writes - writes1h,
    cacheWrite1hTokens: writes1h,
  };
}

/**
 * With sdkOnly, count only turns sent through the Claude Agent SDK
 * (entrypoint "sdk-cli", "sdk-py", "sdk-ts", ...), which are billed to an API
 * key, and skip turns from the interactive Claude Code CLI (entrypoint "cli"),
 * which a Claude subscription may cover instead.
 */
function skipEntry(entry: { entrypoint?: unknown }, sdkOnly: boolean): boolean {
  return sdkOnly && !String(entry.entrypoint ?? '').startsWith('sdk');
}

/**
 * Normalize a user-supplied path to the canonical Windows form.
 * Handles: C:/Users/...  →  C:\Users\...  or  /home/user/...  as-is.
 */
function normalizePath(p: string): string {
  let n = p.trim();
  // Convert forward slashes to backslashes on Windows
  if (process.platform === 'win32') {
    n = n.replace(/\//g, '\\');
    // Ensure drive letter is uppercase (C: → C:)
    n = n.replace(/^([a-z]):/i, (_, d) => d.toUpperCase() + ':');
    // If path starts with drive but no backslash, fix (C:Users → C:\Users)
    n = n.replace(/^([A-Z]):(?!\\)/, '$1:\\');
  }
  return n;
}

/**
 * Encode a Windows project path to match Claude's directory naming.
 * C:\Users\...  →  C--Users-...
 * Also handles forward-slash inputs and lowercase drive letters.
 */
function encodeProjectPath(projectPath: string): string {
  const p = normalizePath(projectPath);
  // Claude Code replaces every character other than A-Z, a-z and 0-9 with -:
  // C:\Users\me\my_app → C--Users-me-my-app, /home/me/.config → -home-me--config
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Resolve the Claude data root directory (~/.claude).
 * Tries multiple sources since the plugin subprocess has a restricted env.
 */
function resolveClaudeDir(): string {
  const candidates: string[] = [];

  // os.homedir() is most reliable
  try { candidates.push(os.homedir()); } catch { /* ignore */ }
  // Windows fallbacks
  if (process.env.USERPROFILE) candidates.push(process.env.USERPROFILE);
  // Unix HOME
  if (process.env.HOME) candidates.push(process.env.HOME);
  // Derive from process.cwd() if it looks like it's under a home dir
  try {
    const cwd = process.cwd();
    if (cwd) candidates.push(cwd);
  } catch { /* ignore */ }

  for (const home of candidates) {
    const claudeDir = path.join(home, '.claude');
    if (fs.existsSync(claudeDir)) {
      return claudeDir;
    }
  }

  // Last resort: return first candidate
  return path.join(candidates[0] || os.homedir(), '.claude');
}

/**
 * Try to find a session JSONL file by scanning the projects directory.
 * Returns { projectsDir, sessionFile } or null.
 */
function findSession(projectPath: string, sessionId: string): { projectsDir: string; sessionFile: string } | null {
  const encoded = encodeProjectPath(projectPath);
  const claudeDir = resolveClaudeDir();
  const projectsRoot = path.join(claudeDir, 'projects');

  // 1) Exact match with encoded path
  const exactDir = path.join(projectsRoot, encoded);
  if (fs.existsSync(exactDir)) {
    const f = path.join(exactDir, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) {
      return { projectsDir: exactDir, sessionFile: f };
    }
  }

  // 2) Scan all project dirs for a matching session file
  if (fs.existsSync(projectsRoot)) {
    try {
      const entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(projectsRoot, entry.name, `${sessionId}.jsonl`);
        if (fs.existsSync(candidate)) {
          return { projectsDir: path.join(projectsRoot, entry.name), sessionFile: candidate };
        }
      }
    } catch { /* ignore */ }
  }

  // 3) Fallback: try case-insensitive match on Windows
  if (process.platform === 'win32' && fs.existsSync(projectsRoot)) {
    try {
      const lower = encoded.toLowerCase();
      const entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.toLowerCase() === lower) {
          const f = path.join(projectsRoot, entry.name, `${sessionId}.jsonl`);
          if (fs.existsSync(f)) {
            return { projectsDir: path.join(projectsRoot, entry.name), sessionFile: f };
          }
        }
      }
    } catch { /* ignore */ }
  }

  return null;
}

/**
 * Parse a single JSONL file and accumulate token usage from assistant messages.
 */
async function parseSessionFile(filePath: string, sdkOnly: boolean): Promise<Tokens & { turnCount: number; model: string }> {
  const result = { ...emptyTokens(), turnCount: 0, model: '' };

  if (!fs.existsSync(filePath)) {
    return result;
  }

  const rl = createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  const seenMsgIds = new Set<string>();

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'assistant' || skipEntry(entry, sdkOnly)) continue;

      const usage = entry.message?.usage as UsageFields | undefined;
      if (!usage) continue;

      // DeepSeek models produce multiple content blocks per API call
      // (thinking, text, tool_use) — each gets its own JSONL entry but
      // they all share the same message.id and identical usage. Deduplicate.
      const msgId = entry.message?.id as string | undefined;
      if (msgId) {
        if (seenMsgIds.has(msgId)) continue;
        seenMsgIds.add(msgId);
      }

      result.turnCount++;
      addTokens(result, usageTokens(usage));

      if (!result.model && entry.message?.model) {
        result.model = entry.message.model;
      }
    } catch {
      // skip malformed lines
    }
  }

  return result;
}

/**
 * Parse a session file plus its subagent transcripts (<session>/subagents/*.jsonl).
 */
async function parseSessionWithSubagents(projectsDir: string, sessionId: string, sdkOnly: boolean): Promise<Tokens & { turnCount: number; model: string }> {
  const result = await parseSessionFile(path.join(projectsDir, `${sessionId}.jsonl`), sdkOnly);

  const subagentsDir = path.join(projectsDir, sessionId, 'subagents');
  if (fs.existsSync(subagentsDir)) {
    try {
      for (const sub of fs.readdirSync(subagentsDir, { withFileTypes: true })) {
        if (sub.isFile() && sub.name.endsWith('.jsonl')) {
          const r = await parseSessionFile(path.join(subagentsDir, sub.name), sdkOnly);
          addTokens(result, r);
          result.turnCount += r.turnCount;
        }
      }
    } catch { /* ignore */ }
  }

  return result;
}

/**
 * Read token usage from a Claude session JSONL file (including subagents).
 */
async function getSessionUsage(projectPath: string, sessionId: string, sdkOnly: boolean): Promise<SessionUsage> {
  if (!projectPath || !sessionId) {
    return { ...emptyTokens(), turnCount: 0, sessionId, projectPath, model: '', error: 'Missing projectPath or sessionId' };
  }

  const found = findSession(projectPath, sessionId);
  if (!found) {
    const encoded = encodeProjectPath(projectPath);
    const claudeDir = resolveClaudeDir();
    return {
      ...emptyTokens(),
      turnCount: 0, sessionId, projectPath, model: '',
      error: `Session not found. Looked in: ${path.join(claudeDir, 'projects', encoded)}. Try checking the project path and session ID.`,
    };
  }

  const usage = await parseSessionWithSubagents(found.projectsDir, sessionId, sdkOnly);
  return { ...usage, sessionId, projectPath, model: usage.model || 'unknown' };
}

// ── Project / All-time scanners ───────────────────────────────────────

/**
 * Parse all sessions for a single project directory and return aggregate.
 */
async function getProjectUsage(projectPath: string, sdkOnly: boolean): Promise<ProjectUsage> {
  if (!projectPath) {
    return { projectPath: '', ...emptyTokens(), turnCount: 0, sessionCount: 0, sessions: [], error: 'Missing projectPath' };
  }

  const encoded = encodeProjectPath(projectPath);
  const claudeDir = resolveClaudeDir();
  const projectsDir = path.join(claudeDir, 'projects', encoded);

  if (!fs.existsSync(projectsDir)) {
    return {
      projectPath,
      ...emptyTokens(), turnCount: 0, sessionCount: 0, sessions: [],
      error: `Project directory not found. Looked in: ${projectsDir}`,
    };
  }

  return scanProjectDir(projectsDir, projectPath, sdkOnly);
}

async function scanProjectDir(projectsDir: string, projectPath: string, sdkOnly: boolean): Promise<ProjectUsage> {
  const sessions: SessionSummary[] = [];
  const total = emptyTokens();
  let totalTurns = 0;

  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;

    const sessionId = entry.name.replace(/\.jsonl$/, '');
    const usage = await parseSessionWithSubagents(projectsDir, sessionId, sdkOnly);

    if (totalTokens(usage) > 0) {
      sessions.push({ ...usage, sessionId, model: usage.model || 'unknown' });
      addTokens(total, usage);
      totalTurns += usage.turnCount;
    }
  }

  // Sort sessions by total tokens descending
  sessions.sort((a, b) => totalTokens(b) - totalTokens(a));

  return {
    projectPath,
    ...total,
    turnCount: totalTurns,
    sessionCount: sessions.length,
    sessions,
  };
}

/**
 * Scan ALL projects under ~/.claude/projects and return aggregate.
 */
async function getAllUsage(sdkOnly: boolean): Promise<AllUsage> {
  const claudeDir = resolveClaudeDir();
  const projectsRoot = path.join(claudeDir, 'projects');

  if (!fs.existsSync(projectsRoot)) {
    return {
      ...emptyTokens(), turnCount: 0, sessionCount: 0, projectCount: 0, projects: [],
      error: `Projects directory not found: ${projectsRoot}`,
    };
  }

  const projects: AllUsage['projects'] = [];
  const total = emptyTokens();
  let totalTurns = 0;
  let totalSessions = 0;

  const dirEntries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  for (const dir of dirEntries) {
    if (!dir.isDirectory()) continue;

    const projectDir = path.join(projectsRoot, dir.name);
    // Decode project path for display (reverse of encode)
    const decodedPath = decodeProjectPath(dir.name);
    const usage = await scanProjectDir(projectDir, decodedPath, sdkOnly);

    if (usage.sessionCount > 0) {
      const { sessions: _sessions, error: _error, ...summary } = usage;
      projects.push(summary);
      addTokens(total, usage);
      totalTurns += usage.turnCount;
      totalSessions += usage.sessionCount;
    }
  }

  // Sort projects by total tokens descending
  projects.sort((a, b) => totalTokens(b) - totalTokens(a));

  return {
    ...total,
    turnCount: totalTurns,
    sessionCount: totalSessions,
    projectCount: projects.length,
    projects,
  };
}

/**
 * Reverse the encoded project path back to a readable form.
 * C--Users-19447-Documents-cc-project  →  C:\Users-19447-Documents-cc-project
 * Note: lossy — spaces/underscores that were encoded as - stay as -.
 */
function decodeProjectPath(encoded: string): string {
  // E--... → E:\...
  return encoded.replace(/^([A-Z])--/, '$1:\\');
}

// ── Daily usage scanner ─────────────────────────────────────────────

/**
 * Scan all sessions across all projects and aggregate token usage by day.
 */
async function getDailyUsage(sdkOnly: boolean): Promise<DailyUsage> {
  const claudeDir = resolveClaudeDir();
  const projectsRoot = path.join(claudeDir, 'projects');

  if (!fs.existsSync(projectsRoot)) {
    return {
      ...emptyTokens(), turnCount: 0, sessionCount: 0, days: [],
      error: `Projects directory not found: ${projectsRoot}`,
    };
  }

  // Map from date string (YYYY-MM-DD) to aggregate
  const dayMap = new Map<string, Tokens & { turnCount: number; sessions: Set<string> }>();

  const dirEntries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  for (const dir of dirEntries) {
    if (!dir.isDirectory()) continue;

    const projectDir = path.join(projectsRoot, dir.name);
    let fileEntries: fs.Dirent[];
    try { fileEntries = fs.readdirSync(projectDir, { withFileTypes: true }); } catch { continue; }

    for (const file of fileEntries) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;

      const sessionId = file.name.replace(/\.jsonl$/, '');
      const sessionFile = path.join(projectDir, file.name);
      const dailySessions = await parseDailyFile(sessionFile, sdkOnly);

      for (const [date, usage] of dailySessions) {
        let day = dayMap.get(date);
        if (!day) {
          day = { ...emptyTokens(), turnCount: 0, sessions: new Set() };
          dayMap.set(date, day);
        }
        addTokens(day, usage);
        day.turnCount += usage.turnCount;
        day.sessions.add(sessionId);
      }
    }
  }

  // Build sorted array
  const total = emptyTokens();
  let totalTurns = 0;
  const allSessions = new Set<string>();

  const days = Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b)) // chronological
    .map(([date, d]) => {
      addTokens(total, d);
      totalTurns += d.turnCount;
      d.sessions.forEach((s) => allSessions.add(s));
      const { sessions, ...tokens } = d;
      return { date, ...tokens, sessionCount: sessions.size };
    });

  return {
    ...total,
    turnCount: totalTurns,
    sessionCount: allSessions.size,
    days,
  };
}

/**
 * Parse a JSONL file and aggregate token usage per day.
 * Returns a Map of date → usage.
 */
async function parseDailyFile(
  filePath: string,
  sdkOnly: boolean,
): Promise<Map<string, Tokens & { turnCount: number }>> {
  const dayMap = new Map<string, Tokens & { turnCount: number }>();

  if (!fs.existsSync(filePath)) return dayMap;

  const rl = createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  const seenMsgIds = new Set<string>();

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'assistant' || skipEntry(entry, sdkOnly)) continue;

      const usage = entry.message?.usage as UsageFields | undefined;
      if (!usage) continue;

      // DeepSeek models produce multiple content blocks per API call
      // (thinking, text, tool_use) — each gets its own JSONL entry but
      // they all share the same message.id and identical usage. Deduplicate.
      const msgId = entry.message?.id as string | undefined;
      if (msgId) {
        if (seenMsgIds.has(msgId)) continue;
        seenMsgIds.add(msgId);
      }

      const ts = entry.timestamp;
      if (!ts) continue; // no timestamp, skip

      const date = new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD

      let day = dayMap.get(date);
      if (!day) {
        day = { ...emptyTokens(), turnCount: 0 };
        dayMap.set(date, day);
      }
      addTokens(day, usageTokens(usage));
      day.turnCount++;
    } catch {
      // skip malformed lines
    }
  }

  return dayMap;
}

// ── HTTP server ────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', 'http://localhost');
  // ?sdkOnly=1 counts only Agent SDK turns (see skipEntry)
  const sdkOnly = url.searchParams.get('sdkOnly') === '1';

  // GET /presets — return all preset model pricing
  if (req.method === 'GET' && (url.pathname === '/presets' || url.pathname === '//presets')) {
    res.writeHead(200);
    res.end(JSON.stringify(PRESETS));
    return;
  }

  // GET /session-usage?projectPath=...&sessionId=...
  if (req.method === 'GET' && (url.pathname === '/session-usage' || url.pathname === '//session-usage')) {
    const projectPath = url.searchParams.get('projectPath');
    const sessionId = url.searchParams.get('sessionId');

    if (!projectPath || !sessionId) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing projectPath or sessionId' }));
      return;
    }

    try {
      const usage = await getSessionUsage(projectPath, sessionId, sdkOnly);
      res.writeHead(200);
      res.end(JSON.stringify(usage));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  // POST /calculate — server-side cost verification
  if (req.method === 'POST' && (url.pathname === '/calculate' || url.pathname === '//calculate')) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const {
          inputPrice, outputPrice, cachedInputPrice, cacheWrite5mPrice = 0, cacheWrite1hPrice = 0,
          inputTokens, outputTokens, cachedInputTokens, cacheWrite5mTokens = 0, cacheWrite1hTokens = 0,
        } = JSON.parse(body);

        const inputCost = (inputTokens / 1_000_000) * inputPrice;
        const outputCost = (outputTokens / 1_000_000) * outputPrice;
        const cachedInputCost = (cachedInputTokens / 1_000_000) * cachedInputPrice;
        const cacheWriteCost = (cacheWrite5mTokens / 1_000_000) * cacheWrite5mPrice
          + (cacheWrite1hTokens / 1_000_000) * cacheWrite1hPrice;
        const total = inputCost + outputCost + cachedInputCost + cacheWriteCost;

        res.writeHead(200);
        res.end(JSON.stringify({
          inputCost: Math.round(inputCost * 10000) / 10000,
          outputCost: Math.round(outputCost * 10000) / 10000,
          cachedInputCost: Math.round(cachedInputCost * 10000) / 10000,
          cacheWriteCost: Math.round(cacheWriteCost * 10000) / 10000,
          total: Math.round(total * 10000) / 10000,
        }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
    return;
  }

  // GET /project-usage?projectPath=... — sum of all sessions in one project
  if (req.method === 'GET' && (url.pathname === '/project-usage' || url.pathname === '//project-usage')) {
    const projectPath = url.searchParams.get('projectPath');
    if (!projectPath) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing projectPath' }));
      return;
    }
    try {
      const usage = await getProjectUsage(projectPath, sdkOnly);
      res.writeHead(200);
      res.end(JSON.stringify(usage));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  // GET /all-usage — sum of all sessions across all projects
  if (req.method === 'GET' && (url.pathname === '/all-usage' || url.pathname === '//all-usage')) {
    try {
      const usage = await getAllUsage(sdkOnly);
      res.writeHead(200);
      res.end(JSON.stringify(usage));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  // GET /daily-usage — token usage aggregated by day across all projects
  if (req.method === 'GET' && (url.pathname === '/daily-usage' || url.pathname === '//daily-usage')) {
    try {
      const usage = await getDailyUsage(sdkOnly);
      res.writeHead(200);
      res.end(JSON.stringify(usage));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  if (addr && typeof addr !== 'string') {
    console.log(JSON.stringify({ ready: true, port: addr.port }));
  }
});
