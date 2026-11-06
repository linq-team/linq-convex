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

3. **Merge the Version Packages PR.** That changes `package.json`, which triggers
   `publish.yml`: it builds, typechecks, tests, publishes to npm, tags `v<version>` and cuts a
   GitHub release. If that version is already on npm it does nothing.

Nothing publishes until step 3, so the Version Packages PR is the release gate.

`changesets/action` does not publish because it runs the publish command as a child process
without the OIDC token, so `npm publish` fails `ENEEDAUTH`
([npm/cli#8976](https://github.com/npm/cli/issues/8976)).

## One-time setup

npm only lets you add a trusted publisher to a package that already exists, so the first
version is published by hand from an account in the `@linqapp` npm org:

```sh
npm login                      # an @linqapp org member with publish rights
npm ci
rm -rf dist *.tsbuildinfo && npm run build
npm test
npm publish --access public
git tag v0.1.0 && git push origin v0.1.0
```

Then on npmjs.com, open `@linqapp/convex` → Settings → **Trusted Publisher** → GitHub Actions:

| Field             | Value         |
| ----------------- | ------------- |
| Organization/user | `linq-team`   |
| Repository        | `linq-convex` |
| Workflow filename | `publish.yml` |
| Environment       | (empty)       |

On the same page, set **Publishing access** to require 2FA and disallow tokens, so only the
workflow can publish. Renaming or moving `publish.yml` breaks publishing until this entry is
updated.

No npm token is stored in GitHub. Don't set `NODE_AUTH_TOKEN` on the publish step: it would
shadow OIDC.

## Publishing by hand

Only if Actions is down or trusted publishing is misconfigured: run the one-time commands above
with the new version, then `gh release create v<version> --generate-notes`.
