import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import path from "node:path"

/** Where a file lives in git terms, so two worktrees of one repo compare equal. */
export interface Located {
  /** The repo's shared git directory, the same for every worktree. Undefined outside git. */
  repo?: string
  /** Path inside the worktree, or the absolute path outside git. */
  rel: string
  branch?: string
}

interface Checkout {
  repo: string
  root: string
  gitdir: string
}

const checkouts = new Map<string, Checkout | null>()

function checkout(directory: string): Checkout | null {
  const cached = checkouts.get(directory)
  if (cached !== undefined) return cached
  let found: Checkout | null = null
  const dotgit = path.join(directory, ".git")
  if (existsSync(dotgit)) {
    if (statSync(dotgit).isDirectory()) found = { repo: realpathSync(dotgit), root: directory, gitdir: dotgit }
    else {
      // A linked worktree: ".git" is a file pointing at <repo>/.git/worktrees/<name>.
      const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, "utf8"))
      // A worktree whose repo was deleted counts as outside git.
      if (match && existsSync(path.resolve(directory, match[1]!.trim()))) {
        const gitdir = path.resolve(directory, match[1]!.trim())
        const common = path.join(gitdir, "commondir")
        const repo = existsSync(common)
          ? path.resolve(gitdir, readFileSync(common, "utf8").trim())
          : path.dirname(path.dirname(gitdir))
        found = { repo: realpathSync(repo), root: directory, gitdir }
      }
    }
  } else {
    const parent = path.dirname(directory)
    found = parent === directory ? null : checkout(parent)
  }
  checkouts.set(directory, found)
  return found
}

function branch(gitdir: string) {
  try {
    const head = readFileSync(path.join(gitdir, "HEAD"), "utf8").trim()
    return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : undefined
  } catch {
    return undefined
  }
}

/** Locates an absolute file path, or a path relative to the session's directory. */
export function locate(file: string, base: string): Located {
  const absolute = path.resolve(base, file)
  const found = checkout(path.dirname(absolute))
  if (!found) return { rel: absolute }
  return {
    repo: found.repo,
    rel: path.relative(found.root, absolute),
    branch: branch(found.gitdir),
  }
}

/** The branch checked out in the worktree holding a directory, if any. */
export function branchOf(directory: string) {
  const found = checkout(directory)
  return found ? branch(found.gitdir) : undefined
}

/** The repo a directory belongs to, if any. */
export const repoOf = (directory: string) => checkout(directory)?.repo

/** File paths a write, edit or patch call touches. */
export function writtenPaths(tool: string, input: Record<string, unknown>): string[] {
  if ((tool === "edit" || tool === "write") && typeof input.path === "string") return [input.path]
  if (tool === "patch" && typeof input.patchText === "string")
    return [...input.patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map(
      (match) => (match[1] ?? match[2]!).trim(),
    )
  return []
}
