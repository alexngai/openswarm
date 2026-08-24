/** Bundle entrypoint: the sandbox-deployable `openswarm` executable. */
import { runCli } from './index'

const code = await runCli(process.argv.slice(2))
// Hard exit: PTY and watcher handles from the composed harness outlive the
// run; the CLI's contract is exit-on-completion.
process.exit(code)
