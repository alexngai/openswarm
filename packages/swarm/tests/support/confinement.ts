/**
 * Whether this host can fully confine a hidden suite's run, probed as the
 * verifier helper probes it (macOS Seatbelt, or a working bwrap on Linux).
 * Tests that open a real L3 verifier skip where it cannot: there openVerifier
 * refuses L3 by design (Ubuntu 24.04, say, restricts the user namespaces
 * bwrap needs).
 */
import { spawnSync } from 'node:child_process'

export const fullConfinement =
  process.platform === 'darwin'
    ? spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0
    : process.platform === 'linux' && spawnSync('/usr/bin/bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-net', '/bin/true']).status === 0
