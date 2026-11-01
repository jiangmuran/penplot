# Security policy

penplot drives a physical machine and is usually reachable by everyone on a home or office LAN, so
we treat security bugs seriously.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's
**"Report a vulnerability"** button (Security → Advisories) on this repository to send a private
report. Include:

- affected version / commit and how it is deployed (LAN, TLS, Cloudflare Tunnel, …),
- steps to reproduce or a proof of concept,
- impact (e.g. unauthenticated machine control, privilege escalation between roles, file read/write,
  shell access through the teletype terminal, denial of service of the job streamer).

We aim to acknowledge reports within 7 days and to publish a fix and advisory once a patched release
is available. Credit is given unless you prefer otherwise.

Supported versions: the latest release on `main`.

## Threat model in short

- The default deployment is **plain HTTP on a trusted LAN**. Anyone who can sniff the LAN can see
  passwords and cookies; enable TLS (`PENPLOT_TLS_CERT` / `PENPLOT_TLS_KEY`) or a tunnel when that
  matters.
- First run is protected by an 8-digit **setup code** written to `<data dir>/setup-code` (mode 0600,
  deleted after setup). Until an admin exists every API except state/setup/health returns `423`.
- Roles: admin / operator / viewer; API tokens carry scopes (`read`, `control`, `admin`). Unsafe
  cookie-authenticated requests need `X-Penplot: 1` and a matching `Origin` (CSRF protection);
  cookies are `HttpOnly`, `SameSite=Strict`, `Secure` over HTTPS.
- Logins are rate-limited per client IP and globally.
- Only one user holds the machine **control lease**; E-stop is always allowed.
- `PENPLOT_DEV=1` disables the setup code and enables a CORS allowlist and the simulator — **never**
  use it on a reachable machine.

## Deployment hardening checklist

- [ ] Run the service as the dedicated `penplot` user (as `deploy/bootstrap.sh` sets up), never as
      root; releases are read-only to it.
- [ ] Keep `/etc/penplot/web.env` at `root:penplot 0640`; `PENPLOT_DEV=0`.
- [ ] Use a strong admin password (≥ 10 characters); create separate accounts per person with the
      smallest role; revoke unused API tokens.
- [ ] Do not forward the port to the internet. For remote access use a Cloudflare Tunnel running **on
      the board** (forwarded headers are trusted from loopback only) behind a Cloudflare Access
      policy. Tunnel credentials stay on the board.
- [ ] Bind to a specific interface with `PENPLOT_HOST` if the board has several networks.
- [ ] The teletype **terminal mode** is an interactive shell with the service account's rights. It is
      admin-only and refused for remote (tunnel) users; disable it if you do not need it. The
      standalone `demos/teletype` script runs a shell as the user that starts it — LAN demos only.
- [ ] Keep the OS and the Python dependencies (`requirements-web.lock`) up to date.
- [ ] Treat uploaded files (SVG, DXF, XLSX, fonts, G-code) as untrusted; report any parser crash or
      resource exhaustion you find.
