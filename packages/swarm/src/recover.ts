/**
 * Fold a member's persisted session log into what it was asked and what it
 * reported.
 *
 * This was the warm-restart workaround for members that could not resume.
 * They now resume their own session (docs/05 A2), so nothing in the runtime
 * uses it; it stays only because eval/benchmark.mjs tasks (`digest-tool-calls`,
 * `briefing-clip-count`) are cut from HEAD and target these two functions.
 */
import { readFileSync } from 'node:fs'

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
