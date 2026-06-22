import { describe, it, expect } from "vitest";

// Replicate the narration block logic from pi-narrate for testing
const NARRATION_BLOCK = `## Working style

Narrate your work in short user-visible updates between actions. Between any two tool calls, write one or two sentences saying:
- what you just learned from the previous result (be concrete: name the endpoint, the status code, the implication, the file and line, etc.), and
- what you're going to try next and why.

Avoid silent action streams. Do not run multiple tool calls in a row without a one-line status update. Do not dump several memory_store calls back-to-back without prose between them — write a one-line "why" before each memory_store ("Worth saving — preprod env with weak auth pattern") so the user sees the reasoning live.

Memories are durable artifacts. Status updates are the live commentary the user reads while you work. Both are required; one does not replace the other.

When you are about to run a sequence of related actions ("nuclei scan, more probing on X, then Y"), name the FIRST one explicitly and start it — don't just announce the list and disappear into tool calls.`;

function buildNarrateBlock(extra: string): string {
  return extra ? `${NARRATION_BLOCK}\n\n${extra}` : NARRATION_BLOCK;
}

function injectSystemPrompt(systemPrompt: string, extra: string): string {
  const block = buildNarrateBlock(extra);
  return `${systemPrompt}\n\n${block}`;
}

describe("narrate block", () => {
  it("contains the working style header", () => {
    expect(NARRATION_BLOCK).toContain("## Working style");
  });

  it("contains key instructions", () => {
    expect(NARRATION_BLOCK).toContain("Narrate your work");
    expect(NARRATION_BLOCK).toContain("silent action streams");
    expect(NARRATION_BLOCK).toContain("memory_store");
    expect(NARRATION_BLOCK).toContain("one-line");
  });

  it("builds block without extra", () => {
    const block = buildNarrateBlock("");
    expect(block).toBe(NARRATION_BLOCK);
  });

  it("appends extra after double newline", () => {
    const block = buildNarrateBlock("Custom rule: always use bash");
    expect(block).toBe(`${NARRATION_BLOCK}\n\nCustom rule: always use bash`);
  });

  it("injects block after system prompt", () => {
    const result = injectSystemPrompt("You are a helpful assistant.", "");
    expect(result).toContain("You are a helpful assistant.");
    expect(result).toContain("## Working style");
    expect(result.split("## Working style")[0]).toBe("You are a helpful assistant.\n\n");
  });

  it("injects block with extra content", () => {
    const result = injectSystemPrompt("Base prompt", "Extra rule");
    expect(result).toContain("Base prompt");
    expect(result).toContain("## Working style");
    expect(result).toContain("Extra rule");
    // Extra comes after the narration block
    const narrationIdx = result.indexOf("## Working style");
    const extraIdx = result.indexOf("Extra rule");
    expect(extraIdx).toBeGreaterThan(narrationIdx);
  });
});
