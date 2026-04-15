import love from 'eslint-config-love';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.snapshots/**',
      '**/tmp/**',
      'packages/**/*.test.ts',
      'packages/obsidian-plugin/main.js',
      'packages/obsidian-plugin/main.js.map',
    ],
  },
  {
    ...love,
    files: ['packages/**/*.ts', 'packages/**/*.tsx'],
    languageOptions: {
      ...love.languageOptions,
      parserOptions: {
        ...love.languageOptions?.parserOptions,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...love.rules,
      'require-unicode-regexp': ['error', { requireFlag: 'u' }],
      '@typescript-eslint/no-magic-numbers': [
        'error',
        {
          ignore: [-1, 0, 1],
        },
      ],
    },
  },
];
