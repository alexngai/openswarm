"""Standalone tests for openswarm_stream — run with ``python3 test_openswarm_stream.py``.

No pytest / Harbor dependency, so it works in any Python 3.10+ environment.
"""

import json

from openswarm_stream import parse_openswarm_stream


def _line(obj: dict) -> str:
    return json.dumps(obj)


def test_happy_path() -> None:
    stdout = "\n".join(
        [
            "[openswarm] discovering plugins...",  # noise line — must be skipped
            _line({"type": "text_delta", "text": "Hello "}),
            _line({"type": "tool_use_start", "name": "write_file"}),
            _line({"type": "text_delta", "text": "world"}),
            _line(
                {
                    "type": "message_stop",
                    "usage": {"inputTokens": 120, "outputTokens": 8, "cacheReadInputTokens": 50},
                }
            ),
        ]
    )
    r = parse_openswarm_stream(stdout)
    assert r.text == "Hello world", r.text
    assert r.tool_names == ["write_file"], r.tool_names
    assert r.usage.input_tokens == 120
    assert r.usage.output_tokens == 8
    assert r.usage.cache_read_tokens == 50
    assert r.usage.total_tokens == 178
    assert not r.is_error


def test_error_event() -> None:
    stdout = _line(
        {"type": "error", "error": {"code": "transport", "message": "Claude Code process exited"}}
    )
    r = parse_openswarm_stream(stdout)
    assert r.is_error
    assert r.error_message == "Claude Code process exited"
    assert r.text == ""


def test_snake_case_usage() -> None:
    stdout = _line(
        {"type": "message_stop", "usage": {"input_tokens": 5, "output_tokens": 3, "cache_read_input_tokens": 1}}
    )
    r = parse_openswarm_stream(stdout)
    assert r.usage.input_tokens == 5 and r.usage.output_tokens == 3 and r.usage.cache_read_tokens == 1


def test_multiple_turns_accumulate() -> None:
    stdout = "\n".join(
        [
            _line({"type": "text_delta", "text": "a"}),
            _line({"type": "message_stop", "usage": {"inputTokens": 10, "outputTokens": 2}}),
            _line({"type": "text_delta", "text": "b"}),
            _line({"type": "message_stop", "usage": {"inputTokens": 20, "outputTokens": 4}}),
        ]
    )
    r = parse_openswarm_stream(stdout)
    assert r.text == "ab"
    assert r.usage.input_tokens == 30 and r.usage.output_tokens == 6


def test_garbage_only() -> None:
    r = parse_openswarm_stream("not json at all\nanother line")
    assert r.text == "" and r.usage.total_tokens == 0 and not r.is_error


def test_bool_not_counted_as_int() -> None:
    # A stray boolean in a usage field must not be coerced to 1.
    stdout = _line({"type": "message_stop", "usage": {"inputTokens": True, "outputTokens": 7}})
    r = parse_openswarm_stream(stdout)
    assert r.usage.input_tokens == 0 and r.usage.output_tokens == 7


def _run() -> None:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"ok  {t.__name__}")
    print(f"\n{len(tests)} passed")


if __name__ == "__main__":
    _run()
