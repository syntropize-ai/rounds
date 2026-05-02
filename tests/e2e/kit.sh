#!/usr/bin/env bash
# openobs e2e testkit entry point. See tests/e2e/README.md.
set -euo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/env.sh
source "${KIT_DIR}/lib/env.sh"
# shellcheck source=lib/cluster.sh
source "${KIT_DIR}/lib/cluster.sh"
# shellcheck source=lib/deploy.sh
source "${KIT_DIR}/lib/deploy.sh"
# shellcheck source=lib/port-forward.sh
source "${KIT_DIR}/lib/port-forward.sh"

usage() {
  cat <<EOF
usage: kit.sh <command>

commands:
  up       create kind cluster, build image, helm install, port-forward
  down     pkill port-forward and delete kind cluster (asks for confirmation)
  run      run vitest scenarios + chainsaw tests against the running cluster
  full     up -> run -> down (always tears down; OPENOBS_TEST_KEEP=1 to skip)

env:
  OPENOBS_TEST_LLM_PROVIDER  llm provider passed to the chart
  OPENOBS_TEST_LLM_API_KEY   llm api key (stored in the chart's Secret)
  OPENOBS_TEST_LLM_MODEL     llm model id
  OPENOBS_TEST_KEEP=1        skip teardown in 'full' (debug)
EOF
}

cmd_up() {
  cluster_up
  image_build_and_load
  helm_install
  wait_ready
  pf_up
  apply_workloads
  ok "openobs e2e cluster up at $(cat "${STATE_DIR}/url")"
}

apply_workloads() {
  local ns="${WORKLOADS_NS:-openobs-e2e}"
  phase "applying workload fixtures to namespace ${ns}"
  kubectl get namespace "${ns}" >/dev/null 2>&1 || kubectl create namespace "${ns}"
  kubectl apply -n "${ns}" -f "${E2E_ROOT}/fixtures/workloads/" >/dev/null
  kubectl wait --for=condition=available --timeout=180s deployment --all -n "${ns}" >/dev/null \
    || warn "some workload deployments still pending (continuing)"
  ok "workload fixtures applied"
}

cmd_down() {
  if [[ -z "${OPENOBS_TEST_FORCE:-}" ]]; then
    printf 'This will delete kind cluster "%s" and stop port-forward. Continue? [y/N] ' "${CLUSTER}"
    read -r reply
    case "${reply}" in
      y|Y|yes|YES) ;;
      *) warn "aborted"; return 1 ;;
    esac
  fi
  pf_down
  cluster_down
}

cmd_run() {
  if [[ ! -f "${STATE_DIR}/url" ]]; then
    die "no .state/url found — run 'kit.sh up' first"
  fi
  local url
  url="$(cat "${STATE_DIR}/url")"
  phase "running scenarios against ${url}"

  # Idempotent setup wizard: bootstrap admin, LLM config, datasource,
  # ops connector, SA token. Writes .state/sa-token which scenarios read.
  phase "seeding setup state"
  bash "${E2E_ROOT}/lib/seed.sh"

  local has_scenarios=0
  if compgen -G "${E2E_ROOT}/scenarios/**/*.test.ts" >/dev/null \
     || compgen -G "${E2E_ROOT}/scenarios/*.test.ts" >/dev/null; then
    has_scenarios=1
  fi

  local has_chainsaw=0
  if compgen -G "${E2E_ROOT}/chainsaw/tests/*/chainsaw-test.yaml" >/dev/null; then
    has_chainsaw=1
  fi

  if [[ "${has_scenarios}" -eq 0 && "${has_chainsaw}" -eq 0 ]]; then
    warn "no scenarios yet (sibling agents B/C still in flight); nothing to run"
    return 0
  fi

  if [[ "${has_scenarios}" -eq 1 ]]; then
    phase "vitest scenarios"
    OPENOBS_TEST_URL="${url}" \
      npx vitest run --config "${E2E_ROOT}/vitest.e2e.config.ts"
  else
    warn "no vitest scenarios"
  fi

  if [[ "${has_chainsaw}" -eq 1 ]]; then
    phase "chainsaw tests"
    chainsaw test "${E2E_ROOT}/chainsaw/tests"
  else
    warn "no chainsaw tests"
  fi
}

cmd_full() {
  OPENOBS_TEST_FORCE=1
  local rc=0
  cmd_up
  cmd_run || rc=$?
  if [[ -n "${OPENOBS_TEST_KEEP:-}" ]]; then
    warn "OPENOBS_TEST_KEEP=1 — leaving cluster up for debugging"
  else
    cmd_down || true
  fi
  return "${rc}"
}

main() {
  if [[ $# -lt 1 ]]; then
    usage
    exit 2
  fi
  local sub="$1"; shift
  case "${sub}" in
    up)   cmd_up "$@" ;;
    down) cmd_down "$@" ;;
    run)  cmd_run "$@" ;;
    full) cmd_full "$@" ;;
    -h|--help|help) usage ;;
    *) usage; exit 2 ;;
  esac
}

main "$@"
