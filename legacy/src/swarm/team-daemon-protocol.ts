/**
 * Team daemon protocol — wire format for CLI ↔ team-daemon communication.
 *
 * Companion to src/swarm/ipc/protocol.ts (which defines orchestrator ↔ worker
 * IPC). Each frame is one line of JSON over a Unix socket connection.
 *
 * v0.5 stage 5E.1: locks the request/response/notification frame shapes
 * + zod schemas. Transport (Unix socket bind, frame parsing) is 5E.2.
 *
 * Methods used in requests (CLI → daemon):
 *   - "status"        params: {};                 result: StatusResult
 *   - "send_prompt"   params: SendPromptParams;   result: SendPromptResult
 *   - "stop"          params: StopParams;         result: AcknowledgedResult
 *   - "kill"          params: {};                 result: AcknowledgedResult
 *
 * Notifications (one-way; daemon → subscribers):
 *   - "team_event"    params: TeamEventParams (passthrough LaneEvent shape)
 *
 *     Phase 4.1d decision: there is deliberately NO socket subscribe RPC.
 *     The per-team `events.jsonl` is the blessed follow contract — consumers
 *     tail it (`team logs --follow`) or parse it structurally via
 *     `src/swarm/events-log.ts` (`parseTeamEventsLog`). The notification type
 *     is retained only as a locked wire shape for a future remote/hub path
 *     (MAP), which is threaded separately and does not use this socket.
 */

import { z } from "zod";
import type { UsageTotals } from "./usage-aggregator.js";

// ---------------------------------------------------------------------------
// Frame shape
// ---------------------------------------------------------------------------

export type TeamDaemonFrame =
  | TeamDaemonRequest
  | TeamDaemonResponse
  | TeamDaemonNotification;

export interface TeamDaemonRequest {
  readonly kind: "request";
  readonly id: string;
  readonly method: TeamDaemonRequestMethod;
  readonly params: unknown;
}

export type TeamDaemonRequestMethod =
  | "status"
  | "send_prompt"
  | "stop"
  | "kill";

export type TeamDaemonResponse = TeamDaemonOk | TeamDaemonErr;

export interface TeamDaemonOk {
  readonly kind: "response";
  readonly id: string;
  readonly ok: true;
  readonly result: unknown;
}

export interface TeamDaemonErr {
  readonly kind: "response";
  readonly id: string;
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string };
}

export interface TeamDaemonNotification {
  readonly kind: "notification";
  readonly method: TeamDaemonNotificationMethod;
  readonly params: unknown;
}

export type TeamDaemonNotificationMethod = "team_event";

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/** Well-known error codes for daemon RPC errors. */
export const TEAM_DAEMON_ERROR_CODES = {
  TRANSPORT_CLOSED: "transport_closed",
  REQUEST_TIMEOUT: "request_timeout",
  MALFORMED_FRAME: "malformed_frame",
  UNKNOWN_METHOD: "unknown_method",
  INVALID_PARAMS: "invalid_params",
  INTERNAL_ERROR: "internal_error",
  /** Socket file present but daemon process is dead (V0.5.Q5b). */
  TEAM_NOT_RUNNING: "team_not_running",
  /** `team start` rejected because a live daemon already owns this name (V0.5.Q7). */
  TEAM_ALREADY_RUNNING: "team_already_running",
} as const;

export type TeamDaemonErrorCode =
  (typeof TEAM_DAEMON_ERROR_CODES)[keyof typeof TEAM_DAEMON_ERROR_CODES];

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isRequest(f: TeamDaemonFrame): f is TeamDaemonRequest {
  return f.kind === "request";
}

export function isResponse(f: TeamDaemonFrame): f is TeamDaemonResponse {
  return f.kind === "response";
}

export function isNotification(f: TeamDaemonFrame): f is TeamDaemonNotification {
  return f.kind === "notification";
}

// ---------------------------------------------------------------------------
// Request param/result schemas
// ---------------------------------------------------------------------------

/** params for "status" request — empty object. */
export const StatusParamsSchema = z.object({}).strict();
export type StatusParams = z.infer<typeof StatusParamsSchema>;

/**
 * Rolled-up token/cost usage totals (GitHub #17). Schema is pinned to the
 * `UsageTotals` shape produced by the swarm usage aggregator via
 * `z.ZodType<UsageTotals>`, so the wire schema and the producer type can never
 * silently drift.
 */
export const UsageTotalsSchema: z.ZodType<UsageTotals> = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cacheWriteInputTokens: z.number(),
  totalTokens: z.number(),
  calls: z.number(),
  costUsd: z.number(),
  gpuSeconds: z.number(),
  flops: z.number(),
  costUsdComplete: z.boolean(),
  gpuSecondsComplete: z.boolean(),
  flopsComplete: z.boolean(),
});

/**
 * result for "status" — daemon's current team snapshot.
 *
 * GitHub #17: each member optionally carries its subtree `usage` roll-up
 * (itself + everything it spawned) and the snapshot optionally carries a
 * team-wide `teamUsage` total. Both are optional so pre-#17 producers (and the
 * empty-team case before any usage is observed) still validate.
 */
export const StatusResultSchema = z.object({
  teamName: z.string(),
  scope: z.string(),
  topology: z.string(),
  startedAt: z.number(),
  members: z.array(
    z.object({
      memberId: z.string(),
      role: z.string(),
      agentId: z.string(),
      state: z.string(),
      usage: UsageTotalsSchema.optional(),
    }),
  ),
  teamUsage: UsageTotalsSchema.optional(),
});
export type StatusResult = z.infer<typeof StatusResultSchema>;

/**
 * params for "send_prompt" — push a prompt into the team.
 *
 * `target` routing semantics:
 *   - "entry" (default): per-topology default per V0.4.Q4 — root for
 *     coordinator/critic-loop/pipeline; broadcast for fanout/peer-team/committee.
 *   - "broadcast": every member.
 *   - { agentId }: a specific member.
 */
export const SendPromptParamsSchema = z.object({
  prompt: z.string().min(1),
  target: z
    .union([
      z.literal("entry"),
      z.literal("broadcast"),
      z.object({ agentId: z.string() }).strict(),
    ])
    .optional(),
});
export type SendPromptParams = z.infer<typeof SendPromptParamsSchema>;

/** result for "send_prompt" — at-least-once enqueue confirmation (V0.5.Q6). */
export const SendPromptResultSchema = z.object({
  delivered: z.number().int().nonnegative(),
  recipients: z.array(z.string()),
});
export type SendPromptResult = z.infer<typeof SendPromptResultSchema>;

/** params for "stop" — graceful drain via 4D drain frame. */
export const StopParamsSchema = z.object({
  /** How long to wait for in-flight tasks before escalating to kill. */
  timeoutMs: z.number().int().positive().optional(),
});
export type StopParams = z.infer<typeof StopParamsSchema>;

/** params for "kill" — immediate termination. */
export const KillParamsSchema = z.object({}).strict();
export type KillParams = z.infer<typeof KillParamsSchema>;

/** ack-only result shared by "stop" and "kill". */
export const AcknowledgedResultSchema = z.object({
  acknowledged: z.literal(true),
});
export type AcknowledgedResult = z.infer<typeof AcknowledgedResultSchema>;

// ---------------------------------------------------------------------------
// Notification schemas
// ---------------------------------------------------------------------------

/**
 * params for "team_event" notification — a forwarded LaneEvent.
 *
 * Schema is `passthrough` because LaneEvent is a discriminated union defined
 * in src/swarm/events.ts; the daemon serialises whatever it gets from
 * `host.events()` and consumers narrow on `type` themselves. Keeping the
 * notification opaque here avoids coupling the protocol module to the full
 * LaneEvent type tree.
 */
export const TeamEventParamsSchema = z
  .object({
    ts: z.number(),
  })
  .passthrough();
export type TeamEventParams = z.infer<typeof TeamEventParamsSchema>;
