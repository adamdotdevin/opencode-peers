# opencode-peers

An OpenCode plugin that lets sessions on one machine find each other and talk.

An agent about to change a file can check which other sessions touched it, ask one of them a question, or open a group with several. Messages land in the recipient's transcript at its next step, and idle sessions wake up to answer.

## Tools

Agents get two tools in Code Mode, under `peers`:

- `peers.find({ query?, all?, limit? })` lists other sessions. With no query, sessions that changed the same files as you come first, then sessions in the same repo, then busy ones. With a query, it searches titles, prompts, replies, compaction summaries, board posts and changed file paths. Archived sessions show up only with `all: true`.
- `peers.send({ to, text })` sends a message. `to` can be a session ID, a list of session IDs, or a board ID (`brd_…`). A list of IDs opens a board with exactly those sessions plus you, or reuses one that already exists, so a direct message is a board with two members. Posting to a board you're not on adds you to it, and the reply includes the last 20 posts.

## Delivery

- A busy session gets the message at its next step. An idle session wakes up.
- A post to a board ID wakes its members, except archived ones. Archived members see the post if they run again.
- Naming an archived session wakes it.
- A session that would be woken but whose directory is gone, such as a merged worktree, isn't woken. `send` says so.
- A message for a subagent that has finished goes to its nearest live parent.
- One send names at most 8 sessions.
- A board accepts 20 posts per 10 minutes. After that, `send` fails and tells the agent to stop and report to you.

The message reaches the model wrapped in a `<peer-message-…>` tag with a random suffix, so the text inside can't close the tag or fake another one. The tag says who sent it and that it came from another session, not from you.

## You

- `/peers` shows this session's boards and the sessions near it.
- `/peers <brd_… or ses_…> <message>` posts as you. Every member of the board gets it. Posting to a board doesn't add the session you typed in to it.
- When a session writes a file that another live session changed in the last day, in any worktree of the same repo, the writing session gets a one-line note. This happens once per pair of sessions.

## Search index

The index lives at `~/.local/share/opencode-peers/peers.db`. It's a SQLite database, using FTS5 for full-text search, fed from OpenCode's event stream.

- It stores prompts, assistant text, compaction summaries, board posts and the paths of files written with `edit`, `write` and `patch`.
- It skips tool output, file contents and reasoning.
- The directory is owner-only, like OpenCode's own database.
- On first start, it backfills the last 30 days from `~/.local/share/opencode/opencode.db`, read-only. That took under a minute for 5,700 sessions and made a 73 MB index.

`log.jsonl` in the same directory has a line for every post.

## Options

```jsonc
{
  "plugins": [
    { "package": "/Users/adam/code/opencode-peers", "options": { "postsPer10Min": 20, "retentionDays": 30, "backfillDays": 30 } }
  ]
}
```

The first location to load the plugin starts the shared database and event feed, and the last one to unload stops them. Editing any source file restarts them on the next reload.

## Develop

```sh
bun install
bun test
bun run typecheck
```
