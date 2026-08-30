# Critique — src/app/(dashboard)

Method: dual-agent (A: design review, isolated · B: detector + static inventory, isolated).
Browser evidence collected by the controller; B had no browser tool exposed.
Date: 2026-08-30 · Branch: master · Mode: Operate

## Score

**22 / 40** (Nielsen 10 heuristics)

| # | Heuristic | Score |
|---|---|---|
| 1 | Visibility of system status | 2 |
| 2 | Match with the real world | 3 |
| 3 | User control and freedom | 2 |
| 4 | Consistency and standards | 3 |
| 5 | Error prevention | 1 |
| 6 | Recognition rather than recall | 2 |
| 7 | Flexibility and efficiency | 1 |
| 8 | Aesthetic and minimalist design | 3 |
| 9 | Recognize/diagnose/recover from errors | 2 |
| 10 | Help and documentation | 3 |

Detector: exit 0, zero findings across 71 .tsx files. No ignore-config exists,
so this is a genuine clean result, not a suppressed one.

## Priority issues

- **P0** Environment identity vanishes where you can act. `isStaging()` has exactly
  one consumer (`dashboard/page.tsx`). Site detail, all 7 tabs, every confirm
  dialog, and the marketplace install picker are environment-blind.
- **P0** Multi-site install has no confirmation. `InstallPanel` calls
  `createInstallBatchAction` straight from the footer; `SiteOption` is `{id,name}`
  with URL and environment discarded at the boundary.
- **P0** Maintenance mode is a write-only control. Two blind buttons; current state
  is never read or displayed.
- **P1** Triage collapsed: 12 of 12 sites are `warn`, all dots identical amber.
  `updates > 0` raises warn, so routine maintenance ranks with a dead connection.
- **P1** Failure has no durable record: `showInlineError={false}` nearly everywhere,
  9s toast lifetime, batch errors behind `title`, no retry.
- **P2** No search, no command palette, no cross-site action.

## Verified accessibility gaps

- `scope="col"`: 0 occurrences app-wide.
- No skip link anywhere; 7 tab stops before content on every navigation.
- Toast close is `-m-1 rounded-2xl p-1` (24px) — the exact pattern
  `tests/touch-targets.test.ts` bans, but that test only reads modal.tsx and
  sidebar.tsx, so toast.tsx slipped the net.
- Toast is `fixed inset-x-0 bottom-0 z-50` below `sm`, overlapping the
  `sticky bottom-0 z-20` BulkBar — contradicting BulkBar's own comment.
- GridMap: `role="application"`, no text alternative for 81 points.
- GeoGrid legend names 2 of 5 ramp colours; ranks 4–15 have no entry.
- login/page.tsx: `<h2>` precedes the page's only `<h1>` in DOM order.

## Token drift

- `grid-map.tsx:91,93,94` — `color:#fff`, `border:2px solid #fff`,
  `rgba(0,0,0,.35)` are raw literals outside `token()`.
  `tests/grid-map-tokens.test.ts` matches `"#[0-9a-f]{6}"` in double quotes only,
  so 3-digit hex inside the template literal is invisible to it.
- `login/geogrid-field.tsx:47-50`, `login/page.tsx:28,35,52` — raw brand hex,
  no token indirection.
- Accepted: `manifest.ts` and `services/reports/document.tsx` have no CSS-var access.
