import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/', 'coverage/', 'generated/', 'node_modules/'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Every promise is awaited or has its rejection handled, including `void` ones: a lazy
      // query that is never awaited is exactly the bug that once lost status updates.
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: false }],
    },
  },
  { files: ['server/**/*.ts', 'shared/**/*.ts', '*.config.ts'], languageOptions: { globals: globals.node } },
  { files: ['web/**/*.ts'], languageOptions: { globals: globals.browser } },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  prettier,
);
