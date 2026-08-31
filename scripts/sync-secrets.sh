#!/usr/bin/env bash
# Push credentials from THIS shell's environment into GitHub Actions secrets.
#
# Run it yourself, in the shell where the values are already exported:
#   ./scripts/sync-secrets.sh
#
# Values are piped to `gh` on stdin -- never echoed, never in argv (argv is
# visible to `ps`), never in shell history. Only names and lengths are printed.
#
# Options:
#   --repo <owner/name>   target repo (default: phix/sonar-remediation-automation)
#   --keychain            also mirror into the macOS Keychain for local runs
#   --dry-run             show what would happen, change nothing
#
# Anything unset in your environment is skipped, not blanked. To fill gaps:
#   export JIRA_API_TOKEN=...        # then re-run
set -uo pipefail

REPO=phix/sonar-remediation-automation
DRY=0; KEYCHAIN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo)     REPO="${2:?--repo needs a value}"; shift 2 ;;
    --dry-run)  DRY=1; shift ;;
    --keychain) KEYCHAIN=1; shift ;;
    -h|--help)  sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

SECRETS="JIRA_USER_EMAIL JIRA_API_TOKEN SONAR_TOKEN SONAR_TOKEN_READ TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID SANDBOX_REPO_TOKEN ANTHROPIC_API_KEY"
VARIABLES="JIRA_BASE_URL JIRA_PROJECT_KEY SONAR_ORG SONAR_PROJECT_KEY"

command -v gh >/dev/null || { echo "gh not found"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh is not authenticated -- run: gh auth login"; exit 1; }
gh repo view "$REPO" >/dev/null 2>&1 || { echo "cannot see repo $REPO"; exit 1; }

echo "target: $REPO"
[ "$DRY" = 1 ] && echo "DRY RUN -- nothing will be written"
echo

set_count=0; skip_count=0; fail_count=0

kc_key() { echo "$1" | tr 'A-Z_' 'a-z-'; }

echo "Secrets (encrypted, write-only once set)"
for name in $SECRETS; do
  val=$(printenv "$name" 2>/dev/null || true)
  if [ -z "$val" ]; then
    printf '  skip   %-20s not set in this shell\n' "$name"
    skip_count=$((skip_count+1)); continue
  fi
  if [ "$DRY" = 1 ]; then
    printf '  would  %-20s (%d chars)\n' "$name" "${#val}"
    set_count=$((set_count+1)); continue
  fi
  if printf '%s' "$val" | gh secret set "$name" --repo "$REPO" >/dev/null 2>&1; then
    printf '  SET    %-20s (%d chars)\n' "$name" "${#val}"
    set_count=$((set_count+1))
    if [ "$KEYCHAIN" = 1 ] && command -v security >/dev/null 2>&1; then
      security add-generic-password -U -s sonar-remediation -a "$(kc_key "$name")" -w "$val" 2>/dev/null \
        && printf '         %-20s also stored in Keychain\n' ""
    fi
  else
    printf '  FAIL   %-20s gh secret set failed\n' "$name"
    fail_count=$((fail_count+1))
  fi
done

echo
echo "Variables (plaintext, readable in logs -- non-secret only)"
for name in $VARIABLES; do
  val=$(printenv "$name" 2>/dev/null || true)
  # fall back to the known-good values for this project
  if [ -z "$val" ]; then
    case "$name" in
      JIRA_BASE_URL)    val="https://1337software.atlassian.net" ;;
      JIRA_PROJECT_KEY) val="SONAR" ;;
    esac
  fi
  if [ -z "$val" ]; then
    printf '  skip   %-20s not set, no default\n' "$name"
    skip_count=$((skip_count+1)); continue
  fi
  if [ "$DRY" = 1 ]; then
    printf '  would  %-20s = %s\n' "$name" "$val"; continue
  fi
  if gh variable set "$name" --body "$val" --repo "$REPO" >/dev/null 2>&1; then
    printf '  SET    %-20s = %s\n' "$name" "$val"
    set_count=$((set_count+1))
  else
    printf '  FAIL   %-20s gh variable set failed\n' "$name"
    fail_count=$((fail_count+1))
  fi
done

echo
echo "$set_count set, $skip_count skipped, $fail_count failed"

if [ "$DRY" != 1 ]; then
  echo
  echo "Confirming what GitHub now holds (names only -- values are write-only):"
  gh secret   list --repo "$REPO" 2>/dev/null | sed 's/^/  secret   /'
  gh variable list --repo "$REPO" 2>/dev/null | sed 's/^/  variable /'
fi

[ "$fail_count" -eq 0 ]
