@../AGENTS.md

# Claude Code Parallel Slices adapter

This repository supports Codex, Cursor, and Claude Code concurrently. The
default convenience controller is recorded in `.parallel-slices/agent.json`; it is
not an exclusive ownership switch. Verify Claude Code support with:

```bash
node scripts/parallel-slices/agent-profile.mjs require-enabled claude-code
```

Initialization may use any enabled controller. A sliced-plan run has exactly
one owner recorded in its JSON state and ignored local run lease. Acquire that
lease before lifecycle work, and never compete with another controller's run.
The root `/goal` thread orchestrates fresh workers and must not implement slice
code itself.
