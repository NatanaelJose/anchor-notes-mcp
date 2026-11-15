// Values the copied Anchor files import from Anchor internals, inlined.
// Source (commit dfa65c80cc917642af2edb4be947dfb925049c44):
//   web/features/notes/quill.ts (types), web/features/notes/quill-lines.ts (MAX_LIST_INDENT),
//   web/lib/design/tokens.ts (HIGHLIGHTS). AGPL-3.0.

export type QuillOp = {
  insert?: unknown;
  delete?: number;
  retain?: number;
  attributes?: Record<string, unknown>;
};

export type QuillDelta = { ops: QuillOp[] };

export const MAX_LIST_INDENT = 3;

export const HIGHLIGHTS = ["yellow", "green", "blue", "pink", "purple"] as const;
