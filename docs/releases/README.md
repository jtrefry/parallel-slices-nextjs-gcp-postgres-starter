# Release notes

Capture release-note fragments while each slice is built. Assemble and publish
them only during the project's existing release process.

Developer fragments answer what changed, which workspace packages, contracts,
configuration, or dependencies are affected, how the change was validated, and
what needs rollout or monitoring attention.

The scope manifest declares the classification and includes the exact fragment
paths in its allowlist. The Parallel Slices gate checks the required fragment and
its template. Pre-push and pull-request CI repeat that validation across all
new scope manifests and release fragments on the branch.

Unreleased fragments are evidence, not automatically approved publication copy.
Review feature flags, audience, rollout state, and security implications before
publishing them.
