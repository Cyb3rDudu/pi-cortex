/**
 * pi-recap (v0.1)
 *
 * Auto-summarizes the current Pi session and writes the recap back to
 * mcp-memory-service so the next session (or any other client) can pick up
 * where this one left off.
 *
 * Triggers:
 *   - session_before_compact  (save state before context loss)
 *   - session_shutdown        (one final snapshot at process exit)
 *
 * Each recap is stored with:
 *   - tags = ["proj:<key>", "type:session-recap", "source:pi-recap",
 *             "date:YYYY-MM-DD", ...topic tags]
 *   - memory_type = "session-recap"
 *   - parent_id   = content_hash of the previous recap for this project
 *                   (chain across sessions; queried at startup, updated after
 *                   each successful write)
 *
 * Project key derivation order: git remote → project marker → configured
 * PI_CORTEX_PROJECT_ROOTS (so e.g. ~/Code/bounties/acme.com/ → proj:acme.com
 * even without a git repo). Topic tags come from PI_CORTEX_TOPIC_ROOTS
 * (e.g. ~/Code/bounties=bug-bounty appends `topic:bug-bounty`).
 *
 * Configure via environment variables (see CLAUDE.md for the full table).
 *
 * License: MIT
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { completeSimple, type Model } from "@mariozechner/pi-ai";
import type {
  AssistantMessage,
  Message,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from "@mariozechner/pi-ai";

const ENDPOINT = (process.env.PI_MEMORY_ENDPOINT ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
const API_KEY = process.env.PI_MEMORY_API_KEY ?? "";
const DISABLED = !!process.env.PI_RECAP_DISABLE;
const MIN_MESSAGES = clampInt(process.env.PI_RECAP_MIN_MESSAGES, 4, 1, 1000);
const MAX_CHARS = clampInt(process.env.PI_RECAP_MAX_CHARS, 24_000, 1_000, 200_000);
const MODEL_OVERRIDE = process.env.PI_RECAP_MODEL ?? "";
const PROJECT_ROOTS = parsePathList(process.env.PI_CORTEX_PROJECT_ROOTS);
const TOPIC_ROOTS = parseTopicRoots(process.env.PI_CORTEX_TOPIC_ROOTS);

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

const PROJECT_MARKERS = [
  "package.json",
  "go.mod",
  "pyproject.toml",
  "Cargo.toml",
  "composer.json",
  "Gemfile",
  ".git",
];

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function parsePathList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => path.resolve(expandHome(p)));
}

interface TopicRoot {
  root: string;
  topic: string;
}

function parseTopicRoots(raw: string | undefined): TopicRoot[] {
  if (!raw) return [];
  const out: TopicRoot[] = [];
  for (const piece of raw.split(",")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0 || eq === trimmed.length - 1) continue;
    const root = path.resolve(expandHome(trimmed.slice(0, eq).trim()));
    const topic = trimmed.slice(eq + 1).trim();
    if (root && topic) out.push({ root, topic });
  }
  return out;
}

function isUnderRoot(cwd: string, root: string): boolean {
  if (cwd === root) return false;
  const rel = path.relative(root, cwd);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function deriveFromRoots(cwd: string, roots: string[]): string | null {
  const sorted = [...roots].sort((a, b) => b.length - a.length);
  for (const root of sorted) {
    if (!isUnderRoot(cwd, root)) continue;
    const rel = path.relative(root, cwd);
    const first = rel.split(path.sep)[0];
    if (first) return `proj:${first}`;
  }
  return null;
}

function deriveTopicTags(cwd: string, topicRoots: TopicRoot[]): string[] {
  const tags = new Set<string>();
  for (const { root, topic } of topicRoots) {
    if (isUnderRoot(cwd, root)) tags.add(`topic:${topic}`);
  }
  return [...tags];
}

function safeGitRemote(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 1500,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function parseRemote(url: string): string | null {
  const stripped = url.replace(/\.git$/, "");
  const ssh = stripped.match(/^[a-z]+@([^:]+):(.+)$/i);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  try {
    const u = new URL(stripped);
    const p = u.pathname.replace(/^\/+/, "");
    return `${u.host}/${p}`;
  } catch {
    return null;
  }
}

function deriveProjectKey(cwd: string): string | null {
  const remote = safeGitRemote(cwd);
  if (remote) {
    const parsed = parseRemote(remote);
    if (parsed) return `proj:${parsed}`;
  }
  for (const marker of PROJECT_MARKERS) {
    if (fs.existsSync(path.join(cwd, marker))) {
      return `proj:${path.basename(cwd)}`;
    }
  }
  const fromRoots = deriveFromRoots(cwd, PROJECT_ROOTS);
  if (fromRoots) return fromRoots;
  return null;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;
  return headers;
}

interface MemoryShape {
  content?: string;
  content_hash?: string;
  tags?: string[];
  created_at_iso?: string;
}

async function searchByTagOnce(tags: string[], matchAll: boolean): Promise<MemoryShape[]> {
  const res = await fetch(ENDPOINT + "/api/search/by-tag", {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ tags, match_all: matchAll }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`mcp-memory-service ${res.status}`);
  const data = (await res.json()) as { results?: MemoryShape[]; memories?: MemoryShape[] };
  return data.results ?? data.memories ?? [];
}

async function findLatestRecapHash(projectKey: string): Promise<string | null> {
  try {
    const memories = await searchByTagOnce([projectKey, "type:session-recap"], true);
    if (memories.length === 0) return null;
    memories.sort((a, b) => (b.created_at_iso ?? "").localeCompare(a.created_at_iso ?? ""));
    return memories[0]?.content_hash ?? null;
  } catch {
    return null;
  }
}

interface StoreResult {
  content_hash?: string;
  success?: boolean;
}

async function storeRecap(
  projectKey: string,
  topicTags: string[],
  content: string,
  parentHash: string | null,
): Promise<string | null> {
  const isoDate = new Date().toISOString().slice(0, 10);
  const body: Record<string, unknown> = {
    content,
    tags: [projectKey, "type:session-recap", "source:pi-recap", `date:${isoDate}`, ...topicTags],
    memory_type: "session-recap",
  };
  if (parentHash) {
    body.parent_id = parentHash;
    body.relationship_type = "follows";
  }
  const res = await fetch(ENDPOINT + "/api/memories", {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`mcp-memory-service ${res.status}: ${text || res.statusText}`);
  }
  const data = (await res.json()) as StoreResult;
  return data.content_hash ?? null;
}

interface MaybeMessageEntry {
  type?: string;
  id?: string;
  message?: Message;
}

function isMessageEntry(e: MaybeMessageEntry): e is { type: "message"; id: string; message: Message } {
  return e.type === "message" && !!e.message && typeof e.id === "string";
}

function textOfContent(content: UserMessage["content"] | AssistantMessage["content"] | ToolResultMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((c) => {
      if (c.type === "text") return (c as TextContent).text;
      if (c.type === "thinking") return "";
      if (c.type === "image") return "[image]";
      if (c.type === "toolCall") {
        const args = JSON.stringify((c as { arguments?: unknown }).arguments ?? {});
        return `[tool-call ${(c as { name?: string }).name ?? "?"}(${args.slice(0, 200)})]`;
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function renderMessage(m: Message): string | null {
  if (m.role === "user") {
    const t = textOfContent(m.content).trim();
    return t ? `USER: ${t}` : null;
  }
  if (m.role === "assistant") {
    const t = textOfContent(m.content).trim();
    return t ? `ASSISTANT: ${t}` : null;
  }
  if (m.role === "toolResult") {
    const t = textOfContent(m.content).trim();
    if (!t) return null;
    return `TOOL[${m.toolName}]${m.isError ? "(error)" : ""}: ${t.slice(0, 600)}`;
  }
  return null;
}

function buildTranscript(messages: Message[], maxChars: number): string {
  const rendered = messages.map(renderMessage).filter((s): s is string => !!s);
  // Walk newest → oldest, keep until we hit the budget, then reverse to chronological.
  let total = 0;
  const kept: string[] = [];
  for (let i = rendered.length - 1; i >= 0; i--) {
    const line = rendered[i]!;
    const len = line.length + 1;
    if (total + len > maxChars && kept.length > 0) break;
    kept.push(line);
    total += len;
  }
  kept.reverse();
  if (kept.length < rendered.length) {
    kept.unshift(`[...${rendered.length - kept.length} earlier message(s) truncated...]`);
  }
  return kept.join("\n\n");
}

const RECAP_SYSTEM_PROMPT = `You are summarizing a coding-agent session for long-term memory. Output a tight markdown brief that a future session can read in seconds and immediately know what to do next.

Format (omit empty sections):

### Goal
One or two sentences — what the user was trying to do.

### What was done
Bullet list of concrete actions: files touched, commands run, decisions made, bugs fixed. Be specific (paths, function names, command names).

### Findings & decisions
Bullet list of non-obvious facts, gotchas, or design choices that future sessions need to know. Note rationale ("we chose X because Y") when present.

### Open / next steps
Bullet list of unfinished work, TODOs, or follow-up questions, ordered by what to pick up first.

Hard rules:
- Be terse. No preamble, no closing remarks.
- No quotes from the transcript — paraphrase.
- Cap output at ~400 words.
- If the session was trivial (no real work), output a single line: \`Trivial session: <one-sentence description>\`.`;

interface ParsedModelRef {
  provider: string;
  modelId: string;
}

function parseModelOverride(s: string): ParsedModelRef | null {
  const idx = s.indexOf("/");
  if (idx <= 0 || idx === s.length - 1) return null;
  return { provider: s.slice(0, idx), modelId: s.slice(idx + 1) };
}

async function pickModel(ctx: ExtensionContext): Promise<{ model: Model<any>; apiKey: string } | null> {
  const tryModel = async (m: Model<any> | undefined): Promise<{ model: Model<any>; apiKey: string } | null> => {
    if (!m) return null;
    const key = await ctx.modelRegistry.getApiKey(m).catch(() => undefined);
    if (!key) return null;
    return { model: m, apiKey: key };
  };

  if (MODEL_OVERRIDE) {
    const ref = parseModelOverride(MODEL_OVERRIDE);
    if (ref) {
      const m = ctx.modelRegistry.find(ref.provider, ref.modelId);
      const picked = await tryModel(m);
      if (picked) return picked;
    }
  }
  const current = await tryModel(ctx.model);
  if (current) return current;
  for (const m of ctx.modelRegistry.getAvailable()) {
    const picked = await tryModel(m);
    if (picked) return picked;
  }
  return null;
}

async function summarize(
  ctx: ExtensionContext,
  transcript: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const picked = await pickModel(ctx);
  if (!picked) return null;
  const userMessage: UserMessage = {
    role: "user",
    content: `Transcript follows. Summarize per the format above.\n\n---\n\n${transcript}`,
    timestamp: Date.now(),
  };
  const result = await completeSimple(
    picked.model,
    {
      systemPrompt: RECAP_SYSTEM_PROMPT,
      messages: [userMessage],
    },
    {
      apiKey: picked.apiKey,
      maxTokens: 1200,
      temperature: 0.2,
      signal,
    },
  );
  const text = result.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("")
    .trim();
  return text || null;
}

interface RecapState {
  projectKey: string;
  topicTags: string[];
  parentHash: string | null;
  lastRecappedEntryId: string | null;
  lastRecap: { trigger: string; at: number; content: string; hash: string | null } | null;
  inFlight: boolean;
}

function collectMessages(
  ctx: ExtensionContext,
  sinceEntryId: string | null,
): { messages: Message[]; lastEntryId: string | null } {
  const branch = ctx.sessionManager.getBranch() as unknown as MaybeMessageEntry[];
  let started = sinceEntryId === null;
  const messages: Message[] = [];
  let lastEntryId: string | null = null;
  for (const entry of branch) {
    if (!started) {
      if (entry.id === sinceEntryId) started = true;
      continue;
    }
    if (isMessageEntry(entry)) {
      messages.push(entry.message);
      lastEntryId = entry.id;
    }
  }
  return { messages, lastEntryId };
}

async function runRecap(
  ctx: ExtensionContext,
  state: RecapState,
  trigger: "session_before_compact" | "session_shutdown" | "manual",
  signal?: AbortSignal,
): Promise<{ ok: boolean; reason?: string }> {
  if (state.inFlight) return { ok: false, reason: "already running" };
  state.inFlight = true;
  try {
    const { messages, lastEntryId } = collectMessages(ctx, state.lastRecappedEntryId);
    if (messages.length < MIN_MESSAGES) {
      return { ok: false, reason: `only ${messages.length} new message(s); below PI_RECAP_MIN_MESSAGES=${MIN_MESSAGES}` };
    }
    const transcript = buildTranscript(messages, MAX_CHARS);
    const summary = await summarize(ctx, transcript, signal);
    if (!summary) return { ok: false, reason: "no model with API key available for summarization" };
    const header = `# Session recap (${trigger}) — ${new Date().toISOString()}\nProject: ${state.projectKey}\n\n`;
    const content = header + summary;
    const hash = await storeRecap(state.projectKey, state.topicTags, content, state.parentHash);
    state.parentHash = hash ?? state.parentHash;
    state.lastRecappedEntryId = lastEntryId ?? state.lastRecappedEntryId;
    state.lastRecap = { trigger, at: Date.now(), content, hash };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  } finally {
    state.inFlight = false;
  }
}

export default async function piRecapExtension(pi: ExtensionAPI) {
  if (DISABLED) return;

  const cwd = process.cwd();
  const projectKey = deriveProjectKey(cwd);
  if (!projectKey) {
    // Per CLAUDE.md: Pi extensions never write `proj:none` and never recap when
    // no project key derives.
    return;
  }

  const state: RecapState = {
    projectKey,
    topicTags: deriveTopicTags(cwd, TOPIC_ROOTS),
    parentHash: await findLatestRecapHash(projectKey),
    lastRecappedEntryId: null,
    lastRecap: null,
    inFlight: false,
  };

  pi.on("session_before_compact", async (event, ctx) => {
    const result = await runRecap(ctx, state, "session_before_compact", event.signal);
    if (ctx.hasUI) {
      ctx.ui.notify(
        result.ok ? "pi-recap: recap saved before compaction" : `pi-recap: skipped (${result.reason})`,
        result.ok ? "info" : "warning",
      );
    }
    // Never cancel compaction — best-effort writeback.
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await runRecap(ctx, state, "session_shutdown");
    // No notify on shutdown — UI may be torn down.
  });

  pi.registerCommand("recap", {
    description: "Inspect or trigger pi-recap (subcommands: status | now).",
    handler: async (args, ctx) => {
      const cmd = args.trim();
      if (cmd === "" || cmd === "status") {
        const last = state.lastRecap;
        const lastLine = last
          ? `last: ${last.trigger} ${Math.round((Date.now() - last.at) / 1000)}s ago${
              last.hash ? ` (hash ${last.hash.slice(0, 8)})` : " (no hash returned)"
            }`
          : "last: never (this session)";
        const parentLine = state.parentHash
          ? `chain parent: ${state.parentHash.slice(0, 8)}…`
          : "chain parent: none (first recap for this project)";
        ctx.ui.notify(
          `pi-recap: project=${state.projectKey}, topics=[${state.topicTags.join(",")}], ${lastLine}, ${parentLine}, in_flight=${state.inFlight}`,
          "info",
        );
        if (last) ctx.ui.notify(last.content, "info");
        return;
      }
      if (cmd === "now") {
        ctx.ui.notify("pi-recap: running…", "info");
        const result = await runRecap(ctx, state, "manual");
        ctx.ui.notify(
          result.ok ? "pi-recap: recap saved" : `pi-recap: skipped (${result.reason})`,
          result.ok ? "info" : "warning",
        );
        return;
      }
      ctx.ui.notify("pi-recap: usage — /recap [status|now]", "info");
    },
  });
}
