/**
 * pi-memory
 *
 * Pi extension that exposes mcp-memory-service (https://github.com/doobidoo/mcp-memory-service)
 * as plain Pi tools — no MCP layer needed. Hits the service's REST API directly.
 *
 * Configure via environment variables:
 *   PI_MEMORY_ENDPOINT  Base URL of mcp-memory-service HTTP API.
 *                       Default: http://127.0.0.1:8000
 *   PI_MEMORY_API_KEY   Optional bearer token. If unset, requests are unauthenticated
 *                       (the service must allow anonymous access).
 *
 * Tools registered:
 *   memory_search           — semantic search via /api/search
 *   memory_search_by_tag    — exact-tag filter via /api/search/by-tag
 *   memory_recent           — list most recent N memories via /api/memories
 *   memory_store            — write a new memory via POST /api/memories
 *
 * License: MIT
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const ENDPOINT = (process.env.PI_MEMORY_ENDPOINT ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
const API_KEY = process.env.PI_MEMORY_API_KEY ?? "";
const PROJECT_ROOTS = parsePathList(process.env.PI_CORTEX_PROJECT_ROOTS);
const TOPIC_ROOTS = parseTopicRoots(process.env.PI_CORTEX_TOPIC_ROOTS);

const PROJECT_MARKERS = [
	"package.json",
	"go.mod",
	"pyproject.toml",
	"Cargo.toml",
	"composer.json",
	"Gemfile",
	".git",
];

// Canonical type values from CLAUDE.md. Used to teach the model and to keep
// the agent honest when it picks a memory_type.
const VALID_TYPES = [
	"scope",
	"recon",
	"enum",
	"finding",
	"negative",
	"decision",
	"session-recap",
	"reference",
	"user",
	"feedback",
	"research",
	"reading",
	"idea",
	"question",
	"note",
] as const;

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
	const sorted = [...PROJECT_ROOTS].sort((a, b) => b.length - a.length);
	for (const root of sorted) {
		if (!isUnderRoot(cwd, root)) continue;
		const rel = path.relative(root, cwd);
		const first = rel.split(path.sep)[0];
		if (first) return `proj:${first}`;
	}
	return null;
}

function deriveTopicTags(cwd: string): string[] {
	const tags = new Set<string>();
	for (const { root, topic } of TOPIC_ROOTS) {
		if (isUnderRoot(cwd, root)) tags.add(`topic:${topic}`);
	}
	return [...tags];
}

// Enforce v0.2 schema on every write: always inject proj:<key> (when
// derivable), topic:<x> per PI_CORTEX_TOPIC_ROOTS, source:agent, and
// date:YYYY-MM-DD. If the agent passes a `memory_type` that matches a
// canonical type, also inject `type:<value>`. Dedupe so we never write a
// duplicate tag if the agent already supplied one of these.
function enrichTags(rawTags: string[], memoryType: string | undefined): string[] {
	const tags = new Set(rawTags);
	const cwd = process.cwd();

	const proj = deriveProjectKey(cwd);
	if (proj && !rawTags.some((t) => t.startsWith("proj:"))) {
		tags.add(proj);
	}
	for (const t of deriveTopicTags(cwd)) {
		tags.add(t);
	}
	if (!rawTags.some((t) => t.startsWith("source:"))) {
		tags.add("source:agent");
	}
	if (!rawTags.some((t) => t.startsWith("date:"))) {
		tags.add(`date:${new Date().toISOString().slice(0, 10)}`);
	}
	if (memoryType && (VALID_TYPES as readonly string[]).includes(memoryType)) {
		if (!rawTags.some((t) => t.startsWith("type:"))) {
			tags.add(`type:${memoryType}`);
		}
	}
	return [...tags];
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
	const headers: Record<string, string> = { ...extra };
	if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;
	return headers;
}

async function call<T = unknown>(
	path: string,
	init: { method?: string; body?: unknown; query?: Record<string, string | number> } = {},
): Promise<T> {
	const url = new URL(ENDPOINT + path);
	for (const [k, v] of Object.entries(init.query ?? {})) {
		url.searchParams.set(k, String(v));
	}
	const res = await fetch(url, {
		method: init.method ?? "GET",
		headers: authHeaders(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
		body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`mcp-memory-service ${res.status}: ${text || res.statusText}`);
	}
	const data = (await res.json()) as T;
	// mcp-memory-service returns HTTP 200 with `{success: false, message: ...}`
	// for application-level failures (db locked, duplicate-content dedupe, etc.).
	// Surface those as thrown errors so the LLM sees the real outcome instead
	// of a hallucinated success.
	const maybe = data as unknown as { success?: boolean; message?: string };
	if (maybe && maybe.success === false) {
		throw new Error(`mcp-memory-service refused: ${maybe.message ?? "unknown error"}`);
	}
	return data;
}

interface MemoryShape {
	content?: string;
	content_hash?: string;
	tags?: string[];
	memory_type?: string;
	created_at_iso?: string;
	[k: string]: unknown;
}

// mcp-memory-service search endpoints wrap each hit:
//   { results: [{ memory: <Memory>, similarity_score, relevance_reason }, ...] }
// The /api/memories listing returns flat:
//   { memories: [<Memory>, ...] }
// Normalize both to a flat MemoryShape[].
function normalizeMemoryList(data: { results?: unknown[]; memories?: unknown[] }): MemoryShape[] {
	const items = data.results ?? data.memories ?? [];
	return items
		.map((item) => {
			if (item && typeof item === "object" && "memory" in item) {
				return (item as { memory?: MemoryShape }).memory;
			}
			return item as MemoryShape;
		})
		.filter((m): m is MemoryShape => !!m && typeof m === "object");
}

function summarizeMemory(m: MemoryShape): string {
	const tags = (m.tags ?? []).join(", ") || "—";
	const date = m.created_at_iso?.slice(0, 10) ?? "—";
	const head = (m.content ?? "").slice(0, 240).replace(/\s+/g, " ");
	return `[${date}] (${tags}) ${head}`;
}

const SearchParams = Type.Object({
	query: Type.String({ description: "Natural-language query for semantic search" }),
	n_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 8 })),
});

const SearchByTagParams = Type.Object({
	tags: Type.Array(Type.String(), { description: "Tags to match. Memories with any matching tag are returned." }),
	match_all: Type.Optional(Type.Boolean({ description: "If true, require ALL tags to match.", default: false })),
});

const RecentParams = Type.Object({
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10 })),
});

const StoreParams = Type.Object({
	content: Type.String({ description: "The memory content. Keep it concise (~300 chars or less)." }),
	tags: Type.Array(Type.String(), {
		description:
			"Optional dimensional tags following the v0.2 schema: host:<x>, vuln:<x>, tech:<x>, severity:<critical|high|medium|low|info>, status:<open|fixed|dup|deprecated>, cve:<id>. Do NOT write proj:, topic:, source:, or date: by hand — those are auto-attached.",
	}),
	memory_type: Type.String({
		description:
			"REQUIRED. The kind of memory. One of: scope, recon, enum, finding, negative, decision, session-recap, reference, user, feedback, research, reading, idea, question, note. This drives the auto-attached type:<value> tag.",
	}),
});

export default function piMemoryExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description: "Semantic search over the long-term memory store (mcp-memory-service).",
		promptSnippet: "Search the memory store for context relevant to a natural-language query.",
		promptGuidelines: [
			"Call this when picking up a topic the user has worked on before.",
			"Use specific noun phrases as the query — names, domains, tools, IDs.",
			"Default n_results is 8; raise only if breadth matters more than precision.",
		],
		parameters: SearchParams,
		async execute(_id, { query, n_results }) {
			const data = await call<{ results?: unknown[]; memories?: unknown[] }>("/api/search", {
				method: "POST",
				body: { query, n_results: n_results ?? 8 },
			});
			const list = normalizeMemoryList(data);
			if (list.length === 0) {
				return { content: [{ type: "text", text: "No matching memories." }], details: { count: 0 } };
			}
			const lines = list.map((m, i) => `${i + 1}. ${summarizeMemory(m)}`).join("\n");
			return {
				content: [{ type: "text", text: `Found ${list.length} memory(s):\n${lines}` }],
				details: { count: list.length, query },
			};
		},
	});

	pi.registerTool({
		name: "memory_search_by_tag",
		label: "Memory Search by Tag",
		description: "Filter memories by exact tag match.",
		promptSnippet: "Find memories tagged with one or more specific labels.",
		promptGuidelines: [
			"Use this when you know the exact tag(s) to filter by — e.g. a project name, target host, or vuln class.",
			"Set match_all=true to require every supplied tag to be present.",
		],
		parameters: SearchByTagParams,
		async execute(_id, { tags, match_all }) {
			const data = await call<{ results?: unknown[]; memories?: unknown[] }>("/api/search/by-tag", {
				method: "POST",
				body: { tags, match_all: match_all ?? false },
			});
			const list = normalizeMemoryList(data);
			if (list.length === 0) {
				return { content: [{ type: "text", text: "No memories with those tags." }], details: { count: 0 } };
			}
			const lines = list.map((m, i) => `${i + 1}. ${summarizeMemory(m)}`).join("\n");
			return {
				content: [{ type: "text", text: `Found ${list.length} memory(s):\n${lines}` }],
				details: { count: list.length, tags, match_all: !!match_all },
			};
		},
	});

	pi.registerTool({
		name: "memory_recent",
		label: "Recent Memories",
		description: "List the most recently created memories regardless of topic.",
		promptSnippet: "Show the latest memories that have been written to the store.",
		promptGuidelines: ["Useful at session start to remind yourself what was happening last time."],
		parameters: RecentParams,
		async execute(_id, { limit }) {
			const data = await call<{ memories?: unknown[]; results?: unknown[] }>("/api/memories", {
				query: { page_size: limit ?? 10 },
			});
			const list = normalizeMemoryList(data);
			if (list.length === 0) {
				return { content: [{ type: "text", text: "No memories yet." }], details: { count: 0 } };
			}
			const lines = list.map((m, i) => `${i + 1}. ${summarizeMemory(m)}`).join("\n");
			return {
				content: [{ type: "text", text: `Last ${list.length} memory(s):\n${lines}` }],
				details: { count: list.length },
			};
		},
	});

	pi.registerTool({
		name: "memory_store",
		label: "Store Memory",
		description:
			"Write a new memory to the long-term store under the v0.2 tag schema. The tool AUTO-ATTACHES proj:<key> (derived from cwd via git remote / project marker / PI_CORTEX_PROJECT_ROOTS), topic:<x> (per PI_CORTEX_TOPIC_ROOTS), source:agent, date:YYYY-MM-DD, and type:<memory_type>. Do not duplicate those by hand.",
		promptSnippet:
			"Persist a fact, decision, finding, or summary so future sessions (Pi or other clients) can recall it.",
		promptGuidelines: [
			"Always pass `memory_type` — it drives the canonical type:<value> tag. Pick from: scope, recon, enum, finding, negative, decision, session-recap, reference, user, feedback, research, reading, idea, question, note.",
			"In `tags`, only add OPTIONAL DIMENSIONAL tags: host:<domain>, vuln:<class>, tech:<stack>, severity:<level>, status:<state>, cve:<id>. Skip them when not applicable — empty array is fine.",
			"Do NOT write proj:, topic:, source:, or date: tags by hand. The tool auto-attaches them based on cwd and current time.",
			"Keep content concise (~300 chars). Split large notes into multiple linked memories rather than one giant blob.",
			"If you find yourself wanting `bugbounty` or `decision` as a bare tag, that's a sign you should use memory_type=decision and rely on the auto-attached topic:bug-bounty (set via PI_CORTEX_TOPIC_ROOTS for bug-bounty cwds).",
		],
		parameters: StoreParams,
		async execute(_id, { content, tags, memory_type }) {
			const enrichedTags = enrichTags(tags ?? [], memory_type);
			const data = await call<{ content_hash?: string; success?: boolean }>("/api/memories", {
				method: "POST",
				body: { content, tags: enrichedTags, memory_type },
			});
			const hash = data.content_hash ?? "";
			return {
				content: [
					{
						type: "text",
						text: `Stored memory${hash ? ` (${hash.slice(0, 8)})` : ""} with tags: ${enrichedTags.join(", ")}`,
					},
				],
				details: { tags: enrichedTags, memory_type, hash },
			};
		},
	});
}
