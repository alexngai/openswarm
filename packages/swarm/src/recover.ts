/**
 * Warm-restart support: recover what a dead member knew from the log it
 * already persisted.
 *
 * A member's composition mounts `dsh-session-persistence-jsonl` rooted at
 * `DSH_SESSION_ROOT`, so when a child dies its full session log is on disk
 * beside the worktree. What does NOT happen is resume: the SDK server's
 * `getOrCreateSession` consults an in-memory map for that process and falls
 * through to `agents.create`, never to persistence, so a respawned child is
 * amnesiac by default (pinned by `member-resume.test.ts`).
 *
 * So we rehydrate the only way available to us — read the log, fold it to what
 * the member was asked and what it reported, and hand that to the replacement
 * as briefing context. Combined with the worktree, which still holds the
 * member's actual file changes, a replacement resumes with the two things that
 * matter: the work and the narrative. Exact tool-call state and in-context
 * nuance are genuinely lost.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Text blocks of a message-shaped event payload, tolerant of both shapes. */
function textOf(data: any): string {
  const content = data?.message?.content ?? data?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('')
    .trim()
}

/**
 * Locate a session's `session.jsonl` under a persistence root. The store nests
 * logs under a workspace-derived directory whose naming is the persistence
 * plugin's business, so this searches for the session-id directory rather than
 * reconstructing that scheme.
 */
export function findSessionLog(root: string, sessionId: string): string | undefined {
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry)
      let isDir: boolean
      try {
        isDir = statSync(path).isDirectory()
      } catch {
        continue
      }
      if (!isDir) continue
      if (entry === sessionId) {
        const log = join(path, 'session.jsonl')
        try {
          if (statSync(log).isFile()) return log
        } catch {
          // Directory without a log yet; keep looking.
        }
      }
      stack.push(path)
    }
  }
  return undefined
}

export interface SessionDigest {
  /** Prompts the member received, oldest first. */
  asked: string[]
  /** Final text the member produced, oldest first. */
  reported: string[]
}

/** Fold a persisted member log into what it was asked and what it answered. */
export function digestSessionLog(logPath: string): SessionDigest {
  const digest: SessionDigest = { asked: [], reported: [] }
  let raw: string
  try {
    raw = readFileSync(logPath, 'utf8')
  } catch {
    return digest
  }
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let event: any
    try {
      event = JSON.parse(line)
    } catch {
      continue // a torn final frame is expected after a crash
    }
    const text = textOf(event?.data)
    if (text === '') continue
    if (event.type === 'user/message') digest.asked.push(text)
    else if (event.type === 'assistant/message') digest.reported.push(text)
  }
  return digest
}

/**
 * Render a digest as briefing context for a replacement member, or `undefined`
 * when there is nothing worth saying. Bounded so a long-lived member's history
 * cannot crowd out its actual task; the most RECENT entries are kept, since
 * they describe the state the worktree is now in.
 */
export function renderRecoveryBriefing(digest: SessionDigest, maxChars = 4_000): string | undefined {
  if (digest.asked.length === 0 && digest.reported.length === 0) return undefined
  const clip = (entries: string[]): string[] =>
    entries.slice(-3).map((e) => (e.length > 600 ? `${e.slice(0, 600)}…` : e))
  const lines = [
    'Your previous process ended before finishing. This is what you had done.',
    '',
    ...(digest.asked.length > 0
      ? ['Previously asked of you:', ...clip(digest.asked).map((e) => `- ${e}`), '']
      : []),
    ...(digest.reported.length > 0
      ? ['What you reported:', ...clip(digest.reported).map((e) => `- ${e}`), '']
      : []),
    'Your git worktree still contains every file change you made, so inspect it before redoing work.',
  ]
  const text = lines.join('\n')
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}
