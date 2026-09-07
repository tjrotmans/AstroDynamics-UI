import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        ws: true,
      },
    }
  },
  // `npm run build && npm run preview` serves the PRODUCTION bundle against
  // the same backend (freeze investigation: React's dev-only
  // prop-diff instrumentation was measured at ~6 s per commit on the Phase
  // 03 page; production React has none of it and renders ~2-3x faster).
  preview: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        ws: true,
      },
    }
  }
})