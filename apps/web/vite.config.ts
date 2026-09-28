import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from "vite-tsconfig-paths";

// https://vite.dev/config/
//
// The config is a function so `command` is available: 'serve' for `vite dev`,
// 'build' for `vite build`. Reading process.env.NODE_ENV here would be less
// reliable than asking Vite which command it is running.
export default defineConfig(({ command }) => ({
  server: {
    host: '127.0.0.1',
    port: 5175,
    strictPort: true,
  },
  build: {
    sourcemap: 'hidden',
  },
  plugins: [
    react({
      babel: {
        /**
         * `react-dev-locator` is what powers Trae's click-an-element-to-open-its
         * source. It works by stamping every JSX element with
         * `trae-inspector-file-path`, `-start-line`, `-start-column`,
         * `-end-line`, `-end-column` attributes.
         *
         * Applied unconditionally, those stamps shipped to production — measured
         * at 1020 occurrences in the built bundle, exposing the source tree's
         * file names and line numbers to anyone who opens devtools.
         *
         * Kept for `serve` because the capability is genuinely useful while
         * developing; never attached to `build`.
         */
        plugins: command === 'serve' ? ['react-dev-locator'] : [],
      },
    }),
    tsconfigPaths()
  ],
}))
