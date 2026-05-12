# Hyveon

A cost-efficient multi-game dedicated server platform on **AWS Fargate** with a
local management UI and a fully serverless Discord bot. Servers only run — and
only cost money — while someone is playing.

> 📚 Full documentation lives at **[codercoco.github.io/Hyveon](https://codercoco.github.io/Hyveon/)**
> (built from [`docs/`](./docs) by GitHub Pages). The rest of this README is a
> quick tour; deep-dives, setup steps, and architecture diagrams are on the
> site.

## What you get

- **AWS Fargate** — runs game server containers on-demand via `RunTask` (no
  persistent ECS Service, no idle costs).
- **EFS** — persists world saves across server restarts, one access point
  per game.
- **Route 53** — a Lambda auto-UPSERTs `{game}.yourdomain.com` on task start
  and DELETEs it on stop.
- **Optional ALB + ACM** — for any game marked `https = true`, traffic goes
  through a load balancer with TLS termination.
- **Watchdog Lambda** — automatically shuts down idle servers based on
  `NetworkPacketsIn`.
- **Terraform** — provisions every AWS resource.
- **Nest.js + React management app** — local dashboard to start/stop servers,
  edit config, monitor costs, stream logs, and manage Discord credentials.
- **Serverless Discord bot** — two Node.js Lambdas + DynamoDB + Secrets
  Manager serve Discord HTTP interactions. Permitted Discord users/roles
  can `/server-start`, `/server-stop`, `/server-status`, and `/server-list`
  from chat without any 24/7 process running.

## Documentation

The [docs site](https://codercoco.github.io/Hyveon/) is
organised around three roles. Pick the one that matches what you need to do.

| Guide | You are… |
|---|---|
| [**Setup guide**](https://codercoco.github.io/Hyveon/setup/) | Going from a blank AWS account to a running Fargate task. |
| [**User guide**](https://codercoco.github.io/Hyveon/guides/user/) | Driving an already-provisioned deployment — the dashboard, Discord commands, day-to-day ops. |
| [**Maintainer guide**](https://codercoco.github.io/Hyveon/guides/maintainer/) | Working on this codebase. |
| [**Private parent + submodule guide**](https://codercoco.github.io/Hyveon/guides/submodule/) | Wrapping this repo in a private repo that holds `terraform.tfvars` and tfstate. Includes an interactive scaffolder ([`scripts/init-parent.ts`](./scripts/init-parent.ts)) that generates the wrapper Makefile, tfvars, and `.env`. |

Component deep-dives:

- [**Architecture**](https://codercoco.github.io/Hyveon/architecture/) — full diagram + `/server-start` sequence.
- [**Terraform**](https://codercoco.github.io/Hyveon/components/terraform/) — every `.tf` file, variables, outputs, gotchas.
- [**Management app**](https://codercoco.github.io/Hyveon/components/management-app/) — Nest.js API, React dashboard, `@hyveon/shared`.
- [**Lambdas**](https://codercoco.github.io/Hyveon/components/lambdas/) — interactions, followup, update-dns, watchdog.

## Quick start

```bash
# 1. First-time bootstrap (installs node/terraform/aws CLI on Debian/Ubuntu,
#    npm-installs all workspaces, builds Lambda bundles, runs terraform init)
chmod +x setup.sh && ./setup.sh

# 2. Configure
$EDITOR terraform/terraform.tfvars        # game_servers, hosted_zone_name, ...

# 3. Deploy infra
cd terraform && terraform apply

# 4a. Run the management app in dev mode
cd .. && npm run app:dev
#     http://localhost:5173  (Nest on :3001, Vite proxy)

# 4b. …or in Docker (production mode — requires a bearer token)
cd ..
touch app/server_config.json
export API_TOKEN="$(openssl rand -hex 32)"
docker compose up --build
#     http://localhost:5000  (dashboard prompts for $API_TOKEN)
```

See the [setup guide](https://codercoco.github.io/Hyveon/setup/)
for the full walkthrough, including the IAM policy, Discord bot setup, and
troubleshooting.

## Configuration at a glance

Edit `terraform/terraform.tfvars`. The `game_servers` map is the single
source of truth — task definitions, EFS access points, DNS, watchdog config,
and Discord command autocomplete all derive from it.

```hcl
aws_region       = "us-east-1"
project_name     = "game-servers"
hosted_zone_name = "yourdomain.com"   # must exist in Route 53

game_servers = {
  palworld = {
    image  = "thijsvanloef/palworld-server-docker:latest"
    cpu    = 2048
    memory = 8192
    ports = [
      { container = 8211,  protocol = "udp" },
      { container = 27015, protocol = "udp" },
    ]
    environment = [
      { name = "PLAYERS",     value = "8" },
      { name = "SERVER_NAME", value = "My Palworld Server" },
    ]
    efs_path = "/palworld"
    https    = false
  }
}
```

Cost ballpark: **Fargate 2 vCPU / 8 GB ≈ $0.12/hr** while running; EFS is
pennies/month. Playing 4 hours/day, 5 days/week ≈ **$10–12/month**, vs.
~$60/month for a 24/7 t3.large.

## Repository structure

```text
Hyveon/
├── app/                       # Nest.js + React monorepo (npm workspaces)
│   └── packages/
│       ├── shared/            # @hyveon/shared
│       ├── desktop-main/      # @hyveon/desktop-main (Nest.js API)
│       ├── web/               # @hyveon/web   (React + Vite)
│       └── lambda/
│           ├── interactions/  # Discord Function URL entry point
│           ├── followup/      # Async ECS work + Discord PATCH
│           ├── update-dns/    # Route 53 + ALB on task state change
│           └── watchdog/      # Idle detection + auto-stop
├── terraform/                 # All AWS infra (VPC, ECS, EFS, 4 Lambdas, DDB…)
├── docs/                      # Documentation site (published via GH Pages)
├── Dockerfile
├── docker-compose.yml
├── setup.sh                   # First-time bootstrap (node/terraform/aws)
├── scripts/                   # Helper scripts (init-parent.ts scaffolder)
├── CLAUDE.md                  # Project instructions + invariants
├── CONTRIBUTING.md            # PR conventions, local checks
└── README.md                  # this file
```

## Tearing it down

Stop every server from the dashboard first (so the update-dns Lambda cleans
its records), then:

```bash
cd terraform && terraform destroy
```

The two Discord Secrets Manager secrets use `recovery_window_in_days = 0`,
so they are deleted immediately and a later `apply` is clean.

## License

See [LICENSE](./LICENSE).
