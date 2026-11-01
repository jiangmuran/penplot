# 09 — Performance audit: "好多东西都好慢" (2026-11-01)

Measured on the production board (Orange Pi Zero 3, release 20261101-015616) from a LAN client:
Playwright Chromium (desktop 1440×900; phone = Pixel 7 + 4× CPU throttle), a React-DevTools-hook
commit counter / fiber walker, CDP `Performance.getMetrics`, curl / Python probes with a temporary
token, cProfile on the board. The real user was printing and editing during the audit, so the board was
under real load. Scripts live outside the repo (scratchpad); the method is described below so it can be repeated.

## TL;DR — where the time actually goes

| # | cause | evidence | fix | after |
|---|---|---|---|---|
| 1 | **Page render is O(n²) pure Python** (`gcode.optimize_paths`, greedy nearest-neighbour) | studio preview of the 4 400-stroke `plotter_test_A4.svg`: **72–80 s per render** on the board; 41 M `_dist2` calls = 80 % of the render | vectorised nearest search (numpy), same float maths and tie-breaking → **byte-identical G-code / paths** | **80.5 s → 11.8 s** on the board (desktop 2.97 → 0.48 s) |
| 2 | **Identical renders are never shared** — the runner's "identical request rides on the running task" never matched for renders, because `rid`/`out_dir` (random) are in the args. Every reload / second tab / other device re-rendered the same page, and two of them filled both workers | task list: 6 slots (`uimvx…/page`) rendering the same doc back to back, 75 s each | key without `rid`/`out_dir`; slot-tagged (preview) renders share across slots and reuse a finished result for 10 min while its dir exists; riders counted so one client's supersede/abort does not cancel the others | reload / 2nd tab: **75 s → one HTTP round trip** (test `test_identical_slot_renders_are_shared_and_reused`) |
| 3 | **Font samples queued behind renders** (`font_sample` = quiet worker task, waits ≤ 30 s then 503). While a page render runs (and while a job streams, `limit()` = 1), every font picker / fonts-page `<img>` waited, each holding one of the browser's **6 connections per host** → every other REST call of the app stalled behind them | first font detail 4.7 s even on an idle board; samples 503 under load | quiet tasks get their own lane (1 extra slot beyond `limit()`); heavy tasks still obey the limit | samples no longer wait for renders (test `test_quiet_tasks_have_their_own_lane`) |
| 4 | **The board's WiFi link is lossy** (it *is* partly the network, but not bandwidth): laptop→router 0.4 ms, laptop→board p50 27 ms / p90 189–338 ms / max 1.5 s, **5–60 % packet loss**, with board CPU at 2 % (no correlation with load). Server answers in 8–21 ms p99 on localhost | `probe.py` local vs LAN; `ping` with `/proc/stat` sampled each second; UWE5622 SDIO, `tx bitrate 87.8 MBit/s VHT-MCS 2` at −54 dBm | (operational) **plug in Ethernet** — `end0` exists, NO-CARRIER; or move the AP/channel | — |
| 5 | **New TCP connection per click after 5 s idle** (uvicorn `timeout_keep_alive=5`). On that link a fresh connection costs p50 **180 ms**, p90 **1 062 ms**, max 2.5 s vs p50 13 / p90 398 ms kept-alive | `ka.py`: 40 × (new conn, then same conn) | `timeout_keep_alive=75` (env `PENPLOT_KEEPALIVE_S`) | removes the handshake from almost every interaction |
| 6 | Task waits polled `/tasks/{id}` 250 ms→1 s (adds up to 1 s + a lossy round trip to every slow render) although the WS already pushes `task` with the result | studio waterfall: 4–8 `GET /tasks/…` per render | `waitTask` resolves on the WS event (result included), progress from WS; HTTP poll only every 3 s as fallback (short schedule kept while the WS does not track the task) | render result shown at completion, −80 % poll requests |
| 7 | Re-renders on unchanged status frames: the server sends `status` ~4 Hz while connected; each frame was a new object → every `useLive(s => s.machine)` subscriber (MachinePage ~650 components, gate, toolbar, DRO…) re-rendered even when only `updated_at` moved | commits/s with machine idle-but-connected: 6.3 | structural sharing in `applyStatus` (unchanged fields keep references; only-`updated_at` frames are dropped); `MachinePage` uses narrow selectors | **6.3 → 2.3 commits/s**; phone main thread /machine **71 → 36 ms/s**, studio 35 → 21, jobs 23 → 14 |
| 8 | Chrome context churn: `<Page>` pushes `subtitle` (often a new JSX node) into a React context on every page render → toolbar, E-stop layer, attention effects, shortcut sheet re-rendered with every studio render | fiber walk: those components were update origins in every studio commit | chrome state is a Zustand store with selectors; `set()` ignores no-op updates; title/subtitle render in a leaf (`ToolbarTitle`) | they no longer appear as origins |
| 9 | Boot duplicates | `/jobs` cold load 11 API calls (`/machine/lease` ×5), `/auth/state` ×2, `/settings` ×2 on every screen | `refreshLease` single-flight + 1.5 s freshness; first `hello` does not re-fetch a fresh `/auth/state`; onboarding reads `/settings` through the query cache | `/jobs` 11 → 6 requests; no duplicate auth/settings |

Not the cause (measured): front-end CPU. Desktop main thread is busy **10–38 ms per second (1–4 %)** on every
screen, also while a job streams; no long tasks > 50 ms at idle; heap 9–25 MB and flat over the run; click-to-feedback
is fast (font switch 25–130 ms, print sheet opens in 65–112 ms, before and after). Static assets are hashed and cached
`immutable`, pre-compressed (br), `index.html` `no-cache` + ETag; font samples `max-age=600`, render paths `max-age=3600`.

## Numbers

### Server, on the board (localhost, no WiFi)
`GET /machine/status` p50 11 / p99 21 / max 26 ms; `/auth/state` p50 8 / p99 12 ms (`probe.py`, 20 s, 2 render workers at
100 %). So the event loop is not blocked; the outliers seen from the LAN (p90 338 ms, max 1.5 s) are the link.

### Render of the user's project `测试svg` (1 SVG element, 4 399 strokes, 40 674 G-code lines)
| | board old | board new | desktop old | desktop new |
|---|---|---|---|---|
| `render_project` | 80.5 s | 11.8 s | 2.97 s | 0.48 s |

Output (`page-0.gcode`, `page-0.page.bin`, `page-0.machine.bin`) md5-identical old vs new. Remaining cost (cProfile on
the board, new code): `load_svg` (importers, cached per element in `el_cache`) ≈ 40 %, `analyze_gcode` ≈ 25 %,
`optimize_paths` ≈ 10 %, `line_problem` (per-char loop, now a regex fast path) ≈ 5 %.

### Browser (prod build: board = before, same build of this tree via `vite preview` → board = after)
| screen | before commits/s | after | phone ms/s before | after |
|---|---|---|---|---|
| studio (real project) | 6.3 | 2.3 | 35 | 21 |
| machine | 6.3 | 2.3 | 71 | 36 |
| jobs | 6.1 | 2.1 | 23 | 14 |

Studio cold open on the board: UI usable 3.4 s, preview needs the render (5 s `?wait=8` + 202 + polling →
≈18 s for the old render; with fixes 1/2/6 it is ≈12 s first time and one round trip on reload).

## Changes (files)
- `penplot/gcode.py` — `optimize_paths` vectorised (numpy; falls back to the reference loop `_optimize_paths_py` for
  < 64 paths, missing numpy, empty or non-finite coords). Test `test_optimize_paths_matches_reference` + 54 random/tie cases.
- `penplot/machine/base.py` — `line_problem` regex fast path (same messages).
- `penplot/web/tasks/runner.py` — args key without `rid`/`out_dir`; cross-slot sharing + done-result reuse for
  slot-tagged `render_project`/`render_text`; rider counting (`_release`, `_supersede`); quiet lane (`QUIET_LANE=1`).
  Only slot submissions share, because `RenderService.rerender()` picks its own rid and ignores the task result.
- `penplot/web/__main__.py` — `timeout_keep_alive` 75 s.
- `webui/src/api/studio.ts` — WS-driven `waitTask`.
- `webui/src/api/store.ts` — `shareStatus` structural sharing.
- `webui/src/app/chrome.tsx`, `page.tsx`, `toolbar.tsx`, `estop.tsx`, `attention.tsx` — chrome store + selectors.
- `webui/src/app/live-effects.tsx`, `api/collab.ts`, `features/onboarding/state.ts` — boot dedupe.
- `webui/src/features/machine/index.tsx` — narrow selectors (+ hold card, below).
- Also in this pass (coordinator request): stray feed hold. `isStrayHold()` (`api/status-view.ts`): GRBL `Hold*` with no
  active job and no teletype session → pill 「机器暂停」, global banner `HoldBanner` (`app/banners.tsx`) and a card on /machine
  with 「解除暂停」 → `POST /machine/clear-hold` (`api/machine.ts clearHold`), errors via `describeError`. Types regenerated.

Verification: `pytest -q` 160 passed / 2 skipped; `npm run build` OK; e2e desktop-chromium navigation, machine, jobs,
fonts, reconnect, estop, studio: 39 passed, 2 skipped.

## Remaining / recommendations
1. **Ethernet for the board** (biggest single item for "random" slowness). If WiFi must stay: check channel/interference
   (MCS 2 at −54 dBm means heavy retries); the driver (sprdwl_ng) exposes no retry counters.
2. Studio (owner: studio agent): the boot is a serial chain `auth/state → project → papers/profiles/fonts → render`;
   the page render is requested only after everything else arrived. Start the render request in parallel with the
   metadata, and use `wait` ≈ 20 s so most renders answer in the POST itself. Element-preview batches have no slot and
   therefore do not share across clients (they have the IndexedDB + `el_cache` caches).
3. `analyze_gcode` (≈ 25 % of the remaining render, and run again in `start()`, see coordinator's job-start work):
   per-line regex + dict building; a fast path for the generator's own `G0/G1 X Y` lines would roughly halve it.
4. `load_svg` (importers owner): ≈ 40 % of a first render of a large SVG; cached per element afterwards.
5. /projects thumbnails without `thumb_url` fetch each project's full doc (N+1, parallel, once per 10 s stale window).
   A server thumbnail or `?include=doc_summary` on the list would remove ~10 requests per visit.
6. 6-connections-per-host still applies to the fonts page (dozens of `sample.svg`); HTTP/2 needs TLS. Sample results
   are cached on disk, so it only matters on the first visit after a font install.
