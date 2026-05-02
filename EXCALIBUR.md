# Excalibur — Pi deployment notes

Excalibur (CT 103, BlackArch Linux, `192.168.1.103`) is the box where Pi runs day-to-day for bug-bounty work. This file documents the deployed state so the next Claude session can land in a known environment.

## Connection

```bash
ssh dudu@192.168.1.103
```

Default shell: fish. Alt-shell: bash (via `~/.bashrc`).

## Pi installation

| Item | Value |
|---|---|
| Binary | `~/.bun/bin/pi` |
| Version | 0.72.0 (`@mariozechner/pi-coding-agent`, installed via `bun add -g`) |
| Auth | Picks up `$ZAI_API_KEY` from fish universal scope |
| Default provider/model | `zai` / `glm-5.1` (set per-invocation, no global default yet) |
| Telemetry | OFF — `PI_OFFLINE=1` (fish universal + `~/.bashrc`) |

## This repo on excalibur

Cloned source-of-truth and symlinks into Pi's user-extensions dir:

```
~/src/pi-cortex/                       ← git clone of Cyb3rDudu/pi-cortex
~/.pi/agent/extensions/pi-memory      → ~/src/pi-cortex/pi-memory
~/.pi/agent/extensions/pi-bbcontext   → ~/src/pi-cortex/pi-bbcontext
~/.pi/agent/extensions/pi-recap       → ~/src/pi-cortex/pi-recap
```

Pi auto-discovers any `package.json` under `~/.pi/agent/extensions/*/` that has `"pi": { "extensions": ["./index.ts"] }`.

To create the symlinks the first time (or after adding a new extension):

```bash
mkdir -p ~/.pi/agent/extensions
ln -sfn ~/src/pi-cortex/pi-memory     ~/.pi/agent/extensions/pi-memory
ln -sfn ~/src/pi-cortex/pi-bbcontext  ~/.pi/agent/extensions/pi-bbcontext
ln -sfn ~/src/pi-cortex/pi-recap      ~/.pi/agent/extensions/pi-recap
```

## Env vars set on excalibur

Persisted in two layers (fish universal vars + `~/.bashrc` exports) so both interactive and non-interactive shells see them:

| Var | Value | Purpose |
|---|---|---|
| `PI_OFFLINE` | `1` | Suppress all Pi startup network calls (telemetry, update checks) |
| `PI_MEMORY_ENDPOINT` | `http://192.168.1.105:8000` | nexus mcp-memory-service REST URL |
| `PI_BBCONTEXT_MAX` | `8` | Total memory budget per system-prompt injection |
| `PI_BBCONTEXT_INCLUDE_GLOBAL` | unset (set to `1` to enable) | Pull `proj:none` cross-cutting memories alongside the project bucket |
| `PI_RECAP_MIN_MESSAGES` | unset (defaults to `4`) | Minimum branch messages before `pi-recap` writes anything |
| `ZAI_API_KEY` | (set) | Z.AI coding plan API key |

> **Legacy `PI_BBCONTEXT_TAGS=bugbounty,decision,finding` was removed during the v0.2 cutover.** The new schema (`proj:`, `type:`, etc., per `CLAUDE.md`) does the heavy lifting; reintroduce `PI_BBCONTEXT_TAGS` only if you want to additionally narrow the injected bucket (e.g. to `type:finding,type:decision`).
>
> **Legacy memories were not back-filled.** Memories tagged with the old flat scheme remain searchable via `memory_search` / `memory_search_by_tag` but will not auto-inject under v0.2 because they lack a `proj:<key>` tag. Rewrite them by hand if and when you want them to surface again.

## Memory backend reachability

- nexus (CT 105) at `192.168.1.105`
- LAN-only: `200 OK` on `/api/health`, `/api/search`, `/api/memories`, `/api/memories?limit=N`, `/api/search/by-tag`
- Public: <https://memory.i.catdev.io> (NPM proxy → CT 105:8000) for the dashboard

## Built-in skills available to Pi

The shared skill `hacking` (BlackArch toolkit reference) is symlinked from opencode's skills dir into Pi's discovery path:

```
~/.config/opencode/skills/hacking/SKILL.md   ← canonical file
~/.agents/skills/hacking → ~/.config/opencode/skills/hacking
```

Pi finds it under "user" skills. Edit the canonical file once; both pi and opencode see the change.

## Deployment workflow

After committing changes on the Mac:

```bash
ssh dudu@192.168.1.103 'cd ~/src/pi-cortex && git pull --ff-only'
```

Then restart any open Pi sessions on excalibur. Extension changes are loaded at extension-factory time, so a new `pi` invocation picks them up.

For a quick smoke test:

```bash
ssh dudu@192.168.1.103 \
  'fish -c "~/.bun/bin/pi --provider zai --model glm-5.1 --print \
    \"Reply ONLY with a comma-separated list of every tool name available to you.\""'
```

You should see `read, bash, edit, write, memory_search, memory_search_by_tag, memory_recent, memory_store`.

## What's deployed right now

| Component | Version | Status |
|---|---|---|
| pi-memory | 0.1.0 | ✅ working — four memory_* tools register and respond |
| pi-bbcontext | 0.2.0 | ✅ project-aware bucket-and-rank; injects from `proj:<key>` (and `proj:none` when `PI_BBCONTEXT_INCLUDE_GLOBAL=1`); falls back to semantic only when tag buckets return zero |
| pi-recap | 0.1.0 | ✅ writes a `type:session-recap` to nexus on `session_before_compact` and `session_shutdown`, chained via `parent_id` to the previous recap for the project |

## Other tools on excalibur (out of scope here)

- **opencode** (still installed, deferred cleanup) — currently has its own auto-injection plugin and `memory` MCP wired to nexus. We're keeping it parallel until Pi takes over.
- **crush** — uninstalled.

If you need to verify what else is sharing the memory store, see opencode's `~/.config/opencode/opencode.jsonc` and `~/.config/opencode/plugins/memory-plugin.js`.
