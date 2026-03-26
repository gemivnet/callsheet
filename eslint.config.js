import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  prettierConfig,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ─── TypeScript: strict but practical ─────────────────────────────

      // Unused vars are errors (underscore-prefixed ignored)
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],

      // Explicit any: warn (too many external APIs to ban outright)
      '@typescript-eslint/no-explicit-any': 'warn',

      // Require return types on exported functions
      '@typescript-eslint/explicit-function-return-type': [
        'warn',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],

      // Consistent type imports (enforces `import type { Foo }`)
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/consistent-type-exports': 'error',

      // No floating promises — must await or explicitly void
      '@typescript-eslint/no-floating-promises': 'error',

      // No misused promises (async in forEach, etc.)
      '@typescript-eslint/no-misused-promises': 'error',

      // Require await in async functions
      '@typescript-eslint/require-await': 'warn',

      // Switch must be exhaustive
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      // Array type: prefer T[] over Array<T>
      '@typescript-eslint/array-type': ['error', { default: 'array' }],

      // Consistent indexed object style: Record<K,V> over { [key: K]: V }
      '@typescript-eslint/consistent-indexed-object-style': ['error', 'record'],

      // Prefer as const
      '@typescript-eslint/prefer-as-const': 'error',

      // No unnecessary type assertions
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',

      // No confusing void expression
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],

      // Prefer nullish coalescing over ||
      '@typescript-eslint/prefer-nullish-coalescing': 'warn',

      // Non-null assertions: warn (external APIs sometimes need them)
      '@typescript-eslint/no-non-null-assertion': 'warn',

      // ─── Relaxed for external API / JSON.parse heavy codebase ─────────

      // Allow common types in template literals (config values are unknown/{})
      '@typescript-eslint/restrict-template-expressions': 'off',

      // Allow + with any (connector descriptions build strings from mixed types)
      '@typescript-eslint/restrict-plus-operands': 'off',

      // Unnecessary condition: off — too many false positives with ?? on API responses
      '@typescript-eslint/no-unnecessary-condition': 'off',

      // Unsafe any rules: warn not error — JSON.parse and external APIs are everywhere
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',

      // Unbound method: off — false positives with dynamic imports
      '@typescript-eslint/unbound-method': 'off',

      // Use unknown in catch: warn (good practice but not critical)
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'warn',

      // No base to string: warn (some external types are fine)
      '@typescript-eslint/no-base-to-string': 'warn',

      // No empty function: warn (sometimes needed for noop callbacks)
      '@typescript-eslint/no-empty-function': 'warn',

      // ─── JavaScript: opinionated ──────────────────────────────────────

      // Strict equality
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      // No var, prefer const
      'no-var': 'error',
      'prefer-const': 'error',

      // Arrow functions for callbacks
      'prefer-arrow-callback': 'error',

      // Object destructuring preferred
      'prefer-destructuring': ['warn', { object: true, array: false }],

      // Modern syntax
      'prefer-rest-params': 'error',
      'prefer-spread': 'error',

      // No duplicate imports
      'no-duplicate-imports': 'error',

      // No else after return
      'no-else-return': ['error', { allowElseIf: false }],

      // Clean ternaries
      'no-unneeded-ternary': 'error',
      'no-nested-ternary': 'error',

      // Object shorthand: obj = { fn() {} } over { fn: function() {} }
      'object-shorthand': ['error', 'always'],

      // No throw literals / prefer reject errors
      'no-throw-literal': 'error',
      'prefer-promise-reject-errors': 'error',

      // Require default case in switch
      'default-case': 'error',

      // No self compare
      'no-self-compare': 'error',

      // Catch template literal syntax in regular strings
      'no-template-curly-in-string': 'warn',

      // No useless code
      'no-useless-rename': 'error',
      'no-useless-return': 'error',
      'no-constructor-return': 'error',

      // Curly braces required for multi-line blocks
      curly: ['error', 'multi-line', 'consistent'],

      // Prefer template — off for prompt building readability
      'prefer-template': 'off',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', '*.js'],
  },
);
