import { locate, writtenPaths } from "./repo.ts"
import type { Store } from "./store.ts"

/** The event types the index listens to. Deltas and tool output never reach the plugin. */
export const EVENT_TYPES = [
  "session.created",
  "session.renamed",
  "session.moved",
  "session.archived",
  "session.unarchived",
  "session.deleted",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.inbox.enqueued",
  "session.text.ended",
  "session.compaction.ended",
  "session.forked",
] as const

/** Not an OpenCode event: the plugin queues one when an edit, write or patch call succeeds. */
export const WRITE = "peers.write"

export interface Event {
  readonly type: string
  readonly data: Record<string, any>
}

/** A file a session just wrote, for the overlap heads-up. */
export interface Written {
  sessionID: string
  rootID: string
  repo: string
  rel: string
}

export const PROMPT_LIMIT = 8_000
export const TEXT_LIMIT = 4_000

export const WRITE_TOOLS = new Set(["edit", "write", "patch"])

export const clip = (text: string, limit: number) => (text.length > limit ? text.slice(0, limit) : text)

export function createIndexer(store: Store) {
  return function apply(event: Event, time = Date.now()): Written[] {
    const data = event.data
    const id: string = data.sessionID
    switch (event.type) {
      case "session.created": {
        const parent = data.parentID ? store.session(data.parentID) : undefined
        store.upsertSession({
          id,
          root_id: parent?.root_id ?? data.parentID ?? id,
          parent_id: data.parentID ?? null,
          directory: data.location?.directory ?? "",
          title: "",
          busy: 0,
          archived: 0,
          updated: time,
        })
        if (data.title) store.setTitle(id, data.title)
        return []
      }
      case "session.forked": {
        // A fork is a new root in its source's directory. Its title arrives with a rename or the next header copy.
        const source = store.session(data.parentID)
        store.upsertSession({
          id,
          root_id: id,
          parent_id: null,
          directory: source?.directory ?? "",
          title: "",
          busy: 0,
          archived: 0,
          updated: time,
        })
        return []
      }
      case "session.renamed":
        store.setTitle(id, data.title)
        return []
      case "session.moved":
        store.patchSession(id, { directory: data.location?.directory, updated: time })
        return []
      case "session.archived":
        store.patchSession(id, { archived: 1, busy: 0 })
        return []
      case "session.unarchived":
        store.patchSession(id, { archived: 0, updated: time })
        return []
      case "session.deleted":
        store.removeSession(id)
        return []
      case "session.execution.started":
        store.patchSession(id, { busy: 1, updated: time })
        return []
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        store.patchSession(id, { busy: 0, updated: time })
        return []
    }

    const session = store.session(id)
    if (!session) return []
    const doc = (text: string, kind: string, limit: number) => {
      const trimmed = text.trim()
      if (trimmed) store.addDoc({ text: clip(trimmed, limit), sessionID: id, rootID: session.root_id, kind, time })
    }

    switch (event.type) {
      case "session.inbox.enqueued":
        if (data.item?.type === "user" && typeof data.item.payload?.text === "string")
          doc(data.item.payload.text, "prompt", PROMPT_LIMIT)
        return []
      case "session.text.ended":
        doc(data.text ?? "", "text", TEXT_LIMIT)
        return []
      case "session.compaction.ended":
        doc(data.text ?? "", "summary", PROMPT_LIMIT)
        return []
      case WRITE:
        return recordWrites(store, session, data.tool, data.input ?? {}, time)
    }
    return []
  }
}

export function recordWrites(
  store: Store,
  session: { id: string; root_id: string; directory: string },
  tool: string,
  input: Record<string, unknown>,
  time: number,
): Written[] {
  const written: Written[] = []
  for (const file of writtenPaths(tool, input)) {
    const where = locate(file, session.directory || "/")
    store.addFile({
      session_id: session.id,
      root_id: session.root_id,
      repo: where.repo ?? "",
      rel: where.rel,
      branch: where.branch ?? null,
      time,
    })
    if (where.repo) written.push({ sessionID: session.id, rootID: session.root_id, repo: where.repo, rel: where.rel })
  }
  return written
}
