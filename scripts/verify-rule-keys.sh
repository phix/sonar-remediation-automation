#!/usr/bin/env bash
# Verify that every rule key in the smell catalogue is real, and record the
# severity SonarQube will actually assign.
#
#   ./scripts/verify-rule-keys.sh [catalogue.json]
#
# A planted smell whose rule is not activated in the default quality profile
# never fires, which would read as a pipeline failure at the first-scan gate
# when the real fault is a bookkeeping error in the catalogue. This checks both:
#
#   1. the rule exists                    (api/rules/show)
#   2. the rule is active in "Sonar way"  (api/rules/search + qprofile)
#   3. the catalogue's expected_severity matches the profile's active severity
#
# Reads anonymously — SonarQube Cloud serves the rules API for a public
# organization without a token, so this runs before SONAR_TOKEN exists.
set -euo pipefail

SONAR_URL="${SONAR_URL:-https://sonarcloud.io}"
SONAR_ORG="${SONAR_ORG:-phix}"
CATALOGUE="${1:-${CATALOGUE:-smells/catalogue.json}}"

[ -f "$CATALOGUE" ] || { echo "no catalogue at $CATALOGUE" >&2; exit 2; }

# Default profile key per language, e.g. js -> AaBO...
profiles_json="$(curl -fsS "$SONAR_URL/api/qualityprofiles/search?organization=$SONAR_ORG")"

fail=0
pass=0

# rule_key<TAB>expected_severity, deduplicated: a rule used twice is one lookup.
while IFS=$'\t' read -r key expected; do
  [ -n "$key" ] || continue

  show="$(curl -fsS "$SONAR_URL/api/rules/show?organization=$SONAR_ORG&key=$key" 2>/dev/null || true)"
  name="$(printf '%s' "$show" | jq -r '.rule.name // empty')"
  if [ -z "$name" ]; then
    printf 'FAIL  %-24s does not exist in %s\n' "$key" "$SONAR_ORG"
    fail=$((fail + 1)); continue
  fi

  lang="$(printf '%s' "$show" | jq -r '.rule.lang')"
  qprofile="$(printf '%s' "$profiles_json" \
    | jq -r --arg l "$lang" '.profiles[] | select(.language==$l and .isDefault==true) | .key')"

  # activation=true restricts the search to rules active in that profile, and
  # actives[] carries the severity the profile assigns, which is what an
  # analysis will actually report.
  act="$(curl -fsS "$SONAR_URL/api/rules/search?organization=$SONAR_ORG&rule_key=$key&qprofile=$qprofile&activation=true&f=actives")"
  active_sev="$(printf '%s' "$act" | jq -r --arg k "$key" '.actives[$k][0].severity // empty')"

  if [ -z "$active_sev" ]; then
    printf 'FAIL  %-24s exists but is NOT ACTIVE in the default %s profile\n' "$key" "$lang"
    fail=$((fail + 1)); continue
  fi
  if [ "$active_sev" != "$expected" ]; then
    printf 'FAIL  %-24s catalogue says %s, profile assigns %s\n' "$key" "$expected" "$active_sev"
    fail=$((fail + 1)); continue
  fi

  printf 'ok    %-24s %-8s %s\n' "$key" "$active_sev" "$name"
  pass=$((pass + 1))
done < <(jq -r '.smells[] | [.sonar_rule_key, .expected_severity] | @tsv' "$CATALOGUE" | sort -u)

printf '\n%s rule key(s) verified, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
