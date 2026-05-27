/**
 * mapping.ts — convert OpenteamsConfig → TeamSpec.
 *
 * v0.4 stage 4F. Mapping rules (per docs/25 §5.4):
 *
 *   - `topology.root` + `spawn_rules` → TopologyKind: "coordinator"
 *     (root + model-driven spawning).
 *   - `topology.root` + empty/absent `spawn_rules` (root only) → still
 *     "coordinator" with one member (the root) for v0.4.
 *   - `topology.root` + flat `spawn_rules` (all roles spawned by root) →
 *     "coordinator".
 *   - `x-swarm-harness.topology` overrides the inferred topology.
 *   - `communication.{channels,subscriptions,emissions,enforcement}` plumbs
 *     through unchanged into `coordination.communication`.
 *   - `x-swarm-harness.coordination` merges over the defaults — lets users
 *     override completion rule, aggregator, etc. via the YAML extension.
 */

import type {
  TeamSpec,
  MemberSpec,
  TopologyKind,
  TeamCoordination,
} from "../team-spec.js";
import type { OpenteamsConfig } from "./loader.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MapOptions {
  /**
   * Topology used when the openteams config doesn't disambiguate (no
   * `topology.root`, no `x-swarm-harness.topology`). Default: "fanout".
   */
  readonly defaultTopology?: TopologyKind;
}

// ---------------------------------------------------------------------------
// openteamsToTeamSpec
// ---------------------------------------------------------------------------

/**
 * Convert a parsed openteams config into a TeamSpec ready for
 * Orchestrator.runTeam(). Members get fallback prompts when no per-role
 * prompt is present so MemberSpec.prompt (required by zod) stays valid.
 */
export function openteamsToTeamSpec(
  config: OpenteamsConfig,
  opts: MapOptions = {},
): TeamSpec {
  // 1. Pick topology.
  const ext = config["x-swarm-harness"];
  let topology: TopologyKind;
  if (ext?.topology !== undefined) {
    topology = ext.topology;
  } else if (config.topology?.root !== undefined) {
    topology = "coordinator";
  } else {
    topology = opts.defaultTopology ?? "fanout";
  }

  // 2. Build members. For coordinator topology, root goes first (members[0]),
  //    then the rest in spawn-rule / role-list order. For other topologies,
  //    expand all known roles into members.
  const roles = config.roles ?? [];
  const rolePrompts = config.rolePrompts ?? {};

  const buildMember = (role: string): MemberSpec => ({
    role,
    prompt: rolePrompts[role] ?? `You are the ${role} of team ${config.name}.`,
  });

  let members: MemberSpec[];
  if (topology === "coordinator" && config.topology?.root !== undefined) {
    const rootRole = config.topology.root.role;
    const rootMember = buildMember(rootRole);
    const otherMembers = roles
      .filter((r) => r !== rootRole)
      .map(buildMember);
    members = [rootMember, ...otherMembers];
  } else {
    members = roles.map(buildMember);
  }

  if (members.length === 0) {
    throw new Error(`openteams template "${config.name}" has no roles`);
  }

  // 3. Build coordination block. Communication plumbs through; user-supplied
  //    x-swarm-harness.coordination overrides any defaults we set.
  const userCoordination =
    (ext?.coordination as Partial<TeamCoordination> | undefined) ?? {};
  const coordination: TeamCoordination = {
    completion: userCoordination.completion ?? { kind: "all" },
    ...(config.communication !== undefined && {
      communication: config.communication,
    }),
    // Carry over any other fields the user supplied (aggregator, idleTimeoutMs,
    // entryPoint, etc.). User wins on conflicts.
    ...userCoordination,
  };

  return {
    name: config.name,
    topology,
    members,
    coordination,
    templateName: config.name,
  };
}
