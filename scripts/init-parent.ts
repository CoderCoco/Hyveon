#!/usr/bin/env -S npx tsx
/**
 * init-parent.ts
 *
 * Interactive scaffolder for the "private parent repo + Hyveon
 * submodule" deployment pattern documented at
 * https://codercoco.github.io/Hyveon/guides/submodule/.
 *
 * Run from the parent (private) repo root:
 *
 *   cd your-private-games
 *   git submodule add https://github.com/CoderCoco/Hyveon.git
 *   (cd Hyveon/scripts && npm install)
 *   npx --prefix Hyveon/scripts tsx Hyveon/scripts/init-parent.ts
 *
 * The script writes (or refuses to overwrite without --force):
 *   - Makefile           wrapper around the submodule's Makefile
 *   - terraform.tfvars   skeleton populated from your answers
 *   - .env               API_TOKEN for the management app (gitignored)
 *   - .gitignore         covers .env, .make/, terraform.tfstate*, etc.
 *
 * It NEVER reads or modifies anything inside the submodule.
 */

import { createInterface, type Interface } from 'node:readline/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdin as input, stdout as output, argv, cwd, exit } from 'node:process';
import { randomBytes } from 'node:crypto';

interface Answers {
  parentDir: string;
  submoduleDir: string;
  submoduleName: string;
  projectName: string;
  awsRegion: string;
  hostedZone: string;
  apiToken: string;
  configureDiscord: boolean;
  discordApplicationId?: string;
  discordBotToken?: string;
  discordPublicKey?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI dispatch
// ─────────────────────────────────────────────────────────────────────────────

/** Subcommands `init-parent.ts` dispatches on. `bootstrap` is the default when none is given. */
export type CliCommand = 'bootstrap' | 'migrate';

/** Direction for `migrate` — which way to move the parent repo's tfvars backend. */
export type MigrateDirection = 'to-s3' | 'to-local';

export interface CliArgs {
  command: CliCommand;
  force: boolean;
  /** Pre-seeds an S3 tfvars backend during bootstrap. Only meaningful when `command === 'bootstrap'`. */
  s3Tfvars: boolean;
  /** Skips interactive confirmation prompts. Valid for both subcommands. */
  yes: boolean;
  /** Only meaningful when `command === 'migrate'`; always set once parsing succeeds (migrate requires exactly one direction). */
  direction?: MigrateDirection;
}

/** Thrown by {@link parseCliArgs} for an unrecognized subcommand, an unrecognized flag, or an invalid flag combination. Callers should print `err.message` plus {@link USAGE} to stderr and exit 1. */
export class CliUsageError extends Error {}

export const USAGE = `Usage:
  init-parent.ts [--force] [--s3-tfvars] [--yes]            Interactive bootstrap (default)
  init-parent.ts migrate --to-s3 | --to-local [--yes]        Migrate an existing parent repo's tfvars backend
`;

/**
 * Parses `init-parent.ts`'s CLI args (i.e. `argv.slice(2)`) into a subcommand
 * plus its flags. `bootstrap` is implied when the first token isn't a known
 * subcommand, so existing invocations like `tsx init-parent.ts --force` keep
 * working unchanged. Throws {@link CliUsageError} for an unrecognized
 * subcommand, an unrecognized flag for the resolved subcommand, or (for
 * `migrate`) anything other than exactly one of `--to-s3` / `--to-local`.
 * Pure and side-effect free, so it's directly unit-testable.
 */
export function parseCliArgs(args: string[]): CliArgs {
  const rest = [...args];
  let command: CliCommand = 'bootstrap';

  if (rest[0] === 'migrate') {
    command = 'migrate';
    rest.shift();
  } else if (rest[0] !== undefined && rest[0].startsWith('--') === false) {
    throw new CliUsageError(`Unknown subcommand "${rest[0]}".`);
  }

  const knownFlags: readonly string[] =
    command === 'bootstrap' ? ['--force', '--s3-tfvars', '--yes'] : ['--to-s3', '--to-local', '--yes'];

  for (const token of rest) {
    if (!knownFlags.includes(token)) {
      throw new CliUsageError(`Unknown flag "${token}" for ${command === 'bootstrap' ? 'the default bootstrap command' : "'migrate'"}.`);
    }
  }

  const force = rest.includes('--force');
  const s3Tfvars = rest.includes('--s3-tfvars');
  const yes = rest.includes('--yes');

  if (command === 'bootstrap') {
    return { command, force, s3Tfvars, yes };
  }

  const hasS3 = rest.includes('--to-s3');
  const hasLocal = rest.includes('--to-local');
  if (hasS3 === hasLocal) {
    throw new CliUsageError('migrate requires exactly one of --to-s3 | --to-local.');
  }

  return { command, force, s3Tfvars, yes, direction: hasS3 ? 'to-s3' : 'to-local' };
}

/** Mutable so it can be set once `parseCliArgs` has run at entrypoint time; `writeIfSafe` reads it below. */
let FORCE = false;

// ─────────────────────────────────────────────────────────────────────────────
// Path detection
// ─────────────────────────────────────────────────────────────────────────────

/** Walk up from `start` until a directory containing `.gitmodules` is found. */
function findParentRepoRoot(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, '.gitmodules'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Best-effort guess of the submodule path inside the parent repo. */
function detectSubmodulePath(parentDir: string, scriptDir: string): string {
  // If the script lives at <parent>/<submodule>/scripts/init-parent.ts,
  // the submodule directory name is the immediate parent of `scripts/`.
  const submoduleRoot = dirname(scriptDir);
  const rel = relative(parentDir, submoduleRoot);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel;

  // Fall back to parsing .gitmodules.
  const gm = join(parentDir, '.gitmodules');
  if (existsSync(gm)) {
    const m = readFileSync(gm, 'utf8').match(/path\s*=\s*(\S+)/);
    if (m) return m[1];
  }
  return 'Hyveon';
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompting
// ─────────────────────────────────────────────────────────────────────────────

async function ask(rl: Interface, label: string, def?: string): Promise<string> {
  const suffix = def === undefined ? ': ' : ` [${def}]: `;
  const raw = (await rl.question(label + suffix)).trim();
  return raw || def || '';
}

async function askBool(rl: Interface, label: string, def: boolean): Promise<boolean> {
  const hint = def ? 'Y/n' : 'y/N';
  const raw = (await rl.question(`${label} (${hint}): `)).trim().toLowerCase();
  if (!raw) return def;
  return raw.startsWith('y');
}

async function askRequired(rl: Interface, label: string, def?: string): Promise<string> {
  while (true) {
    const v = await ask(rl, label, def);
    if (v) return v;
    output.write('  ↳ a value is required.\n');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// File generators
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirrors the structure documented in the Makefile-driven submodule pattern:
 *   setup → init submodule, run setup.sh, stamp its sha, then pull tfvars
 *            from S3 if setup.sh just bootstrapped a backend
 *   plan  → auto-pull tfvars from S3 (unless NO_PULL=1), copy tfvars in,
 *            delegate to submodule's `make tf-plan`
 *   apply → check tfvars are in sync with S3 first (unless FORCE_APPLY=1),
 *            copy tfvars in, delegate to `make tf-apply`
 *   update → bump submodule, rerun setup.sh only if its sha changed
 *   dev   → pull live tfstate into .make/, then `make dev` in submodule
 *
 * Three extra targets — tfvars-pull, tfvars-push, tfvars-diff — wrap
 * scripts/tfvars-sync.ts for manual use. plan/apply's auto-pull/check are
 * gated on TFVARS_BACKEND, which resolves to "s3" or "local" in this order:
 *   1. GSD_TFVARS_BACKEND=s3    — force s3, even without a marker file yet
 *   2. GSD_TFVARS_BACKEND=local — force local, even if a marker file exists
 *   3. otherwise: "s3" when the `.gsd/tfvars-bucket` marker file setup.sh
 *      writes inside the submodule directory exists, else "local"
 * When TFVARS_BACKEND is "local", plan/apply/setup behave exactly as
 * before — no S3 calls are made. setup's post-bootstrap pull applies the
 * same override semantics but re-implements them directly in its shell
 * recipe rather than referencing TFVARS_BACKEND — see the comment on that
 * recipe below for why.
 *
 * API_TOKEN is loaded from .env (gitignored) — never hardcoded.
 */
export function renderMakefile(a: Answers): string {
  return `SHELL      := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c

REPO_ROOT   := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
SUBMODULE   := $(REPO_ROOT)/${a.submoduleDir}
TF_DIR      := $(SUBMODULE)/terraform
TFVARS      := $(REPO_ROOT)/terraform.tfvars
STAMP_DIR   := $(REPO_ROOT)/.make
SETUP_STAMP := $(STAMP_DIR)/setup.stamp

# Load API_TOKEN (and any other K=V) from .env without leaking it into git.
ifneq (,$(wildcard $(REPO_ROOT)/.env))
include $(REPO_ROOT)/.env
export
endif

# ── S3 tfvars backend detection ──────────────────────────────────────────────
# TFVARS_MARKER is the bucket-name marker file setup.sh writes when it
# bootstraps the versioned S3 tfvars backend (see setup.sh's
# bootstrap_tfvars_backend()). TFVARS_LOCK is the sidecar lock file
# tfvars-sync.ts writes after every successful pull/push, recording the S3
# version id/etag last synced.
TFVARS_MARKER := $(SUBMODULE)/.gsd/tfvars-bucket
TFVARS_LOCK   := $(TFVARS).lock

# TFVARS_BACKEND resolves the s3-vs-local decision explicitly, so an operator
# can always force one or the other regardless of what's on disk:
#   - GSD_TFVARS_BACKEND=s3    → force s3, even if the marker file is missing
#   - GSD_TFVARS_BACKEND=local → force local, even if a marker file is present
#   - unset                    → s3 when the marker file exists, else local
# Recursive ('=', not ':='), so \$(wildcard ...) is re-evaluated whenever this
# variable is referenced from a *separate* \`make\` invocation (plan, apply,
# tfvars-pull, etc. all see current marker-file state that way). It must NOT
# be used to gate \`setup\`'s post-bootstrap pull: GNU Make expands a rule's
# entire recipe before running the first line of that recipe, so a reference
# to this variable inside the same \`setup\` recipe that runs setup.sh would
# still see the pre-setup.sh filesystem state even though it appears later in
# the recipe text. \`setup\` re-implements the same override logic directly in
# its shell recipe instead — see below.
TFVARS_BACKEND = $(if $(filter s3,$(GSD_TFVARS_BACKEND)),s3,$(if $(filter local,$(GSD_TFVARS_BACKEND)),local,$(if $(wildcard $(TFVARS_MARKER)),s3,local)))

# TFVARS_BUCKET is display-only (used in log messages below); GSD_TFVARS_BUCKET
# wins if already set, otherwise the marker file's contents.
TFVARS_BUCKET = $(if $(GSD_TFVARS_BUCKET),$(GSD_TFVARS_BUCKET),$(shell cat $(TFVARS_MARKER) 2>/dev/null))
# TFVARS_SYNC is deliberately just the interpreter invocation with no
# subcommand or flags: tfvars-sync.ts's parseArgs() requires the subcommand
# (pull/push/check/diff) to be argv[0], so every call site must render
# "$(TFVARS_SYNC) <subcommand> $(TFVARS_SYNC_ARGS)" — never put flags before
# the subcommand.
TFVARS_SYNC      = npx --prefix $(SUBMODULE)/scripts tsx $(SUBMODULE)/scripts/tfvars-sync.ts
TFVARS_SYNC_ARGS = --path $(TFVARS) --bucket "$\${GSD_TFVARS_BUCKET:-$$(cat $(TFVARS_MARKER) 2>/dev/null)}"

.PHONY: help setup plan apply update dev copy-tfvars pull-tfvars-if-needed check-tfvars-if-needed tfvars-pull tfvars-push tfvars-diff

# ── Help ─────────────────────────────────────────────────────────────────────
help:
\t@echo "${a.projectName} — submodule deployment wrapper"
\t@echo ""
\t@echo "  make setup         One-time bootstrap: init submodule, install deps, terraform init"
\t@echo "                     (pulls terraform.tfvars from S3 afterwards if setup.sh bootstrapped a backend)"
\t@echo "  make plan          Copy tfvars into submodule then terraform plan"
\t@echo "                     (auto-pulls tfvars from S3 first when a backend is detected; NO_PULL=1 to skip)"
\t@echo "  make apply         Copy tfvars into submodule then terraform apply"
\t@echo "                     (checks tfvars are in sync with S3 first when a backend is detected; FORCE_APPLY=1 to skip)"
\t@echo "  make update        Pull latest ${a.submoduleDir}/main; rerun setup.sh if changed"
\t@echo "  make dev           Start dev servers (Nest :3001 + Vite :5173)"
\t@echo "  make tfvars-pull   Pull terraform.tfvars from the S3 backend (requires one to be configured)"
\t@echo "  make tfvars-push   Push terraform.tfvars to the S3 backend"
\t@echo "  make tfvars-diff   Show a unified diff between local and remote terraform.tfvars"
\t@echo ""
\t@echo "  S3 tfvars backend detection: GSD_TFVARS_BACKEND=s3|local overrides;"
\t@echo "  otherwise inferred from the $(TFVARS_MARKER) marker file."

# ── Stamp dir ────────────────────────────────────────────────────────────────
$(STAMP_DIR):
\t@mkdir -p $@

# ── One-time setup ───────────────────────────────────────────────────────────
setup: | $(STAMP_DIR)
\tgit submodule update --init --recursive
\tbash $(SUBMODULE)/setup.sh
\t@sha256sum $(SUBMODULE)/setup.sh | cut -d' ' -f1 > $(SETUP_STAMP)
# Runtime (not parse-time) check, evaluated entirely inside this shell
# command: GNU Make expands a rule's whole recipe — including any
# $(wildcard ...)/$(shell ...) calls hiding inside TFVARS_BACKEND/
# TFVARS_BUCKET — before running the first line of that recipe, so a
# make-variable-based check here would still see the filesystem from before
# setup.sh (above) ran, even though it's written later in the recipe text.
# Mirror TFVARS_BACKEND's own GSD_TFVARS_BACKEND override semantics by hand,
# and defer both the marker-file test and its \`cat\` to the shell so they
# see whatever setup.sh just wrote.
\t@if [ "$\${GSD_TFVARS_BACKEND:-}" = s3 ] || { [ "$\${GSD_TFVARS_BACKEND:-}" != local ] && [ -f $(TFVARS_MARKER) ]; }; then \\
\t  bucket="$\${GSD_TFVARS_BUCKET:-$$(cat $(TFVARS_MARKER) 2>/dev/null)}"; \\
\t  if [ -n "$$(git -C $(REPO_ROOT) status --porcelain -- $(TFVARS))" ]; then echo "$(TFVARS) has uncommitted changes — skipping S3 pull to avoid clobbering them (commit or stash them, then run 'make tfvars-pull')." >&2; \\
\t  else \\
\t    echo "S3 tfvars backend detected (s3://$$bucket) — pulling terraform.tfvars..."; \\
\t    if pull_out=$$($(TFVARS_SYNC) pull $(TFVARS_SYNC_ARGS) 2>&1); then \\
\t      echo "$$pull_out"; \\
\t    elif echo "$$pull_out" | grep -qi 'NoSuchKey\\|specified key does not exist'; then \\
\t      echo "no tfvars object found in s3://$$bucket yet — run 'make tfvars-push' to seed the bucket" >&2; \\
\t    else \\
\t      echo "$$pull_out" >&2; \\
\t      echo "tfvars pull failed — aborting setup; check credentials/network, then run 'make tfvars-pull' once resolved" >&2; \\
\t      exit 1; \\
\t    fi; \\
\t  fi; \\
\t fi

# ── Copy tfvars into the submodule terraform dir ─────────────────────────────
$(TF_DIR)/terraform.tfvars: $(TFVARS)
\tcp $(TFVARS) $@

# Force a fresh copy on every plan/apply so stale vars can't slip through.
copy-tfvars: $(TFVARS)
\tcp $(TFVARS) $(TF_DIR)/terraform.tfvars

# ── Terraform targets ────────────────────────────────────────────────────────
# Internal gates: silently no-op in local mode (TFVARS_BACKEND=local) so
# plan/apply behave exactly as they did before S3 sync existed.
# pull-tfvars-if-needed guards against clobbering uncommitted local edits the
# same way the manual tfvars-pull target does below: a pull overwrites
# $(TFVARS) in place, so if git sees it as dirty we abort instead of silently
# discarding the operator's changes (NO_PULL=1 still skips the pull entirely).
pull-tfvars-if-needed:
\t@if [ "$(TFVARS_BACKEND)" = s3 ] && [ -z "$\${NO_PULL:-}" ]; then \\
\t  if [ -n "$$(git -C $(REPO_ROOT) status --porcelain -- $(TFVARS))" ]; then echo "$(TFVARS) has uncommitted changes — commit or stash them before pulling from S3 (or rerun with NO_PULL=1)." >&2; exit 1; fi; \\
\t  $(TFVARS_SYNC) pull $(TFVARS_SYNC_ARGS); \\
\t fi

check-tfvars-if-needed:
\t@if [ "$(TFVARS_BACKEND)" = s3 ] && [ -z "$\${FORCE_APPLY:-}" ]; then $(TFVARS_SYNC) check $(TFVARS_SYNC_ARGS); fi

# plan auto-pulls the latest tfvars from S3 first (skip with NO_PULL=1), so a
# stale local copy can't silently drive \`terraform plan\`. In local mode
# pull-tfvars-if-needed is a no-op and this is unchanged from before.
plan: pull-tfvars-if-needed copy-tfvars
\t$(MAKE) -C $(SUBMODULE) tf-plan

# apply checks tfvars are still in sync with S3 first (skip with
# FORCE_APPLY=1), so drift can't silently drive \`terraform apply\`. In local
# mode check-tfvars-if-needed is a no-op and this is unchanged from before.
apply: check-tfvars-if-needed copy-tfvars
\t$(MAKE) -C $(SUBMODULE) tf-apply

# ── Manual remote tfvars sync (gated on TFVARS_BACKEND) ─────────────────────
# Unlike the internal gates above, these fail fast with a pointer to
# configure a backend instead of silently no-opping — they're operator-driven.
# tfvars-pull additionally refuses to clobber uncommitted local edits: a pull
# overwrites $(TFVARS) in place, so if git sees it as dirty we abort instead
# of silently discarding the operator's changes.
tfvars-pull:
\t@if [ "$(TFVARS_BACKEND)" != s3 ]; then echo "No S3 tfvars backend detected (TFVARS_BACKEND=$(TFVARS_BACKEND)) — set GSD_TFVARS_BACKEND=s3 (with GSD_TFVARS_BUCKET) or bootstrap one via setup.sh." >&2; exit 1; fi
\t@if [ -n "$$(git -C $(REPO_ROOT) status --porcelain -- $(TFVARS))" ]; then echo "$(TFVARS) has uncommitted changes — commit or stash them before pulling from S3." >&2; exit 1; fi
\t$(TFVARS_SYNC) pull $(TFVARS_SYNC_ARGS)

tfvars-push:
\t@if [ "$(TFVARS_BACKEND)" != s3 ]; then echo "No S3 tfvars backend detected (TFVARS_BACKEND=$(TFVARS_BACKEND)) — set GSD_TFVARS_BACKEND=s3 (with GSD_TFVARS_BUCKET) or bootstrap one via setup.sh." >&2; exit 1; fi
\t$(TFVARS_SYNC) push $(TFVARS_SYNC_ARGS)

tfvars-diff:
\t@if [ "$(TFVARS_BACKEND)" != s3 ]; then echo "No S3 tfvars backend detected (TFVARS_BACKEND=$(TFVARS_BACKEND)) — set GSD_TFVARS_BACKEND=s3 (with GSD_TFVARS_BUCKET) or bootstrap one via setup.sh." >&2; exit 1; fi
\t$(TFVARS_SYNC) diff $(TFVARS_SYNC_ARGS)

# ── Submodule update with idempotent setup.sh re-run ─────────────────────────
update: | $(STAMP_DIR)
\tgit submodule update --remote --merge $(SUBMODULE)
\t@CURRENT=$$(sha256sum $(SUBMODULE)/setup.sh | cut -d' ' -f1); \\
\t PREVIOUS=$$(cat $(SETUP_STAMP) 2>/dev/null || echo ""); \\
\t if [ "$$CURRENT" != "$$PREVIOUS" ]; then \\
\t   echo "setup.sh changed — clearing .terraform/ and rerunning..."; \\
\t   rm -rf $(TF_DIR)/.terraform; \\
\t   bash $(SUBMODULE)/setup.sh; \\
\t   echo "$$CURRENT" > $(SETUP_STAMP); \\
\t else \\
\t   echo "setup.sh unchanged — skipping."; \\
\t fi
\t@echo ""
\t@echo "Submodule updated. Commit the new pointer when ready:"
\t@echo "  git add ${a.submoduleDir} && git commit -m 'chore: bump ${a.submoduleDir}'"

# ── Dev server ───────────────────────────────────────────────────────────────
# Pull live tfstate into a temp file and point ConfigService at it via
# TF_STATE_PATH; falls back to null when the backend isn't reachable yet
# (e.g. before the first apply).
dev: | $(STAMP_DIR)
\tterraform -chdir=$(TF_DIR) state pull > $(STAMP_DIR)/tfstate.json 2>/dev/null || echo 'null' > $(STAMP_DIR)/tfstate.json
\trm -f $(SUBMODULE)/app/packages/*/tsconfig*.tsbuildinfo
\tTF_STATE_PATH=$(STAMP_DIR)/tfstate.json $(MAKE) -C $(SUBMODULE) dev
`;
}

/**
 * Skeleton tfvars derived from the public terraform.tfvars.example shape. We
 * fill in the few things we just asked the user about and leave the rest as
 * commented examples.
 */
export function renderTfvars(a: Answers): string {
  const discordBlock =
    a.configureDiscord && a.discordApplicationId && a.discordBotToken && a.discordPublicKey
      ? `discord_application_id = "${a.discordApplicationId}"
discord_bot_token      = "${a.discordBotToken}"
discord_public_key     = "${a.discordPublicKey}"
`
      : `# discord_application_id = "1234567890"
# discord_bot_token      = "MTIz...xyz"
# discord_public_key     = "0123abc..."
`;

  return `# ${a.projectName} — Terraform variables.
# Commit this file to your private parent repo. The wrapper Makefile copies it
# into ${a.submoduleDir}/terraform/terraform.tfvars on every plan/apply, where
# the submodule's own .gitignore prevents it from being committed back.

aws_region   = "${a.awsRegion}"
project_name = "${a.projectName}"

# Hosted zone in Route 53. {game}.${a.hostedZone} records are managed by Lambda.
hosted_zone_name = "${a.hostedZone}"

# Watchdog: auto-shuts down idle servers after (interval × idle_checks) minutes.
watchdog_interval_minutes = 15
watchdog_idle_checks      = 4
watchdog_min_packets      = 100

# acm_certificate_domain = "*.${a.hostedZone}"

# Discord bot credentials (optional — leave commented out to configure via the web UI).
${discordBlock}
# base_allowed_guilds  = ["123456789012345678"]
# base_admin_user_ids  = ["987654321098765432"]
# base_admin_role_ids  = []

# Game server definitions. See ${a.submoduleDir}/terraform/terraform.tfvars.example
# for the full schema.
game_servers = {
  # palworld = {
  #   image  = "thijsvanloef/palworld-server-docker:latest"
  #   cpu    = 2048
  #   memory = 8192
  #   ports = [
  #     { container = 8211,  protocol = "udp" },
  #     { container = 27015, protocol = "udp" },
  #   ]
  #   environment = [
  #     { name = "PLAYERS",     value = "8" },
  #     { name = "SERVER_NAME", value = "My Palworld Server" },
  #   ]
  #   volumes = [
  #     { name = "saves", container_path = "/palworld" },
  #   ]
  #   https = false
  # }
}
`;
}

export function renderEnv(a: Answers): string {
  return `# Bearer token for the management app (also used by docker compose).
# This file is gitignored — never commit it. Rotate by deleting and re-running
# \`init-parent.ts\` (or just generate a new hex string).
API_TOKEN=${a.apiToken}
`;
}

export function renderGitignore(a: Answers): string {
  return `# ${a.projectName} — parent repo .gitignore

# Bearer token + any local environment overrides
.env
.env.*
!.env.example

# Make stamp dir (sha256 of submodule's setup.sh, cached tfstate.json, ...)
.make/

# Terraform local state, if you ever fall off the S3 backend
terraform.tfstate
terraform.tfstate.backup
*.tfvars.local

# tfvars-sync.ts sidecar lock file (S3 version/etag metadata, not a secret,
# but machine-local and irrelevant to commit)
*.tfvars.lock

# Editor / OS noise
.DS_Store
.vscode/
.idea/
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// IO helpers
// ─────────────────────────────────────────────────────────────────────────────

function writeIfSafe(path: string, contents: string): 'wrote' | 'skipped' | 'overwrote' {
  if (existsSync(path) && !FORCE) {
    return 'skipped';
  }
  const existed = existsSync(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return existed ? 'overwrote' : 'wrote';
}

function status(path: string, action: 'wrote' | 'skipped' | 'overwrote', parentDir: string): void {
  const rel = relative(parentDir, path) || path;
  const tag =
    action === 'wrote'
      ? '  +'
      : action === 'overwrote'
        ? '  ~'
        : '  ·';
  const note = action === 'skipped' ? '  (exists — use --force to overwrite)' : '';
  output.write(`${tag} ${rel}${note}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

function isValidProjectName(s: string): boolean {
  // Used as part of S3 bucket names by setup.sh — keep it conservative.
  return /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(s);
}

function isValidRegion(s: string): boolean {
  return /^[a-z]{2,3}-[a-z]+-\d$/.test(s);
}

function isValidDomain(s: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap (the pre-existing interactive flow, unchanged)
// ─────────────────────────────────────────────────────────────────────────────

/** The interactive bootstrap flow: prompts for parent-repo details and writes Makefile/terraform.tfvars/.env/.gitignore. Exported so the entrypoint guard below can invoke it after CLI parsing. */
export async function runBootstrap(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const guessedParent = findParentRepoRoot(cwd()) ?? findParentRepoRoot(scriptDir) ?? cwd();

  output.write('\n');
  output.write('  Hyveon — submodule deployment scaffolder\n');
  output.write('  ────────────────────────────────────────────────────\n');
  output.write('\n');
  output.write(`  Parent repo:  ${guessedParent}\n`);
  output.write(`  Script:       ${relative(guessedParent, fileURLToPath(import.meta.url)) || fileURLToPath(import.meta.url)}\n`);
  output.write('\n');
  output.write('  This will write Makefile, terraform.tfvars, .env, and .gitignore in\n');
  output.write('  the parent repo. Existing files are skipped unless you pass --force.\n');
  output.write('\n');

  const rl = createInterface({ input, output });
  try {
    const parentDir = await ask(rl, 'Parent repo path', guessedParent);

    if (!existsSync(parentDir) || !statSync(parentDir).isDirectory()) {
      output.write(`\n  ✗ ${parentDir} is not a directory.\n`);
      exit(1);
    }

    const submoduleDir = await ask(
      rl,
      'Submodule path (relative to parent repo)',
      detectSubmodulePath(parentDir, scriptDir),
    );
    const submoduleName = submoduleDir.split('/').pop() || 'Hyveon';

    let projectName = '';
    while (!isValidProjectName(projectName)) {
      projectName = await askRequired(rl, 'Project name (S3 bucket prefix; lowercase, dashes ok)', 'game-servers');
      if (!isValidProjectName(projectName)) output.write('  ↳ must be 3–32 chars, lowercase letters/numbers/dashes.\n');
    }

    let awsRegion = '';
    while (!isValidRegion(awsRegion)) {
      awsRegion = await askRequired(rl, 'AWS region', 'us-east-1');
      if (!isValidRegion(awsRegion)) output.write('  ↳ must look like "us-east-1".\n');
    }

    let hostedZone = '';
    while (!isValidDomain(hostedZone)) {
      hostedZone = await askRequired(rl, 'Route 53 hosted zone (e.g. example.com)');
      if (!isValidDomain(hostedZone)) output.write('  ↳ must be a valid domain.\n');
    }

    const generated = randomBytes(32).toString('hex');
    const apiTokenChoice = await ask(rl, 'API_TOKEN for the management app (press Enter to generate)', generated);
    const apiToken = apiTokenChoice || generated;

    const configureDiscord = await askBool(rl, 'Seed Discord credentials in tfvars now?', false);

    let discordApplicationId: string | undefined;
    let discordBotToken: string | undefined;
    let discordPublicKey: string | undefined;
    if (configureDiscord) {
      discordApplicationId = await askRequired(rl, '  Discord Application ID');
      discordBotToken = await askRequired(rl, '  Discord Bot Token');
      discordPublicKey = await askRequired(rl, '  Discord Public Key');
    }

    const answers: Answers = {
      parentDir,
      submoduleDir,
      submoduleName,
      projectName,
      awsRegion,
      hostedZone,
      apiToken,
      configureDiscord,
      discordApplicationId,
      discordBotToken,
      discordPublicKey,
    };

    output.write('\n  Writing files…\n');
    status(join(parentDir, 'Makefile'), writeIfSafe(join(parentDir, 'Makefile'), renderMakefile(answers)), parentDir);
    status(join(parentDir, 'terraform.tfvars'), writeIfSafe(join(parentDir, 'terraform.tfvars'), renderTfvars(answers)), parentDir);
    status(join(parentDir, '.env'), writeIfSafe(join(parentDir, '.env'), renderEnv(answers)), parentDir);
    status(join(parentDir, '.gitignore'), writeIfSafe(join(parentDir, '.gitignore'), renderGitignore(answers)), parentDir);

    output.write('\n  ✓ Done.\n\n');
    output.write('  Next steps:\n');
    output.write(`    1. Review terraform.tfvars and add at least one entry under game_servers.\n`);
    output.write(`    2. Run \`make setup\` to bootstrap the submodule and Terraform.\n`);
    output.write(`    3. Run \`make plan\` then \`make apply\`.\n`);
    output.write(`    4. \`make dev\` to launch the management app on :5173.\n\n`);

    if (existsSync(join(parentDir, '.gitmodules'))) {
      const gm = readFileSync(join(parentDir, '.gitmodules'), 'utf8');
      if (!gm.includes(submoduleDir)) {
        output.write(`  Note: ${submoduleDir} is not in .gitmodules. Add it with:\n`);
        output.write(`    git submodule add https://github.com/CoderCoco/Hyveon.git ${submoduleDir}\n\n`);
      }
    } else {
      output.write(`  Note: no .gitmodules found. Add the submodule with:\n`);
      output.write(`    git submodule add https://github.com/CoderCoco/Hyveon.git ${submoduleDir}\n\n`);
    }
  } finally {
    rl.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Migrate (dispatch only — the migration itself lands in a follow-up task)
// ─────────────────────────────────────────────────────────────────────────────

/** Runs the `migrate` subcommand for an already-validated `direction`. Migration itself lands in a follow-up task, so this only wires up dispatch: it prints a "not implemented yet" message and exits non-zero. */
export function runMigrate(direction: MigrateDirection): void {
  process.stderr.write(`\n  ✗ migrate --${direction} is not implemented yet.\n`);
  exit(1);
}

// Only run when this file is the entry point — keeps the renderers importable
// from tests without auto-launching the prompt loop. Compare normalized
// absolute paths so relative invocations (e.g. `tsx init-parent.ts`) still
// match.
const isEntrypoint =
  argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(argv[1]);

if (isEntrypoint) {
  let CLI: CliArgs;
  try {
    CLI = parseCliArgs(argv.slice(2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\n  ✗ ${message}\n\n${USAGE}`);
    exit(1);
  }

  if (CLI.command === 'migrate') {
    // parseCliArgs guarantees exactly one of --to-s3 | --to-local by the time
    // command === 'migrate' is returned, so direction is always defined here.
    runMigrate(CLI.direction as MigrateDirection);
  } else {
    FORCE = CLI.force;
    runBootstrap().catch((err) => {
      process.stderr.write(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
      exit(1);
    });
  }
}
