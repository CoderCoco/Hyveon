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
