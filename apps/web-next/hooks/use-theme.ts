'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * The SPA's `hooks/useTheme.ts`, ported with its two quirks intact: the stored key is
 * `theme`, the default is **dark**, and the value is a class on `<html>` — which is
 * what makes `tokens.css`'s `.dark` block the thing that actually changes colour.
 *
 * The default has to match `app/layout.tsx`'s inline script, or the first paint lands
 * on the light tokens and a dark-mode reader sees a flash that the SPA does not have.
 */
type Theme = 'dark' | 'light'

const STORAGE_KEY = 'theme'

export function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'
  return window.localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark'
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readStoredTheme)

  useEffect(() => {
    document.documentElement.classList.remove('dark', 'light')
    document.documentElement.classList.add(theme)
    window.localStorage.setItem(STORAGE_KEY, theme)
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'))
  }, [])

  return { theme, toggleTheme, isDark: theme === 'dark' }
}
