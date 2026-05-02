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
   │   pi-memory     │    │  pi-bbcontext    │    │     (future)      │
   │  on-demand      │    │  auto-inject     │    │     pi-recap      │
   │  tools          │    │  system prompt   │    │  auto-summary     │
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
└── pi-bbcontext/
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

These names exist in the installed binary; do not invent new ones:

```
agent_start, agent_end
before_agent_start, before_provider_request, after_provider_response
message_start, message_end, message_update
model_select, branch, before_branch, before_clear, before_compact,
before_new, before_switch, before_tree, resources_discover,
input, line, data, end, error, exit, close, context, overflow
```

`before_agent_start` is the only event that can mutate the system prompt — return `{ systemPrompt: <new value> }` from the handler.

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
| `proj:` | Project key — the stable identity of what this memory is about | `proj:github.com/Cyb3rDudu/pi-cortex`<br>`proj:acme.com`<br>`proj:none` for cross-project / global notes |
| `type:` | What kind of memory it is (drives ranking and filtering) | see table below |

### Memory types (`type:` values)

| Value | Use for |
|---|---|
| `type:scope` | Program rules, RoE, what's in/out of bounds (bug-bounty intake) |
| `type:recon` | Passive reconnaissance summaries (subdomain lists, tech stack, auth model) |
| `type:enum` | Enumeration findings (interesting endpoints, parameters, roles) |
| `type:finding` | Confirmed or near-confirmed vulnerabilities / bugs |
| `type:negative` | What didn't work and why — equally valuable, prevents repeat work |
| `type:decision` | Architectural / strategic / tactical choices and the rationale |
| `type:session-recap` | Auto-generated session summaries (written by future `pi-recap`) |
| `type:reference` | Pointers to external systems (URLs, dashboards, ticket IDs) |
| `type:user` | Stable facts about the user (role, expertise, preferences) |
| `type:feedback` | Corrections / preferences the user has voiced — apply across future sessions |
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
3. Else: do not assign a project key. The memory is either `proj:none` (cross-cutting) or should not be auto-injected anywhere.

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
| `PI_MEMORY_ENDPOINT` | both | `http://127.0.0.1:8000` | Base URL of mcp-memory-service REST API |
| `PI_MEMORY_API_KEY` | both | — | Bearer token (omit for anonymous) |
| `PI_BBCONTEXT_TAGS` | bbcontext | — | Comma-separated tags to filter the auto-injection |
| `PI_BBCONTEXT_MAX` | bbcontext | `8` | Max memories injected |
| `PI_BBCONTEXT_QUERY` | bbcontext | `{project} recent work decisions findings` | Query template; `{project}`/`{parent}` expand to cwd parts |
| `PI_BBCONTEXT_DISABLE` | bbcontext | — | Any non-empty value disables auto-injection |

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
