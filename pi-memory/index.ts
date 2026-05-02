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

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const ENDPOINT = (process.env.PI_MEMORY_ENDPOINT ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
const API_KEY = process.env.PI_MEMORY_API_KEY ?? "";

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
		description: "Tags for retrieval. Always include at least one identifying tag (e.g. project, domain).",
	}),
	memory_type: Type.Optional(
		Type.String({ description: "Optional category like 'note', 'finding', 'decision', 'observation'.", default: "note" }),
	),
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
		description: "Write a new memory to the long-term store with tags for later retrieval.",
		promptSnippet: "Persist a fact, decision, finding, or summary that future sessions should remember.",
		promptGuidelines: [
			"Always include at least one identifying tag (project name, domain, ticket ID, etc).",
			"Keep content concise — split large notes into multiple linked memories instead of one giant blob.",
			"Use memory_type to categorize: 'note' (default), 'finding', 'decision', 'observation', 'summary'.",
		],
		parameters: StoreParams,
		async execute(_id, { content, tags, memory_type }) {
			const data = await call<{ content_hash?: string; success?: boolean }>("/api/memories", {
				method: "POST",
				body: { content, tags, memory_type: memory_type ?? "note" },
			});
			const hash = data.content_hash ?? "";
			return {
				content: [{ type: "text", text: `Stored memory${hash ? ` (${hash.slice(0, 8)})` : ""}.` }],
				details: { tags, memory_type: memory_type ?? "note", hash },
			};
		},
	});
}
