import { describe, it, expect } from "vitest";

interface MemoryShape {
  content?: string;
  content_hash?: string;
  tags?: string[];
  created_at_iso?: string;
  [k: string]: unknown;
}

function normalizeMemoryList(data: { results?: unknown[]; memories?: unknown[] }): MemoryShape[] {
  const items = data.results ?? data.memories ?? [];
  return items
    .map((item) => {
      if (item && typeof item === "object" && "memory" in item) {
        return (item as { memory?: MemoryShape }).memory;
      }
      return item as MemoryShape;
    })
    .filter((m): m is MemoryShape => !!m && typeof m === "object");
}

function summarizeMemory(m: MemoryShape): string {
  const tags = (m.tags ?? []).join(", ") || "—";
  const date = m.created_at_iso?.slice(0, 10) ?? "—";
  const head = (m.content ?? "").slice(0, 240).replace(/\s+/g, " ");
  return `[${date}] (${tags}) ${head}`;
}

describe("normalizeMemoryList", () => {
  it("handles empty results", () => {
    expect(normalizeMemoryList({})).toEqual([]);
    expect(normalizeMemoryList({ results: [] })).toEqual([]);
    expect(normalizeMemoryList({ memories: [] })).toEqual([]);
  });

  it("normalizes wrapped results (search endpoint format)", () => {
    const data = {
      results: [
        {
          memory: { content: "hello", content_hash: "abc123", tags: ["proj:test"] },
          similarity_score: 0.9,
        },
        {
          memory: { content: "world", content_hash: "def456", tags: ["type:note"] },
          similarity_score: 0.7,
        },
      ],
    };
    const result = normalizeMemoryList(data);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ content: "hello", content_hash: "abc123", tags: ["proj:test"] });
    expect(result[1]).toEqual({ content: "world", content_hash: "def456", tags: ["type:note"] });
  });

  it("normalizes flat memories (listing endpoint format)", () => {
    const data = {
      memories: [
        { content: "first", tags: ["a"] },
        { content: "second", tags: ["b"] },
      ],
    };
    const result = normalizeMemoryList(data);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ content: "first", tags: ["a"] });
    expect(result[1]).toEqual({ content: "second", tags: ["b"] });
  });

  it("prefers results over memories when both present", () => {
    const data = {
      results: [{ memory: { content: "from-results" } }],
      memories: [{ content: "from-memories" }],
    };
    const result = normalizeMemoryList(data);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("from-results");
  });

  it("filters out null and non-object entries", () => {
    const data = {
      memories: [null, "string", 42, { content: "valid" }, undefined] as unknown[],
    };
    const result = normalizeMemoryList(data);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ content: "valid" });
  });
});

describe("summarizeMemory", () => {
  it("formats a complete memory", () => {
    const m: MemoryShape = {
      content: "This is a test memory content",
      tags: ["proj:test", "type:note"],
      created_at_iso: "2026-06-22T12:00:00Z",
    };
    expect(summarizeMemory(m)).toBe(
      "[2026-06-22] (proj:test, type:note) This is a test memory content",
    );
  });

  it("uses — for missing date", () => {
    const m: MemoryShape = { content: "hello", tags: ["a"] };
    expect(summarizeMemory(m)).toBe("[—] (a) hello");
  });

  it("uses — for missing tags", () => {
    const m: MemoryShape = { content: "hello", created_at_iso: "2026-01-01T00:00:00Z" };
    expect(summarizeMemory(m)).toBe("[2026-01-01] (—) hello");
  });

  it("truncates content at 240 chars", () => {
    const long = "x".repeat(300);
    const m: MemoryShape = { content: long, tags: ["a"], created_at_iso: "2026-01-01T00:00:00Z" };
    const result = summarizeMemory(m);
    expect(result.split(") ")[1]?.length).toBeLessThanOrEqual(240);
  });

  it("collapses whitespace in content", () => {
    const m: MemoryShape = {
      content: "hello   world\n\nfoo  bar",
      tags: ["a"],
      created_at_iso: "2026-01-01T00:00:00Z",
    };
    expect(summarizeMemory(m)).toBe("[2026-01-01] (a) hello world foo bar");
  });
});
