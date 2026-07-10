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
expect(
  'Makefile defines TFVARS_BACKEND gated on GSD_TFVARS_BACKEND override then the marker file',
  mk.includes(
    'TFVARS_BACKEND = $(if $(filter s3,$(GSD_TFVARS_BACKEND)),s3,$(if $(filter local,$(GSD_TFVARS_BACKEND)),local,$(if $(wildcard $(TFVARS_MARKER)),s3,local)))',
  ),
);
expect('Makefile routes TFVARS_SYNC --bucket through TFVARS_MARKER', mk.includes('cat $(TFVARS_MARKER)'));

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
  mk.includes('if [ "$(TFVARS_BACKEND)" = s3 ] && [ -z "$${NO_PULL:-}" ]; then $(TFVARS_SYNC) pull; fi'),
);
expect('Makefile plan depends on pull-tfvars-if-needed', mk.includes('plan: pull-tfvars-if-needed copy-tfvars'));
expect(
  'Makefile gates apply check on TFVARS_BACKEND and FORCE_APPLY',
  mk.includes('if [ "$(TFVARS_BACKEND)" = s3 ] && [ -z "$${FORCE_APPLY:-}" ]; then $(TFVARS_SYNC) check; fi'),
);
expect('Makefile apply depends on check-tfvars-if-needed', mk.includes('apply: check-tfvars-if-needed copy-tfvars'));
expect(
  'Makefile setup runtime-pulls tfvars post-bootstrap when TFVARS_BACKEND is s3',
  mk.includes('if [ "$(TFVARS_BACKEND)" = s3 ]; then') && mk.includes('$(TFVARS_SYNC) pull ||'),
);
expect(
  'Makefile setup tolerates a first-time pull against an empty bucket instead of aborting',
  /\$\(TFVARS_SYNC\) pull \|\| echo ".*run 'make tfvars-push' to seed the bucket"/.test(mk),
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
