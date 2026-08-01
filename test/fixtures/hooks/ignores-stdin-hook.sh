#!/usr/bin/env bash
# ignores-stdin-hook — emits an empty JSON body and exits 0 WITHOUT reading its
# stdin payload. A legitimate hook shape: a hook that only cares that an event
# fired has no reason to read the body.
#
# Every other fixture here drains stdin with `cat >/dev/null`, which is why the
# EPIPE crash this guards against never showed up in the suite: the payload was
# always consumed, so the pipe never broke under the writer.
echo "{}"
exit 0
