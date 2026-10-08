/**
 * Shared Tailwind preset — the colour half of the design tokens.
 *
 * `theme.extend.colors` maps Tailwind utilities (bg-card, text-muted-foreground,
 * ...) onto the `hsl(var(--token))` custom properties declared in ./tokens.css.
 * The two files must be used together: the preset references variables that only
 * exist once tokens.css is loaded.
 *
 * Deliberately NOT in here: `darkMode`, `content`, and anything else an app owns.
 * In particular `content` never belongs in a shared preset — a preset carrying one
 * app's globs would make Tailwind scan the wrong files and silently purge live
 * classes from another app's CSS.
 *
 * Plain CommonJS on purpose: Tailwind loads configs through jiti, and this is the
 * one module format both a Vite app and a Next app can require() or import without
 * a build step.
 */
module.exports = {
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
    },
  },
}
