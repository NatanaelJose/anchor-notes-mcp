import { describe, expect, it } from "vitest";
import { appendMarkdown, toDelta, toMarkdown } from "../src/markdown";
import { roundTripCases } from "./fixtures/roundtrip";

const stored = (ops: unknown[]) => JSON.stringify({ ops });

describe("Anchor round-trip fixtures", () => {
  for (const { name, ops, markdown } of roundTripCases) {
    it(`${name}: delta → markdown`, () => {
      expect(toMarkdown(stored(ops))).toBe(markdown);
    });
    it(`${name}: markdown → delta`, () => {
      expect(JSON.parse(toDelta(markdown)).ops).toEqual(ops);
    });
    it(`${name}: markdown → delta → markdown is stable`, () => {
      expect(toMarkdown(toDelta(markdown))).toBe(markdown);
    });
  }
});

describe("content edge cases", () => {
  it("empty content reads as empty markdown", () => {
    expect(toMarkdown(null)).toBe("");
    expect(toMarkdown("")).toBe("");
  });

  it("non-Delta content is returned as is", () => {
    expect(toMarkdown("plain old text")).toBe("plain old text");
  });

  it("checklist written by Claude becomes a real checklist", () => {
    expect(JSON.parse(toDelta("- [ ] buy milk\n- [x] pay rent\n")).ops).toEqual([
      { insert: "buy milk" },
      { insert: "\n", attributes: { list: "unchecked" } },
      { insert: "pay rent" },
      { insert: "\n", attributes: { list: "checked" } },
    ]);
  });
});

describe("appendMarkdown", () => {
  it("keeps the existing ops untouched, including ones markdown can't express", () => {
    const original = [
      { insert: "Title" },
      { insert: "\n", attributes: { header: 5 } }, // markdown would clamp this to ###
      { insert: { unknownEmbed: true } },
      { insert: "\n" },
    ];
    const ops = JSON.parse(appendMarkdown(stored(original), "**new**")).ops;
    expect(ops.slice(0, original.length)).toEqual(original);
    expect(ops.slice(original.length)).toEqual([{ insert: "new", attributes: { bold: true } }, { insert: "\n" }]);
  });

  it("adds a line break when the stored content lacks a trailing one", () => {
    const ops = JSON.parse(appendMarkdown(stored([{ insert: "a" }]), "b")).ops;
    expect(ops).toEqual([{ insert: "a" }, { insert: "\n" }, { insert: "b" }, { insert: "\n" }]);
  });

  it("works on empty and non-Delta notes", () => {
    expect(toMarkdown(appendMarkdown(null, "x"))).toBe("x\n");
    expect(toMarkdown(appendMarkdown("raw", "x"))).toBe("raw\nx\n");
  });
});
