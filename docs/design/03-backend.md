# 03 — Backend / Platform Architecture & API Spec (penplot web workbench)

Status: design (no code yet). Scope: the Python backend in `penplot/web/`, its contract with the React
frontend (`webui/`), and deployment on the Orange Pi Zero 3. Core library `penplot/` stays usable
from the CLI. Changes the core needs are listed in §10.

## 0. Constraints that shape the design

| Fact | Consequence |
|---|---|
| OPi Zero 3: 4× A53, 2 GB RAM, SD card, Ubuntu 24.04, py3.12 aarch64 | Use only deps with `manylinux aarch64 cp312` wheels or pure Python. Install with `--only-binary :all:`, never compile on the board. Write to the SD card as little as possible. |
| WiFi only, latency spikes and drops | Streaming runs only on the server and never depends on a client. Control calls are safe to retry. WS clients resync from a snapshot. Jog uses deadman increments. |
| GRBL 1.1f on CH340 (`/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0`), Arduino-class board | Opening the port toggles DTR, which **resets the MCU**: position, the Z state and any in-flight planner are lost (see §3.4). CH340 has no serial number, so the by-id name is the same for any CH340. |
| Pen = Z stepper, Z0 up, Z+8 down (`grbl.type=Stepper`, `zOn=8`, `zSpeed=5000`) | Pen state is a *position*. After a reset it is unknown until the operator lifts the pen and re-zeroes. |
| `Sender` streams from the RX thread (`ok` → `_fill` → `ser.write`) | Every serial write goes through **one write lock**. Non-realtime commands are forbidden while a job owns the stream, because they would steal `ok`s from the Sender's FIFO byte accounting. |
| Fonts: 86 `.gfont`, about 224 MB; `GFont.load(load_zip=False)` still reads the whole file | Keep a font metadata and coverage index in SQLite, keyed by (size, mtime). Never scan all fonts per request. |
| No Node/nginx on board | uvicorn serves the API and the pre-built static SPA. Assets are pre-compressed at build time. |
| Other services may already run on the board | Do not touch them. Use our own unit name, user, port (check `ss -ltnp`), paths and venv. |

## 1. Stack (decided)

| Layer | Choice | Why |
|---|---|---|
| HTTP/WS | **FastAPI** + **uvicorn** (1 worker, `--loop asyncio`, `--http h11`, `--ws websockets`) | Single process ⇒ single serial owner. Leave out `uvicorn[standard]`: uvloop/httptools gains are small and watchfiles is dead weight. |
| Models | **pydantic v2** (comes with FastAPI; `pydantic-core` has aarch64 wheels) | Validates requests and generates OpenAPI → TS types. |
| DB | **stdlib `sqlite3`** (WAL), one connection behind a lock, hand-written SQL plus `migrations/NNN_*.sql` | No SQLAlchemy/SQLModel: saves about 15–25 MB RSS and about 0.5 s import on an A53. About 15 small tables do not need an ORM. JSON columns (`json_extract`) hold settings and project docs. |
| Serial | **pyserial** ≥3.5 (`exclusive=True` → TIOCEXCL) | Already used by the core. |
| Uploads | **python-multipart** | Required by FastAPI forms. Pure Python. |
| Password hash | **stdlib `hashlib.scrypt`** (n=2¹⁴, r=8, p=1, 16 B salt, 64 B key ≈ 16 MB, ~120 ms on A53) | No argon2-cffi/bcrypt dependency. Good enough for one admin. |
| CPU work | `multiprocessing` **forkserver** with one process per task, max 2 at a time (§2.7) | Can be cancelled with `terminate()`. Memory is returned on exit. Stays clear of the GIL used by the serial threads. |

Dependency groups (`pyproject.toml` → `[project.optional-dependencies]`). Exact pins live in
`requirements-web.lock`, produced on the dev PC by `uv pip compile --python-platform aarch64-unknown-linux-gnu --python-version 3.12`.

| Extra | Packages | Size / notes |
|---|---|---|
| `web` (required) | `fastapi>=0.115,<1`, `uvicorn>=0.30`, `websockets>=12`, `python-multipart>=0.0.9`, `pyserial>=3.5` | about 12 MB installed |
| `image` | `numpy`, `pillow` (WebP is included in the wheels) | about 45 MB. Needed for PNG/JPG/WebP tracing and PNG export. |
| `vector` | `svgelements` (pure), `ezdxf` (pure; optional C ext wheel) | SVG and DXF import |
| `office` | `openpyxl` (pure) | XLSX batch data. CSV uses stdlib `csv`. |
| `ttf` | `fonttools` (pure) + `image`; `scikit-image` optional (≈ +60 MB with scipy) | TTF/OTF → stroke font. Skeleton mode falls back to the core's Zhang-Suen without skimage. |
| PDF export | **no dependency**: an in-house ~120-line vector PDF writer (`penplot/export/pdf.py`, moveto/lineto streams) | Strokes are plain polylines. reportlab/cairo are not worth the weight. |

Each optional feature is probed at startup (`importlib.util.find_spec`). `GET /system/info.features`
reports what is available, and missing features return `501 feature_unavailable`.

## 2. Process model

```
uvicorn (1 proc, Nice -5) ─ asyncio loop ─ routers ─ EventBus ─► N WS clients ; sd_notify watchdog task
 ├─ MachineService (owns serial): rx-thread (core _rx_loop) · cmd-thread (blocking send(wait_ok)) · poller task ('?') · Sender+JobRunner
 ├─ TaskRunner (forkserver, ≤2 child procs, nice 15) · FontIndex (SQLite cache, glyph LRU, 2-thread pool) · DB (sqlite3 WAL, to_thread)
```

### 2.1 MachineService (asyncio facade over the threaded controller)
| Concern | Rule |
|---|---|
| Ownership | It is the only object that opens the port: `serial.Serial(port, 115200, timeout=0.05, write_timeout=1, exclusive=True)`. A CLI `penplot print` run at the same time gets `EBUSY`, and the API reports `port_busy` with the PID from `fuser`. |
| Writes | `_wlock` (threading.Lock) wraps every `ser.write`, both line commands (Sender, cmd-thread) and realtime bytes (`? ! ~ 0x18 0x85`). Writes are short. `write_timeout=1` turns a vanished device into an exception instead of a hang. |
| Command calls | `await svc.call(fn, *a)` runs core methods (`jog`, `set_pen`, `set_zero`, `send(...,True)`) on the **single cmd-thread**. That serializes them and keeps them off the loop. They are rejected with `409 machine_busy` while `job.state ∈ {preparing,running,stopping}`, and while `paused` unless `sender.pending==[]` and GRBL is `Idle` (§2.3). |
| Realtime path | `svc.rt(b'!')` writes directly under `_wlock` and **does not queue** behind the cmd-thread or Sender. E-stop, hold, resume and jog-cancel use this path. |
| Thread→loop | Core callbacks (`on_event`, `on_log`, Sender `on_progress/on_complete/on_error`) do O(1) work: they update counters and atomics and call `loop.call_soon_threadsafe(bus.publish, ...)` for discrete events only. Progress and status are **sampled** by the poller, never pushed per line. |
| Raw line tap | A new core event `FirmwareEvent('line', text)` (§10). It lets `$$`, `[MSG:]`, `[GC:]` and `ALARM:n` be captured and sent to the log ring. |
| Ring buffers (RAM only) | serial log `deque(maxlen=5000)` holding (t, dir, text); per-job error list. Nothing per line goes to the SD card. |

### 2.2 Status polling
| Machine state | `?` rate | Published to WS |
|---|---|---|
| job running / jogging / homing | 4 Hz (250 ms; GRBL guidance is ≤5 Hz) | `status` ≤4 Hz, `progress` 2 Hz |
| connected, idle | 1 Hz | only on change, plus a heartbeat every 5 s |
| disconnected | 0 (reconnect probe instead, §2.5) | on change |
| e-stop sequence | 10 Hz for ≤2 s | every report |

The poller parses `<State|MPos|WCO|Bf|FS|Ov|Pn>` (core extension §10). **WPos = MPos − WCO**: GRBL
reports WCO only every 10–30 reports, so the service caches it. Idle detection after the last `ok`
comes from the poller and replaces the blocking `wait_idle()`. The core's own `start_status_polling`
is disabled (`settings.updateStatus=false` is forced inside the service) because it starts a new thread
on every `Grbl` banner, i.e. on every soft reset.

### 2.3 Job state machine
```
            create          start                 last ok + Idle
  (none) ──► queued ──► preparing ──► running ───────────────────► done
               │  ▲         │  │       │  ▲
          delete│  └─failed─┘  │  pause│  │resume
               ▼               │       ▼  │
            (gone)             │      paused ──stop──► stopping ──Idle──► aborted(user_stop)
                               │       │                  ▲
                               └───────┴── error/alarm/serial_lost/crash ──► failed(reason)
  any non-terminal ── estop ──► aborted(estop)       terminal: done | failed | aborted
```

| State | Entry actions (on the cmd-thread) | Allowed calls |
|---|---|---|
| queued | job row created; G-code stored; analysis done (lines, bbox, est. time per line) | start, delete, PATCH overrides |
| preparing | connected? → `?` (Alarm ⇒ fail `alarm_locked`) → bounds check against the work area → `origin_valid` or `set_zero` (if `autoSetZero`/override) → pen-up → profile/override `startGcode` → `Sender.load_commands` | estop, stop |
| running | `Sender.start()`; checkpoint `acked_line` to DB every 15 s | pause, stop, estop |
| paused | `soft`: `Sender.pause()` (pen-up after buffered moves, ≤15 planner blocks). `hold`: `rt('!')` first, then `Sender.pause()` (pen stays down until resume). Records WPos at pause. | resume, stop, estop; jog/pen/raw **only if** `pending==0 && Idle` |
| resuming (transient) | if the tool head was moved: `G90 G0 X{px}Y{py}` back to the pause point; `hold` ⇒ `rt('~')`; `Sender.resume()` (pen-down re-inserted) | estop |
| stopping | `Sender.stop()` (pen-up first, then `G90G0 X0Y0`; K_AT paper-out) | estop |
| done/failed/aborted | `endGcode` (done only); `wait Idle`; summary row; ETA calibration update (done only) | retry (→ new job), delete |

- **One active job.** Other jobs wait as `queued`. A finished job **never auto-starts the next**:
  the pen plotter needs paper changed between pages. A multi-page render creates a `batch` of jobs (`seq` 1..n),
  and the UI offers "start next" on `done`. `settings.batch_auto_advance` (default false) plus
  `options.pause_between_pages_s` covers sheet-fed machines (K_AT).
- **Retry from line N** (`POST /jobs/{id}/retry {from_line}`) builds a new job with this preamble: pen-up,
  `G90`, rapid to the XY state reached at line N (computed from the analysis), then the remaining lines.
  It is allowed only if `origin_valid` (same zero as the original), else `409 origin_invalid`.
- **Idempotency** (WiFi retries): control calls are state-idempotent. `start` on `running` returns 200 with the
  current job, and `pause` on `paused` is a no-op. Non-idempotent calls (`jog`, `command`, `zero`) take an
  `Idempotency-Key` header, and the server dedupes (key → response) for 30 s.

### 2.4 E-stop (bypasses everything)
Triggers: `POST /machine/estop`, `POST /jobs/{id}/estop`, WS `{"type":"cmd","op":"estop"}`. The WS path is
preferred because the socket is already open, so the stop does not wait for a new TCP connection over bad WiFi.
Sequence (≤ ~4 s, runs on its own thread, not the cmd-thread):

1. `rt(b'!')` (feed hold, immediate decel); `sender.abort()` (drop the queue and pending items; no more writes).
2. Poll `?` at 10 Hz until `Hold:0` (decel done) or 1.5 s.
3. `rt(b'\x18')` (soft reset: flushes the planner and RX buffer). Wait for the `Grbl` banner (≤3 s).
4. If `Hold:0` was reached before the reset, GRBL keeps its position (no ALARM 3) and `origin_valid` stays true.
   Otherwise it reports `ALARM:3`: send `$X` and set `origin_valid=false`.
5. Pen-up `G1G90 Z{zOff}F{zSpeed}`, **only when** `origin_valid`. If the origin is lost, a work-Z move is
   unpredictable, so the UI shows "pen state unknown: jog Z up, then Zero".
6. Job → `aborted(estop)`; WS `alarm`/`job` events; audit row.

E-stop is never rate-limited, needs only `control` scope, and works in every state, including `preparing`.
The UI button is always visible.

### 2.5 Crash safety, restart, unplug
| Event | What happens physically | Backend behaviour |
|---|---|---|
| Web process dies mid-job (OOM, bug, kill -9) | The port closes. GRBL finishes its buffered moves (≤15 planner blocks + ≤100 B RX, about 1–3 s) and stops, **pen possibly down**. | systemd restarts after 3 s. Startup sees a job row in `preparing/running/paused/stopping` → `failed(process_crash, last_acked_line)`. It does **not** auto-resume. The UI shows a recovery panel: lift the pen, re-zero, "retry from line N". |
| Reopen after the crash | Opening the port asserts DTR → Arduino reset → MPos=0 at the current spot, G54 (EEPROM) still applied ⇒ **work coords invalid**, Z unknown | Connect with `reset=False` (skips the core's 0x18); `origin_valid=false` until the operator zeroes (`POST /machine/zero`) or homes. Mitigation to try on hardware: `stty -F $PORT -hupcl` (installed via udev `RUN+=`) keeps DTR asserted across close and reopen, so restarting the service does not reset the MCU. If that works, a crash leaves GRBL's position intact and we probe `?` to adopt the state. Treat as *unverified*. |
| `systemctl stop/restart`, deploy (SIGTERM) | — | Lifespan shutdown: if a job is active → `Sender.stop()` (pen-up + home), wait Idle ≤30 s (`TimeoutStopSec=45`), mark it `aborted(shutdown)`, broadcast `notice:shutdown`, close WS. `deploy.sh` refuses to restart while `job_active` unless `--force`. |
| USB unplug | `rx_loop` raises and exits (the core currently exits **silently**: fix in §10) | The supervisor sees `rx_thread` dead or a write `SerialException` → `connected=false`, active job → `failed(serial_lost)`, `origin_valid=false`. |
| Replug | MCU power-cycles | The supervisor polls `os.path.exists(port)` every 2 s (backoff to 10 s). If `profile.connection.auto_connect`, it reopens and waits for the banner. A resumed job is never streamed into a freshly reset machine. |
| GRBL ALARM during a job | GRBL locks | The core aborts the Sender; job → `failed(alarm:N)`; WS `alarm` with a hint table (1 hard limit, 2 soft limit, 3 reset in motion, 9 homing fail). Unlock is a deliberate `POST /machine/unlock`. |
| `error:N` reply | — | `stop_on_error` (default true, can be overridden per job): job → stopping → `failed(gcode_error, line, cmd, reply)`. Otherwise the error is recorded and streaming continues. |
| Event loop stall >60 s | — | systemd watchdog kills and restarts (crash path above). The stream would stall anyway, because RX→`_fill` only runs on `ok`. |

### 2.6 Event fan-out
`EventBus` holds a set of subscribers. Each has topic filters and two outboxes: **latest-value slots** for
`status`, `progress` and `system` (always overwritten, never queued) and a bounded `deque(256)` for discrete events (`job`,
`alarm`, `error`, `task`, `log` batches). When the deque overflows, the oldest `log` entries are dropped first and a
`{"type":"gap","dropped":n}` marker is sent. Each client has its own sender task with `wait_for(send, 5 s)`, and a client
that times out is closed (code 1013). Producers never block, so a slow phone on bad WiFi cannot stall
streaming. Log lines are batched every 200 ms and only for clients subscribed to `log`.

### 2.7 TaskRunner (CPU-heavy work)
| Item | Decision |
|---|---|
| Executor | `mp.get_context('forkserver')`, `set_forkserver_preload(['penplot.layout','penplot.gcode','penplot.psf','penplot.geometry'])`. A fresh child per task (≈50 ms spawn). `os.nice(15)`, `oom_score_adj=500` in the child. |
| Concurrency | ≤2 at once (≤1 while a job is `running`, as a safety margin). FIFO queue; `task` rows live in memory and only failures and results are persisted. |
| Kinds | `render_page`, `render_project`, `trace_image`, `import_svg/dxf`, `ttf_convert`, `batch_render`, `font_index`, `export_pdf/png` |
| Results | The child writes its outputs to `/run/penplot/cache/<render_id>/` (tmpfs): `page-N.gcode`, `page-N.paths.bin`, `page-N.svg`, `stats.json`. It returns only a small dict. Large path lists are never pickled back. |
| Progress/cancel | A child→parent `mp.Pipe` carries progress messages (rate-limited 4 Hz) → WS `task`. Cancel = `terminate()`. **Superseded renders**: a request carrying `X-Render-Slot: <client>/<page>` cancels the previous task in the same slot (live preview while typing). |
| Sync façade | `POST` render endpoints take `?wait=5`. If the task ends within 5 s → `200 {result}`, else `202 {task_id}`. Poll `GET /tasks/{id}` or watch WS. |
| Memory | Hard cap per child via `resource.setrlimit(RLIMIT_AS, 700 MB)`, so a bad image cannot OOM the streamer. |

Memory budget: main ≈ 90 MB (FastAPI+pydantic ≈ 55, font coverage bitmaps ≈ 1 MB, glyph LRU ≤ 32 MB) +
2 children × ≤ 400 MB typical ⇒ `MemoryHigh=900M`, `MemoryMax=1200M`. Fonts are read from page cache
(224 MB fits in the remaining RAM), so children do not need their own font caches.

## 3. Data model

### 3.1 Data directories
| Path | Contents | Write rate |
|---|---|---|
| `/var/lib/penplot/` (`StateDirectory`, env `PENPLOT_DATA_DIR`) | `penplot.db` (+wal), `setup-code` (0600, deleted after setup) | low |
| `…/fonts/` (`PENPLOT_FONT_DIR`) | `.gfont`/`.psf` (bundled + uploaded + converted) | rare |
| `…/files/ab/abcdef….<ext>` | library blobs, content-addressed by sha256 (G-code, SVG, DXF, images, CSV/XLSX, project assets) | per save |
| `…/jobs/<job_id>.gcode` | hardlink to the file blob, or the rendered G-code frozen at job creation | per job |
| `/run/penplot/` (`RuntimeDirectory`, tmpfs, env `PENPLOT_CACHE_DIR`) | render cache, upload staging, element path cache, task scratch; LRU-pruned at 150 MB | high (RAM) |

### 3.2 SQLite schema (PRAGMA `journal_mode=WAL, synchronous=NORMAL, temp_store=MEMORY, busy_timeout=5000, foreign_keys=ON`)
| Table | Columns (abridged) |
|---|---|
| `meta` | `key`, `value` (schema_version) |
| `admin` | `id=1`, `pw_hash` (`scrypt$n$r$p$salt$hash`), `created_at`, `pw_changed_at` |
| `sessions` | `id_hash` PK (sha256 of the cookie), `created_at`, `last_seen` (written ≤ every 10 min), `expires_at`, `ip`, `ua` |
| `api_tokens` | `id`, `name`, `hash` (sha256), `scopes` (`read,control,admin`), `created_at`, `last_used` (≤1/10 min), `expires_at?` |
| `profiles` | `id`, `name`, `is_active`, `doc` JSON = MachineConfig (`type,settings,grbl,marlin,ebb,kat,advanced,axes`, as in `configs/grbl-zpen.json`) + `connection{port,baud,auto_connect,reset_on_connect}` + `work_area{w_mm,h_mm}` + `print_defaults` (§3.4), `updated_at` |
| `papers` | `id`, `name`, `builtin` (12 from `page_presets()`, read-only), `width_mm`, `height_mm`, `margins{l,r,t,b}`, `orientation`, `rotation` (0/90/180/270), `ruling{line_num,line_gap,line_gap_offset,base_line}` |
| `projects` | `id`, `name`, `is_template`, `doc` JSON (§3.3), `thumb_file_id?`, `rev` (optimistic lock), `created_at`, `updated_at` |
| `files` | `id`, `kind` (`gcode,svg,dxf,image,text,table,asset,export`), `name`, `sha256`, `size`, `mime`, `meta` JSON (bbox, lines, stats, px size), `tags`, `created_at` |
| `fonts` | `id` (filename stem), `filename`, `format` (`gfont,psf`), `display_name`, `glyph_count`, `size_bytes`, `mtime`, `ref_size`, `coverage` BLOB (zlib BMP bitmap 8 KB + astral list), `source` (`bundled,upload,ttf`), `meta` JSON |
| `jobs` | `id`, `batch_id?`, `seq`, `name`, `source` JSON (`{file_id}`/`{project_id,rev,page}`/`{render_id,page}`/`{batch_row}`), `profile_snapshot` JSON (resolved profile + overrides), `status`, `reason`, `total_lines`, `acked_line`, `est_s`, `elapsed_s`, `errors` JSON (≤50), `origin` JSON, `created_at`, `started_at`, `finished_at` |
| `job_events` | `job_id`, `ts`, `from`, `to`, `detail` (state transitions only) |
| `settings` | `key`, `value` JSON (app prefs: `default_font`, `batch_auto_advance`, `pause_on_client_loss_s`, `poll_hz`, `session_ttl_h`, `eta_factor`, `ui.*`) |
| `audit` | `ts`, `actor` (session/token id), `action` (`estop,raw_cmd,grbl_set,profile_activate,login_fail,…`), `detail` |

### 3.3 Composition model (Project → Pages → Elements)
```jsonc
Project.doc = {"version":1, "name":"…", "variables":[{"name":"name","default":"","type":"text"}],
  "paper": {"paper_id":"a4-normal"} | PaperSpec,  "print": PrintOverrides /* §3.4 */,
  "pages": [{"id":"p1", "paper":null /* override */, "origin":null /* OriginSpec override */,
    "elements": [{"id":"e1", "type":"text|flow_text|image|svg|dxf|shape|gcode",
      "transform":{"x":20,"y":30,"scale":1,"sx":1,"sy":1,"rotation":0} /* mm, page space, y-down */,
      "z":3, "locked":false, "hidden":false, "pen":1 /* future multi-pen */, "props":{…per type…}}]}]}
```

| Element `type` | `props` | Path source (core) |
|---|---|---|
| `text` (box) | `text` (may contain `{{var}}`), `font_id` or `font_mix[{font_id,weight}]`, `size_mm`, `line_height`, `char_space`, `align` L/C/R/D, `box{w,h}`, `jitter` (FontsSet: `randomY,randomRotate,randomFontSize,randomSpace,randomXScale,randomYScale,simple`), `seed` | `TextDocument` with a synthetic `PageInfo` the size of the box |
| `flow_text` | as `text`, plus `ruling` from paper, `paragraph{spe_type,spe_value,left,right}`. It flows across **new pages automatically** (page count is a render output) | `TextDocument.layout/entities` (current `cmd_write` behaviour) |
| `image` | `file_id`, `mode` edge/skeleton/dots, `invert`, `th_low/high`, `blur`, `binarize`, `min_len`, `width_mm`, `simplify`, `spacing_mm`, `gamma` | `penplot.image` (needs `image` extra) |
| `svg` / `dxf` | `file_id`, `units`, `flatten_tol_mm` (0.1), `layers[]`, `stroke_filter` | `svgelements` / `ezdxf` → polylines (new `penplot/importers/`) |
| `shape` | `kind` rect/ellipse/line/polygon/grid, dims, `hatch{angle,spacing}?` | `geometry.Path` primitives |
| `gcode` | `file_id`, `as_paths=true` | `parse_gcode` → paths (re-emitted with this job's profile) |

Render pipeline (in a task child):
`element → paths(mm, element-local)` **cached** in `/run/penplot/cache/el/<hash>.bin`, where
`hash = sha256(type, props, font file mtimes, resolved variables, core version)` (transform is *not* in the hash) →
apply `transform` → z-order concat (hidden dropped) → page paths (mm, y-down) → clip/bounds check against the
paper → **machine transform** (`export_transform` generalised to mm input: rotation, OriginSpec, axes) →
optimize (`nearDst`, greedy order, optional) → `generate_gcode(profile+overrides)` → per-line analysis.
Moving an element only re-runs the last stages. Text is re-laid out only when its own props change.

**OriginSpec** (profile default, overridable per project page and per job):
`{"corner": 0..3 (AxesSettings.pos: LeftUp, RightUp, LeftDown, RightDown), "revxy": bool, "x_rev": bool, "y_rev": bool, "offset_x_mm", "offset_y_mm", "rotation": 0|90|180|270, "set_zero_at_start": bool|null}`.
The `machine` preview shows the post-transform coordinates with the origin marker. `stats.out_of_work_area` uses
`profile.work_area`.

### 3.4 Print settings: resolution order and fields
`effective = profile.print_defaults ⊕ profile.settings/grbl ⊕ project.print ⊕ job.overrides` (right wins;
frozen into `jobs.profile_snapshot`).

| Field | Maps to | Notes |
|---|---|---|
| `feed_rate`, `jog_speed` | `settings.feedRate/jogSpeed` | mm/min |
| `pen_down_z`, `pen_up_z`, `z_speed` | `grbl.zOn/zOff/zSpeed` (Marlin/EBB equivalents) | validated 0…20 mm |
| `tool_on_delay`, `tool_off_delay` | `settings.toolOnDelay/OffDelay` | s (G4 dwell) |
| `optimize`, `near_dst`, `simplify` | `generate_gcode(optimize)`, `nearDst`, RDP tol | |
| `copies`, `copy_gap_mm`, `copy_mode` (`repeat_same` / `tile_x` / `tile_y`) | expands into the job or into N batch jobs | |
| `start_gcode`, `end_gcode` | `advanced.startGcode/endGcode` | `{{var}}` allowed |
| `multi_page` | `separate_jobs` (default) / `one_job_pause_between` (M0-less pause: Sender pause injected) / `first_only` | |
| `stop_on_error`, `origin` (OriginSpec) | Sender, transform | |

### 3.5 Templates and batch
A template is a project with `is_template=1` and `variables[]`. `POST /projects/{id}/batch` with
`{data_file_id (CSV/XLSX), sheet?, mapping{var: column}, rows: "all"|[i…], name_pattern}` runs the
`batch_render` task: one render per row (variables substituted in `text`, `start_gcode`, `file names`), then one
`queued` job per row (×pages) sharing a `batch_id`. A preview of row N is available before committing.

## 4. REST API (`/api/v1`, JSON, errors `{"error":{"code","message","detail"}}`)

Status codes: 400 bad input, 401 unauthenticated, 403 scope, 404, 409 state conflict (`machine_busy`,
`job_active`, `origin_invalid`, `port_busy`), 413 too large, 422 validation, 423 `setup_required`, 429 rate, 501
feature missing, 503 machine disconnected. Lists take `?limit=50&cursor=`. Scopes: **R**=read, **C**=control,
**A**=admin (cookie session = all).

### 4.1 Auth
| Method | Path | Req → Resp | Scope |
|---|---|---|---|
| GET | `/auth/state` | → `{setup_required, authenticated, user:"admin", csrf:false}` | none |
| POST | `/auth/setup` | `{setup_code, password(≥10)}` → sets cookie, `{ok}`; only while no admin exists | none |
| POST | `/auth/login` | `{password}` → `Set-Cookie pp_session`; `{expires_at}` (rate-limited) | none |
| POST | `/auth/logout` | → 204 | session |
| POST | `/auth/password` | `{old, new}` → 204; revokes other sessions | A |
| GET/DELETE | `/auth/sessions`, `/auth/sessions/{id}` | list `{id,ip,ua,created,last_seen,current}` / revoke | A |
| GET/POST/DELETE | `/auth/tokens`, `/auth/tokens/{id}` | POST `{name, scopes[], expires_days?}` → `{id, token:"ppt_<id>_<secret>"}` (shown once) | A |

### 4.2 Fonts
| Method | Path | Req → Resp | Scope |
|---|---|---|---|
| GET | `/fonts` | `?q=&covers=<text>&format=&source=` → `[{id,display_name,format,glyph_count,size_bytes,source,missing?:[ch]}]` | R |
| GET | `/fonts/{id}` | → meta + `ref_size`, header fields, `coverage_summary{cjk,latin,symbols}` | R |
| GET | `/fonts/{id}/coverage` | `?text=` → `{missing:[…]}`; without text → `{ranges:[[lo,hi]…]}` | R |
| GET | `/fonts/{id}/glyphs/{codepoint}.svg` | single glyph SVG (cache-control 1 d; ETag=mtime) | R |
| GET | `/fonts/{id}/glyphs` | `?from=&count=200` → `[{cp, w, path_d}]` (grid browser) | R |
| GET | `/fonts/{id}/sample.svg` | `?text=&size_mm=` (thread pool, ≤200 chars) | R |
| POST | `/fonts` | multipart `.gfont/.psf` (≤30 MB) → font; `.ttf/.otf/.ttc` → `202 {task_id}` (`ttf_convert`) with form fields `mode skeleton/outline, charset gb2312-1/gb2312-2/latin/custom, chars, size_px, simplify_tol, face_index, name` | A |
| POST | `/fonts/{id}/convert` | `{to: "psf"/"gfont"}` → file download (stream) | R |
| PATCH | `/fonts/{id}` | `{display_name}` | A |
| DELETE | `/fonts/{id}` | 409 if referenced by an active job; bundled fonts can be hidden but not deleted | A |
| POST | `/fonts/reindex` | → `202 {task_id}` | A |

### 4.3 Papers, projects, render
| Method | Path | Req → Resp | Scope |
|---|---|---|---|
| GET/POST | `/papers` | PaperSpec CRUD (builtins read-only) | R / A |
| GET/PUT/DELETE | `/papers/{id}` | | R / A |
| GET | `/projects` | `?template=0/1&q=` → `[{id,name,is_template,pages,updated_at,thumb_url}]` | R |
| POST | `/projects` | `{name, doc?, from_template_id?}` → Project | C |
| GET | `/projects/{id}` | → `{id, name, rev, doc}` | R |
| PUT | `/projects/{id}` | `{doc, rev}` → 409 `rev_conflict` if stale | C |
| PATCH | `/projects/{id}/elements/{eid}` | partial props/transform (cheap drag updates; `rev` bump) | C |
| POST | `/projects/{id}/duplicate` · `/save-as-template` | → Project | C |
| GET | `/projects/{id}/export` | → `project.json` bundle (doc + referenced files base64 or `.zip` with `?zip=1`) | R |
| POST | `/projects/import` | multipart json/zip → Project (fonts referenced by id; missing ones reported) | C |
| DELETE | `/projects/{id}` | | C |
| POST | `/projects/{id}/render` | `{pages:"all"/[i], variables?, row?, overrides?}` `?wait=5` → `RenderResult` / 202 | R |
| POST | `/render/text` | quick flowing text without a project (`cmd_write` parity): `{text, font_id/font_mix, paper, align, text_size, char_space, jitter, seed, optimize, profile_id?}` → `RenderResult` | R |
| GET | `/render/{rid}` | → `RenderResult{rid, pages:[{index, stats{draw_mm,travel_mm,pen_lifts}, bbox, est_s, gcode_lines, out_of_work_area, warnings{missing_glyphs, clipped}}]}` | R |
| GET | `/render/{rid}/pages/{i}/preview.svg` | `?space=page/machine&travel=0/1` | R |
| GET | `/render/{rid}/pages/{i}/paths` | compact polylines: `application/octet-stream` (Float32 + offsets), for canvas | R |
| GET | `/render/{rid}/pages/{i}/gcode` | download | R |
| POST | `/render/{rid}/save` | `{page?, name}` → `files` entries | C |
| POST | `/render/{rid}/export` | `{format: svg/png/pdf/gcode/zip, pages, dpi?}` → file or 202 | R |
| GET/DELETE | `/tasks`, `/tasks/{id}` | `{id,kind,state(queued/running/done/failed/cancelled),progress,result,error}` / cancel | R / C |

### 4.4 Imports (each returns a `files` row + parsed meta; elements are created client-side referencing `file_id`)
| Method | Path | Notes |
|---|---|---|
| POST | `/import/image` | PNG/JPG/WebP ≤20 MB, downscaled to `maxImageSize` px; meta `{px_w,px_h}`; `POST /import/image/{file_id}/trace {mode,…}` → 202 preview paths |
| POST | `/import/svg` | ≤10 MB; parsed in a child (svgelements); meta `{bbox_mm, paths, layers}`; XML entity expansion rejected |
| POST | `/import/dxf` | ezdxf; `{layers, units, bbox}` |
| POST | `/import/gcode` | ≤50 MB streamed to disk; analysis `{lines, bbox, stats, est_s, warnings[line>80 chars, unsupported G/M, G91 sections, no pen moves]}` |
| POST | `/import/text` | TXT (utf-8/gb18030 auto-detect) → returns the text |
| POST | `/import/table` | CSV/XLSX → `{sheets:[{name, columns, row_count, sample_rows}]}` |

### 4.5 Files library
| Method | Path | Req → Resp | Scope |
|---|---|---|---|
| GET | `/files` | `?kind=&q=&tag=` → `[{id,kind,name,size,meta,tags,created_at}]` | R |
| POST | `/files` | multipart (dedupe by sha256; 507 if <500 MB free) | C |
| GET | `/files/{id}` · `/files/{id}/content` · `/files/{id}/preview.svg` | meta / raw (Range ok) / preview | R |
| PATCH/DELETE | `/files/{id}` | `{name,tags}` / delete (409 if a queued or active job uses it) | C |

### 4.6 Jobs
| Method | Path | Req → Resp | Scope |
|---|---|---|---|
| POST | `/jobs` | `{source:{file_id}/{project_id,page}/{render_id,page}, name?, profile_id?, overrides?:PrintOverrides, start?:bool}` → Job (`409 job_active` if start and busy) | C |
| GET | `/jobs` | `?status=&batch_id=` → Job[] | R |
| GET | `/jobs/current` | → Job + live progress or 204 | R |
| GET | `/jobs/{id}` | → `Job{id,name,status,reason,total_lines,acked_line,est_s,elapsed_s,eta_s,errors,batch_id,seq,origin,…}` | R |
| PATCH | `/jobs/{id}` | `{overrides,name}` (queued only; re-renders) | C |
| POST | `/jobs/{id}/start` | `{set_zero?: bool}` | C |
| POST | `/jobs/{id}/frame` | `{z:"up", feed?, corners_only?}` → traces the bbox **pen-up** (or `pen_down_light`), then returns to start; queued jobs only; uses cmd-thread | C |
| POST | `/jobs/{id}/pause` | `{mode:"soft"/"hold"}` | C |
| POST | `/jobs/{id}/resume` · `/stop` · `/estop` | | C |
| POST | `/jobs/{id}/retry` | `{from_line?}` → new Job | C |
| GET | `/jobs/{id}/log` | `?since_seq=&limit=` serial log slice (live job only; RAM) | R |
| GET | `/jobs/{id}/gcode` | download | R |
| DELETE | `/jobs/{id}` | queued/terminal only | C |
| POST | `/batches/{id}/start-next` · DELETE `/batches/{id}` | | C |

### 4.7 Machine
| Method | Path | Req → Resp | Scope |
|---|---|---|---|
| GET | `/machine/status` | → `MachineStatus{connected, port, firmware, grbl_state, state_text, wpos[3], mpos[3], wco[3], feed, buf{planner,rx}, ov, pins, pen:"up/down/unknown", origin_valid, last_alarm, job_id}` | R |
| GET | `/machine/ports` | → `[{path, by_id, vid, pid, busy_pid?}]` (`/dev/serial/by-id/*`, `serial.tools.list_ports`) | R |
| POST | `/machine/connect` | `{port?, baud?, reset?:false}` → status | C |
| POST | `/machine/disconnect` | 409 while a job is active | C |
| POST | `/machine/jog` | `{dx,dy,dz,feed?, seq}` (≤50 mm per call; `$J=`); the client repeats small steps while held | C |
| POST | `/machine/jog/cancel` | `0x85` realtime | C |
| POST | `/machine/zero` | `{axes:"xyz"/"xy"/"z"}` → `G10 P0 L20 …` (honours offsets) → `origin_valid=true` | C |
| POST | `/machine/pen` | `{state:"up"/"down"}` | C |
| POST | `/machine/goto-origin` | `G90G0 X0Y0` (pen up first) | C |
| POST | `/machine/homing` · `/unlock` · `/sleep` · `/reset` | `$H` (only if `$22=1`) · `$X` · `$SLP` · `0x18` | C |
| POST | `/machine/estop` | §2.4 | C |
| POST | `/machine/frame` | `{bbox_mm, feed?}` ad-hoc frame | C |
| POST | `/machine/command` | `{line, timeout_s?:10}` → `{ok, reply_lines[]}`; idle only; audited | A |
| POST | `/machine/realtime` | `{byte:"?","!","~","0x18","0x85","0x90".."0x9D"}` (overrides) | C |
| GET | `/machine/grbl-settings` | `$$` → `[{n,value,desc,unit}]` (cached 60 s) | R |
| PUT | `/machine/grbl-settings` | `{ "110": 3000, … }` → writes the diff only (EEPROM); idle only; audited | A |
| POST | `/machine/macro/{1..3}` | runs `advanced.macroN` | C |

### 4.8 Profiles, settings, system
| Method | Path | Req → Resp | Scope |
|---|---|---|---|
| GET/POST | `/profiles` | list / create `{name, doc}` (pydantic mirrors `settings.py` classes; unknown keys kept) | R / A |
| GET/PUT/PATCH/DELETE | `/profiles/{id}` | active profile cannot be deleted | R / A |
| POST | `/profiles/{id}/activate` | 409 while a job is active; reconnects if the port/baud changed | A |
| POST | `/profiles/import` · GET `/profiles/{id}/export` | `grbl-zpen.json` compatible | A / R |
| GET/PATCH | `/settings` | app settings (§3.2) | R / A |
| GET | `/system/health` | **no auth**: `{status:"ok", version, uptime_s, machine_connected, job_active}` | none |
| GET | `/system/info` | `{version, git_sha, built_at, python, os, hostname, ips[], features{image,vector,office,ttf}, data_dir, font_dir}` | R |
| GET | `/system/metrics` | `{cpu_pct[4], load[3], temp_c (/sys/class/thermal), mem{total,avail,proc_rss}, disk{data_free,total}, sd_writes_mb (/proc/diskstats delta), tasks_running}` | R |
| GET | `/system/wifi` | `{iface, ssid, signal_dbm, quality, bitrate, ip}` (`/proc/net/wireless` + `iw dev … link`) | R |
| GET | `/system/logs` | `?n=500&since=&priority=` → `journalctl -u penplot-web -o json` (requires the `systemd-journal` group) | A |
| POST | `/system/restart` | `{force?}` → 202; 409 if a job is active; the process exits 0 and systemd restarts it | A |

OpenAPI: `/api/v1/openapi.json` (auth R), Swagger at `/api/v1/docs` (auth R; assets from CDN, so the browser needs
internet; ReDoc disabled). `webui` generates `src/api/schema.d.ts` from the dumped spec via `openapi-typescript` at
build time (`python -m penplot.web dump-openapi`), so the dev PC does not need the board.

## 5. WebSocket `/api/v1/ws`

Auth: session cookie on upgrade + `Origin` must match `Host` (or the `PENPLOT_DEV` allowlist). Scripts send
`Sec-WebSocket-Protocol: penplot.v1, bearer.<token>`. The token is never placed in the query string (it would end up in logs).
Server ping every 15 s; close after 45 s of silence. Each message carries `seq` (per connection) and `ts`.

| Dir | `type` | Payload |
|---|---|---|
| S→C | `hello` | `{server_version, conn_id, snapshot:{machine:MachineStatus, job:Job/null, tasks:[…], batch?}}`. The client resets its state from this on every reconnect. |
| C→S | `subscribe` | `{topics:["status","progress","job","log","alarm","task","system"]}` (default: all except `log`) |
| S→C | `status` | MachineStatus (≤4 Hz while active; on change while idle) |
| S→C | `progress` | `{job_id, line_acked, line_sent, total, percent, elapsed_s, eta_s, wpos, page, batch_seq}` (2 Hz) |
| S→C | `job` | `{job_id, from, to, reason?, job}` (every transition, created/deleted) |
| S→C | `alarm` | `{code, text, hint, during_job_id?}` |
| S→C | `error` | `{job_id, line, cmd, reply}` (`error:N` replies) |
| S→C | `log` | `{lines:[{t, dir:">"/"<"/"!", text}], dropped}` (200 ms batches) |
| S→C | `task` | `{task_id, kind, state, progress, result?, error?}` |
| S→C | `system` | metrics subset every 5 s (cpu, temp, mem, wifi dBm) |
| S→C | `notice` | `{level, code:"shutdown"/"restart"/"origin_invalid"/"port_busy", message}` |
| S→C | `gap` | `{dropped}` (the client should refetch `/jobs/current` and `/machine/status`) |
| C→S | `cmd` | `{id, op:"estop"/"pause"/"resume"/"stop"/"jog"/"jog_cancel"/"pen"/"realtime", args}` → S→C `ack {id, ok, error?}`. Same rules as REST. `jog` carries `seq` for dedupe. |
| C→S/S→C | `ping`/`pong` | `{t}` (the client measures RTT and shows a WiFi quality badge) |

ETA: the analysis assigns each line `t_i = dist/feed + Z moves (|Δz|/zSpeed) + G4 dwell`. Then
`eta = (T_total − T_acked) × k`, where `k` is the running ratio *actual_elapsed / est_elapsed* of this job (clamped 0.5–3).
Before 30 s have elapsed, `k` comes from `settings.eta_factor`, an EMA over completed jobs (it accounts for acceleration on short strokes).

## 6. Auth & security (LAN, plain HTTP)

| Topic | Decision |
|---|---|
| First run | No admin row ⇒ every API except `/auth/state`, `/auth/setup`, `/system/health` returns `423`. On first boot the server writes an 8-digit code to `/var/lib/penplot/setup-code` (0600) and logs it to the journal. `setup` requires it. This prevents a LAN neighbour from claiming the device first. Reset: `penplot-web reset-password` on the board (CLI subcommand). |
| Hash | `hashlib.scrypt` (§1), compared with `hmac.compare_digest`; params stored with the hash so they can be upgraded. |
| Session | 32-byte random token; cookie `pp_session`, `HttpOnly; SameSite=Strict; Path=/; Max-Age=30d` (sliding, `last_seen` throttled); **no `Secure`** (no TLS). Stored as sha256. |
| API tokens | `Authorization: Bearer ppt_<id>_<secret>` with scopes R/C/A. High entropy, so sha256 is enough. `last_used` is throttled. |
| CSRF | `SameSite=Strict` **plus** unsafe methods (POST/PUT/PATCH/DELETE) with cookie auth must send `X-Penplot: 1` (custom header ⇒ cross-origin forms cannot send it without a CORS preflight, and CORS is off) **and** `Origin`/`Referer` must match `Host`. Bearer requests skip this. |
| Login rate limit | In memory: per IP 5 failures / 5 min → exponential lockout (30 s·2ⁿ, max 15 min); global 30 failures / h → 15 min lock for all IPs (still allows the setup-code reset CLI). Failures are audited. |
| WS | Same cookie + Origin check; scope checked per `cmd`. |
| HTTP without TLS | Accepted risk on a home LAN: passwords and cookies can be sniffed on the WiFi (WPA2 protects the link from outsiders; a compromised LAN host can still intercept). Mitigations: short-lived cookies are optional, raw command/`$$` writes need A scope, and estop always works. Optional later: a self-signed TLS cert via uvicorn `--ssl-*` (env `PENPLOT_TLS_CERT/KEY`); not the default because phones complain about it. Never port-forward. |
| Bind | `0.0.0.0:8080` (survives DHCP/IP changes after WiFi reconnects). `PENPLOT_HOST` can restrict it. |
| Upload safety | Size limits per endpoint, extension + magic sniff, files stored by hash (no user-supplied paths), Pillow `MAX_IMAGE_PIXELS=40e6`, SVG/XLSX parsed in a child with the RLIMIT. |
| Physical safety | `pause_on_client_loss_s` (default off; e.g. 60 ⇒ soft pause when no authenticated WS client has been connected for 60 s during a job). |

## 7. Repository layout

```
penplot/{importers/{svg,dxf,table}.py, export/{pdf,png}.py, compose.py}   new core modules (lazy optional deps)
penplot/web/__main__.py      `python -m penplot.web serve|dump-openapi|reset-password|check`
penplot/web/app.py           create_app(): lifespan (DB, MachineService, TaskRunner, FontIndex), routers, static
penplot/web/{config,db,auth,deps,events,fonts,sysinfo}.py   env→Config (plain os.environ) · sqlite+migrations/ · scopes/CSRF/rate-limit · EventBus · FontIndex · /proc,/sys,iw,journalctl
penplot/web/machine/{service,jobs,analysis}.py               MachineService+supervisor+poller+estop · JobRunner/ETA · per-line time table
penplot/web/tasks/{runner,kinds}.py                          forkserver runner · task entrypoints (pure fns of JSON)
penplot/web/schemas/*.py, routers/{auth,fonts,papers,projects,render,imports,files,jobs,machine,profiles,settings,system,tasks,ws}.py
penplot/web/static/ (not in git: SPA copied by deploy) · _build.json (version, sha, built_at)
webui/                       React+Vite+TS → webui/dist (vite-plugin-compression .br/.gz)
deploy/                      penplot-web.service, web.env.example, 99-penplot-serial.rules, journald-penplot.conf, bootstrap.sh, deploy.sh
requirements-web.lock · tests/web/ (pytest + httpx TestClient + FakeGrbl pty)
```

Static serving: `/assets/*` gets `Cache-Control: public, max-age=31536000, immutable`, served pre-compressed
(`.br`/`.gz` chosen by `Accept-Encoding`, a small custom `StaticFiles` subclass). `index.html` gets `no-cache`. Any
non-`/api` 404 GET falls back to `index.html` (SPA routes). Large API JSON/SVG goes through `GZipMiddleware(minimum_size=2048, compresslevel=5)`.

### 7.1 Environment (`/etc/penplot/web.env`)
`PENPLOT_HOST=0.0.0.0` · `PENPLOT_PORT=8080` · `PENPLOT_DATA_DIR=/var/lib/penplot` (dev `~/.penplot`) ·
`PENPLOT_FONT_DIR=$DATA_DIR/fonts` (the CLI honours it already) · `PENPLOT_CACHE_DIR=/run/penplot` · `PENPLOT_CACHE_MB=150` ·
`PENPLOT_STATIC_DIR=<pkg>/web/static` · `PENPLOT_SERIAL_PORT` (overrides the profile) · `PENPLOT_TASK_WORKERS=2` · `PENPLOT_LOG_LEVEL=INFO` ·
`PENPLOT_DEV=0` (1 = CORS/Origin allowlist `http://localhost:5173`, FakeGrbl, no setup code) · `PENPLOT_TLS_CERT/_KEY` (optional HTTPS).

### 7.2 Logging
stdlib `logging` → stderr → **journald** (no files, no logrotate). Format `level logger message` (journald adds
timestamps); `SyslogIdentifier=penplot-web`. Serial traffic is **not** logged to journald (RAM ring only, see `/jobs/{id}/log`);
journald gets state transitions, errors, alarms, auth events and task failures. Uvicorn access log is off (it chatters with
polling and wears the SD card); WARN-level access lines are logged for 4xx/5xx only. Unit-level `LogRateLimitIntervalSec=30s`,
`LogRateLimitBurst=2000`.

## 8. Deployment on the Orange Pi

### 8.1 Layout on the board (separate from any source checkout and from other services)
| Path | Owner | Purpose |
|---|---|---|
| `/opt/penplot/releases/<YYYYmmdd-HHMMSS>/` | root, read-only to the service | code + `penplot/web/static` |
| `/opt/penplot/current` → release | symlink | atomic switch / rollback (keep 3) |
| `/opt/penplot/venv/` | root | python3.12 venv with deps from `requirements-web.lock` |
| `/var/lib/penplot/` | `penplot:penplot` | state (fonts copied **on the board** once from `<source checkout>/fonts`, not over WiFi) |
| `/etc/penplot/web.env` | root 0640 | env |

The service runs as system user `penplot` (groups `dialout`, `systemd-journal`). `<source checkout>` stays as
the legacy CLI until the web version is proven; its `penplot print` will fail with `EBUSY` while the web service holds the port.
That is intended.

### 8.2 systemd unit `deploy/penplot-web.service`
```ini
[Unit]
Description=penplot web workbench
After=network.target
StartLimitIntervalSec=0

[Service]
Type=notify
User=penplot
SupplementaryGroups=dialout systemd-journal
EnvironmentFile=-/etc/penplot/web.env
Environment=PYTHONPATH=/opt/penplot/current PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WorkingDirectory=/opt/penplot/current
ExecStart=/opt/penplot/venv/bin/python -m penplot.web serve
Restart=always
RestartSec=3
WatchdogSec=60
TimeoutStopSec=45
KillMode=mixed
Nice=-5
MemoryHigh=900M
MemoryMax=1200M
OOMScoreAdjust=-300
StateDirectory=penplot
RuntimeDirectory=penplot
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/penplot /run/lock
DeviceAllow=char-ttyUSB rw
LogRateLimitIntervalSec=30s
LogRateLimitBurst=2000

[Install]
WantedBy=multi-user.target
```

`Type=notify` + `WatchdogSec`: the app sends `READY=1` after the DB, routes and static files are up (serial connect runs
asynchronously and never delays readiness) and `WATCHDOG=1` every 20 s from an asyncio task (stdlib `socket` to
`$NOTIFY_SOCKET`, no dependency). There is deliberately no `After=dev-…device`: the service must start without the plotter
plugged in. `PYTHONDONTWRITEBYTECODE` works because deploy precompiles `.pyc` (`/opt` is read-only under `ProtectSystem=strict`).

### 8.3 Serial exclusivity & udev (`99-penplot-serial.rules`)
```
SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", ATTRS{idProduct}=="7523", GROUP="dialout", MODE="0660", SYMLINK+="penplot-grbl", RUN+="/bin/stty -F /dev/%k -hupcl"
```
Layers: `exclusive=True` (TIOCEXCL) in the service + an advisory `flock(/run/lock/penplot-serial.lock)` that the CLI `print`/`tool`
also take (§10) + one owner process. If a second CH340 is ever attached, switch the profile port to
`/dev/serial/by-path/…` (by-id is ambiguous). Keep ModemManager off the port: add `ENV{ID_MM_DEVICE_IGNORE}="1"` (or
make sure MM is not installed); it is a known source of random bytes sent to CH340/Arduino devices.

### 8.4 `deploy/bootstrap.sh` (once, on the board, as root; idempotent)
`apt-get install -y python3.12-venv` → `useradd -r -s /usr/sbin/nologin -G dialout,systemd-journal penplot` →
`mkdir -p /opt/penplot/releases /etc/penplot && python3.12 -m venv /opt/penplot/venv` →
`install -d -o penplot /var/lib/penplot/fonts && cp -a <source checkout>/fonts/. /var/lib/penplot/fonts/ && chown -R penplot: /var/lib/penplot` →
install the unit + udev rule (`udevadm control --reload && udevadm trigger`) → optional journald drop-in (`SystemMaxUse=64M`, `SyncIntervalSec=5m`;
board-wide, so confirm first) → check port and unit name are free (`ss -ltnp | grep :8080`, `systemctl list-units | grep penplot`; another service may
already use them → `PENPLOT_PORT=8090`) → `systemctl enable --now penplot-web`. No compiler or Node is needed on the board.

### 8.5 `deploy/deploy.sh` (dev PC) — `./deploy/deploy.sh opi [--force] [--deps]`
| Step | Command (abridged) |
|---|---|
| 1 build | `(cd webui && npm ci && npm run build)`; `rm -rf penplot/web/static && cp -r webui/dist penplot/web/static`; write `_build.json` |
| 2 deps lock (if pyproject changed) | `uv pip compile pyproject.toml --extra web --extra image --extra vector --extra office --python-platform aarch64-unknown-linux-gnu --python-version 3.12 --generate-hashes -o requirements-web.lock` |
| 3 guard | `curl -fs http://opi:8080/api/v1/system/health` → abort if `job_active` and no `--force` |
| 4 upload | `rsync -az --delete --link-dest=/opt/penplot/current --exclude fonts/ --exclude .venv/ --exclude out/ --exclude download/ --exclude webui/ --exclude tests/ --exclude '__pycache__' ./ root@opi:/opt/penplot/releases/$TS/` (hardlinks unchanged files ⇒ minimal SD writes) |
| 5 deps | if the lock hash changed: `PIP_NO_CACHE_DIR=1 /opt/penplot/venv/bin/pip install --only-binary=:all: --require-hashes -r requirements-web.lock` |
| 6 precompile | `/opt/penplot/venv/bin/python -m compileall -q -j 4 /opt/penplot/releases/$TS/penplot` |
| 7 preflight | `/opt/penplot/venv/bin/python -m penplot.web check` (imports, migrations dry-run, static present) |
| 8 switch | `ln -sfn releases/$TS /opt/penplot/current.new && mv -T current.new current` (atomic); `systemctl restart penplot-web` |
| 9 health | poll `/system/health` for 30 s; on failure re-point to the previous release, restart, exit 1 |
| 10 prune | keep the newest 3 releases |

DB migrations run at startup inside a transaction. Before applying a migration the DB is copied to `penplot.db.bak-<schema>` with
the sqlite backup API. A rollback to an older release with a newer schema refuses to start (`check` catches this).

### 8.6 SD-card write minimisation (summary)
tmpfs for every cache, preview and upload staging · WAL + `synchronous=NORMAL` · job checkpoint every 15 s and on transitions
only · `last_seen`/`last_used` throttled to 10 min · no serial log to disk · access log off · `.pyc` precompiled at
deploy, `PYTHONDONTWRITEBYTECODE` · rsync `--link-dest` · `PIP_NO_CACHE_DIR` · journald `SystemMaxUse` cap (optional) ·
`/system/metrics.sd_writes_mb` so the effect can be checked.

### 8.7 WiFi drops
| Situation | Behaviour |
|---|---|
| Client loses WiFi mid-job | The job continues (it lives on the server). WS reconnects with backoff 0.5→1→2→5 s and gets a `hello` snapshot; the UI shows a "reconnecting / last seen Xs" banner. |
| Board WiFi drops (wifi-watchdog restarts the iface) | uvicorn stays bound to 0.0.0.0, streaming is unaffected, and the board's IP may change (display `hostname.local` if avahi is present). No dependency on `network-online.target`. |
| Request retried after a timeout | Control calls are state-idempotent; `Idempotency-Key` covers non-idempotent ones; jog `seq` dedupe. |
| Jog while WiFi stalls | The client sends ≤0.3 s worth of `$J=` steps repeatedly while held (deadman), so a lost link stops motion within one step. `jog/cancel` (0x85) is sent on release, best-effort. |
| Estop under bad WiFi | Sent first over the open WS, with an HTTP fallback in parallel; the server dedupes. |

## 9. Targets & tests

Targets (verify on the A53): cold start to READY <4 s · status latency <20 ms · one-page (~400 CJK chars) live preview <1.5 s (<0.3 s on element-cache hit) · RX→`_fill` <1 ms with no stream stall while 2 tasks run · TTF conversion runs in the background and can be cancelled.
Tests: **FakeGrbl** pty (`os.openpty`) emulating 1.1f (128 B RX, planner timing, `?`, `! ~ 0x18 0x85`, `ALARM:3` on reset in motion, `error:N`, unplug = close). Cases: `cmd_print` parity, soft/hold pause, estop timing, kill mid-job → `failed(process_crash)`, replug, a slow WS client does not slow the stream, auth/CSRF/rate-limit, migrations.

## 10. Required changes in the core `penplot/` (small, backwards compatible)

| # | File | Change | Why |
|---|---|---|---|
| 1 | `machine/base.py` | `open(port, baud, exclusive=True, reset=True, write_timeout=1)`; `_wlock` around every `ser.write`; `write_realtime(b)` | exclusivity, thread-safe writes, attach without resetting the MCU |
| 2 | `machine/base.py` | `_rx_loop` exception → `connected=False`, emit `FirmwareEvent('disconnected', reason)` | today an unplug is silent |
| 3 | `machine/base.py` | emit `FirmwareEvent('line', text)` for every RX line before dispatch | `$$` capture, `[MSG:]`, log ring |
| 4 | `machine/base.py` `Sender` | counters `acked`, `sent`, `line_of_pending_head`; `insert_front(cmds)` for return-to-pause-point; `on_progress` contract: O(1), may be called from the RX thread | progress/ETA, resume after jog |
| 5 | `machine/grbl.py` | parse `WCO`, `Bf`, `FS`, `Ov`, `Pn`; compute WPos; one status poller at most (guard against a new thread per banner); `$$` collection API | correct position, no thread leak |
| 6 | `layout.py` | `export_transform` accepts mm input and an OriginSpec (corner/offset/rotation as data) | composition model |
| 7 | `gfont.py` | `read_header(path)` that reads only the header bytes and the ZIP central directory (seek from the end) → coverage | fast indexing without loading 224 MB |
| 8 | `cli.py` | `print`/`tool` take `flock(/run/lock/penplot-serial.lock)`, fail fast if held | coexistence with the web service |
| 9 | `gcode.py` | `analyze_gcode(text, mc) → (per_line_time array, positions, bbox, stats, warnings)` | ETA, retry-from-line, import validation |
| 10 | new | `importers/`, `export/pdf.py`, `export/png.py`, `compose.py` | formats + project rendering |

## 11. Open risks

| Risk | Impact | Mitigation |
|---|---|---|
| DTR auto-reset on port open (Arduino + CH340) | Any service restart mid-job, or even an idle reconnect, loses work coordinates and pen Z | `-hupcl` udev trick (verify on hardware); `origin_valid` flag; never auto-resume; recovery UI |
| Process death leaves the pen down on paper | ink blot, possible paper tear | systemd restart + recovery banner; shutdown path lifts the pen; keep the main process tiny and move heavy work to rlimited children |
| GIL contention between the RX thread and the event loop | stream hiccups (GRBL starves when the planner drains) | CPU work only in child processes; endpoints async and short; 4 Hz sampling instead of per-line callbacks |
| Plain HTTP on WiFi | session sniffing by a compromised LAN host | scopes, audit, optional TLS env, setup code |
| SD card wear and corruption on power loss | DB loss | WAL+NORMAL, backups before migration, tmpfs caches; recommend a high-endurance card |
| Memory: big image traces or many-page flow text | OOM kills the streamer | RLIMIT_AS on children, `MemoryHigh`, OOMScoreAdjust (main −300, children +500), max image pixels |
