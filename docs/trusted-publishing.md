# Publishing dsh-shared-browser

Two registries are served by one workflow, [`.github/workflows/release.yml`](../.github/workflows/release.yml),
which runs on every push to `main`.

| Registry | Package name | Authentication |
| --- | --- | --- |
| `registry.npmjs.org` | `dsh-shared-browser` | npm trusted publishing (OIDC), `NPM_TOKEN` secret as fallback |
| `npm.pkg.github.com` | `@feigenb/dsh-shared-browser` | workflow `GITHUB_TOKEN` with `packages: write` |

A GitHub Release tagged `v<version>` with the packed `.tgz` attached is created for
every new version, before either registry is touched.

## What one push does

1. `Pack the bundle` - `npm pack`, so the published bytes are exactly the tarball
   the release carries.
2. `Create GitHub Release` - tag `v<version>` plus `dsh-shared-browser-<version>.tgz`.
3. `Publish to npm` - trusted publishing: npm exchanges the Actions OIDC token for a
   short-lived credential, so no long-lived token is required. If that handshake
   fails, the step retries with the `NPM_TOKEN` repository secret.
4. `Publish a scoped mirror to GitHub Packages` - the same tarball, unpacked,
   renamed to `@feigenb/dsh-shared-browser` and published to `npm.pkg.github.com`.
   GitHub Packages only accepts scoped names, which is the only reason this mirror
   exists.

The workflow is idempotent: if `refs/tags/v<version>` already exists, the publish
steps are skipped, so re-running it or pushing without a version bump is harmless.

## Trusted publishing (OIDC) setup

The npm package page has a **Trusted Publisher** connection that must match this
repository. The connection is set up once on npmjs.com and then validated by the
first successful publish.

Fields used for `dsh-shared-browser`:

| Field | Value |
| --- | --- |
| Publisher | `GitHub Actions` |
| Organization or user | `FeiGenb` |
| Repository | `dsh-shared-browser` |
| Workflow filename | `release.yml` (file name only) |
| Environment name | *empty* - this workflow does not use GitHub Environments |
| Allowed actions | `Allow npm publish` checked, `Allow npm dist-tag` checked |

Requirements on the workflow side:

- `permissions: id-token: write` - mandatory, it is what lets npm obtain the OIDC token.
- npm CLI `>= 11.5.1` on the runner - the workflow upgrades npm explicitly, because
  the Node 22 image still ships npm 10.x.
- No `NODE_AUTH_TOKEN` and no `registry-url` in `actions/setup-node` - setup-node would
  write a `:_authToken=${NODE_AUTH_TOKEN}` placeholder into `.npmrc`, and an unset
  variable breaks the OIDC publish path. The registry is passed with
  `--registry=https://registry.npmjs.org/` instead.

If the workflow file is renamed or the repository is renamed, the connection stops
matching and publishing fails; recreate the connection on npmjs.com in that case.

## One path only: push to main

A GitHub push to `main` is the single source of truth for a release. The workflow
tags the version, creates the GitHub Release, publishes to npmjs.org and publishes
the GitHub Packages mirror - all from the same tarball, in one run.

Publishing from a workstation is therefore blocked on purpose: `package.json` has a
`prepublishOnly` hook ([`scripts/publish-guard.mjs`](../scripts/publish-guard.mjs))
that refuses to run outside GitHub Actions. A local `npm publish` would produce a
version with no tag, no release and no mirror behind it, and the two registries would
drift apart immediately.

To rehearse a release locally, pack it:

```bash
npm run check && npm pack      # inspect the tarball, publish nothing
```

## Installing from the GitHub Packages mirror

```ini
@feigenb:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

`GITHUB_TOKEN` here is a personal access token (classic) with at least
`read:packages`. Most DSH users should install the npmjs package instead - the
mirror exists for automation that already has a GitHub identity.
