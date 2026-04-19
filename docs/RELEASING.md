# Releasing

OpenObs publishes three distribution channels on every version tag:

| Channel | Registry | Target command |
|---|---|---|
| Docker image | `ghcr.io/openobs/openobs:<tag>` | `docker pull …` |
| Helm chart (OCI) | `oci://ghcr.io/openobs/charts/openobs` | `helm install … oci://…` |
| Helm chart (repo) | `https://openobs.github.io/openobs` | `helm repo add openobs …` |
| npm package | `openobs` on npmjs.org | `npm install -g openobs` |

All four are driven by one tag and one workflow file
(`.github/workflows/release.yml`).

## One-time setup

Before the first release, do these once per repo:

1. **Enable GitHub Pages.**
   Settings → Pages → Build and deployment → Source = `Deploy from a branch`,
   Branch = `gh-pages`, folder = `/ (root)`. Save. (Branch is created
   automatically by the first release; the Pages setting can be configured
   before that branch exists.)

2. **Add `NPM_TOKEN` repo secret.**
   - Create a token at <https://www.npmjs.com/settings/~/tokens> with
     scope **Automation** (or **Publish** for granular control).
   - In GitHub: Settings → Secrets and variables → Actions → New repository
     secret → Name `NPM_TOKEN`, Value = the token.
   - The release workflow skips npm publish gracefully with a warning if
     this secret is missing, so you can do this later if you only want
     Docker + Helm for now.

3. **Verify `GITHUB_TOKEN` has package write permission.**
   Default enough for ghcr.io pushes in public repos. For org-owned repos,
   check Settings → Actions → General → Workflow permissions = `Read and
   write permissions`.

## Cutting a release

From `main` (or any branch — the workflow only cares about the tag):

```bash
# Pick a semver, no pre-prefix leniency on helm/npm.
VERSION=0.1.0
git tag "v$VERSION"
git push origin "v$VERSION"
```

That's it. GitHub Actions runs the five-job release pipeline:

1. **release** — creates the GH Release object with install instructions.
2. **package** — builds the helm chart + the npm bundle once, uploads as
   an artifact so later jobs share the same bits.
3. **helm-oci** — pushes the chart to `ghcr.io/<owner>/charts`.
4. **helm-pages** — rebuilds `gh-pages/index.yaml` merging the new chart
   tarball so `helm repo add` users see the new version.
5. **npm-publish** — `npm publish openobs-<version>.tgz` (if NPM_TOKEN set).
6. **attach-assets** — uploads both `.tgz` files to the GH Release so
   users can grab them without depending on any registry.

Expected duration: ~3–5 min total (jobs run in parallel once `package` finishes).

## Install commands end users see

After a successful tag, users can install via any of:

```bash
# npm — one command to run on any dev machine
npx openobs            # or: npm install -g openobs && openobs

# Docker — minimal container
docker run --rm -p 3000:3000 ghcr.io/openobs/openobs:v0.1.0

# Helm — traditional repo-add flow
helm repo add openobs https://openobs.github.io/openobs
helm repo update
helm install my-openobs openobs/openobs

# Helm — OCI direct (no repo add)
helm install my-openobs \
  oci://ghcr.io/openobs/charts/openobs \
  --version 0.1.0
```

## Versioning notes

- **Tag format**: `v<semver>`. The leading `v` is stripped for chart and
  npm versions (semver compliance).
- **Docker tag is `v<semver>`** (kept as-is). Chart appVersion in
  `Chart.yaml` is stamped to `<semver>` (no `v`).
- **No pre-release channels yet.** `vX.Y.Z-beta.N` tags still publish —
  npm marks them dist-tag `latest` by default. If you want `--tag beta`,
  wire that in release.yml explicitly.
- **Re-publishing a version fails.** npm and helm both reject duplicate
  versions. Bump before retrying.

## If something goes wrong mid-release

Each job is independent after `package`. If `npm-publish` fails because
the token is wrong, the Helm push and GH Release still succeed. Fix the
secret and re-run the individual job from the workflow run page — or
push a new patch tag.

The one coupling: if `package` fails, nothing downstream happens.
Investigate from the Actions run UI, fix, re-tag (e.g. `v0.1.1`).
