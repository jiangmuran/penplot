# Contributing to penplot / 参与贡献

Thanks for helping! Issues and pull requests are welcome in Chinese or English.
欢迎用中文或英文提 issue 和 PR。

## Before you start

- For anything larger than a small fix, open an issue first so we can agree on the approach.
- **Safety first**: penplot moves real machines. Changes to `penplot/machine/`, the job streamer or
  E-stop paths need tests with `FakeGrbl` and a note on how you verified them (simulator / real
  machine, controller and firmware version).
- **No non-redistributable material**: never commit vendor `.gfont` fonts, fonts converted from
  proprietary TTFs (SimSun, Microsoft YaHei, …), screenshots showing them, or code taken from other
  writing-machine software. New fonts must carry an open licence (e.g. SIL OFL) and be added to the
  allowlist in `.gitignore`, `fonts/README.md` and `fonts/LICENSES/`.
- **No personal data**: no real IP addresses, hostnames, tunnel IDs, tokens, setup codes, usernames
  or home paths in code, docs, tests or screenshots. Use `192.168.1.50`, `plotter.local`,
  `plotter.example.com`, `<TUNNEL_ID>`.

## Development setup

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -e '.[all,dev]'
OPENBLAS_NUM_THREADS=1 python -m pytest -q

# web workbench with the simulated plotter
PENPLOT_DEV=1 PENPLOT_SERIAL_PORT=fake PENPLOT_DATA_DIR=~/.penplot-dev penplot-web serve
cd webui && npm ci && npm run dev
```

## Checks a PR must pass (same as CI)

```bash
OPENBLAS_NUM_THREADS=1 python -m pytest -q        # Python 3.12
ruff check penplot tests                          # if you touched Python
cd webui && npm run lint && npm run build         # Node 22
cd e2e && npx playwright test                     # for UI / API behaviour changes
```

Tests must pass **without** private fonts: the repository only has the fonts in `fonts/`. A test that
genuinely needs other fonts must skip with a clear reason when they are missing (see
`tests/scripts/_paths.py` for the `PENPLOT_TTF_DIR` pattern).

## Conventions

- **API changes**: update the Pydantic schemas, then
  `penplot-web dump-openapi > docs/design/openapi.json` and `cd webui && npm run gen:api`;
  document user-visible changes in `docs/api.md`.
- **Help / manual**: edit `webui/src/features/help/articles/*.md`, then copy them to `docs/manual/`.
- **UI text** is Simplified Chinese; keep terms consistent with the glossary
  (`docs/manual/02-glossary.md`: 原点、走边框、抬笔/落笔、控制权…).
- **Core library** (`penplot/` outside `web/`) stays importable with the standard library only;
  optional dependencies are imported lazily.
- Keep commits focused; describe *why* in the message. Add an entry under "Unreleased" in
  `docs/CHANGELOG.md` for user-visible changes.

## Licence

penplot is licensed under `AGPL-3.0-or-later`. By submitting a contribution you agree that it is
licensed under the same terms (fonts: SIL OFL 1.1 where applicable), and you confirm you have the
right to submit it.
