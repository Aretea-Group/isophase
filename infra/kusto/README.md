# Kusto Emulator

The Kusto Emulator ("kustainer") is the query engine behind Mock Sentinel. It is an
**internal** dependency: nothing outside `apps/mock-sentinel` may connect to it
(PRD-1 §7).

## Image

```text
mcr.microsoft.com/azuredataexplorer/kustainer-linux
```

Verified against the MCR registry on 2026-08-18:

| Property | Value |
|---|---|
| Architectures | `linux/amd64` **only** — no arm64 manifest is published |
| Exposed port | `8080` (HTTP query + management endpoint) |
| Entrypoint | `/start-kusto.sh` → `Kusto.Personal -gw -https:false` |
| Required env | `ACCEPT_EULA=Y` |
| Size | ~1.2 GB compressed, ~3.4 GB on disk |
| Tags | ~25,400 rolling build tags; `latest` moves daily |

`infra/docker-compose.yml` pins the image **by digest**, because ADR 001 requires a
deterministic environment and no tag provides one. Treat a digest change as a
dependency upgrade.

## REST surface

```bash
# Management / control commands
curl -X POST http://localhost:8080/v1/rest/mgmt \
  -H 'Content-Type: application/json' \
  -d '{"csl":".show databases"}'

# Queries
curl -X POST http://localhost:8080/v1/rest/query \
  -H 'Content-Type: application/json' \
  -d '{"db":"SentinelLab","csl":"SecurityEvent | take 5"}'
```

No authentication. The emulator holds ingested data in the container; it does not
survive `docker compose down`. The bootstrap loader is therefore the single source
of truth for recreating the environment and must be repeatable (ADR 001).

## Apple Silicon: use Colima with Apple Virtualization + Rosetta

The image has no ARM64 build and Microsoft lists ARM processors as unsupported, so on
an M-series Mac it must run through x86-64 translation. **Rosetta works; QEMU does
not** — Kusto requires SSE4.2/AVX2, which Rosetta translates and QEMU user-mode does
not handle usably.

### Verified working setup

Measured 2026-08-18 on Apple M4 Pro / macOS 26.3 / Colima 0.10.3 / Docker CLI 29.7.2:

```bash
brew install colima docker docker-compose
mkdir -p ~/.docker/cli-plugins
ln -sfn /opt/homebrew/opt/docker-compose/bin/docker-compose ~/.docker/cli-plugins/docker-compose

colima start --vm-type vz --vz-rosetta --memory 6 --cpu 4
```

Confirm translation before going further — this must print `x86_64`:

```bash
docker run --rm --platform linux/amd64 alpine uname -m
```

Results with that configuration:

| Check | Result |
|---|---|
| `uname -m` under `--platform linux/amd64` | `x86_64`, Rosetta present in the process maps |
| `avx2` in `/proc/cpuinfo` | present — the requirement QEMU could not satisfy |
| `Kusto.Personal` start-up | **~3.1-3.7 s** |
| `docker compose up -d kusto` → host-queryable | **~2-4 s** |
| `docker restart` → host-queryable | **~2 s** |
| `NetDefaultDB` | created and answering queries |
| Idle CPU / memory | ~0.2%, ~850 MB resident |
| `.create database` / `.create table` / `.ingest inline` / `summarize` query | all succeed |
| `.show database <db> schema` | returns table + column + type — this backs `GET /schema` |
| Invalid KQL | returns a real Kusto `General_BadRequest` with client/activity IDs |

A 7-minute soak of 40 sequential queries returned 40/40 HTTP 200, both with and
without the compose healthcheck active.

The setup is functional but outside Microsoft's supported configuration.

### Required: .NET flags to survive Rosetta

Without extra configuration the emulator crashes under Rosetta, typically within the
first minute:

```text
rosetta error: rt_tgsigqueueinfo failed in pend_signal: 11
/start-kusto.sh: line 12: 8 Trace/breakpoint trap (core dumped) ./Kusto.Personal ...
```

Exit code 133 (SIGTRAP). Rosetta cannot service the SIGSEGV traffic .NET's JIT
generates when flipping page permissions (W^X). Every observed crash landed during JIT
warm-up, never in steady state.

`docker-compose.yml` therefore sets:

```yaml
DOTNET_EnableWriteXorExecute: "0"
DOTNET_TieredCompilation: "0"
```

Measured over ~10 minutes of continuous querying (one request every 6s):

| Configuration | Requests OK | Crashes |
|---|---|---|
| Without the flags | 93 / 100 | **2** (at 43s and 61s) |
| With the flags | 99 / 100 | **0** |

The two variables were not isolated from each other; `DOTNET_EnableWriteXorExecute=0`
is the documented fix for .NET under Rosetta and is expected to be the one doing the
work. Both are harmless on native amd64 hosts, so they are set unconditionally.

`restart: unless-stopped` remains as a second line of defence — it was verified to
recover the container automatically from an exit-133 crash. Anything depending on Kusto
should still verify readiness over HTTP rather than assuming the container stays up,
and the bootstrap loader must be re-runnable after a restart (which ADR 001 requires
anyway, since the emulator holds data only in the container).

### Port conflicts

If a query returns `Connection reset by peer` while the container logs say the database
is answering, check for another engine's forwarder holding the port:

```bash
lsof -nP -iTCP:8080 -sTCP:LISTEN
```

Podman's `gvproxy` will happily hold a published port even when its own container is
dead, and Colima cannot then bind it. Free the port and restart the container.

## Data lifetime

Ingested data lives in the container and does not survive `docker compose down`. The
bootstrap loader is therefore the single source of truth for recreating the environment
and must be repeatable (ADR 001).
