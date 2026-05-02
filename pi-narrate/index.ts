/**
 * pi-narrate
 *
 * Tiny extension that appends a narration guideline to every system prompt
 * via Pi's `before_agent_start` hook. The default Pi system prompt does not
 * tell the agent how chatty to be; without guidance, models like glm-5.1
 * tend to produce silent action streams (5 tool calls in a row, no prose
 * commentary, then a multi-memory_store dump). That's bad UX for live work
 * — the user wants short status updates between actions, not just durable
 * memory artifacts.
 *
 * This extension does ONE thing: it appends a small "Working style" block
 * to the system prompt on every model call, instructing the agent to:
 *   - narrate one or two sentences between actions (what was learned, what's
 *     next),
 *   - avoid silent tool-call streams,
 *   - prefix each memory_store with a one-line "why" so memories don't
 *     replace user-visible narration.
 *
 * Configure via environment variables:
 *   PI_NARRATE_DISABLE   If set to any non-empty value, disables injection.
 *   PI_NARRATE_EXTRA     Optional additional sentences appended after the
 *                        built-in block (e.g. project-specific tone).
 *
 * License: MIT
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DISABLED = !!process.env.PI_NARRATE_DISABLE;
const EXTRA = (process.env.PI_NARRATE_EXTRA ?? "").trim();

const NARRATION_BLOCK = `## Working style

Narrate your work in short user-visible updates between actions. Between any two tool calls, write one or two sentences saying:
- what you just learned from the previous result (be concrete: name the endpoint, the status code, the implication, the file and line, etc.), and
- what you're going to try next and why.

Avoid silent action streams. Do not run multiple tool calls in a row without a one-line status update. Do not dump several memory_store calls back-to-back without prose between them — write a one-line "why" before each memory_store ("Worth saving — preprod env with weak auth pattern") so the user sees the reasoning live.

Memories are durable artifacts. Status updates are the live commentary the user reads while you work. Both are required; one does not replace the other.

When you are about to run a sequence of related actions ("nuclei scan, more probing on X, then Y"), name the FIRST one explicitly and start it — don't just announce the list and disappear into tool calls.`;

export default async function piNarrateExtension(pi: ExtensionAPI) {
  if (DISABLED) return;

  const block = EXTRA ? `${NARRATION_BLOCK}\n\n${EXTRA}` : NARRATION_BLOCK;

  pi.on("before_agent_start", async (event) => {
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });

  pi.registerCommand("narrate", {
    description: "Show or test the current pi-narrate injected block.",
    handler: async (args, ctx) => {
      const cmd = args.trim();
      if (cmd === "status") {
        ctx.ui.notify(
          `pi-narrate: enabled, extra=${EXTRA ? `${EXTRA.length} chars` : "none"}, block=${block.length} chars`,
          "info",
        );
        return;
      }
      ctx.ui.notify(block, "info");
    },
  });
}
