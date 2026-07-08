import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import jsdoc from 'eslint-plugin-jsdoc';
import tsdoc from 'eslint-plugin-tsdoc';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/node_modules/**',
      '**/*.d.ts',
      'packages/web/vite.config.ts',
      'packages/web/playwright-report/**',
      'packages/web/test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      jsdoc,
      tsdoc,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'tsdoc/syntax': 'error',
      'jsdoc/require-jsdoc': ['error', {
        publicOnly: true,
        require: {
          FunctionDeclaration: true,
          ClassDeclaration: true,
          MethodDefinition: true,
          ArrowFunctionExpression: true,
          FunctionExpression: true,
        },
        contexts: [
          'TSInterfaceDeclaration',
          'TSTypeAliasDeclaration',
          'TSEnumDeclaration',
        ],
        checkConstructors: false,
      }],
    },
  },
  {
    files: ['packages/web/**/*.{ts,tsx}'],
    ignores: ['packages/web/e2e/**'],
    ...react.configs.flat.recommended,
    languageOptions: {
      ...react.configs.flat.recommended.languageOptions,
      globals: {
        ...globals.browser,
      },
    },
    settings: {
      react: { version: 'detect' },
    },
  },
  {
    files: ['packages/web/**/*.{ts,tsx}'],
    ignores: ['packages/web/e2e/**'],
    ...react.configs.flat['jsx-runtime'],
  },
  {
    files: ['packages/web/**/*.{ts,tsx}'],
    ignores: ['packages/web/e2e/**'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['packages/web/**/*.{ts,tsx}'],
    ignores: ['packages/web/e2e/**'],
    rules: { 'react/prop-types': 'off' },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // Ban direct @aws-sdk/* imports outside the cloud-aws implementation and
    // the Lambda packages (which run standalone, without a DI-injected
    // cloud provider). Everywhere else must depend on the cloud-agnostic
    // interfaces in @hyveon/shared/cloud.js instead.
    files: ['packages/**/*.{ts,tsx}'],
    ignores: [
      'packages/cloud-aws/**',
      'packages/lambda/**',
      // Legacy call sites predating the cloud-provider abstraction, pending
      // migration onto the cloud-agnostic interfaces. Do not add new entries
      // here — new code should depend on @hyveon/shared/cloud.js instead.
      'packages/shared/src/ddb/client.ts',
      'packages/shared/src/ddb/configStore.ts',
      'packages/shared/src/ddb/configStore.test.ts',
      'packages/shared/src/ddb/pendingStore.ts',
      'packages/shared/src/ddb/pendingStore.test.ts',
      'packages/shared/src/secrets/secretsStore.ts',
      'packages/shared/src/secrets/secretsStore.test.ts',
      'packages/desktop-main/src/services/LogsService.ts',
      'packages/desktop-main/src/services/LogsService.test.ts',
      'packages/desktop-main/src/services/Ec2Service.ts',
      'packages/desktop-main/src/services/Ec2Service.test.ts',
      'packages/desktop-main/src/services/FileManagerService.ts',
      'packages/desktop-main/src/services/FileManagerService.test.ts',
      'packages/desktop-main/src/services/EcsService.ts',
      'packages/desktop-main/src/services/EcsService.test.ts',
      'packages/desktop-main/src/test-mocks/ecs-mock.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        patterns: [{
          group: ['@aws-sdk/*'],
          message: 'Import AWS SDK clients only within packages/cloud-aws or packages/lambda; depend on the cloud-agnostic interfaces from @hyveon/shared/cloud.js elsewhere.',
        }],
      }],
    },
  },
);
