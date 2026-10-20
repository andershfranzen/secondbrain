#!/usr/bin/env bash
# Updates a Compose installation from Git. Run it in the deployment checkout
# (a clone of this repository with its .env):
#
#   scripts/deploy.sh [--eval | --skip-eval] [ref]      (ref defaults to origin/main)
#
# It builds the new version, and when the agent changed it first runs the agent
# evaluation against your model: the synthetic scenarios plus private cases
# drafted from your corrections. The new version starts only if no fewer checks
# pass than in the last accepted run; otherwise the old one keeps running.
#
# Optional .env.deploy: COMPOSE_FILES (space-separated, relative to the checkout)
# and EVAL_DATABASE_URL (default: the app database's server, database
# secondbrain_eval, which the evaluation erases).
set -euo pipefail
cd "$(dirname "$0")/.."

mode=auto ref=origin/main
for arg; do
  case $arg in
    --eval) mode=always ;;
    --skip-eval) mode=never ;;
    -*) echo "Unknown option: $arg" >&2; exit 2 ;;
    *) ref=$arg ;;
  esac
done
COMPOSE_FILES="infrastructure/compose.production.yaml infrastructure/compose.chatgpt.yaml"
EVAL_DATABASE_URL=""
[ -f .env.deploy ] && . ./.env.deploy
C=(docker compose --env-file .env)
for f in $COMPOSE_FILES; do C+=(-f "$f"); done

git diff --quiet HEAD || { echo "Tracked files have local changes; commit or discard them first." >&2; exit 1; }
git fetch --quiet origin
old=$(git rev-parse HEAD)
git checkout --quiet --detach "$ref"
new=$(git rev-parse --short HEAD)
if [ "$(git rev-parse HEAD)" = "$old" ] && [ $mode != always ]; then
  echo "Already at $new."
  exit 0
fi
echo "Building $new…"
"${C[@]}" build --quiet

# Files that shape what the agent does or how it is scored.
agent="packages/memory/src/agent.ts packages/memory/src/calendar.ts packages/ai/src packages/shared/src tests/fixtures/agent-scenarios.ts scripts/lib/agent-evaluation.ts"
if [ $mode = always ] || { [ $mode = auto ] && ! git diff --quiet "$old" HEAD -- $agent; }; then
  echo "The agent changed; evaluating it before switching (a few minutes of model use)…"
  if ! "${C[@]}" run --rm -T --no-deps \
      -e DATA_DIR=/tmp/eval-data -e ERASURE_MANIFEST_PATH=/tmp/eval-erasures/manifest.jsonl \
      -e EVAL_DATABASE_URL="$EVAL_DATABASE_URL" -e RUN="$new" \
      worker sh -c '
        set -e
        mkdir -p /tmp/eval-data /tmp/eval-erasures /data/evaluation/results
        pnpm -s ops corrections --days 365 --cases /data/evaluation/cases.json | tail -n 2
        evaluate() {
          pnpm -s eval:agent --live --send-synthetic-to-provider --send-cases-to-provider \
            --database "${EVAL_DATABASE_URL:-$(echo "$DATABASE_URL" | sed "s#/[^/]*\$#/secondbrain_eval#")}" \
            --cases /data/evaluation/cases.json --baseline /data/evaluation/baseline.json \
            --output "/data/evaluation/results/$RUN-$(date +%Y%m%d-%H%M%S).json"
        }
        # Model answers vary, so a run that misses the bar gets one rerun.
        evaluate || { echo "Not passed; running it once more to rule out a fluke…"; evaluate; }
      '; then
    echo "The evaluation did not pass. Staying on $(git rev-parse --short "$old"); rebuilding it…" >&2
    git checkout --quiet --detach "$old"
    "${C[@]}" build --quiet
    echo "Rerun with --eval to try again, or --skip-eval to deploy anyway." >&2
    exit 1
  fi
fi
"${C[@]}" up -d
echo "Deployed $new."
