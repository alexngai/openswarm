/**
 * store.ts — Solid binding over the pure REPL reducer.
 *
 * Phase 0 migration (docs/16-parity-plan.md): replaces the React `useReducer`
 * binding in src/ui/repl/app.tsx with a Solid `createStore` that preserves the
 * exact reducer semantics. The reducer itself (../repl/state.ts) is
 * framework-agnostic and is not rewritten — this file only adapts it to
 * Solid's reactivity primitives.
 */

import { createStore, reconcile } from "solid-js/store";
import {
  createInitialState,
  reduce,
  type InitialStateOptions,
  type ReplEvent,
  type ReplState,
} from "../repl/state.js";

export interface ReplStore {
  /** Reactive store proxy. Reads inside Solid computations create tracked deps. */
  readonly state: ReplState;
  /** Dispatch a reducer event; triggers reactive updates on any field that changed. */
  readonly dispatch: (event: ReplEvent) => void;
}

export function createReplStore(opts?: InitialStateOptions): ReplStore {
  const [state, setState] = createStore<ReplState>(createInitialState(opts));
  const dispatch = (event: ReplEvent): void => {
    const next = reduce(state, event);
    // reconcile diffs `next` against current store contents and applies the
    // minimum set of granular mutations — preserving Solid's fine-grained
    // reactivity. Using setState(next) directly would replace-by-identity and
    // trigger broader re-renders.
    setState(reconcile(next));
  };
  return { state, dispatch };
}
