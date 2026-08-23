/**
 * Internal utilities shared across tier0 tools only.
 * Not a cross-tree shared module — belongs to the tier0 tool set.
 */

const MAX_BYTES = 16 * 1024; // 16 KiB

/**
 * Truncate a Buffer to at most `maxBytes` bytes at a UTF-8-safe codepoint
 * boundary, then decode to string. Appends "[truncated]" if truncation occurred.
 */
export function truncateUtf8(buf: Buffer, maxBytes = MAX_BYTES): string {
  if (buf.length <= maxBytes) {
    return buf.toString("utf8");
  }

  // Walk back from maxBytes to find a safe UTF-8 boundary.
  // UTF-8 continuation bytes have the form 10xxxxxx (0x80–0xBF).
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end--;
  }

  return buf.slice(0, end).toString("utf8") + "[truncated]";
}

// ---------------------------------------------------------------------------
// HeadTailBuffer — preserves first N + last N bytes of long output (F13)
// ---------------------------------------------------------------------------

const DEFAULT_HEAD_BYTES = 20 * 1024; // 20 KiB
const DEFAULT_TAIL_BYTES = 20 * 1024; // 20 KiB

export interface HeadTailOptions {
  readonly headBytes?: number;
  readonly tailBytes?: number;
}

/**
 * Smart truncation that preserves both the beginning and end of output.
 *
 * For short output (fits in head+tail budget), returns the full string.
 * For long output, returns:
 *   [first headBytes]
 *   \n\n[... truncated N bytes ...]\n\n
 *   [last tailBytes]
 *
 * Both cut points are UTF-8-safe.
 */
export function headTailTruncate(
  buf: Buffer,
  opts: HeadTailOptions = {},
): string {
  const headBytes = opts.headBytes ?? DEFAULT_HEAD_BYTES;
  const tailBytes = opts.tailBytes ?? DEFAULT_TAIL_BYTES;

  if (buf.length <= headBytes + tailBytes) {
    return buf.toString("utf8");
  }

  const headEnd = utf8SafeBoundary(buf, headBytes);
  const tailStart = utf8SafeBoundaryReverse(buf, buf.length - tailBytes);

  const head = buf.slice(0, headEnd).toString("utf8");
  const tail = buf.slice(tailStart).toString("utf8");
  const omitted = tailStart - headEnd;

  return `${head}\n\n[... truncated ${omitted} bytes ...]\n\n${tail}`;
}

function utf8SafeBoundary(buf: Buffer, pos: number): number {
  let end = Math.min(pos, buf.length);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end--;
  }
  return end;
}

function utf8SafeBoundaryReverse(buf: Buffer, pos: number): number {
  let start = Math.max(pos, 0);
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) {
    start++;
  }
  return start;
}

/**
 * Check whether `resolved` is under (or equal to) `cwd`.
 * Uses a trailing-separator prefix check to prevent path-traversal.
 */
export function isUnderCwd(resolved: string, cwd: string): boolean {
  const cwdWithSep = cwd.endsWith("/") ? cwd : cwd + "/";
  return resolved === cwd || resolved.startsWith(cwdWithSep);
}

/**
 * Build a z.preprocess normalizer that maps legacy/alias parameter names to
 * the canonical (Claude Code-aligned) name before validation.
 *
 * Canonical schemas advertise only the primary name (e.g. `file_path`), but
 * older openswarm trajectories and non-Claude models may emit the alias
 * (e.g. `path`). When only the alias is present it is renamed to the
 * primary; when both are present the primary wins.
 */
export function aliasParams(
  aliases: Record<string, string>,
): (raw: unknown) => unknown {
  return (raw: unknown): unknown => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const obj = raw as Record<string, unknown>;
    let out: Record<string, unknown> | undefined;
    for (const [alias, primary] of Object.entries(aliases)) {
      if (alias in obj && !(primary in obj)) {
        out ??= { ...obj };
        out[primary] = out[alias];
        delete out[alias];
      }
    }
    return out ?? raw;
  };
}
