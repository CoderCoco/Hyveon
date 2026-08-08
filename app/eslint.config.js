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
  // `recommended`, deliberately — NOT `recommendedTypeChecked`.
  //
  // This matters more than usual right now. The workspace compiles on
  // TypeScript 7, which is outside typescript-eslint 8.65's declared peer
  // range (`>=4.8.4 <6.1.0`); the root package.json `overrides` are what let
  // npm install that combination at all. It works because these presets are
  // purely syntactic: `@typescript-eslint/typescript-estree` only needs
  // TypeScript's parser and AST, which TS 7 still exposes. The APIs TS 7.0
  // dropped are the programmatic Program/TypeChecker ones, which only the
  // type-aware rule set touches.
  //
  // So: before switching to `recommendedTypeChecked`, or adding
  // `parserOptions.project` / `projectService`, check whether
  // typescript-eslint supports TypeScript 7 yet (see typescript-eslint
  // #12518, which is blocked on the new API landing in TS 7.1). If it does
  // not, either stay on this preset or pin `typescript` back to ^5.9.3 and
  // drop the overrides.
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
      // EventBridge Scheduler has no cloud-agnostic interface in
      // @hyveon/shared/cloud.js (unlike Secrets Manager's SecretsStore) — the
      // FileBrowser auto-stop schedule is AWS-specific by design, same
      // AWS-SDK-direct reasoning as EcsService/Ec2Service above.
      'packages/desktop-main/src/services/SchedulerService.ts',
      'packages/desktop-main/src/services/SchedulerService.test.ts',
      // First-run wizard bootstrap (epic #139): deliberately AWS-SDK-direct,
      // not part of the cloud-agnostic RunTask/StopTask contract — see
      // openspec/changes/add-first-run-wizard/design.md decision 6.
      'packages/desktop-main/src/services/BootstrapService.ts',
      'packages/desktop-main/src/services/BootstrapService.test.ts',
      'packages/desktop-main/src/services/IamCheckService.ts',
      'packages/desktop-main/src/services/IamCheckService.test.ts',
      'packages/desktop-main/src/services/GuidedIamService.ts',
      'packages/desktop-main/src/services/GuidedIamService.test.ts',
      // resolveAwsClientCredentials converts the wizard's AwsCredentialSource
      // into the @aws-sdk/client-* `credentials` shape (static keys or
      // fromIni) — the same job IamCheckService.buildClientConfig already
      // does privately above, extracted so every other AWS-SDK-client owner
      // in desktop-main (EcsService, Ec2Service, cloud-provider.module.ts's
      // factories) can share it instead of re-deriving it.
      'packages/desktop-main/src/services/awsCredentialSource.ts',
      'packages/desktop-main/src/services/awsCredentialSource.test.ts',
      // Rotation-integration regression test composing both services above
      // against a shared store — same AWS-SDK-direct reasoning applies.
      'packages/desktop-main/src/services/guided-iam-rotation-integration.test.ts',
      // AwsProfileService.rotateActiveCredentials builds STS/IAM clients from
      // explicit credential parameters, same reasoning as GuidedIamService
      // above — see add-one-click-aws-bootstrap Group 3.
      'packages/desktop-main/src/services/AwsProfileService.ts',
      'packages/desktop-main/src/services/AwsProfileService.test.ts',
      'packages/desktop-main/src/test-mocks/ecs-mock.ts',
      'packages/desktop-main/src/test-mocks/run-record-mock.ts',
      'packages/desktop-main/src/test-mocks/remote-file-store-mock.ts',
      // Tier-2 integration spec for the wizard.guidedIam.* IPC channels
      // (add-one-click-aws-bootstrap Group 6): mocks the same STS/IAM SDK
      // calls GuidedIamService.ts makes directly (see that exception above)
      // via aws-sdk-client-mock, since no MockStore/DI-seam stub exists for
      // STS/IAM at this tier — same AWS-SDK-direct reasoning applies here.
      'packages/web/e2e/integration-specs/guided-iam.spec.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        patterns: [{
          group: ['@aws-sdk/*', '@aws-sdk/**'],
          message: 'Import AWS SDK clients only within packages/cloud-aws or packages/lambda; depend on the cloud-agnostic interfaces from @hyveon/shared/cloud.js elsewhere.',
        }],
      }],
    },
  },
);
