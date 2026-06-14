import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Global ignores: must be a standalone object (ignores as the ONLY key),
  // otherwise flat config scopes it to this entry and dist/ still gets linted.
  { ignores: ['dist/', 'node_modules/', 'src-tauri/'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }]
    }
  }
);
