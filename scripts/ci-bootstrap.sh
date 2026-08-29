#!/usr/bin/env bash
# Bootstrap a generic container into a working CI environment, then build and
# test the target repository.
#
# This is the "everything a CI should do" path: start from a stock base image
# that knows nothing about this project, install the toolchain, clone the
# source, install dependencies, build, test. Nothing is baked into an image, so
# the same script produces the same result on a laptop and on a runner.
#
# Run it locally exactly as CI does:
#   docker run --rm -e SANDBOX_REF=main \
#     -v "$PWD/scripts:/ci:ro" ubuntu:24.04 /ci/ci-bootstrap.sh
#
# Every site-specific value is an environment variable with a default, so the
# office version overrides rather than forks.
set -euo pipefail

SANDBOX_REPO_URL="${SANDBOX_REPO_URL:-https://github.com/phix/sonar-sandbox-app.git}"
SANDBOX_REF="${SANDBOX_REF:-main}"
NODE_MAJOR="${NODE_MAJOR:-24}"
JRE_PACKAGE="${JRE_PACKAGE:-openjdk-21-jre-headless}"
WORKDIR="${WORKDIR:-/workspace}"
# Skip stages when a caller only wants part of the bootstrap.
RUN_BUILD="${RUN_BUILD:-1}"
RUN_TESTS="${RUN_TESTS:-1}"

step() { printf '\n=== [%s] %s ===\n' "$(date -u +%H:%M:%S)" "$1"; }
elapsed() { printf '%s' "$(( $(date +%s) - START ))"; }
START="$(date +%s)"

step "toolchain: apt base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl git gnupg jq unzip "$JRE_PACKAGE" >/dev/null

step "toolchain: node ${NODE_MAJOR} via NodeSource"
curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
apt-get install -y -qq --no-install-recommends nodejs >/dev/null

step "toolchain: versions"
# The two hard requirements. Java >= 21 is non-negotiable: Sonar Scanner CLI v8
# dropped support for older runtimes on 2026-07-20.
node --version
npm --version
java -version 2>&1
git --version
jq --version

node_major_actual="$(node --version | sed 's/^v\([0-9]*\).*/\1/')"
java_major_actual="$(java -version 2>&1 | sed -n '1s/.*version "\([0-9]*\).*/\1/p')"
[ "$node_major_actual" -ge "$NODE_MAJOR" ] || { echo "FAIL: node $node_major_actual < $NODE_MAJOR"; exit 1; }
[ "$java_major_actual" -ge 21 ] || { echo "FAIL: java $java_major_actual < 21"; exit 1; }
TOOLCHAIN_SECONDS="$(elapsed)"

step "source: clone ${SANDBOX_REPO_URL} @ ${SANDBOX_REF}"
rm -rf "$WORKDIR"
git clone --quiet --depth 1 --branch "$SANDBOX_REF" "$SANDBOX_REPO_URL" "$WORKDIR"
cd "$WORKDIR"
echo "HEAD $(git rev-parse HEAD)"

step "dependencies: npm ci"
npm ci --no-audit --no-fund
DEPS_SECONDS="$(elapsed)"

if [ "$RUN_BUILD" = "1" ]; then
  step "build"
  npm run build
fi

if [ "$RUN_TESTS" = "1" ]; then
  step "test"
  npm test
fi

step "done"
printf 'timing_seconds toolchain=%s through_deps=%s total=%s\n' \
  "$TOOLCHAIN_SECONDS" "$DEPS_SECONDS" "$(elapsed)"
