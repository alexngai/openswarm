/**
 * Pure view-model helpers for the Swarm tab, kept free of React so they are
 * unit-testable. Shapes are the swarm protocol's (`swarm/runs`, `swarm/view`).
 */

/** The run to show: the newest started from this session, else the newest. */
export function pickRun(runs, sessionId) {
  const newest = (list) => list.reduce((best, run) => (best === undefined || run.startedAt > best.startedAt ? run : best), undefined)
  return newest(runs.filter((run) => run.parentSessionId === sessionId)) ?? newest(runs)
}

/** Runs newest first, for the picker. */
export function newestFirst(runs) {
  return [...runs].sort((a, b) => b.startedAt - a.startedAt)
}

/** Every member a view names: from the run's spec, then any task owner not in it. */
export function memberNames(view) {
  const spec = view.run.spec ?? {}
  const members = [
    ...(spec.members ?? []),
    ...(spec.workers ?? []),
    ...(spec.tiers ?? []),
    ...(spec.stages ?? []).map((stage) => stage.member),
    spec.worker,
    spec.critic,
    spec.judge,
    spec.gate,
    spec.coordinator,
  ]
  const names = [...members.map((member) => member?.name), ...view.tasks.map((task) => task.owner)]
  return [...new Set(names.filter((name) => typeof name === 'string' && name !== ''))]
}

/** Tasks in id order (`t2` before `t10`). */
export function sortTasks(tasks) {
  return [...tasks].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
}

/** Questions still waiting for an answer. */
export function openQuestions(view) {
  return view.questions.filter((question) => question.status === 'open')
}

/** Time since `time`, coarsely: `42s`, `5m`, `3h`, `2d`. */
export function age(time, now = Date.now()) {
  const s = Math.max(0, Math.round((now - time) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3_600) return `${Math.floor(s / 60)}m`
  return s < 86_400 ? `${Math.floor(s / 3_600)}h` : `${Math.floor(s / 86_400)}d`
}

/** A picker line: `run-1a2b3c4d · running · peer-team · 5m`. */
export function runLabel(run, now = Date.now()) {
  return `${run.id} · ${run.status} · ${run.topology} · ${age(run.startedAt, now)}`
}

/** `swarm/start` args from the form's JSON text; a blank worktrees box is omitted. */
export function startArgs(specText, worktreesText) {
  const args = { spec: parseObject('spec', specText) }
  if (worktreesText.trim() !== '') args.worktrees = parseObject('worktrees', worktreesText)
  return args
}

function parseObject(label, text) {
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`${label}: ${error.message}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label}: must be a JSON object`)
  return value
}
