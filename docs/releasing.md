# Releasing

Home Assistant reads the app's `version` from `actual_curator/config.yaml` on `main` and pulls
`ghcr.io/shaiu/actual-curator-ha:<version>`. If the bump reaches `main` before that image exists,
users are offered an update they cannot download. So the image is built from the tag first, and the
bump is merged after.

1. On a branch `release/vX.Y.Z`, bump the version in `package.json`, `package-lock.json`
   (`npm version X.Y.Z --no-git-tag-version`) and `actual_curator/config.yaml` (quoted:
   `version: "X.Y.Z"`), and add the entry to `CHANGELOG.md` and `actual_curator/CHANGELOG.md`.
   Open a pull request and wait for CI.
2. Tag the pull request's head commit and push the tag:
   ```bash
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```
   The `image` workflow builds `ghcr.io/shaiu/actual-curator:X.Y.Z`, then the Home Assistant app
   image per architecture (signed with Cosign) and the multi-arch `actual-curator-ha:X.Y.Z`. It
   refuses a tag that does not match `config.yaml`.
3. When that run is green, merge the pull request with **Create a merge commit**, so the tagged
   commit is part of `main`'s history. Do not squash: a squash commit is a different commit from the
   tag.
4. Create a GitHub release from the tag, with the changelog entry as notes.

The image actions skip a tag that already exists, so re-running a release never overwrites a
published image. Fix forward with a new patch version instead.
