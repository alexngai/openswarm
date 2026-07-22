#!/usr/bin/env python3
"""HumanEval execution harness (docs/58 Phase 1).

Given a model completion for one problem, emit JSON with BOTH:
  - `hidden`  : did the hidden test pass? (the oracle correctness label)
  - `dt_attempt`/`dt_fail` : docstring `>>>` doctests attempted/failed
                             → sig_visibletests = (attempt-fail)/attempt when attempt>0

WARNING: exec()s untrusted model-generated code — the standard HumanEval risk.
Run only on the vetted HumanEval benchmark, in a subprocess with a wall-clock
timeout (the caller enforces it), in a scratch cwd.

Usage: humaneval_exec.py <prompt_file> <completion_file> <test_file> <entry_point>
Reads code from files (never string-interpolated) to avoid injection into this harness.
"""
import sys, json, io, contextlib, doctest, re


def main() -> int:
    prompt_f, completion_f, test_f, entry = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    prompt = open(prompt_f).read()
    completion = open(completion_f).read()
    test = open(test_f).read()

    # The visible-test signal runs the PROMPT's docstring `>>>` examples against the
    # model's function — the model's completion often drops the docstring, so we take
    # the examples from the original prompt and attach them to the completed function.
    dm = re.search(r'("""|\'\'\')(.*?)\1', prompt, re.DOTALL)
    orig_doc = dm.group(2) if dm else None

    # Build the module namespace: try the completion alone (instruct models return the
    # whole function); fall back to prompt+completion (models that return only a body).
    ns: dict = {}
    err = None
    for src in (completion, prompt + "\n" + completion):
        ns = {}
        try:
            exec(src, ns)
        except Exception as e:  # noqa: BLE001
            err = f"exec:{type(e).__name__}:{e}"
            continue
        if entry in ns and callable(ns[entry]):
            err = None
            break
    if entry not in ns or not callable(ns.get(entry)):
        print(json.dumps({"hidden": False, "dt_attempt": 0, "dt_fail": 0, "err": err or "no-entry"}))
        return 0

    # Attach the prompt's original docstring (with >>> examples) to the completed function.
    if orig_doc is not None:
        try:
            ns[entry].__doc__ = orig_doc
        except Exception:  # noqa: BLE001
            pass

    # Visible-test signal: run the docstring's >>> examples on the entry function.
    dt_attempt = dt_fail = 0
    try:
        finder = doctest.DocTestFinder(verbose=False, recurse=False)
        runner = doctest.DocTestRunner(verbose=False)
        for t in finder.find(ns[entry], name=entry, globs=ns):
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                r = runner.run(t)
            dt_attempt += r.attempted
            dt_fail += r.failed
    except Exception:  # noqa: BLE001
        pass

    # Hidden test: define check(...) and run it against the entry function.
    hidden = True
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            exec(test, ns)
            ns["check"](ns[entry])
    except Exception:  # noqa: BLE001
        hidden = False

    print(json.dumps({"hidden": hidden, "dt_attempt": dt_attempt, "dt_fail": dt_fail}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
