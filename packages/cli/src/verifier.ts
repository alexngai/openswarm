/**
 * `openswarm verifier`: install, inspect and feed the L3 verifier (docs/05
 * B1, D4). Hidden suites live in a store owned by a locked system user with
 * mode 0700; members run as the operator, so the kernel denies them a read.
 * A root-owned helper is the only way in, through two sudoers rules: run,
 * list and log without a password (the gate, and so also any member, can
 * call them; the helper only ever answers with summaries), and add-suite and
 * remove-suite with the operator's password every time, so a member cannot
 * plant a suite whose command reads the store.
 *
 * `setup` and `uninstall` print the exact commands, then run them through
 * `sudo` with the operator's own terminal password; nothing here stores a
 * credential. None of it protects anything from a member running as root.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { SUDO, VERIFIER_INSTALL, activeVerifier, tarDirectory, verifierHelperSource, verifierInstall } from 'openswarm-swarm'
import type { CliIo } from './index'

const sq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/**
 * Why `path` is not safe to trust as root-owned, or undefined: it (or, while
 * it does not exist yet, its nearest existing ancestor) and every ancestor
 * must be owned by root and writable by no one else, along the path as
 * written and where its symlinks lead; else whoever can write one can swap
 * what sudo runs as the verifier. A symlink itself is judged by its
 * directory, which is what decides who can replace it. Injectable for tests.
 */
export function unsafePath(
  path: string,
  stat: (p: string) => { uid: number; mode: number; link: boolean } | undefined = statOf,
  real: (p: string) => string = realOf,
): string | undefined {
  const chain = (start: string): string | undefined => {
    let at = start
    while (stat(at) === undefined && dirname(at) !== at) at = dirname(at)
    for (;;) {
      const st = stat(at)
      if (st === undefined) return `${at} does not exist`
      if (!st.link && st.uid !== 0) return `${at} is owned by uid ${st.uid}, not root`
      if (!st.link && (st.mode & 0o022) !== 0) return `${at} is writable by its group or others (mode ${(st.mode & 0o777).toString(8)})`
      if (dirname(at) === at) return undefined
      at = dirname(at)
    }
  }
  return chain(path) ?? chain(real(path))
}

function statOf(path: string): { uid: number; mode: number; link: boolean } | undefined {
  try {
    const st = lstatSync(path)
    return { uid: st.uid, mode: st.mode, link: st.isSymbolicLink() }
  } catch {
    return undefined
  }
}

/** `path` with its nearest existing ancestor's symlinks resolved. */
function realOf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return dirname(path) === path ? path : join(realOf(dirname(path)), basename(path))
  }
}

/**
 * Why `node` cannot run the helper as the verifier, or undefined. The helper
 * runs a copy of it, root-owned; a library it loads from anywhere the
 * operator can write (Homebrew's node, say: `/opt/homebrew/...`, `@rpath`)
 * would let a member run code as the verifier. macOS's own libraries live in
 * the dyld cache, not on disk.
 */
export function unsafeNode(node: string): string | undefined {
  let listing: string
  try {
    listing =
      process.platform === 'darwin'
        ? execFileSync('/usr/bin/otool', ['-L', node], { encoding: 'utf8' })
        : execFileSync('/usr/bin/ldd', [node], { encoding: 'utf8' })
  } catch (error) {
    return `cannot list the libraries ${node} loads (${process.platform === 'darwin' ? 'otool' : 'ldd'}: ${error instanceof Error ? error.message.split('\n')[0] : error})`
  }
  for (const line of listing.split('\n').slice(process.platform === 'darwin' ? 1 : 0)) {
    const lib = process.platform === 'darwin' ? /^\s+(\S+)/.exec(line)?.[1] : /=>\s+(\/\S+)/.exec(line)?.[1] ?? /^\s+(\/\S+)/.exec(line)?.[1]
    if (lib === undefined) continue
    if (lib.startsWith('@')) return `${node} loads ${lib}, a library found relative to it; use an official Node build (nodejs.org), which loads only system libraries`
    if (/^\/(usr\/lib|System\/Library)\//.test(lib) && process.platform === 'darwin') continue
    const why = unsafePath(lib)
    if (why !== undefined) return `${node} loads ${lib}, and ${why}; use an official Node build (nodejs.org), which loads only system libraries`
  }
  return undefined
}

export interface SetupPlan {
  platform: 'darwin' | 'linux'
  operator: string
  /** The operator's primary group, the verifier's too: so it can read a 0750 home's ignored environment. */
  gid: number
  /** macOS: a free uid under 500 (a hidden system user). */
  uid?: number
  node: string
  /** sha256 of `node` as preflight checked it: the root script installs only that file. */
  nodeHash: string
  helperSource: string
  nologin: string
}

/** Every tool the root scripts call, by absolute path: a PATH lookup as root runs whatever the operator's PATH finds first. */
function tools(platform: 'darwin' | 'linux') {
  return platform === 'darwin'
    ? {
        group: 'wheel',
        id: '/usr/bin/id',
        mkdir: '/bin/mkdir',
        chown: '/usr/sbin/chown',
        chmod: '/bin/chmod',
        install: '/usr/bin/install',
        mktemp: '/usr/bin/mktemp',
        rm: '/bin/rm',
        visudo: '/usr/sbin/visudo',
        sha256: '/usr/bin/shasum -a 256',
        cut: '/usr/bin/cut',
        // The libraries node loads: otool reads the load commands without running anything.
        libs: (bin: string) => `/usr/bin/otool -L ${bin} | /usr/bin/tail -n +2 | /usr/bin/awk '{print $1}'`,
        system: '/usr/lib/*|/System/Library/*',
      }
    : {
        group: 'root',
        id: '/usr/bin/id',
        mkdir: '/bin/mkdir',
        chown: '/bin/chown',
        chmod: '/bin/chmod',
        install: '/usr/bin/install',
        mktemp: '/bin/mktemp',
        rm: '/bin/rm',
        visudo: '/usr/sbin/visudo',
        sha256: '/usr/bin/sha256sum',
        cut: '/usr/bin/cut',
        // ldd runs the binary's loader; by then the binary is the one preflight
        // checked (its hash), so that loader is the system's.
        libs: (bin: string) => `/usr/bin/ldd ${bin} | /usr/bin/awk '$2 == "=>" {print $3; next} $1 ~ /^\// {print $1}'`,
        system: '/lib/*|/lib64/*|/usr/lib/*|/usr/lib64/*',
      }
}

/**
 * The shell script `setup` runs as root: user, store, helper, sudoers
 * (checked by `visudo -cf` before it is installed). node is copied into a
 * root-only staging directory first and checked there, so what is checked is
 * what is installed: the same file preflight saw (its hash), loading only
 * system libraries.
 */
export function setupScript(plan: SetupPlan): string {
  const { user, store, libexec, helper, sudoers } = verifierInstall(plan.platform)
  const t = tools(plan.platform)
  const createUser =
    plan.platform === 'darwin'
      ? [
          `  /usr/bin/dscl . -create /Users/${user}`,
          `  /usr/bin/dscl . -create /Users/${user} UniqueID ${plan.uid}`,
          `  /usr/bin/dscl . -create /Users/${user} PrimaryGroupID ${plan.gid}`,
          `  /usr/bin/dscl . -create /Users/${user} UserShell /usr/bin/false`,
          `  /usr/bin/dscl . -create /Users/${user} NFSHomeDirectory /var/empty`,
          `  /usr/bin/dscl . -create /Users/${user} RealName 'OpenSwarm verifier'`,
          `  /usr/bin/dscl . -create /Users/${user} IsHidden 1`,
          `  /usr/bin/dscl . -create /Users/${user} Password '*'`,
        ]
      : [`  /usr/sbin/useradd --system --no-create-home --home-dir /nonexistent --shell ${plan.nologin} --gid ${plan.gid} ${user}`]
  const wrapper = `exec /usr/bin/env -i SUDO_UID="$SUDO_UID" PATH=/usr/bin:/bin:/usr/sbin:/sbin ${libexec}/bin/node ${libexec}/helper.mjs "$@"`
  const rules = [
    '# OpenSwarm L3 verifier (docs/05 B1), written by `openswarm verifier setup`.',
    `Cmnd_Alias OPENSWARM_VERIFIER_RUN = ${helper} run *, ${helper} list, ${helper} log, ${helper} log *`,
    `Cmnd_Alias OPENSWARM_VERIFIER_ADMIN = ${helper} add-suite *, ${helper} remove-suite *`,
    '# A password every time, never a cached one, for what changes the suites.',
    'Defaults!OPENSWARM_VERIFIER_ADMIN timestamp_timeout=0',
    `${plan.operator} ALL=(${user}) NOPASSWD: OPENSWARM_VERIFIER_RUN`,
    `${plan.operator} ALL=(${user}) PASSWD: OPENSWARM_VERIFIER_ADMIN`,
  ]
  return [
    'set -eu',
    'umask 022',
    `# 1. The verifier user: a system user with no login and no home.`,
    `if ! ${t.id} -u ${user} >/dev/null 2>&1; then`,
    ...createUser,
    'fi',
    `# 2. The store: the verifier user's alone (0700).`,
    `${t.mkdir} -p ${sq(store)}`,
    `${t.chown} ${user} ${sq(store)}`,
    `${t.chmod} 0700 ${sq(store)}`,
    `# 3. node, staged root-only and checked there: the file preflight checked, loading only system libraries.`,
    `stage=$(${t.mktemp} -d /var/tmp/openswarm-verifier.XXXXXX)`,
    `trap '${t.rm} -rf "$stage"' EXIT`,
    `${t.install} -o root -g ${t.group} -m 0755 ${sq(plan.node)} "$stage/node"`,
    `[ "$(${t.sha256} "$stage/node" | ${t.cut} -d' ' -f1)" = ${sq(plan.nodeHash)} ] || { echo 'openswarm verifier: node changed after it was checked' >&2; exit 1; }`,
    `${t.libs('"$stage/node"')} | while read -r lib; do case "$lib" in ${t.system}) ;; *) echo "openswarm verifier: node loads $lib, outside the system libraries" >&2; exit 1 ;; esac; done`,
    `# 4. The helper: root-owned, run by that node, configured beside itself.`,
    `${t.mkdir} -p ${libexec}/bin`,
    `${t.install} -o root -g ${t.group} -m 0755 "$stage/node" ${libexec}/bin/node`,
    `${t.install} -o root -g ${t.group} -m 0644 ${sq(plan.helperSource)} ${libexec}/helper.mjs`,
    `printf '%s\\n' ${sq(JSON.stringify({ store }))} > ${libexec}/config.json`,
    `printf '%s\\n' '#!/bin/sh' ${sq(wrapper)} > ${helper}`,
    `${t.chown} -R root:${t.group} ${libexec}`,
    `${t.chmod} 0755 ${libexec} ${libexec}/bin ${helper}`,
    `${t.chmod} 0644 ${libexec}/config.json ${libexec}/helper.mjs`,
    `# 5. sudoers: run, list and log without a password; add-suite and remove-suite with one.`,
    `rules=$(${t.mktemp})`,
    `printf '%s\\n' ${rules.map(sq).join(' ')} > "$rules"`,
    `${t.visudo} -cf "$rules"`,
    `${t.install} -o root -g ${t.group} -m 0440 "$rules" ${sudoers}`,
    `${t.rm} -f "$rules"`,
  ].join('\n')
}

/** The shell script `uninstall` runs as root: the rules first, so nothing can call a half-removed helper. */
export function uninstallScript(platform: 'darwin' | 'linux'): string {
  const { user, store, libexec, sudoers } = verifierInstall(platform)
  const t = tools(platform)
  return [
    'set -u',
    `${t.rm} -f ${sudoers}`,
    `${t.rm} -rf ${libexec}`,
    `${t.rm} -rf ${sq(store)}`,
    platform === 'darwin' ? `/usr/bin/dscl . -delete /Users/${user} 2>/dev/null || true` : `/usr/sbin/userdel ${user} 2>/dev/null || true`,
  ].join('\n')
}

/** Plan a setup on this host, or say why it cannot be done safely. */
function planSetup(node: string): SetupPlan {
  const platform = process.platform
  if (platform !== 'darwin' && platform !== 'linux') throw new Error(`the L3 verifier installs on macOS and Linux, not ${platform}`)
  if (process.getuid?.() === 0) {
    throw new Error('run setup as the operator, not root (it calls sudo itself); L3 protects nothing from members that run as root')
  }
  for (const path of [VERIFIER_INSTALL.libexec, VERIFIER_INSTALL.store, VERIFIER_INSTALL.sudoers]) {
    const why = unsafePath(dirname(path))
    if (why !== undefined) throw new Error(`cannot install ${path} safely: ${why}`)
  }
  const nodeProblem = unsafeNode(node)
  if (nodeProblem !== undefined) throw new Error(`${nodeProblem}; pass its path with --node`)
  let uid: number | undefined
  if (platform === 'darwin') {
    const used = new Set(
      execFileSync('/usr/bin/dscl', ['.', '-list', '/Users', 'UniqueID'], { encoding: 'utf8' })
        .split('\n')
        .map((line) => Number(line.trim().split(/\s+/)[1])),
    )
    uid = [...Array(100).keys()].map((i) => 499 - i).find((n) => !used.has(n))
    if (uid === undefined) throw new Error('no free uid in 400-499 for a hidden system user')
  }
  return {
    platform,
    operator: userInfo().username,
    gid: process.getgid!(),
    ...(uid === undefined ? {} : { uid }),
    node,
    nodeHash: createHash('sha256').update(readFileSync(node)).digest('hex'),
    helperSource: verifierHelperSource(),
    nologin: existsSync('/usr/sbin/nologin') ? '/usr/sbin/nologin' : '/sbin/nologin',
  }
}

/** Run a root script through sudo: the operator types their password at sudo's own prompt. */
function asRoot(script: string, io: CliIo): number {
  io.err('running it with sudo (your password, at sudo’s prompt):')
  return spawnSync(SUDO, ['/bin/sh', '-c', script], { stdio: 'inherit' }).status ?? 1
}

/** What is installed, piece by piece; and whether the helper answers without a password, as the gate needs. */
function status(io: CliIo): number {
  const { user, store, libexec, helper, sudoers } = VERIFIER_INSTALL
  let ok = true
  const line = (good: boolean, text: string) => {
    ok &&= good
    io.out(`${good ? 'ok  ' : 'no  '} ${text}`)
  }
  if (process.getuid?.() === 0) line(false, 'you are root: L3 hides nothing from members that run as root')
  let uid: number | undefined
  try {
    uid = Number(execFileSync('/usr/bin/id', ['-u', user], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())
  } catch {}
  line(uid !== undefined, `verifier user ${user}${uid === undefined ? ' is missing' : ` (uid ${uid})`}`)
  try {
    const st = statSync(store)
    line(st.uid === uid && (st.mode & 0o777) === 0o700, `store ${store} (owner uid ${st.uid}, mode ${(st.mode & 0o777).toString(8)})`)
  } catch {
    line(false, `store ${store} is missing`)
  }
  for (const path of [helper, join(libexec, 'helper.mjs'), join(libexec, 'config.json'), join(libexec, 'bin', 'node')]) {
    const why = existsSync(path) ? unsafePath(path) : 'missing'
    line(why === undefined, `${path}${why === undefined ? ' (root-owned)' : `: ${why}`}`)
  }
  try {
    statSync(sudoers)
    line(true, `sudoers rules ${sudoers}`)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    line(code === 'EACCES', `sudoers rules ${sudoers}${code === 'EACCES' ? ' (not readable to you; the next line tests them)' : ' are missing'}`)
  }
  const listed = spawnSync(SUDO, ['-n', '-u', user, helper, 'list'], { encoding: 'utf8' })
  let answer: { suites: { name: string }[]; enforcement: string } | undefined
  try {
    answer = JSON.parse(listed.stdout.trim())
  } catch {}
  const suites = answer?.suites
  line(listed.status === 0 && suites !== undefined, suites === undefined ? `the helper does not answer without a password: ${(listed.stdout + listed.stderr).trim().split('\n').at(-1) ?? ''}` : `the helper answers: ${suites.length} suite(s)${suites.length === 0 ? '' : ` (${suites.map((s) => s.name).join(', ')})`}`)
  if (answer !== undefined) {
    line(answer.enforcement === 'full', `runs are confined: ${answer.enforcement}${answer.enforcement === 'full' ? '' : ' (L3 is refused unless OPENSWARM_VERIFIER_ALLOW_PARTIAL=1, and then counts as L2; install bwrap)'}`)
  }
  return ok ? 0 : 1
}

/** The admin form of the verifier's command: sudo prompts for the password instead of failing (-n). */
const adminCommand = () => activeVerifier().command.filter((arg, _i, all) => !(all[0] === SUDO && arg === '-n'))

export async function runVerifier(args: string[], flags: Map<string, string>, io: CliIo): Promise<number> {
  const [sub, ...rest] = args
  const platform = process.platform as 'darwin' | 'linux'
  switch (sub) {
    case 'setup': {
      const script = setupScript(planSetup(flags.get('--node') ?? process.execPath))
      io.out(script)
      return flags.has('--print') ? 0 : asRoot(script, io)
    }
    case 'uninstall': {
      const script = uninstallScript(platform)
      io.out(script)
      return flags.has('--print') ? 0 : asRoot(script, io)
    }
    case 'status':
      return status(io)
    case 'add-suite': {
      const [name, dir] = rest
      if (name === undefined || dir === undefined || rest.length > 2) break
      if (!existsSync(join(dir, 'openswarm-suite.json'))) {
        throw new Error(`${dir} has no openswarm-suite.json: {"command": "cd {work} && …", "junit"?: "<report path under {work}>", "timeoutMs"?: N}`)
      }
      const [command, ...prefix] = adminCommand()
      const added = spawnSync(command!, [...prefix, 'add-suite', name], { input: tarDirectory(dir), stdio: ['pipe', 'pipe', 'inherit'], encoding: 'utf8' })
      io.out(added.stdout.trim())
      return added.status ?? 1
    }
    case 'remove-suite':
    case 'list': {
      if (rest.length !== (sub === 'list' ? 0 : 1)) break
      const [command, ...prefix] = sub === 'list' ? activeVerifier().command : adminCommand()
      const done = spawnSync(command!, [...prefix, sub, ...rest], { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' })
      io.out(done.stdout.trim())
      return done.status ?? 1
    }
  }
  io.err(VERIFIER_USAGE)
  return 2
}

export const VERIFIER_USAGE = `usage: openswarm verifier setup [--node <path>] [--print]
       openswarm verifier status
       openswarm verifier add-suite <name> <dir>
       openswarm verifier remove-suite <name>
       openswarm verifier list
       openswarm verifier uninstall [--print]`
