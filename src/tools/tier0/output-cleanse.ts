/**
 * Token-efficient post-cleanse pipeline for command output (bash / shell).
 *
 * Ported from MiMoCode's `bash_token_efficient_pipeline`, adapted to OpenSwarm
 * style and wired to the canonical secrets module (`redactSecrets`) instead of
 * a duplicate pattern set.
 *
 * A Pipeline is composed from CleanPlugin instances. Each plugin is a single
 * pass over the text; `createPipeline` chains them and wraps the chain with a
 * "never-worse" guard — if the cleaned output is not strictly shorter than the
 * original, the cosmetic passes are reverted (degraded=true). Passes marked
 * `security` survive that revert: redaction grows the text, so it is often
 * the reason the chain fails to shrink, and reverting it would put the raw
 * secret back into model-facing output.
 *
 * Default plugin chain — order matters:
 *   progress  fold \r-redrawn lines, keep only the last rendered frame
 *   ansi      strip ANSI CSI/OSC/DCS escapes, backspace overstrike, control bytes
 *   redact    mask secrets via the shared secrets module (before elision)
 *   longline  collapse lines > MAX_LINE_CHARS to a `…<elided N chars>` marker
 *
 * `progress` must precede `ansi` (CR carries state across ANSI sequences).
 * `redact` must precede `longline` so a long secret is masked, not elided
 * mid-pattern.
 *
 * Opt-out: `# nofilter` / `# raw` in the command, or env OPENSWARM_BASH_RAW=1.
 * Disable only redaction: env OPENSWARM_OUTPUT_NO_REDACT=1.
 *
 * Tunables (positive ints via env; defaults shown):
 *   OPENSWARM_OUTPUT_MAX_LINE_CHARS=500
 *   OPENSWARM_OUTPUT_LINE_HEAD_KEEP=160
 *   OPENSWARM_OUTPUT_NEVER_WORSE_MARGIN=0
 */

import { redactSecrets } from "./secrets.js";

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Read tunables lazily per-run so tests (and runtime config) can override env.
function tunables() {
  return {
    maxLineChars: envPositiveInt("OPENSWARM_OUTPUT_MAX_LINE_CHARS", 500),
    lineHeadKeep: envPositiveInt("OPENSWARM_OUTPUT_LINE_HEAD_KEEP", 160),
    neverWorseMargin: envNonNegativeInt("OPENSWARM_OUTPUT_NEVER_WORSE_MARGIN", 0),
  };
}

const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_DCS = /\x1b[PX^_][\s\S]*?\x1b\\/g;
const BACKSPACE = /[^\n]\x08/g;
const CTRL_BYTES = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

const SKIP_MARKERS = ["# nofilter", "# raw"];

export interface CleanOptions {
  readonly command?: string;
}

export interface CleanResult {
  readonly text: string;
  readonly bytesIn: number;
  readonly bytesOut: number;
  /** True when the never-worse guard reverted to the original text. */
  readonly degraded: boolean;
}

export interface CleanPlugin {
  readonly name: string;
  /**
   * Security plugins are exempt from the never-worse guard. Their job is to
   * remove something dangerous and they typically *grow* the text doing it, so
   * a size-based rollback would silently undo them.
   */
  readonly security?: boolean;
  apply(text: string, ctx: CleanOptions): string;
}

export interface CleanPipeline {
  readonly plugins: ReadonlyArray<CleanPlugin>;
  run(text: string, options?: CleanOptions): CleanResult;
}

function shouldSkip(command: string | undefined): boolean {
  if (process.env.OPENSWARM_BASH_RAW === "1") return true;
  if (!command) return false;
  return SKIP_MARKERS.some((mark) => command.includes(mark));
}

/**
 * progress — fold \r-redrawn lines. When carriage returns redraw the same
 * position, only the segment after the LAST `\r` survives (the final rendered
 * frame). No-op when the text contains no `\r`.
 */
export function progressPlugin(): CleanPlugin {
  return {
    name: "progress",
    apply(text) {
      if (!text.includes("\r")) return text;
      return text
        .split("\n")
        .map((line) => {
          const stripped = line.endsWith("\r") ? line.slice(0, -1) : line;
          const idx = stripped.lastIndexOf("\r");
          return idx === -1 ? stripped : stripped.slice(idx + 1);
        })
        .join("\n");
    },
  };
}

/**
 * ansi — strip ANSI escapes (CSI/OSC/DCS), backspace overstrike, control bytes.
 * The backspace loop collapses `x\b` repeatedly: `ab\b\bcd` → `cd`.
 */
export function ansiPlugin(): CleanPlugin {
  return {
    name: "ansi",
    apply(text) {
      let out = text.replace(ANSI_CSI, "").replace(ANSI_OSC, "").replace(ANSI_DCS, "");
      while (BACKSPACE.test(out)) out = out.replace(BACKSPACE, "");
      BACKSPACE.lastIndex = 0;
      return out.replace(CTRL_BYTES, "");
    },
  };
}

/**
 * redact — mask secrets using the shared `redactSecrets` module. Disabled when
 * OPENSWARM_OUTPUT_NO_REDACT=1 (falls back to identity so ordering is stable).
 */
export function redactPlugin(): CleanPlugin {
  return {
    name: "redact",
    security: true,
    apply(text) {
      if (process.env.OPENSWARM_OUTPUT_NO_REDACT === "1") return text;
      return redactSecrets(text).redacted;
    },
  };
}

/**
 * longline — elide lines longer than maxLineChars, keeping the head and a
 * `…<elided N chars>` tail marker. Short-circuits when the whole text is
 * already within the threshold.
 */
export function longLinePlugin(): CleanPlugin {
  return {
    name: "longline",
    apply(text) {
      const { maxLineChars, lineHeadKeep } = tunables();
      if (text.length <= maxLineChars) return text;
      return text
        .split("\n")
        .map((line) => {
          if (line.length <= maxLineChars) return line;
          return `${line.slice(0, lineHeadKeep)}…<elided ${line.length - lineHeadKeep} chars>`;
        })
        .join("\n");
    },
  };
}

/**
 * Default plugin chain. Returns a fresh array each call so callers can safely
 * splice/extend without mutating shared state.
 */
export function defaultPlugins(): CleanPlugin[] {
  return [progressPlugin(), ansiPlugin(), redactPlugin(), longLinePlugin()];
}

/**
 * Pipeline factory. Composes the injected plugins: skip-check → fold plugins →
 * never-worse guard. The guard runs at the tail because individual plugins may
 * temporarily inflate the text (e.g. a short secret expanding to its
 * `[REDACTED:*]` marker); only the chain as a whole must shrink.
 *
 * The guard's fallback keeps `security` plugins applied. Falling all the way
 * back to the raw input would make the byte budget able to un-redact secrets,
 * which is the same inflation the paragraph above describes — on a short
 * output there is nothing else to reclaim those bytes, so the guard trips and
 * the credential would be handed back in the clear.
 */
export function createPipeline(plugins: CleanPlugin[] = defaultPlugins()): CleanPipeline {
  return {
    plugins,
    run(text, options = {}) {
      const bytesIn = Buffer.byteLength(text, "utf8");
      if (!text || shouldSkip(options.command)) {
        return { text, bytesIn, bytesOut: bytesIn, degraded: false };
      }
      const out = plugins.reduce((acc, plugin) => plugin.apply(acc, options), text);
      const bytesOut = Buffer.byteLength(out, "utf8");
      if (bytesOut + tunables().neverWorseMargin >= bytesIn) {
        // Never-worse guard: the chain did not pay for itself, so fall back to
        // the input — but re-apply the security plugins first. Reverting to raw
        // text would un-redact secrets whenever redaction was the thing that
        // grew the output, which is exactly the short-output case (a 20-char
        // key becomes a 25-char [REDACTED:*] marker). Saving bytes is never
        // worth re-exposing a credential.
        const safe = plugins
          .filter((plugin) => plugin.security)
          .reduce((acc, plugin) => plugin.apply(acc, options), text);
        return {
          text: safe,
          bytesIn,
          bytesOut: Buffer.byteLength(safe, "utf8"),
          degraded: true,
        };
      }
      return { text: out, bytesIn, bytesOut, degraded: false };
    },
  };
}

const defaultPipeline = createPipeline();

/** Public entry point used by the bash/shell tools. */
export function cleanOutput(text: string, options: CleanOptions = {}): CleanResult {
  return defaultPipeline.run(text, options);
}
