# 04 — Contract notes (backend ⇄ frontend)

Authoritative machine-readable contract: `docs/design/openapi.json` (regenerate with
`.venv/bin/python -m penplot.web dump-openapi > docs/design/openapi.json`). This file gives concrete
JSON examples and the behaviour the schema cannot express. Base URL `/api/v1`.

## 1. Conventions

- **Auth**: cookie `pp_session` (HttpOnly, SameSite=Strict) set by `/auth/setup` and `/auth/login`.
  Every `POST/PUT/PATCH/DELETE` sent with the cookie must carry header **`X-Penplot: 1`** (also for
  `/auth/login`, `/auth/setup`, `/auth/logout`). Scripts use `Authorization: Bearer ppt_<id>_<secret>` instead (no header needed).
- **First run**: while no admin exists every endpoint except `/auth/state`, `/auth/setup`, `/system/health`
  answers `423 setup_required`. `GET /auth/state` tells the UI which screen to show.
- **Errors** always: `{"error":{"code":"…","message":"…(zh-CN)","detail":…}}`. 422 validation errors use
  the same envelope with `code:"validation_error"` and `detail:[{loc,msg,type}]`.
- **Times** are Unix seconds (float). **Lengths** in mm. **Ids** are short opaque strings.
- **Coordinates**: *page space* = mm from the page top-left, **y down** (what the canvas uses).
  *Machine space* = GRBL work coordinates, mm, origin = pen position at job start, **y up**
  (for the default LeftUp origin content has x ≥ 0, y ≤ 0).
- **Long work** (`POST /projects/{id}/render`, `/render/text`, `/import/image/{id}/trace`, batch):
  query `?wait=5` (default 5 s, 0 = return at once). Finished in time → `200` with the result; otherwise
  `202 {"task_id","kind","state"}`, then watch WS `task` messages or poll `GET /tasks/{id}`; the final
  task `result` is the same object the 200 would have returned.
- **Live preview**: send header `X-Render-Slot: <clientId>/<pageId>` with renders; a new render in the same
  slot cancels the previous one still running (its task ends `cancelled`).
- **Idempotency**: `POST /machine/jog|zero|command` accept `Idempotency-Key: <uuid>` (deduped 30 s).
  Job control calls are state-idempotent (pause on paused = 200 no-op).
- **409 codes**: `machine_busy`, `job_active`, `origin_invalid`, `pen_unknown`, `out_of_work_area`, `port_busy`,
  `rev_conflict`, `in_use`, `bad_state`, `lease_held`, `element_locked`, `builtin`, `teletype_active`, `need_paper`,
  `last_admin`. **400** `unsafe_gcode`, `bad_command`, `bad_setting`. **413** `too_large`, `zip_bomb`.
  **503** `machine_disconnected`. **501** `feature_unavailable`. Every error has a zh-CN `message` ready to show.
- **Roles** (§13): `admin` (everything), `operator` (read+control), `viewer` (read; may e-stop). Motion/job control
  additionally needs the **control lease** (§14). E-stop (`POST /machine/estop`, `/jobs/{id}/estop`, WS `estop`)
  works for every signed-in user, always.

## 2. Error body
```json
{"error": {"code": "machine_busy", "message": "任务进行中，手动操作被拒绝", "detail": {"job_id": "j7f3a2c1", "status": "running"}}}
```
```json
{"error": {"code": "validation_error", "message": "请求参数不合法",
           "detail": [{"loc": ["body", "dx"], "msg": "Input should be less than or equal to 50", "type": "less_than_equal"}]}}
```

## 3. Auth
`GET /auth/state`
```json
{"setup_required": false, "authenticated": true, "user": "admin", "csrf": true,
 "setup_code_required": true, "scopes": ["read", "control", "admin"], "via": "session", "dev": false}
```
`GET /auth/state` also carries `user_info:{id,username,display_name,role}` and `role`.
`POST /auth/setup` `{"setup_code": "<8位初始化码>", "username": "admin", "password": "至少十个字符的密码"}` → `{"ok": true}` + cookie
(creates the first **admin** user; dev mode: `setup_code` may be omitted).
`POST /auth/login` `{"username":"ann","password":"…"}` (username optional when there is a single user / `admin`) →
`{"ok":true,"expires_at":1793952000.0}`;
wrong password `401 bad_password`; lockout `429 rate_limited` with `detail.retry_after_s`.
`POST /auth/tokens` `{"name":"ci","scopes":["read","control"],"expires_days":90}` →
```json
{"id": "a1b2c3d4", "name": "ci", "scopes": ["read", "control"], "created_at": 1761900000.0,
 "last_used": null, "expires_at": 1769676000.0, "token": "ppt_a1b2c3d4_Zx9…"}
```

## 4. MachineStatus (`GET /machine/status`, WS `status`)
```json
{"connected": true, "connecting": false, "port": "/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0",
 "baud": 115200, "fake": false, "firmware": "1.1f", "grbl_state": "Idle", "state_text": "空闲",
 "wpos": [12.5, -40.0, 0.0], "mpos": [112.5, -60.0, 0.0], "wco": [100.0, -20.0, 0.0],
 "feed": 0.0, "spindle": 0.0, "buf": {"planner": 15, "rx": 128}, "ov": [100, 100, 100], "pins": "",
 "pen": "up", "origin_valid": true, "last_alarm": null, "job_id": null, "busy": false,
 "error": null, "updated_at": 1761900123.4}
```
- `pen`: derived from work Z when `origin_valid` (closer to `zOn` → down), else from the last pen command, `unknown` after a reset.
- `origin_valid=false` after (re)connect / reset / ALARM:3 → UI shows "抬笔并重新设零".
- `busy=true` → manual controls (jog/pen/zero/command) will get `409 machine_busy`.
- Also: `machine_type`, `profile_id`, `profile_name` (display name of the active machine profile), `teletype` (a paper
  terminal session holds the machine).
- **Z reference**: jobs only zero **XY** at start. After (re)connect/reset the pen height is unknown and `start` answers
  `409 pen_unknown` until the operator lifts the pen and calls `POST /machine/zero {"axes":"xyz"}` (UI: 「抬笔并设为原点」).
- `last_alarm`: `{"code": 3, "text": "ALARM:3", "hint": "运动中复位，坐标已丢失：请抬笔并重新设零", "ts": 1761900000.0, "during_job_id": "j1"}`.
- Disconnected: `{"connected": false, "port": "/dev/…", "grbl_state": "", "state_text": "未连接", "wpos": null, "mpos": null, "wco": null, "pen": "unknown", "origin_valid": false, "error": "port_busy: pid 1234", …}`.

## 5. Job (`GET /jobs/{id}`, WS `job.data.job`)
```json
{"id": "j7f3a2c1", "name": "书信 第1页", "status": "running", "reason": null,
 "batch_id": null, "seq": 1,
 "source": {"file_id": null, "project_id": "p01", "rev": 7, "page": 0, "render_id": "r9c2", "variables": null, "batch_row": null, "retry_of": null, "from_line": null},
 "profile_id": "default", "overrides": {"feed_rate": 1800},
 "total_lines": 5231, "acked_line": 1200, "sent_line": 1214, "percent": 22.9,
 "est_s": 1260.0, "elapsed_s": 300.2, "eta_s": 960.5,
 "errors": [], "origin": {"corner": 0, "revxy": false, "x_rev": false, "y_rev": false,
   "offset_x_mm": 0.0, "offset_y_mm": 0.0, "rotation": 0, "set_zero_at_start": null},
 "bbox": [31.6, -270.4, 177.3, -25.4], "out_of_work_area": false,
 "created_at": 1761900000.0, "started_at": 1761900010.0, "finished_at": null,
 "pause_mode": null, "can_retry_from": 1200}
```
Statuses: `queued → preparing → running ⇄ paused → stopping → done | failed | aborted`.
`reason` values: `user_stop`, `estop`, `alarm:N`, `gcode_error`, `serial_lost`, `process_crash`, `shutdown`,
`alarm_locked`, `not_connected`, `prepare_failed`, `pen_unknown`.
`issues: string[]` lists safety problems found when the job was created (travel incl. pen-up moves outside the work
area, Z outside the pen range, G28/G30/G53). `start` with issues → `409 out_of_work_area` (`detail.issues`); an admin
may pass `{"allow_out_of_bounds": true}` (audited). Job G-code is stored comment-free; lines with realtime characters
(`! ~ ?` 0x18), non-ASCII bytes or `$` commands are refused at creation (`400 unsafe_gcode`, `detail.line`).
Retry jobs (`retry {from_line>1}`) never re-zero and start only while the origin epoch of the source job is unchanged
(`409 origin_invalid` otherwise). `overrides.placement {dx_mm, dy_mm}` shifts the drawing (page mm right/down). `errors[]`: `{"line": 812, "cmd": "G1 X…", "reply": "error:20", "ts": …}`.
Create: `POST /jobs` `{"source":{"render_id":"r9c2","page":0},"name":"书信","overrides":{"feed_rate":1800},"start":true}`
(or `{"source":{"file_id":"f12"}}` for a library G-code, or `{"source":{"project_id":"p01","page":0}}` which renders first).

## 6. RenderResult (`POST /projects/{id}/render`, `/render/text`, `GET /render/{rid}`)
```json
{"rid": "r9c2", "created_at": 1761900000.0, "project_id": "p01", "project_rev": 7, "profile_id": "default",
 "elapsed_ms": 812.0,
 "pages": [{"index": 0, "source_page": 0, "width_mm": 209.0, "height_mm": 296.0,
   "stats": {"draw_mm": 10234.5, "travel_mm": 3120.1, "pen_lifts": 1520, "strokes": 1520},
   "bbox": [31.8, 25.4, 177.2, 270.6], "machine_bbox": [31.8, -270.6, 177.2, -25.4],
   "est_s": 1260.0, "gcode_lines": 5231, "out_of_work_area": false,
   "warnings": {"missing_glyphs": ["龘"], "clipped": false, "overflow": false, "messages": []}}]}
```
Per page: `GET /render/{rid}/pages/{i}/preview.svg?space=page|machine&travel=0|1`, `…/paths?space=page|machine`
(binary, below), `…/gcode` (download). Results live in RAM cache (LRU, ~150 MB); a `404` on an old `rid` means: render again.

**paths binary** (little endian): `u32 magic 0x314C5050 ("PPL1")`, `u32 n`, `u32 offsets[n+1]` (point
indices), `f32 xy[2*offsets[n]]`. Polyline *k* = points `offsets[k] .. offsets[k+1]-1`. Order = pen order
(travel moves are between the end of k and the start of k+1).

## 7. PaperSpec (`GET /papers`)
```json
{"id": "a4-normal", "name": "A4普通边距", "builtin": true, "width_mm": 209.0, "height_mm": 296.0,
 "margins": {"l": 31.8, "r": 31.8, "t": 25.4, "b": 25.4}, "orientation": "portrait", "rotation": 0,
 "ruling": {"line_num": 20, "line_gap": 0.0, "line_gap_offset": 0.0, "base_line": 1.0}}
```
Builtin ids: `a4-normal a4-narrow a4-moderate a4-wide a3-… 16k-…` (from `layout.page_presets()`), read-only (PUT/DELETE → 409 `builtin`).
`orientation:"landscape"` swaps width/height for layout. `rotation` rotates the page onto the machine.
Projects reference papers by `{"paper_id": "a4-normal"}` or inline `{"paper_id": null, "spec": {PaperBase…}}`.

## 8. Project.doc (each element type)
```json
{"version": 1, "name": "书信",
 "variables": [{"name": "name", "default": "", "type": "text", "label": "收件人"}],
 "paper": {"paper_id": "a4-normal", "spec": null},
 "print": {"feed_rate": 1800, "optimize": true},
 "pages": [{"id": "p1", "paper": null, "origin": null, "elements": [
   {"id": "e1", "type": "flow_text", "name": "正文", "transform": {"x": 0, "y": 0, "scale": 1, "sx": 1, "sy": 1, "rotation": 0},
    "z": 0, "locked": false, "hidden": false, "pen": 1,
    "props": {"text": "亲爱的{{name}}：\n…", "font_id": "open-wenkai-stroke", "font_mix": null, "text_size": 1.0,
              "char_space": 0.0, "align": "L", "paragraph": {"spe_type": 1, "spe_value": 8.0, "left": 0, "right": 0},
              "line_num": null, "seed": 42, "missing_glyph": "box",
              "jitter": {"randomY": 0.05, "randomRotate": [-3, 3], "randomFontSize": [0.95, 1.05], "randomSpace": [1, 1],
                         "randomXScale": [1, 1], "randomYScale": [1, 1], "randomFirstPos": 0, "simple": 0,
                         "widthAdd": 0, "spaceWidthAdd": 0, "tabWidthAdd": 0, "baseLine": 1, "chars": "，,.。"}}},
   {"id": "e2", "type": "text", "transform": {"x": 120, "y": 250, "scale": 1, "sx": 1, "sy": 1, "rotation": 0}, "z": 1,
    "locked": false, "hidden": false, "pen": 1,
    "props": {"text": "{{name}} 敬上", "font_id": "penplot-sans", "size_mm": 8, "line_height": 1.3, "char_space": 0,
              "align": "R", "box": {"w": 60, "h": 12}, "seed": 1, "jitter": {}, "missing_glyph": "box"}},
   {"id": "e3", "type": "image", "transform": {"x": 20, "y": 200, "scale": 1, "sx": 1, "sy": 1, "rotation": 0}, "z": 2,
    "props": {"file_id": "f3", "mode": "edge", "width_mm": 50, "invert": false, "th_low": 0.1, "th_high": 0.25,
              "blur": 1.4, "binarize": 0.5, "min_len": 6, "simplify": 0.6, "spacing_mm": 1.2, "gamma": 1.0, "max_px": 1200}},
   {"id": "e4", "type": "svg", "transform": {"x": 150, "y": 30}, "z": 3,
    "props": {"file_id": "f4", "units": "auto", "width_mm": 30, "flatten_tol_mm": 0.1, "layers": null, "stroke_filter": null}},
   {"id": "e5", "type": "dxf", "transform": {"x": 10, "y": 10}, "z": 4, "props": {"file_id": "f5", "width_mm": null, "layers": ["0"]}},
   {"id": "e6", "type": "shape", "transform": {"x": 30, "y": 40}, "z": 5,
    "props": {"kind": "grid", "w": 150, "h": 30, "rows": 1, "cols": 10, "grid_style": "tian", "hatch": null}},
   {"id": "e7", "type": "gcode", "transform": {"x": 0, "y": 0}, "z": 6, "props": {"file_id": "f6", "as_paths": true}}
 ]}]}
```
Element semantics:
- `transform`: element origin placed at (x, y) page mm; `scale×sx`, `scale×sy` scale; `rotation` degrees clockwise around the element origin.
- `flow_text`: lays out in the page's margin box (paper ruling `line_num` lines), x/y shift it; it **adds pages** when the
  text overflows (render output can have more pages than `doc.pages`; `source_page` tells which project page made it).
- `text`: a box at the element origin; `size_mm` = glyph em height; lines of `size_mm*line_height`; wraps at `box.w`
  (no wrap if `box` null); lines beyond `box.h` are dropped and `warnings.overflow=true`.
- `image`/`svg`/`dxf`/`gcode`: element-local origin = top-left of the content's bbox; `width_mm` scales (image: required;
  svg/dxf: null = native units; gcode: native mm, y flipped to page space).
- `svg` text (`<text>/<tspan>`): `props.text_mode` `font` (default) draws it with a single-stroke font,
  `outline` keeps only geometry the file already has (live text is not drawn; warning), `skip` ignores text.
  Font per run: `text_font_map` (SVG font-family name, case-insensitive, first mapped name in the family list
  wins) → `text_font_id` → app default font. `text_size_scale` multiplies every font-size around each glyph's
  origin (baselines stay put); `text_jitter` = text Jitter shape (subset used: randomFontSize, randomX/YScale,
  randomRotate, randomY ×em, randomSpace on a 0.15 em gap, baseLine, simple), `text_seed` (null = from element id),
  `missing_glyph` `box|skip`. Missing chars go to page `warnings.missing_glyphs`; textPath (laid out as plain text),
  vertical writing-mode (upright, top-to-bottom), flowRoot (ignored) and >20000 chars add `warnings.messages`.
  **Size mapping**: SVG font-size = em; the stroke font's em is estimated per font as the stored advance of an
  ideograph (国/中/永/一), else CJK ink height / 0.80, else cap height of `H` / 0.70, else `size/1.3`; glyph
  baseline (font y=0) sits on the SVG baseline. Glyphs without a stored advance get ink width + 2×0.06 em
  (ideographs: 1 em, centred); spaces 0.3 em. Supported: x/y/dx/dy/rotate lists (descendants override, per char),
  ancestor transforms + viewBox, `<use>`, font-size px/pt/mm/em/%/keywords, text-anchor per text chunk,
  dominant-/alignment-baseline (middle, central, hanging, text-before/after-edge, ideographic …), baseline-shift,
  letter-/word-spacing, xml:space / CSS white-space, simple `<style>` rules (tag/.class/#id), `layers` and
  `stroke_filter` (matches the text's stroke or fill). The element path cache key includes the identity
  (name, size, mtime) of every font the text may use.
- `shape`: `rect`/`ellipse` of `w×h` from the element origin; `line`/`polygon` from `points` (`closed`); `grid` = `rows×cols`
  cells over `w×h` with `grid_style` `plain|tian(田)|mi(米)`; optional `hatch{angle,spacing}` fill for rect/ellipse.
- `{{var}}` in text props and `print.start_gcode/end_gcode` is replaced from `variables` (render request `variables`/batch row → defaults).
- `hidden` elements are not rendered; `z` sorts (ascending = drawn first); `locked` is UI-only.

### 8.1 Page.background (reference background — never printed)
```json
{"id": "p1", "background": {"file_id": "f9a1", "source_id": "f9a0", "page": 0, "page_count": 3, "name": "方格本.pdf",
  "px_w": 1240, "px_h": 1754, "natural_mm": [210.0, 297.0],
  "transform": {"x": 104.5, "y": 148.0, "scale": 0.1694, "rotation": -0.4},
  "opacity": 0.5, "visible": true, "locked": false, "calib": {"a": [102.0, 140.5], "b": [1130.0, 141.2], "mm": 174.0}},
 "elements": [...]}
```
- A scanned note template / sheet shown under the design in the studio, the position preview and the print thumbnail.
  **Never** part of render paths, G-code, SVG, PDF or jobs (renders don't even resolve `file_id`); optional faint layer
  in the PNG export (`RenderExport.background: true`, visible backgrounds only).
- `transform`: `x`,`y` = page mm of the image **centre**; `scale` = mm per image pixel (size = `px_w*scale × px_h*scale`);
  `rotation` = degrees clockwise around the centre. SVG: `translate(x y) rotate(r) scale(s) translate(-px_w/2 -px_h/2)`.
- `calib` = the last two-point calibration in image px (UI re-edit + origin snap targets). `locked` is UI-only.
- `POST /import/background` (multipart `file`, form `page`=0, `dpi`=150, ≤ 20 MB): PNG/JPEG/WebP → EXIF rotation baked in,
  longest side ≤ 3000 px, re-encoded (JPEG, PNG if alpha); PDF → page rasterised (pypdfium2, `features.pdf`; 501 without it),
  the PDF kept as `source` (kind `asset`). → `201 {"file": FileInfo(image), "source": FileInfo|null, "page", "page_count",
  "px_w", "px_h", "dpi", "natural_mm"}` (`natural_mm` from the PDF page size or a scanner dpi; 72/96 dpi = unknown).
  Errors `400 bad_image | bad_pdf | bad_page`, `413 too_large`.
- `POST /import/background/{source_id}/page {"page": 2, "dpi": 150}` → same result for another PDF page;
  `GET /import/background/{source_id}/pages/{n}/thumb.png?size=240` → page-picker thumbnail.
- Project export/import bundles carry `file_id` and `source_id` blobs (ids remapped on import).

## 9. PrintOverrides / OriginSpec
```json
{"feed_rate": 1800, "jog_speed": 3000, "pen_down_z": 8.0, "pen_up_z": 0.0, "z_speed": 5000,
 "tool_on_delay": 0.0, "tool_off_delay": 0.0, "optimize": true, "near_dst": 0.3, "simplify": 0.0,
 "copies": 1, "copy_gap_mm": 10.0, "copy_mode": "repeat_same", "start_gcode": "", "end_gcode": "",
 "multi_page": "separate_jobs", "stop_on_error": true,
 "origin": {"corner": 0, "revxy": false, "x_rev": false, "y_rev": false, "offset_x_mm": 0.0,
            "offset_y_mm": 0.0, "rotation": 0, "set_zero_at_start": null}}
```
All fields optional (`null`/absent = inherit). Resolution: profile `print_defaults` < profile settings/grbl < `project.print` < job overrides.
`origin.corner`: 0 LeftUp, 1 RightUp, 2 LeftDown, 3 RightDown = which page corner the pen sits on at job start;
`offset_*_mm` = origin distance from that corner measured inward.
`origin.anchor`: `paper` (corner of the paper) or `content` (corner of the drawing's bbox), `null` = inherit. The studio's
draggable origin marker solves `offset_*_mm` so the marker point P becomes machine (0,0): corner 0 → `offset = P − anchor
corner` (other corners mirrored; negative = outside). It writes `page.origin` when the page has one, else `doc.print.origin`.
`placement` (dx/dy) moves the drawing instead and never changes where the pen is parked relative to a `content` anchor.

## 10. Profile doc (`GET /profiles/{id}`)
```json
{"id": "default", "name": "GRBL Z 笔", "is_active": true, "updated_at": 1761900000.0,
 "doc": {"type": "Grbl",
   "settings": {"dpi": 96, "feedRate": 1500, "jogSpeed": 2500, "toolOnDelay": 0.0, "toolOffDelay": 0.0, "nearDst": 0.3,
                "offsetX": 0.0, "offsetY": 0.0, "rotate": 0.0, "singleStep": false, "autoSetZero": true, "autoConnect": true,
                "autoSleep": false, "updateStatus": false, "maxImageSize": 4000, "sheetAutoAlignScale": 60, "alertFileComplete": true, "useSysDpi": true},
   "grbl": {"type": "Stepper", "penUpPos": 50, "penDownPos": 0, "ecoServo": false, "zOn": 8.0, "zOff": 0.0, "zSpeed": 5000, "laserS": 1000},
   "marlin": {…}, "ebb": {…}, "kat": {…},
   "advanced": {"startGcode": "", "endGcode": "", "macro1": "", "macro2": "", "macro3": "", "zJogStep": 1.0},
   "axes": {"revxy": false, "xAxeRev": false, "yAxeRev": false, "pos": 0},
   "connection": {"port": "/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0", "baud": 115200, "auto_connect": true, "reset_on_connect": false},
   "work_area": {"w_mm": 300.0, "h_mm": 300.0},
   "print_defaults": {"optimize": false}}}
```
`PATCH /profiles/{id}` `{"doc": {"grbl": {"zOn": 7.5}}}` deep-merges. Unknown keys are kept. Export = this `doc` (it is a valid
`configs/grbl-zpen.json` superset; import accepts both).

## 11. WebSocket `/api/v1/ws`
Connect with the session cookie (same origin). Scripts: `Sec-WebSocket-Protocol: penplot.v1, bearer.ppt_…`.
Close codes: `4401` unauthenticated, `4423` setup required, `1013` client too slow. Every server message has
`type`, `seq` (per connection), `ts`. Payload is under `data` except `hello`, `gap`, `ack`, `pong`.

Server → client:
```json
{"type": "hello", "seq": 1, "ts": 1761900000.1, "server_version": "0.3.0", "conn_id": "c7",
 "snapshot": {"machine": {MachineStatus}, "job": {Job} , "tasks": [{Task}], "batch": null}}
{"type": "status", "seq": 2, "ts": …, "data": {MachineStatus}}
{"type": "progress", "seq": 3, "ts": …, "data": {"job_id": "j7f3a2c1", "line_acked": 1200, "line_sent": 1214, "total": 5231,
   "percent": 22.9, "elapsed_s": 300.2, "eta_s": 960.5, "wpos": [80.1, -120.3, 8.0], "page": 0, "batch_seq": null}}
{"type": "job", "seq": 4, "ts": …, "data": {"job_id": "j7f3a2c1", "from": "running", "to": "paused", "reason": null, "job": {Job}}}
{"type": "job", "seq": 5, "ts": …, "data": {"job_id": "j7f3a2c1", "from": "done", "to": "deleted", "reason": null, "job": null}}
{"type": "alarm", "seq": 6, "ts": …, "data": {"code": 3, "text": "ALARM:3", "hint": "运动中复位…", "during_job_id": "j7f3a2c1"}}
{"type": "error", "seq": 7, "ts": …, "data": {"job_id": "j7f3a2c1", "line": 812, "cmd": "G5 X1", "reply": "error:20"}}
{"type": "log", "seq": 8, "ts": …, "data": {"lines": [{"t": 1761900000.2, "dir": ">", "text": "G1 X10.000Y-5.000F1500"},
   {"t": 1761900000.21, "dir": "<", "text": "ok"}], "dropped": 0}}
{"type": "task", "seq": 9, "ts": …, "data": {"task_id": "t5", "kind": "render_project", "state": "done", "progress": 1.0,
   "message": "", "result": {RenderResult}, "error": null}}
{"type": "system", "seq": 10, "ts": …, "data": {"cpu": 23.5, "temp_c": 51.2, "mem_avail": 1203450000, "mem_total": 2045000000, "wifi_dbm": -58}}
{"type": "notice", "seq": 11, "ts": …, "data": {"level": "warning", "code": "origin_invalid", "message": "机器已复位，请抬笔并重新设零"}}
{"type": "gap", "seq": 12, "ts": …, "dropped": 17}
{"type": "ack", "seq": 13, "ts": …, "id": "k1", "ok": true, "result": {…}, "error": null}
{"type": "pong", "seq": 14, "ts": …, "t": 1761900000.0}
```
`dir` in log: `>` sent, `<` received, `!` event/notice. Log lines only arrive after subscribing to `log`.
`notice.code`: `shutdown`, `restart`, `origin_invalid`, `port_busy`, `connected`, `disconnected`, `lease_taken`.

More server → client messages (always delivered unless noted):
```json
{"type": "attention", "data": {"code": "paper_change", "level": "warning", "sound": "paper",
  "message": "「贺卡 张三」写完了，换上下一张纸后继续（第 2 张）", "job_id": "j1", "batch_id": "b1", "next_job_id": "j2"}}
{"type": "presence", "data": {"online": [{"conn_id": "c3", "user": {"id": "u1", "username": "admin", "display_name": "管理员", "role": "admin"},
  "page": "/studio", "project_id": "p01", "element_id": null, "since": 1761900000.0, "client": "Mozilla/5.0 …"}]}}
{"type": "lease", "data": {"held": true, "holder": {"id": "u2", "username": "ann", "user": "ann", "display_name": "Ann", "role": "operator", "since": 1761900000.0},
  "since": 1761900000.0, "last_active": 1761900100.0, "online": true, "expires_at": null, "release_after_s": 60, "reason": "take"}}
{"type": "project", "data": {"project_id": "p01", "rev": 8, "kind": "element", "by": {"id": "u2", "username": "ann", "display_name": "Ann", "role": "operator"},
  "conn_id": "c7", "patch": {"page_id": "p1", "element_id": "e2", "element": {Element}}}}
{"type": "locks", "data": {"project_id": "p01", "locks": [{"element_id": "e2", "user": {"id": "u2", "username": "ann"}, "conn_id": "c7", "ts": 1761900000.0}]}}
{"type": "teletype", "data": {"kind": "chars", "session_id": "tt1a2b", "list": [[17, "H", 0, 4, "q"]]}}
{"type": "studio.patch", "data": {"project_id": "p01", "client": "B", "ops": […], "from": {"user": {UserRef}, "conn_id": "c7"}}}
```
`attention.code`: `job_done` (sound done), `paper_change` (between batch jobs, teletype page full; sound paper),
`job_failed`, `estop`, `alarm`, `gcode_error`, `serial_lost`, `client_loss_pause` (sound error), `lease_taken`,
`lease_released` (sound info). `project`, `locks` and `studio.*` go only to sockets whose presence names that project.
After `gap` (or a reconnect) refetch `GET /jobs/current` and `GET /machine/status`.

Client → server:
```json
{"type": "subscribe", "topics": ["status", "progress", "job", "alarm", "task", "system", "error", "log"]}
{"type": "cmd", "id": "k1", "op": "estop", "args": {}}
{"type": "cmd", "id": "k2", "op": "pause", "args": {"mode": "hold"}}
{"type": "cmd", "id": "k3", "op": "resume", "args": {}}
{"type": "cmd", "id": "k4", "op": "stop", "args": {}}
{"type": "cmd", "id": "k5", "op": "jog", "args": {"dx": 1.0, "dy": 0, "dz": 0, "feed": 1500, "seq": 17}}
{"type": "cmd", "id": "k6", "op": "jog_cancel", "args": {}}
{"type": "cmd", "id": "k7", "op": "pen", "args": {"state": "up"}}
{"type": "cmd", "id": "k8", "op": "realtime", "args": {"byte": "0x91"}}
{"type": "ping", "t": 1761900000.0}
```
```json
{"type": "presence", "page": "/studio", "project_id": "p01", "element_id": "e2"}
{"type": "lock", "id": "L1", "project_id": "p01", "element_id": "e2"}
{"type": "unlock", "project_id": "p01", "element_id": "e2"}
{"type": "tt_keys", "id": "k9", "data": "hello\n"}
{"type": "studio.presence", "data": {"project_id": "p01", "client": "A", "name": "Ann", "color": "#f60", "page": 0, "selection": ["e2"]}}
{"type": "studio.patch",    "data": {"project_id": "p01", "client": "A", "ops": [ … ]}}
{"type": "studio.saved",    "data": {"project_id": "p01", "client": "A", "rev": 9}}
{"type": "studio.bye",      "data": {"project_id": "p01", "client": "A"}}
```
`pause/resume/stop` act on the current job. Default subscription = everything except `log`.
Server sends WebSocket-level pings every 15 s. Messages are handled **in order per socket** (e-stop is never queued);
limits: 64 KB per message, ~20 messages/s (excess → `ack {ok:false, error.code:"rate_limited"}`), `presence` coalesced
to 1/s, `NaN`/`Infinity` rejected. `cmd` args are validated with the same models as REST (`JogRequest`, `PenRequest`,
`RealtimeRequest`, `JobPause`); WS jog steps are capped to ~300 ms of travel (hold-to-jog), and the server sends a jog
cancel when the jogging socket closes or stops sending steps for 1 s. The credential is re-checked on every
command: a disabled user / revoked session gets `ack {error.code:"unauthenticated"}` and the socket is closed (4401).
`studio.*` messages are relayed verbatim to the other viewers of `data.project_id` with an authoritative `data.from`;
viewers may send `studio.presence`/`studio.bye` only. `studio.presence` also sets the socket's presence project.

## 12. Other shapes (short)
- Task: `{"id":"t5","kind":"render_project","state":"running","progress":0.4,"message":"","result":null,"error":null,"created_at":…,"started_at":…,"finished_at":null,"slot":"c1/p1"}`
- FileInfo: `{"id":"f12","kind":"gcode","name":"heart.gcode","sha256":"…","size":20480,"mime":"text/plain","meta":{"lines":812,"bbox":[0,-50,40,0],"est_s":95.2},"tags":["demo"],"created_at":…}`
- FontSummary: `{"id":"open-wenkai-stroke","display_name":"文楷单线 WenKai Stroke","filename":"open-wenkai-stroke.psf","format":"psf","glyph_count":7122,"size_bytes":5931572,"source":"bundled","hidden":false,"missing":null}`
  (`GET /fonts?covers=你好龘` fills `missing` per font).
- GlyphPage: `{"font_id":"…","ref_size":95,"total":6902,"next_from":200,"glyphs":[{"cp":20320,"char":"你","w":88.0,"path_d":"M12 -60L40 -2…"}]}`
- Upload `POST /fonts` (multipart `file`): `.gfont/.psf` → `201 FontSummary`; `.ttf/.otf/.ttc` → `202 TaskRef` (`ttf_convert`).
- Imports (multipart field `file`): `/import/gcode` → `{"file":FileInfo,"analysis":{"lines":812,"motion_lines":790,"bbox":[…],"draw_mm":…,"travel_mm":…,"pen_lifts":40,"est_s":95.2,"warnings":[]}}`;
  `/import/svg|dxf` → `{"file":…,"bbox_mm":[…],"width_mm":40,"height_mm":30,"paths":12,"layers":["0"],
  "text_runs":[{"text_index":0,"content":"你好","font_family":"'Microsoft YaHei', sans-serif","families":["Microsoft YaHei","sans-serif"],"font_size":8,"size_mm":8,"chars":2}],"text_families":["…"]}`
  (SVG only; also stored in `file.meta.text_runs/text_families`; `paths` counts drawn shapes only, `bbox_mm` adds a
  font-independent estimate of the text: ideographs 1 em, others 0.55 em);
  `/import/image` → `{"file":…,"px_w":1200,"px_h":800}`; `/import/table` → `{"file":…,"sheets":[{"name":"Sheet1","columns":["name","addr"],"row_count":40,"sample_rows":[["张三","北京"]]}]}`;
  `/import/text` → `{"text":"…","encoding":"gb18030","chars":1200}`.


## 13. Users and roles
`GET /auth/me` → `{"id":"u2","username":"ann","display_name":"Ann","role":"operator","disabled":false,"created_at":…,"last_login":…}`.
Admin: `GET/POST /users` (`{"username","password","role","display_name"}`), `PATCH /users/{id}` (`{role?,disabled?,display_name?}`;
the last admin cannot be demoted/disabled → `409 last_admin`), `POST /users/{id}/password {"new"}` (revokes their
sessions), `DELETE /users/{id}`. Sessions and API tokens belong to a user (`?all=1` for admins); a token's scopes
are capped by its user's role. Audit `actor` = `user:<username>` (`… (token <id>)` for tokens).

## 14. Machine control lease
`GET /machine/lease` → LeaseInfo (`mine` = the caller holds it). `POST /machine/lease {"force":false}` takes it
(`409 lease_held` with `detail.holder`; `force:true` = admin only). `DELETE /machine/lease` releases (holder/admin).
Every motion/job-control call (jog, pen, zero, frame, connect, job start/pause/resume/stop/frame, teletype…) passes
the lease gate: a free lease is auto-taken by the first operator who acts; admins may act regardless. The lease is
released automatically after `settings.lease_release_s` (60 s) with the holder having no WebSocket open and no API
activity; releasing/forcing cancels any jog in progress.

## 15. Collaboration
`GET /presence` → PresenceEntry[]; `GET /projects/{id}/collab` → `{"project_id","viewers":[…],"locks":[…]}`.
`PUT /projects/{id}` and `PATCH …/elements/{eid}` broadcast WS `project` to the project's other viewers; send header
`X-Conn-Id: <hello.conn_id>` to recognise your own echo. Soft locks: WS `lock`/`unlock` (expire after 120 s; send
again to refresh; released on disconnect). `PATCH …/elements/{eid}` on an element locked by another user →
`409 element_locked` (add `?force=1` to override).

## 16. Teletype (paper terminal)
`POST /teletype/session` `{"char_h":3,"feed":4000,"z_up":null,"z_down":null,"paper":{"paper_id":"a4-normal"},"margin":8,
"max_backlog":1500,"mode":"type","set_zero":true}` → TeletypeState (holds the machine like a job; jobs get
`409 teletype_active`). `POST /teletype/type {"text"}` (typing: `\n` newline, `\b` back one cell → overstrike, `\t`;
full-width punctuation → ASCII) → `{"ok":true,"echo":"…"}`; page full → `409 need_paper`, then `POST /teletype/newpage`.
`POST /teletype/action {"action":"pause|resume|stop|change_paper|set_origin|home|pen_up|mode|interrupt|settings","args":{}}`.
`GET /teletype/state`, `GET /teletype/font`, `DELETE /teletype/session`. WS topic `teletype` events (see TeletypeEvent);
WS input `tt_keys`. Terminal mode (`mode:"term"`): admin only and `settings.teletype.terminal_enabled=true`
(default false; audited); PTY at `WS /api/v1/teletype/pty`: server sends binary frames (output, first = replay),
client sends binary/text keystrokes and `{"type":"resize","rows":30}` (columns = paper columns).
State example: `{"active":true,"session_id":"tt1a2b","mode":"type","cols":80,"rows":58,"pending":12,"paused":false,
"need_paper":false,"origin_ok":true,"page":1,"paper":{"geo":{"h":3,"cw":2.4,"lh":4.8,"cols":80,"rows":58,…},"row":0,"col":5,
"chars":[[1,"H",0,0,"ok"]]}}`.

## 17. Diagnostics and recovery
`POST /system/diagnostics {"pen_test":false,"confirm":false}` (control; pen test also needs the lease) →
`{"status":"ok|warn|fail","checks":[{"id":"grbl_22","name":"$22 回零","status":"warn","detail":"$22=1","message":"$22=1",
"hint":"本机没有限位开关…"}],"counts":{…}}`; `GET /system/diagnostics` → last report or 204.
Check ids: serial_present, serial_open, banner, status_latency, grbl_13/20/21/22, travel, feed, zspeed, laser, dir, pen,
wifi, disk, memory, temp, fonts, clock, data_dir. Status values are `ok|warn|fail|skip`.
`GET /machine/recovery` → `{"ok":false,"situation":"origin_invalid","reasons":["alarm","origin_invalid","job_failed"],
"machine":{MachineStatus},"last_job":{Job},"steps":[{"id":"unlock","title":"解锁","detail":"…","action":{"method":"POST","path":"/api/v1/machine/unlock","body":{}}}]}`.
Dev/test: `POST /machine/fake/fault {"kind":"unplug|alarm|reset|reset_in_motion|garbage|slow_acks|error_every|error_next|clear","value":…}`
(admin, simulator only); env `PENPLOT_FAKE_FAULTS="slow_acks=0.05,garbage=0.02,alarm_after=30"`.

## 18. Placement preview
`GET /render/{rid}/pages/{i}/placement?dx_mm=&dy_mm=` → `{"space":"machine","origin":[0,0],"work_area":[0,-300,300,0],
"paper":[[0,0],[209,0],[209,-296],[0,-296],[0,0]],"bbox":[10,-30,30,-10],"frame":[[10,-30],…],"offset_mm":[0,0],
"out_of_work_area":false,"violations":[],"fits_paper":true,"est_s":12.3,"apply_hint":{"overrides":{"placement":{…}}}}`;
`…/placement.svg` draws work area, paper, drawing, frame and origin (machine coords, y up).

## 19. Seed content, templates, compatibility
Built-in papers come from `page_presets()` and `seed/papers.json` (read-only). Built-in templates `tpl-<id>` from
`seed/templates` are read-only (`409 builtin` on PUT/PATCH/DELETE; duplicate to edit) and carry `builtin`, `category`,
`description`, `tags`, `variables_hint`, `sample_data`, `thumb_url` (`GET /projects/{id}/thumb.png`) in Project and
ProjectSummary. Seed sample CSVs are imported once into the library with tag `示例`. Fonts a template names but the
device lacks fall back to the default font (page `warnings.messages`). Batch results include
`missing_glyphs {"7":["龘"]}` per data row (1-based).
`POST /profiles/import` takes multipart `files` (one or more): a penplot export/MachineConfig json, or the original
software's `settings.json`, `Grbl.json`/`Marlin.json`/`EBB.json`/`KAT.json`, `AdvancedViewData.json`, `AxesData.json`
(or a zip of them); form `name`, `type`. Units: G-code `G20` is converted to mm in analysis/import; vector element
`props.units`: `auto` (SVG width/height+viewBox, unit-less = 96 dpi px; DXF `$INSUNITS`, unitless = mm) or a forced
`mm|cm|m|in|ft|pt|px` size of one drawing unit.

## 20. Settings additions
`pause_on_client_loss_s` (default **120**: soft-pause a running job when every web client that watched it is gone this
long; armed only after a client was seen, so script jobs are not paused), `lease_release_s` (60),
`teletype {terminal_enabled:false, terminal_user:null, terminal_shell:null}`.
