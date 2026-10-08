// PROBE-SECRET-MARKER: this line reaching a member means the verifier leaked (docs/05 B1, exit criterion 2).
import { existsSync } from 'node:fs'
process.exit(existsSync('work/probe-ok.txt') ? 0 : 1)
