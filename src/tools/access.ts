/**
 * Resource access declarations. These have two consumers.
 *
 * The scheduler reads them to decide which concurrent tool calls may overlap.
 * Two accesses conflict when at least one of them writes and their paths
 * overlap. Reads (including `search`) on overlapping paths do not conflict.
 * The `all` kind is a global barrier: it conflicts with every other access,
 * including other `all`s.
 *
 * The permission gate reads them to learn which resources a call will touch,
 * so a grant can bind to one path or one host rather than to a tool name.
 *
 * Every tool must declare something — `ToolImpl.accesses` is required — because
 * the two consumers have opposite failure modes and silence reads as
 * "conflicts with nothing" to one and "nothing to authorize" to the other. A
 * tool whose side effects cannot be named (shell commands, env mutation,
 * shared in-process state) declares `all()`, which is honest in both
 * directions: a global barrier to the scheduler and an unknown resource to the
 * gate.
 *
 * Ported, with light adaptation, from kimi-code's tool-access module.
 */

export type ToolFileAccessOperation = "read" | "write" | "readwrite" | "search";

export interface ToolFileAccess {
  readonly kind: "file";
  readonly operation: ToolFileAccessOperation;
  readonly path: string;
  readonly recursive?: boolean;
}

/**
 * A call to something outside this machine's filesystem. `url` carries the
 * grant identity: the policy engine binds an approval to its host, so
 * `https://api.example.com/a` and `.../b` are one decision.
 *
 * The scheme need not be http. A stdio MCP server has no host of its own, so
 * it is named `mcp://<server>`; a plugin is `plugin://<plugin>`. That keeps
 * "approve this server once" on the same machinery as "approve this domain
 * once" instead of inventing a second grant vocabulary for local servers.
 */
export interface ToolNetworkAccess {
  readonly kind: "network";
  readonly method: string;
  readonly url: string;
}

export interface ToolResourceAccessAll {
  readonly kind: "all";
}

export type ToolResourceAccess = ToolFileAccess | ToolNetworkAccess | ToolResourceAccessAll;
export type ToolAccesses = readonly ToolResourceAccess[];

export const ToolAccesses = {
  none(): ToolAccesses {
    return [];
  },

  all(): ToolAccesses {
    return [{ kind: "all" }];
  },

  /** A request to a remote resource, identified for grants by its host. */
  network(url: string, method = "GET"): ToolAccesses {
    return [{ kind: "network", method, url }];
  },

  /** A call into an MCP server, identified by the server's configured name. */
  mcpServer(serverName: string): ToolAccesses {
    return ToolAccesses.network(`mcp://${encodeURIComponent(serverName)}`, "CALL");
  },

  /** A call into a plugin-provided tool, identified by the plugin's name. */
  plugin(pluginName: string): ToolAccesses {
    return ToolAccesses.network(`plugin://${encodeURIComponent(pluginName)}`, "CALL");
  },

  file(
    operation: ToolFileAccessOperation,
    path: string,
    options: { readonly recursive?: boolean } = {},
  ): ToolAccesses {
    return [{ kind: "file", operation, path, recursive: options.recursive }];
  },

  readFile(path: string): ToolAccesses {
    return ToolAccesses.file("read", path);
  },

  readTree(path: string): ToolAccesses {
    return ToolAccesses.file("read", path, { recursive: true });
  },

  writeFile(path: string): ToolAccesses {
    return ToolAccesses.file("write", path);
  },

  writeTree(path: string): ToolAccesses {
    return ToolAccesses.file("write", path, { recursive: true });
  },

  readWriteFile(path: string): ToolAccesses {
    return ToolAccesses.file("readwrite", path);
  },

  readWriteTree(path: string): ToolAccesses {
    return ToolAccesses.file("readwrite", path, { recursive: true });
  },

  searchTree(path: string): ToolAccesses {
    return ToolAccesses.file("search", path, { recursive: true });
  },

  conflict(left: ToolAccesses, right: ToolAccesses): boolean {
    return left.some((l) => right.some((r) => resourceAccessesConflict(l, r)));
  },
};

function resourceAccessesConflict(
  left: ToolResourceAccess,
  right: ToolResourceAccess,
): boolean {
  if (left.kind === "all" || right.kind === "all") return true;

  // Network accesses never conflict. The scheduler exists to protect this
  // machine's state from concurrent tool calls, and a request to a remote host
  // does not touch it. Ordering of remote effects is the caller's problem —
  // two writes to the same API would race whether or not we serialized them,
  // since nothing here can see that remote state.
  if (left.kind === "network" || right.kind === "network") return false;

  if (!fileOperationsConflict(left.operation, right.operation)) return false;
  return fileAccessesOverlap(left, right);
}

function fileOperationsConflict(
  left: ToolFileAccessOperation,
  right: ToolFileAccessOperation,
): boolean {
  return fileOperationWrites(left) || fileOperationWrites(right);
}

function fileOperationWrites(operation: ToolFileAccessOperation): boolean {
  switch (operation) {
    case "read":
    case "search":
      return false;
    case "write":
    case "readwrite":
      return true;
  }
}

function fileAccessesOverlap(left: ToolFileAccess, right: ToolFileAccess): boolean {
  const leftPath = normalizePath(left.path);
  const rightPath = normalizePath(right.path);
  if (leftPath === rightPath) return true;

  const leftPrefix = leftPath.endsWith("/") ? leftPath : `${leftPath}/`;
  const rightPrefix = rightPath.endsWith("/") ? rightPath : `${rightPath}/`;
  return (
    (left.recursive === true && rightPath.startsWith(leftPrefix)) ||
    (right.recursive === true && leftPath.startsWith(rightPrefix))
  );
}

// Case-folds and collapses separators so accesses declared with different
// surface forms of the same path still match. Over-conservative on
// case-sensitive filesystems (we may serialize two distinct files that differ
// only in case) — that costs throughput but cannot cause data races.
function normalizePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replaceAll(/\/+/g, "/");
  const folded = normalized.toLowerCase();
  if (folded.length > 1 && folded.endsWith("/")) {
    return folded.slice(0, -1);
  }
  return folded;
}
