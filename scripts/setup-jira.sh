#!/usr/bin/env bash
# One-shot Jira credential setup. Prompts, validates against the live API,
# then stores in the macOS Keychain and GitHub Actions secrets.
#
#   ./scripts/setup-jira.sh
#
# The token is read with a hidden prompt: never echoed, never in argv, never
# in shell history, never written to a file in this repo.
set -uo pipefail

REPO=phix/sonar-remediation-automation
BASE=https://1337software.atlassian.net
PROJ=SONAR
SERVICE=sonar-remediation

echo "Jira credential setup"
echo "  site:    $BASE"
echo "  project: $PROJ"
echo

# Reuse whatever is already stored, so re-runs are cheap.
EMAIL=$(security find-generic-password -s "$SERVICE" -a jira-user-email -w 2>/dev/null || true)
TOKEN=$(security find-generic-password -s "$SERVICE" -a jira-api-token  -w 2>/dev/null || true)

if [ -n "$EMAIL" ]; then
  read -r -p "Atlassian email [$EMAIL]: " in; [ -n "$in" ] && EMAIL="$in"
else
  read -r -p "Atlassian email [1337.geek@gmail.com]: " EMAIL
  [ -z "$EMAIL" ] && EMAIL=1337.geek@gmail.com
fi
[ -z "$EMAIL" ] && { echo "email is required"; exit 1; }

if [ -n "$TOKEN" ]; then
  printf 'API token [keep existing, or paste a new one]: '
else
  printf 'API token (hidden -- id.atlassian.com/manage-profile/security/api-tokens): '
fi
read -rs in; echo
[ -n "$in" ] && TOKEN="$in"
[ -z "$TOKEN" ] && { echo "token is required"; exit 1; }

echo
echo "1. Validating against the live API..."
me=$(curl -s -u "$EMAIL:$TOKEN" "$BASE/rest/api/2/myself")
if ! echo "$me" | jq -e '.accountId' >/dev/null 2>&1; then
  echo "   FAILED -- Jira rejected these credentials."
  echo "   $(echo "$me" | jq -rc '.message? // .errorMessages? // .' 2>/dev/null | head -c 200)"
  echo
  echo "   Most common cause: wrong email. It must be the address this Atlassian"
  echo "   account signs in with, which may not be the one you expect."
  echo "   Second most common: a scoped token. Use a classic (unscoped) one."
  echo "   Nothing was stored."
  exit 1
fi
echo "   OK -- authenticated as $(echo "$me" | jq -r '.displayName')"

echo "2. Checking the $PROJ project is visible..."
projs=$(curl -s -u "$EMAIL:$TOKEN" "$BASE/rest/api/2/project")
if echo "$projs" | jq -e --arg k "$PROJ" 'any(.[]; .key==$k)' >/dev/null 2>&1; then
  echo "   OK -- visible: $(echo "$projs" | jq -r '[.[].key] | join(", ")')"
else
  echo "   WARNING -- $PROJ not in the visible list: $(echo "$projs" | jq -rc '[.[].key]')"
  echo "   Credentials are valid, so storing them anyway."
fi

echo "3. Storing in the macOS Keychain..."
security add-generic-password -U -s "$SERVICE" -a jira-user-email -w "$EMAIL" && echo "   OK -- jira-user-email"
security add-generic-password -U -s "$SERVICE" -a jira-api-token  -w "$TOKEN" && echo "   OK -- jira-api-token"

echo "4. Pushing to GitHub Actions secrets on $REPO..."
printf '%s' "$EMAIL" | gh secret set JIRA_USER_EMAIL --repo "$REPO" && echo "   OK -- JIRA_USER_EMAIL"
printf '%s' "$TOKEN" | gh secret set JIRA_API_TOKEN  --repo "$REPO" && echo "   OK -- JIRA_API_TOKEN"

echo
echo "Done. Verify the full contract with:"
echo "  ./scripts/verify-api-contracts.sh"
