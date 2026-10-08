/**
 * Why `postcss-import` is in this chain when `apps/web/postcss.config.js` does not list
 * it — measured, not stylistic.
 *
 * `app/globals.css` opens with `@import "design-tokens/tokens.css";`, the same line 1
 * `apps/web/src/index.css` uses. Vite gets away with it because its bundled
 * postcss-import inlines the file *before* Tailwind sees anything, so the token block
 * arrives inside a stylesheet that does have `@tailwind base`.
 *
 * Next 16 / Turbopack does not do that by default: it turns the `@import` into its own
 * CSS module and runs the same PostCSS chain over it in isolation, and Tailwind v3
 * refuses a lone `@layer base` without a matching `@tailwind base`. The first build
 * said so outright:
 *
 *   CssSyntaxError: packages/design-tokens/tokens.css:1:1:
 *   `@layer base` is used but no matching `@tailwind base` directive is present.
 *
 * So the shared-token mechanism does **not** survive Next's CSS pipeline unchanged —
 * which is the assumption this stage was told not to make. Listing postcss-import
 * before tailwindcss restores the shape Vite produces, and nothing outside this app is
 * touched: `packages/design-tokens` still owns one copy of the tokens, `apps/web` still
 * gets them through its own bundler.
 *
 * Verified in the emitted stylesheet (see README "design tokens") — `:root` and `.dark`
 * both present with their values, and `text-muted-foreground` compiled from the shared
 * preset.
 *
 * The plugin names are strings rather than `import`ed functions for a second measured
 * reason: importing them makes Turbopack bundle Tailwind's own CommonJS into the
 * config's chunk, which rewrites `__dirname`, and Tailwind reads its preflight out of
 * `lib/css/` — the build then dies with
 * `ENOENT: ... 'C:\ROOT\node_modules\.pnpm\tailwindcss@3.4.19_…\lib\css\preflight.css'`.
 * Strings are resolved by the PostCSS config loader inside Node, where that path is
 * still real.
 */
const config = {
  // Order matters: inline the `@import`, then Tailwind, then autoprefixer over the
  // whole result.
  plugins: ['postcss-import', 'tailwindcss', 'autoprefixer'],
}

export default config
