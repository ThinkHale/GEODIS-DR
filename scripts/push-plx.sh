#!/bin/bash
# Push the PLX workbook to the GEODIS Management Suite.
#
# Why this exists: the workbook lives on geodis.sharepoint.com, which is a
# different Microsoft tenant from the one Power Automate runs in. A connector
# there cannot get a token SharePoint will accept for another tenant's site --
# that is the "Invalid audience Uri" 401. Guest access lets you open and SYNC
# the file, though, so this reads the synced copy locally and posts it, which
# never crosses a tenant boundary at all.
#
# Setup, once:
#   1. Open the library in the browser and choose Sync (or "Add shortcut to
#      OneDrive"), so the file appears under ~/Library/CloudStorage/.
#   2. Store the sync key in the Keychain, so it is never in a file:
#        security add-generic-password -a "$USER" -s geodis-sync-key -w
#   3. Point PLX_FILE below at the synced path, or export it before running.
#
# Run it by hand first. Schedule it with the .plist beside this file.

set -uo pipefail

ENDPOINT="https://syncreport-eusvh7xq5q-uc.a.run.app/?plx=1"
LOG="${HOME}/Library/Logs/geodis-plx-push.log"
PLX_FILE="${PLX_FILE:-}"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG"; }

# Find the workbook if a path was not given: the synced location differs by
# which library you sync, so search the CloudStorage roots rather than guess.
if [ -z "$PLX_FILE" ]; then
  PLX_FILE=$(find "${HOME}/Library/CloudStorage" -maxdepth 6 -name 'PLX - Geodis Spreadsheet.xlsx' -print -quit 2>/dev/null)
fi

if [ -z "$PLX_FILE" ] || [ ! -f "$PLX_FILE" ]; then
  log "FAILED: could not find 'PLX - Geodis Spreadsheet.xlsx' under ~/Library/CloudStorage."
  log "        Sync the SharePoint library first, or set PLX_FILE to its path."
  exit 1
fi

# A OneDrive placeholder is a stub until it is downloaded; posting one would
# upload an empty workbook and look like a successful sync of nothing.
SIZE=$(stat -f%z "$PLX_FILE" 2>/dev/null || echo 0)
if [ "$SIZE" -lt 20000 ]; then
  log "FAILED: '$PLX_FILE' is only ${SIZE} bytes -- it is probably an un-downloaded"
  log "        OneDrive placeholder. Open it once so OneDrive fetches the contents."
  exit 1
fi

KEY=$(security find-generic-password -a "$USER" -s geodis-sync-key -w 2>/dev/null)
if [ -z "$KEY" ]; then
  log "FAILED: no sync key in the Keychain. Add it with:"
  log "        security add-generic-password -a \"\$USER\" -s geodis-sync-key -w"
  exit 1
fi

MODIFIED=$(date -u -r "$PLX_FILE" '+%Y-%m-%dT%H:%M:%SZ')
BODY=$(mktemp -t geodis-plx)
trap 'rm -f "$BODY"' EXIT

# Built with python3 so a filename or path can never break the JSON.
python3 - "$PLX_FILE" "$MODIFIED" > "$BODY" <<'PY'
import base64, json, os, sys
path, modified = sys.argv[1], sys.argv[2]
with open(path, 'rb') as fh:
    payload = base64.b64encode(fh.read()).decode('ascii')
json.dump({'fileBase64': payload, 'fileName': os.path.basename(path), 'modifiedAt': modified}, sys.stdout)
PY

log "Posting $(basename "$PLX_FILE") (${SIZE} bytes, modified ${MODIFIED})"
RESPONSE=$(curl -sS -w '\n%{http_code}' -X POST "$ENDPOINT" \
  -H 'Content-Type: application/json' -H "x-sync-key: ${KEY}" \
  --data-binary "@${BODY}" 2>&1)
STATUS=$(printf '%s' "$RESPONSE" | tail -n1)
PAYLOAD=$(printf '%s' "$RESPONSE" | sed '$d')

if [ "$STATUS" = "200" ]; then
  log "OK  $(printf '%s' "$PAYLOAD" | python3 -c 'import json,sys; s=json.load(sys.stdin).get("sync",{}); print("shiftTags=%s sites=%s openOrders=%s warnings=%s" % (s.get("shiftTags"), s.get("sites"), s.get("openOrders"), len(s.get("warnings",[]))))' 2>/dev/null || printf '%s' "$PAYLOAD")"
else
  log "FAILED: HTTP ${STATUS}  ${PAYLOAD}"
  exit 1
fi
