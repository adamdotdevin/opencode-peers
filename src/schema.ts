// Output schemas, so Code Mode types the tools' results and hands back objects rather than JSON strings.

const text = { type: "string" } as const
const ref = {
  type: "object",
  properties: { id: text, title: text },
  required: ["id", "title"],
} as const

export const findOutput = {
  type: "object",
  properties: {
    you: ref,
    sessions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: text,
          title: text,
          state: { type: "string", enum: ["busy", "idle", "archived"] },
          active: { type: "string", description: "When it last worked, such as \"5m ago\"." },
          directory: text,
          branch: text,
          sameRepo: { type: "boolean" },
          files: { type: "array", items: text, description: "Files you both changed, or files matching the query." },
          snippet: { type: "string", description: "Matching text, with matches in «»." },
          subagents: { type: "array", items: ref, description: "Its running subagents. You can message them too." },
        },
        required: ["id", "title", "state", "active", "directory", "sameRepo"],
      },
    },
    boards: {
      type: "array",
      items: {
        type: "object",
        properties: { id: text, members: { type: "array", items: ref }, last: text },
        required: ["id", "members"],
      },
    },
  },
  required: ["you", "sessions", "boards"],
} as const

export const sendOutput = {
  type: "object",
  properties: {
    board: { type: "string", description: "Use this as `to` to keep talking to the same group." },
    delivered: {
      type: "array",
      items: {
        type: "object",
        properties: { id: text, title: text, how: text },
        required: ["id", "title", "how"],
      },
    },
    history: {
      type: "array",
      description: "The board's last posts, only when this post joined you to it.",
      items: {
        type: "object",
        properties: { from: text, title: text, text, time: text },
        required: ["from", "text", "time"],
      },
    },
  },
  required: ["board", "delivered"],
} as const
