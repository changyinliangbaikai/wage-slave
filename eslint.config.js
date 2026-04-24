// ESLint v9 flat config - 适配 Electron(主进程 + 渲染进程) + React + TypeScript
// 仅做基础规则，不与现有代码冲突；后续可以按需收紧
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactPlugin from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-electron/**',
      'release/**',
      'node_modules/**',
      '*.config.js',
      '*.config.ts',
      'split_sprite.py',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // React 配置：只应用于渲染进程
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',    // 新 JSX 转换不需要 import React
      'react/prop-types': 'off',            // TS 已经提供类型
      'react/no-unknown-property': 'off',   // 允许一些 Electron-specific 属性
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // react-hooks v6 新规则对现有异步 effect 模式偏严，先降级为 warn 逐步改进
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/set-state-in-render': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  // 主进程配置
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  // 所有 TS 的通用微调（宽松一些，避免打断当前代码）
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',         // 项目里有一些必要的 any（IPC payload 等）
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-require-imports': 'warn',     // 存量代码里偶尔有 require，先 warn
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-useless-escape': 'warn',
      'prefer-const': 'warn',
    },
  },
)
