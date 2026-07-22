---
name: parallel-slices-plan
description: Create a human-approved Parallel Slices Product Plan, then apply the configured slice-sizing strategy and AI-compile it into validated version 2 manifests, version 4 JSON state, dependencies, locks, and Ready Slices. Use for feature, fix, foundation, or re-planning work before implementation.
---

# Plan a Parallel Slices milestone

Run `node scripts/parallel-slices/agent-profile.mjs require-enabled claude-code`
before taking any other action. Stop if Claude Code support is not enabled.

Read `docs/parallel-slices/plan-milestone.md` completely and follow it as the
authoritative planning workflow. Do not implement application code. Present the
Product Plan alone for explicit approval, commit it, then compile and commit the
machine execution files separately without requesting a second approval.
