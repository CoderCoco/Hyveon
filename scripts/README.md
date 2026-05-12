# scripts/

Helper scripts for `Hyveon`. These are intentionally **not** part
of the `app/` workspace — they exist to be run from a *parent* repo that
vendors `Hyveon` as a git submodule, before any of the app's
dependencies have been installed.

## `init-parent.ts`

Interactive scaffolder for the [private parent + submodule deployment
pattern](https://codercoco.github.io/Hyveon/guides/submodule/). It
generates a `Makefile`, `terraform.tfvars`, `.env`, and `.gitignore` in your
parent repo, all wired to the wrapper Make targets (`setup`, `plan`, `apply`,
`update`, `dev`) so you can drive the whole stack from the parent repo root.

### Usage

From the parent (private) repo root, after adding the submodule:

```bash
git submodule add https://github.com/CoderCoco/Hyveon.git
(cd Hyveon/scripts && npm install)
node --import tsx Hyveon/scripts/init-parent.ts
# or, equivalently:
npx --prefix Hyveon/scripts tsx Hyveon/scripts/init-parent.ts
```

Flags:

- `--force` — overwrite existing files instead of skipping them.

The script never reads or modifies anything inside the submodule. Safe to
re-run; without `--force` it leaves existing files alone.

### Requirements

- Node.js 20+ (the same minimum the rest of the project enforces).
- `git` on `$PATH` (used to detect `.gitmodules`).

Windows users should run this under WSL or Git Bash — the generated
`Makefile` uses `bash`, `sha256sum`, and `cp`, which mirrors the upstream
Makefile's shell expectations.
