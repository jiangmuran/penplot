# seed/ — ready-to-use content

| Path | What |
|---|---|
| `templates/index.json` | manifest: `{version:1, templates:[{id, file, name, category, description, tags, sample_data, preview, preview_svg, variables, fonts, paper_id}]}` |
| `templates/<id>.json` | one **Project.doc** each (04-contract-notes §8), validated against `penplot.web.schemas.projects.ProjectDoc` |
| `templates/previews/<id>.png/.svg` | first-page preview (page space, 4 px/mm PNG) |
| `papers.json` | `{version:1, papers:[{id, name, category, note?, width_mm, height_mm, margins, orientation, rotation, ruling}]}` (PaperBase + `id`/`category`/`note`) |
| `samples/*.csv` | UTF-8 CSV for batch: `addresses.csv` (name,address,postcode,sender_address,sender_postcode,from,date,message), `guests.csv` (name,table) |
| `make_templates.py` | generator for the template JSON (edit layouts here) |
| `validate.py` | schema + render check of every template through `penplot.compose`, writes previews; exit 1 on errors, missing glyphs, overflow, clipping |

```
.venv/bin/python seed/make_templates.py && .venv/bin/python seed/validate.py
```

## Backend loading contract

1. **Papers**: on startup (idempotent, `INSERT OR IGNORE`), add each `papers.json` entry as a *builtin* paper
   (`builtin=1`, read-only) with id = `id`, name = `name`, doc = the PaperBase fields. Ignore `category`/`note`
   or keep them in the doc (extra keys).
2. **Templates**: for each `index.json` entry create (or update when the stored copy is unchanged by the user) a
   project with `is_template=1`, stable id `tpl-<id>`, `name`, `doc` = contents of `file`. Expose `category`,
   `description`, `tags`, `sample_data` in the project summary (e.g. `meta`) so 项目与模板 can filter by category;
   thumbnails: serve `previews/<id>.png` as `thumb_url`.
3. **Samples**: optionally import `samples/*.csv` into the file library (kind `table`, tag `示例`).
4. Templates embed their paper inline (`paper: {paper_id, spec}`), so they render even if step 1 is skipped;
   `a4-normal` templates use the builtin. Fonts referenced: see `index.json` `fonts` (all in `fonts/`). If a font is
   missing on a device, fall back to the default font.
