---
name: security-check
description: Security check of this Homey app (Hoymiles HiOne). Use when asked to check for vulnerabilities, run a security check or audit, or when a scheduled task asks for the periodic security check. Covers dependencies, secrets, credential handling, the app's web API, Modbus and cloud writes, network scanning and the CI workflows.
---

# Security check: Homey app for the Hoymiles HiOne

The automated side (npm audit, CodeQL, Dependabot) runs in GitHub Actions every
week: `.github/workflows/security.yml` and `.github/dependabot.yml`. This skill
is the part a tool cannot do: read the app's own risky spots with judgement.

Write the report in Dutch. Keep code, identifiers and commit messages in English.

## 1. Automated checks (run them, quote the result)

```bash
npm ci --ignore-scripts && npm audit --audit-level=low
npm test
git ls-files | grep -Ei '\.env|secret|credential|\.pem$|\.key$|id_rsa' || echo "no suspicious file names"
git grep -nEi '(api[_-]?key|token|password|secret)\s*[:=]\s*["'\''][^"'\'' ]{8,}' -- ':!test' ':!package-lock.json' || echo "no hard-coded secrets"
```

Known false positives: `drivers/hione/pair/login_credentials.html` (by file
name) and the translated `password: 'Wachtwoord'`-style labels in that file and
`settings/index.html`. Anything else is worth a look.

If the GitHub MCP tools are available, also read the latest run of the
"Security scan" workflow and the open Dependabot / code-scanning alerts.

## 2. Manual review: the app's own risky spots

Read the code, do not assume. For each point: OK, finding (with
`file:line`), or not checked (and why).

1. **Cloud credentials.** `drivers/hione/driver.js` stores the Hoymiles e-mail
   and password in `homey.settings` and in the device store. Check they never
   reach a log line (`this.log`, `this.error`, `console.*`), an error message
   that bubbles up to a Flow, the diagnostics endpoint, or a widget/settings
   page response.
2. **App web API** (`api.js`, `app.json` → `api`). No endpoint may be marked
   `"public": true`. Check what `/diagnostics`, `/datasources`, `/bms`,
   `/modbus/scan` and `/ports` return: no password, token or full cloud
   payload with personal data. Check input validation on IP addresses and
   ports passed in (no probing outside the local network).
3. **Modbus writes** (`lib/HoymilesModbus.js`). Every write goes to a known,
   named register; values are range-checked before writing; percentage
   settings are read before writing and confirmed afterwards
   (`_writePercent`). Look for any new write path that skips this.
4. **Cloud writes** (`lib/HoymilesApi.js`). HTTPS only, TLS verification never
   disabled (`rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED`).
   Tokens are not logged.
5. **Network scan** (`lib/NetworkScan.js`). Limited to the local subnet, with
   timeouts and a bounded number of hosts/ports.
6. **Flow card arguments.** Numbers from Flows are clamped before they reach a
   register or the cloud (SOC 0-100, power limits within device range).
7. **CI and supply chain.** Third-party actions in `.github/workflows/` pinned
   to a tag or SHA, not a branch. Known exception at the time of writing:
   `athombv/github-action-homey-app-validate@master` (Athom's own action; flag
   it, it is not an automatic failure). Workflows run with least
   `permissions`.
8. **Dependencies.** `package.json` should stay small. Any new dependency:
   is it maintained, and is it really needed?

## 3. Report

Start with a one-line verdict. Then a table: check, result, severity
(hoog / middel / laag / info), `file:line`. Then concrete fixes for each
finding. Do not change code unless the user asks; if asked, work on the
session's development branch and run `npm test` before committing.
