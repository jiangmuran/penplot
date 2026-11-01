# Third-party notices

penplot itself is licensed under the GNU Affero General Public License v3.0 or later
(`AGPL-3.0-or-later`, see [LICENSE](LICENSE)). This file lists third-party material that is
**included in this repository or in builds made from it**, and the main dependencies that are
installed separately.

## 1. Bundled in the repository

### xterm.js 6.0.0 — MIT

`demos/teletype/static/xterm.js`, `demos/teletype/static/xterm.css` (unmodified release build).
The full licence text is in [`demos/teletype/static/xterm.LICENSE`](demos/teletype/static/xterm.LICENSE).

```
Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)
```

### Fonts — SIL Open Font License 1.1

The single-line fonts in `fonts/` are Modified Versions of OFL fonts (centre-line extraction and
subsetting by penplot's own converter). They remain under the OFL 1.1, do not use the Reserved Font
Names of their sources, and are documented in [`fonts/README.md`](fonts/README.md).

| File | Derived from | Copyright | Licence text |
|---|---|---|---|
| `fonts/open-wenkai-stroke.psf` | LXGW WenKai v1.530 | © 2021-2026 LXGW, with Reserved Font Names '霞鹜', '霞鶩', '落霞孤鹜', '落霞孤鶩' and 'LXGW'; © 2020 The Klee Project Authors | [`fonts/LICENSES/OFL-LXGW-WenKai.txt`](fonts/LICENSES/OFL-LXGW-WenKai.txt) |
| `fonts/open-hei-stroke.psf` | Noto Sans CJK SC 2.004 | © 2014-2021 Adobe. Noto is a trademark of Google Inc. | [`fonts/LICENSES/OFL-Noto-CJK.txt`](fonts/LICENSES/OFL-Noto-CJK.txt) |
| `fonts/open-caveat-stroke.psf` | Caveat | © 2014 The Caveat Project Authors | [`fonts/LICENSES/OFL-Caveat.txt`](fonts/LICENSES/OFL-Caveat.txt) |

`fonts/penplot-sans.psf` (and its source in `penplot/builtin_font.py`) and
`demos/teletype/font.py` are original works of the penplot authors and are covered by the project
licence.

## 2. Included in the web UI build (`webui/` → `penplot/web/static/`)

The production bundle contains code from these npm packages (runtime `dependencies` of
`webui/package.json`; versions as locked in `webui/package-lock.json`):

| Package | Licence |
|---|---|
| react, react-dom | MIT |
| react-router-dom | MIT |
| @tanstack/react-query | MIT |
| zustand | MIT |
| @radix-ui/react-* (alert-dialog, context-menu, dialog, dropdown-menu, label, popover, scroll-area, select, separator, slider, slot, switch, tabs, toast, toggle-group, tooltip) | MIT |
| @xterm/xterm, @xterm/addon-fit | MIT |
| clsx, tailwind-merge | MIT |
| class-variance-authority | Apache-2.0 |
| lucide-react | ISC |

Their transitive dependencies are MIT, ISC, BSD or Apache-2.0 licensed. Build-only tools (Vite,
Tailwind CSS, TypeScript, oxlint, Playwright, `@vitejs/plugin-react`) are not shipped in the bundle.
To regenerate a complete list: `cd webui && npx license-checker --production --summary`.

The interactive API docs page (`/api/v1/docs`) loads Swagger UI (Apache-2.0) from a CDN at run time;
it is not bundled.

## 3. Python dependencies (installed separately, not bundled)

The core library needs only the Python standard library. Optional extras from `pyproject.toml`:

| Package | Extra | Licence |
|---|---|---|
| pyserial | machine, web | BSD-3-Clause |
| numpy | image, ttf | BSD-3-Clause |
| Pillow | image, ttf | MIT-CMU (HPND) |
| fontTools | ttf | MIT |
| scikit-image | ttf | BSD-3-Clause |
| matplotlib | preview | Matplotlib licence (PSF-based) |
| FastAPI | web | MIT |
| uvicorn | web | BSD-3-Clause |
| websockets | web | BSD-3-Clause |
| python-multipart | web | Apache-2.0 |
| svgelements | vector | MIT |
| ezdxf | vector | MIT |
| openpyxl | office | MIT |
| pypdfium2 (PDFium) | pdf | Apache-2.0 / BSD-3-Clause |
| pydantic | web | MIT |
| pytest, httpx, ruff | dev | MIT, BSD-3-Clause, MIT |

`requirements-web.lock` pins the exact versions (with hashes) used by `deploy/deploy.sh`.

## 4. Data you supply yourself

- **makemeahanzi** (`penplot font mmah`): stroke-order data from
  <https://github.com/skishore/makemeahanzi>, derived from Arphic PL fonts. Not included; if you
  redistribute a font converted from it, keep the Arphic Public License and its notices.
- **`.gfont` fonts** from other plotter software and fonts converted from proprietary TTFs
  (SimSun, Microsoft YaHei, …) are not part of this project and must not be committed
  (see `.gitignore` and `fonts/README.md`).

## 5. Interoperability

penplot can read and write the `.gfont` single-line font format and produce G-code compatible with
existing writing-machine software. These formats are documented in
[`docs/ANALYSIS.md`](docs/ANALYSIS.md) for interoperability only; penplot contains no code or
fonts from that software. Product names mentioned in the documentation belong to their owners.
