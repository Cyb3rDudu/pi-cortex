# pi-cortex implementation plan

This file is the contract between planning sessions and execution sessions. Read `CLAUDE.md` first for project context and the canonical tag schema, then this file for the work scope and decisions already locked in.

## Mission framing (broader than this iteration)

`pi-cortex` is **the cognitive layer for every LLM client we run**, not just Pi. Architecture:

```
                 ┌──────────────────────────────────────────────┐
                 │   mcp-memory-service (nexus, CT 105)          │
                 │   semantic store + graph relationships        │
                 └──────────────────────────────────────────────┘
                                ▲       ▲       ▲       ▲
                                │       │       │       │
       ┌────────────────────────┘       │       │       └─────────────────────┐
       │                                │       │                             │
   ┌───┴────┐                    ┌──────┴─┐ ┌───┴──────┐               ┌──────┴──────┐
   │   Pi   │                    │OpenCode│ │ DeepChat │               │  Browser    │
   │  CLI   │                    │  CLI   │ │   GUI    │               │   plugin    │
   │  dev   │                    │ legacy │ │ research │               │  (future)   │
   └───┬────┘                    └────────┘ └──────┬───┘               └──────┬──────┘
       │                                            │                          │
       │ this repo (pi-cortex):                    │ Skill-based recall +     │ TBD
       │   pi-memory  (tools)                      │ agent-decided saves      │ likely:
       │   pi-bbcontext (auto-inject)              │ via the same MCP         │ topic-tagged
       │   pi-recap   (auto-summarize)             │ backend                  │ reading saves
       └─────                                                                ──┘
```

**This iteration ships only the Pi-side:** `pi-bbcontext v0.2` and `pi-recap v0.1`. The schema and conventions documented below MUST stay tool-agnostic because DeepChat and the browser plugin will land later against the same backend.

## Tag schema additions (update `CLAUDE.md`)

The current schema in `CLAUDE.md` is dev-coded. Extend it as follows; these changes are part of this work and must land in `CLAUDE.md` before code merges.

### Add a new namespace prefix

| Prefix | When to use |
|---|---|
| `topic:` | Soft grouping for non-code work (DeepChat conversations, browser reading sessions, cross-cutting research). May coexist with `proj:`. Examples: `topic:llms`, `topic:home-infra`, `topic:bug-bounty`. |

`proj:` remains the canonical anchor for code-repo work — deterministic, machine-derivable from git remote / project markers. `topic:` is the gentler key when there's no cwd, no repo, no obvious project identity. They are not mutually exclusive: a memory can carry both.

### Add new `type:` values

| Value | Use for |
|---|---|
| `type:research` | Facts gathered while reading / exploring a topic. Cross-cutting. |
| `type:reading` | Notes pulled from a specific source (paper, article, video, page). |
| `type:idea` | Generative thoughts to revisit. |
| `type:question` | Open questions to circle back to. |

Existing `type:` values stay as-is. The dev-flavored ones (`recon`, `enum`, `finding`, `negative`) and the cross-cutting ones (`reference`, `user`, `feedback`, `decision`, `note`, `session-recap`, `scope`) all keep their semantics.

### Project-key derivation — clarify the "no key" case

`CLAUDE.md` says memories without a derivable project key are either `proj:none` or shouldn't be auto-injected. Tighten that:

- Pi extensions (`pi-bbcontext`, `pi-recap`) **never** write `proj:none` — if the key can't be derived, they no-op.
- Other clients (DeepChat, browser) MAY write `proj:none` for cross-cutting facts; those memories surface to Pi only when `PI_BBCONTEXT_INCLUDE_GLOBAL=1`.

### `CLAUDE.md` correction

The current text says "no `session_start` exists in 0.72 — only `agent_start`, `agent_end`, …". That's wrong — `session_start`, `session_shutdown`, `turn_start`, `turn_end`, `session_compact`, and `session_before_compact` all exist (verified in `~/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts:593–602`). Fix the note so future planning isn't misled.

## Decisions locked in for this iteration

The dedicated planning session produced a thorough proposal with open questions. Answers below — these are not up for debate during execution; flag if implementation reveals a real blocker.

### `pi-bbcontext v0.2`

| Open question | Decision |
|---|---|
| 1. Extra tag filter applies to the global bucket too? | **Yes**. Apply consistently. User can clear `PI_BBCONTEXT_TAGS` to see unfiltered globals. |
| 2. Bucket cardinality — greedy fill or reserve quotas per bucket? | **Greedy.** `PI_BBCONTEXT_MAX` is a budget, not a per-bucket quota. |
| 3. Block placement — before or after the base system prompt? | **After** (matches v0.1; "this is context, not instructions" framing reads naturally last). |
| 4. Tag-only, or always include a small semantic top-up? | **Tag-first**, `PI_BBCONTEXT_QUERY` is the *fallback only* when tag-based search returns zero hits. |
| 5. Migrate legacy memories tagged `bugbounty,decision,finding`? | **No.** Clean break. Document in `EXCALIBUR.md`. New memories follow the namespaced schema; legacy ones are searchable via raw tag matching but won't auto-inject until they're rewritten. |

### `pi-recap v0.1`

| Open question | Decision |
|---|---|
| 1. `pi-ai` import path — verify before writing code? | **Verify.** Sanity-check `~/.bun/install/global/node_modules/.../pi-ai/package.json` exports the expected `streamSimple` (or equivalent) before depending on it. If not exported, fall back to using `ctx`-provided helpers. |
| 2. `session_before_compact` as a trigger? | **Keep it.** It's the most useful "save state before context loss" moment. The latency cost is acceptable since compaction itself is heavy. |
| 3. `agent_end` vs `session_shutdown` for end-of-session? | **`session_shutdown`.** One final recap at process exit, not one per agent loop. Fewer, higher-signal recaps. |
| 4. Set both `tags: [type:session-recap]` AND top-level `memory_type: "session-recap"`? | **Both.** Redundant on purpose. Tag is canonical for retrieval; top-level matches mcp-memory-service's native field. |
| 5. Append recap to the session transcript too? | **No.** Keep the transcript clean. The memory store is the surface; `/recap status` is the in-session inspection tool. |
| 6. Duplicate `deriveProjectKey` across `pi-bbcontext` and `pi-recap`? | **Yes for v0.1.** Self-contained extensions per `CLAUDE.md`. A `pi-cortex-shared/` workspace package is a refactor candidate, not part of v0.1. |
| 7. Symlinks on excalibur — manual or scripted? | **Manual for v0.1.** Add the `pi-recap` symlink command to `EXCALIBUR.md`'s deploy section. A scripted bootstrap is a candidate after pi-recap proves out. |

### Cross-cutting decisions

- **No tests / CI.** `CLAUDE.md` already says verification is by running Pi. Don't add a test framework.
- **No build step.** Ship `.ts` source. Pi loads it via Bun.
- **No new runtime deps.** Both extensions stick to `node:` builtins, global `fetch`, `typebox` (already a peer for `pi-memory`), and indirect access to `@mariozechner/pi-ai` via the host's `node_modules`.

## What execution must produce

### Code

- `pi-bbcontext/index.ts` — rewrite (~200 LOC) per the bucket-and-rank plan in the dedicated session's proposal. `package.json` version bump to `0.2.0`.
- `pi-recap/index.ts` + `pi-recap/package.json` — new extension (~250 LOC). Same factory shape as the others. `pi.extensions: ["./index.ts"]`.

### Docs

- `CLAUDE.md`:
  - Add the `topic:` prefix row to the tag schema table.
  - Add the four new `type:` values (`research`, `reading`, `idea`, `question`).
  - Tighten the "project-key fallback" wording per the rule above.
  - Fix the `session_start` claim — list the actual `session_*` and `turn_*` events as verified in pi 0.72's `types.d.ts`.
  - Update the env-var table in the configuration section to include all new vars from `pi-bbcontext` and `pi-recap`.
  - Flip pi-recap from "future" to "live" in the architecture diagram.
- `EXCALIBUR.md`:
  - Update "What's deployed right now" — pi-bbcontext to ✅ at 0.2.0, pi-recap to ✅ at 0.1.0.
  - Update env-var table with new keys.
  - Document the legacy-memory clean break (no backfill).
  - Add the `pi-recap` symlink command to the deploy section.
- `README.md`:
  - One-line description of `pi-recap`.
  - Update the configuration table to match `CLAUDE.md`.

### Commit shape

Conventional commits with flat scope, per `CLAUDE.md`. Suggested commits (split as needed):

```
feat(bbcontext): rule-based, project-aware auto-injection (v0.2)
feat(recap): auto-summarization with parent_id chain (v0.1)
docs(extensions): tag schema additions (topic:, research types)
docs(claude): fix session_start event reference
chore(release): pi-bbcontext 0.2.0, pi-recap 0.1.0
```

## Multi-client notes (out of scope for this iteration, must not be broken)

These are not implementation tasks for this iteration. They define the constraints the schema must keep satisfied so we don't repaint the bikeshed when DeepChat / the browser plugin land.

### DeepChat (research / non-code chat)

- Will use the **same `mcp-memory-service` backend** via its native MCP support (already proven — opencode hits the same backend).
- Will use a **DeepChat Skill** (markdown, the open Agent Skills standard, same SKILL.md format we already use) named e.g. `memory-aware-chat` instructing the model to:
  - Call `memory_search` (via the MCP) before answering substantive questions.
  - Call `memory_store` with appropriate tags after learning or deciding something noteworthy.
- Project-key strategy in DeepChat:
  - DeepChat conversations don't have cwd. Use `topic:<conversation-name>` as the soft anchor.
  - Long-running research thread → e.g. `topic:research/llm-agentic-patterns`.
  - May add `proj:none` for truly cross-cutting items.
- DeepChat does not have lifecycle hooks → **no auto-recap loop** there. Recap is Pi-only territory until DeepChat exposes plugin hooks. Skill instructions can ask the model to "save a one-line recap before you sign off," but that's model-discretion, not a guarantee.

### Browser plugin (future)

- Pure capture-side. Will emit memories tagged:
  - `type:reading` for explicitly saved pages
  - `type:research` for highlighted insights
  - `topic:<domain or topic>` as soft grouping
  - Rarely a `proj:<key>` (only if the user is explicitly saving into a known project context — e.g., a "save to acme.com bug bounty" hotkey)
- Defaults to `proj:none` to avoid polluting Pi's project searches.
- Implementation TBD; not scoped here.

### Schema-portability invariants

To keep these clients composable later:

1. **Never put dev-only values into `type:`.** All `type:` values must make sense across clients OR have a clearly-namespaced sibling. The new research types are the proof case.
2. **`proj:` is for stable, machine-derivable identifiers.** If something can't be derived from `git remote` or a project marker, it doesn't get a `proj:` — use `topic:` instead.
3. **Auto-set tags (`date:`, `source:`) are written by the storage adapter, not the user.** Each client's `source:` value is its own (e.g., `source:pi-recap`, `source:deepchat`, `source:browser`).
4. **Memories form a graph, not just a flat list.** `parent_id` and `relationship_type` are part of the schema. `pi-recap` sets up the first chain (`relationship_type: "follows"`); future tooling may add `relationship_type: "supersedes"`, `"refers-to"`, etc. Don't break the existing fields.

## Open questions for the user (not for execution)

These are mine to think about before next iteration; flagging here so they're not lost:

- Should `pi-cortex` ship a small CLI tool (e.g. `cortex-store`, `cortex-search`) for non-Pi shells (cron jobs, fish abbreviations, browser plugin's native messaging host) to interact with the memory store without round-tripping through an LLM? Probably yes, eventually.
- Do we want a memory-graph viewer (web UI on top of mcp-memory-service's existing dashboard) that surfaces the recap chain visually? mcp-memory-service's dashboard shows individual memories, not relationships.
- Tag governance: a single `proj:` per memory feels right, but should `type:` be plural (a memory can be both `type:finding` and `type:decision`)? Lean: keep singular for now; if we need to express "this finding led to a decision," that's two memories with `parent_id` linking them.

These do **not** block this iteration.
