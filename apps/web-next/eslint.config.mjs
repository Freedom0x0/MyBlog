import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import next from 'eslint-config-next/core-web-vitals'

const config = [
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', 'pnpm-lock.yaml'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...next,
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    languageOptions: {
      // Both, because this app really does run in both: `lib/api.ts` executes in the
      // Node server (`process.env`, `AbortSignal`), components execute in the browser
      // (`window`, `document`). `no-undef` cannot tell them apart from one file.
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    /**
     * The build configs are loaded by tools, not by the app: Tailwind reads its config
     * through jiti, which is exactly why `require("design-tokens/tailwind-preset")`
     * works in an ESM package with no build step — and it is the shared-preset
     * mechanism design D-2 rests on. `no-require-imports` would forbid the one line
     * that keeps the two sites' colours in sync, so it is off here rather than worked
     * around by copying the token map into this app.
     */
    files: ['*.config.js', '*.config.mjs', '*.config.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    /**
     * `@next/next/no-img-element` is off on purpose, and the reason is a scope call,
     * not impatience. Every image on these pages is a URL the app does not control:
     * `coverImage` is whatever `POST /uploads/complete` handed back (an object-store
     * host configured by `MEDIA_PUBLIC_BASE_URL`, `http://127.0.0.1:9000` locally),
     * GitHub avatars are `avatars.githubusercontent.com`, and the homepage avatar is a
     * text-to-image URL baked into the SPA's copy. `next/image` needs an enumerated
     * `remotePatterns` allow list to render any of them, and choosing that list is the
     * image-pipeline decision the stage checklist explicitly defers ("图片 CDN、多尺寸
     * 变体 … 属 S8 批次"). Plain `<img>` is also what the SPA renders today, so this is
     * the parity-preserving option; revisit both together.
     */
    files: ['app/**/*.tsx', 'components/**/*.tsx'],
    rules: {
      '@next/next/no-img-element': 'off',
    },
  },
]

export default config
