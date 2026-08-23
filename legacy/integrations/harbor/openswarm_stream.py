"""Pure-stdlib parser for openswarm's headless JSONL stream.

openswarm's ``prompt --headless --output-format json`` mode emits a JSONL *stream*
of events (one JSON object per line):

    {"type": "text_delta", "text": "..."}          assistant text chunk
    {"type": "tool_use_start", "name": "write_file"} a tool call started
    {"type": "message_stop", "usage": {...}}         end of a turn, carries token usage
    {"type": "error", "error": {...}}                a run error

This module has **no dependency on Harbor** so it can be unit-tested standalone
(``python3 test_openswarm_stream.py``). It is the Python mirror of the TypeScript
``openSwarmParse`` in swarmkit-eval (``adapters/harness/cli-adapter.ts``) and of the
HAL bridge's ``_parse_openswarm_stream`` (``adapters/hal/agent/main.py``) — keep the
three in sync.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field


@dataclass
class OpenswarmUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens + self.cache_read_tokens


@dataclass
class OpenswarmResult:
    """Everything the Harbor agent needs out of an openswarm headless run."""

    text: str = ""
    usage: OpenswarmUsage = field(default_factory=OpenswarmUsage)
    tool_names: list[str] = field(default_factory=list)
    is_error: bool = False
    error_message: str | None = None


def _num(value: object) -> int:
    if isinstance(value, bool):  # bool is an int subclass — exclude it explicitly
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    return 0


def _usage_field(usage: dict, *names: str) -> int:
    """First present numeric field among ``names`` (camelCase or snake_case)."""
    for name in names:
        if name in usage:
            return _num(usage[name])
    return 0


def parse_openswarm_stream(stdout: str) -> OpenswarmResult:
    """Parse an openswarm headless JSONL stream into an :class:`OpenswarmResult`.

    Robust to interleaved non-JSON lines (e.g. ``[openswarm] discovering plugins...``
    printed to stdout) — any line that does not parse as a JSON object is skipped.
    """
    result = OpenswarmResult()
    chunks: list[str] = []

    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except Exception:  # noqa: BLE001 — tolerate partial / non-JSON lines
            continue
        if not isinstance(obj, dict):
            continue

        kind = obj.get("type")
        if kind == "text_delta":
            text = obj.get("text")
            if isinstance(text, str):
                chunks.append(text)
        elif kind == "tool_use_start":
            name = obj.get("name")
            result.tool_names.append(name if isinstance(name, str) else "tool")
        elif kind == "error":
            result.is_error = True
            err = obj.get("error")
            if isinstance(err, dict) and isinstance(err.get("message"), str):
                result.error_message = err["message"]
            elif isinstance(err, str):
                result.error_message = err
        elif kind == "message_stop":
            usage = obj.get("usage")
            if isinstance(usage, dict):
                result.usage.input_tokens += _usage_field(usage, "inputTokens", "input_tokens")
                result.usage.output_tokens += _usage_field(usage, "outputTokens", "output_tokens")
                result.usage.cache_read_tokens += _usage_field(
                    usage, "cacheReadInputTokens", "cache_read_input_tokens"
                )

    result.text = "".join(chunks).strip()
    return result
