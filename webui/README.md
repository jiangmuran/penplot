# PenPlot web workbench (webui)

React 19 + TypeScript + Vite 8, Tailwind v4, Radix primitives (shadcn-style, in-repo), lucide-react,
TanStack Query, Zustand, react-router v7. UI language: 简体中文. Specs: `../docs/design/02-ux.md` (UI),
`../docs/design/03-backend.md` + `04-contract-notes.md` + `openapi.json` (API).

```bash
npm install
npm run dev          # Vite on :5173, proxies /api (incl. WebSocket) → http://localhost:8080
PENPLOT_BACKEND=http://127.0.0.1:8099 npm run dev -- --port 5180   # other backend / port
npm run build        # tsc -b && vite build → dist/ (+ .gz/.br next to every text asset)
npm run gen:api      # docs/design/openapi.json → src/api/schema.d.ts (openapi-typescript)
npm run screenshots -- http://localhost:5173 /tmp/shots shell /studio [--mock]
```

`gen:api` runs openapi-typescript from `tools/openapi/` (its own node_modules with TypeScript 5, installed
on first run), because the app compiles with the native TypeScript 7, which has no JS compiler API.
`--mock` in the screenshot script fakes an authenticated backend, a connected machine and a running job.

## Layout

```
src/
  main.tsx, index.css          entry; design tokens + Tailwind theme (single CSS file)
  app/                         SHELL (foundation-owned; phase-2 may add files, not rewrite)
    app.tsx, router.tsx        providers; route table (lazy feature chunks)
    app-shell.tsx              frame: sidebar / tab bar, toolbar / nav bar, banners, <Outlet/>, global layers
    page.tsx, chrome.tsx       <Page> component + toolbar portals
    auth/, auth-gate.tsx       /login, /setup, guard, session-expired dialog
    estop.tsx, status-pill.tsx, mini-player.tsx, banners.tsx, drop-overlay.tsx,
    notification-center.tsx, global-shortcuts.tsx, live-effects.tsx, nav.ts, ui-store.ts
    import-handlers.ts         where features register drag-and-drop import handlers
  components/ui/               UI kit (import from '@/components/ui')
  lib/                         cn, format, media (breakpoints), theme, shortcuts, toast, confirm, import-registry
  api/                         client (fetch), query (TanStack + keys), ws (socket), store (live Zustand),
                               machine (estop/pause/…), auth, status-view, types (aliases), schema.d.ts (generated)
  features/<name>/index.tsx    one folder per screen (studio, projects, fonts, machine, jobs, console, settings, system)
```

Phase-2 agents own `src/features/**`. Shared foundation dirs (`app/`, `components/ui/`, `lib/`, `api/`) are
append-only for them: add new files, don't rewrite existing ones.

## Conventions

### Add a screen / route
Every route renders a default-exported component from `src/features/<name>/index.tsx` wrapped in `<Page>`:

```tsx
import { Page } from '@/app/page'
import { Button, SearchField } from '@/components/ui'

export default function FontsPage() {
  return (
    <Page title="字库" toolbar={<SearchField value={q} onValueChange={setQ} />} actions={<Button variant="filled">导入</Button>}>
      …
    </Page>
  )
}
```
- `toolbar` = page controls after the title, `actions` = icon buttons and **one** primary action (on the right, before the status pill).
- `padded={false}` makes the page full-bleed (canvas). `inspector` shows the panel-right toggle; read its state from
  `useUi((s) => s.inspector[bp])` (`bp` from `useBreakpoint()`) and render the panel yourself (bottom `Sheet` on compact).
- On compact, `<Page>` draws the iOS large title, which collapses into the nav bar as the page scrolls.
- New route: add it to `src/app/router.tsx` (`lazy: page(() => import('@/features/x/…'))`). Sub-routes should live inside the feature.
- Sidebar and tab-bar entries come from `src/app/nav.ts`.

### Data: REST
```ts
import { api, ApiError } from '@/api/client'
import { qk, queryClient } from '@/api/query'
import type { components } from '@/api/schema'
type FontSummary = components['schemas']['FontSummary']

useQuery({ queryKey: qk.fonts.list({ q }), queryFn: () => api.get<FontSummary[]>('/fonts', { query: { q } }) })
useMutation({ mutationFn: (id: string) => api.delete(`/fonts/${id}`), meta: { errorTitle: '删除字体失败' },
              onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.fonts.all }) })
```
- `api` adds `credentials: 'include'` and `X-Penplot: 1` on unsafe methods. Errors throw a typed `ApiError` (`status`, `code`, `message` in Chinese, `detail`, `retryAfter`).
  Network or proxy failure gives `status 0/502` with `isOffline` set. 401 opens the in-place re-login dialog, and 423 redirects to `/setup`.
- Non-idempotent machine calls take `{ idempotencyKey: true }`.
- Mutation errors toast automatically (`meta.errorTitle`). Set `meta: { silent: true }` to handle them yourself. Queries never toast; render `<ErrorState error={e} onRetry={refetch} />` instead.
- Long work (`?wait=5`) can return `202 {task_id}`. Watch `useLive((s) => s.tasks[id])` (fed by WS `task`) or poll `/tasks/{id}`.
- Endpoints go live progressively. Show 404/501 as an inline "尚不可用" state, not a crash.
- Query keys: `qk.<resource>.all | list(params) | detail(id)`. Add new resources to `qk` in `api/query.ts`.

### Live data: WebSocket
- `ws` (`src/api/ws.ts`) is started by the shell. It handles hello snapshots, reconnects with 0.5/1/2/5 s backoff, measures ping RTT, and sends `cmd` with acks.
- Read live state from the Zustand store: `useLive((s) => s.machine)`, `s.job`, `s.progress`, `s.tasks`, `s.alarm`, `s.log`, `s.conn`, `s.rtt`, `s.quality`, `s.system`.
  Use `useShallow` when you select several fields.
- Raw events: `useWsEvent('error', (e) => …)`. Opt-in topics (e.g. the serial log): `useWsTopics(['log'])`. The log
  then arrives in `useLive((s) => s.log)` (ring buffer, 5000 lines).
- Commands: `await ws.cmd('jog', { dx: 1, dy: 0, dz: 0, feed: 1500, seq })`. For pause/resume/stop/estop/pen, use the
  helpers in `@/api/machine`: they prefer the WebSocket and fall back to HTTP.
- Status presentation: `statusView()` / `useLiveStatus()` (colour, icon, label), and `<StatusPill>`.

### Feedback
- Toast: `toast.success('已保存')`, `toast.error('写入失败', { description })`, or `toast({ title, action: { label: '撤销', onClick } })`.
  Toasts with the same `key` merge (×N). Errors stay on screen until dismissed. Every toast is recorded in the notification center (bell).
- Destructive confirmation: `if (await confirm({ title: '删除字体？', confirmLabel: '删除', destructive: true })) …`.
  Cancel has default focus. Use toast-with-undo for operations that can be undone.
- Alarm and disconnection banners are global. Don't toast them.

### Errors, crashes, attention (05-review fixes)
- `describeError(err)` from `@/api/errors` returns `{ title, hint, code, status, technical }` in plain Chinese (it maps `job_active`, `machine_busy`,
  `origin_invalid`, `port_busy`, `lease_held`, `rev_conflict`, … plus network failures). Never show a raw HTTP status. `ErrorState`, mutation toasts and `errorMessage()` already use it.
- Each child route has `errorElement: <PageError/>`, and the outlet is wrapped in a `SafeBoundary`. A page that crashes renders
  「这一页出错了」 inside the shell, while the sidebar, toolbar, mini-player and E-stop keep working. Shell widgets have their own boundaries (`@/app/error-boundary`).
  Visit `/__crash` in dev to check this.
- `useHideMiniPlayer()` (`@/app/mini-player`) hides the global mini-player while your page is mounted. `/jobs` hides it automatically.
- Attention: `@/lib/attention` provides `alertUser`, `playTone`, `requestNotifications` (call it from a click) and `useAttentionPrefs`. The shell
  (`app/attention.tsx`) turns job done / change paper / paused on error / failed / alarm / firmware error / control-lease changes into sound, vibration,
  a system notification, title flashing and the attention banner. It also keeps the screen awake while writing and re-syncs when the tab returns to the foreground.
  `<AttentionSettings/>` (`@/app/attention-settings`) is a drop-in settings group.
- PWA: `public/manifest.webmanifest`, `public/icons/*`, `public/sw.js` (notifications only, no caching). Browsers only allow notifications and service workers
  over HTTPS or localhost; on plain-HTTP LAN the sound and title flashing still work. Minimum supported iOS version: 16.
- The floating E-stop never covers sheets. Regular side sheets start below the toolbar (`--estop-safe-top`). On compact, while a bottom sheet is open,
  the E-stop moves to the top-right corner.

### Drag-and-drop import
In your feature, create a small module (no heavy imports) and import it once from `src/app/import-handlers.ts`:
```ts
registerImportHandler({ id: 'fonts.install', label: '安装到字库', icon: Type, priority: 10,
  accept: ['.psf', '.gfont', '.ttf', '.otf', '.ttc'], run: async (files, { navigate }) => { … } })
```
The overlay offers up to 3 handlers that accept every dropped file, sorted by `priority`. A low-priority
"上传到文件库" fallback is registered by default.

### Keyboard shortcuts
`useShortcut('mod+p', openPrint, { description: '打印', group: '创作台' })` (Mod = ⌘ on Apple, Ctrl elsewhere).
Single-key shortcuts don't fire while the user is typing. Shortcuts with a `description` appear in the `?` cheat-sheet.
The shell owns Mod+. (E-stop), Mod+1…8, Mod+Alt+S/I, `?`, Space (pause/resume outside /studio) and Esc (stop dialog outside /studio).
Studio should register its own Space/Esc behaviour.

## Design tokens
All tokens are CSS variables in `src/index.css` (02-ux §4). Light and dark follow the system, `data-theme` forces one,
`data-accent` changes the accent, and `data-density` the density. Helpers live in `@/lib/theme`. Use semantic Tailwind names, never raw hex:

| Kind | Classes |
|---|---|
| Labels | `text-label`, `text-secondary-label`, `text-tertiary-label`, `text-quaternary-label` |
| Fills | `bg-fill`, `bg-secondary-fill`, `bg-tertiary-fill`, `bg-quaternary-fill` |
| Backgrounds | `bg-bg`, `bg-bg-secondary`, `bg-bg-grouped`, `bg-bg-grouped-secondary`, `bg-bg-elevated` |
| System colours | `bg-blue/15`, `text-red`, … plus `text-on-tint-{green,red,orange,blue}` for text on 15% tints |
| Accent | `bg-accent`, `text-accent`, `bg-accent/15` (only for primary, selection, links, focus, progress) |
| Canvas | `bg-canvas-desk`, `bg-canvas-paper`, `text-ink`, `text-guide`, `text-axis-x/-y`, `text-travel`, `shadow-paper` |
| Type | `text-large-title`, `text-title1/2/3`, `text-headline`, `text-body`, `text-callout`, `text-subheadline`, `text-footnote`, `text-caption` (macOS sizes; iOS sizes at <768px or with touch) |
| Radii | `rounded-xs` 4, `rounded-sm` 6, `rounded-md` 8, `rounded-lg` 10, `rounded-xl` 14 |
| Shadows | `shadow-sm`, `shadow-md` (popover/toast), `shadow-lg` (sheet/dialog), `shadow-paper` |
| Materials | `mat-sidebar`, `mat-toolbar`, `mat-thick`, `mat-thin`, `mat-hud` (they fall back to opaque under reduced transparency) |
| Lines | `hairline-t/-b/-l/-r` (0.5px separators), `<Separator/>` |
| Motion | `ease-standard/-spring`, `duration-[var(--dur-fast)]`, `animate-pop-in`, `animate-fade-in`, `press` (scale .97). Reduced motion turns movement into fades. |
| Touch | `pointer-coarse:` variant for 44px targets; `pt-safe`/`pb-safe` for safe-area insets |

Spacing uses Tailwind's 4px scale on an 8pt grid (`p-2` 8, `p-4` 16, `p-6` 24). Page padding is 24 on regular and 16 on compact.

UI kit (`@/components/ui`): Button (filled/gray/tinted/plain/bordered/destructive*), IconButton (requires `label`;
shows a tooltip and shortcut), Input/Textarea, NumberField (unit + stepper), Slider, Switch, Segmented, Select, Combobox,
SearchField, Dialog, Sheet (side panel, or bottom sheet with detents on compact), Popover, DropdownMenu, ContextMenu,
Tooltip, Tabs, Toaster, AlertDialog/ConfirmHost, ScrollArea, Separator, Badge, StatusPill, Card, GroupedList/ListRow,
FormRow/FormField, EmptyState/ErrorState, Skeleton/SkeletonList/Delayed, ProgressBar/ProgressRing, Kbd, Spinner.
