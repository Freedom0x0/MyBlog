/** @type {import('tailwindcss').Config} */
const config = {
  darkMode: ["class"],
  // App-local on purpose, and *not* in the shared preset: these are the files this
  // app renders. The SPA's globs would scan the wrong tree and purge classes the
  // Next pages actually emit. There is no `index.html` here — App Router documents
  // come from app/layout.tsx — so the globs are the three source directories plus
  // lib/, which holds class strings the markdown renderer assembles.
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./hooks/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  // Same mechanism apps/web uses (design D-2): the colour half of `theme.extend`
  // lives in packages/design-tokens and is loaded through Tailwind's own `presets`,
  // which needs no build step. Tailwind v3 only — v4 dropped `presets` and JS config,
  // so a v4 upgrade here would silently orphan the shared token map.
  presets: [require("design-tokens/tailwind-preset")],
  theme: {
    extend: {
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
}

export default config
