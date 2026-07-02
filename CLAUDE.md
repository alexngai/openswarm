# Agent Instructions

<!-- SWARMKIT-WIKI:START -->
## SwarmKit Ecosystem Knowledge Base

This repository participates in the SwarmKit ecosystem. Before changing architecture, package boundaries, cross-repo integrations, protocols, task/dispatch behavior, memory/learning flows, workspace/git behavior, or agent orchestration semantics, query the shared knowledge base:

```sh
node /Users/alexngai/GitHub/swarmkit-wiki/scripts/query-knowledge.mjs context --cwd "$PWD"
node /Users/alexngai/GitHub/swarmkit-wiki/scripts/query-knowledge.mjs repo openswarm
node /Users/alexngai/GitHub/swarmkit-wiki/scripts/query-knowledge.mjs interactions openswarm
node /Users/alexngai/GitHub/swarmkit-wiki/scripts/query-knowledge.mjs search "<concept>"
```

Canonical ecosystem memory lives at `/Users/alexngai/GitHub/swarmkit-wiki`.

When this repo changes knowledge that should persist across agents, update the relevant wiki article, semantic model, raw snapshot, graph artifact, or cross-repo interaction data in `swarmkit-wiki`. Do not treat this repo's local `.understand-anything/` cache as canonical; graph artifacts are centralized in `swarmkit-wiki/.understand-anything/graphs/`.
<!-- SWARMKIT-WIKI:END -->
