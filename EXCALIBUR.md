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
| `PI_CORTEX_PROJECT_ROOTS` | `~/Code,~/Code/bounties` | Treat first folder under either path as the project (so `~/Code/bounties/acme.com/` → `proj:acme.com`, `~/Code/carrier-admin/` → `proj:carrier-admin`) even with no git repo |
| `PI_CORTEX_TOPIC_ROOTS` | `~/Code/bounties=bug-bounty` | Auto-attach `topic:bug-bounty` to any work under `~/Code/bounties` (extra search bucket for bbcontext, extra stored tag on recaps) |
| `PI_BBCONTEXT_MAX` | `8` | Total memory budget per system-prompt injection |
| `PI_BBCONTEXT_INCLUDE_GLOBAL` | unset (set to `1` to enable) | Pull `proj:none` cross-cutting memories alongside the project bucket |
| `PI_RECAP_MIN_MESSAGES` | unset (defaults to `4`) | Minimum branch messages before `pi-recap` writes anything |
| `ZAI_API_KEY` | (set) | Z.AI coding plan API key |

> **Legacy `PI_BBCONTEXT_TAGS=bugbounty,decision,finding` was removed during the v0.2 cutover.** The new schema (`proj:`, `type:`, etc., per `CLAUDE.md`) does the heavy lifting; reintroduce `PI_BBCONTEXT_TAGS` only if you want to additionally narrow the injected bucket (e.g. to `type:finding,type:decision`).
>
> **Legacy memories were not back-filled.** Memories tagged with the old flat scheme remain searchable via `memory_search` / `memory_search_by_tag` but will not auto-inject under v0.2 because they lack a `proj:<key>` tag. Rewrite them by hand if and when you want them to surface again.

## Memory backend reachability

- nexus (CT 105) at `192.168.1.105`
- LAN-only: `200 OK` on `/api/health`, `/api/search`, `/api/memories`, `/api/memories?page_size=N`, `/api/search/by-tag`
- MCP streamable-http on `192.168.1.105:8888/mcp`
- Public: <https://memory.i.catdev.io> (NPM proxy → CT 105:8000) for the dashboard

### Deployment topology (single-writer, post 2026-05-02)

For months we ran two containers (`mcp-dashboard` :8000 and `mcp-memory` :8888) each with its own python process holding write connections to the same SQLite file. SQLite is single-writer; this caused frequent `database is locked` errors and silent write failures.

The fix uses mcp-memory-service's built-in coordinator: when the second instance detects another HTTP server on `localhost:8000`, it flips its storage to `HTTPClientStorage` and proxies all writes through the first instance. To make `localhost` resolve correctly across containers, both must share a network namespace.

```
nexus (CT 105)
├── mcp-dashboard          ← owns the network namespace
│   image: doobidoo/mcp-memory-service:10
│   ports: 8000:8000, 8888:8888       (both ports exposed here)
│   env:   MCP_MODE=http
│   role:  ONLY writer to /opt/mcp-memory/data/memories.db
│
└── mcp-memory             ← --network=container:mcp-dashboard
    image: doobidoo/mcp-memory-service:10
    ports: (none — uses dashboard's namespace)
    env:   MCP_MODE=streamable-http
    role:  serves MCP on :8888; coordinator detects dashboard on
           localhost:8000 → all writes proxy through it
```

To recreate from scratch (volumes preserved across `nerdctl rm`):

```bash
sudo nerdctl stop mcp-memory && sudo nerdctl rm mcp-memory
sudo nerdctl stop mcp-dashboard && sudo nerdctl rm mcp-dashboard

sudo nerdctl run -d --name mcp-dashboard --restart=always \
  -p 8000:8000 -p 8888:8888 \
  -v /opt/mcp-memory/data:/app/sqlite_db \
  -v mcp-memory_mcp-dashboard-backups:/app/backups \
  -e MCP_MEMORY_STORAGE_BACKEND=sqlite_vec \
  -e MCP_MEMORY_SQLITE_PATH=/app/sqlite_db/memories.db \
  -e MCP_MEMORY_BACKUPS_PATH=/app/backups \
  -e MCP_MEMORY_USE_ONNX=1 \
  -e MCP_MODE=http -e MCP_HTTP_HOST=0.0.0.0 -e MCP_HTTP_PORT=8000 \
  -e MCP_ALLOW_ANONYMOUS_ACCESS=true \
  docker.io/doobidoo/mcp-memory-service:10

sudo nerdctl run -d --name mcp-memory --restart=always \
  --network=container:mcp-dashboard \
  -v /opt/mcp-memory/data:/app/sqlite_db \
  -v mcp-memory_mcp-memory-backups:/app/backups \
  -e MCP_MEMORY_STORAGE_BACKEND=sqlite_vec \
  -e MCP_MEMORY_SQLITE_PATH=/app/sqlite_db/memories.db \
  -e MCP_MEMORY_BACKUPS_PATH=/app/backups \
  -e MCP_MEMORY_USE_ONNX=1 \
  -e MCP_MODE=streamable-http -e MCP_SSE_HOST=0.0.0.0 -e MCP_SSE_PORT=8888 \
  -e MCP_ALLOW_ANONYMOUS_ACCESS=true \
  docker.io/doobidoo/mcp-memory-service:10
```

If you ever see `database is locked` again, first sanity-check that `mcp-memory` is still attached to the dashboard's namespace (`sudo nerdctl inspect mcp-memory | grep NetworkMode` should show `container:mcp-dashboard`). If it's not, the lock contention is back and the recreate above is the fix.

### Wipe + restart (clean DB)

Months of pre-cutover dual-writer contention left at least one row with on-disk page corruption that `PRAGMA integrity_check` and `PRAGMA quick_check` could not detect (only the actual UPDATE on row id=726 surfaced it as "database disk image is malformed"). On 2026-05-02 we wiped the live DB and restarted with a fresh empty store under the v0.2 schema. The repair-vs-rebuild calculus tipped to rebuild because (a) the cleanup pass would have had to rewrite ~470 memories anyway, (b) the corrupt-page count was unbounded — one confirmed, no way to know how many more, (c) most pre-cutover content was pre-namespace and would have needed a tag overhaul regardless.

To wipe (use sparingly — destroys all live memories):

```bash
TS=$(date -u +%Y%m%dT%H%M%SZ)
ssh dudu@192.168.1.105 "sudo cp -p /opt/mcp-memory/data/memories.db /opt/mcp-memory/manual-backups/pre-wipe-${TS}.memories.db"
ssh dudu@192.168.1.105 "sudo cp -p /opt/mcp-memory/data/sqlite_vec.db /opt/mcp-memory/manual-backups/pre-wipe-${TS}.sqlite_vec.db"
ssh dudu@192.168.1.105 'sudo nerdctl stop mcp-memory && sudo nerdctl rm mcp-memory'
ssh dudu@192.168.1.105 'sudo nerdctl stop mcp-dashboard'
ssh dudu@192.168.1.105 "sudo mv /opt/mcp-memory/data/memories.db /opt/mcp-memory/manual-backups/wiped-from-live-${TS}.memories.db"
ssh dudu@192.168.1.105 "sudo mv /opt/mcp-memory/data/memories.db-wal /opt/mcp-memory/manual-backups/wiped-from-live-${TS}.memories.db-wal 2>/dev/null || true"
ssh dudu@192.168.1.105 "sudo mv /opt/mcp-memory/data/memories.db-shm /opt/mcp-memory/manual-backups/wiped-from-live-${TS}.memories.db-shm 2>/dev/null || true"
ssh dudu@192.168.1.105 "sudo mv /opt/mcp-memory/data/sqlite_vec.db /opt/mcp-memory/manual-backups/wiped-from-live-${TS}.sqlite_vec.db"
ssh dudu@192.168.1.105 'sudo nerdctl start mcp-dashboard'
# wait for /api/health to return healthy, then bring mcp-memory back up
# via the recreate command above.
```

### Backup index

Snapshots in `/opt/mcp-memory/manual-backups/` (preserved across container recreates; the volume lives in `/var/lib/nerdctl/.../mcp-memory_mcp-dashboard-backups/_data/` for the daily auto-backups, but the manual snapshots live directly on the host bind-mount):

| Prefix | Reason | Notes |
|---|---|---|
| `pre-redeploy-20260502T073358Z.*` | Before container split → shared-namespace cutover | DB had 474 memories; WAL frozen at last successful write 2026-05-01 19:04 due to dual-writer lock |
| `pre-tag-cleanup-20260502T075650Z.*` | Before tag-cleanup attempt | 474 memories, 555 distinct tags, all pre-namespace |
| `pre-fts-rebuild-20260502T082532Z.*` | Before FTS5 rebuild attempt for row 726 | Rebuild was unnecessary (FTS5 integrity-check passed); page-level corruption was elsewhere |
| `pre-row726-repair-20260502T092840Z.*` | Before repair attempt that never ran | We pivoted to wipe instead |
| `pre-wipe-20260502T093222Z.*` + `wiped-from-live-20260502T093222Z.*` | The full pre-wipe state, both as a copy and as the moved-aside live files | This is the canonical "everything before the wipe" snapshot if you ever need to mine the old corpus |

The `wiped-from-live-*` files are the EXACT bytes that were live at wipe time (mv'd, not copied). The `pre-wipe-*` files are a `cp -p` of the same state taken seconds before. Keeping both in case one gets damaged by future filesystem mishaps.

To inspect the old corpus without touching the live DB, you can attach to it from any sqlite-capable container:

```bash
ssh dudu@192.168.1.105 'sudo nerdctl exec mcp-dashboard python3 -c "
import sqlite3
c = sqlite3.connect(\"/app/backups/wiped-from-live-20260502T093222Z.memories.db\")
# ...query the old data read-only...
"'
```

(The `mcp-memory_mcp-dashboard-backups` volume mounts to `/app/backups` inside the container; copy the `wiped-from-live-*` files there if you want them visible to the running service for read-only inspection.)

Daily auto-backups continue to write to the `mcp-memory_mcp-dashboard-backups` volume — those are the rolling restore points going forward.

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
