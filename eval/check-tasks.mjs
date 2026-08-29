// Prove the task set discriminates, before any spend.
import { resolve } from 'node:path'
import { TASKS } from './benchmark.mjs'
import { verifyDiscrimination } from './discriminate.mjs'
const REPO = resolve(import.meta.dirname, '..')
try {
  verifyDiscrimination(TASKS, REPO, { onProgress: (l) => console.log(l) })
  console.log('\nall checks discriminate')
} catch (e) {
  console.error('\nDISCRIMINATION FAILURE:', e.message)
  process.exit(1)
}
