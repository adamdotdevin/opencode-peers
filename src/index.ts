import { Plugin } from "@opencode/plugin"
import { readdirSync, readFileSync } from "node:fs"
import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { backfill } from "./backfill.ts"
import { find, list } from "./find.ts"
import { createIndexer, EVENT_TYPES, WRITE, WRITE_TOOLS, type Event } from "./indexer.ts"
import { headsUp } from "./overlap.ts"
import { Peers } from "./rpc.ts"
import { findOutput, sendOutput } from "./schema.ts"
import { send, type Api, type SendOutput } from "./send.ts"
import { dataDirectory, open, type Store } from "./store.ts"

export const ID = "peers"

const DAY = 86_400_000

/**
 * A hash of this plugin's source, so editing any file replaces the running shared state on the next reload. Every
 * location imports its own copy of the module, and the same files give every copy the same hash.
 */
const RUNTIME = String(
  Bun.hash(
    readdirSync(import.meta.dir)
      .sort()
      .map((file) => readFileSync(path.join(import.meta.dir, file), "utf8"))
      .join("\0"),
  ),
)

interface Shared {
  runtime?: string
  stopped?: AbortController
  store?: Store
  contexts: Plugin.Context[]
  subscription?: { ctx: Plugin.Context; controller: AbortController }
  queue: Event[]
  timers: ReturnType<typeof setInterval>[]
}

// The service loads one plugin instance per location, each from its own copy of this module. They share one
// database, event feed and index, started by the first and stopped by the last.
const shared = (): Shared => {
  const store = globalThis as unknown as Record<symbol, Shared | undefined>
  return (store[Symbol.for(`opencode.${ID}`)] ??= { contexts: [], queue: [], timers: [] })
}

const number = (value: unknown, fallback: number) => (typeof value === "number" && value > 0 ? value : fallback)

export function settings(options: Record<string, unknown>) {
  return {
    postsPer10Min: number(options.postsPer10Min, 20),
    retentionDays: number(options.retentionDays, 30),
    backfillDays: number(options.backfillDays, 30),
  }
}

export async function log(entry: Record<string, unknown>) {
  const dir = dataDirectory()
  await mkdir(dir, { recursive: true })
  await appendFile(path.join(dir, "log.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
}

const api = (current: () => Plugin.Context): Api => ({
  get: (sessionID) =>
    current()
      .session.get({ sessionID: sessionID as never })
      .then(
        (session) => session,
        (error) => {
          // In process, the core error arrives as is: "Session.NotFoundError", not the HTTP "SessionNotFoundError".
          if (error?._tag === "Session.NotFoundError") return undefined
          throw error
        },
      ),
  synthetic: (input) => current().session.synthetic({ ...input, sessionID: input.sessionID as never }),
})

function subscribe(state: Shared, ctx: Plugin.Context) {
  const controller = new AbortController()
  state.subscription = { ctx, controller }
  void (async () => {
    for await (const event of ctx.event.subscribe({ types: [...EVENT_TYPES], signal: controller.signal }))
      state.queue.push(event as unknown as Event)
  })().catch((error) => {
    if (!controller.signal.aborted) void log({ event: "error", where: "subscribe", error: String(error) })
  })
}

function start(state: Shared, ctx: Plugin.Context) {
  const store = open()
  state.store = store
  state.runtime = RUNTIME
  state.stopped = new AbortController()
  const apply = createIndexer(store)
  const current = () => state.contexts.at(-1) ?? ctx
  const { retentionDays, backfillDays } = settings(ctx.options)

  subscribe(state, ctx)

  const flush = () => {
    if (state.queue.length === 0) return
    try {
      const batch = state.queue.splice(0)
      const written = store.transaction(() => batch.flatMap((event) => apply(event)))
      if (written.length)
        void headsUp(store, api(current), written).catch((error) => log({ event: "error", where: "headsUp", error: String(error) }))
    } catch (error) {
      void log({ event: "error", where: "flush", error: String(error) }).catch(() => {})
    }
  }
  const prune = () => store.prune(Date.now() - retentionDays * DAY)

  state.timers.push(setInterval(flush, 1_000), setInterval(prune, DAY))
  prune()
  void backfill(store, { days: backfillDays, signal: state.stopped.signal }).then(
    (result) => log({ event: "backfill", ...result }),
    (error) => log({ event: "error", where: "backfill", error: String(error) }),
  )
}

function stop(state: Shared) {
  state.stopped?.abort()
  state.subscription?.controller.abort()
  state.subscription = undefined
  for (const timer of state.timers) clearInterval(timer)
  state.timers = []
  state.queue = []
  state.store?.db.close()
  state.store = undefined
}

export default Plugin.define({
  id: ID,
  async setup(ctx) {
    // Remote workspaces run their own sessions. This plugin connects the local service's.
    if (ctx.location.workspaceID !== undefined) return

    const state = shared()
    if (state.runtime !== RUNTIME) stop(state)
    state.contexts.push(ctx)
    if (!state.store) start(state, ctx)
    const store = () => state.store!
    const peers = api(() => ctx)
    const options = () => settings(ctx.options)

    // Successful writes only: a rejected or failed edit didn't change the file.
    await ctx.tool.hook("execute.after", (event) => {
      if (event.status === "completed" && WRITE_TOOLS.has(event.tool) && state.store)
        state.queue.push({ type: WRITE, data: { sessionID: event.sessionID, tool: event.tool, input: event.input } })
    })

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "peers",
        description:
          "Talk to the other OpenCode sessions on this machine. Find sessions working near you and message them or a group of them.",
      })
      editor.add({
        name: "find",
        description:
          "Find other sessions to coordinate with. With no query, lists live sessions near you: ones that changed the same files first, then ones in the same repo, then busy ones. With a query (a feature, file path or identifier), searches their titles, prompts, replies and changed files. all: true includes archived sessions, for finding who built something. Also returns your own session ID and your boards. Check it before changing shared code, or when the user mentions another session's work.",
        input: {
          type: "object",
          properties: {
            query: { type: "string", description: "Words, a file path or an identifier. Omit to list sessions near you." },
            all: { type: "boolean", description: "Include archived sessions. Defaults to false." },
            limit: { type: "number", description: "Most sessions to return. Defaults to 8." },
          },
          additionalProperties: false,
        },
        output: findOutput,
        options: { namespace: "peers", codemode: true, pinned: true },
        execute: async (input, context) => ({
          output: find(store(), context.sessionID, (input ?? {}) as { query?: string; all?: boolean; limit?: number }),
        }),
      })
      editor.add({
        name: "send",
        description:
          "Message other sessions. to is a session ID, a list of session IDs (starts or reuses a group with exactly those sessions and you), or a board ID (brd_…) to post to that group, which also joins it. Recipients see it at their next step, and idle ones wake up. Replies arrive on their own as peer messages, so don't wait or poll. Keep it short and say whether you need an answer.",
        input: {
          type: "object",
          properties: {
            to: {
              description: "A session ID (ses_…), a list of session IDs, or a board ID (brd_…).",
              anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
            },
            text: { type: "string", description: "The message." },
          },
          required: ["to", "text"],
          additionalProperties: false,
        },
        output: sendOutput,
        options: { namespace: "peers", codemode: true, pinned: true },
        execute: async (input, context) => {
          const { to, text } = input as { to: string | string[]; text: string }
          const result = await send(store(), peers, { sessionID: context.sessionID, to, text }, options())
          void log({ event: "post", from: context.sessionID, ...summary(result) }).catch(() => {})
          return { output: result }
        },
      })
    })

    // The TUI part (src/tui.ts) reads and posts through these for its /peers picker.
    await ctx.rpc.register(Peers, {
      list: async (input) => {
        const { sessionID } = (input ?? {}) as { sessionID?: string }
        return list(store(), sessionID)
      },
      post: async (input) => {
        const { board, text } = input as { board: string; text: string }
        if (!store().boardExists(board)) throw new Error(`No group ${board}`)
        const result = await send(store(), peers, { sessionID: "user", user: true, to: board, text }, options())
        void log({ event: "post", from: "user", ...summary(result) }).catch(() => {})
        return { delivered: result.delivered }
      },
    })

    return () => {
      state.contexts = state.contexts.filter((item) => item !== ctx)
      if (state.contexts.length === 0) return stop(state)
      if (state.subscription?.ctx === ctx) {
        state.subscription.controller.abort()
        subscribe(state, state.contexts.at(-1)!)
      }
    }
  },
})

const summary = (result: SendOutput) => ({
  board: result.board,
  to: result.delivered.map((entry) => ({ id: entry.id, how: entry.how })),
})
