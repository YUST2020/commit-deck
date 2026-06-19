/**
 * ESLint Flat Config
 *
 * 技术栈：Electron + Vue 3 + Vite + TypeScript + Naive UI + Tailwind v4
 * 规范来源：AGENTS.md（禁 any、SFC 块序 script→template→style、组件 PascalCase…）
 *
 * 严格度：核心约束 error（any / 未用变量 / import 去重 / Vue 块序…），
 * import/order 设 warn（避免一次性大规模重排），用 --max-warnings=0 收紧。
 */
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import importPlugin from 'eslint-plugin-import'
import globals from 'globals'

export default tseslint.config(
  // ---------- 忽略：构建产物 / 配置 / 类型快照 ----------
  {
    ignores: [
      'dist/**',
      'out/**',
      'release/**',
      'node_modules/**',
      '**/*.tsbuildinfo',
      'electron.vite.config.*',
      'electron-builder.yml'
    ]
  },

  // ---------- 基础推荐集 ----------
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  importPlugin.flatConfigs.recommended,

  // ---------- Vue 用 vue-eslint-parser 解析 ----------
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue']
      }
    }
  },

  // ---------- 路径别名解析（@/ @renderer/ @shared/） ----------
  {
    settings: {
      'import/resolver': {
        typescript: {
          project: ['./tsconfig.web.json', './tsconfig.node.json'],
          alwaysTryTypes: true
        }
      }
    }
  },

  // ---------- 全局：语言 & 运行环境 globals ----------
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node
      }
    }
  },

  // ---------- 项目规则 ----------
  {
    files: ['**/*.{ts,tsx,vue,js,mjs,cjs}'],
    rules: {
      // --- TypeScript：与 AGENTS.md「禁 any、strict」对齐 ---
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],

      // --- JS 通用 ---
      'no-console': ['warn', { allow: ['warn', 'error'] }], // log/info/debug 仅提醒
      'no-debugger': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'smart'],

      // --- import ---
      'import/no-duplicates': 'error',
      'import/no-unresolved': 'off', // 别名 + 包外引用多，关掉避免噪声
      'import/order': [
        'warn',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'never',
          alphabetize: { order: 'ignore' } // 避免一次性大规模重排
        }
      ],

      // --- Vue：与 AGENTS.md 一致 ---
      'vue/block-order': ['error', { order: ['script', 'template', 'style'] }],
      // 模板里 PascalCase；忽略 Naive UI 的 n-* 组件（kebab-case 是其惯用写法）
      // 以及 Vue 内置组件（Transition/KeepAlive 等，全局自动注册）
      'vue/component-name-in-template-casing': [
        'error',
        'PascalCase',
        {
          ignores: [
            'n-.+',
            'transition',
            'transition-group',
            'keep-alive',
            'component',
            'slot',
            'teleport'
          ]
        }
      ],
      'vue/component-definition-name-casing': ['error', 'PascalCase'],
      'vue/multi-word-component-names': 'off', // App.vue 等单词名放行
      'vue/attributes-order': 'warn',
      'vue/no-v-html': 'off',
      'vue/require-default-prop': 'off', // 配合 TS 可选 props
      // 风格类交给编辑器/格式化，避免噪声
      'vue/html-self-closing': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/multiline-html-element-content-newline': 'off',
      'vue/html-indent': 'off',
      'vue/html-closing-bracket-newline': 'off'
    }
  }
)
