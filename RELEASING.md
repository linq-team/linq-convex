# Releasing

Releases are proposed by [changesets](https://github.com/changesets/changesets) and published
by `.github/workflows/publish.yml` over npm trusted publishing (OIDC). The version that ships is
the one in `package.json`.

## Normal flow

1. **Add a changeset in the PR that makes the change.**

   ```sh
   npx changeset   # needs Node 22+
   ```

   Pick `patch`, `minor` or `major` and write the line users will read in the changelog. Commit
   the file it creates under `.changeset/`. A PR with no user-visible change needs none.

2. **Merge to `main`.** The Version workflow opens or updates a **Version Packages** PR that
   applies every pending changeset: it bumps `package.json` and writes `CHANGELOG.md`.

3. **Run CI on the Version Packages PR's latest commit.** The Version workflow uses
   `GITHUB_TOKEN`, so its bot-created commits do not automatically run all checks.
   In **Actions → CI → Run workflow**, select the PR's head branch (usually
   `changeset-release/main`), then run it. From the CLI, use:

   ```sh
   gh workflow run ci.yml --repo linq-team/linq-convex --ref changeset-release/main
   ```

   Use the actual head branch shown on the PR. Confirm the completed `check` job's head SHA
   matches the PR's latest commit and that the required check is green before merging.
   Repeat after every update to the version PR; running CI on `main` does not validate the
   version PR. If GitHub offers **Approve workflows to run** for the bot PR, approving its
   pending CI run is also sufficient once it succeeds on that same latest commit.

4. **Merge the Version Packages PR.** That changes `package.json`, which triggers
   `publish.yml`: it builds, typechecks, tests, publishes to npm, tags `v<version>` and cuts a
   GitHub release. If that version is already on npm it skips publication and repairs missing
   release metadata after verifying the published source.

Publication runs only on protected `main`, through the `npm-convex-release` environment.
Require review and passing CI on `main`, and restrict the environment to protected branches.
The Version Packages PR is the normal release gate. A maintainer can also dispatch the same
workflow on `main`; it uses the exact version in the reviewed `package.json`.

The Version and Publish workflows install dependencies with `npm ci --ignore-scripts` to
skip dependency lifecycle scripts while holding release permissions. Publish then explicitly
builds, typechecks, and tests the package before publishing with npm `12.2.2` (pinned; supports
OIDC and requires Node `24.15.0` or later on the Node 24 line). The version workflow only
updates release metadata and does not need a build.

`changesets/action` does not publish because it runs the publish command as a child process
without the OIDC token, so `npm publish` fails `ENEEDAUTH`
([npm/cli#8976](https://github.com/npm/cli/issues/8976)).

## One-time setup

npm only lets you add a trusted publisher to a package that already exists. For the first
release, configure a short-lived, scope-limited `NPM_TOKEN` in the protected
`npm-convex-release` environment and dispatch `publish.yml` on `main` with
`bootstrap_with_token: true`. The workflow builds and tests the package before publishing it
with provenance. Make the repository public before publishing with provenance.

Then on npmjs.com, open `@linqapp/convex` → Settings → **Trusted Publisher** → GitHub Actions:

| Field             | Value         |
| ----------------- | ------------- |
| Organization/user | `linq-team`   |
| Repository        | `linq-convex` |
| Workflow filename | `publish.yml` |
| Environment       | `npm-convex-release` |
| Allowed actions   | `npm publish` (staged publishing is also allowed) |

Validate the new publisher by making its first tokenless release within npm's validation
window. Then revoke the temporary token and delete the environment's `NPM_TOKEN`. Normal
releases leave `bootstrap_with_token` disabled. Do not add repository-wide npm credentials.

On the same page, set **Publishing access** to require 2FA and disallow tokens, so only the
workflow can publish. Renaming or moving `publish.yml` breaks publishing until this entry is
updated.

The normal publish step uses OIDC with no npm token. Only the explicit first-release bootstrap
path reads the environment-scoped token.

## Recovering a partial release

Rerun the workflow if npm succeeded but creating the tag or GitHub release failed. An existing
npm version is checked for repository identity and source commit; that commit must be an
ancestor of reviewed `main` and contain the same package name/version. Source and existing
tag checks run before any publication. The workflow then independently repairs the tag
and GitHub release. It refuses to reuse a tag that points to a different commit. A registry
lookup failure other than 404 fails closed and never triggers a speculative publish.

## Publishing by hand

Prefer repairing the reviewed Actions workflow. An emergency manual release must preserve the
reviewed source commit, package version, tests, and matching release tag; it will not have the
same Actions provenance as the normal path.
