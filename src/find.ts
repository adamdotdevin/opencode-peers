import { branchOf, repoOf } from "./repo.ts"
import type { SessionRow, Store } from "./store.ts"

export interface FindInput {
  query?: string
  all?: boolean
  limit?: number
}

export interface Card {
  id: string
  title: string
  state: "busy" | "idle" | "archived"
  active: string
  directory: string
  branch?: string
  sameRepo: boolean
  /** Files you both wrote, or files matching the query. */
  files?: string[]
  snippet?: string
  /** Subagents of this session that are running now. You can message them too. */
  subagents?: { id: string; title: string }[]
}

export interface BoardCard {
  id: string
  members: { id: string; title: string }[]
  last?: string
}

export interface FindOutput {
  you: { id: string; title: string }
  sessions: Card[]
  boards: BoardCard[]
}

export const ago = (time: number, now = Date.now()) => {
  const minutes = Math.max(0, Math.round((now - time) / 60_000))
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** Words from free text, quoted so paths and punctuation never break FTS5 syntax. */
export function terms(query: string) {
  return (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).map((word) => `"${word}"`)
}

interface Hit {
  score: number
  /** The newest matching text, which says when the session last worked on this. */
  time?: number
  snippet?: string
  files: Set<string>
}

const DAY = 86_400_000

export function find(store: Store, callerID: string, input: FindInput, now = Date.now()): FindOutput {
  const db = store.db
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 30)
  const caller = store.session(callerID)
  const callerRoot = caller?.root_id ?? callerID

  const mine = db
    .query<{ repo: string; rel: string }, [string]>("select distinct repo, rel from file where root_id = ? and repo != ''")
    .all(callerRoot)
  const mineKeys = new Set(mine.map((file) => `${file.repo}\0${file.rel}`))
  const repos = new Set(mine.map((file) => file.repo))
  const ownRepo = caller ? repoOf(caller.directory) : undefined
  if (ownRepo) repos.add(ownRepo)

  const hits = new Map<string, Hit>()
  const hit = (root: string) => {
    let entry = hits.get(root)
    if (!entry) hits.set(root, (entry = { score: 0, files: new Set() }))
    return entry
  }
  const matchedBoards = new Set<string>()

  const query = input.query?.trim()
  if (query) {
    const words = terms(query)
    // Only sessions find can return count toward the limits, so archived text can't crowd out live sessions.
    const all = input.all ? 1 : 0
    const search = (match: string) => {
      const docs = db
        .query<
          { root_id: string; kind: string; ref: string | null; time: number; score: number; snip: string },
          [string, string, number]
        >(
          `select doc.root_id, doc.kind, doc.ref, doc.time, bm25(doc) score, snippet(doc, 0, '«', '»', '…', 16) snip
           from doc left join session r on r.id = doc.root_id
           where doc match ? and (doc.kind = 'post' or (doc.root_id != ? and (? or r.archived = 0)))
           order by score limit 300`,
        )
        .all(match, callerRoot, all)
      const titles = db
        .query<{ root_id: string; score: number }, [string, string, number]>(
          `select s.root_id, bm25(title_fts) score
           from title_fts join session s on s.rowid = title_fts.rowid join session r on r.id = s.root_id
           where title_fts match ? and s.root_id != ? and (? or r.archived = 0) order by score limit 200`,
        )
        .all(match, callerRoot, all)
      return { docs, titles }
    }
    let found = words.length ? search(words.join(" ")) : { docs: [], titles: [] }
    if (words.length > 1 && found.docs.length + found.titles.length === 0) found = search(words.join(" OR "))

    // A root's text score is the sum of its best three chunks.
    const counted = new Map<string, number>()
    for (const doc of found.docs) {
      if (doc.kind === "post" && doc.ref) matchedBoards.add(doc.ref)
      if (doc.kind === "post") continue
      const matched = hit(doc.root_id)
      matched.time = Math.max(matched.time ?? 0, doc.time)
      const seen = counted.get(doc.root_id) ?? 0
      if (seen >= 3) continue
      counted.set(doc.root_id, seen + 1)
      const entry = hit(doc.root_id)
      entry.score += -doc.score
      entry.snippet ??= doc.snip
    }
    for (const title of found.titles) hit(title.root_id).score += -title.score * 3

    if (/[/.]/.test(query)) {
      const files = db
        .query<{ root_id: string; rel: string }, [string, number, string]>(
          `select f.root_id, f.rel from file f join session r on r.id = f.root_id
           where f.root_id != ? and (? or r.archived = 0) and f.rel like '%' || ? || '%' order by f.time desc limit 300`,
        )
        .all(callerRoot, all, query.replace(/^\.?\//, ""))
      for (const file of files) {
        const entry = hit(file.root_id)
        if (entry.files.size === 0) entry.score += 10
        entry.files.add(file.rel)
      }
    }
  } else {
    const recent = db
      .query<{ id: string }, [number]>(
        `select id from session where parent_id is null and (? or archived = 0) order by updated desc limit 200`,
      )
      .all(input.all ? 1 : 0)
    for (const row of recent) hit(row.id)
  }

  const filesOf = db.query<{ repo: string; rel: string }, [string]>(
    "select distinct repo, rel from file where root_id = ? order by time desc limit 500",
  )
  const latestBranch = db.query<{ branch: string | null }, [string]>(
    "select branch from file where root_id = ? and branch is not null order by time desc limit 1",
  )
  const runningSubagents = db.query<{ id: string; title: string }, [string]>(
    "select id, title from session where root_id = ? and id != root_id and busy = 1 order by updated desc limit 5",
  )

  const cards: { card: Card; rank: number[] }[] = []
  for (const [root, entry] of hits) {
    if (root === callerRoot) continue
    const row = store.session(root)
    if (!row || row.parent_id) continue
    if (row.archived && !input.all) continue
    const files = filesOf.all(root)
    const overlap = files.filter((file) => mineKeys.has(`${file.repo}\0${file.rel}`)).map((file) => file.rel)
    const sameRepo = files.some((file) => repos.has(file.repo)) || (repoOf(row.directory) ?? "\0") === ownRepo
    const subagents = runningSubagents.all(root)
    const busy = row.busy === 1 || subagents.length > 0
    // Archiving bumps a session's updated time, so archived sessions age by their newest matching text instead.
    const last = row.archived && entry.time ? entry.time : row.updated
    const card = toCard(row, {
      last,
      busy,
      sameRepo,
      branch: latestBranch.get(root)?.branch ?? branchOf(row.directory),
      files: overlap.length ? overlap.slice(0, 5) : [...entry.files].slice(0, 5),
      snippet: entry.snippet,
      subagents,
      now,
    })
    const rank = query
      ? [
          entry.score *
            Math.max(0.2, 0.5 ** ((now - last) / (7 * DAY))) *
            (sameRepo ? 1.5 : 1) *
            (busy ? 1.3 : 1) *
            (overlap.length ? 2 : 1),
        ]
      : [overlap.length, sameRepo ? 1 : 0, busy ? 1 : 0, row.updated]
    cards.push({ card, rank })
  }
  cards.sort((a, b) => {
    for (let i = 0; i < a.rank.length; i++) if (a.rank[i] !== b.rank[i]) return b.rank[i]! - a.rank[i]!
    return 0
  })

  const boardIDs = [...new Set([...store.boardsOf(callerID), ...matchedBoards])]
  return {
    you: { id: callerID, title: caller?.title ?? "" },
    sessions: cards.slice(0, limit).map((entry) => entry.card),
    boards: boardIDs.slice(0, 10).map((id) => boardCard(store, id, now)),
  }
}

function toCard(
  row: SessionRow,
  extra: {
    last: number
    busy: boolean
    sameRepo: boolean
    branch?: string
    files: string[]
    snippet?: string
    subagents: { id: string; title: string }[]
    now: number
  },
): Card {
  return {
    id: row.id,
    title: row.title,
    state: row.archived ? "archived" : extra.busy ? "busy" : "idle",
    active: ago(extra.last, extra.now),
    directory: row.directory,
    ...(extra.branch ? { branch: extra.branch } : {}),
    sameRepo: extra.sameRepo,
    ...(extra.files.length ? { files: extra.files } : {}),
    ...(extra.snippet ? { snippet: extra.snippet } : {}),
    ...(extra.subagents.length ? { subagents: extra.subagents } : {}),
  }
}

const who = (post: { from_id: string; from_title: string }) =>
  post.from_id === "user" ? "user" : `${post.from_title || post.from_id} (${post.from_id})`

export function boardCard(store: Store, id: string, now = Date.now()): BoardCard {
  const last = store.lastPost(id)
  return {
    id,
    members: store.members(id).map((member) => ({ id: member, title: store.session(member)?.title ?? "" })),
    ...(last ? { last: `${who(last)} (${ago(last.time, now)}): ${last.text.slice(0, 160)}` } : {}),
  }
}
