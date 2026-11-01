import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { brotliCompressSync, constants as zc, gzipSync } from 'node:zlib'
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const BACKEND = process.env.PENPLOT_BACKEND ?? 'http://localhost:8080'

/**
 * Emit pre-compressed `.gz` and `.br` siblings for text assets so the FastAPI static
 * handler can serve them by Accept-Encoding without compressing on the Orange Pi.
 */
function precompress(): Plugin {
  const re = /\.(js|mjs|css|html|svg|json|txt|map|wasm)$/
  return {
    name: 'penplot-precompress',
    apply: 'build',
    enforce: 'post',
    // Compress the FINAL files on disk: in generateBundle the chunks still
    // contain placeholders (e.g. __VITE_PRELOAD__) that Vite replaces later,
    // and the backend serves the .br/.gz variants in preference.
    writeBundle(opts, bundle) {
      const dir = opts.dir ?? 'dist'
      for (const name of Object.keys(bundle)) {
        if (!re.test(name)) continue
        const file = path.join(dir, name)
        const buf = readFileSync(file)
        if (buf.length < 1024) continue
        writeFileSync(`${file}.gz`, gzipSync(buf, { level: 9 }))
        writeFileSync(
          `${file}.br`,
          brotliCompressSync(buf, {
            params: { [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_SIZE_HINT]: buf.length },
          }),
        )
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), precompress()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: false, ws: true },
    },
  },
  preview: {
    proxy: {
      '/api': { target: BACKEND, changeOrigin: false, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined
          // xterm (~300 kB) is only used by the lazily loaded teletype terminal. Keep it out of the
          // eagerly preloaded `vendor` chunk so it is fetched only when the terminal opens.
          if (id.includes('@xterm')) return 'xterm'
          if (/[\\/](react|react-dom|scheduler|react-router|react-router-dom)[\\/]/.test(id)) return 'react'
          if (id.includes('@radix-ui')) return 'radix'
          if (id.includes('@tanstack') || id.includes('zustand')) return 'data'
          if (id.includes('lucide-react')) return 'icons'
          return 'vendor'
        },
      },
    },
  },
})
