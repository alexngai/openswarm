#!/usr/bin/env python3
"""MBPP execution harness (docs/62 Phase 1.5 — MBPP scale-out).

MBPP has no docstring `>>>` examples like HumanEval; each problem ships a
`test_list` of assert statements. To keep the escalation signal leakage-free we
SPLIT that list (the caller does it): the model is shown the FIRST assert (which
also conveys the function name/signature) and it becomes the visible-test signal;
the REMAINING asserts are held out as the hidden oracle the model never saw.

Emits JSON with the same shape as humaneval_exec.py so the row schema and the
`humaneval-frontier.ts` analyzer are unchanged:
  - `hidden`     : did ALL held-out asserts pass? (the oracle correctness label)
  - `dt_attempt` / `dt_fail` : visible asserts attempted / failed
                               → sig_visible = (attempt-fail)/attempt

WARNING: exec()s untrusted model-generated code — the standard MBPP/HumanEval risk.
Run only on the vetted MBPP benchmark, in a subprocess with a wall-clock timeout
(the caller enforces it), in a scratch cwd.

Usage: mbpp_exec.py <completion_file> <visible_file> <hidden_file> <setup_file>
Each *_file holds code/asserts read from disk (never string-interpolated) to avoid
injection into this harness. visible/hidden files are newline-separated asserts.
"""
import sys, json, io, contextlib


def _run_asserts(asserts, ns):
    """Return the number that failed (raised)."""
    failed = 0
    for t in asserts:
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                exec(t, ns)
        except Exception:  # noqa: BLE001
            failed += 1
    return failed


def main() -> int:
    completion_f, visible_f, hidden_f, setup_f = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    completion = open(completion_f).read()
    visible = [l for l in open(visible_f).read().splitlines() if l.strip()]
    hidden = [l for l in open(hidden_f).read().splitlines() if l.strip()]
    setup = open(setup_f).read()

    # Build the module namespace: setup (imports) + the model's completion. MBPP has no
    # signature prompt, so an instruct model returns the whole function definition.
    ns: dict = {}
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            exec(setup + "\n" + completion, ns)
    except Exception as e:  # noqa: BLE001
        # Won't import/parse → all visible fail, oracle fails.
        print(json.dumps({"hidden": False, "dt_attempt": len(visible), "dt_fail": len(visible),
                          "err": f"exec:{type(e).__name__}:{e}"[:120]}))
        return 0

    # Visible-test signal (the assert shown in the prompt).
    dt_fail = _run_asserts(visible, ns)
    # Hidden oracle: every held-out assert must pass.
    hidden_ok = _run_asserts(hidden, ns) == 0

    print(json.dumps({"hidden": hidden_ok, "dt_attempt": len(visible), "dt_fail": dt_fail}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
