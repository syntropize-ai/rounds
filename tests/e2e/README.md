# openobs e2e testkit

Real-cluster end-to-end harness. Builds the openobs image, brings up a kind
cluster, helm-installs the chart, and runs vitest + chainsaw scenarios against
it.

## Prerequisites

Local CLIs on `$PATH`:

- docker
- kind
- kubectl
- helm
- Kyverno Chainsaw (`brew install kyverno/chainsaw/chainsaw`; Homebrew core
  has a different `chainsaw` binary that does not support `chainsaw test`)
- jq
- node 20+ (and the repo's `npm install`)

## Quick start

```sh
export OPENOBS_TEST_LLM_PROVIDER=anthropic
export OPENOBS_TEST_LLM_MODEL=claude-sonnet-4-6
export OPENOBS_TEST_LLM_API_KEY=sk-...
npm run e2e:full
```

### Colima users

Creating a fresh kind cluster on Colima (macOS) often fails with:
`could not find a log line that matches "Reached target .*Multi-User
System.*|detected cgroup v1"`. Colima's nested cgroup layout is the
culprit — kind expects systemd cgroup conventions that the default
Colima VM doesn't expose to a brand-new node.

Two workarounds:

```sh
# A. Reuse an existing kind cluster you already have running
export CLUSTER=kind     # or whatever `kind get clusters` lists
npm run e2e:up

# B. Spin Colima with cgroupsv2 enabled
colima delete
colima start --cgroup-manager systemd --cpu 4 --memory 8
```

`tests/e2e/kit.sh down` will delete the cluster named by `CLUSTER`. If
you set `CLUSTER=kind` to reuse a long-running shared cluster, prefer
`helm uninstall openobs -n openobs && kubectl delete ns openobs` for
cleanup so the shared cluster stays up.

`e2e:full` is `up -> run -> down`. The intermediate steps are also exposed:

```sh
npm run e2e:up     # build, install, port-forward
npm run e2e:run    # vitest + chainsaw against the running cluster
npm run e2e:down   # delete cluster + kill port-forward
```

## Environment variables

| Var                          | Purpose                                                  |
| ---------------------------- | -------------------------------------------------------- |
| `OPENOBS_TEST_LLM_PROVIDER`  | LLM provider passed to the chart                         |
| `OPENOBS_TEST_LLM_API_KEY`   | LLM API key (stored in the release Secret)               |
| `OPENOBS_TEST_LLM_MODEL`     | LLM model id                                             |
| `OPENOBS_TEST_KEEP=1`        | Skip teardown in `full` for debugging                    |
| `CLUSTER`                    | kind cluster name (default `openobs-e2e`)                |
| `IMAGE_TAG`                  | Image tag (default: short git sha)                       |
| `GATEWAY_PORT`               | Local port-forward (default `3000`)                      |
| `NO_COLOR=1`                 | Disable color output                                     |

## Debugging

`OPENOBS_TEST_KEEP=1 npm run e2e:full` leaves the cluster, port-forward, and
state files in place after a failure. Useful state lives in
`tests/e2e/.state/`:

- `url` — the gateway URL
- `pf.pid`, `pf.log` — port-forward process and output
- `admin-token`, etc. — populated by sibling seed scripts

To reset, run `npm run e2e:down`.

## Layout

```
tests/e2e/
  kit.sh                # entry point (up | down | run | full)
  lib/                  # bash helpers sourced by kit.sh
  fixtures/helm/        # helm values overlay for tests
  fixtures/workloads/   # workload yamls (sibling agent B)
  scenarios/            # vitest scenarios (sibling agent C)
  chainsaw/tests/       # chainsaw cases (sibling agent B)
  vitest.e2e.config.ts  # scenarios-only vitest config
  .state/               # runtime state (git-ignored)
```
