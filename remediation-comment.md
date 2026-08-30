<!-- sonar-remediation -->
### Automated remediation

| Outcome | Findings |
|---|---|
| Fixed deterministically | **18** |
| Awaiting the agentic path | 10 |
| Refused by policy | 4 |
| **Total reported** | **32** |

**56% of reported findings were resolved with no LLM call.** That ratio is the argument this pipeline makes: a rule with no codemod costs money and latency on every pull request that trips it.

#### Refused by policy — these block the merge and are not waived

- `javascript:S7737` at `api/src/auth/session.js:32` — `api/src/auth/session.js` is under the protected path `api/src/auth/`. Security-sensitive code is refused by location, not by whether the fix looks easy.
- `javascript:S2004` at `api/src/auth/session.js:45` — `api/src/auth/session.js` is under the protected path `api/src/auth/`. Security-sensitive code is refused by location, not by whether the fix looks easy.
- `javascript:S7765` at `api/src/auth/session.js:47` — `api/src/auth/session.js` is under the protected path `api/src/auth/`. Security-sensitive code is refused by location, not by whether the fix looks easy.
- `javascript:S1121` at `api/src/auth/token-verifier.js:33` — `api/src/auth/token-verifier.js` is under the protected path `api/src/auth/`. Security-sensitive code is refused by location, not by whether the fix looks easy.

#### No deterministic fixer exists for these

- `javascript:S3776` × 2
- `javascript:S4144` × 2
- `typescript:S3358` × 4
- `typescript:S3776` × 1
- `typescript:S4144` × 1

<details><summary>Every deterministic edit</summary>

- `api/src/app.js:2` — remove-unused-import: removed the whole import of randomUUID
- `api/src/reports/summary.js:97` — to-optional-chain: rewrote to an optional chain
- `api/src/reports/summary.js:87` — to-optional-chain: rewrote to an optional chain
- `api/src/reports/summary.js:78` — to-optional-chain: rewrote to an optional chain
- `api/src/reports/summary.js:51` — remove-dead-store: dropped the overwritten initial value of total
- `api/src/reports/summary.js:9` — var-to-const: var -> const for DEFAULT_WINDOW_DAYS
- `api/src/reports/summary.js:8` — var-to-const: var -> const for CURRENCY_SCALE
- `api/src/routes/orders.js:7` — remove-unused-variable: removed unused variable legacyPageSize
- `api/src/routes/orders.js:2` — remove-unused-import: removed the whole import of VALID_STATUSES
- `api/src/services/order-service.js:8` — remove-unused-variable: removed unused variable cacheTtlSeconds
- `api/src/store.js:13` — remove-unused-variable: removed unused variable seedCount
- `web/src/app/orders/order-list/order-list.ts:3` — remove-unused-import: removed the whole import of FormsModule
- `web/src/app/orders/order-stats.ts:10` — var-to-const: var -> const for CURRENCY_SCALE
- `web/src/app/orders/order-stats.ts:9` — var-to-const: var -> const for DEFAULT_PAGE_SIZE
- `web/src/app/orders/order.service.ts:3` — remove-unused-import: removed unused specifier(s) catchError

</details>