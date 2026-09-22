## What changed

<!-- One paragraph: what a reader of the commit log would want to know. -->

## Why

<!-- The PRD or ADR that authorises it, or the bug it fixes. New behaviour without a PRD is the
     thing AGENTS.md §1 asks you not to do. -->

## Checklist

- [ ] `bun run check` is green locally (formatting, lint, typecheck, tests)
- [ ] No architecture change without an ADR (`AGENTS.md` §15), and no PRD edited to match the code
- [ ] Nothing under `runs/` or `.data/` is included, and no credential or tenant detail appears
- [ ] Turn-0 context, the run artifact's shape and what `evaluate` scores are unchanged — or the
      change is recorded as a new measurement condition
