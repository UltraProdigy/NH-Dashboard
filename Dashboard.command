#!/bin/bash
#
# Double-click this file in Finder to build fresh data, start the local
# server, and open the dashboard in your browser.
#
# macOS runs .command files in Terminal on double-click. Closing that Terminal
# window stops the server.

cd "$(dirname "$0")" || exit 1

echo "NH Dashboard"
echo "============"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "Node isn't installed. Run: brew install node"
  echo
  read -r -p "Press Return to close."
  exit 1
fi

# Fail early with a clear message rather than a stack trace mid-build.
if [ -z "$GITHUB_TOKEN" ] && [ ! -f .env ] && ! gh auth token >/dev/null 2>&1; then
  echo "No GitHub token available."
  echo "Run:  gh auth login"
  echo
  read -r -p "Press Return to close."
  exit 1
fi

echo "Fetching fresh data (this takes about a minute)..."
echo
if ! node --env-file-if-exists=.env src/build.js; then
  echo
  echo "Build failed — see above."
  read -r -p "Press Return to close."
  exit 1
fi

PORT="${PORT:-4000}"
echo
echo "Starting server on http://localhost:$PORT"
echo "Close this window to stop it."
echo

# Give the server a moment to bind before the browser hits it.
( sleep 1 && open "http://localhost:$PORT" ) &

exec node --env-file-if-exists=.env src/serve.js
