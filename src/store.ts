import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export const dataDirectory = () =>
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode-peers")

/** One row per session OpenCode knows about, kept current from events. */
export interface SessionRow {
  id: string
  root_id: string
  parent_id: string | null
  project_id: string
  directory: string
  title: string
  busy: number
  archived: number
  updated: number
}

export interface FileRow {
  session_id: string
  root_id: string
  /** Empty outside git. */
  repo: string
  rel: string
  branch: string | null
  time: number
}

export interface PostRow {
  id: number
  board_id: string
  from_id: string
  from_title: string
  text: string
  time: number
}

const SCHEMA = `
create table if not exists meta (key text primary key, value text not null);

create table if not exists session (
  id text primary key,
  root_id text not null,
  parent_id text,
  project_id text not null default '',
  directory text not null default '',
  title text not null default '',
  busy integer not null default 0,
  archived integer not null default 0,
  updated integer not null default 0,
  -- Set once the one-time backfill has read this session's history.
  backfilled integer not null default 0
);
create index if not exists session_root on session (root_id);

-- Session titles, keyed by the session table's rowid so a rename replaces one row.
create virtual table if not exists title_fts using fts5 (text, tokenize = 'porter unicode61');

-- Searchable text: prompts, assistant text, compaction summaries and board posts.
-- ref holds the board ID for posts.
create virtual table if not exists doc using fts5 (
  text, session_id unindexed, root_id unindexed, kind unindexed, ref unindexed, time unindexed,
  tokenize = 'porter unicode61'
);

-- Files a session wrote. repo is the shared git directory, so worktrees of one repo compare equal.
create table if not exists file (
  session_id text not null,
  root_id text not null,
  repo text not null default '',
  rel text not null,
  branch text,
  time integer not null,
  primary key (session_id, rel, repo)
);
create index if not exists file_repo_rel on file (repo, rel);
create index if not exists file_root on file (root_id, time);

create table if not exists board (id text primary key, created integer not null);
create table if not exists member (
  board_id text not null,
  session_id text not null,
  joined integer not null,
  primary key (board_id, session_id)
) without rowid;
create index if not exists member_session on member (session_id);
create table if not exists post (
  id integer primary key,
  board_id text not null,
  from_id text not null,
  from_title text not null default '',
  text text not null,
  time integer not null
);
create index if not exists post_board on post (board_id, time);

-- Pairs of root sessions already told they write the same files.
create table if not exists notified (a text not null, b text not null, primary key (a, b)) without rowid;
`

export function open(file = path.join(dataDirectory(), "peers.db")) {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file, { create: true })
  db.run("pragma journal_mode = wal")
  db.run("pragma synchronous = normal")
  db.run("pragma busy_timeout = 5000")
  db.run(SCHEMA)
  return createStore(db)
}

export type Store = ReturnType<typeof createStore>

export function createStore(db: Database) {
  const q = {
    session: db.query<SessionRow, [string]>("select * from session where id = ?"),
    upsertSession: db.query(
      `insert into session (id, root_id, parent_id, project_id, directory, title, busy, archived, updated)
       values ($id, $root_id, $parent_id, $project_id, $directory, $title, $busy, $archived, $updated)
       on conflict (id) do update set
         root_id = excluded.root_id, parent_id = excluded.parent_id, project_id = excluded.project_id,
         directory = excluded.directory, title = excluded.title, busy = excluded.busy,
         archived = excluded.archived, updated = max(session.updated, excluded.updated)`,
    ),
    rowid: db.query<{ rowid: number }, [string]>("select rowid from session where id = ?"),
    deleteTitle: db.query("delete from title_fts where rowid = ?"),
    insertTitle: db.query("insert into title_fts (rowid, text) values (?, ?)"),
    insertDoc: db.query(
      "insert into doc (text, session_id, root_id, kind, ref, time) values (?, ?, ?, ?, ?, ?)",
    ),
    insertFile: db.query(
      `insert into file (session_id, root_id, repo, rel, branch, time) values (?, ?, ?, ?, ?, ?)
       on conflict do update set branch = excluded.branch, time = excluded.time`,
    ),
    boardsOf: db.query<{ board_id: string }, [string]>("select board_id from member where session_id = ?"),
    members: db.query<{ session_id: string }, [string]>(
      "select session_id from member where board_id = ? order by joined",
    ),
    isMember: db.query<{ n: number }, [string, string]>(
      "select count(*) n from member where board_id = ? and session_id = ?",
    ),
    addMember: db.query("insert or ignore into member (board_id, session_id, joined) values (?, ?, ?)"),
    removeMember: db.query("delete from member where board_id = ? and session_id = ?"),
    board: db.query<{ id: string }, [string]>("select id from board where id = ?"),
    insertBoard: db.query("insert into board (id, created) values (?, ?)"),
    insertPost: db.query<{ id: number }, [string, string, string, string, number]>(
      "insert into post (board_id, from_id, from_title, text, time) values (?, ?, ?, ?, ?) returning id",
    ),
    recentPosts: db.query<PostRow, [string, number]>(
      "select * from (select * from post where board_id = ? order by id desc limit ?) order by id",
    ),
    postsSince: db.query<{ n: number }, [string, number]>(
      "select count(*) n from post where board_id = ? and time > ?",
    ),
    lastPost: db.query<PostRow, [string]>("select * from post where board_id = ? order by id desc limit 1"),
    notified: db.query<{ n: number }, [string, string]>("select count(*) n from notified where a = ? and b = ?"),
    markNotified: db.query("insert or ignore into notified (a, b) values (?, ?)"),
    meta: db.query<{ value: string }, [string]>("select value from meta where key = ?"),
    setMeta: db.query("insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value"),
  }

  return {
    db,
    transaction: <T>(fn: () => T) => db.transaction(fn)(),

    session: (id: string) => q.session.get(id) ?? undefined,
    upsertSession(row: SessionRow) {
      q.upsertSession.run({
        $id: row.id,
        $root_id: row.root_id,
        $parent_id: row.parent_id,
        $project_id: row.project_id,
        $directory: row.directory,
        $title: row.title,
        $busy: row.busy,
        $archived: row.archived,
        $updated: row.updated,
      })
    },
    /** Updates some fields of a known session. Unknown sessions are ignored: session.created adds them. */
    patchSession(id: string, patch: Partial<Omit<SessionRow, "id">>) {
      const current = q.session.get(id)
      if (!current) return
      this.upsertSession({ ...current, ...patch })
    },
    removeSession(id: string) {
      const rowid = q.rowid.get(id)?.rowid
      if (rowid !== undefined) q.deleteTitle.run(rowid)
      db.query("delete from session where id = ?").run(id)
      db.query("delete from doc where session_id = ?").run(id)
      db.query("delete from file where session_id = ?").run(id)
      db.query("delete from member where session_id = ?").run(id)
    },
    setTitle(id: string, title: string) {
      const row = q.session.get(id)
      if (!row || row.title === title) return
      const rowid = q.rowid.get(id)!.rowid
      q.deleteTitle.run(rowid)
      if (title) q.insertTitle.run(rowid, title)
      this.upsertSession({ ...row, title })
    },
    addDoc(input: { text: string; sessionID: string; rootID: string; kind: string; ref?: string; time: number }) {
      q.insertDoc.run(input.text, input.sessionID, input.rootID, input.kind, input.ref ?? null, input.time)
    },
    addFile(row: FileRow) {
      q.insertFile.run(row.session_id, row.root_id, row.repo, row.rel, row.branch, row.time)
    },

    boardsOf: (sessionID: string) => q.boardsOf.all(sessionID).map((row) => row.board_id),
    members: (boardID: string) => q.members.all(boardID).map((row) => row.session_id),
    isMember: (boardID: string, sessionID: string) => (q.isMember.get(boardID, sessionID)?.n ?? 0) > 0,
    addMember: (boardID: string, sessionID: string, time: number) => q.addMember.run(boardID, sessionID, time),
    removeMember: (boardID: string, sessionID: string) => q.removeMember.run(boardID, sessionID),
    boardExists: (boardID: string) => q.board.get(boardID) !== null,
    createBoard(id: string, members: readonly string[], time: number) {
      q.insertBoard.run(id, time)
      for (const member of members) q.addMember.run(id, member, time)
    },
    /** The board whose members are exactly this set, if there is one. */
    boardWithMembers(members: readonly string[]): string | undefined {
      if (members.length === 0) return undefined
      const placeholders = members.map(() => "?").join(", ")
      const row = db
        .query<{ board_id: string }, string[]>(
          `select board_id from member
           where board_id in (select board_id from member where session_id = ?)
           group by board_id
           having count(*) = ${members.length} and sum(session_id in (${placeholders})) = ${members.length}
           limit 1`,
        )
        .get(members[0]!, ...members)
      return row?.board_id
    },
    addPost(input: { boardID: string; from: string; fromTitle: string; text: string; time: number }) {
      return q.insertPost.get(input.boardID, input.from, input.fromTitle, input.text, input.time)!.id
    },
    recentPosts: (boardID: string, limit: number) => q.recentPosts.all(boardID, limit),
    postsSince: (boardID: string, since: number) => q.postsSince.get(boardID, since)?.n ?? 0,
    lastPost: (boardID: string) => q.lastPost.get(boardID) ?? undefined,

    notified: (a: string, b: string) => (q.notified.get(a, b)?.n ?? 0) > 0,
    markNotified: (a: string, b: string) => q.markNotified.run(a, b),

    meta: (key: string) => q.meta.get(key)?.value,
    setMeta: (key: string, value: string) => q.setMeta.run(key, value),

    /** Drops search text and file rows older than the cutoff. Boards and posts are kept. */
    prune(before: number) {
      db.query("delete from doc where kind != 'post' and time < ?").run(before)
      db.query("delete from file where time < ?").run(before)
    },
  }
}
