/**
 * The C1/C2 task set (docs/04 companion): changes to this repo, each with a
 * SEALED ground-truth check.
 *
 * `checkpoints` never reach the system under test — `PublicTask` is a `Pick`
 * allowlist, so they are structurally unreachable rather than merely undocumented,
 * and a `cmd` check's `writeFiles` seeds its test into the FINISHED workspace,
 * after the agent is done, in a directory it never saw. That is the held-out
 * property we would otherwise have had to build and maintain by convention.
 *
 * A check must FAIL at the base commit and pass only after a correct change; one
 * that already passes scores a no-op as success. `verifyChecksFailAtBase` in
 * validate.mjs enforces that rather than trusting the author.
 */

/** Mock-driven wiring task. The scripted member writes the marker; the sealed check looks for it. */
export const wiringTask = {
  id: 'selfmod/wiring',
  benchmark: 'openswarm-selfmod',
  prompt: 'Create a file eval-marker.txt in the repository root containing the word evaluated.',
  checkpoints: [
    {
      id: 'marker-written',
      weight: 1,
      check: { type: 'cmd', cmd: 'grep -q evaluated eval-marker.txt' },
    },
  ],
}

export function selfModBenchmark(tasks = [wiringTask]) {
  return {
    id: 'openswarm-selfmod',
    execution: 'native',
    async load(opts = {}) {
      const ids = opts.taskIds
      const chosen = ids === undefined ? tasks : tasks.filter((t) => ids.includes(t.id))
      return opts.limit === undefined ? chosen : chosen.slice(0, opts.limit)
    },
  }
}

/**
 * Gate-on vs gate-off. Everything else is held constant, so a difference between
 * these two arms is attributable to the gate — the backbone-controlled design
 * from JIT-Agent's Table 4, applied to our own loop.
 */
export const ARMS = [
  { id: 'gated', label: 'gate on', scaffold: {} },
  { id: 'ungated', label: 'gate off', scaffold: {} },
]
