# ADR 006 — Analyst Console Boundary

**Status:** Accepted
**Date:** 2026-08-19
**Amends:** `AGENTS.md` §2 (frontend non-goal), §4 (technology baseline), §5 (repository shape), §14 (implementation order)
**Extends:** ADR 005 §2 (run artifact)
**Amended by:** ADR 007 §1, §3 (the console drives a control surface, so it is no longer a
read-only reader that never imports the investigator)
**Extended by:** ADR 007 §4 (observable run lifecycle); ADR 008 §4, §5 (run artifact lifecycle;
ground-truth scoring stays in `scripts/`)
**Amended:** 2026-08-25 — §2's stated blocker for `@opentui/keymap` was factually wrong; the
decision it supported is unchanged. Detail: [`../research-console-write-path.md`](../research-console-write-path.md).

## Context

PRD-3 specifies a read-only terminal console over the investigations PRD-2 produces. Building it
contradicts a non-goal that `AGENTS.md` §2, PRD-1 §10 and PRD-2 §24 all state in the same single
word: `frontend`.

`AGENTS.md` §15 lists "an implementation would require introducing a roadmap feature listed as a
non-goal" as a stop-and-ask trigger, and asks for a small ADR rather than a silent change of course.
This is that ADR.

## Decisions

### 1. The frontend non-goal is scoped, not deleted

**Was:** `AGENTS.md` §2, PRD-1 §10 and PRD-2 §24 exclude `frontend` outright.

**Now:** a web/product frontend remains excluded. A local, read-only operator console over run
artifacts is in scope.

The word was never ambiguous in context. `docs/architecture.md` §14 names the excluded thing as a
"Nuxt frontend", and §15 schedules it as roadmap PRD **7. UI / Operations**, sitting behind an
Investigation API in the capability diagram. That is a networked, multi-user product surface with an
API boundary, authentication and a deployment story — all of which `AGENTS.md` §2 separately
excludes as well.

The console is none of those things. It is a program that reads two files off the local disk and
draws them. The repository already contains something in that category and did not call it a
frontend: `scripts/evaluate-runs.ts` reads the same run artifacts and renders 96-column ASCII tables
of them.

The distinction that matters is not terminal-versus-browser, it is whether the surface is a
*product* — served, authenticated, depended upon — or a *local reader*. PRD-3 is a local reader, and
§14 of that PRD keeps it there by excluding the network, authentication, and any write path.

**Consequence.** `AGENTS.md` is amended in four places: §2 narrows the non-goal to a web/product
frontend, §4 adds OpenTUI to the technology baseline, §5 adds `apps/console/` to the expected
repository shape, and §14 adds Phase 7.

### 2. OpenTUI, not Ink and not a hand-rolled renderer

`@opentui/core` 0.5.4, MIT, pinned exactly.

The decisive constraint is the existing TypeScript configuration. `tsconfig.base.json` has no JSX
settings, there is no `.tsx` file anywhere in the repository, and it sets `erasableSyntaxOnly: true`.
Ink would require enabling `jsx` and `jsxImportSource` repository-wide and adding React plus its
transitive tree to a project whose root has three runtime dependencies and whose linter has no React
plugin configured. That is a large change to shared configuration in service of one app.

A hand-rolled ANSI renderer avoids every dependency, but trades them for roughly six hundred lines
of terminal plumbing — raw mode, resize, wrapping, clipping, scrollback, focus — that we would own,
test and debug for no product benefit.

OpenTUI's core is imperative, so it needs no JSX and no shared-config change; the surface the
console actually uses is `apps/console/src/ui/`. It requires Bun 1.3.0 or later, which `engines`
already mandates. Native cores ship as per-platform optional dependencies, so no Zig toolchain is
involved.

**The risk is real and accepted.** 0.5.4 was published 2026-08-18 and the package is pre-1.0, so a
breaking change between now and PRD-3 landing is likely rather than hypothetical. Two mitigations:
the version is pinned exactly, which is this repository's convention for every dependency; and
OpenTUI-aware code is confined to `apps/console/src/ui/`, with reading, indexing and formatting kept
pure beneath it. Replacing the renderer should not require touching a single line that parses a
transcript.

`@opentui/keymap` is not adopted, so the keymap is application-owned. That is the same shape as
PRD-2 owning its turn ceiling because Pi has no built-in one.

**Correction, 2026-08-25.** This paragraph originally read "`@opentui/keymap` is not usable — it
peer-depends on React or Solid". That reason was wrong: at 0.5.4 those peers are marked optional,
so the package was never technically unusable here. The decision stands on cost instead — adopting
a second pre-1.0 dependency and rewriting `onKey` in `apps/console/src/ui/app.ts`, the console's
highest-risk code, buys nothing the console needs. Established in
[`../research-console-write-path.md`](../research-console-write-path.md).

`CodeRenderable` is avoided: it pulls the `web-tree-sitter` peer dependency, and no KQL grammar
exists for it in any case.

**Verified before adoption, 2026-08-19**, by a throwaway spike outside the repository: clean
resolution, correct alternate-screen and cursor handling under a real pty, and no `web-tree-sitter`
peer warning. Two findings from it still bind code. `captureCharFrame()` returns the rendered frame
as plain text, which is what makes the console's panes snapshot-testable. And a global `keyInput`
listener runs before the focused renderable, with `stopPropagation()` shielding it — the mechanism
the pane keymap depends on.

### 3. The console reads files; it does not import the investigator

No code under `apps/console/**` imports `apps/investigator/**`. The run artifact and the transcript
are the entire contract between them.

This is the boundary discipline `.oxlintrc.json` already enforces for Mock Sentinel internals,
applied in the other direction.

One case is worth naming because it is the tempting mistake: the console must not import
`apps/investigator/src/env.ts` to display configuration. That module validates at import and throws,
by deliberate design (ADR 005 §6), so reusing it would make the console refuse to open a two-week-old
run because a provider key for a model it is never going to call is absent. The console has its own
environment contract covering only what it needs.

### 4. The run artifact gains a lifecycle

**Was:** ADR 005 §2 — one `runs/<run-id>.json` per invocation, written when the sweep completes.

**Now:** the same file, with optional `status`, `traceDir` and `config` fields, flushed after each
alert rather than only at the end.

An artifact that exists only after a sweep finishes cannot answer "what is running", which is
PRD-3's first requirement. The alternative — inferring liveness from transcript file mtimes — works
only when `INVESTIGATOR_TRACE=true`, which is off by default, so the console would show nothing at
all for the standard configuration.

The change is small because the machinery exists. `apps/investigator/src/index.ts` already has a
`flush()` closure, written so an interrupted sweep leaves usable data; PRD-3 calls it before the
first alert and through the existing `onResult` seam. No change to `runner.ts`.

Every added field is optional, so artifacts written before PRD-3 still parse, and
`scripts/evaluate-runs.ts` — which declares its own permissive view of the shape rather than
importing the Zod schema — is unaffected either way.

**This does not reopen ADR 005 §2.** That decision rejected a PostgreSQL trace store in favour of one
JSON file per run holding per-alert outcomes. It still is one JSON file per run holding per-alert
outcomes. `config` earns its place on ADR 005 §2's own argument for `model`: two runs are not
comparable without knowing how each was configured.

### 5. Ground-truth scoring stays in `scripts/`

The console does not compare a verdict against `fixtures/scenarios/`.

`loadScenarios` lives in `apps/mock-sentinel/src/scenarios/scenarios.ts`, and the
`no-restricted-imports` rule in `.oxlintrc.json` bans `apps/**` from reaching Mock Sentinel
internals, exempting `scripts/**` precisely so `scripts/evaluate-runs.ts` can perform that join.
Letting the console score would mean moving the loader into a package — a boundary change for a
feature PRD-3 does not need.

There is a second reason to keep the split. PRD-2 §20 makes ground-truth isolation a property of the
system, not a habit; the fewer code paths that can reach the answer key, the cheaper that property is
to keep true.

### 6. Transcript reading is a constraint, not an optimisation

Transcripts are large enough that the obvious implementation is a defect. Measured on
`runs/traces/01a0191c-…-d52663c4-….jsonl` — 16.5 MB across 1,752 lines — before PRD-3 was written:

```text
message_update    1,636 lines    96.4% of bytes
longest line      128,799 bytes
distinct types    9
```

So the console never reads a transcript into memory as a string and never parses a `message_update`,
`message_end` or `agent_end` line — `message_end` earns its place on that list by being 494 lines
across the corpus that nothing reads, since usage is counted from `turn_end` alone. Each line's type is taken from its first 120 bytes: `trace.ts` writes every
record as `{"at":"<iso>","type":"<name>",…}`, and the pattern matched 1,752 of 1,752 lines with no
exceptions. The **first** `"type":"` occurrence is the event type, because a `message_update` line
carries a nested `delta.type` inside the same prefix.

Two further rules follow from the data rather than from taste. Token and cost totals sum `usage` from
`turn_end` events only, because `message_start` and `message_end` carry a duplicate copy of the same
turn's usage and summing all three triples the figure. And transcripts are indexed lazily — a
151-alert sweep produces 151 of them, so a run list opens none and an alert opens one.

This is recorded here rather than left in the code because it is the kind of constraint a later
change quietly breaks.

### 7. The artifact records the alert's own facts, not just its id

**Was:** decision §4 gave the artifact a lifecycle. Each result still identified its alert only by
`alertId` and `alertTitle`.

**Now:** each result also carries an optional `alert` block — `severity`, `startTimeUtc`,
`endTimeUtc`, `timeGenerated`, `tactics`, `techniques`, `compromisedEntity`, `alertType`.

The gap was found by using the console. A result's `startedAt` and `completedAt` say when the
*agent* ran; nothing said when the *incident* happened. Measured on this corpus the two are five
years apart — the Training Lab telemetry is historical, so an alert from `2021-10-23T05:26Z` is
investigated on `2026-08-19T09:11Z`. Without the first, a verdict cannot be placed in time and a
list of runs cannot be ordered by anything an analyst triages on.

Transcript-only recovery was rejected as the primary answer. The console can already parse the
alert out of the first user message, and does — but `INVESTIGATOR_TRACE` is off by default, so a
transcript-only design leaves the standard configuration with no incident time anywhere. PRD-3 §4.2
anticipated exactly this: "either the artifact gains a field or the console does without."

Deliberately a subset rather than the whole `SecurityAlertResource`. Mirroring the alert would
duplicate Mock Sentinel's contract into a durable artifact and turn every upstream field addition
into a migration; the transcript already holds the alert verbatim for anyone who needs the rest.
The field types are plain strings rather than `@soc/contracts`' `AlertSeverity` and `AttackTactic`
enums, for the same reason the console reads leniently: this is a persisted record read back by
later tooling, and a new severity upstream should not make old artifacts unreadable.

**Consequence.** Artifacts written before this carry no `alert` block. The console recovers those
facts from the transcript for the selected investigation only — a run list still opens no
transcripts (PRD-3 §8.1) — and renders the columns blank, not as placeholders, where neither source
has them.

### 8. `view/` emits tones; `ui/` owns the palette

Decision 3 keeps `data/` and `view/` free of OpenTUI so the renderer stays replaceable. Colour is
the one requirement that pulls against it: PRD-3 §9.8 asks for a verdict band, an impact and a
failure to be coloured, and colour arrives from the renderer.

Three options. Move the palette into `view/` — then the view layer is naming hex codes for a
renderer it is not supposed to know about. Have `ui/` re-derive meaning from rendered strings by
matching on them — a parser for text we just formatted, which breaks the first time a heading is
reworded. Or let `view/` say what a span *means* and let `ui/` decide what that looks like.

The third. `view/format.ts` defines `Tone` (`true-positive`, `inconclusive`, `failed`, `dim`, …) and
`Line = string | Span[]`, so a renderer that needs no colour keeps returning plain strings and keeps
its existing tests. `ui/styled.ts` converts `Line[]` to OpenTUI's `StyledText`, mapping tones through
`ui/theme.ts`. Neither layer learns anything about the other.

This replaced `runStateColor` / `bandColor` / `impactColor`, which asked `ui/` to know what a run
state and an impact *were*. They were also, until this change, imported by nothing: the whole
palette was written for PRD-3 §9.8 and never reached the screen.

This is also why both list panes stopped using `SelectRenderable`. Its option type is plain strings,
so no tone could reach a row; it drew two lines per item whether or not the second earned its place;
it painted its own background, so the pane looked unlike every other; and it owned its own scroll
position. Drawing the rows as `Line[]` costs about forty lines of windowing code and removes all
four problems, along with the second source of truth for which pane had focus.

### 9. The permanent panes belong to the case, not the console

PRD-3 §8.1 originally gave pane `[1]` to a status readout — provider, model, thinking level, turn
and timeout ceilings, Sentinel URL, tracing, average tokens and average cost. Together with the
header, that made the two always-visible surfaces carry no security information at all, while every
value in them was already on the `c` screen.

That is the right layout for someone evaluating an agent and the wrong one for someone triaging an
alert, and PRD-3 §1 names the second as the user. Pane `[1]` now carries the alert: entity
identifiers, the detection's own `description` and its `additionalData`, all of which the view layer
had been parsing and discarding.

No acceptance criterion is lost. §13's requirements for per-run and per-investigation token and cost
figures, and for run configuration shown separately from the current environment, are all met by the
configuration screen, which is unchanged.

Two things this got wrong first time and had to be corrected.

The alert list was hidden whenever a run had a single alert. Almost every run in this corpus has
exactly one, so the pane was almost never there — which made `1-4` a lie in the key bar and left a
navigation key walking towards a pane that did not exist. It is always present now, sized to its
contents, and the sidebar reads `[1]` Alerts → `[2]` Runs → `[3]` Case.

And the case pane was sized to its contents. Every alert carries a different amount, so moving down the run list resized pane `[1]`,
which resized pane `[2]` underneath it, and the list moved under the analyst's own keypress. Panes
are now sized as a share of the terminal — they change on resize and at no other time.

## Testing

`AGENTS.md` §7 asks for tests at deterministic boundaries, and the console's boundaries are the two
file formats it reads. `apps/console/src/data/` and `src/view/` are pure and import nothing from
OpenTUI, which is what makes them testable without a terminal; that separation exists for testing as
much as for replaceability.

`runs/` is gitignored, so fixtures are committed under `apps/console/test/fixtures/` — a trimmed real
transcript plus artifacts in the current shape, the legacy `nextAction` shape, and a failed-result
shape that no run on disk has yet produced. Pane layouts are snapshot-tested through
`@opentui/core/testing` (§2), guarded on the native binary in the style of
`apps/mock-sentinel/test/integration/*` skipping when Kusto is absent, so `bun test` stays green
without it.

The cost is worth stating, as ADR 005 did. The live-tail path — a transcript growing while the
console reads it — needs a running sweep and is verified by hand rather than in `bun test`, so a
regression there surfaces as a stalled pane rather than a red test.

## Consequences

**Positive:** the work PRD-2 already does becomes legible without changing what the agent does; the
run artifact answers "what is running" for every consumer, not only the console; no new store,
daemon, index or network surface; and the renderer sits behind one directory.

**Negative:** a pre-1.0 dependency with a native binary enters the baseline; the run artifact schema
grows three fields and `completedAt` changes meaning to "last written"; the investigator now writes
its artifact N+2 times per sweep instead of once; and the console reads a transcript format that was
designed as a debugging aid rather than as an interface, which couples it to a shape `trace.ts` is
free to change.

## References

- `docs/prd-3-analyst-console.md`
- ADR 005 (investigation agent boundary), particularly §2 on the run artifact and §6 on configuration
- `docs/architecture.md` §14 (current non-goals) and §15 (capability roadmap, PRD 7 "UI / Operations")
- `@opentui/core` 0.5.4 — MIT, Bun ≥ 1.3.0, imperative core API; per-platform native cores ship as
  optional dependencies. `@opentui/keymap` is not adopted — see §2 and its 2026-08-25 correction;
  the peer-dependency reason first given there was inaccurate.
