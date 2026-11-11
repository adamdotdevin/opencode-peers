import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { clip, PROMPT_LIMIT, recordWrites, TEXT_LIMIT } from "./indexer.ts"
import type { Store } from "./store.ts"

// This is the one module that reads OpenCode's own database. It only reads, and if the schema moves it throws,
// the caller logs it, and the live index carries on.

export const openCodeDatabase = () =>
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode", "opencode.db")

interface Header {
  id: string
  parent_id: string | null
  directory: string
  title: string | null
  time_updated: number
  time_busy: number | null
  time_idle: number | null
  time_archived: number | null
}

/** Copies every session's header into the index. Cheap (a few thousand rows), so it runs at each start. */
export function headers(source: Database, store: Store) {
  const rows = source
    .query<Header, []>(
      "select id, parent_id, directory, title, time_updated, time_busy, time_idle, time_archived from session_v2",
    )
    .all()
  const parents = new Map(rows.map((row) => [row.id, row.parent_id]))
  const root = (id: string) => {
    let current = id
    for (let parent = parents.get(current); parent; parent = parents.get(current)) current = parent
    return current
  }
  store.transaction(() => {
    for (const row of rows) {
      const existing = store.session(row.id)
      store.upsertSession({
        id: row.id,
        root_id: root(row.id),
        parent_id: row.parent_id,
        directory: row.directory,
        title: existing?.title ?? "",
        busy: row.time_busy !== null && (row.time_idle === null || row.time_busy > row.time_idle) ? 1 : 0,
        archived: row.time_archived === null ? 0 : 1,
        updated: row.time_updated,
      })
      store.setTitle(row.id, row.title ?? "")
    }
  })
  return rows.length
}

interface Message {
  type: string
  time_created: number
  data: string
}

/**
 * Indexes the recent prompts, text and file writes of sessions updated in the window, newest first, in small slices
 * so the service stays responsive. Only messages from before `until` are read: later ones came in as live events.
 */
export async function content(
  source: Database,
  store: Store,
  options: { since: number; until: number; slice?: number; pause?: number; signal?: AbortSignal },
) {
  const done = new Set(
    store.db.query<{ id: string }, []>("select id from session where backfilled = 1").all().map((row) => row.id),
  )
  const ids = source
    .query<{ id: string }, [number]>("select id from session_v2 where time_updated > ? order by time_updated desc")
    .all(options.since)
    .map((row) => row.id)
    .filter((id) => !done.has(id))
  const mark = store.db.query("update session set backfilled = 1 where id = ?")
  const messages = source.query<Message, [string, number, number, string, number, number]>(
    `select type, time_created, data from (
       select type, seq, time_created, data from session_message
       where session_id = ? and type in ('user', 'compaction') and time_created between ? and ? order by seq desc limit 20
     ) union all select type, time_created, data from (
       select type, seq, time_created, data from session_message
       where session_id = ? and type = 'assistant' and time_created between ? and ? order by seq desc limit 25
     )`,
  )
  // Each slice blocks the shared service while it parses, so keep it to a few sessions.
  const slice = options.slice ?? 10
  for (let start = 0; start < ids.length; start += slice) {
    if (options.signal?.aborted) return start
    store.transaction(() => {
      for (const id of ids.slice(start, start + slice)) {
        const session = store.session(id)
        if (!session) continue
        for (const message of messages.all(id, options.since, options.until, id, options.since, options.until))
          indexMessage(store, session, message)
        mark.run(id)
      }
    })
    await Bun.sleep(options.pause ?? 50)
  }
  return ids.length
}

function indexMessage(store: Store, session: { id: string; root_id: string; directory: string }, message: Message) {
  const data = JSON.parse(message.data)
  const add = (text: unknown, kind: string, limit: number) => {
    if (typeof text !== "string" || !text.trim()) return
    store.addDoc({
      text: clip(text.trim(), limit),
      sessionID: session.id,
      rootID: session.root_id,
      kind,
      time: message.time_created,
    })
  }
  if (message.type === "user") return add(data.text, "prompt", PROMPT_LIMIT)
  if (message.type === "compaction") return add(data.summary, "summary", PROMPT_LIMIT)
  for (const part of data.content ?? []) {
    if (part.type === "text") add(part.text, "text", TEXT_LIMIT)
    if (part.type === "tool" && part.state?.status === "completed" && part.state.input) recordWrites(store, session, part.name, part.state.input, message.time_created)
  }
}

/**
 * Runs the header copy, then the one-time content backfill if it hasn't finished. An interrupted backfill resumes
 * where it stopped, with the same cutoff, so nothing is indexed twice.
 */
export async function backfill(
  store: Store,
  options: { file?: string; days: number; now?: number; signal?: AbortSignal },
) {
  const file = options.file ?? openCodeDatabase()
  if (!existsSync(file)) return { sessions: 0, indexed: 0 }
  const source = new Database(file, { readonly: true })
  try {
    const sessions = headers(source, store)
    if (store.meta("backfill") === "done") return { sessions, indexed: 0 }
    const until = Number(store.meta("backfill.until") ?? options.now ?? Date.now())
    store.setMeta("backfill.until", String(until))
    const since = until - options.days * 86_400_000
    const indexed = await content(source, store, { since, until, signal: options.signal })
    if (options.signal?.aborted) return { sessions, indexed }
    store.setMeta("backfill", "done")
    return { sessions, indexed }
  } finally {
    source.close()
  }
}
