// Probe plugin: one reversible effect — write a marker file on apply,
// remove it on dispose. Observable evidence for mount/unmount/replug.
import { writeFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

export const name = 'spike-marker'

export function apply(ctx, config) {
  const file = resolve(process.env.SPIKE_MARKER_DIR ?? '.', config?.file ?? 'spike-marker.txt')
  const text = config?.text ?? 'spike'
  ctx.effect(() => {
    writeFileSync(file, `${text}\n`)
    return () => rmSync(file, { force: true })
  })
}
