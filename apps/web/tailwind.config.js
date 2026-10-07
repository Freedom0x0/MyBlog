/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  // Stays app-local on purpose: Tailwind scans these globs to decide which utilities
  // to keep. A shared preset carrying another app's globs would scan the wrong files
  // and silently purge classes this app actually renders.
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  // The colour half of `theme.extend` lives in packages/design-tokens (the tokens the
  // future public Next.js app has to share). Loaded through Tailwind's own `presets`
  // mechanism; requires no build step.
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