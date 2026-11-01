// Apply the stored appearance before first paint (no flash). See src/lib/theme.ts.
// External file (not inline) so the strict CSP `script-src 'self'` allows it.
try {
  var t = localStorage.getItem('penplot.theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  var a = localStorage.getItem('penplot.accent');
  if (a) document.documentElement.dataset.accent = a;
} catch {}
