# pi-cortex

A cognitive layer for [Pi](https://pi.dev/). `pi-cortex` is a small set of Pi extensions that wire [mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) into the Pi coding agent without going through the MCP protocol — Pi's design favours direct tools over protocol layers, so we hit the service's REST API directly.

## Extensions

### `pi-memory` — long-term memory tools

Registers four tools the agent can call on demand:

| Tool | Endpoint | Purpose |
|---|---|---|
| `memory_search` | `POST /api/search` | Semantic search by natural-language query |
| `memory_search_by_tag` | `POST /api/search/by-tag` | Exact tag filter |
| `memory_recent` | `GET /api/memories?limit=N` | Latest N memories |
| `memory_store` | `POST /api/memories` | Persist a new memory with tags |

Use this when you want an agent that *can* read/write memory but only when it decides to.

### `pi-bbcontext` — auto-inject memories into the system prompt

Project-aware auto-injection. Derives a `proj:<key>` tag from `git remote get-url origin` (or a project marker like `package.json` / `go.mod`), pulls memories tagged with that key from `mcp-memory-service`, and appends them to the system prompt on every `before_agent_start` (delimited so the model knows it's context, not instructions). Optionally also pulls cross-cutting `proj:none` memories with `PI_BBCONTEXT_INCLUDE_GLOBAL=1`. Falls back to semantic search via `PI_BBCONTEXT_QUERY` only when both tag buckets return zero hits.

Use this when you want zero-touch memory recall — the agent always sees the relevant snippets without needing to call a tool.

`pi-bbcontext` is independent of `pi-memory` — you can run either one or both.

### `pi-recap` — auto-summarize sessions back to memory

Writes a `type:session-recap` memory at `session_before_compact` (save state before context loss) and at `session_shutdown` (final snapshot at process exit). Each recap is chained to the previous one for the same project via `parent_id`, so the next session — Pi or any other client — can replay where you left off. Summaries are produced with the session's currently-selected model (or `PI_RECAP_MODEL`); the memory is tagged `proj:<key>`, `type:session-recap`, `source:pi-recap`, `date:YYYY-MM-DD`. Inspect or trigger manually via `/recap [status|now]`.

## Configuration

All three extensions read environment variables:

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `PI_MEMORY_ENDPOINT` | all | `http://127.0.0.1:8000` | Base URL of mcp-memory-service HTTP API |
| `PI_MEMORY_API_KEY` | all | — | Bearer token (omit if anonymous access is allowed) |
| `PI_BBCONTEXT_TAGS` | bbcontext | — | Comma-separated tags to additionally narrow every injected bucket |
| `PI_BBCONTEXT_MAX` | bbcontext | `8` | Total memory budget across buckets (greedy fill, not per-bucket) |
| `PI_BBCONTEXT_QUERY` | bbcontext | `{project} recent work decisions findings` | Semantic fallback query (used **only** when tag search returns 0); `{project}` / `{parent}` expand to cwd parts |
| `PI_BBCONTEXT_INCLUDE_GLOBAL` | bbcontext | — | Set to `1` to also pull `proj:none` cross-cutting memories |
| `PI_BBCONTEXT_DISABLE` | bbcontext | — | Set to any non-empty value to skip auto-injection |
| `PI_RECAP_DISABLE` | recap | — | Set to any non-empty value to skip auto-recap |
| `PI_RECAP_MIN_MESSAGES` | recap | `4` | Minimum branch messages before a recap is generated |
| `PI_RECAP_MAX_CHARS` | recap | `24000` | Max chars of transcript fed to the summarizer (older turns dropped first) |
| `PI_RECAP_MODEL` | recap | — | Optional `provider/model-id` override for summarization |

## Install

These extensions are loaded by Pi from any of its extension directories — the easiest path is:

```bash
git clone https://github.com/Cyb3rDudu/pi-cortex.git ~/src/pi-cortex

# Symlink each extension into Pi's user-extensions dir
mkdir -p ~/.pi/agent/extensions
ln -sfn ~/src/pi-cortex/pi-memory     ~/.pi/agent/extensions/pi-memory
ln -sfn ~/src/pi-cortex/pi-bbcontext  ~/.pi/agent/extensions/pi-bbcontext
ln -sfn ~/src/pi-cortex/pi-recap      ~/.pi/agent/extensions/pi-recap
```

Then export the relevant env vars in your shell profile:

```bash
export PI_MEMORY_ENDPOINT="http://memory-service.lan:8000"
# Optional: include cross-cutting `proj:none` memories alongside the project bucket.
# export PI_BBCONTEXT_INCLUDE_GLOBAL=1
```

Restart Pi. The injected block (visible via `/bbcontext`) shows which bucket each snippet came from, and `/recap status` shows when the next session-recap will be written.

## Pi extension API hooks used

- `before_agent_start` — runs before every model call. `pi-bbcontext` returns `{ systemPrompt }` to append the auto-injected memory block.
- `session_before_compact` — runs before context compaction. `pi-recap` uses this to write a recap before context is lost.
- `session_shutdown` — runs at process exit. `pi-recap` uses this to write a final recap of the session.
- `registerTool` — `pi-memory` exposes its four tools through this.
- `registerCommand` — `pi-bbcontext` adds `/bbcontext [refresh|status]`; `pi-recap` adds `/recap [status|now]`.

## Compatibility

- Pi: tested with `@mariozechner/pi-coding-agent` ≥ 0.72
- mcp-memory-service: tested with v10.47

## License

MIT
