# pi-cortex

A cognitive layer for the [pi.dev](https://pi.dev/) coding agent. `pi-cortex` is a set of Pi extensions that wire the agent directly to [mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) — long-term memory, auto-injected context, periodic recaps. No MCP protocol layer; Pi prefers direct tools, so we hit the service's REST API and use Pi's native hooks.

## Why this exists

Long-term memory is a property of the *user*, not of the LLM. Every coding session should pick up where the last one left off, regardless of which tool or model was used. mcp-memory-service is the central store; `pi-cortex` is the Pi-side adapter.

## Architecture

```
                   ┌──────────────────────────────────────┐
                   │  mcp-memory-service (nexus, CT 105)  │
                   │  - sqlite-vec semantic store         │
                   │  - graph relationships (parent_id)   │
                   │  - REST /api/* + MCP /mcp            │
                   └──────────────────────────────────────┘
                                    ▲
                                    │ HTTP (REST)
                                    │
            ┌───────────────────────┼───────────────────────┐
            │                       │                       │
   ┌────────┴────────┐    ┌─────────┴────────┐    ┌─────────┴─────────┐
   │   pi-memory     │    │  pi-bbcontext    │    │     pi-recap      │
   │  on-demand      │    │  auto-inject     │    │ auto-summary at   │
   │  tools          │    │  system prompt   │    │ compact/shutdown  │
   └─────────────────┘    └──────────────────┘    └───────────────────┘
            │                       │                       │
            └───────────┬───────────┴───────────┬───────────┘
                        │                       │
                  Pi extension API (registerTool, on(...))
                        │                       │
                  ┌─────┴───────────────────────┴─────┐
                  │   @mariozechner/pi-coding-agent   │
                  └───────────────────────────────────┘
```

- **pi-memory** — registers four tools (`memory_search`, `memory_search_by_tag`, `memory_recent`, `memory_store`) the agent calls on demand.
- **pi-bbcontext** — auto-fetches relevant memories at startup and injects them into the system prompt on every `before_agent_start` event. No tool calls required by the agent.
- **pi-recap** — auto-summarizes the current session at `session_before_compact` (save state before context loss) and `session_shutdown` (final snapshot at process exit), then writes the summary back to `mcp-memory-service` with `type:session-recap` and a `parent_id` chain to the previous recap.
- **future extensions** live as siblings under the repo root.

## Repo layout

```
pi-cortex/
├── CLAUDE.md            ← project context (this file)
├── EXCALIBUR.md         ← deployment specifics for the dev/test box
├── README.md            ← user-facing install + config
├── LICENSE              ← MIT
├── pi-memory/
│   ├── package.json     ← name, "pi": { "extensions": ["./index.ts"] }
│   └── index.ts         ← extension entry point
├── pi-bbcontext/
│   ├── package.json
│   └── index.ts
└── pi-recap/
    ├── package.json
    └── index.ts
```

Each extension is a self-contained directory loadable independently.

## Pi extension conventions

A Pi extension is a directory containing:

```jsonc
// package.json — minimum viable
{
  "name": "pi-extension-<name>",
  "version": "0.x.y",
  "private": true,
  "type": "module",
  "pi": { "extensions": ["./index.ts"] }
}
```

```typescript
// index.ts — the entry point
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default async function (pi: ExtensionAPI) {
  // synchronous registration
  pi.registerTool({ /* ... */ });
  pi.registerCommand("name", { /* ... */ });
  pi.on("event_name", async (event, ctx) => { /* ... */ });
}
```

The factory function is awaited by Pi, so async startup work (like fetching initial state) can run before the first turn.

### Verified hook events (Pi 0.72)

These names exist in the installed binary; do not invent new ones. Source of truth: `@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts:593–613`.

```
resources_discover
session_start, session_shutdown
session_before_switch, session_switch
session_before_fork,   session_fork
session_before_compact, session_compact
session_before_tree,   session_tree
context
before_agent_start, agent_start, agent_end
turn_start, turn_end
model_select
tool_call, tool_result
user_bash
input
```

Notes for extension authors:

- `before_agent_start` is the only event that can mutate the system prompt — return `{ systemPrompt: <new value> }` from the handler. Multiple extensions chain.
- `session_before_compact` fires before context compaction with `{ branchEntries, signal, ... }` — the right place to write a recap before context is lost.
- `session_shutdown` fires on process exit — use it for one final session-level write. Prefer it over `agent_end` when you want one write per session, not one per agent loop.
- `context` fires before each LLM call with the full `messages` array; can return `{ messages }` to rewrite history.

### Tools use TypeBox schemas

Schemas in `parameters` are TypeBox (`import { Type } from "typebox"`). Pi exposes them as the tool's JSON Schema to the model.

### No build step

Pi loads `.ts` files directly via Bun, so we ship source. Don't add a `dist/` build pipeline unless we publish to npm.

## Memory tag schema (canonical conventions)

Every memory written by Pi extensions, by Pi tools, or by the user themselves should follow this taxonomy. Tags are a flat list of strings; we use `prefix:value` to namespace.

### Required tags (every memory)

Exactly one of each:

| Prefix | Purpose | Examples |
|---|---|---|
| `proj:` | Project key — the stable, machine-derivable identity of what this memory is about (git remote or project marker; see derivation rules below) | `proj:github.com/Cyb3rDudu/pi-cortex`<br>`proj:acme.com`<br>`proj:none` for cross-project / global notes (only set by non-Pi clients — Pi extensions never write `proj:none`) |
| `type:` | What kind of memory it is (drives ranking and filtering) | see table below |

### Soft-anchor prefix

When a memory has no obvious `proj:` (DeepChat conversations, browser reading sessions, cross-cutting research), use `topic:` as the soft anchor. `topic:` may coexist with `proj:` — they are not mutually exclusive.

| Prefix | When to use | Examples |
|---|---|---|
| `topic:` | Soft grouping for non-code work | `topic:llms`, `topic:home-infra`, `topic:bug-bounty`, `topic:research/agentic-patterns` |

### Memory types (`type:` values)

| Value | Use for |
|---|---|
| `type:scope` | Program rules, RoE, what's in/out of bounds (bug-bounty intake) |
| `type:recon` | Passive reconnaissance summaries (subdomain lists, tech stack, auth model) |
| `type:enum` | Enumeration findings (interesting endpoints, parameters, roles) |
| `type:finding` | Confirmed or near-confirmed vulnerabilities / bugs |
| `type:negative` | What didn't work and why — equally valuable, prevents repeat work |
| `type:decision` | Architectural / strategic / tactical choices and the rationale |
| `type:session-recap` | Auto-generated session summaries (written by `pi-recap`; chained via `parent_id`) |
| `type:reference` | Pointers to external systems (URLs, dashboards, ticket IDs) |
| `type:user` | Stable facts about the user (role, expertise, preferences) |
| `type:feedback` | Corrections / preferences the user has voiced — apply across future sessions |
| `type:research` | Facts gathered while reading or exploring a topic. Cross-cutting, often paired with `topic:` |
| `type:reading` | Notes pulled from a specific source (paper, article, video, web page) |
| `type:idea` | Generative thought to revisit later |
| `type:question` | Open question to circle back to |
| `type:note` | Catch-all when nothing else fits — use sparingly |

### Optional dimensional tags

Add when applicable; never required:

| Prefix | Use for | Examples |
|---|---|---|
| `host:` | Domain or hostname the memory is scoped to | `host:api.acme.com` |
| `vuln:` | Vulnerability class (security work) | `vuln:idor`, `vuln:ssrf`, `vuln:auth` |
| `tech:` | Tech stack identifier | `tech:sveltekit`, `tech:postgres` |
| `cve:` | Specific CVE reference | `cve:2026-12345` |
| `severity:` | Risk rating | `severity:critical`, `severity:high` |
| `status:` | Workflow state | `status:open`, `status:fixed`, `status:dup` |

### Auto-set tags

Storage adapters (and `memory_store`) attach these automatically; the user does not write them by hand:

| Prefix | Purpose |
|---|---|
| `date:YYYY-MM-DD` | ISO date the memory was written |
| `source:pi-recap` / `source:agent` / `source:user` | Who wrote it |

### Project-key derivation

To ensure a project's memories are recallable from any machine, derive the key in this order:

1. If cwd is inside a git repo with a remote: `proj:<host>/<owner>/<repo>` parsed from `git remote get-url origin` (e.g. `proj:github.com/Cyb3rDudu/pi-cortex`).
2. Else if cwd looks like a project (has `package.json`, `go.mod`, `pyproject.toml`, `Cargo.toml`, `composer.json`, `Gemfile`, or `.git`): `proj:<basename>`.
3. Else if cwd is *under* one of the configured `PI_CORTEX_PROJECT_ROOTS`: `proj:<first-segment-after-root>`. This handles the "directory of projects" pattern — e.g. with `PI_CORTEX_PROJECT_ROOTS=~/Code,~/Code/bounties`, working in `~/Code/bounties/acme.com/notes/` resolves to `proj:acme.com` even though there's no git repo or project marker. When multiple roots match, the deepest (most-specific) wins, so `~/Code/bounties` correctly beats `~/Code`.
4. Else: no project key can be derived.

In addition to (3), `PI_CORTEX_TOPIC_ROOTS` maps a parent path to a topic tag (e.g. `~/Code/bounties=bug-bounty,~/Reading=research`). Any cwd under that root gets the matching `topic:<value>` appended to whatever the extension does — `pi-bbcontext` adds a topic bucket alongside the project bucket, and `pi-recap` writes the topic tag(s) onto the stored recap so future searches surface it via either anchor.

Behaviour when no key can be derived:

- **Pi extensions (`pi-bbcontext`, `pi-recap`) MUST no-op.** They never write `proj:none`, never auto-inject, and never auto-recap. The user can still call `memory_store` from `pi-memory` by hand if they want a global note.
- **Other clients (DeepChat, browser plugin) MAY write `proj:none`** for genuinely cross-cutting facts. Those memories surface to Pi only when `PI_BBCONTEXT_INCLUDE_GLOBAL=1`, so they don't pollute project-scoped recall by default.

### Querying patterns

| Want | How |
|---|---|
| All memories about a project | `search_by_tag(["proj:<key>"])` |
| Recent recaps for a project | `search_by_tag(["proj:<key>", "type:session-recap"], match_all=true)` |
| All open findings on a host | `search_by_tag(["host:<x>", "type:finding", "status:open"], match_all=true)` |
| Cross-project user preferences | `search_by_tag(["type:feedback"])` or `["type:user"]` |
| Semantic without tag bias | `memory_search("<query>")` |

## Memory backend (mcp-memory-service)

- Runs on **nexus** (CT 105) at `192.168.1.105:8000` (HTTP/REST + dashboard) and `:8888/mcp` (MCP streamable-http).
- Schema supports `parent_id` and `relationship_type` on memories — i.e. it's a graph store. Use these for chained recaps and supersedes/refers-to relationships.
- Anonymous access allowed on the LAN; no auth needed by default.
- Dashboard UI at <https://memory.i.catdev.io>.

## Configuration (env vars consumed by extensions)

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `PI_MEMORY_ENDPOINT` | all | `http://127.0.0.1:8000` | Base URL of mcp-memory-service REST API |
| `PI_MEMORY_API_KEY` | all | — | Bearer token (omit for anonymous) |
| `PI_CORTEX_PROJECT_ROOTS` | bbcontext + recap | — | Comma-separated parent dirs (`~` expanded). When cwd is under any of them, the first path segment under the root becomes the project key — even without git or a project marker. Deeper roots win on ambiguity |
| `PI_CORTEX_TOPIC_ROOTS` | bbcontext + recap | — | Comma-separated `<path>=<topic>` pairs. When cwd is under `<path>`, append `topic:<topic>` (extra search bucket for bbcontext, extra stored tag for recap). Example: `~/Code/bounties=bug-bounty,~/Reading=research` |
| `PI_BBCONTEXT_TAGS` | bbcontext | — | Comma-separated tags to additionally filter every auto-injected bucket (project + topic + globals) |
| `PI_BBCONTEXT_MAX` | bbcontext | `8` | Total memory budget across all buckets (greedy fill — not per-bucket) |
| `PI_BBCONTEXT_QUERY` | bbcontext | `{project} recent work decisions findings` | Semantic query template used **only** when tag-based search returns 0 hits. `{project}` / `{parent}` expand to cwd parts |
| `PI_BBCONTEXT_INCLUDE_GLOBAL` | bbcontext | — | If set to `1`, also pull memories tagged `proj:none` (cross-cutting writes from non-Pi clients) into the injected block |
| `PI_BBCONTEXT_DISABLE` | bbcontext | — | Any non-empty value disables auto-injection |
| `PI_RECAP_DISABLE` | recap | — | Any non-empty value disables auto-recap |
| `PI_RECAP_MIN_MESSAGES` | recap | `4` | Minimum number of message entries in the current branch before a recap is generated (skips empty/trivial sessions) |
| `PI_RECAP_MAX_CHARS` | recap | `24000` | Maximum chars of transcript to send to the summarizer (older turns are dropped first) |
| `PI_RECAP_MODEL` | recap | — | Optional `provider/model-id` to use for summarization. If unset, uses the session's currently-selected model |

## Code style

- TypeScript, ESM (`"type": "module"`).
- Two-space indent, double-quoted strings (matches Pi's own examples).
- Comments only when the *why* isn't obvious from the code. No JSDoc walls of text on internal helpers.
- Prefer pure functions for transforms (parsing memories, building blocks); push side effects to the extension factory and event handlers.
- Use `node:`-prefixed built-ins (`node:path`, `node:fs`).
- `fetch` (global), no `axios` or other HTTP libs.

## Commit conventions

[Conventional Commits](https://www.conventionalcommits.org/) with a flat scope:

```
feat(memory): add memory_search_by_tag tool
fix(bbcontext): use async factory init instead of nonexistent session_start
docs: explain tag schema and project-key derivation
```

Scope is the extension dir name (`memory`, `bbcontext`) or `extensions`/`docs` for cross-cutting work.

## Local dev workflow

1. Edit on the Mac in `~/Code/pi-cortex/`.
2. Commit + push.
3. On the deployment box (see `EXCALIBUR.md`), `git pull` and restart Pi — extension changes are picked up on the next session.

There's no test suite yet; verification is done by running Pi against a known prompt and inspecting the result.

## Related references

- Pi docs: <https://pi.dev/>
- Pi extension examples: <https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions>
- mcp-memory-service: <https://github.com/doobidoo/mcp-memory-service>
- nexus deployment: see `EXCALIBUR.md` for the deployed extension state.
