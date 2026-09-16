# Microsoft Defender — app registration and consent

What to create in Microsoft Entra ID so this repository can read a Microsoft Defender XDR tenant,
and how to tell whether it worked. Two things consume these same three credentials: the probe
(`bun run probe:defender`), and the connector that runs real investigations.

**No tenant identifiers appear in this document.** Everything specific to a deployment lives in
`.env`, which is ignored.

## What you are creating

One Entra **app registration** with a client secret and up to three **application** permissions on
Microsoft Graph:

| Permission | Reaches | Used by | Needed when |
|---|---|---|---|
| `SecurityAlert.Read.All` | `GET /security/alerts_v2` | the alert queue | always |
| `ThreatHunting.Read.All` | `POST /security/runHuntingQuery` | every telemetry query | always |
| `SecurityIncident.ReadWrite.All` | `POST /security/incidents/{id}/comments` | writing findings onto the case | only to publish (PRD-9) |

**Grant the first two and stop, unless you want findings written back.** The read pair is the whole
system minus its last hop: the agent investigates, the verdict lands in `runs/`, and the tenant is
never touched. That is a complete and useful configuration, and it is the one to start with.

### If you want findings in the portal

The agent adds a **comment** to the incident its alert belongs to, so an analyst working that case
sees the finding without knowing this tool exists. It does nothing else — PRD-9 §4.1 D5 fixes
publication as additive comment text, and PRD-9 §3 permanently excludes setting `status`,
`classification`, `determination` or any response action.

**Read this before granting it.** Three things are true and none of them is obvious:

1. **It is a wider grant than the operation used.** `SecurityIncident.ReadWrite.All` permits updating
   any incident in the tenant — status, classification, determination, assignment. This project uses
   exactly one additive comment operation from it. Graph offers no comment-only scope, so you are
   trusting this project's own fence rather than Entra's, and the fence is asserted by a test
   (`apps/investigator/test/publish.test.ts`) rather than enforced by the platform.
2. **The object is bigger than an alert.** An incident groups several alerts, so a mistake behind
   that fence reaches further than one detection. The same grouping means one incident collects one
   comment per investigated alert — `bun run probe:defender --only I` reports the ratio for your
   tenant.
3. **A comment cannot be deleted through the API** once written.

**Not `SecurityAlert.ReadWrite.All`.** It was the obvious choice and it does not work: `PATCH
/security/alerts_v2/{id}` carrying a `comments` array returns **200 and discards the field** —
measured, not assumed (ADR 012 §6). If you granted it for an earlier version of this document, you
can remove it; it buys nothing.

If you do not want the trade, leave it ungranted. Everything else works without it, and
`publishFindings` falls back to recording publication in the run artifact.

**Least privilege, stated rather than implied:** each row above is the narrowest documented scope for
the endpoint beside it. `SecurityActions.ReadWrite.All` and the Defender for Endpoint scopes are
deliberately absent — every response action is out of scope (PRD-9 §3). Reading incidents as an
investigation unit stays out too (ADR 011 §1); this grant is used to write a comment and for nothing
else.

**Application permissions, not delegated.** This diverges from the Azure Sentinel connector, which
falls back to `az login` or `Connect-AzAccount` when no service principal is configured
(ADR 009 §3). Defender has no such fallback: developer sign-in is not a verified path to
`ThreatHunting.Read.All`, so PRD-8 §4.1 D2 requires the credential triple and never falls back to
another identity. This is a deliberate divergence rather than an omission — it is recorded as one so
a later reader does not "fix" it.

## Prerequisites

- A tenant with Microsoft Defender XDR, and advanced hunting available in the Defender portal.
- Someone who can grant tenant-wide admin consent: **Global Administrator**, **Privileged Role
  Administrator**, or **Cloud Application Administrator**. Creating the registration needs much
  less; granting consent is the step that needs the privileged role, and it is the step that
  actually matters.

## Portal walkthrough

1. **Entra admin center → Applications → App registrations → New registration.**
   Name it something an operator will recognise a year from now — `soc-agent-poc (read-only)` is
   fine. Leave *Supported account types* on **Accounts in this organizational directory only**.
   Leave the redirect URI blank: this is a daemon, and it never signs a person in.

2. **Overview.** Copy **Application (client) ID** and **Directory (tenant) ID**. These are
   `DEFENDER_CLIENT_ID` and `DEFENDER_TENANT_ID`. Neither is a secret, but both identify the tenant,
   so keep them out of anything committed.

3. **Certificates & secrets → New client secret.** Copy the **Value** — not the Secret ID — the
   moment it appears; the portal never shows it again. This is `DEFENDER_CLIENT_SECRET`. Note the
   expiry: when it lapses, every call fails at once and the failure looks like an outage rather than
   a calendar event.

4. **API permissions → Add a permission → Microsoft Graph → Application permissions.** Add
   `SecurityAlert.Read.All` and `ThreatHunting.Read.All`. Choosing *Delegated permissions* here is
   the single most common mistake, and it fails later rather than now — see below.

5. **Grant admin consent for \<tenant\>**, and confirm both rows read **Granted**. Until they do, the
   registration is complete and unusable.

## `az` equivalent

The permission ids are looked up rather than pasted, so this stays correct if Microsoft moves them.

```sh
GRAPH=00000003-0000-0000-c000-000000000000

APP_ID=$(az ad app create --display-name "soc-agent-poc (read-only)" --query appId -o tsv)
az ad sp create --id "$APP_ID"

for role in SecurityAlert.Read.All ThreatHunting.Read.All; do
  id=$(az ad sp show --id "$GRAPH" --query "appRoles[?value=='$role'].id | [0]" -o tsv)
  az ad app permission add --id "$APP_ID" --api "$GRAPH" --api-permissions "$id=Role"
done

# The privileged step. Everything above is reversible and inert without it.
az ad app permission admin-consent --id "$APP_ID"

az ad app credential reset --id "$APP_ID" --years 1 --query "{tenant:tenant,app:appId,secret:password}"
```

`=Role` is what makes each permission an *application* permission; `=Scope` would make it delegated,
which is the mistake step 4 warns about.

## Configure

In `.env` (never `.env.example`):

```sh
DEFENDER_TENANT_ID=...
DEFENDER_CLIENT_ID=...
DEFENDER_CLIENT_SECRET=...
# Optional; see below.
# DEFENDER_WORKSPACE_ID=...
```

All three are required **together**. A partial group is a configuration error naming the missing
keys, and never a silent fallback to another identity (PRD-8 §4.1 D2). With none of them set, the
Defender source is simply not active and nothing else changes.

`DEFENDER_WORKSPACE_ID` targets one Log Analytics workspace onboarded into the Defender portal.
Omitted, `runHuntingQuery` uses the caller's primary workspace. Leave it unset unless you know you
need it: **the silent fallback is measured, not merely documented.** A `workspaceId` no tenant owns
is accepted with `200` and answered from the primary workspace, so a success here is not evidence
that the workspace you named was the one queried, and a typo looks exactly like a working
configuration (`research-defender-api.md` §9.6).

What remains unsettled is narrower — whether naming a *legitimate* onboarded workspace changes any
result. That needs a tenant with Sentinel onboarded to the Defender portal, which this one is not,
so an identical result would prove nothing either way (PRD-8 §7 Q5).

## Verify

```sh
bun run probe:defender
```

With no credentials it prints why it is skipping and exits 0. With credentials it acquires a token,
makes one cheap Graph call, and — if that call is refused — stops there rather than spending the
tenant's hunting quota discovering the same refusal forty more times. Everything it learns lands in
`.data/defender-probe/<timestamp>/`:

- `findings.md` — scrubbed of tenant identifiers, and the half meant to be read into
  `docs/research-defender-api.md`.
- `transcript.json` — every request and response verbatim, tenant identifiers intact. The client
  secret and the bearer token are redacted from both; `.data/` is ignored by git and by nothing
  else.

A full run makes on the order of seventy Graph calls and takes a couple of minutes, because it paces
itself deliberately — see the next section.

## When it does not work

**Every call returns `403` with a token in hand.** Admin consent was not granted, or was granted for
delegated permissions instead of application ones. Check that both rows in *API permissions* read
**Granted** and that the *Type* column says **Application**. Do not try to diagnose this by decoding
the token: Microsoft documents explicitly that applications must not inspect Graph token claims, and
the probe does not.

**Only hunting fails, or only alerts fail.** The two permissions are granted separately, so the two
endpoints can disagree. The probe reports each endpoint's status separately for this reason.

**`AADSTS7000215` or `AADSTS7000222`.** The secret is wrong, or expired. Reset it — step 3, or
`az ad app credential reset`.

**`AADSTS700016`.** The client id does not exist in that tenant. Usually the tenant id and client id
came from different registrations.

**A query fails with `Failed to resolve table or column expression named 'X'`.** That is a `400`,
not a permission problem: the tenant does not hold that table, which is a function of its licences.
An unresolvable table being a `400` rather than a `403` is what makes a missing table
distinguishable from a missing role at all, and the probe leans on it (PRD-8 §4.2).

## Two things worth knowing before you point this at a tenant

**Advanced hunting quota is shared and it blocks.** The CPU allowance is per tenant, and once it is
exhausted queries are blocked *for everything else in the tenant* until the next 15-minute cycle.
Graph documents "at least 45 calls per minute". This is why the probe is strictly serial and paced,
and why `--pace-ms` exists rather than a parallel sweep. If you are running against a tenant someone
else depends on, run it out of hours.

**Every run against a real tenant writes outside the committed corpus.** Run and trace directories
must sit under `.data/` whenever any active source reads a live tenant, even when Sentinel is
`mock` (PRD-8 §4.1 D10, ADR 009 §5). The probe enforces this on itself. The consequence is that
Defender runs are unscored by construction — `scripts/evaluate-runs.ts` joins to
`fixtures/scenarios/`, so a Defender investigation investigates but does not benchmark
(PRD-8 §4.1 D13).

## References

- [PRD-8 — Microsoft Defender Data Source](./prd-8-microsoft-defender-data-source.md) — §4.1 D2, D10, D13; §5 Phase 0
- [`research-defender-api.md`](./research-defender-api.md) — §7 authentication, §8 what only a tenant can answer
- [ADR 009 — Azure Monitor Logs Connector](./adr/009-azure-monitor-logs-connector.md) — §3, the credential rule this diverges from
- [Microsoft Graph security API overview](https://learn.microsoft.com/en-us/graph/api/resources/security-api-overview?view=graph-rest-1.0)
