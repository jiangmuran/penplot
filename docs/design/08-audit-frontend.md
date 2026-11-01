# 08 — Frontend audit (webui/, e2e/) before open-sourcing

Scope: `webui/**` and `e2e/**`, excluding `webui/src/features/{teletype,studio}/**` and
`webui/src/api/{teletype,studio}*.ts` (owned by parallel agents; findings there are reported, not fixed).
Date: 2026-11-01. Tools: `oxlint` (repo config), `knip@5` (via npx), a grep-based export/usage scan, `vite build`,
Playwright `desktop-chromium`.

Legend: **[fixed]** = changed in this pass, **[open]** = recommendation, **[owner: x]** = belongs to another agent.

---

## P0 — must fix before publishing

1. **Personal LAN address in shipped help articles** [fixed]
   `src/features/help/articles/09-troubleshooting.md` and `11-api.md` (bundled into the help chunk) contained the
   developer's board address `<board-ip>`. Replaced by a generic `192.168.1.50` with a "换成控制盒的地址" note.
   `docs/manual/` is described as a *copy* of these articles (help/articles.ts); it still contains the old IP and
   must be re-synced by the docs owner (`cp webui/src/features/help/articles/*.md docs/manual/`).
   Also still present outside webui: `docs/design/00-plan.md` (board IP, ssh root), `deploy/`. Not checked here.
   No `<your-domain>`, e-mail addresses, real names or home paths were found in `webui/` or `e2e/`
   (sources, public/, scripts, README, test specs).

2. **`webui/public/favicon.svg` was never committed** [fixed]
   The root `.gitignore` ignores `*.svg` (plot output) with only `docs/**` re-included, so a fresh clone would
   have no favicon (index.html links `/favicon.svg`). Added `!public/favicon.svg` to `webui/.gitignore`;
   it now shows up as untracked and needs `git add` by the integrator.

3. **License metadata missing** [open]
   No `LICENSE` file in the repo and no `"license"` field in `webui/package.json` / `e2e/package.json`.
   Add the AGPL-3.0 text at the root and `"license": "AGPL-3.0-only"` (or `-or-later`; a decision for the owner)
   to both package.json files. Consider SPDX headers only if the project wants them; not required.

4. **TypeScript build currently broken by in-progress teletype work** [owner: teletype]
   `tsc -b` fails only in `src/features/teletype/{controls,store,type-pad}.tsx` (missing `normalizeText`,
   `TeletypeFont` → `TeletypeFontInfo`, `SessionForm` fields, `api.font`). Everything else compiles; the build
   passed before those edits landed. Re-run `npm run build` once teletype settles.

## P1 — bundle size

Eager JS (everything `index.html` loads/preloads):

| | raw | gzip |
|---|---|---|
| before | ≈ 1 090 kB | ≈ 320 kB |
| after this pass | ≈ 757 kB | ≈ 237 kB |

5. **xterm was in the eagerly preloaded `vendor` chunk** [fixed]
   `vite.config.ts` `manualChunks` put every non-listed `node_modules` id into `vendor`, which the shell
   imports, so `@xterm/xterm` (332 kB, 83 kB gz) plus its CSS were downloaded on every page although only the
   lazy `features/teletype/terminal.tsx` uses it. Now `@xterm` gets its own `xterm` chunk; `vendor` dropped
   from 361 kB to 29 kB and `xterm.css` is no longer in `index.html`. No teletype file was touched.

6. **Largest chunks after the fix**
   | chunk | raw / gz | why |
   |---|---|---|
   | `xterm` | 332 / 83 kB | lazy, teletype terminal only |
   | `react` | 300 / 95 kB | react-dom 19 + react-router 7 (expected) |
   | `studio` | 206 / 65 kB | lazy route; canvas, inspector, sheets |
   | `radix` | 182 / 55 kB | **eager**: all 16 Radix packages in one chunk |
   | `index` | 88 / 31 kB | app shell |
   | `settings` | 87 / 27 kB | lazy route |
   | `icons` | 55 / 17 kB | lucide icons used across features (tree-shaken) |

7. **Radix is all eager because of the UI-kit barrel** [open]
   `@/components/ui/index.ts` re-exports every primitive and the shell imports from it, so slider, select,
   context-menu, tabs, scroll-area etc. ship with the first page. Removing the `radix` manualChunk changes nothing
   (tested). Real fix: the shell (`src/app/**`) imports from `@/components/ui/<file>` instead of the barrel, or the
   barrel is split (core vs. heavy). Expected saving ~60–90 kB raw on first load. Not done here (touches many
   shell files; low risk but not "cheap").

8. Help articles (≈ 40 kB) are `import.meta.glob(..., { eager: true })` inside the lazy help chunk; fine.

## P1 — dead code

9. **Removed** [fixed] (zero references anywhere in `src/`, incl. studio/teletype):
   - `src/app/placeholder-page.tsx` (phase-1 stub screen; README entry removed too)
   - `api/fonts.ts`: `glyphSvgUrl`, `useDeleteFont` · `api/jobs.ts`: `useBatch` (also used an ad-hoc query key)
   - `api/profiles.ts`: `importProfile` · `api/tasks.ts`: `TASK_KIND_LABEL`, `taskLabel`, `useRunningTasks`
   - `features/console/grbl-codes.ts`: `grblErrorHint`, `grblAlarmHint`, `grblErrorFix`, `grblAlarmFix`
   - `features/settings/profile-editor.tsx`: `ProfileNameField` and its private `TextRow`
   - `lib/format.ts`: `formatPercent` · `lib/theme.ts`: `isDark`
10. **Kept on purpose** [open, low]: unused UI-kit wrappers (`DialogTrigger/Close/Portal`, `SheetTrigger/Close`,
    `Tabs*`, `Select*` primitives, `ContextMenuSub*`, `ScrollArea`, `CardBody`, `TooltipRoot/*`, `PopoverAnchor`…)
    — they are the kit's public surface and tree-shake away. ~50 exported-but-file-local helpers/types (e.g.
    `api/collab.ts` `useLeaseStore`, `features/jobs/history.tsx` `JobMenu`) could drop `export`; cosmetic.
11. Unused in owned-by-others code [owner: studio/teletype]: `api/studio.ts` `waitTask`, `postAndWait`,
    `decodePaths`, `importKindFor`; `studio/geometry.ts` `toPage`, `round2`, `fmtMm`; `studio/model.ts`
    `SHAPE_LABEL`, `DEFAULT_MARGINS`, `hasFlow`, `docText`; `teletype/font.ts` `FALLBACK`, `GLYPHS` (exported only).
12. knip note: knip mis-resolves several `@/` imports in this repo (reports e.g. `useFonts` as unused although
    `features/fonts/index.tsx` imports it), so its list was cross-checked with a plain usage scan. It flags
    `public/sw.js` and `public/theme-init.js` as unused files — false positives (loaded at runtime).
13. **Dependencies**: no unused entries in `package.json`; every runtime dep is imported, `playwright` is used by
    `scripts/screenshots.mjs`, `tailwindcss` via `index.css`.

## P1 — duplicated logic / inconsistent API usage

All REST paths used through `api.*()` (187 call sites) exist in `openapi.json` with a matching method. Issues are
duplication and cache-key drift:

14. **`GET /machine/ports` has four fetchers** [open]: `api/profiles.ts useMachinePorts` (staleTime 5 s),
    `api/machine-control.ts usePorts` (15 s, `select: asArray`), `api/system.ts usePorts` (no staleTime),
    `features/onboarding/machine.ts usePortList` (key `[...ports, mode]`). The first three share `qk.machine.ports`
    with different options. Keep one hook (machine-control's, it is defensive) and re-export it.
15. **`GET /profiles` has three fetchers** on the same key: `api/profiles.ts useProfiles`,
    `api/machine-control.ts useProfiles` (with `asArray`), `features/studio/data.ts` [owner: studio].
16. **`saveBlob` / `filenameFromResponse` duplicated** in `api/download.ts` and `api/studio.ts` [owner: studio].
17. **Ad-hoc query keys** instead of `qk.*` (README convention): `api/fonts.ts` (`['fonts','coverage'…]`,
    `['fonts','glyphs'…]`, …: OK-ish, they are under the `fonts` prefix so `qk.fonts.all` still invalidates them),
    `api/system.ts` audit (`['system','audit',limit]`), `features/onboarding/steps.tsx`
    (`['jobs','detail',id]` duplicates `qk.jobs.detail`, `['onboarding','test-render',…]`).
18. `features/projects/soft-delete.ts` calls `fetch('/api/v1/projects/…', {keepalive})` directly, bypassing
    `api` (needed for `keepalive` on unload). Acceptable; it hard-codes `/api/v1` instead of `API_BASE`.
19. Help articles: `webui/src/features/help/articles/*.md` is the source, `docs/manual/*.md` a manual copy.
    Add a check or a copy step (e.g. in `npm run build` or CI) so they cannot drift.

## P2 — dev-only / demo code in the production bundle

20. `/__crash` route is behind `import.meta.env.DEV` [ok]; the tiny `Crash` function still ships. Fine.
21. **Onboarding "demo" mode** (`features/onboarding/machine.ts`) [open]: when `/machine/status` answers
    404/501 **or the network is offline**, the wizard switches to a simulated machine with fake ports
    (`/dev/ttyUSB0` CH340 …) and pretends that connect/jog/zero succeed (with a "演示" badge). Every endpoint exists
    now, so this is phase-1 scaffolding. The offline case is risky: a Wi-Fi blip during first-run makes the wizard
    "connect" to a fake plotter. Recommend: remove the sim, or at least drop `isOffline` from `unavailable()`.
22. Connection card lists `'fake'` (模拟器 FakeGrbl) as a port option even in production
    (`features/machine/connection-card.tsx:58`); the backend only accepts it in dev. Guard it on
    `machine?.fake || import.meta.env.DEV` [open].
23. `scripts/screenshots.mjs --mock` fakes an authenticated backend; dev tool, not bundled [ok].

## P2 — lint (oxlint, 136 warnings, 0 errors)

| rule | mine | studio/teletype |
|---|---|---|
| react(only-export-components) | 50 | 16 |
| react(set-state-in-effect) | 30 | 6 |
| react(refs) (ref read during render) | 11 | 3 |
| react(purity) (`Date.now()` in render) | 8 | 2 |
| exhaustive-deps / immutability / did-update-set-state | 3 | 1 |
| no-control-regex, no-unused-expressions | — | 4 |

Fixed: `no-useless-escape` in `app/auth/setup-page.tsx` (`[\w.\-]` → `[\w.-]`, same set) and unused catch
binding in `public/theme-init.js`. The rest are React-Compiler-style advisories on patterns that work today
(reset-form-on-open effects, `ref.current = value` mirrors, countdowns reading `Date.now()`); changing them is
not behaviour-neutral, so they were left. Worth a look: `projects/dialogs.tsx:150` (effect reads
`templates.length` but runs only on `open` — if templates load after opening, the dialog stays in "blank" mode),
`studio/index.tsx:120` (`canEdit` missing) [owner: studio], `studio/canvas/canvas.tsx:632-633` unused
expressions [owner: studio]. Consider turning `only-export-components` off: it only affects HMR.

## P2 — console noise

24. Only three calls remain outside studio/teletype, all legitimate: `app/error-boundary.tsx` (crash report),
`api/ws.ts` (listener threw), `api/machine.ts:102` `console.warn('[live] refresh failed')` — this one fires on
every failed refresh while offline; downgrade to `console.debug` or rate-limit [open].

## P2 — copy / glossary

25. **「租户」** [fixed]: `settings/users.tsx` ("为租户的每位成员…") and `app/auth/setup-page.tsx`
    ("其他租户成员的账号") — a leftover of a 家人 → 租户 replacement; a single-box tool has no tenants.
    Now 「为每位使用者建立各自的账号」/「其他人的账号」.
26. No 家人/家书/妈妈 etc. in `webui/src` or `e2e/`. (`docs/design/02-ux.md`, `04-contract-notes.md`,
    `05-review-ux.md` still use 家书 as example project name — docs owner.)
27. 原点 / 走边框 are used consistently. Minor drift [open]: status pill row label 「零点」 and
    「请抬笔并重新设零」 (`app/status-pill.tsx:69`, quoted in the glossary article) vs. 原点 everywhere else;
    「设 Z 零点」 in troubleshooting is about the pen axis and is correct. Suggest 「原点 · 未设定 · 请抬笔并重新设原点」
    together with the glossary sentence.

## P3 — accessibility

28. Good baseline: `IconButton` requires `label`, images have `alt` (decorative ones `alt=""`), one `<main>`
    per page (navigation spec), no positive `tabIndex`, focus rings via `focus-ring`/`focus-visible`.
29. `app/mini-player.tsx:120` `div onClick={stopPropagation}` without role — harmless (event shield only).
30. `console/codes-tab.tsx:83` rows use `outline-none` with `tabIndex=-1` and rely on the accent bar for the
    current item; OK since they are scroll targets, not tab stops.
31. Open e2e finding F7 (`/help` nests a second `<main>`) still annotated in navigation.spec.

## e2e housekeeping (done in this pass)

- Stale `knownBug` markers removed for fixed bugs **F1** (precompress), **F5** (E-stop aria-hidden), **F6**
  (CSP / theme-init), **F8** (`$J=` jogs); their console allow-list entry for F6 removed; FINDINGS.md updated.
- `reconnect.spec.ts` matched old banner copy 「与设备的连接已断开」; the shell says 「连接中断」. Regex extended.
- `studio.spec.ts › print sheet` fails: the checkbox 「纸张和笔已就位」 no longer exists in the print sheet
  [owner: studio — either restore it or update the spec].
- A backend spawned by `serve.mjs` survived one run after Playwright exited (port stayed bound); killing the
  supervisor should also kill its child process group.

## Verification

- `npm run build`: passed after this pass's webui changes; now fails only on the teletype TS errors in item 4.
- `oxlint`: 0 errors.
- Playwright `desktop-chromium` (full suite, E2E_PORT=8197): 49 passed, 4 skipped/fixme; failures were the
  stale markers and the reconnect regex (fixed, re-run green) plus the studio print-sheet spec above.
