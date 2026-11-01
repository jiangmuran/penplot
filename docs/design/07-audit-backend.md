# 07 — Backend (Python) audit before open-sourcing

Scope: `penplot/**` (minus `penplot/web/teletype/**`, `routers/teletype.py`), `tests/**`, `scripts/**`,
`pyproject.toml`. Tools: `ruff` (F + B subset), `vulture --min-confidence 60`, grep. Date 2026-11-01.

Legend: **[fixed]** = changed in this pass (behaviour-preserving unless stated, tests green);
**[owner]** = needs a decision or lives outside the backend paths.

## P0 — must fix before the repo goes public

1. **Personal / site data outside the Python package** [owner]
   - `deploy/deploy.sh:3,6` default `HOST="root@<board-ip>"`; `deploy/bootstrap.sh:33-35` copies from
     `<repo-on-board>/fonts`. Make `HOST` a required arg/env (`PENPLOT_DEPLOY_HOST`) and the font source a parameter.
   - `docs/design/00-plan.md` (board IP, `ssh root`, `<other-project>`), `docs/api.md`, `docs/manual/09,11`,
     `webui/src/features/help/articles/{09-troubleshooting,11-api}.md` use `http://<board-ip>:8080`.
     The built bundle `penplot/web/static/assets/help-*.js` ships that string in the wheel.
     Replace with `http://<设备地址>:8080` or `penplot.local`, then rebuild the frontend.
   - `demos/teletype/teletype.py:1189` hard-codes `192.168.0.1` (route probe; harmless, but could be `8.8.8.8`/`10.255.255.255`).
   - Repo root holds **8 core dumps** (`core.36537xx`, ~700 KB each; may contain memory and secrets),
     `penplot.egg-info/`, `out/`, `download/penplot.zip`. Delete them and add them to `.gitignore`.
   - The Python package itself is clean: no IPs, domains, e-mails, user names or `/home`/`/root` paths in
     `penplot/**`, `scripts/**`, `pyproject.toml`. `tests/web/test_tunnel.py` uses `192.168.1.77` only as a
     generic LAN address in test data (fine).
2. **Third-party / vendor material** [owner]
   - `penplot/tea.py` + `GFONT_KEY` (`tea.py:186`) and `gfont.py` read and write the original vendor's
     encrypted `.gfont` format, ported from the vendor app (`machine.h`, `marlin.b.b`, `kat/a.b()` ... in docstrings).
     Interoperability reimplementation is usually fine, but confirm before publishing. Also check that **no vendor
     `.gfont` fonts in `fonts/`** are redistributed without a license.
   - `penplot/mmah.py` output derives from Arphic PL fonts (notice in the docstring). Ship the Arphic license
     text with any converted `.psf` in `fonts/`.
3. **Wheel lacked seed data** [fixed] — `Config.from_env` looked only at `<repo>/configs/grbl-zpen.json` and
   `<repo>/seed`, so `pip install .` gave a server with no built-in papers or templates and **origin anchor
   'paper'** (the manual documents 'content'). Now `pyproject` `data-files` installs both under
   `<prefix>/share/penplot/`, and `config._bundled()` falls back to that location. Verified in a fresh venv.

## P1 — correctness / safety

4. **Old origin model still the code default** [owner]
   - `layout.OriginSpec(anchor='paper')`, `printcfg.effective()` fallback `'anchor': 'paper'`, and
     `schemas/common.py:91` ("else 'paper'"). Only the seed profile (`configs/grbl-zpen.json`
     `print_defaults.origin.anchor = content`) gives the documented default. Profiles created through
     `POST /profiles` without `print_defaults`, or imported with `import_original`, silently use the paper corner.
     Suggest: make 'content' the fallback in `printcfg.effective` (one line plus tests) once the UI agrees.
   - CLI `penplot write/img` (`cli.py:252-273`) still uses `export_transform` (paper corner, `origin=(0,0)`)
     and ignores `print_defaults.origin` from `--config`. The same text lands in a different place from the CLI
     and from the web.
   - `layout.check_bounds` / `work_area_rect` assume the origin sits at a machine travel corner. With the content
     anchor, the origin is wherever the pen was parked, so the `out_of_work_area` gate only checks the job's
     extent, not its absolute position. Document this or drop the work-area check when `anchor='content'`.
   - `scripts/draw_console.py` docstring and defaults (`--x0 30 --y0 -58`) assume "origin = paper corner".
   - `GcodeBuilder.finish()` always emits `G90G0 X0Y0` (travel back to the origin) after the job. Under the
     content model that is the top-left of the writing, which is fine, but it is a pen-up rapid across the
     paper. Keep it, or make "park" configurable.
5. **Unbounded list limits** [fixed] — `limit`/`n` query params on `/jobs`, `/jobs/{id}/log`, `/files`,
   `/projects`, `/system/audit`, `/system/logs` were plain `int`. A negative value makes SQLite `LIMIT -1` return
   every row. They are now `Query(ge=1, le=5000)` (audit `le=2000`); test `test_list_limits_are_bounded`.
6. **`Path.arc_to_beziers` divided by zero** [fixed] when start == end (SVG says to drop the arc). Test
   `test_arc_with_identical_endpoints_is_omitted`. The dead `c = den` / duplicate `den` computation is removed.
7. **`PATCH /settings` takes `body: dict`** (`routers/system.py:97`) [owner]. It is validated after the merge
   against `AppSettings`, but that is an `OpenModel`, so any extra key is persisted. `teletype.terminal_user` and
   `terminal_shell` are `dict[str, Any]`: an admin can pick any binary as the PTY shell (root service).
   Use a typed `AppSettingsPatch` (all-optional) and a strict `TeletypeSettings` model, and allow-list shells
   from `/etc/shells`.
8. **`parse_gcode` ignores motion modes** (`gcode.py`) — G2/G3 arcs come out as chords to the end point, and
   G0 vs G1 is not distinguished (pen state comes from Z/M words only). The unused `motion` tracker is
   removed [fixed]. Document it in the import UI, or interpolate arcs.
9. **Silent listener failures** — `machine/base.py:_emit` swallows every listener exception (`except Exception:
   pass`). A bug in a WS/status listener vanishes without a trace. Add `log.exception` (no serial data is
   logged). Other broad excepts (≈25) are teardown/best-effort (`close()`, `feed_hold`, `soft_reset`, PIL
   `draft`, svgelements/ezdxf per-element) and are acceptable; `_track_pen`'s `except Exception: pass` around
   `self._pen()` should be narrowed to `(AttributeError, TypeError)`.
10. **Risky defaults** (documented, not changed)
    - `PENPLOT_HOST=0.0.0.0`, plain HTTP unless `PENPLOT_TLS_*` is set. Fine on a home LAN; the README should say so.
    - `session_ttl_h = 720` (30 days).
    - The first-run setup code is logged at WARNING (`auth.py:164`), so anyone who can read the journal can claim
      the device before the owner. Acceptable for an appliance; document it.
    - `DEFAULT_CONNECTION.auto_connect=True` with the CH340 by-id path: on a different board it just fails
      quietly, which is OK. The path was duplicated in `machine/service.py` [fixed → uses
      `profiles.DEFAULT_CONNECTION`] and is still duplicated in `schemas/system.py:12` (owned by the schema agent).
    - Swagger UI (`app.py:72`) loads JS from the jsDelivr CDN into the app origin (06 review). Self-host it or
      disable it outside dev.
11. **`MachineService.connect(auto=False)`**: the `auto` parameter is unused (vulture 100%). Either use it
    (no error toast on auto-connect) or drop it.

## P2 — dead code, duplication, naming

12. **Removed dead code** [fixed] (no references in penplot/tests/scripts/seed/e2e/deploy/webui):
    - `web/tasks/kinds.py: child_main` (superseded by the long-lived `tasks/worker.py`; duplicate sandbox code)
    - `image.py: _resize_nn, _cut_corners`; `strokes.py: _nbrs_factory`; `tea.py: _i32`
    - `web/library.py: _gcode_preview, Files.update_meta`; `web/errors.py: unavailable_feature`
    - `machine/base.py: Controller._wait_ok`
    - `geometry.Affine2D.translate`: removed the `Affine2D._mul(...) if False else ...` dead branch
    - `gcode.py`: unused locals (`s = self.m.settings` ×2, `motion`); `ttffont.py`: bare attribute access made explicit
    - 17 unused imports in core and web modules and tests (`compose`, `gcode`, `layout`, `mmah`, `preview`, `psf`,
      `web/library`, `web/render`, `web/machine/jobs`, `web/routers/machine`, 4 test files)
    - `builtin_font.load_builtin` annotation referenced the undefined name `penplot` (F821)
13. **Unused public API, kept on purpose (library surface; decide before 1.0)** — vulture flags these with no
    in-repo callers: `geometry.Affine2D.{pre_translate,pre_rotate_deg,shear_deg,get_matrix}`,
    `Path.{set_closed_polygon,quad_bezier,snap_to_int}`, `machine.kat.KatBatchQueue` (+`feed_out_paper`,
    `park_pen`), `marlin.sd_*`, `ebb.{cmd_time_ms,reset_board}`, `grbl.read_params`,
    `base.{reset_zero_tracking,Sender.line_of_pending_head}`, `settings.px2mm`, `psf.to_gfont_bytes`,
    `builtin_font.export_builtin`, `preview.paths_to_png`, `image.edges_to_paths`. They are ports of the
    original app. Either cover them with a test or delete them; untested hardware paths (K_AT, EBB, Marlin SD)
    should at least be marked "untested" in the README.
14. **Duplicated helpers**
    - Java-style number formatting is implemented 5 times: `gcode.fmt3/_fstr`, `marlin.fmt3/jnum`,
      `grbl.jnum/jfloat`, `kat._jnum`, `base._num`. Note that `gcode.fmt3` keeps `-0.000` while `marlin.fmt3`
      maps it to `0.000`; G-code output differs by firmware. Consolidate into one `penplot/fmt.py`
      (byte-identical golden tests exist in `tests/scripts`).
    - `psf.load_dir` vs `gfont.load_dir` (same loop, both `print('skip ...')` to stdout).
    - `_rdp` in `ttffont.py` and `web/teletype/glyphs.py`; `_components` in `image.py` and `ttffont.py`.
    - Seed/repo asset lookup (`config._repo_fonts`, `config._bundled`). Fine for now.
15. **Naming** — mixed Java-port camelCase (`feedRate`, `autoSetZero`, `zOn`, `penDownMM`) in `settings.py` /
    profile JSON next to snake_case web fields (`pen_down_z`, `set_zero_at_start`). That is a persisted format,
    so do not rename it; `printcfg.effective` is the single mapping point, so keep it that way.
16. **Leftover debug output** — `strokes.skeleton_strokes(debug=True)` prints `[dbg]` lines (opt-in, OK);
    library functions `psf.load_dir`, `gfont.load_dir`, `ttffont` (`warning: ...`) `print` to stdout/stderr
    instead of `logging`. Not hit by the web server (CLI only), but switch them to `logging` / `warnings`.
    No `breakpoint()`/`pdb`/stray `print` in the web package (`__main__.py` prints are CLI output).
17. **TODO/FIXME** — none in the audited paths.
18. **Docstrings** — `tasks/worker.py` and `runner.py` match the code. `kinds.py` header ("run in a child
    process") is still true via the worker. `scripts/draw_console.py` describes the old origin (see 4).

## Packaging (checked)

19. `pip install <wheel>[web]` in a fresh Python 3.14 venv works; `penplot --version` → `penplot 0.3.0`;
    `penplot-web --help` and `python -m penplot.web check` run (imports ok, static ok). In a smoke test,
    `serve` with `PENPLOT_SERIAL_PORT=fake` answered `/system/health` and seeded 23 papers and 14 templates
    from `<venv>/share/penplot/seed`, with the profile anchor set to `content`.
    The wheel holds only `penplot/**` (no tests, no `tests/scripts`, no dev files) plus `share/penplot/{configs,seed}`.
    It is ~4 MB, mostly `penplot/web/static` with `.br` + `.gz` copies of every asset.
20. [fixed] `version` is now dynamic from `penplot.__version__` (it was duplicated in pyproject).
21. [fixed] Extras:
    - `all` listed only six packages (no web/vector/office/pdf). It is now `penplot[machine,image,ttf,preview,web,vector,office,pdf]`.
    - `web` pins `uvicorn>=0.35`, because `serve` uses `ws='websockets-sansio'`, which needs ≥0.35.
    - `web` declares `pydantic>=2`, which is imported directly.
    - `dev` adds `ruff`.
    - `requirements-web.lock` was compiled with `--extra pdf`; `pdf` is now declared (backgrounds agent).
22. [owner] Add `license = "AGPL-3.0-or-later"` (or `-only`; owner's choice) and `license-files` /
    classifiers to `[project]` once `LICENSE` exists. Add `[project.urls]`. `requires-python>=3.10`
    is honest (match statements are absent; the code is 3.10-compatible).
23. [owner] The web server without `[image]` reports every feature as unavailable. `python -m penplot.web check`
    prints that, but the README should recommend `pip install 'penplot[web,image,vector,office,pdf]'`
    (≈ the lock file) for the appliance.
24. `seed/make_templates.py` and `seed/validate.py` are dev tools and are **not** installed (only the
    data files are).

## Lint

- `pyproject.toml` `[tool.ruff]`: `select = F, B, E9`. Ignored: B007, B008 (FastAPI `File()` idiom), B023 (all
  loop closures are called synchronously inside the loop; checked `kat.py`, `kinds.py`, `worker.py`,
  `routers/ws.py`), B904, B905. Excluded: `tests/scripts` (legacy subprocess scripts), static/webui/e2e/seed.
- `ruff check penplot tests` is clean except `tests/web/test_teletype.py` (3 unused imports). That file is the
  teletype agent's; run `ruff check --fix tests/web/test_teletype.py` when it settles.
- No style rules (E/W/I) on purpose: the code uses dense one-liners and `%` formatting, and a reformat would
  conflict with parallel work.
