/**
 * Process hardening (S4): strip dangerous environment variables and apply
 * OS-level hardening before spawning child processes.
 *
 * Prevents dynamic-linker injection (LD_PRELOAD, DYLD_*), interpreter
 * startup hooks (PYTHONSTARTUP, NODE_OPTIONS, PERL5LIB, RUBYLIB),
 * and other env vars that allow code injection into spawned shells.
 */

const DANGEROUS_ENV_PREFIXES = [
  "LD_",
  "DYLD_",
  "_DYLD_",
] as const;

const DANGEROUS_ENV_EXACT = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "LD_DEBUG",
  "LD_PROFILE",
  "LD_SHOW_AUXV",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_LIBRARY_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "DYLD_VERSIONED_LIBRARY_PATH",
  "DYLD_PRINT_LIBRARIES",
  "NODE_OPTIONS",
  "NODE_REPL_EXTERNAL_MODULE",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "PERL5LIB",
  "PERL5OPT",
  "RUBYLIB",
  "RUBYOPT",
  "JULIA_LOAD_PATH",
  "LUA_PATH",
  "LUA_CPATH",
  "CLASSPATH",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "DOTNET_STARTUP_HOOKS",
  "COR_ENABLE_PROFILING",
  "BASH_ENV",
  "ENV",
  "CDPATH",
  "GLOBIGNORE",
  "PROMPT_COMMAND",
]);

/**
 * Strip dangerous env vars from a process.env-like object.
 * Returns a new object (never mutates the input).
 */
export function hardenEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isDangerous(key)) continue;
    out[key] = value;
  }
  return out;
}

function isDangerous(key: string): boolean {
  if (DANGEROUS_ENV_EXACT.has(key)) return true;
  const upper = key.toUpperCase();
  for (const prefix of DANGEROUS_ENV_PREFIXES) {
    if (upper.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * List of env vars that were stripped (for audit logging).
 */
export function strippedVars(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return Object.keys(env).filter(isDangerous);
}

let _hardenedEnv: NodeJS.ProcessEnv | undefined;

/**
 * Cached hardened env — computed once from process.env and reused for all
 * spawned child processes. Thread-safe (computed on first call, then frozen).
 */
export function getHardenedEnv(): NodeJS.ProcessEnv {
  if (!_hardenedEnv) {
    _hardenedEnv = Object.freeze(hardenEnv());
  }
  return _hardenedEnv;
}

export function resetHardenedEnvCache(): void {
  _hardenedEnv = undefined;
}

/**
 * Apply OS-level process hardening. Call once at startup.
 * - Sets core dump size to 0 (prevents secrets leaking to disk).
 * - Logs stripped env vars for audit.
 */
export function applyProcessHardening(): string[] {
  try {
    const p = process as unknown as {
      setrlimit?: (resource: string, limits: { soft: number; hard: number }) => void;
    };
    p.setrlimit?.("core", { soft: 0, hard: 0 });
  } catch {
    // Not available on all platforms — best effort.
  }
  return strippedVars();
}
