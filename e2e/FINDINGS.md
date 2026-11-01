# E2E findings
Open bugs have a `knownBug('F<n>')` test describing correct behaviour (expected-fail); when fixed it reports "expected to fail, but passed" → remove the marker, move the entry to Fixed. Repro backend: `cd e2e && node scripts/serve.mjs` (http://127.0.0.1:8093, FakeGrbl).

## Open
### F4 — Jogs from reloaded page / 2nd client silently dropped · high · backend (machine/service.py jog)
Global `_jog_seq`; clients restart seq at 1 → ack ok, no motion. Repro: /machine X+1 → reload → X+1 does nothing. Fix: dedupe per connection or random seq base. Test: machine.spec.ts › jog dedupe (other tests use `jogSeqShim`).

### F7 — /help nests a second <main> · low · pages:help
Test: navigation.spec.ts › one main landmark (annotated).

## Fixed during session (tests now strict)
- F1 — pre-compressed .br/.gz JS contained `__VITE_PRELOAD__` (compressed before placeholders were replaced) · critical · shell (vite.config.ts: now compresses in writeBundle from disk).
- F6 — CSP blocked the inline no-flash theme script; theme/accent lost on reload · medium · shell (external public/theme-init.js).
- F5 — E-stop got aria-hidden while a dialog was open · medium · shell (app/estop.tsx).
- F8 — console rejected `$J=` jogs with a misleading message · low · backend (check_raw_line).
- F2 — /system crashed: backend PresenceEntry.user object vs UI string (`[...name]`) · high · pages:system⇄backend.
- F3 — UI locked out its own user after first manual action (lease `mine` via conn_id, absent in backend LeaseInfo) · critical · shell⇄backend.

## Notes
- No fault hook: PENPLOT_FAKE_FAULTS doesn't exist; FakeGrbl unplug()/fail_lines unreachable → unplug test is fixme. Suggest dev-only `/dev/fake/{unplug,alarm,fail_line}`.
- ETA under FakeGrbl reflects real speed (expected).
- Mini-player textContent includes an inline <style> @keyframes.
