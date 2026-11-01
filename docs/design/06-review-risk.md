# 06 — Security & reliability review (risk register)

Scope: `penplot/web/**`, the core it drives (`penplot/machine/*`, `gcode.py`, `compose.py`, `importers/*`,
`export/*`), `deploy/**`, `tests/web/**`, `demos/teletype/` and the in-progress `penplot/web/teletype/`.
Snapshot: working tree 2026-10-31 ~22:05. Other agents were editing `auth.py`, `ws.py`, `context.py`,
`jobs.py` and `collab.py` during the review, so line numbers can drift by a few lines.
Method: code reading, `pytest -q tests/web` (42 passed), an in-process FakeGrbl probe script, and a dev
server on :8092 (FakeGrbl) probed with curl. **V** = reproduced, **R** = established by reading the code,
**?** = needs a check on the board.

Threat model: home LAN over plain HTTP and WPA2 WiFi. Adversaries: (a) any LAN device or browser tab
(including DNS rebinding from the internet), (b) a logged-in low-privilege user once multi-user lands
(viewer/operator), (c) hostile files (SVG/XLSX/zip/G-code from the web), (d) faults: WiFi loss, unplug,
OOM, SIGTERM, SD card. The worst outcome is **physical**: the pen or carriage driven into the frame or
the paper with no limit switches, or the pen left down on the paper.

## 0. Summary (priority order)

| ID | Sev | Area | One line |
|---|---|---|---|
| P1 | critical | physical | Streamed G-code is sent raw: comments and UTF-8 reach GRBL, whose realtime parser runs `!`, `~`, `0x84` (safety door), `0x85` and `0x90–0x9D` from inside comments. `的` = `E7 9A 84`, so it triggers the safety door. |
| P2 | critical | teletype/authz | WS `tt_keys` checks only the lease, not the scope. A **viewer** auto-takes the free lease and can type. In terminal mode this becomes shell input. |
| P3 | high | physical | Soft pause leaves the pen **down** for any G-code whose pen lines do not match `pen_cmd()` exactly (library files, any `pen_*_z`/`z_speed` override). |
| P4 | high | physical | A manual command that returns `error:N` while a job is paused makes the attached Sender `stop()`, so the head rapids to X0Y0 and the job fails. |
| P5 | high | physical | Retry-from-line N re-zeroes (`G10 L20 X0Y0`) wherever the head currently is (`autoSetZero` default), so the rest of the job draws offset. |
| P6 | high | physical | Auto-zero at start with `z_valid=false` runs `set_zero('xyz')` at an unknown Z. After a crash or reconnect with the pen down, every later pen-down plunges 8 mm deeper. |
| P7 | high | physical | The WS `jog` path bypasses the pydantic bounds: `dz=45` was accepted and moved Z 45 mm; NaN raised a 500. REST rejects both with 422. |
| P8 | high | physical | Jog deadman: `jog_cancel` (0x85) can overtake queued or in-flight `$J=` steps. There is no server-side cancel when the jogging client drops. |
| P9 | high | DoS/unauth | Multipart bodies are parsed **before** auth: an unauthenticated 300 MB upload was fully received, then got 401. |
| P10 | high | resource | Project import zip bomb: a 612 KB zip took main-process RSS to **1.31 GB** (VmHWM). Same pattern for XLSX, DXF preview and image import, which all run in the main process. |
| P11 | high | XSS→admin | Uploaded SVG is served same-origin as `image/svg+xml` (`/files/{id}/content`, `/preview.svg`) with no CSP or `nosniff`. Script in it runs with the viewer's session. |
| P12 | high | deploy | `ProtectSystem=strict` without `PrivateTmp`/`TMPDIR` probably makes `/tmp` read-only (?). That breaks multipart spooling >1 MB and the multiprocessing forkserver socket. |
| P13 | high | bounds | The new `out_of_work_area` gate (jobs.py:449) uses a **pen-down-only** bbox. Pen-up travel, Z range, `G28/G30/G53` and arcs are not checked. |
| P14 | medium | latency | The default asyncio executor (8 threads on 4 cores) is shared by `?wait=60` task waits and job **stop**/analysis, so read-scope render spam delays Stop. |
| P15 | medium | multi-user | WS principal is cached at connect. A disabled or demoted user, or a revoked session, keeps jog/pause/stop/teletype control until reconnect. |
| P16 | medium | concurrency | Profile edits apply to the live controller mid-job. The Sender is built from the active profile, not the job snapshot. |
| P17 | medium | resource | `/run` tmpfs (cache 150 MB + staging up to 100 MB + spool) is charged to the service cgroup (`MemoryMax=1200M`) and shares `/run` with systemd. |
| P18 | medium | injection | `/machine/command` and `PUT /grbl-settings` values allow `\n` and realtime bytes, so they can inject multiple commands (`$N0=` startup blocks, `$RST`). G-code files and `start_gcode` can carry `$` lines, which control scope can then write to EEPROM. |
| P19 | medium | deploy | The deploy guard fails open (health unreachable ⇒ restart mid-job). Rollback across a migration crash-loops (`SchemaTooNew`). |
| P20 | medium | auth | Login lockout DoS (global 30/h). `/auth/setup` has no rate limit (8-digit code). Host header not validated (DNS rebinding). Concurrent scrypt bursts. |
| P21 | medium | WS DoS | Unbounded `create_task` per WS message. `presence` spam fans out O(N²). No per-socket rate limit. |
| P22 | medium | teletype | The shell runs as `penplot`, so it can rewrite `penplot.db`, read the journal and share the streamer's cgroup. Output fan-out would reach viewers. `preexec_fn` runs in a threaded process. |
| P23 | low | misc | See §9. |

## 1. Physical safety

### P1 — realtime bytes inside streamed lines (critical, R)
`machine/base.py` `Sender.load_commands()` (only `.strip()`) → `_fill()` → `send(cmd)` writes the whole
line, comments included. `jobs.start()` builds `lines` from the raw file (jobs.py ~465). GRBL 1.1 picks
realtime commands out of the RX stream **wherever they occur, inside comments too**: `?`, `!` (feed hold),
`~` (cycle start/resume), `0x18`, and the extended bytes ≥0x80. `0x84` = safety door, `0x85` = jog
cancel, `0x90–0x9D` = feed/rapid/spindle overrides, `0xA0/0xA1` = coolant. GRBL silently drops every other
byte ≥0x80. UTF-8 CJK continuation bytes are 0x80–0xBF. `的` = E7 **9A 84**, so it changes the spindle
override and then **opens the safety door**. The job halts in `Door` mid-stroke with the pen down, and the
job state machine does not recognize `Door`. A comment such as `(done!)` holds the job, and `~` resumes it.
Sources: library G-code from Chinese tools, `start_gcode`/`end_gcode` and macros, and future `{{var}}`
substitution into start/end G-code (03 §3.4; `compose.substitute` is not wired there yet). The design risk
is that a CSV batch row becomes G-code.
**Fix (core, one place):** sanitize every line before `send()`. Strip `;…` and `(…)` comments, then
**reject** the job or line if anything outside printable ASCII 0x20–0x7E remains or if it contains
`!~?` or 0x18. Do this in `Sender._add` and in the teletype `Streamer.queue`. Do it at import as well
(`analyze_gcode` warning plus a 400 at `POST /jobs`). Also count bytes, not chars, for `RX_CAPACITY`.
`{{var}}` values put into G-code must match `^[A-Za-z0-9 .\-]*$` or be refused.

### P3 — pen tracking by exact string match (high, V)
`base.py:570 _track_pen` sets `_stream_pen_down` only when a line equals `c.pen_cmd(...)` byte for byte.
`pen_cmd` comes from the **active profile** (`Sender(c)`, jobs.py:512), whereas rendered G-code uses the
effective config with overrides (`printcfg.effective`). Probe: a library file using `G1 Z8 F5000` streamed
with `stream_pen_down=False` and `pen_status()='up'` while it was drawing. After a soft pause,
`_pause_lifted=False`, so no pen-up was injected. The pen stays on the paper for the whole pause and the
ink bleeds. Resume does not re-lower it either. The same thing happens for every job with `pen_down_z`,
`pen_up_z` or `z_speed` overrides.
**Fix:** track the pen from the parsed Z word (reuse the `analyze_gcode` rule
`abs(z-zOn)<abs(z-zOff)`; `a.analysis.pen[line]` already exists). Build the Sender's
`MachineConfig` from the job's `profile_snapshot`+overrides. Soft pause should always inject the pen-up
when the analysed state at `sent_line` is down.

### P4 — manual error while paused stops the job and homes (high, V)
`base.py:612-621`: the paused Sender stays attached and has `running=True`. Any `error:N`, including one
from `/machine/command` (probe: `G5 X1` gave `error:20`), a jog rejected by soft limits, or a macro, is
taken as a stream error. `stop_on_error` then calls `stop()`: pen-up, `G90G0 X0Y0`, job → `failed(gcode_error)`.
Probe: the job went paused → failed, and wpos went to (0,0). **Fix:** while paused with `pending==[]`,
detach the Sender listener (or use a gate flag), or tag in-flight manual commands so their replies are
not credited to the Sender. Test: pause, then a bad jog/command; the job must stay paused.

### P5 — retry-from-line re-zeroes at the current head position (high, V)
`jobs.retry()` copies `origin` (whose `set_zero_at_start` is usually null). `start()` then falls back to
`autoSetZero=True` and `_prepare_blocking` sends `G10 P0 L20 X0Y0` (probe log: `['G1G90 Z0.0F5000',
'G10 P0 L20 X0.0Y0.0', …]` after jogging 30/−30). The rest of the page is drawn 30 mm off.
`retry` also checks only `m.origin_valid`, not "same zero as the original" (03 §2.3).
**Fix:** retry jobs store `origin_epoch` and `set_zero_at_start=false`, and `start` refuses with
`409 origin_invalid` unless the epoch matches the source job's epoch.

### P6 — auto-zero Z at an unknown pen height (high, R)
`jobs.py:~501` `set_zero('xyz')  # pen assumed at rest`. After reconnect, MCU reset, ALARM 3 or process
crash, `z_valid=False`, and 03 §2.5 says the pen may be **down**. Zeroing Z there makes Z0 a pen-down
height, so `zOn=8` drives the pen 8 mm into the paper or bed. **Fix:** never zero Z implicitly. If
`z_valid` is false, `start` returns `409 pen_unknown` until the operator confirms "pen is up" (`POST
/machine/zero {axes:'z'}`) or jogs Z. The UI already has "抬笔并重新设零".

### P7 — WS commands bypass validation (high, V)
`context.py:185 ws_command('jog')` calls `float(args[...])` with no bounds. `service.jog` checks only
|dx|,|dy| ≤ 50 (service.py:541), so dz, feed and NaN are unchecked. Probe: WS `dz=45` → ack ok, wpos z=45.
NaN → `jnum` ValueError → 500 (`json.loads` accepts `NaN`). REST `dz=45` → 422. `feed` is passed
unvalidated as well (`'F%d' % 'abc'`).
**Fix:** validate WS `args` with the same pydantic models (`JogRequest`, `PenRequest`, `RealtimeRequest`,
`JobPause`), use `json.loads(parse_constant=reject)`, and move the bounds into `MachineService.jog`
(|dz| ≤ 20, `math.isfinite`, 1 ≤ feed ≤ $110).

### P8 — jog deadman (high, R)
Jogs run on the single cmd-thread (`service.call`), and `jog_cancel` writes 0x85 directly. WS messages are
dispatched with `create_task` (ws.py:127), and REST jogs arrive on separate TCP connections. A `$J=` that
is queued or still in flight when the 0x85 goes out starts **after** the cancel and runs its full length
(≤ 50 mm). If the jogging phone loses WiFi, the last step still completes, and nothing cancels on
disconnect. **Fix:** keep a jog generation counter. `jog_cancel` increments it and `run()` drops stale
steps. Cap each step to about 300 ms of travel (`feed/60*0.3`). Send 0x85 when the WS that issued the
last jog closes or goes 1 s without a step. Process WS `jog`/`jog_cancel` serially per socket.

### P13 — bounds gate is incomplete (high, R/V)
The new gate (jobs.py:449) uses `analyze_gcode` bbox, which only covers pen-down XY (gcode.py ~680). Probe:
`G0 X2000 Y5` travel was not in the bbox. Z range is never checked (Z−50 or Z+30 would crash the pen
stepper). `G28/G30` (stored positions, with no homing on this machine), `G53` (machine coordinates) and
G2/G3 arc bulge are treated as warnings only. `/machine/frame` takes any bbox and feed. **Fix:**
compute travel and Z extents in `analyze_gcode`. Refuse G28/G30/G53/G20 by default, and refuse when
Z ∉ [min(zOff,zOn)−1, max(zOff,zOn)+1]. Check the frame bbox against the work area. Keep
`allow_out_of_bounds` admin-only and audited (verify the router enforces A).

### Other physical items (medium/low)
- **P16 mid-job profile change** (profiles.py:92-101). The comment says the job keeps its snapshot, but
  `m.load_profile(p)` swaps `ctrl.machine` immediately, which changes stop/pause pen commands and tracking.
  Defer `load_profile` until `jobs.active is None` (queue it), or refuse with 409.
- **Realtime `!`/`~` with an active job** (service.py ~713) maps to `jobs.pause/resume` via
  `ensure_future`. In `preparing`/`stopping`, that raises `bad_state`, which is swallowed, and **no hold
  is sent**. Always write the byte as well.
- **SIGTERM/shutdown** (`jobs.shutdown`, jobs.py:80) handles only running/paused. A `stopping` or `preparing`
  job is marked aborted while the machine is still moving, and then `machine.stop()` closes the port. If
  `-hupcl` does not hold DTR (unverified, `deploy/99-penplot-serial.rules`), the close resets the MCU
  mid-move (ALARM 3, pen may stay down). Budget: uvicorn graceful 40 s + 30 s idle wait > `TimeoutStopSec=45`,
  so SIGKILL can land mid-stop. Fix: cancel WS first, wait for Idle inside a budget of about 35 s total, and
  set `TimeoutStopSec=60`.
- **E-stop on non-GRBL** (`halt_blocking`). Marlin `M410` is queued like a normal line unless
  EMERGENCY_PARSER is compiled in. EBB sends `''`, which does nothing. Document this, or use EBB `ES`.
- **Two controllers:** the lease is check-then-set with no lock (collab.py `check`/`_set`). Two operators
  hitting a free lease at once both pass, and admins bypass the lease silently, so two admins can jog at
  once. Make the auto-take atomic and audit admin bypasses.
- **`pause_on_client_loss_s`** exists only as a setting (schemas/system.py:66). It is not implemented.

## 2. AuthN / AuthZ

- **P2 (critical).** ws.py:86-92 `tt_keys` → `collab.check(p)` → `teletype.keys()` with **no
  `p.has('control')`**. `collab.check` auto-takes a free lease for any user, so a viewer gets the
  lease, which also locks operators out with 409 `lease_held`. Once the teletype service lands, a viewer
  can type onto the plotter, and in terminal mode into a shell. Fix: require `control` for `tt_keys`,
  require `admin` when `mode=='term'`, and never let `collab.check` take a lease for a principal without
  `control`.
- **P15.** ws.py `_auth` resolves the principal once. `patch_user(disabled)`, role demotion, `revoke_session`
  and password change do not affect open sockets. Fix: re-resolve per `cmd` (cheap: cache for 2 s), or
  have AuthService publish `session_revoked{user_id}` so the WS closes with code 4401.
- Verified OK: tokens can only be minted from a session (routers/auth.py:117), token scopes ∩ role,
  disabled users are refused, the last admin is protected, CSRF needs `X-Penplot` and the cookie is
  `SameSite=Strict`, the WS cookie path checks Origin, setup code compare uses `compare_digest`,
  sessions are stored as sha256.
- **P20 login/setup.** (a) The global lockout (auth.py:113: 30 failures/h → everyone locked out for 15 min)
  lets any LAN host lock the admin out. Keep per-IP and per-username limits and drop the global lock, or
  exempt known-good session IPs. (b) `/auth/setup` is not rate limited. 10⁸ codes at a few hundred
  requests/s is feasible during the first-boot window. Add the limiter there too. (c) No Host allowlist
  (probe: `Host: evil.example` → 200), so DNS rebinding reaches unauthenticated endpoints, setup and
  login. Add `TrustedHostMiddleware` (board IP, hostname, `*.local`, `localhost`). (d) `login` is a sync
  endpoint: 40 concurrent requests from one IP all pass `check()` before the first `fail()`, which means
  40 scrypt runs × 16 MB plus all 4 cores. Use a semaphore (≤2) around `verify_password`. (e) An unknown
  username skips scrypt, which makes a timing oracle. Verify against a dummy hash.
- **Swagger UI** (`/api/v1/docs`) pulls JS from a CDN into the app origin, so a compromised CDN gets an
  admin session. Vendor the files or disable `/docs` when `dev=0`.
- **No per-project ACL.** Every operator can PUT or DELETE every project and file, and every viewer can
  read them all and receives project patches via `presence(project_id)` with an unvalidated id. That is
  acceptable for a household, but decide it explicitly before "collaboration" ships, and at least
  record `owner_id` and audit deletes.
- Setup code is logged at WARNING on every start until setup completes (auth.py:164). Anyone in
  `systemd-journal`/`adm` can read it. Low; prefer only the 0600 file plus a console hint.

## 3. Injection and parsers

- **P1** (above): G-code comments and bytes.
- **P18.** `CommandRequest.line` (schemas/machine.py) allows `\n`, `\r`, `!`, `~`, 0x18 and bytes ≥0x80,
  so one admin call can carry several commands plus realtime bytes. `GrblSettingsUpdate` values are
  unchecked strings: `{"110":"3000\n$N0=G1Z8F100"}` writes a **startup block that lowers the pen at every
  boot**. Fix: `line` must match `^[\x20-\x7e]{1,80}$` minus `!~?`. Settings values must be numeric, and
  `n` must belong to the known `$` table. Refuse `$N`, `$RST`, `$I=` and `$SLP` in raw commands unless
  forced. Separately, with control scope (not admin), uploaded G-code and `start_gcode` overrides are
  streamed raw, so a `$130=…`, `$N0=…` or `$RST=*` line runs while GRBL is Idle at job start. That bypasses
  the admin-only gate on `$$` writes. Refuse lines starting with `$` in job streams.
- **SVG XXE/entities** (`importers/svg.py:_check_safe`) looks only at the first 64 KB and matches
  `<!ENTITY`/`<!entity` exactly (`<!Entity` passes). Parsing happens in the RLIMIT child, and expat
  ≥2.4 resists amplification, so this is low. Still, reject any `<!DOCTYPE`.
- **P11 SVG XSS (high, V).** `/files/{id}/content` and `/files/{id}/preview.svg` return the uploaded bytes
  as `image/svg+xml` from the app origin (probe: `<script>` delivered verbatim). Opening it in a tab, or
  any future `<iframe>`/`<object>` use, runs script that can call the API with the victim's cookie and
  `X-Penplot`, then create a token or user, run raw commands, or open the shell. With multi-user this is
  operator→admin escalation. Fix: on every user-content response send
  `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'`,
  `X-Content-Type-Options: nosniff` and `Content-Disposition: attachment` (inline only for raster
  previews). Render SVG previews from parsed paths (`compose.preview_svg`) instead of echoing the
  upload. Add global headers `X-Frame-Options: DENY` and a CSP for the SPA.
- **Filenames/paths:** blobs are content-addressed and `ext` comes from `os.path.splitext` (no separator
  possible). Render `rid` is checked for `/` and `..`. Font stems are sanitised. Static files are
  confined by `abspath` prefix. Zip-slip does not apply (member names are not used as paths). OK.
- **`{{var}}`** currently goes into text only (compose.py:116/145). Before it reaches start/end G-code or
  file names, see P1 (allow-list) and keep `name_pattern` output through `attachment()`.

## 4. Resource exhaustion (2 GB board, single process holds the serial port)

- **P9 (high, V).** FastAPI parses `request.form()` before running the auth dependencies, and uvicorn/h11
  has no body limit. Probe: `curl -F file=@300MB …/import/gcode` without a cookie → 401 after
  `size_upload=300000211`. The body is spooled to `/tmp`, which is RAM if tmpfs and SD wear if not. Fix:
  an ASGI middleware that rejects early, (a) when there is no valid session or token on unsafe `/api`
  requests, and (b) when `Content-Length` exceeds the per-route maximum (default 1 MB, uploads ≤ 100 MB).
  It should also stream-count chunked bodies. Set `TMPDIR=/var/lib/penplot/tmp` (P12) or a size-capped
  tmpfs.
- **P10 (high, V).** `Projects.import_bundle` (library.py:558-566) reads up to 200 MB into RAM, then
  `z.read(n)` inflates each member without limits. Probe: a 612 KB zip took VmHWM to 1.31 GB in the main
  process. On the board that is an OOM kill of the streamer mid-job, with the pen down. The same class
  of bug also exists in:
  `Imports.table`/`render.submit_batch` (openpyxl loads `sharedStrings.xml` fully even with `read_only`).
  `Imports.image` decodes and resizes in the main process (`im.convert`, line 298; 40 MP RGBA ≈ 160 MB,
  and `MAX_IMAGE_PIXELS` only raises at 2× = 80 MP). `Files.preview_svg` for DXF runs ezdxf in the main
  process. `Imports.gcode`/`jobs.create` read 50 MB into memory, keep a list of lines and run
  `analyze_gcode` in the main process, so the GIL competes with the RX thread and streaming stutters.
  `render.export` PNG at 600 dpi A3 ≈ 70 MP is rendered in the main process. Fix: every parse, decode
  or inflate goes through `TaskRunner` children (RLIMIT_AS). Check zip `infolist()` totals before
  reading (Σ file_size ≤ 200 MB, ratio ≤ 100, ≤ 1000 members). Check XLSX the same way (it is a zip).
  Stream G-code analysis line by line from the file. Cap `dpi×page area`.
- **P14 (medium, R).** `TaskRunner.wait` does `run_in_executor(None, done_ev.wait, ≤60 s)`, and the default
  pool has `min(32, cpu+4)` = 8 threads. `jobs.stop` (jobs.py:654), `shutdown` (:82) and `start`
  analysis (:465) use the same pool. Eight read-scope `POST /render/text?wait=60` calls therefore delay
  **Stop** by up to 60 s. Fix: await an `asyncio.Event` set via `call_soon_threadsafe`, and give stop
  and estop their own dedicated thread.
- The task queue is unbounded (`runner.submit`), and `_gc` stops at the first queued task. There is no
  per-task wall-clock timeout, so a pathological render pins a slot forever. Cap the queue at about 20
  (429 when full) and set a timeout per kind (render 120 s, ttf 600 s).
- `MemoryHigh=900M` throttles the **whole cgroup**, the serial process included, when render children
  grow. Run children in a sub-cgroup (`Delegate=yes` and move the forkserver into a child cgroup with
  its own `memory.max`), or in a separate `penplot-tasks.service`.
- **P17.** `/run` is about 10% of RAM (~200 MB) and shared with systemd and udev. The render cache
  (150 MB) plus staging is charged to the service's memory cgroup. Put the cache on its own
  `TemporaryFileSystem=/run/penplot:size=192M` or lower `PENPLOT_CACHE_MB` to 64, and prune before
  writing, not only `_on_done`.
- **P21 WS.** ws.py:127 creates a task per message with no bound. `presence` messages each trigger
  `publish_presence()` to every subscriber. Each send `json.dumps` per client per message. Fix: handle
  messages sequentially per socket (estop inline is fine), apply a token bucket (e.g. 20 msg/s, presence
  1/s, coalesced), set `ws_max_size` to 64 KB, and serialise once per message. The "close after 45 s of
  silence" in 03 §5 is not implemented (ws.py:114 keeps looping). It relies on uvicorn pings
  (`ws_ping_timeout=30`), which is acceptable, but document it.
- Bounded already (OK): log ring 5000, bus log buffer 2000, per-client queue 256 with gap, tasks dict
  200, idempotency map 500, teletype overflow 20000.

## 5. Data durability and SD wear

- WAL + `synchronous=NORMAL` is the right choice (no corruption; at most about 1 s of commits lost on
  power cut). Checkpoint every 15 s, `last_seen` at most every 10 min and log ring only in RAM are good.
- **P19 migrations.** `migrate()` backs up to `penplot.db.bak-<cur>` (never pruned), but a rollback to the
  previous release then hits `SchemaTooNew` and crash-loops under `Restart=always`. `002_users` keeps
  the old `admin` table, which goes stale once users change. Fix: `deploy.sh` rollback restores
  `penplot.db.bak-N` when the schema changed (stop, copy, start), or migrations stay
  backward-compatible for one release with a "max_compatible" marker. Keep only the last 3 backups.
- Every job writes its full G-code to `/var/lib/penplot/jobs/` (jobs.py `_insert`), copies included
  (`copies` ≤ 100 × 50 MB = 5 GB of SD writes), and `retry` writes another copy. Fix: hardlink the
  library blob (`os.link`) for file sources, store copies once with `seq` metadata, and add retention
  (prune terminal jobs older than N days).
- No retention exists for `audit`, `job_events`, `files` orphans (`delete` keeps blobs if another row
  shares the sha) or `jobs/*.gcode`.
- `Files.add_staged`: `shutil.move` across filesystems (tmpfs → SD) is copy+unlink, not atomic. A crash
  leaves a partial blob under its final sha name, and dedupe then trusts it forever. Copy to
  `dst+'.part'`, `fsync`, then `os.replace`.

## 6. Deployment

- **P12 (?).** `ProtectSystem=strict` mounts everything read-only except `/dev`, `/proc`, `/sys` and the
  State/Runtime directories, so `/tmp` is probably not writable. Then `tempfile.gettempdir()` fails for
  Starlette's spooled upload (>1 MB) and `multiprocessing` forkserver's `mkdtemp`, and every render or
  upload breaks on the board while working on the dev PC. Check on the board with `systemd-run
  -p ProtectSystem=strict -p User=penplot python3 -c 'import tempfile;print(tempfile.gettempdir())'`.
  Fix: `PrivateTmp=yes` plus `Environment=TMPDIR=/var/lib/penplot/tmp` for large spools.
- Check `DeviceAllow=char-ttyUSB rw` (?). It makes the device policy closed, so confirm that `/dev/ptmx`
  and `/dev/pts` are still allowed (FakeGrbl pty, teletype PTY) and that the CH340 really shows up as
  ttyUSB (not ttyACM).
- Hardening to add (none of these conflict with the app): `PrivateTmp=yes`, `ProtectKernelTunables`,
  `ProtectKernelModules`, `ProtectControlGroups`, `ProtectClock`, `ProtectHostname`,
  `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK`, `RestrictNamespaces=yes`,
  `LockPersonality=yes`, `SystemCallFilter=@system-service`, `SystemCallArchitectures=native`,
  `CapabilityBoundingSet=` (empty), `UMask=0027`, `TasksMax=256`.
- `systemd-journal` group lets the service (and a teletype shell) read **the whole system journal**.
  Only `/system/logs` needs it. Use a root `journalctl` wrapper, or accept this and document it.
- **P19 deploy.sh.** Step 3 runs `curl … || true`, so if the board is slow or unreachable the guard passes
  and step 8 restarts mid-job. Abort unless the health check succeeds and `job_active` is false (or
  `--force`). Step 4 rsyncs the whole working tree: the untracked `core.365*` core dumps in the repo root
  (which may contain secrets from process memory), any `.env` and local DBs all go to the board. Use
  `git ls-files`-based rsync or an allowlist. Rollback ignores DB state (see §5). Health only checks
  HTTP 200, so add `machine_connected` and a `check` of the static files.
- udev rule matches **every** CH340 (1a86:7523) with `SYMLINK+="penplot-grbl"` and runs `stty -hupcl`
  on each. With two CH340s the symlink flaps. Match by `ID_PATH` (USB port).
- Bind `0.0.0.0` is fine on a LAN. Add `PENPLOT_HOST` guidance and the Host allowlist (P20). Never
  port-forward. The default OPi user is in `dialout` and can open the port when the service is down.
  The flock lock covers penplot tools only.

## 7. Teletype (demo now, service in progress)

The demo (`demos/teletype/teletype.py`) runs a **root login shell** on 0.0.0.0:8765, protected by a 72-bit
key passed in the URL query. The key lands in browser history and Referer, and is printed to the journal.
The cookie is not HttpOnly and the key is compared with `==`. `/api/settings` and `/api/jog` take
unbounded values (`z_down`, `dx`). It is acceptable only as a supervised demo and must never run beside
the web service, since both would want the port.

Integration design risks (`penplot/web/teletype/*`, ws.py `tt_keys`):
1. **P2**: the authz gap above. Terminal input must require `admin`, a fresh re-auth (password prompt
   ≤ 5 min old), `settings.teletype.terminal_enabled` (default false), and an audit row per session.
2. **P22 privilege.** `Pty` runs as the service user. That user can write `/var/lib/penplot/penplot.db`
   (an `UPDATE users SET role='admin'` gives a persistent backdoor), read setup codes and the full journal,
   and open the serial port. The setuid branch only applies if the service runs as root, which it must not.
   Fix: run the shell through a separate unit (`systemd-run --uid=<shelluser> --slice=penplot-tty.slice
   -p MemoryMax=256M -p TasksMax=64 --pty`), or a tiny root helper with an allowlisted user. The shell
   must not have write access to the data dir. Otherwise a `make -j4` or fork bomb in the terminal OOMs
   or starves the streamer, because it shares the cgroup.
3. **Output fan-out**: PTY output must go only to the session owner and admins, never to the `teletype`
   topic for all subscribers (events.py:19 adds it to `DEFAULT_TOPICS`). Do not keep a replay log in RAM
   beyond the owner's needs. The paper copy is itself a disclosure, so add a "do not print" pause for
   password prompts (no-echo detection via `termios` `ECHO` flag on the slave).
4. `pty.py:63 preexec_fn` in a multi-threaded process can deadlock the child (CPython docs). Use
   `Popen(user=, group=, extra_groups=, start_new_session=True)` and set the controlling TTY with
   `os.login_tty` in a tiny `exec` wrapper. The auto-restart loop (pty.py:125) respawns a crashing shell
   forever at 1 Hz. Add backoff and a give-up limit.
5. `Streamer.flush()` (stream.py) forgets in-flight bytes that are still in GRBL's RX buffer. Later
   sends assume an empty buffer and can overflow the 128-byte RX buffer, which corrupts lines. Only flush
   after a soft reset (which `halt_abort` should guarantee), or keep accounting until the replies arrive.
   While a session is idle, `busy_reason()` lets manual commands through while the Streamer listener is
   attached. Their `ok`s pop teletype in-flight entries. Gate manual commands while `inflight` is non-empty.
6. Teletype G-code is generated from font strokes (no text reaches G-code). Keep it that way, and
   sanitise through P1 anyway.

## 8. Fault scenarios with no test yet (tests/web)

Physical / stream:
1. A G-code comment containing `!`, `~`, `的` or `0x85` is rejected or stripped before streaming (P1).
   FakeGrbl must model realtime extraction from the stream (it currently parses only whole lines).
2. Soft pause on a library file with `G1 Z8 F5000` and on a job with a `pen_down_z` override: the pen goes
   up (P3).
3. Paused job plus a failing `/machine/command` or jog: the job stays paused and does not home (P4).
4. Retry-from-line after jogging: no `G10 L20` is sent, and `409` is returned if the origin epoch changed (P5).
5. Start after reconnect (`z_valid=false`) with autoSetZero: `409 pen_unknown`, no `G10 … Z0` (P6).
6. WS `jog` with dz=45, NaN or feed='x': rejected like REST (P7).
7. `jog_cancel` racing queued jogs: no `$J=` is written after the 0x85, and the WS close of the jogging
   client sends 0x85 (P8).
8. Out-of-area travel, Z outside the pen range, `G28`/`G53` lines: start refused (P13). `/machine/frame`
   with an out-of-area bbox.
9. Profile PATCH during a running job: pen commands unchanged until the job ends (P16).
10. Realtime `!` during `preparing`/`stopping` still holds.
11. SIGTERM in `stopping`/`preparing`/`hold` paused: the pen ends up and the job reason is `shutdown`,
    within the `TimeoutStopSec` budget. Kill -9 mid-job, then restart: `failed(process_crash)`,
    `origin_valid=false`, no auto-connect reset storm.
12. E-stop while `connecting`, during the hold-stop soft reset, during teletype streaming, and twice
    concurrently (REST + WS). Measure latency from the request to the 0x21 write (< 50 ms target).
13. Unplug during `preparing`, during e-stop and during `_stop_blocking`. Replug with a different CH340.
14. Stop latency with 8 concurrent `?wait=60` renders (P14).

Security / resources:
15. An unauthenticated oversized multipart is rejected before the body is read (P9).
16. Zip bomb, XLSX bomb, 80 MP PNG and a huge DXF: 4xx, and main-process RSS < +50 MB (P10).
17. SVG with `<script>`: content and preview responses carry `CSP: sandbox`, `nosniff` and an attachment
    disposition (P11). An `<!Entity` / DOCTYPE SVG is rejected.
18. Viewer `tt_keys`, viewer lease auto-take, a disabled user's open WS sending `cmd` (P2, P15).
19. Raw command containing `\n` or `!`. Grbl-settings value containing `\n$N0=` (P18).
20. Host header not in the allowlist gets 400. `/auth/setup` brute force is rate limited. The global
    lockout does not lock out other IPs (P20).
21. WS flood: 10k `presence` messages/s keep latency bounded and memory flat (P21).
22. Migration up, then rollback with `.bak` restore (P19). A crash between blob move and DB insert
    leaves no partial blob.
23. Deploy guard: health timeout ⇒ abort.

## 9. Low-severity notes (P23)

- `origin_ok` accepts requests with neither Origin nor Referer. That is fine only because `X-Penplot` is
  required. Keep both checks together; do not drop the header requirement "since Origin is checked".
- `Idempotency` keys are global, not per principal (context.py:26). Another user's response can be
  replayed by key. Namespace keys by `principal.id`.
- `_jog_seq` is global (service.py:537). A second client, or one that reconnected with a lower counter, has
  its jogs silently dropped for up to 1000 seqs. Track it per connection.
- `/machine/connect {port}` opens any existing path (control scope). Restrict it to `ports()` results
  plus the profile port.
- `GET /jobs?limit=`, `/files?limit=` and `/projects?limit=` have no upper bound. Cap them at 500.
- `reset-password --password` puts the password in argv; read stdin.
- Two concurrent TTF conversions with the same stem can overwrite each other (fonts.py:359).
- `/system/restart --force` during a job goes through the SIGTERM shutdown path (§1).

## 10. Suggested order of work

1. P1 sanitizer in the core Sender and Streamer, plus the import-time rejection (small, high value).
2. P2 and P7 WS validation and scope checks (a few lines in ws.py and context.py).
3. P3–P6 pen and origin correctness in jobs.py and base.py, with tests 2–5 from §8.
4. P9–P12 resource and deploy (middleware, child-process parsing, `PrivateTmp`/`TMPDIR`; verify on the
   board).
5. P8 jog deadman and P13 bounds, then P14–P22.
