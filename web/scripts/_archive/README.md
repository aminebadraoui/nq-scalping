# Archived study scripts

One-off studies that nothing else references any more: no doc, no
`lib/studies.ts` registry entry, no nightly/weekly step, no other
script (checked 2026-10-26). They were moved here, not deleted, so their
numbers stay reproducible. Imports were re-pointed to `../../lib/`.

| Script | What it studied |
|---|---|
| `openResolution.ts` | 9:30–9:59 fake-out fade vs real-drive confirm |
| `openExcursion.ts` | open-drive TP-first hit rates / adverse excursion |
| `rthStudy.ts` | early RTH candidates (soft continuation, extreme-bar fade, RTH pullback) — superseded by `rthOptimizer.ts` |
| `runnerStudy.ts` | ladder/runner exits re-scored over every family |
| `sizeOptimal.ts` | Monte Carlo contract count; reads `/tmp/mom_*.json` dumps that no longer exist |

Run one the usual way, from `web/`:

    node --import ../scripts/ts-loader.mjs ./scripts/_archive/<name>.ts

Move a script back to `scripts/` if a doc or study starts citing it again.
