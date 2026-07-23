module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  ignorePatterns: ['dist/', 'build/', 'node_modules/', '*.d.ts', 'coverage/'],
  rules: {
    // Don't be aggressive — the project has 1000+ files of unknown style.
    // Start permissive; tighten in follow-up PRs as the codebase converges.
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-empty-function': 'off',
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/no-var-requires': 'warn',
    'no-empty': ['warn', { allowEmptyCatch: true }],
    'no-useless-escape': 'warn',
    'no-constant-condition': 'warn',
    // The .tsx half of the codebase carries eslint-disable comments for
    // exhaustive-deps; without the plugin registered those comments are
    // themselves lint errors. Both rules stay at 'warn' per the note above.
    'react-hooks/rules-of-hooks': 'warn',
    'react-hooks/exhaustive-deps': 'warn',
  },
};
