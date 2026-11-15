#!/usr/bin/env bash
# End-to-end test of the Helm chart on a throwaway kind cluster.
#
# Proves, on a real Kubernetes cluster:
#   - the pre-install migration job runs and creates the schema;
#   - the API's pods are admitted under the "restricted" Pod Security Standard, and a privileged pod is not;
#   - health, readiness, sign-in (503 while the IdP is unreachable) and authentication behave;
#   - the network policy admits the ingress namespace and blocks everyone else;
#   - helm upgrade re-runs migrations and rolls the pods without failing a single request.
#
# Needs docker, kind, kubectl and helm, and an API image built beforehand:
#   docker build -f apps/api/Dockerfile -t platform-api:e2e .
#   deploy/helm/e2e/run.sh
#
# Settings (environment variables):
#   API_IMAGE              image to test (default platform-api:e2e)
#   NODE_IMAGE             kind node image (default mirror.gcr.io/kindest/node:v1.33.12)
#   POSTGRES_IMAGE         database image (default mirror.gcr.io/library/postgres:17-alpine)
#   EXPECT_NETWORK_POLICY  "true" (default) fails the run if the policy isn't enforced; set "false" on
#                          hosts whose kernel can't enforce policies (the check then only reports)
#   KEEP_CLUSTER           "true" keeps the cluster afterwards for debugging
set -euo pipefail

CLUSTER=${CLUSTER:-platform-e2e}
API_IMAGE=${API_IMAGE:-platform-api:e2e}
NODE_IMAGE=${NODE_IMAGE:-mirror.gcr.io/kindest/node:v1.33.12}
POSTGRES_IMAGE=${POSTGRES_IMAGE:-mirror.gcr.io/library/postgres:17-alpine}
EXPECT_NETWORK_POLICY=${EXPECT_NETWORK_POLICY:-true}
KEEP_CLUSTER=${KEEP_CLUSTER:-false}

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
WORK=$(mktemp -d)
CONTEXT="kind-$CLUSTER"
k() { kubectl --context "$CONTEXT" "$@"; }

cleanup() {
  rm -rf "$WORK"
  if [ "$KEEP_CLUSTER" != "true" ]; then kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }
pass() { printf '   ok: %s\n' "$*"; }
fail() { printf '   FAIL: %s\n' "$*" >&2; exit 1; }

# Run a throwaway pod in a namespace and print what its shell command prints.
probe() {
  local namespace=$1 command=$2
  k -n "$namespace" run "probe-$RANDOM$RANDOM" --rm -i --quiet --restart=Never \
    --image="$API_IMAGE" --image-pull-policy=Never --command -- sh -c "$command" 2>/dev/null || true
}

step "Create the cluster"
docker image inspect "$API_IMAGE" >/dev/null 2>&1 || fail "build $API_IMAGE first (see the header of this script)"
docker image inspect "$POSTGRES_IMAGE" >/dev/null 2>&1 || docker pull -q "$POSTGRES_IMAGE" >/dev/null
kind create cluster --name "$CLUSTER" --image "$NODE_IMAGE" --config "$HERE/kind-config.yaml" --wait 240s
# Save only linux/amd64, so multi-platform indexes don't reference blobs that were never pulled.
# Older Docker versions have no --platform flag for save and don't need it.
docker save --platform linux/amd64 -o "$WORK/images.tar" "$API_IMAGE" "$POSTGRES_IMAGE" 2>/dev/null \
  || docker save -o "$WORK/images.tar" "$API_IMAGE" "$POSTGRES_IMAGE"
kind load image-archive "$WORK/images.tar" --name "$CLUSTER"

step "Install the test database and the Secret"
sed "s#POSTGRES_IMAGE#$POSTGRES_IMAGE#" "$HERE/infra.yaml" | k apply -f - >/dev/null
k -n data rollout status deploy/postgres --timeout=180s >/dev/null
openssl genpkey -algorithm ed25519 -out "$WORK/audit-key.pem" 2>/dev/null
k -n platform create secret generic platform-secrets \
  --from-literal=DATABASE_URL='postgres://platform:platform-e2e@postgres.data.svc.cluster.local:5432/platform' \
  --from-literal=COOKIE_SECRET="$(openssl rand -base64 48)" \
  --from-literal=OIDC_CLIENT_SECRET=not-used-here \
  --from-file=AUDIT_SIGNING_KEY_PEM="$WORK/audit-key.pem" >/dev/null

step "helm install (the IdP is deliberately unreachable)"
repository=${API_IMAGE%:*}
tag=${API_IMAGE##*:}
helm --kube-context "$CONTEXT" install platform "$ROOT/deploy/helm/platform" -n platform \
  --set image.repository="$repository" --set image.tag="$tag" --set image.pullPolicy=Never \
  --set config.PUBLIC_BASE_URL=https://platform.example.test \
  --set config.OIDC_ISSUER=https://idp.example.test \
  --wait --timeout 5m >/dev/null
pass "installed"

step "Migrations ran before the pods started"
k -n platform get events --field-selector involvedObject.kind=Job -o custom-columns=R:.reason --no-headers | grep -q Completed \
  || fail "the migration job did not complete"
tables=$(k -n data exec deploy/postgres -- psql -U platform -tAc "select count(*) from information_schema.tables where table_schema = 'public'")
[ "$tables" -gt 10 ] || fail "expected the schema to exist, found $tables tables"
pass "migration job completed and created $tables tables"

step "Pods run under the restricted Pod Security Standard"
ready=$(k -n platform get deploy platform-api -o jsonpath='{.status.readyReplicas}')
[ "${ready:-0}" -ge 1 ] || fail "no API pods are ready"
pass "$ready API pod(s) admitted and ready in a namespace that enforces 'restricted'"
if k -n platform run psa-probe --image="$API_IMAGE" --image-pull-policy=Never --restart=Never --privileged --command -- true >/dev/null 2>&1; then
  fail "a privileged pod was admitted: the namespace does not enforce 'restricted'"
fi
pass "a privileged pod is rejected"

step "The API behaves"
out=$(probe ingress-nginx 'wget -qO- -T 5 http://platform.platform.svc/healthz; echo; wget -qO- -T 5 http://platform.platform.svc/readyz; echo
  wget -S -qO- -T 5 http://platform.platform.svc/auth/login 2>&1 | grep -m1 "HTTP/"; wget -S -qO- -T 5 http://platform.platform.svc/v1/me 2>&1 | grep -m1 "HTTP/"')
grep -q '"status":"ok"' <<<"$out" || fail "/healthz: $out"
grep -q '"status":"ready"' <<<"$out" || fail "/readyz: $out"
grep -q '503' <<<"$out" || fail "/auth/login should answer 503 while the IdP is unreachable: $out"
grep -q '401' <<<"$out" || fail "/v1/me should answer 401 without credentials: $out"
pass "healthz ok, readyz ready, sign-in 503 while the IdP is down, anonymous /v1/me 401"

step "The network policy admits only the ingress namespace"
blocked=$(probe default 'wget -qO- -T 5 http://platform.platform.svc/healthz >/dev/null 2>&1 && echo reached || echo blocked')
if [ "$blocked" = "blocked" ]; then
  pass "a pod in another namespace is blocked"
elif [ "$EXPECT_NETWORK_POLICY" = "true" ]; then
  fail "a pod in another namespace reached the API: the network policy is not enforced"
else
  printf '   note: not enforced on this host (its kernel lacks what the CNI needs); EXPECT_NETWORK_POLICY=false\n'
fi

step "helm upgrade re-runs migrations and rolls the pods with zero downtime"
k -n ingress-nginx run load --restart=Never --image="$API_IMAGE" --image-pull-policy=Never --command -- sh -c '
  ok=0; failed=0; end=$(( $(date +%s) + 60 ))
  while [ "$(date +%s)" -lt "$end" ]; do
    if wget -qO- -T 2 http://platform.platform.svc/readyz >/dev/null 2>&1; then ok=$((ok + 1)); else failed=$((failed + 1)); fi
    sleep 0.2
  done
  echo "ok=$ok failed=$failed"' >/dev/null
sleep 5
helm --kube-context "$CONTEXT" upgrade platform "$ROOT/deploy/helm/platform" -n platform --reuse-values \
  --set config.LOG_LEVEL=warn --wait --timeout 5m >/dev/null
runs=$(k -n platform get events --field-selector involvedObject.kind=Job -o custom-columns=R:.reason --no-headers | grep -c Completed)
[ "$runs" -ge 2 ] || fail "the migration job did not run again on upgrade"
k -n ingress-nginx wait --for=jsonpath='{.status.phase}'=Succeeded pod/load --timeout=180s >/dev/null
result=$(k -n ingress-nginx logs load)
grep -q 'failed=0' <<<"$result" || fail "requests failed during the upgrade: $result"
pass "migrations re-ran, the pods rolled, and every request succeeded ($result)"

printf '\nAll end-to-end checks passed.\n'
