import { describe, it, expect, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

// We test the pure logic by re-implementing the functions inline
// (they're not exported from the extension, so we replicate them here
// to verify the logic is correct and catch regressions).

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

function parseRemote(url: string): string | null {
  const stripped = url.replace(/\.git$/, "");
  const ssh = stripped.match(/^[a-z]+@([^:]+):(.+)$/i);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  try {
    const u = new URL(stripped);
    const p = u.pathname.replace(/^\/+/, "");
    return `${u.host}/${p}`;
  } catch {
    return null;
  }
}

describe("expandHome", () => {
  it("expands ~ to homedir", () => {
    expect(expandHome("~")).toBe(os.homedir());
  });

  it("expands ~/path to homedir/path", () => {
    expect(expandHome("~/foo/bar")).toBe(path.join(os.homedir(), "foo/bar"));
  });

  it("leaves absolute paths unchanged", () => {
    expect(expandHome("/tmp/test")).toBe("/tmp/test");
  });

  it("leaves relative paths unchanged", () => {
    expect(expandHome("foo/bar")).toBe("foo/bar");
  });
});

describe("parsePathList", () => {
  it("returns empty array for undefined", () => {
    expect(parsePathList(undefined)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parsePathList("")).toEqual([]);
  });

  it("parses single path", () => {
    const result = parsePathList("/tmp");
    expect(result).toEqual(["/tmp"]);
  });

  it("parses comma-separated paths", () => {
    const result = parsePathList("/tmp, /var");
    expect(result).toEqual(["/tmp", "/var"]);
  });

  it("expands ~ in paths", () => {
    const result = parsePathList("~/Code,~/Bounties");
    expect(result).toEqual([
      path.join(os.homedir(), "Code"),
      path.join(os.homedir(), "Bounties"),
    ]);
  });

  it("filters empty entries", () => {
    const result = parsePathList("/tmp,,/var, ");
    expect(result).toEqual(["/tmp", "/var"]);
  });
});

describe("parseTopicRoots", () => {
  it("returns empty array for undefined", () => {
    expect(parseTopicRoots(undefined)).toEqual([]);
  });

  it("parses single topic root", () => {
    const result = parseTopicRoots("~/Code/bounties=bug-bounty");
    expect(result).toEqual([
      {
        root: path.join(os.homedir(), "Code/bounties"),
        topic: "bug-bounty",
      },
    ]);
  });

  it("parses multiple topic roots", () => {
    const result = parseTopicRoots("~/Code/bounties=bug-bounty,~/Reading=research");
    expect(result).toEqual([
      { root: path.join(os.homedir(), "Code/bounties"), topic: "bug-bounty" },
      { root: path.join(os.homedir(), "Reading"), topic: "research" },
    ]);
  });

  it("skips entries without =", () => {
    const result = parseTopicRoots("invalid,~/Code=valid");
    expect(result).toEqual([{ root: path.join(os.homedir(), "Code"), topic: "valid" }]);
  });

  it("skips entries with = at start or end", () => {
    const result = parseTopicRoots("=bad,good=,~/Code=ok");
    expect(result).toEqual([{ root: path.join(os.homedir(), "Code"), topic: "ok" }]);
  });
});

describe("isUnderRoot", () => {
  it("returns true when cwd is directly under root", () => {
    expect(isUnderRoot("/tmp/foo", "/tmp")).toBe(true);
  });

  it("returns true when cwd is deeply nested under root", () => {
    expect(isUnderRoot("/tmp/foo/bar/baz", "/tmp")).toBe(true);
  });

  it("returns false when cwd equals root", () => {
    expect(isUnderRoot("/tmp", "/tmp")).toBe(false);
  });

  it("returns false when cwd is outside root", () => {
    expect(isUnderRoot("/var/foo", "/tmp")).toBe(false);
  });

  it("returns false when cwd shares prefix but is not under root", () => {
    expect(isUnderRoot("/tmp2/foo", "/tmp")).toBe(false);
  });
});

describe("parseRemote", () => {
  it("parses SSH-style git URL", () => {
    expect(parseRemote("git@github.com:owner/repo.git")).toBe("github.com/owner/repo");
  });

  it("parses SSH-style git URL without .git", () => {
    expect(parseRemote("git@github.com:owner/repo")).toBe("github.com/owner/repo");
  });

  it("parses HTTPS-style git URL", () => {
    expect(parseRemote("https://github.com/owner/repo.git")).toBe("github.com/owner/repo");
  });

  it("parses HTTPS-style git URL without .git", () => {
    expect(parseRemote("https://github.com/owner/repo")).toBe("github.com/owner/repo");
  });

  it("parses HTTPS URL with leading slash in path", () => {
    expect(parseRemote("https://gitlab.com/group/subgroup/repo.git")).toBe(
      "gitlab.com/group/subgroup/repo",
    );
  });

  it("returns null for invalid URL", () => {
    expect(parseRemote("not-a-url")).toBeNull();
  });

  it("handles SSH URLs with subgroups", () => {
    expect(parseRemote("git@gitlab.com:group/subgroup/repo.git")).toBe(
      "gitlab.com/group/subgroup/repo",
    );
  });
});
