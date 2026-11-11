# .github

The [oh-my-omp](https://github.com/oh-my-omp) organization profile. GitHub renders `profile/README.md` on the organization page; `profile/README.zh-CN.md` is its Simplified Chinese translation, so change both together.

## omomp release workflow

`.github/workflows/omomp-release.yml` is the release run every omomp member calls. The logic lives in `scripts/omomp-release.ts`, and the workflow checks it out from `main` beside the member. One run first restores the changelog's published sections against their tags (see [Run results](#run-results)). It then promotes the member's `## [Unreleased]` changelog section to a version and bumps every version file. It commits `chore: release X.Y.Z` on `main`. It moves `main`, the tag `vX.Y.Z` and the `release` branch in one atomic push, then creates the GitHub Release `vX.Y.Z` from that section.

### Run results

A run ends in exactly one result:

- **`released`:** the run published a new version as described above.
- **`nothing-to-release`:** after the published-section check below, `## [Unreleased]` has no top-level list item, so the run pushes nothing.
- **`failed`:** the run exits non-zero, pushes no ref, and the log names the reason.

#### Published sections

The tag decides what is published, not a section's position in the file. A merge that crosses a release can drop a pull request's `## [Unreleased]` items into the section the release just wrote. Before backfilling or computing a version, the run compares every `## [X.Y.Z]` section that has a tag `vX.Y.Z` on the remote with the same section of the same changelog path in the tag's commit. A section without a tag, or one the tag's commit does not have (a missing file or section), is skipped and kept as is.

- **Only extra top-level list items:** the section is restored to the tag's text. Each extra item moves to the same `###` category of `## [Unreleased]`, which is created at the end when it is missing. The items then count in this release's version bump and notes.
- **Any other difference:** a tag line changed or removed, an extra line that is not a top-level list item (including a new `###` heading or a continuation line), or a changed heading. The run fails with `failed:`, naming the `## [X.Y.Z]` section, the tag `vX.Y.Z` and the differing lines.

### Missing Releases

After the published-section check and before deciding, a run checks the current version `V` of `<package-dir>/package.json`. If the tag `vV` is on the remote but has no GitHub Release, the run backfills the Release from the restored changelog's `## [V]` section. The backfill pushes nothing.

### Version bump

The new version follows the `###` categories that hold top-level items:

- **`### Breaking Changes`:** a major bump at 1.0 and above, a minor bump in 0.x.
- **`### Added`:** a minor bump.
- **Anything else:** a patch bump. Items above any `###` and categories outside the seven standard ones are promoted unchanged.

The section date is the GMT+9 date of the run.

### Caller file

Each member adds this file as `.github/workflows/omomp-release.yml`:

```yaml
name: omomp-release

on:
  schedule:
    - cron: "0 17 * * *" # 02:00 GMT+9
  workflow_dispatch:

permissions:
  contents: write

jobs:
  release:
    uses: oh-my-omp/.github/.github/workflows/omomp-release.yml@main
    # with:
    #   package-dir: agent/extensions/_shared
    #   version-files: package-lock.json tern/plugin.toml
    #   changelog: CHANGELOG.md
```

### Inputs

| Input | Default | Meaning |
|---|---|---|
| `package-dir` | `.` | Package root: the directory holding `package.json`, relative to the repository root. Its `package.json` must carry the member declaration `"omomp": {"changelog": "CHANGELOG.md"}`. |
| `version-files` | empty | Further files that carry the version, relative to the repository root and separated by whitespace. In a `.json` file the version is the top-level `version`. A file named `package-lock.json` also carries `packages[""].version`. In a `.toml` file the version is the top-level `version = "X.Y.Z"` line. Any other extension fails the run. Only the version values change. |
| `changelog` | empty | Changelog path relative to the repository root. When empty, the run uses `omomp.changelog` from the declaration, resolved against `package-dir`. When set, the run reads and writes this file instead, but the declaration must still exist. |

### Running it locally

The same logic runs against any git checkout whose `HEAD` is the remote `main`. Run it at the checkout root:

```sh
git clone https://github.com/oh-my-omp/.github /tmp/omomp-dot-github
RELEASE="bun /tmp/omomp-dot-github/scripts/omomp-release.ts"
$RELEASE                                   # package-dir ".", declared changelog
$RELEASE --package-dir agent/extensions/_shared --changelog CHANGELOG.md
$RELEASE --version-files "package-lock.json tern/plugin.toml"
```

A local run pushes to `origin` exactly like the workflow: it uses `--remote <name>` when given, `origin` otherwise. A local run never creates or backfills a GitHub Release. Only the workflow does that, because it passes `--github-release <owner/repo>`. The last line of the output is the result: `omomp-release: released X.Y.Z`, `omomp-release: nothing-to-release`, or `omomp-release: failed: <reason>`.
