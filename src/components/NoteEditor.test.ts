import { describe, it, expect } from "vitest";
import { matchSlash } from "./NoteEditor";

describe("matchSlash", () => {
  it("matches a bare slash at line start", () => {
    expect(matchSlash("/")).toEqual({ query: "" });
  });
  it("captures the query after the slash", () => {
    expect(matchSlash("hello /head")).toEqual({ query: "head" });
    expect(matchSlash("/todo")).toEqual({ query: "todo" });
  });
  it("does not match a slash mid-word (e.g. URLs or paths)", () => {
    expect(matchSlash("http://x")).toBeNull();
    expect(matchSlash("a/b")).toBeNull();
  });
  it("closes once whitespace follows the slash", () => {
    expect(matchSlash("/head ")).toBeNull();
  });
});
