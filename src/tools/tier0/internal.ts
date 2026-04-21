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

/**
 * Check whether `resolved` is under (or equal to) `cwd`.
 * Uses a trailing-separator prefix check to prevent path-traversal.
 */
export function isUnderCwd(resolved: string, cwd: string): boolean {
  const cwdWithSep = cwd.endsWith("/") ? cwd : cwd + "/";
  return resolved === cwd || resolved.startsWith(cwdWithSep);
}
