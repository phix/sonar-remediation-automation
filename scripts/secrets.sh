#!/usr/bin/env bash
# Local secret storage in the macOS Keychain, so tokens never sit in a
# plaintext file. Values are prompted for silently and never echoed.
#
#   ./scripts/secrets.sh set  jira-api-token
#   ./scripts/secrets.sh list
#   ./scripts/secrets.sh rm   jira-api-token
#
# To load them into a shell for a run:
#   eval "$(./scripts/secrets.sh export)"
#
# Keys: jira-api-token jira-user-email sonar-token sonar-token-read telegram-bot-token telegram-chat-id
set -euo pipefail
SERVICE=sonar-remediation
KEYS="jira-api-token jira-user-email sonar-token sonar-token-read telegram-bot-token telegram-chat-id"

var_for() { echo "$1" | tr 'a-z-' 'A-Z_'; }

case "${1:-}" in
  set)
    k="${2:?usage: secrets.sh set <key>}"
    printf 'Value for %s (input hidden): ' "$k"
    read -rs v; echo
    [ -z "$v" ] && { echo "empty, aborted"; exit 1; }
    security add-generic-password -U -s "$SERVICE" -a "$k" -w "$v" && echo "stored $k"
    ;;
  get)
    security find-generic-password -s "$SERVICE" -a "${2:?}" -w 2>/dev/null
    ;;
  rm)
    security delete-generic-password -s "$SERVICE" -a "${2:?}" >/dev/null && echo "removed ${2}"
    ;;
  list)
    for k in $KEYS; do
      if security find-generic-password -s "$SERVICE" -a "$k" -w >/dev/null 2>&1; then
        echo "  set      $k"
      else
        echo "  MISSING  $k"
      fi
    done
    ;;
  export)
    # Emits shell assignments. Values are secret — do not log this output.
    for k in $KEYS; do
      v=$(security find-generic-password -s "$SERVICE" -a "$k" -w 2>/dev/null || true)
      [ -n "$v" ] && printf 'export %s=%q\n' "$(var_for "$k")" "$v"
    done
    # non-secret config travels with them for convenience
    printf 'export JIRA_BASE_URL=%q\n'    "https://1337software.atlassian.net"
    printf 'export JIRA_PROJECT_KEY=%q\n' "SONAR"
    ;;
  *)
    sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
