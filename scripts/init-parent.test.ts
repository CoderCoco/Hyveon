/**
 * Render-function smoke test for init-parent.ts. Run with:
 *   npx tsx init-parent.test.ts
 *
 * No assertion library — fails loudly via `process.exit(1)` if any check
 * doesn't hold.
 */

import { renderMakefile, renderTfvars, renderEnv, renderGitignore } from './init-parent.ts';

const a = {
  parentDir: '/tmp/parent',
  submoduleDir: 'Hyveon',
  submoduleName: 'Hyveon',
  projectName: 'mygames',
  awsRegion: 'us-west-2',
  hostedZone: 'example.com',
  apiToken: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222',
  configureDiscord: false,
};

const errors: string[] = [];
const expect = (label: string, ok: boolean): void => {
  if (!ok) errors.push(label);
};

const mk = renderMakefile(a);
expect('Makefile sets SUBMODULE', mk.includes('SUBMODULE   := $(REPO_ROOT)/Hyveon'));
expect('Makefile reads .env', mk.includes('include $(REPO_ROOT)/.env'));
expect('Makefile delegates plan', mk.includes('$(MAKE) -C $(SUBMODULE) tf-plan'));
expect('Makefile delegates apply', mk.includes('$(MAKE) -C $(SUBMODULE) tf-apply'));
expect('Makefile has dev target with state pull', mk.includes('terraform -chdir=$(TF_DIR) state pull'));
expect('Makefile has setup with stamp', mk.includes('SETUP_STAMP := $(STAMP_DIR)/setup.stamp'));
expect('Makefile rerun-on-change in update', mk.includes('setup.sh changed'));
expect('Makefile copy-tfvars uses cp', mk.includes('cp $(TFVARS) $(TF_DIR)/terraform.tfvars'));
expect('Makefile uses bash shell', mk.startsWith('SHELL      := /usr/bin/env bash'));
expect('Makefile does NOT inline API_TOKEN', !/API_TOKEN\s*:?=\s*[a-f0-9]{40,}/.test(mk));

// ── S3 tfvars backend detection block ───────────────────────────────────────
expect('Makefile defines TFVARS_MARKER', mk.includes('TFVARS_MARKER := $(SUBMODULE)/.gsd/tfvars-bucket'));
expect('Makefile defines TFVARS_LOCK', mk.includes('TFVARS_LOCK   := $(TFVARS).lock'));
expect('Makefile defines PARENT_TFVARS_MARKER at the parent repo root', mk.includes('PARENT_TFVARS_MARKER := $(REPO_ROOT)/.gsd/tfvars-bucket'));
expect(
  'Makefile defines TFVARS_BACKEND gated on GSD_TFVARS_BACKEND override, then the parent-root marker, then the submodule marker',
  mk.includes(
    'TFVARS_BACKEND = $(if $(filter s3,$(GSD_TFVARS_BACKEND)),s3,$(if $(filter local,$(GSD_TFVARS_BACKEND)),local,$(if $(wildcard $(PARENT_TFVARS_MARKER)),s3,$(if $(wildcard $(TFVARS_MARKER)),s3,local))))',
  ),
);
expect('Makefile routes TFVARS_SYNC --bucket through TFVARS_MARKER', mk.includes('cat $(TFVARS_MARKER)'));

// ── Parent-root marker precedence (prefers parent, falls back to submodule) ─
expect(
  'Makefile TFVARS_BACKEND checks the parent-root marker before the submodule marker',
  mk.indexOf('$(wildcard $(PARENT_TFVARS_MARKER))') < mk.indexOf('$(wildcard $(TFVARS_MARKER))') &&
    mk.indexOf('$(wildcard $(PARENT_TFVARS_MARKER))') !== -1,
);
expect(
  'Makefile TFVARS_BACKEND falls back to the submodule marker when no parent-root marker exists',
  mk.includes('$(if $(wildcard $(TFVARS_MARKER)),s3,local)'),
);
expect(
  'Makefile TFVARS_BUCKET prefers the parent-root marker contents, falling back to the submodule marker',
  mk.includes(
    'TFVARS_BUCKET = $(if $(GSD_TFVARS_BUCKET),$(GSD_TFVARS_BUCKET),$(shell cat $(PARENT_TFVARS_MARKER) 2>/dev/null || cat $(TFVARS_MARKER) 2>/dev/null))',
  ),
);
expect(
  'Makefile TFVARS_SYNC_ARGS resolves --bucket from the parent-root marker before the submodule marker',
  mk.includes('cat $(PARENT_TFVARS_MARKER) 2>/dev/null || cat $(TFVARS_MARKER) 2>/dev/null'),
);
expect(
  'Makefile help text mentions the parent-root marker before the submodule marker fallback',
  /otherwise inferred from \$\(PARENT_TFVARS_MARKER\), falling back to \$\(TFVARS_MARKER\)/.test(mk),
);

// ── Gated tfvars-* targets ───────────────────────────────────────────────────
expect('Makefile phonies list tfvars-pull/push/diff (not tfvars-status)', mk.includes('tfvars-pull tfvars-push tfvars-diff'));
expect('Makefile has tfvars-pull target', /^tfvars-pull:$/m.test(mk));
expect('Makefile has tfvars-push target', /^tfvars-push:$/m.test(mk));
expect('Makefile has tfvars-diff target wired to tfvars-sync.ts diff', /^tfvars-diff:$/m.test(mk) && mk.includes('$(TFVARS_SYNC) diff'));
expect('Makefile does NOT have a tfvars-status target', !/^tfvars-status:$/m.test(mk));
expect('Makefile tfvars-* targets gate on TFVARS_BACKEND != s3', mk.includes('if [ "$(TFVARS_BACKEND)" != s3 ]'));
expect(
  'Makefile tfvars-pull aborts on a dirty TFVARS before pulling',
  /tfvars-pull:\n(?:\t.*\n)*?\t@if \[ -n "\$\$\(git -C \$\(REPO_ROOT\) status --porcelain -- \$\(TFVARS\)\)" \]; then echo .* >&2; exit 1; fi\n\t\$\(TFVARS_SYNC\) pull/.test(mk),
);

// ── plan/apply/setup gating ──────────────────────────────────────────────────
expect(
  'Makefile gates plan auto-pull on TFVARS_BACKEND and NO_PULL',
  mk.includes('if [ "$(TFVARS_BACKEND)" = s3 ] && [ -z "$${NO_PULL:-}" ]; then'),
);
expect(
  'Makefile pull-tfvars-if-needed aborts on a dirty TFVARS before auto-pulling, same as tfvars-pull',
  /pull-tfvars-if-needed:\n(?:\t.*\n)*?\t\s*if \[ -n "\$\$\(git -C \$\(REPO_ROOT\) status --porcelain -- \$\(TFVARS\)\)" \]; then echo .* >&2; exit 1; fi;/.test(
    mk,
  ),
);
expect('Makefile plan depends on pull-tfvars-if-needed', mk.includes('plan: pull-tfvars-if-needed copy-tfvars'));
expect(
  'Makefile gates apply check on TFVARS_BACKEND and FORCE_APPLY',
  mk.includes('if [ "$(TFVARS_BACKEND)" = s3 ] && [ -z "$${FORCE_APPLY:-}" ]; then $(TFVARS_SYNC) check $(TFVARS_SYNC_ARGS); fi'),
);
expect('Makefile apply depends on check-tfvars-if-needed', mk.includes('apply: check-tfvars-if-needed copy-tfvars'));
// setup's post-bootstrap check must NOT reference the TFVARS_BACKEND/TFVARS_BUCKET make
// variables: GNU Make expands a rule's whole recipe (including any $(wildcard ...)/
// $(shell ...) calls hiding inside those variables) before running the recipe's first
// line, so a make-variable-based check would still see the filesystem from before
// setup.sh ran earlier in the same recipe. The check must be shell-native instead.
const setupRecipeMatch = /^setup:.*\n(?:(?:\t|#).*\n?)*/m.exec(mk);
const setupRecipe = setupRecipeMatch ? setupRecipeMatch[0] : '';
expect('Makefile has a setup: recipe to inspect', setupRecipe !== '');
// Regression coverage: setup.sh's bootstrap_tfvars_backend() derives
// TF_PROJECT from $(TF_DIR)/terraform.tfvars, not from the parent-root
// $(TFVARS)/PARENT_TFVARS_MARKER. Without copying the parent's tfvars into
// the submodule first, a first-ever `make setup` would see the
// "game-servers" default from terraform.tfvars.example and bootstrap a
// differently-named bucket than the one PARENT_TFVARS_MARKER records.
expect(
  'Makefile setup copies the parent tfvars into the submodule before running setup.sh, so TF_PROJECT (and the bucket setup.sh bootstraps) matches the project name PARENT_TFVARS_MARKER was derived from',
  setupRecipe.includes('cp $(TFVARS) $(TF_DIR)/terraform.tfvars') &&
    setupRecipe.indexOf('cp $(TFVARS) $(TF_DIR)/terraform.tfvars') < setupRecipe.indexOf('bash $(SUBMODULE)/setup.sh'),
);
expect(
  'Makefile setup runtime-pulls tfvars post-bootstrap via a shell-native (not make-variable) S3 backend check that also honors the parent-root marker',
  setupRecipe.includes(
    '[ "$${GSD_TFVARS_BACKEND:-}" = s3 ] || { [ "$${GSD_TFVARS_BACKEND:-}" != local ] && { [ -f $(PARENT_TFVARS_MARKER) ] || [ -f $(TFVARS_MARKER) ]; }; }',
  ) &&
    setupRecipe.includes('$(TFVARS_SYNC) pull $(TFVARS_SYNC_ARGS) 2>&1') &&
    !/if \[ "\$\(TFVARS_BACKEND\)" = s3 \]/.test(setupRecipe),
);

// ── setup exports GSD_TFVARS_BACKEND=s3 when the parent-root marker exists ──
// (but only when GSD_TFVARS_BACKEND is not already set — an explicit
// GSD_TFVARS_BACKEND=local override must survive into setup.sh's environment
// too, per TFVARS_BACKEND's own override precedence)
expect(
  'Makefile setup exports GSD_TFVARS_BACKEND=s3 into setup.sh\'s environment when the parent-root marker exists and GSD_TFVARS_BACKEND is unset',
  /if \[ -z "\$\$\{GSD_TFVARS_BACKEND:-\}" \] && \[ -f \$\(PARENT_TFVARS_MARKER\) \]; then export GSD_TFVARS_BACKEND=s3; fi; \\\n\tbash \$\(SUBMODULE\)\/setup\.sh/.test(
    setupRecipe,
  ),
);
expect(
  'Makefile setup\'s parent-marker export does not clobber an explicit GSD_TFVARS_BACKEND=local override',
  setupRecipe.includes('if [ -z "$${GSD_TFVARS_BACKEND:-}" ] && [ -f $(PARENT_TFVARS_MARKER) ]; then export GSD_TFVARS_BACKEND=s3; fi;'),
);
expect(
  'Makefile setup\'s parent-marker export line precedes the bash setup.sh invocation within the same recipe',
  setupRecipe.indexOf('export GSD_TFVARS_BACKEND=s3') <
    setupRecipe.indexOf('bash $(SUBMODULE)/setup.sh') &&
    setupRecipe.indexOf('export GSD_TFVARS_BACKEND=s3') !== -1,
);
expect(
  'Makefile setup tolerates a first-time pull against an empty bucket instead of aborting',
  /\$\(TFVARS_SYNC\) pull \$\(TFVARS_SYNC_ARGS\) 2>&1\); then[\s\S]*?run 'make tfvars-push' to seed the bucket/.test(mk),
);
// ── tfvars-sync.ts argv order: subcommand MUST be argv[0] (parseArgs()
// throws its usage error otherwise) — every $(TFVARS_SYNC) call site must
// render "<subcommand> $(TFVARS_SYNC_ARGS)", never flags before the
// subcommand. Regression coverage for the blocker where --path/--bucket
// were rendered ahead of pull|check|push|diff.
expect(
  'Makefile never renders TFVARS_SYNC flags before the subcommand',
  !/\$\(TFVARS_SYNC\)\s+--(path|bucket|key|region)\b/.test(mk),
);
expect(
  'Makefile renders TFVARS_SYNC_ARGS (--path/--bucket) after the pull|push|check|diff subcommand at every call site',
  (mk.match(/\$\(TFVARS_SYNC\)\s+(pull|push|check|diff)\b/g) ?? []).length ===
    (mk.match(/\$\(TFVARS_SYNC\)\s+(?:pull|push|check|diff)\s+\$\(TFVARS_SYNC_ARGS\)/g) ?? []).length &&
    (mk.match(/\$\(TFVARS_SYNC\)\s+(pull|push|check|diff)\b/g) ?? []).length === 6,
);

// ── Updated help text ────────────────────────────────────────────────────────
expect('Makefile help mentions tfvars-diff', mk.includes('make tfvars-diff'));
expect('Makefile help mentions GSD_TFVARS_BACKEND override', mk.includes('GSD_TFVARS_BACKEND=s3|local'));
expect('Makefile help does NOT mention tfvars-status', !mk.includes('tfvars-status'));

// ── Local-mode render: plan/apply/setup recipes stay functionally unchanged ──
expect('Makefile plan still delegates to tf-plan after copy-tfvars', /plan: pull-tfvars-if-needed copy-tfvars\n\t\$\(MAKE\) -C \$\(SUBMODULE\) tf-plan/.test(mk));
expect('Makefile apply still delegates to tf-apply after copy-tfvars', /apply: check-tfvars-if-needed copy-tfvars\n\t\$\(MAKE\) -C \$\(SUBMODULE\) tf-apply/.test(mk));
expect('Makefile setup still runs git submodule update and setup.sh', mk.includes('git submodule update --init --recursive') && mk.includes('bash $(SUBMODULE)/setup.sh'));

const tfv = renderTfvars(a);
expect('tfvars sets project_name', tfv.includes('project_name = "mygames"'));
expect('tfvars sets aws_region', tfv.includes('aws_region   = "us-west-2"'));
expect('tfvars sets hosted_zone_name', tfv.includes('hosted_zone_name = "example.com"'));
expect('tfvars has game_servers map', tfv.includes('game_servers = {'));
expect('tfvars Discord left commented when not configured', tfv.includes('# discord_application_id'));

const env = renderEnv(a);
expect('env contains API_TOKEN line', env.includes(`API_TOKEN=${a.apiToken}`));

const gi = renderGitignore(a);
expect('gitignore covers .env', gi.includes('.env\n'));
expect('gitignore covers .make/', gi.includes('.make/'));
expect('gitignore covers tfstate', gi.includes('terraform.tfstate'));
expect('gitignore covers tfvars-sync.ts lock sidecar', gi.includes('*.tfvars.lock'));

const aDiscord = { ...a, configureDiscord: true, discordApplicationId: '111', discordBotToken: 'btok', discordPublicKey: 'pkey' };
const tfvD = renderTfvars(aDiscord);
expect('tfvars writes Discord values when configured', tfvD.includes('discord_bot_token      = "btok"'));
expect('tfvars writes Discord public key', tfvD.includes('discord_public_key     = "pkey"'));

if (errors.length) {
  process.stderr.write(`\n✗ ${errors.length} render check(s) failed:\n`);
  for (const e of errors) process.stderr.write(`  - ${e}\n`);
  process.exit(1);
}
process.stdout.write('✓ All render checks passed.\n');
