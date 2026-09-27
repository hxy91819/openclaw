#!/usr/bin/env bash
# Verifies Tencent TokenHub doctor/config repair in Docker using the bare E2E
# image plus the repo source tree mounted read-only. The probe runs against the
# prebuilt dist bundles and the Tencent plugin source under extensions/tencent,
# exercising the same migration path as
# `src/commands/doctor/shared/legacy-config-core-migrate.ts` ->
# `runPluginSetupConfigMigrations` -> Tencent `normalizeCompatibilityConfig`.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-tencent-tokenhub-doctor-e2e" OPENCLAW_TENCENT_TOKENHUB_DOCTOR_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_TENCENT_TOKENHUB_DOCTOR_E2E_SKIP_BUILD:-0}"
CONTAINER_NAME="openclaw-tencent-tokenhub-doctor-e2e-$$"
RUN_LOG="$(mktemp -t openclaw-tencent-tokenhub-doctor-log.XXXXXX)"

cleanup() {
  docker_e2e_docker_cmd rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -f "$RUN_LOG"
}
trap cleanup EXIT

# bare target = clean Node runner; the repo (with prebuilt dist) is bind-mounted.
docker_e2e_build_or_reuse "$IMAGE_NAME" tencent-tokenhub-doctor \
  "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "bare" "$SKIP_BUILD"

echo "Running Tencent TokenHub doctor/config repair Docker E2E..."
set +e
docker_e2e_run_with_harness \
  --name "$CONTAINER_NAME" \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e OPENCLAW_BUNDLED_PLUGINS_DIR=/repo/extensions \
  -v "$ROOT_DIR:/repo:ro" \
  "$IMAGE_NAME" \
  bash -lc 'set -euo pipefail; cd /repo; node scripts/e2e/tencent-tokenhub-doctor-repair-probe.mjs' \
  >"$RUN_LOG" 2>&1
status=$?
set -e

if [ "$status" -ne 0 ]; then
  echo "Tencent TokenHub doctor/config repair Docker E2E failed"
  docker_e2e_print_log "$RUN_LOG"
  exit "$status"
fi

docker_e2e_print_log "$RUN_LOG"
echo "Tencent TokenHub doctor/config repair Docker E2E passed."