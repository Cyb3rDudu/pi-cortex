# pi-extensions

Two small [Pi](https://pi.dev/) extensions that wire [mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) into Pi without going through the MCP protocol — Pi's design favours direct tools over protocol layers, so we hit the service's REST API directly.

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

Mirrors the auto-injection plugin that `mcp-memory-service` ships for opencode. On `session_start` it queries the service for memories relevant to the current working directory, and on every `before_agent_start` it appends them to the system prompt (delimited so the model knows it's context, not instructions).

Use this when you want zero-touch memory recall — the agent always sees the relevant snippets without needing to call a tool.

`pi-bbcontext` is independent of `pi-memory` — you can run either one or both.

## Configuration

Both extensions read environment variables:

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `PI_MEMORY_ENDPOINT` | both | `http://127.0.0.1:8000` | Base URL of mcp-memory-service HTTP API |
| `PI_MEMORY_API_KEY` | both | — | Bearer token (omit if anonymous access is allowed) |
| `PI_BBCONTEXT_TAGS` | bbcontext | — | Comma-separated tags to filter the auto-injected memories |
| `PI_BBCONTEXT_MAX` | bbcontext | `8` | Max number of memories to inject |
| `PI_BBCONTEXT_QUERY` | bbcontext | `{project} recent work decisions findings` | Query template; `{project}` and `{parent}` expand to cwd basename and its parent |
| `PI_BBCONTEXT_DISABLE` | bbcontext | — | Set to any non-empty value to skip auto-injection |

## Install

These extensions are loaded by Pi from any of its extension directories — the easiest path is:

```bash
git clone https://github.com/Cyb3rDudu/pi-extensions.git ~/src/pi-extensions

# Symlink each extension into Pi's user-extensions dir
mkdir -p ~/.pi/agent/extensions
ln -sfn ~/src/pi-extensions/pi-memory     ~/.pi/agent/extensions/pi-memory
ln -sfn ~/src/pi-extensions/pi-bbcontext  ~/.pi/agent/extensions/pi-bbcontext
```

Then export the relevant env vars in your shell profile:

```bash
export PI_MEMORY_ENDPOINT="http://memory-service.lan:8000"
export PI_BBCONTEXT_TAGS="bugbounty,decision,finding"
```

Restart Pi. On startup you should see notifications like:

```
pi-bbcontext: injected 6 memory snippet(s) (tags: bugbounty,decision,finding)
```

## Pi extension API hooks used

- `session_start` — runs once when a Pi session opens. `pi-bbcontext` uses this to do the initial fetch.
- `before_agent_start` — runs before every model call. `pi-bbcontext` returns `{ systemPrompt }` to mutate the prompt for that call.
- `registerTool` — `pi-memory` exposes its four tools through this.
- `registerCommand` — `pi-bbcontext` adds a `/bbcontext` command to inspect the currently injected block.

## Compatibility

- Pi: tested with `@mariozechner/pi-coding-agent` ≥ 0.72
- mcp-memory-service: tested with v10.47

## License

MIT
