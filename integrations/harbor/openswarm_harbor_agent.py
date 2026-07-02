"""``openswarm`` as a Harbor benchmark agent.

Registered with Harbor by **import path** (no Harbor fork needed) — the ``:`` in the
``-a`` value routes through ``harbor.agents.factory.create_agent_from_import_path``::

    PYTHONPATH=/path/to/openswarm/integrations/harbor \\
    harbor run <task> \\
      -a openswarm_harbor_agent:OpenswarmAgent \\
      -m anthropic/claude-sonnet-4-6 \\
      --ae ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY

From swarmkit-eval's swe-atlas adapter this is just
``agent: "openswarm_harbor_agent:OpenswarmAgent"`` plus a ``PYTHONPATH`` entry in the
Harbor command env (see ``README.md``).

Design (approach B — dedicated ``BaseInstalledAgent``, chosen over the generic ACP
agent): openswarm's headless ``--output-format json`` stream carries per-turn token
usage (``message_stop.usage``) and takes the model as an explicit ``--model`` flag,
whereas its ACP server emits **no** usage and ignores ACP-level model selection. So a
dedicated agent that shells out to ``openswarm prompt … --headless`` gives us cost
accounting and model routing that the ACP path cannot. The agent edits the workspace
directly on disk (no client fs delegation), so Harbor's diff-based verifier grades it
with no extra cooperation.
"""

from __future__ import annotations

import shlex
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

from openswarm_stream import parse_openswarm_stream

# Auth / gateway env we forward into the sandbox if present (via --ae or the host env).
# openswarm itself owns no credentials — it lets the underlying Claude Agent SDK read
# these. ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN cover the LiteLLM-gateway route.
_FORWARDED_ENV = (
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_MODEL",
)

_DEFAULT_PERMISSION_MODE = "danger-full-access"


class OpenswarmAgent(BaseInstalledAgent):
    """Drives the openswarm CLI in headless single-agent mode."""

    # openswarm's headless stream is not ATIF; we populate token usage but skip the
    # (optional) ATIF trajectory conversion.
    SUPPORTS_ATIF = False

    def __init__(
        self,
        *args: Any,
        permission_mode: str = _DEFAULT_PERMISSION_MODE,
        model_override: str | None = None,
        swarm: bool = False,
        install_spec: str = "openswarm@latest",
        binary_dir: str | None = None,
        **kwargs: Any,
    ) -> None:
        """
        Extra ``--ak`` kwargs (all optional):
          permission_mode  openswarm --permission-mode (default danger-full-access;
                           full access keeps headless turns from blocking on prompts)
          model_override   pass this verbatim to --model instead of the Harbor -m name
                           (use for gateway ids openswarm expects in a specific shape)
          swarm            if true, drop --single and let openswarm run its coordinator
                           team (multi-agent). Default false = single agent.
          install_spec     npm spec installed by install() (default openswarm@latest)
          binary_dir       host path to a self-contained compiled build dir
                           (``openswarm`` + co-located ``claude`` + ``libopentui.*``,
                           e.g. packages/cli-linux-<arch>/). When set, install()
                           uploads it into the container and runs that binary instead
                           of installing from npm — use it to test a local/unpublished
                           build. The arch must match the container's.
        """
        super().__init__(*args, **kwargs)
        self._permission_mode = permission_mode
        self._model_override = model_override
        self._swarm = swarm
        self._install_spec = install_spec
        self._binary_dir = binary_dir
        # Where the openswarm executable lives inside the container.
        self._remote_bin = "/opt/openswarm/openswarm" if binary_dir else "openswarm"

    @staticmethod
    def name() -> str:
        return "openswarm"

    def get_version_command(self) -> str | None:
        return f"{self._remote_bin} --version"

    async def install(self, environment: BaseEnvironment) -> None:
        if self._binary_dir is not None:
            # Inject a self-contained compiled build (no npm). The bun binary resolves
            # its co-located `claude`/libopentui next to process.execPath, so uploading
            # the whole dir keeps them together.
            await self.exec_as_root(environment, command="mkdir -p /opt/openswarm")
            await environment.upload_dir(self._binary_dir, "/opt/openswarm")
            await self.exec_as_root(
                environment,
                command="chmod +x /opt/openswarm/openswarm /opt/openswarm/claude",
            )
            await self.exec_as_agent(environment, command=f"{self._remote_bin} --version")
            return

        # Node/npm as root (best-effort — many benchmark images already ship node).
        await self.exec_as_root(
            environment,
            command=(
                "if ! command -v npm >/dev/null 2>&1; then "
                "  (command -v apt-get >/dev/null 2>&1 && apt-get update && "
                "     apt-get install -y --no-install-recommends nodejs npm) || "
                "  (command -v apk >/dev/null 2>&1 && apk add --no-cache nodejs npm) || true; "
                "fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        await self.exec_as_agent(
            environment,
            command=f"npm install -g {shlex.quote(self._install_spec)} && openswarm --version",
        )

    def _resolve_model(self) -> str:
        if self._model_override:
            return self._model_override
        # Harbor hands us e.g. "anthropic/claude-sonnet-4-6"; openswarm wants the bare
        # id/alias for Anthropic. Strip a leading "anthropic/" provider; pass anything
        # else through untouched (gateway routes keep their provider prefix).
        if self._parsed_model_provider in (None, "anthropic"):
            return self._parsed_model_name or self.model_name or ""
        return self.model_name or ""

    def _run_env(self) -> dict[str, str]:
        env: dict[str, str] = {}
        for key in _FORWARDED_ENV:
            val = self._get_env(key)
            if val is not None:
                env[key] = val
        return env

    def _build_command(self, instruction: str, log_path: str) -> str:
        model = self._resolve_model()
        if not model:
            raise ValueError("OpenswarmAgent requires a model (Harbor -m or --ak model_override=)")
        parts = [
            self._remote_bin,
            "prompt",
            shlex.quote(instruction),
            "--headless",
            "--output-format",
            "json",
            "--model",
            shlex.quote(model),
            "--permission-mode",
            shlex.quote(self._permission_mode),
        ]
        if not self._swarm:
            parts.append("--single")  # single agent, not the coordinator team
        # `|| true`: openswarm can exit nonzero (e.g. budget_exceeded → 3) after having
        # already edited the workspace. We still want the verifier to grade those edits,
        # so we swallow the exit code here and detect real errors from the JSONL stream.
        return f"{' '.join(parts)} 2>&1 | tee {shlex.quote(log_path)} || true"

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        log_path = str(EnvironmentPaths.agent_dir / "openswarm.jsonl")
        command = self._build_command(instruction, log_path)
        result = await self.exec_as_agent(environment, command=command, env=self._run_env())

        parsed = parse_openswarm_stream(getattr(result, "stdout", "") or "")
        # Token usage → context (Harbor stores this on TrialResult.agent_result and
        # swarmkit-eval prices it). openswarm's stream carries no per-run cost, so we
        # leave cost_usd unset and let the caller price from tokens.
        context.n_input_tokens = parsed.usage.input_tokens
        context.n_output_tokens = parsed.usage.output_tokens
        context.n_cache_tokens = parsed.usage.cache_read_tokens
        context.metadata = {
            "harness": "openswarm",
            "mode": "swarm" if self._swarm else "single",
            "model": self._resolve_model(),
            "tool_calls": len(parsed.tool_names),
            "is_error": parsed.is_error,
            **({"error_message": parsed.error_message} if parsed.error_message else {}),
        }
        if parsed.is_error:
            self.logger.warning("openswarm reported an error: %s", parsed.error_message)
