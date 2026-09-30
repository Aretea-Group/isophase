# Security policy

This tool authenticates against Microsoft Defender XDR and Microsoft Sentinel tenants with
read-only credentials, and writes what it finds to local run artifacts. A vulnerability in it can
expose a customer's security telemetry, so please report privately.

## Reporting

Use GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/Aretea-Group/isophase/security/advisories/new)**.
It opens a draft advisory visible only to you and the maintainers.

Do not open a public issue, and do not include tenant identifiers, alert contents or run artifacts
in the report — describe the class of data at risk instead.

## What to expect

- Acknowledgement within **5 working days**.
- An assessment and either a fix or a reasoned decision within **30 days** of acknowledgement. If
  it takes longer, you will hear why.
- Credit in the advisory and the release notes, unless you ask not to be named.

## Scope

In scope: anything under `apps/`, `packages/` and `scripts/` — the investigator, the console, the
connectors, the evaluator — and the CI and repository configuration under `.github/`.

Out of scope: the vendored Microsoft Sentinel Training Lab telemetry under `fixtures/telemetry/`
(synthetic data, reported upstream to `Azure/Azure-Sentinel`), and the Kusto Emulator image, which
is Microsoft's.

## Supported versions

There are no releases yet; `main` is the only supported line. Fixes land there.
