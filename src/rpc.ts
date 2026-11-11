import { Rpc } from "@opencode/plugin/rpc"

const text = { type: "string" } as const

export const Peers = Rpc.define({
  id: "peers",
  methods: {
    /** Boards with recent posts and live sessions, ranked near the given session when there is one. */
    list: {
      input: { type: "object", properties: { sessionID: text }, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          boards: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: text,
                members: { type: "array", items: text },
                last: {
                  type: "object",
                  properties: { from: text, active: text, text },
                  required: ["from", "active", "text"],
                },
              },
              required: ["id", "members"],
            },
          },
          sessions: {
            type: "array",
            items: {
              type: "object",
              properties: { id: text, title: text, state: text, active: text, where: text },
              required: ["id", "title", "state", "active", "where"],
            },
          },
        },
        required: ["boards", "sessions"],
      },
    },
    /** Posts to a board as the user. */
    post: {
      input: {
        type: "object",
        properties: { board: text, text },
        required: ["board", "text"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          delivered: {
            type: "array",
            items: { type: "object", properties: { id: text, title: text, how: text }, required: ["id", "title", "how"] },
          },
        },
        required: ["delivered"],
      },
      errors: {
        not_found: { type: "object", properties: { board: text }, required: ["board"], additionalProperties: false },
      },
    },
  },
  events: {},
})

export interface ListOutput {
  boards: { id: string; members: string[]; last?: { from: string; active: string; text: string } }[]
  sessions: { id: string; title: string; state: string; active: string; where: string }[]
}

export interface PostOutput {
  delivered: { id: string; title: string; how: string }[]
}
