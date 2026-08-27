/**
 * mount.tsx — JSX-containing shim that calls @opentui/solid's `render`.
 *
 * Kept separate from `index.ts` so main tsc (jsx: "react-jsx") never
 * tries to compile Solid JSX. The scoped tsconfig in this directory
 * handles .tsx with jsx: "preserve" + jsxImportSource @opentui/solid;
 * Bun's preload plugin handles the transform at runtime.
 */

import { render } from "@opentui/solid";
import { App } from "./app.js";
import type { AppProps } from "./types.js";

/**
 * Start the OpenTUI render loop for the Solid REPL. Returns render()'s
 * promise — which typically stays pending for the TUI's lifetime. The
 * caller should gate resolution on App's `onExit` callback, not on this
 * returned promise.
 */
export function mountSolidRender(props: AppProps): Promise<void> {
  return render(() => <App {...props} />);
}
