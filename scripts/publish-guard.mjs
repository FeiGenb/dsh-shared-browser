#!/usr/bin/env node
// npm publishes are only allowed from the release workflow.
//
// Rationale: a GitHub push to main is the single source of truth. The workflow
// tags the version, creates the GitHub Release, publishes to registry.npmjs.org
// and publishes the scoped mirror to npm.pkg.github.com - all from the same
// tarball. A local "npm publish" would produce a version that no tag, no release
// and no mirror entry point at, and it would also be the only way a long-lived
// publish token could leak into the release history.
//
// The workflow publishes a pre-built tarball (npm publish <file>.tgz), which
// does not run lifecycle scripts, so this guard never fires in CI.

const inActions = process.env.GITHUB_ACTIONS === 'true' && process.env.CI === 'true';

if (!inActions) {
  console.error('');
  console.error('  Publishing from a workstation is disabled.');
  console.error('');
  console.error('  Push to main instead - .github/workflows/release.yml will:');
  console.error('    1. pack the tarball and attach it to a GitHub Release v<version>');
  console.error('    2. publish to registry.npmjs.org via OIDC trusted publishing');
  console.error('    3. publish the @feigenb/... mirror to npm.pkg.github.com');
  console.error('');
  console.error('  To rehearse locally without publishing:  npm pack');
  console.error('');
  process.exit(1);
}
