import { Plugin } from "@opencode/plugin"
import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { backfill } from "./backfill.ts"
import { find, type FindOutput } from "./find.ts"
import { createIndexer, EVENT_TYPES, type Event } from "./indexer.ts"
import { headsUp } from "./overlap.ts"
import { send, type Api, type SendOutput } from "./send.ts"
import { dataDirectory, open, type Store } from "./store.ts"

export const ID = "peers"

const DAY = 86_400_000

interface Shared {
  store?: Store
  contexts: Plugin.Context[]
  subscription?: { ctx: Plugin.Context; controller: AbortController }
  queue: Event[]
  timers: ReturnType<typeof setInterval>[]
}

// The service loads one plugin instance per location. They share one database, event feed and index.
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
          if (error?._tag === "SessionNotFoundError") return undefined
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
  const apply = createIndexer(store)
  const current = () => state.contexts.at(-1) ?? ctx
  const { retentionDays, backfillDays } = settings(ctx.options)

  subscribe(state, ctx)

  let flushing = false
  const flush = async () => {
    if (flushing || state.queue.length === 0) return
    flushing = true
    try {
      const batch = state.queue.splice(0)
      const written = store.transaction(() => batch.flatMap((event) => apply(event)))
      if (written.length) await headsUp(store, api(current), written)
    } catch (error) {
      await log({ event: "error", where: "flush", error: String(error) }).catch(() => {})
    } finally {
      flushing = false
    }
  }
  const prune = () => store.prune(Date.now() - retentionDays * DAY)

  state.timers.push(setInterval(() => void flush(), 1_000), setInterval(prune, DAY))
  prune()
  void backfill(store, { days: backfillDays }).then(
    (result) => log({ event: "backfill", ...result }),
    (error) => log({ event: "error", where: "backfill", error: String(error) }),
  )
}

function stop(state: Shared) {
  state.subscription?.controller.abort()
  state.subscription = undefined
  for (const timer of state.timers) clearInterval(timer)
  state.timers = []
  state.queue = []
  state.store?.db.close()
  state.store = undefined
}

const json = (value: unknown) => ({ content: JSON.stringify(value, null, 1) })

export default Plugin.define({
  id: ID,
  async setup(ctx) {
    // Remote workspaces run their own sessions. This plugin connects the local service's.
    if (ctx.location.workspaceID !== undefined) return

    const state = shared()
    state.contexts.push(ctx)
    if (!state.store) start(state, ctx)
    const store = () => state.store!
    const peers = api(() => ctx)
    const options = () => settings(ctx.options)

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "peers",
        description:
          "Talk to the other OpenCode sessions on this machine. Find sessions working near you and message them or a group of them.",
      })
      editor.add({
        name: "find",
        description:
          "Find other sessions to coordinate with. With no query, lists live sessions near you: ones that changed the same files first, then ones in the same repo, then busy ones. With a query (a feature, file path, identifier or branch), searches their titles, prompts, replies and changed files. all: true includes archived sessions, for finding who built something. Also returns your own session ID and your boards. Check it before changing shared code, or when the user mentions another session's work.",
        input: {
          type: "object",
          properties: {
            query: { type: "string", description: "Words, a file path or an identifier. Omit to list sessions near you." },
            all: { type: "boolean", description: "Include archived sessions. Defaults to false." },
            limit: { type: "number", description: "Most sessions to return. Defaults to 8." },
          },
          additionalProperties: false,
        },
        options: { namespace: "peers", codemode: true, pinned: true },
        execute: async (input, context) =>
          json(find(store(), context.sessionID, (input ?? {}) as { query?: string; all?: boolean; limit?: number })),
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
        options: { namespace: "peers", codemode: true, pinned: true },
        execute: async (input, context) => {
          const { to, text } = input as { to: string | string[]; text: string }
          const result = await send(store(), peers, { sessionID: context.sessionID, to, text }, options())
          await log({ event: "post", from: context.sessionID, ...summary(result) })
          return json(result)
        },
      })
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "peers",
        description: "Post to a peers board or session as yourself, or see this session's boards",
        execute: async ({ sessionID, prompt }) => {
          const note = (text: string, description: string) =>
            ctx.session.synthetic({ sessionID, text, description, resume: false })
          const text = prompt.text.trim()
          if (!text) {
            const result = find(store(), sessionID, {})
            return void (await note(status(result), "peers · boards and sessions near this one"))
          }
          const [to = "", ...rest] = text.split(/\s+/)
          if (!/^(brd|ses)_/.test(to) || rest.length === 0)
            return void (await note("Usage: /peers <brd_… or ses_…> <message>, or /peers alone to see this session's boards.", "peers · usage"))
          try {
            const result = await send(store(), peers, { sessionID, user: true, to, text: text.slice(to.length).trim() }, options())
            await log({ event: "post", from: "user", ...summary(result) })
            const reached = result.delivered.map((entry) => `- ${entry.title || entry.id} (${entry.id}): ${entry.how}`)
            await note(`Posted to ${result.board}.\n${reached.join("\n")}`, `peers · posted to ${result.board}`)
          } catch (error) {
            await note(`Not sent: ${error instanceof Error ? error.message : String(error)}`, "peers · not sent")
          }
        },
      })
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

function status(result: FindOutput) {
  const lines = [`Peers for this session (${result.you.id})`]
  lines.push("", result.boards.length ? "Boards:" : "No boards yet.")
  for (const board of result.boards) {
    const members = board.members.map((member) => member.title || member.id).join(", ")
    lines.push(`- ${board.id}: ${members}${board.last ? `\n  Last: ${board.last}` : ""}`)
  }
  lines.push("", result.sessions.length ? "Sessions near this one:" : "No other live sessions.")
  for (const session of result.sessions) {
    const files = session.files?.length ? `, also changed ${session.files.join(", ")}` : ""
    lines.push(`- ${session.title || "(untitled)"} (${session.id}): ${session.state}, ${session.active}${session.branch ? `, ${session.branch}` : ""}${files}`)
  }
  return lines.join("\n")
}

