import { tacDockerArms, type Arm } from "swarmkit-eval";

const BASE_TAC_ARM_IDS = new Set(["stock", "notes", "opentasks", "opentasks-team-contract"]);

const ACCEPTANCE_CHECKLIST_ARM: Arm = {
  id: "acceptance",
  label: "Acceptance checklist",
  scaffold: {
    systemPromptAppendix: [
      "Use an evaluator-facing acceptance checklist for this TAC task.",
      "",
      "Before making task-specific changes, read /instruction/task.md and create /workspace/ACCEPTANCE.md with:",
      "- the task objective in one sentence;",
      "- the exact acceptance surface the evaluator or user will inspect, distinguishing local repository state, GitLab remote state, GitLab UI objects, pipeline state, wiki pages, releases, images/assets, and running services;",
      "- the concrete project, repository path, branch/ref, issue/MR/release/wiki/page/file paths, and API/UI URLs involved;",
      "- the verification actions you will run after implementation, including the command/API/UI surface that proves the requested artifact exists in the expected place.",
      "",
      "During work, keep /workspace/ACCEPTANCE.md current when the target or evidence changes.",
      "",
      "Before finalizing, re-read /instruction/task.md and /workspace/ACCEPTANCE.md. Do not stop because your implementation surface looks right. Stop only after each checklist item has concrete evidence from the acceptance surface.",
      "",
      "If the task requires a local repository branch or file, verify it in the local repository, not only on GitLab. If the task requires GitLab state, verify the exact GitLab object in the requested project/ref via API or browser. If the task involves CI or a GitLab editor/pipeline workflow, verify the pipeline/editor-facing state, not just that a file was committed.",
      "",
      "For repo-change tasks, preserve the clone layout implied by the task. If the task says to clone a GitLab repo to `/workspace`, a normal `git clone URL` from `/workspace` creates `/workspace/<repo>` and that nested repo may be the evaluator-facing local repository. Do not move a nested clone into `/workspace` unless the task or checkpoint explicitly says `/workspace` itself must be the repo root. When ambiguous, verify candidate local repo paths explicitly with `git -C /workspace rev-parse --show-toplevel` and `git -C /workspace/<repo> rev-parse --show-toplevel`, then run final branch/file checks with absolute `git -C <repo>` and absolute file paths.",
      "",
      "For generated structured data, preserve exact value labels requested by the task. For example, if the task asks for gender parity among `male` and `female`, use literal `male` and `female` values in the field the evaluator is likely to inspect, not synonyms such as `Man` or `Woman`.",
      "",
      "For code tasks, run the closest available test/build/check and inspect failures. Treat visible passing tests as necessary but not sufficient when sanitizer, hidden-test, or evaluator-specific checks are plausible; add at least one targeted check for the requested behavior.",
      "",
      "If an external source or asset is unavailable, do not silently substitute a different artifact. Record the blocker and either keep working toward the requested source or make the smallest justifiable alternative with explicit evidence.",
    ].join("\n"),
  },
};

export function tacExperimentArms(ids: readonly string[]): Arm[] {
  return ids.map((id) => {
    if (id === "acceptance" || id === "acceptance-checklist" || id === "checklist") {
      return ACCEPTANCE_CHECKLIST_ARM;
    }
    if (BASE_TAC_ARM_IDS.has(id)) {
      return tacDockerArms([id as "stock" | "notes" | "opentasks" | "opentasks-team-contract"])[0]!;
    }
    throw new Error(`Unknown TAC arm '${id}'. Supported: stock, notes, opentasks, opentasks-team-contract, acceptance`);
  });
}
