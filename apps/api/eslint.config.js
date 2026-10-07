import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // Build output is generated; linting it reports problems nobody can fix.
  { ignores: ['dist/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      // Underscore-prefixed bindings are the conventional way to say "this
      // parameter exists to satisfy a signature but is intentionally unused".
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
)
