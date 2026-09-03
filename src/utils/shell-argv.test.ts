// Tests for shell argv parsing helpers.
import { describe, expect, it } from "vitest";
import { hasTopLevelShellControlOperator, splitShellArgs } from "./shell-argv.js";

describe("hasTopLevelShellControlOperator", () => {
  it.each([
    { input: "cmd1; cmd2", reason: "semicolon" },
    { input: "cmd1 && cmd2", reason: "ampersand" },
    { input: "cmd1 | cmd2", reason: "pipe" },
    { input: "cmd1\ncmd2", reason: "newline" },
    { input: "cmd1\rcmd2", reason: "carriage return" },
  ])("returns true for '$input' ($reason)", ({ input }) => {
    expect(hasTopLevelShellControlOperator(input)).toBe(true);
  });

  it.each([
    { input: "echo hello", reason: "simple command" },
    { input: "echo 'a;b'", reason: "quoted semicolon" },
    { input: 'echo "a&&b"', reason: "quoted ampersand" },
    { input: "echo 'a|b'", reason: "quoted pipe" },
    { input: "echo a\\;b", reason: "escaped semicolon" },
    { input: "", reason: "empty string" },
    { input: "echo hello world", reason: "multi-word command" },
  ])("returns false for '$input' ($reason)", ({ input }) => {
    expect(hasTopLevelShellControlOperator(input)).toBe(false);
  });

  it("returns false for comment-only string", () => {
    expect(hasTopLevelShellControlOperator("# comment")).toBe(false);
  });

  it("returns true for command with trailing comment and newline", () => {
    expect(hasTopLevelShellControlOperator("cmd # comment\n")).toBe(true);
  });

  it("handles double quote escapes", () => {
    // \" inside double quotes is a literal quote, does NOT close the quote
    // so the semicolon remains inside the quoted string
    expect(hasTopLevelShellControlOperator('echo "hello\\"world; echo bye')).toBe(false);
    // \\n inside double quotes: \ is not a recognized escape (n is not in DOUBLE_QUOTE_ESCAPES)
    // so the backslash is preserved literally and the quote continues
    expect(hasTopLevelShellControlOperator('echo "hello\\nworld"')).toBe(false);
  });

  it("handles redirect with ampersand", () => {
    expect(hasTopLevelShellControlOperator("cmd >&2")).toBe(false);
    expect(hasTopLevelShellControlOperator("cmd > &2")).toBe(true);
  });
});

describe("splitShellArgs", () => {
  it("splits simple space-separated args", () => {
    expect(splitShellArgs("a b c")).toEqual(["a", "b", "c"]);
  });

  it("handles multiple spaces", () => {
    expect(splitShellArgs("a  b   c")).toEqual(["a", "b", "c"]);
  });

  it("handles tabs", () => {
    expect(splitShellArgs("a\tb\tc")).toEqual(["a", "b", "c"]);
  });

  it("handles single-quoted args", () => {
    expect(splitShellArgs("'hello world' arg")).toEqual(["hello world", "arg"]);
  });

  it("handles double-quoted args", () => {
    expect(splitShellArgs('"hello world" arg')).toEqual(["hello world", "arg"]);
  });

  it("handles mixed quotes", () => {
    expect(splitShellArgs("'single' \"double\" bare")).toEqual(["single", "double", "bare"]);
  });

  it("handles escaped characters", () => {
    expect(splitShellArgs("hello\\ world")).toEqual(["hello world"]);
  });

  it("handles escaped backslash", () => {
    expect(splitShellArgs("hello\\\\ world")).toEqual(["hello\\", "world"]);
  });

  it("handles double quote escapes", () => {
    // In double quotes, only \\, \", \$, \`, \\n, \\r consume the backslash
    // \\n is NOT a recognized escape (n not in DOUBLE_QUOTE_ESCAPES), so both chars preserved
    expect(splitShellArgs('"hello\\nworld"')).toEqual(["hello\\nworld"]);
    // \\\\ inside double quotes: \\ IS a recognized escape, so it becomes single \
    expect(splitShellArgs('"hello\\\\world"')).toEqual(["hello\\world"]);
  });

  it("returns null for unterminated single quote", () => {
    expect(splitShellArgs("'hello")).toBeNull();
  });

  it("returns null for unterminated double quote", () => {
    expect(splitShellArgs('"hello')).toBeNull();
  });

  it("returns null for trailing escape", () => {
    expect(splitShellArgs("hello\\")).toBeNull();
  });

  it("handles empty string", () => {
    expect(splitShellArgs("")).toEqual([]);
  });

  it("handles whitespace-only string", () => {
    expect(splitShellArgs("   ")).toEqual([]);
  });

  it("ignores inline comment", () => {
    expect(splitShellArgs("cmd arg # comment")).toEqual(["cmd", "arg"]);
  });

  it("handles complex realistic case", () => {
    expect(splitShellArgs('git commit -m "hello world" --no-verify')).toEqual([
      "git",
      "commit",
      "-m",
      "hello world",
      "--no-verify",
    ]);
  });

  it("treats hash at word start as comment", () => {
    // In POSIX shells, # starts a comment only when it begins a word
    // "echo #hashtag" → after "echo", buf is empty (pushed by space), so # begins a word → comment
    expect(splitShellArgs("echo #hashtag")).toEqual(["echo"]);
  });

  it("preserves hash inside quotes", () => {
    expect(splitShellArgs('"#hashtag"')).toEqual(["#hashtag"]);
  });
});
