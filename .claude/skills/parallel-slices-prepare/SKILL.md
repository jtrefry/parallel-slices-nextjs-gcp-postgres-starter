---
name: parallel-slices-prepare
description: Generate the exact Claude Code /goal invocation for an approved Parallel Slices milestone without starting it.
disable-model-invocation: true
---

# Prepare a Claude Code goal

Run `node scripts/parallel-slices/agent-profile.mjs require-enabled claude-code`
before taking any other action. Stop if Claude Code support is not enabled.

Read `docs/parallel-slices/prepare-controller.md` completely and follow it to
generate the exact copy-paste invocation for a Claude Code-owned `/goal` run.
Do not start the goal yourself.
