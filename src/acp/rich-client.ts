/**
 * RichClient (B2.2, docs/35 §3) — the swarm-aware ACP client's core: an ACP
 * `Client` that folds `session/update`s into a RichRenderer and renders
 * per-member lanes. The reference rich client by construction (Q5) — it speaks
 * plain ACP-with-`_meta.swarm`, so the same agent drives stock Zed (collapsed)
 * and this (richly).
 *
 * This module is the testable core (the Client impl + render). The interactive
 * shell — spawn `acp`, read operator input, send `swarm/steer` — lives in the
 * thin binary (scripts/acp-rich-client.ts) that wires this to real I/O.
 */

import type {
  Client,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { RichRenderer } from "./rich-view.js";
import { formatRichView } from "./rich-format.js";

export interface RichClientOptions {
  /** Decide a permission prompt. Default: allow once. */
  readonly onPermission?: (
    req: RequestPermissionRequest,
  ) => RequestPermissionResponse;
  /** Called after each applied update so a front-end can repaint. */
  readonly onChange?: () => void;
}

const ALLOW_ONCE: RequestPermissionResponse = {
  outcome: { outcome: "selected", optionId: "allow" },
};

export class RichClient implements Client {
  readonly renderer = new RichRenderer();
  private readonly onPermission: (
    req: RequestPermissionRequest,
  ) => RequestPermissionResponse;
  private readonly onChange?: () => void;

  constructor(opts: RichClientOptions = {}) {
    this.onPermission = opts.onPermission ?? (() => ALLOW_ONCE);
    this.onChange = opts.onChange;
  }

  async sessionUpdate(n: SessionNotification): Promise<void> {
    this.renderer.apply(n.update);
    this.onChange?.();
  }

  async requestPermission(
    req: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    return this.onPermission(req);
  }

  /** Current rich view as terminal lines. */
  render(): string[] {
    return formatRichView(this.renderer.view());
  }
}
