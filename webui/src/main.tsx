import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '@/app/app'
import { applyStoredPrefs } from '@/lib/theme'
import './index.css'

applyStoredPrefs()

// Minimal service worker (public/sw.js): lets notifications work from installed/home-screen apps.
// Browsers only allow it in secure contexts (https or localhost).
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => {}))
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
