# Initialize a human-directed, AI-built Next.js application

Run `node scripts/parallel-slices/agent-profile.mjs require-enabled cursor`,
then read `.cursor/skills/parallel-slices-init/SKILL.md` completely and
follow it as the authoritative initialization workflow.

The developer should only need to describe the application, answer product and
operational questions, and approve the resulting Product Plan. The agent
creates and maintains all code, tests, configuration, infrastructure
definitions, diagrams, documentation, release notes, and manual test scripts.

Do not implement application features before the product interview is complete
and the developer explicitly approves the generated Product Plan. Never deploy,
create cloud resources, or run a production migration as part of
initialization. Local Git initialization, goal-branch creation, the approved
Product Plan commit, and the separate AI-compiled execution commit follow the
canonical workflow. Branch push and the single goal-level pull request occur
only after the implementation milestone is complete and
`.parallel-slices/repository.json` authorizes GitHub publication.
