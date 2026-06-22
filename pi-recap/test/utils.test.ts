import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import type { Message, UserMessage, AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";

// Pure functions from pi-recap (replicated for testing)

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function parsePathList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => path.resolve(expandHome(p)));
}

interface TopicRoot {
  root: string;
  topic: string;
}

function parseTopicRoots(raw: string | undefined): TopicRoot[] {
  if (!raw) return [];
  const out: TopicRoot[] = [];
  for (const piece of raw.split(",")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0 || eq === trimmed.length - 1) continue;
    const root = path.resolve(expandHome(trimmed.slice(0, eq).trim()));
    const topic = trimmed.slice(eq + 1).trim();
    if (root && topic) out.push({ root, topic });
  }
  return out;
}

function isUnderRoot(cwd: string, root: string): boolean {
  if (cwd === root) return false;
  const rel = path.relative(root, cwd);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function parseModelOverride(s: string): { provider: string; modelId: string } | null {
  const idx = s.indexOf("/");
  if (idx <= 0 || idx === s.length - 1) return null;
  return { provider: s.slice(0, idx), modelId: s.slice(idx + 1) };
}

interface MaybeMessageEntry {
  type?: string;
  id?: string;
  message?: Message;
}

function isMessageEntry(e: MaybeMessageEntry): e is { type: "message"; id: string; message: Message } {
  return e.type === "message" && !!e.message && typeof e.id === "string";
}

function textOfContent(
  content: UserMessage["content"] | AssistantMessage["content"] | ToolResultMessage["content"],
): string {
  if (typeof content === "string") return content;
  return content
    .map((c) => {
      if (c.type === "text") return (c as { text?: string }).text ?? "";
      if (c.type === "thinking") return "";
      if (c.type === "image") return "[image]";
      if (c.type === "toolCall") {
        const args = JSON.stringify((c as { arguments?: unknown }).arguments ?? {});
        return `[tool-call ${(c as { name?: string }).name ?? "?"}(${args.slice(0, 200)})]`;
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function renderMessage(m: Message): string | null {
  if (m.role === "user") {
    const t = textOfContent(m.content).trim();
    return t ? `USER: ${t}` : null;
  }
  if (m.role === "assistant") {
    const t = textOfContent(m.content).trim();
    return t ? `ASSISTANT: ${t}` : null;
  }
  if (m.role === "toolResult") {
    const t = textOfContent(m.content).trim();
    if (!t) return null;
    return `TOOL[${m.toolName}]${m.isError ? "(error)" : ""}: ${t.slice(0, 600)}`;
  }
  return null;
}

function buildTranscript(messages: Message[], maxChars: number): string {
  const rendered = messages.map(renderMessage).filter((s): s is string => !!s);
  let total = 0;
  const kept: string[] = [];
  for (let i = rendered.length - 1; i >= 0; i--) {
    const line = rendered[i]!;
    const len = line.length + 1;
    if (total + len > maxChars && kept.length > 0) break;
    kept.push(line);
    total += len;
  }
  kept.reverse();
  if (kept.length < rendered.length) {
    kept.unshift(`[...${rendered.length - kept.length} earlier message(s) truncated...]`);
  }
  return kept.join("\n\n");
}

describe("clampInt", () => {
  it("returns fallback for undefined", () => {
    expect(clampInt(undefined, 4, 1, 1000)).toBe(4);
  });

  it("clamps to min and max", () => {
    expect(clampInt("0", 4, 1, 1000)).toBe(1);
    expect(clampInt("9999", 4, 1, 1000)).toBe(1000);
  });
});

describe("parseModelOverride", () => {
  it("parses valid provider/model", () => {
    expect(parseModelOverride("anthropic/claude-4")).toEqual({
      provider: "anthropic",
      modelId: "claude-4",
    });
  });

  it("returns null for invalid formats", () => {
    expect(parseModelOverride("")).toBeNull();
    expect(parseModelOverride("/model")).toBeNull();
    expect(parseModelOverride("provider/")).toBeNull();
    expect(parseModelOverride("noslash")).toBeNull();
  });
});

describe("isMessageEntry", () => {
  it("returns true for valid message entry", () => {
    const entry = {
      type: "message" as const,
      id: "abc123",
      message: { role: "user" as const, content: "hello" },
    };
    expect(isMessageEntry(entry)).toBe(true);
  });

  it("returns false for non-message types", () => {
    expect(isMessageEntry({ type: "thinking_level_change" })).toBe(false);
  });

  it("returns false when message is missing", () => {
    expect(isMessageEntry({ type: "message", id: "abc" })).toBe(false);
  });

  it("returns false when id is missing", () => {
    expect(isMessageEntry({ type: "message", message: { role: "user" as const, content: "hi" } })).toBe(
      false,
    );
  });
});

describe("textOfContent", () => {
  it("handles string content", () => {
    expect(textOfContent("hello world")).toBe("hello world");
  });

  it("handles text content array", () => {
    expect(
      textOfContent([
        { type: "text" as const, text: "hello" },
        { type: "text" as const, text: "world" },
      ]),
    ).toBe("hello world");
  });

  it("skips thinking content", () => {
    expect(
      textOfContent([
        { type: "text" as const, text: "before" },
        { type: "thinking" as const, text: "secret thoughts" },
        { type: "text" as const, text: "after" },
      ]),
    ).toBe("before after");
  });

  it("handles image content", () => {
    expect(textOfContent([{ type: "image" as const }])).toBe("[image]");
  });

  it("handles tool call content", () => {
    expect(
      textOfContent([{ type: "toolCall" as const, name: "bash", arguments: { command: "ls" } }]),
    ).toBe('[tool-call bash({"command":"ls"})]');
  });
});

describe("renderMessage", () => {
  it("renders user message", () => {
    const msg: UserMessage = { role: "user", content: "hello", timestamp: Date.now() };
    expect(renderMessage(msg)).toBe("USER: hello");
  });

  it("renders assistant message", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "here you go" }],
    };
    expect(renderMessage(msg)).toBe("ASSISTANT: here you go");
  });

  it("renders tool result", () => {
    const msg: ToolResultMessage = {
      role: "toolResult",
      toolName: "bash",
      content: "output here",
      isError: false,
    };
    expect(renderMessage(msg)).toBe("TOOL[bash]: output here");
  });

  it("renders error tool result with marker", () => {
    const msg: ToolResultMessage = {
      role: "toolResult",
      toolName: "edit",
      content: "failed to write",
      isError: true,
    };
    expect(renderMessage(msg)).toBe("TOOL[edit](error): failed to write");
  });

  it("returns null for empty content", () => {
    const msg: UserMessage = { role: "user", content: "  ", timestamp: Date.now() };
    expect(renderMessage(msg)).toBeNull();
  });
});

describe("buildTranscript", () => {
  it("builds transcript from messages", () => {
    const messages: Message[] = [
      { role: "user", content: "hello", timestamp: Date.now() },
      { role: "assistant", content: [{ type: "text", text: "hi there" }] },
    ];
    const result = buildTranscript(messages, 1000);
    expect(result).toContain("USER: hello");
    expect(result).toContain("ASSISTANT: hi there");
  });

  it("truncates from oldest when over budget", () => {
    const messages: Message[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: "user", content: `message ${i}`, timestamp: Date.now() + i });
    }
    const result = buildTranscript(messages, 100);
    expect(result).toContain("truncated");
    expect(result).toContain("message 9"); // newest kept
    expect(result).not.toContain("message 0"); // oldest dropped
  });

  it("handles empty messages", () => {
    expect(buildTranscript([], 100)).toBe("");
  });
});
