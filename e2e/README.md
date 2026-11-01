# PenPlot end-to-end tests

Playwright suite that drives the **real frontend** (production build of `webui/`) against the **real
backend** (`python -m penplot.web serve`) with the **FakeGrbl** simulated plotter. Owned by QA; it only
lives in `e2e/` and never modifies `webui/`, `penplot/` or `tests/`.

## Run

```bash
cd e2e
npm install
npx playwright install chromium webkit      # first time; WebKit also needs: sudo npx playwright install-deps webkit
npx playwright test                         # everything (≈ 8 min): setup → desktop-chromium → mobile-webkit
npx playwright test --project=desktop-chromium tests/jobs.spec.ts
npx playwright show-report                  # HTML report (traces + screenshots of failures)
E2E_FIREFOX=1 npx playwright test           # adds a desktop-firefox project
```

What `playwright test` does (see `playwright.config.ts`, `scripts/serve.mjs`):

1. **Builds the SPA** into `e2e/.webui-dist` with webui's own Vite (`vite build --outDir ../e2e/.webui-dist`), so
   `webui/dist` is never touched and every run tests the current source. `scripts/build-webui.mjs` then checks
   that every pre-compressed `.br`/`.gz` sibling equals its plain asset and **removes mismatches** (bug F1),
   writing `.precompress-report.json`.
2. **Starts the backend** in a fresh temp data dir:
   `PENPLOT_DEV=1 PENPLOT_DATA_DIR=<tmp> PENPLOT_SERIAL_PORT=fake PENPLOT_FAKE_TIME_SCALE=0.05 PENPLOT_PORT=8093
   PENPLOT_HOST=127.0.0.1 PENPLOT_STATIC_DIR=e2e/.webui-dist .venv/bin/python -m penplot.web serve`.
   The backend serves the SPA itself (same origin, no proxy). The data dir is deleted at the end
   (`E2E_KEEP_DATA=1` keeps it).
3. `serve.mjs` **supervises** the backend like systemd (`Restart=always`): it respawns it after any exit, which
   is how restart tests work. While `.run/hold` exists it waits before respawning (deterministic "server
   down" windows). Run state (data dir, pids, restart count) is in `.run/state.json`.
4. The `setup` project does the **first-run setup through the UI** (dev mode → no setup code), dismisses the
   onboarding wizard and saves the admin session to `.auth/admin.json` for the other projects.

Fast local loop: start the supervisor yourself and reuse it:

```bash
node scripts/serve.mjs &                    # builds + starts on :8093
E2E_REUSE=1 npx playwright test tests/machine.spec.ts
```

(With `E2E_REUSE=1` the setup project just logs in if the admin already exists. Restart the supervisor to pick
up new frontend/backend code.)

Env knobs: `E2E_PORT` (8093), `E2E_PYTHON`, `E2E_FAKE_TIME_SCALE` (0.05), `E2E_LOG_LEVEL`, `E2E_SKIP_BUILD=1`
(reuse the last build), `E2E_KEEP_DATA=1`, `E2E_REUSE=1`, `E2E_FIREFOX=1`.

### Projects

| Project | Browser / device | Notes |
|---|---|---|
| `setup` | Chromium 1440×900 | UI first-run setup, session for the rest |
| `desktop-chromium` | Chromium 1440×900 (regular: sidebar, toolbar, inspector) | all specs |
| `mobile-webkit` | WebKit, iPhone 13 (compact: tab bar, machine bar, sheets) | all specs; desktop-only flows skip |
| `desktop-firefox` | Firefox 1440×900 | only with `E2E_FIREFOX=1` |

The simulated plotter is one shared resource, so the suite runs **serially** (`workers: 1`).

## Conventions

- **No sleeps.** Everything waits on UI state (`expect(...)`), WebSocket-driven text, or `expect.poll` on the
  REST API. Jobs are sized so FakeGrbl at time scale 0.05 runs ≈ 10–40 s (`helpers/gcode.ts`).
- **Arrange through the API, act through the UI, assert both.** `helpers/api.ts` (`Api`) logs in its own
  cookie session; `machine` fixture = `api` + `resetMachine()` (stop any job, unlock, connect, Idle, pen up and
  zero so jobs are not refused with `pen_unknown`).
- **Console guard** (`guard` auto-fixture): every test fails on uncaught exceptions, `console.error` and HTTP 5xx.
  `guard.strict4xx()` also fails on API 4xx. 404s of endpoints the UI already calls but the backend has not
  shipped (`PENDING_ENDPOINTS`) are annotated, not failed. Console errors of documented bugs
  (`KNOWN_BUG_CONSOLE`) are annotated as `known-bug`.
- **Accessible locators** (role + Chinese name) as a user/screen reader sees them; no CSS classes.
- **Not-yet-available features → `test.fixme(reason)`** (often decided at runtime, e.g. `isPlaceholder(page)`),
  so the suite is green-or-fixme today and tightens automatically when a feature lands.
- **Known bugs → `knownBug('F<n>', summary)`** (`test.fail`): the test describes the *correct* behaviour and is
  expected to fail. When someone fixes the bug Playwright reports "expected to fail, but passed" → delete the
  marker and move the finding to "fixed" in `FINDINGS.md`. (F2 went through this cycle during development.)
- **Contract shim** (fixture option `jogSeqShim`, on by default): bug F4 (global jog `seq` dedupe) would make
  jogs from any but the first page load silently do nothing. The shim rewrites outgoing jog seqs (WS `cmd` and
  `POST /machine/jog`) to globally increasing values so unrelated tests still test their feature; the dedicated
  F4 test runs with `test.use({ jogSeqShim: false })`. Remove the shim when F4 is fixed. (A similar lease shim
  for F3 was removed once F3 was fixed upstream.)
- Service workers are blocked (`serviceWorkers: 'block'`): the app's `sw.js` has no fetch handler, and on
  WebKit a controlling SW hides requests from `page.route`.

## Coverage

| Spec | What it covers |
|---|---|
| `auth.setup.ts` | first-run setup via UI (password rules, mismatch), redirect to /setup while no admin, onboarding dismissal persisted |
| `setup-code.spec.ts` | separate **non-dev** backend: setup code read from `<data dir>/setup-code` (0600), wrong code rejected, code file deleted, setup one-shot (409); login wrong/right password, `?next=` redirect, logout (sidebar menu / 更多 sheet) |
| `navigation.spec.ts` | every route via sidebar (desktop) or tab bar / 更多 (phone) + reload/deep link, no console errors/4xx; any *new* sidebar route; settings sections; `/`, `/write`, `/image` redirects, 404 page; sidebar toggle + Mod+digit; phone tab bar + no horizontal overflow; single `main` landmark |
| `studio.spec.ts` | new project dialog → free layout → text box drag → content, font (searchable picker), size → preview stroke stats → Mod+S/autosave → REST doc → reload persists; paper picker custom 207×294 saved in the doc; print sheet (就位 check gate) → job runs to done, mini-player progress; phone smoke |
| `jobs.spec.ts` | queued job started from 任务 (confirm) → done, mini-player live % increasing and "已完成" then collapse; pause/resume/stop on 任务 (stop confirm, Cancel focused, `user_stop`); pause/resume in the mini-player; Space shortcut; history filter/search/detail deep link |
| `estop.spec.ts` | toolbar E-stop mid-job (no confirm, `aborted(estop)`, recovery card → unlock); Mod+. while typing; E-stop over an open dialog; E-stop exposed to a11y during dialogs (F5) |
| `machine.spec.ts` | jog X/Y updates DRO + REST, set origin; pen down/up badge; controls disabled + explained during a job (and 409 from REST); jog after reload (F4); lease: admin keeps control after its own action (F3 regression); **operator browser session** (username login) blocked while the admin holds control, E-stop enabled, no take-over button, backend 409; release → usable and auto-acquired |
| `console.spec.ts` | `$I` reply, `error:20` shown, ↑ history; log TX/RX + filter; non-realtime commands refused during a job; `$J=` raw jog (F8) |
| `fonts.spec.ts` | search; coverage check (缺 N 字 / 全覆盖, ranking); font detail with sample re-render |
| `settings.spec.ts` | profile edit autosave → REST → reload; custom paper preset create/list/delete (undo toast); appearance theme/accent persist (F6) |
| `tokens.spec.ts` | create read-only API token in the UI → Bearer REST works, control call 403, revoke → 401 |
| `faults.spec.ts` | `error:20` mid-job → `failed(gcode_error)` + recovery wizard guidance; ALARM:3 (soft reset during a jog, from the console UI) → red banner with hint → 解锁 → origin flagged lost with guidance; **fixme**: USB unplug, `PENPLOT_FAKE_FAULTS` |
| `reconnect.spec.ts` | backend down → yellow banner, controls disabled, E-stop kept → back up → auto recovery; restart during a job → `aborted(shutdown)` + interruption banner; 系统 › 重启服务 → reconnect |
| `build.spec.ts` | pre-compressed assets identical to plain (F1); cache headers; missing assets 404; no CSP violation / theme before first paint (F6) |

Real bugs found are in [`FINDINGS.md`](./FINDINGS.md) (IDs F1…F8 are referenced by `knownBug()` markers).
