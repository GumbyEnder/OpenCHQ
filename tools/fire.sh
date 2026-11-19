#!/usr/bin/env bash
# OpenCHQ loop fire - the mechanical half of a pass.
#
# Run this AFTER implementing the node that `node tools/loopctl.mjs next` claimed:
#
#   node tools/loopctl.mjs next        # claims one node, bumps the iteration
#   <implement it, extend web/test/run.mjs>
#   bash tools/fire.sh                 # prove, mark done, commit, push, deploy
#
# Green path: WEB_OK -> node marked done -> commit on branch web -> push origin web.
#             The push IS the deploy: openchq-web is connected to GumbyEnder/OpenCHQ
#             branch web, so Railway builds from the push and /api/version reports the
#             built commit (RAILWAY_GIT_COMMIT_SHA). `railway up` runs only when the
#             fire did not reach origin (no push, or a failed push), because an upload
#             carries no git metadata and needs the build.json stamp.
# Red path: node stays todo, no commit.
#
# Note: openchq-web has no Railway watch pattern, so every push to web builds - including a
# docs-only fire. Set watch paths to web/** (plus package.json, .node-version) if docs-only
# reboots of the live processes become a problem; until then a fire reboots once, not twice.
#
# Env:
#   OPENCHQ_LOOP_NODEPLOY=1   skip the upload fallback entirely
#   OPENCHQ_LOOP_NOPUSH=1     commit but do not push (=> upload fallback deploys)
#   OPENCHQ_LOOP_VERIFY=<s>   after a push, poll /api/version for up to <s> seconds
#   OPENCHQ_WEB_URL           base URL for that poll (default production)
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

# web/data/build.json is an upload artifact, not source. Leaving a stamp in the working
# tree lets the next `git add -A` commit a commit id from an earlier deploy - that is how
# the footer ended up naming the last `railway up` instead of the commit Railway built.
# Drop any residue before deciding the deploy path; the fallback below stamps it again.
git checkout -- web/data/build.json 2>/dev/null || true

DEPLOY_STATE=deployed
if [ "$PUSH_STATE" = "pushed" ]; then
  # One deploy per fire: the push already triggered the git build, so do not upload too.
  if [ "$RUNTIME_CHANGED" = "0" ]; then
    DEPLOY_STATE="deploy-pushed:no-runtime-change"
    echo "NO_RUNTIME_CHANGE $NODE: nothing under web/ changed; push still triggers a git build, no upload"
  else
    DEPLOY_STATE="deploy-pushed"
    echo "PUSH_DEPLOY_QUEUED origin/web $(git rev-parse --short HEAD): Railway builds on push, no railway up"
  fi
elif [ "${OPENCHQ_LOOP_NODEPLOY:-0}" = "1" ]; then
  DEPLOY_STATE="deploy-skipped"
elif [ "$RUNTIME_CHANGED" = "0" ]; then
  DEPLOY_STATE="deploy-skipped:no-runtime-change"
  echo "NO_RUNTIME_CHANGE $NODE: nothing under web/ changed, no reboot"
else
  # Fallback for a fire that never reached origin (OPENCHQ_LOOP_NOPUSH=1 or a failed
  # push). An upload carries no .git, so the commit has to be stamped into the tree.
  node tools/stamp_build.mjs >>"$LOG" 2>&1 || echo "LOOP_STAMP_FAILED: build.json was not written"
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
      echo "RAILWAY_UP $SERVICE (upload fallback: no push this fire)"
    else
      DEPLOY_STATE="deploy-failed"
      echo "LOOP_DEPLOY_FAILED: $(tail -n 3 "$LOG" | tr '\n' ' ')"
    fi
  fi
  # The stamp only had to exist for the upload; keep the tree clean for the next fire.
  git checkout -- web/data/build.json 2>/dev/null || true
fi

# Optional proof that the push-triggered build actually reached production: poll
# /api/version until it names this fire's HEAD. Off by default (a fire costs ~45 s more
# when on); the acceptance gate reads the same endpoint.
if [ "${OPENCHQ_LOOP_VERIFY:-0}" -gt 0 ] 2>/dev/null && [ "$PUSH_STATE" = "pushed" ]; then
  VERIFY_URL="${OPENCHQ_WEB_URL:-https://openchq-web-production.up.railway.app}/api/version"
  HEAD_SHA=$(git rev-parse HEAD)
  WAITED=0
  while [ "$WAITED" -lt "$OPENCHQ_LOOP_VERIFY" ]; do
    LIVE=$(curl -sf "$VERIFY_URL" 2>/dev/null | sed -n 's/.*"commit": *"\([0-9a-f]\{40\}\)".*/\1/p')
    if [ "$LIVE" = "$HEAD_SHA" ]; then
      DEPLOY_STATE="deploy-verified"
      echo "DEPLOY_VERIFIED $VERIFY_URL commit=$(git rev-parse --short HEAD) after ${WAITED}s"
      break
    fi
    sleep 5
    WAITED=$((WAITED + 5))
  done
  if [ "$DEPLOY_STATE" != "deploy-verified" ]; then
    DEPLOY_STATE="deploy-pending"
    echo "DEPLOY_PENDING $VERIFY_URL read '${LIVE:-no answer}' after ${WAITED}s, expected $(git rev-parse --short HEAD)"
  fi
fi

NEXT=$(node tools/loopctl.mjs status)
echo "iteration ${ITERATION}/${CAP}, node ${NODE}, WEB_OK, ${PUSH_STATE}, ${DEPLOY_STATE} | ${NEXT}"
# A green test run is not a green deploy. A push fire reports deploy-pushed because the
# build is Railway's to finish; OPENCHQ_LOOP_VERIFY turns that into a verdict. Exit
# non-zero so a fire cannot report "deployed" when the build never reached the host; the
# commit and push have already happened and are not rolled back.
case "$DEPLOY_STATE" in
  deploy-failed) echo "LOOP_EXIT_DEPLOY_FAILED"; exit 3 ;;
  deploy-skipped:auth) echo "LOOP_EXIT_DEPLOY_AUTH"; exit 4 ;;
  deploy-pending) echo "LOOP_EXIT_DEPLOY_PENDING"; exit 5 ;;
esac
rm -f "$LOG"
exit "$STATUS"
