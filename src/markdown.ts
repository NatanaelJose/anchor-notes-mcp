import type { QuillOp } from "./vendor/anchor/editor";
import { parseDeltaOps } from "./vendor/anchor/delta-lines";
import { deltaToMarkdown } from "./vendor/anchor/delta-to-markdown";
import { markdownToDelta } from "./vendor/anchor/markdown-mapping";

/** Stored note content (Quill Delta JSON) as markdown. Non-Delta content comes back as is. */
export function toMarkdown(content: string | null | undefined): string {
  if (!content) return "";
  const ops = parseDeltaOps(content);
  return ops ? deltaToMarkdown(ops) : content;
}

/** Markdown as stored note content. */
export function toDelta(markdown: string): string {
  return JSON.stringify(markdownToDelta(markdown));
}

/**
 * Appends markdown at the Delta level, so the existing ops (and any format the
 * markdown bridge can't express) stay untouched.
 */
export function appendMarkdown(content: string | null | undefined, markdown: string): string {
  const added = markdownToDelta(markdown).ops;
  if (!content) return JSON.stringify({ ops: added });
  const ops: QuillOp[] = parseDeltaOps(content) ?? [{ insert: content }];
  const last = ops[ops.length - 1];
  const endsWithBreak = typeof last?.insert === "string" && last.insert.endsWith("\n");
  return JSON.stringify({ ops: [...ops, ...(endsWithBreak ? [] : [{ insert: "\n" }]), ...added] });
}
