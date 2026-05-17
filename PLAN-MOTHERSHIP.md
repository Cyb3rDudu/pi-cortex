# pi-cortex implementation plan — mothership multi-client memory

Read `CLAUDE.md` first for the canonical tag schema and `PLAN.md` for the Pi-side iteration plan. This file extends the architecture from "nexus-only, Pi-only" to a **mothership-local backend serving every Mac-side LLM client**. It is both the spec for that local stack and the step-by-step plan to land it.

`EXCALIBUR.md` documents the parallel remote deployment (nexus + Pi on Excalibur). Nothing here changes that. mothership runs its own pool; excalibur keeps using nexus. Cross-pool migration / sync is a follow-up iteration.

## Mission framing

mothership (Mac M2 Max) is where day-to-day Mac work happens — coding sessions, Hermes Signal traffic, email-triage, opencode runs, Claude Code sessions. All of those LLM clients should share a **single local memory pool** with stable provenance tags so that:

- **Cross-client recall works.** Claude Code finds Hermes' research notes; Pi finds Hermes Signal brainstorms; opencode finds Pi session-recaps.
- **Persona/context filtering works.** Hermes-tom doesn't get Hermes-james' DMs back; an email-triage subagent doesn't accidentally pull from a Signal chat.
- **No LAN dependency.** Day-to-day Mac work does not need to reach nexus (CT 105) over the home network. nexus stays as the excalibur-side pool until we decide whether to migrate, sync, or decommission.

```
mothership (Mac M2 Max) — single host, loopback only
─────────────────────────────────────────────────────────────────────────────
  ┌─────────────────────────────────────────────────────────────────┐
  │ mcp-memory-service (com.mcp.memory-dashboard launchd plist)     │
  │ sqlite-vec backend, ONNX MiniLM-L6-v2                            │
  │ HTTP REST on 127.0.0.1:8000                                      │
  │ DB:      ~/Library/Application Support/mcp-memory/sqlite_vec.db  │
  │ Backups: ~/Library/Application Support/mcp-memory/backups        │
  └─────────────────────────────────────────────────────────────────┘
                              ▲   ▲   ▲   ▲
                              │   │   │   │
        ┌─────────────────────┘   │   │   └────────────────────────────┐
        │                         │   │                                │
   ┌────┴──────┐            ┌─────┴────┐  ┌──────┴────────┐    ┌──────┴──────┐
   │    Pi     │            │ opencode │  │ Claude Code   │    │   Hermes    │
   │ (via      │            │ (memory  │  │ (memory       │    │ (custom     │
   │ pi-cortex │            │  plugin) │  │  bridge hook) │    │  provider   │
   │  exts)    │            │          │  │               │    │  plugin)    │
   └───────────┘            └──────────┘  └───────────────┘    └─────────────┘
   X-Agent-ID:              X-Agent-ID:   X-Agent-ID:          X-Agent-ID:
    pi-cortex                opencode      claude-code          hermes-<persona>

   (later) browser extensions — capture-side only, type:reading / type:research
```

## Current state (pre-iteration, verified 2026-05-17)

| Piece | State on mothership |
|---|---|
| `com.mcp.memory-dashboard.plist` | Installed at `~/Library/LaunchAgents/`, configured with `MCP_HTTP_ENABLED=false` → not listening |
| Local SQLite at `~/Library/Application Support/mcp-memory/sqlite_vec.db` | 2.1 MB, last write 2025-10-31. WAL empty. Sits idle. |
| `pi` binary | `/opt/homebrew/bin/pi` installed; **no pi-cortex extensions symlinked** under `~/.pi/agent/extensions/` |
| `PI_MEMORY_ENDPOINT` env | `http://192.168.1.105:8000` (points at nexus — wrong target for the local plan) |
| `opencode` | `/opt/homebrew/bin/opencode` installed, `~/.config/opencode/{opencode.jsonc, memory-plugin.json, plugins/}` already present |
| `claude` (Claude Code) | `~/.local/bin/claude` installed; auto-memory falls back to file at `~/.claude/projects/<proj>/memory/` because `127.0.0.1:12345` connect-refused |
| Hermes (`com.dudu.hermes-gateway`, `com.dudu.signal-cli`, email-triage cron) | Running, no memory backend — only in-process conversation log |
| nexus (CT 105) | 31 memories, 52 tags, 1.9 MB. **Out of scope** here. |

## Tag schema additions (must land in `CLAUDE.md`)

`CLAUDE.md` already canonicalizes `proj:`, `topic:`, `type:`, `source:`, `date:`. Multi-client adds **provenance / identity** axes. These are tool-agnostic and apply to every deployment, not just mothership.

| Prefix | Required for | Examples | Notes |
|---|---|---|---|
| `agent:` | every write | `agent:pi-cortex`, `agent:opencode`, `agent:claude-code`, `agent:hermes-tom`, `agent:hermes-james`, `agent:user-cli` | Mirrors the `X-Agent-ID` HTTP header. mcp-memory-service auto-tags from the header, so the adapter just needs to set the header once. |
| `persona:` | Hermes writes; optional elsewhere | `persona:tom`, `persona:james`, `persona:none` | Distinguishes multiple Hermes personas on the same host (or across hosts) sharing one pool. |
| `channel:` | every write | `channel:cli`, `channel:signal`, `channel:gateway`, `channel:email-triage`, `channel:browser` | Where the input came from. Lets us split "Hermes Signal DM" from "Hermes email-triage decision". |
| `user:` | when a human identity is attached | `user:jan`, `user:christine` | Stable alias only. **Never a raw phone number or email** — those get redacted to alias before the write. |
| `secret:` | optional, write-side | `secret:none` (default), `secret:pii` | Adapter-side detector (phone-number regex, API-token shapes, email regex). Read-side default filter excludes `secret:pii` unless the caller is the original `agent:`. |

`session:<uuid>` continues as the conversation-scope tag (already in use by pi-recap). `parent_id` continues as the graph edge (already in use by pi-recap for the recap chain).

## Decisions locked in for this iteration

### Backend deployment (the mothership pool)

| Open question | Decision |
|---|---|
| 1. Port | **`:8000`** — matches pi-cortex default, matches nexus, reuses every existing adapter convention. Override the plist's `:12345`. |
| 2. Bind | **`127.0.0.1`** only. Loopback. No LAN exposure in v1. |
| 3. Auth | **Anonymous** (`MCP_ALLOW_ANONYMOUS_ACCESS=true`). Single-user Mac on loopback — no auth surface needed. Revisit when browser extensions land. |
| 4. Backend | **`sqlite_vec`** — already configured, low ops, fine for single-user volumes. |
| 5. Storage path | **Keep** `~/Library/Application Support/mcp-memory/sqlite_vec.db`. The 2.1 MB of existing content stays in place; see open question 1 below for what to do with it. |
| 6. Backups | **Keep** `~/Library/Application Support/mcp-memory/backups`. Add `com.mcp.memory-backup.plist` for a daily snapshot, keep last 14. |
| 7. Embeddings | **ONNX** (`MCP_MEMORY_USE_ONNX=1`). Avoids the HuggingFace download on fresh installs and is faster on Apple Silicon. |
| 8. Log level | **`DEBUG`** during rollout; downgrade to `INFO` once stable. |
| 9. KeepAlive | Keep `KeepAlive.Crashed=true` from the existing plist. Drop `LimitLoadToSessionType=Aqua` so the service runs even when no GUI session is logged in (Hermes email-triage runs from launchd, not user-shell). |

### Client adapters

| Client | Decision |
|---|---|
| **pi-cortex** | No code change. Set `PI_MEMORY_ENDPOINT=http://127.0.0.1:8000` as a fish universal var on mothership (not globally — Excalibur stays on nexus). Symlink `~/.pi/agent/extensions/{pi-memory,pi-bbcontext,pi-recap,pi-narrate}` to `~/Code/pi-cortex/<ext>` so Pi-on-Mac picks them up. |
| **opencode** | Config-only redirect. Update `~/.config/opencode/memory-plugin.json` (and/or the plugin entry in `opencode.jsonc`) to point at `http://127.0.0.1:8000`. Verify whatever `X-Agent-ID` header it sets — if it doesn't, add `agent:opencode` to its default tag-set. |
| **Claude Code** | New **memory bridge** as a hook. Dual-write: keep `~/.claude/projects/<proj>/memory/*.md` as the canonical local store (boot resilience), additionally `POST /api/memories` for cross-client visibility. On recall, query both (local first for low-latency, REST for cross-client knowledge). Bridge is best-effort and silent on REST failure — never break a Claude session because the backend is down. |
| **Hermes (mothership / persona tom)** | **New custom memory provider plugin** at `~/Code/hermes/plugins/mcp-memory/{__init__.py,plugin.yaml}`. REST against `127.0.0.1:8000`. Tag every write with `agent:hermes-tom, persona:tom, channel:<source>, user:<alias>`. v1 implements `initialize`, `sync_turn`, `prefetch`, `handle_tool_call` (for an explicit `mcp_memory_search` tool); `on_memory_write` and `on_session_end` are stubs to extend later. |
| **Hermes (mrsbook / persona james)** | Same plugin code, different profile config. Out of scope for this iteration — james runs on a different host and we haven't decided whether mrsbook writes to mothership over LAN or runs its own local pool. See open question 4. |
| **Browser extensions** | Out of scope for this iteration. Schema preserves `channel:browser`, `type:reading`, `type:research` so they land cleanly when they ship. |

### Cross-cutting

- **No new git repo.** Adapter code lives where the client lives: Hermes provider in `~/Code/hermes/plugins/`, Claude bridge in `~/.claude/hooks/`. pi-cortex stays the home for Pi extensions and shared documentation (this file, `CLAUDE.md` schema).
- **No protocol abstraction layer.** Every client hits REST directly. mcp-memory-service also exposes MCP streamable-http if a client prefers it; the schema is identical.
- **Schema enforcement is client-side.** Each adapter REJECTS writes missing the required tags before sending. We do **not** add a server-side validating proxy in v1.
- **No PII auto-redaction.** `secret:pii` tagging is sufficient for v1. The adapter detects phone numbers / API keys / email addresses and tags the memory; nothing is redacted. Read-side defaults handle exposure.
- **One Hermes provider, multiple profiles.** Hermes restricts an instance to a single external memory provider (`memory_manager.py`). We use that one slot for `mcp-memory`; per-persona separation happens via tags, not multiple providers.

## What execution must produce

### Backend setup (mothership)

1. Edit `~/Library/LaunchAgents/com.mcp.memory-dashboard.plist`:
   - `MCP_HTTP_ENABLED` → `true`
   - `MCP_HTTP_PORT` → `8000`
   - Add `MCP_MEMORY_USE_ONNX` → `1`
   - Drop `LimitLoadToSessionType=Aqua`
2. Reload:
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.mcp.memory-dashboard.plist
   launchctl load   ~/Library/LaunchAgents/com.mcp.memory-dashboard.plist
   curl http://127.0.0.1:8000/api/health     # expect {"status":"healthy"}
   ```
3. Daily backup plist `com.mcp.memory-backup.plist`:
   - `StartCalendarInterval` at 04:00
   - Script `~/.local/bin/mcp-memory-backup.sh` — `rsync` of `sqlite_vec.db{,-shm,-wal}` into `…/backups/YYYYMMDD/`, prune dirs older than 14 days
4. Smoke test:
   ```bash
   # write
   curl -X POST http://127.0.0.1:8000/api/memories \
     -H 'X-Agent-ID: user-cli' -H 'Content-Type: application/json' \
     -d '{"content":"smoke test","tags":["agent:user-cli","channel:cli","proj:none","type:note"]}'
   # read
   curl -X POST http://127.0.0.1:8000/api/search \
     -H 'Content-Type: application/json' \
     -d '{"query":"smoke test","n_results":1}'
   ```

### Adapter work (separate commits, one per client)

| Adapter | Effort | Where |
|---|---|---|
| pi-cortex env + extension symlinks on mothership | trivial | fish universal var + four `ln -sfn` |
| opencode redirect | config-only | `~/.config/opencode/memory-plugin.json` |
| Claude Code memory bridge | ~150 LOC | `~/.claude/hooks/memory-bridge.{sh,py}` + settings registration |
| Hermes mcp-memory provider | ~200 LOC | `~/Code/hermes/plugins/mcp-memory/{__init__.py,plugin.yaml}`; tom profile only for v1 |
| Schema-audit script | ~80 LOC | `~/Code/pi-cortex/scripts/audit_tags.py` — lists memories missing required tags and prints suggested back-fill commands |

### Docs that ship with this plan iteration

This commit lands only the plan file itself. The follow-up docs commits land before execution starts so the schema is canonical when the first adapter writes against it.

| File | Change | Lands in |
|---|---|---|
| `pi-cortex/PLAN-MOTHERSHIP.md` | New — this file (spec + plan). | This commit. |
| `pi-cortex/CLAUDE.md` | Append `agent:`, `persona:`, `channel:`, `user:`, `secret:` rows to the tag-schema table; note they apply to every multi-client deployment. | Follow-up commit before execution. |
| `pi-cortex/README.md` | Add a one-paragraph "Local mode (mothership)" section pointing at this plan. | Follow-up commit before execution. |
| `pi-cortex/EXCALIBUR.md` | Unchanged — nexus deployment stays parallel. | — |

### Commit shape

```
docs(plan): add mothership multi-client local memory plan       ← this commit
docs(claude): add provenance tag prefixes (agent, persona, …)  ← follow-up
docs(readme): mention mothership local mode                     ← follow-up
```

Implementation commits land per adapter in their respective repos in subsequent iterations.

## Implementation order (suggested)

1. **Backend up on `127.0.0.1:8000`** + verify pi-cortex on mothership works against it. Lowest risk, immediately useful for Pi-on-Mac work, and unblocks every other adapter.
2. **Claude Code bridge.** The single most-asked-for capability in the conversation that produced this plan — lets Claude Code read Hermes' research/brainstorming.
3. **opencode redirect.** Config-only, no risk; brings opencode into the shared pool.
4. **Hermes provider, `tom` profile.** Higher complexity; the payoff is auto-write of every Signal turn into the shared pool so the rest of the stack can recall it.
5. **Schema-audit + legacy backfill** of the 2.1 MB pre-iteration content. Decide per-memory whether to apply `agent:legacy, source:imported-2026-05-17` or to leave them unaugmented (still searchable, just not auto-recallable).
6. **(Later iteration)** browser extensions; james profile for mrsbook Hermes; nexus → mothership migration (if we go that way).

## Multi-client notes (out of scope for this iteration, must not be broken)

### nexus

- Stays running on CT 105 untouched.
- Excalibur Pi continues to point at nexus (per `EXCALIBUR.md`). Do not change `PI_MEMORY_ENDPOINT` on Excalibur — that's a separate decision.
- Migration of the 31 memories to mothership, leaving them in place, or one-way replication: **deferred**, see open question 5.

### mrsbook / james

- james is the persona on mrsbook (see `agentic-admin/mrsbook/`).
- Needs its own Hermes provider once tom is shipped. Same plugin code, different profile config (`agent:hermes-james, persona:james`).
- **Open question**: writes to mothership-local over LAN, or runs its own mrsbook-local pool. See open question 4.

### Schema-portability invariants (continuing from `PLAN.md`)

All four invariants from `PLAN.md` carry over:

1. Never put dev-only values into `type:`.
2. `proj:` only for stable, machine-derivable identifiers; everything else is `topic:`.
3. Auto-set tags (`date:`, `source:`, `agent:`) are written by the adapter, not the user.
4. Memories form a graph via `parent_id` and `relationship_type`; don't break those fields.

The provenance prefixes (`agent:`, `persona:`, `channel:`, `user:`, `secret:`) are **additive**. They don't supersede or conflict with the existing schema, and they don't change the semantics of any existing tag.

## Open questions for the user (not for execution)

1. **Legacy 2.1 MB SQLite** — back-fill `agent:user-cli, source:legacy-import, date:imported-2026-05-17` across the existing content on first backend-start, or leave the pre-iteration content untagged and only enforce schema on new writes?
2. **Claude Code bridge** — dual-write (local files + REST) as decided above, or full replacement (REST is the only sink, local files become a read-cache only)? Dual-write is safer for boot resilience; full replacement is cleaner long-term.
3. **Hermes provider v1 surface** — write-only (auto-write turns via `sync_turn`), or read+write (also `prefetch` on turn-start)? Loopback RTT is sub-5 ms, so the read-side cost is probably negligible, but writes-only is simpler to ship.
4. **mrsbook / james deployment** — write across the LAN to mothership-local, or stand up a mrsbook-local pool and accept that cross-host recall needs a follow-up sync layer?
5. **nexus migration** — now (with `agent:nexus-import, source:nexus-2026-05-17` tags) or later? If later, the two pools stay isolated for the foreseeable future.

These do **not** block this iteration. They scope the next one.
