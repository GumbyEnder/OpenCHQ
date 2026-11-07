#!/usr/bin/env bash
# OpenCHQ loop fire - the mechanical half of a pass.
#
# Run this AFTER implementing the node that `node tools/loopctl.mjs next` claimed:
#
#   node tools/loopctl.mjs next        # claims one node, bumps the iteration
#   <implement it, extend web/test/run.mjs>
#   bash tools/fire.sh                 # prove, mark done, commit, push, deploy
#
# Green path: WEB_OK -> node marked done -> commit on branch web -> push origin web
#             -> railway up (detached). Red path: node stays todo, no commit.
#
# Env:
#   OPENCHQ_LOOP_NODEPLOY=1   skip the Railway deploy
#   OPENCHQ_LOOP_NOPUSH=1     commit but do not push
#   OPENCHQ_RAILWAY_SERVICE   Railway service name (default openchq-web)
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT" || exit 1

SERVICE=${OPENCHQ_RAILWAY_SERVICE:-openchq-web}
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

NODE=$(node tools/loopctl.mjs current)
if [ -z "$NODE" ]; then
  echo "LOOP_NO_CLAIM: nothing claimed. Run: node tools/loopctl.mjs next"
  exit 2
fi

if [ "$BRANCH" != "web" ]; then
  echo "LOOP_WRONG_BRANCH: on '$BRANCH', the loop only fires on 'web'."
  exit 2
fi

LOG=$(mktemp /tmp/openchq-fire-XXXXXX.log)
node web/test/run.mjs >"$LOG" 2>&1
CODE=$?

if [ "$CODE" -ne 0 ] || ! grep -q "^WEB_OK$" "$LOG"; then
  FAILING=$(grep -m1 -E "Error|error:|missing|leaks|FAILED" "$LOG" | cut -c1-240)
  if [ -z "$FAILING" ]; then FAILING=$(tail -n 1 "$LOG" | cut -c1-240); fi
  node tools/loopctl.mjs fail "$NODE" "red: ${FAILING:-no WEB_OK}"
  echo "LOOP_RED $NODE"
  sed -n '1,40p' "$LOG"
  echo "LOOP_RED $NODE | no commit, node left todo"
  rm -f "$LOG"
  exit 1
fi

WEIGHT=$(grep -c . "$LOG")
node tools/loopctl.mjs done "$NODE" "WEB_OK"
STATUS=$?

ITERATION=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("docs/loop-state.json","utf8")).iteration)')
CAP=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("docs/loop-state.json","utf8")).cap)')
TITLE=$(node -e '
const g = JSON.parse(require("fs").readFileSync("docs/web-loop.graph.json","utf8"));
const n = g.nodes.find((x) => x.id === process.argv[1]);
console.log(n ? n.title : process.argv[1]);
' "$NODE")

PREV=$(git rev-parse HEAD)
git add -A
if git diff --cached --quiet; then
  echo "LOOP_NO_DIFF $NODE: node marked done with no code change"
else
  git commit -q -m "loop: ${NODE} - ${TITLE} (iteration ${ITERATION}/${CAP})" \
    -m "Proved by node web/test/run.mjs printing WEB_OK." || {
      echo "LOOP_COMMIT_FAILED $NODE"; exit 1; }
  echo "COMMITTED $(git rev-parse --short HEAD) ${NODE}"
fi

# The CIFS share can make git's stat cache miss a file that two commands just rewrote,
# so the graph and the counter sometimes land after the main commit. Sweep them.
if [ -n "$(git status --porcelain -- docs/web-loop.graph.json docs/loop-state.json)" ]; then
  git add -- docs/web-loop.graph.json docs/loop-state.json
  if ! git diff --cached --quiet; then
    git commit -q -m "loop: record ${NODE} state (iteration ${ITERATION}/${CAP})" &&
      echo "COMMITTED $(git rev-parse --short HEAD) loop-state"
  fi
fi


PUSH_STATE=pushed
if [ "${OPENCHQ_LOOP_NOPUSH:-0}" = "1" ]; then
  PUSH_STATE="push-skipped"
else
  if git push -q origin web >>"$LOG" 2>&1; then
    echo "PUSHED origin/web"
  else
    PUSH_STATE="push-failed"
    echo "LOOP_PUSH_FAILED: $(tail -n 3 "$LOG" | tr '\n' ' ')"
  fi
fi

# A deploy restarts the process, which ends every live room (reconnect is still a later
# node). Only ship when something a player can see actually changed: server code, the page,
# or the deploy manifest. Docs, the graph and the loop counter do not justify a reboot.
RUNTIME_CHANGED=0
if git diff --name-only "$PREV" HEAD | grep -Eq '^(web/|package\.json$|\.node-version$)'; then
  RUNTIME_CHANGED=1
fi

DEPLOY_STATE=deployed
if [ "${OPENCHQ_LOOP_NODEPLOY:-0}" = "1" ]; then
  DEPLOY_STATE="deploy-skipped"
elif [ "$RUNTIME_CHANGED" = "0" ]; then
  DEPLOY_STATE="deploy-skipped:no-runtime-change"
  echo "NO_RUNTIME_CHANGE $NODE: nothing under web/ changed, no reboot"
else
  RAILWAY_BIN=$(command -v railway || true)
  if [ -z "$RAILWAY_BIN" ] && [ -x "$HOME/.railway/bin/railway" ]; then
    RAILWAY_BIN="$HOME/.railway/bin/railway"
  fi
  if [ -z "$RAILWAY_BIN" ]; then
    DEPLOY_STATE="deploy-skipped:no-cli"
  else
    # A stale CLI session surfaces as "Unauthorized" only after the upload starts. Ask first, so the
    # reason is named before anything is built, and the login can refresh the token.
    if ! "$RAILWAY_BIN" status >>"$LOG" 2>&1; then
      echo "LOOP_DEPLOY_AUTH: railway status failed - the CLI session is not usable: $(tail -n 1 "$LOG")"
      DEPLOY_STATE="deploy-skipped:auth"
    elif "$RAILWAY_BIN" up -y -d --service "$SERVICE" >>"$LOG" 2>&1; then
      echo "RAILWAY_UP $SERVICE"
    else
      DEPLOY_STATE="deploy-failed"
      echo "LOOP_DEPLOY_FAILED: $(tail -n 3 "$LOG" | tr '\n' ' ')"
    fi
  fi
fi

NEXT=$(node tools/loopctl.mjs status)
echo "iteration ${ITERATION}/${CAP}, node ${NODE}, WEB_OK, ${PUSH_STATE}, ${DEPLOY_STATE} | ${NEXT}"
# A green test run is not a green deploy. Exit non-zero so a fire cannot report "deployed" when the
# build never reached the host; the commit and push have already happened and are not rolled back.
case "$DEPLOY_STATE" in
  deploy-failed) echo "LOOP_EXIT_DEPLOY_FAILED"; exit 3 ;;
  deploy-skipped:auth) echo "LOOP_EXIT_DEPLOY_AUTH"; exit 4 ;;
esac
rm -f "$LOG"
exit "$STATUS"
