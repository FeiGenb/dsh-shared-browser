# Publishing to GitHub Packages as well as npm

## Why an extra step is needed

GitHub Packages **only accepts scoped names** (`@namespace/package`), while this
plugin is published to the public npm registry under the unscoped name
`dsh-shared-browser` (that is what users type in the DSH marketplace).

npm and GitHub Packages are separate registries with separate namespaces, so the
same sources are published twice:

| Registry | Package name | Auth |
| --- | --- | --- |
| `registry.npmjs.org` | `dsh-shared-browser` | `NPM_TOKEN` repository secret (granular token, *Publish* + *Bypass 2FA*) |
| `npm.pkg.github.com` | `@feigenb/dsh-shared-browser` | the workflow `GITHUB_TOKEN` with `packages: write` |

`release.yml` does the second publish automatically: it exports the commit with
`git archive`, rewrites `name` to the scoped form, points `publishConfig.registry`
at GitHub Packages, packs again and publishes. No personal access token is
involved, and the package is linked to this repository because `repository` is
set in `package.json`.

## Installing the GitHub Packages build

GitHub Packages requires authentication even for public packages, so a project
that wants the mirror needs a `.npmrc` with the scope mapping and a token:

```ini
@feigenb:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

The token can be a classic PAT with at least `read:packages`; inside GitHub
Actions use `secrets.GITHUB_TOKEN` (the repository is linked to the package, so
it already has read access). Then:

```bash
npm install @feigenb/dsh-shared-browser
```

For DSH itself, install the npmjs build instead — it needs no credentials:

```bash
dsh plugin add dsh-shared-browser
```

## Publishing multiple packages to the same repository

Any package whose `package.json` carries the same `repository` URL is linked to
this repository automatically, which is why the mirror inherits this repo's
access rules instead of needing manual visibility settings.
