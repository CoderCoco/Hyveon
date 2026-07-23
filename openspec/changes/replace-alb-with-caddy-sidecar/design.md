# Design — replace-alb-with-caddy-sidecar

## Context

HTTPS games (`https = true` in the `game_servers` map — currently `foundry`) route through an always-on ALB defined in `terraform/aws/alb.tf`: ACM wildcard cert, ALB + two listeners, one target group + listener rule per HTTPS game, a dedicated ALB security group, and static Route 53 alias records. The `update-dns` Lambda registers/deregisters task private IPs as ALB targets instead of managing A records, and the `watchdog` Lambda deregisters targets before stopping idle tasks; both receive `HTTPS_GAMES` and `ALB_TARGET_GROUPS` env vars from Terraform.

The ALB bills hourly regardless of use (~$16.4/mo since foundry flipped `https = true`) and is the sole violation of the project's scale-to-zero principle. Everything else in the stack — on-demand `RunTask` Fargate tasks, Lambda-managed DNS, watchdog auto-stop — idles at pennies.

Constraints that shape this design:

- **`game_servers` is the single source of truth.** Adding a game (or flipping `https`) must cascade through `for_each` — no hand-written per-game resources.
- **DNS is Lambda-managed.** `update-dns` fires on ECS Task State Change and UPSERTs/DELETEs `{game}.{zone}` A records. The sidecar shares the task's awsvpc ENI, so the task's single public IP serves both the game port and 443 — the existing record mechanism works unchanged for HTTPS games once the static-alias special case is removed.
- **No persistent ECS Service.** Tasks cold-start on demand; DNS for a task exists only after the RUNNING event fires and the Lambda UPSERTs (TTL 30 s). ACME issuance must tolerate the window where the domain does not yet resolve to the new task.
- **Watchdog reads `NetworkPacketsIn` on the task ENI.** The sidecar shares that ENI, so any traffic it attracts (ACME, scanners on 80/443) counts toward idle detection.
- **The `GameServerDeployAll` IAM policy in `docs/docs/setup.md` is the single source of truth** for deploy permissions.

## Goals / Non-Goals

**Goals:**

- Zero ELB/ACM resources in the stack; idle HTTPS cost = $0.
- Valid HTTPS at `https://{game}.{zone}` within ~2 minutes of task RUNNING (first boot may take slightly longer for initial ACME issuance).
- Cert issuance is a rare event: certs persist on EFS across restarts, keeping usage far below Let's Encrypt rate limits.
- Everything cascades from the `game_servers` map — flipping `https = true` on any game is the only edit an operator makes.
- `update-dns` and `watchdog` end up with a single, uniform code path (no target-group branches).

**Non-Goals:**

- No DNS-01 / Route 53 ACME challenge in the primary design (documented fallback only — it needs a custom xcaddy image, an ECR repo, a build pipeline, and task-role IAM).
- No custom Caddy image, ECR repository, or image build pipeline.
- No changes to the watchdog algorithm or thresholds (assessed below; tuning stays a follow-up if real-world data demands it).
- No health-checking / auto-restart of the sidecar beyond ECS essential-container semantics (there is no Service to replace tasks).
- No new Terraform variables (ACME contact email, Caddy image tag overrides, etc. stay out unless implementation proves them necessary).

## Decisions

### D1: Caddy sidecar in the same Fargate task, official image, CLI-driven config

Each `https = true` game's `aws_ecs_task_definition.game` gains a second container:

- `image`: official `caddy` (pinned to a `2.x` tag, e.g. `caddy:2-alpine`, chosen at implementation time — never `latest`).
- `portMappings`: 443/tcp and 80/tcp.
- `command`: `caddy reverse-proxy --from {game}.{hosted_zone_name} --to localhost:{ports[0].container}` — the `--from` domain activates Caddy's automatic HTTPS (cert issuance, HTTP→HTTPS redirect on 80, HTTP-01 + TLS-ALPN-01 challenge handling) with zero config files. WebSockets are proxied natively (Foundry needs them).
- `logConfiguration`: same `/ecs/{game}-server` log group, `awslogs-stream-prefix = "caddy"` so game and proxy logs are distinguishable.
- The game container's `portMappings` are unchanged; in awsvpc mode both containers share `localhost`, so the proxy reaches the game without any inter-container networking config.

The container list is built conditionally inside the existing `for_each` (`concat`/conditional in `jsonencode`) — the map stays the single source of truth.

**Alternatives considered:**

- *Caddyfile via EFS or env-templated config*: more expressive but adds a config-distribution problem (seeding files, escaping JSON). The one-liner `reverse-proxy` subcommand covers the entire requirement.
- *nginx + certbot*: two processes, cron-driven renewal, manual cert paths — strictly worse operationally.
- *Traefik*: heavier, config-discovery machinery useless without a Service/orchestrator integration.
- *Keep ALB but delete/recreate around task lifecycle*: ALB provisioning takes minutes and Terraform-managed lifecycle churn fights the scale-to-zero event flow; rejected.

### D2: HTTP-01 / TLS-ALPN-01 challenges, not DNS-01

The official image supports HTTP-01 and TLS-ALPN-01 out of the box; both validate over the task's public IP once DNS resolves. DNS-01 would decouple issuance from DNS propagation but requires the `caddy-dns/route53` plugin (custom xcaddy build → ECR repo + pipeline) and `route53:ChangeResourceRecordSets` on the task role — a large operational surface for a timing problem that Caddy's issuance retry loop already absorbs (see R1). DNS-01 remains the documented fallback if HTTP-01 proves flaky in practice.

### D3: Cert persistence — dedicated `{game}-certs` EFS access point mounted at `/data`

A new `aws_efs_access_point.caddy_data` with `for_each = local.https_games`, root directory `/{game}/caddy-data`, same posix profile as the game access points (uid/gid 1000 — access points enforce the posix identity for all NFS ops regardless of the container user, so the root-running caddy image works unchanged). The task definition gains a corresponding volume + a `/data` mount on the sidecar only (`/data` is the image's `XDG_DATA_HOME`, where Caddy stores certs and ACME account keys).

**Why not fold into `local.game_volumes`?** That local is derived from operator-declared `volumes` in tfvars; injecting a synthetic entry would leak an implementation detail into the operator contract and complicate the volume validation rule. A separate resource keyed off `local.https_games` still cascades purely from the map.

**Why persist at all?** Without it every task start is a fresh ACME order — Let's Encrypt allows only 5 duplicate certs per week, which a frequently-restarted game would exhaust. With persistence, issuance happens once per game (plus renewals), and the ACME account key is reused.

### D4: Sidecar is `essential = true`

If Caddy dies, the game is unreachable anyway (its raw port no longer has public ingress — D6). Marking the sidecar essential makes ECS stop the whole task on proxy death, which flows into the normal STOPPED → DNS-delete cleanup instead of leaving a billing, unreachable zombie task. `essential = false` was rejected for exactly that zombie scenario. No `dependsOn` ordering is needed: Caddy retries upstream connections, so it can start before the game is listening.

### D5: HTTPS games return to the plain Lambda A-record path

Delete `aws_route53_record.https_game` (static aliases) and the `handleHttps` branch in `update-dns`: all games flow through the existing `handleDirect` (UPSERT public-IP A record on RUNNING, DELETE on STOPPED). The Discord pending-interaction notification for HTTPS games now resolves the public IP like any other game (the current code deliberately omits it because the entry point was the ALB hostname). `watchdog` loses its pre-stop ALB deregistration. Both Lambdas' `HTTPS_GAMES` / `ALB_TARGET_GROUPS` env vars and the `elasticloadbalancing:*` statements in their IAM role policies are removed.

Sequencing note: both Lambdas default the env vars to empty (`?? '{}'` / empty string), so Terraform can drop the env vars before the dead code is deleted — the deployed handlers simply route every game down the direct path. This is what enables the two-PR split (D8).

### D6: Security-group rework — 443/80 public for HTTPS games, raw port closed

In `terraform/aws/main.tf` locals:

- `direct_game_ports` (non-HTTPS, open to 0.0.0.0/0): unchanged.
- `https_game_ports` (currently ALB-SG-scoped): replaced by two static public ingress rules on 443/tcp and 80/tcp, created only when `length(local.https_games) > 0`. Port 80 must stay open — it serves the HTTP-01 challenge and the HTTP→HTTPS redirect.
- HTTPS games' raw container ports get **no** ingress rule at all: the only consumer is the sidecar via localhost, which never traverses the SG.

The `aws_security_group.game_servers` reference to `aws_security_group.alb[0].id` disappears in the same apply that destroys the ALB SG; Terraform orders the in-place SG update before the dependent destroy (see R5).

### D7: Variable, output, and type cleanup

- `acm_certificate_domain` is removed following the repo's five-point Terraform-variable checklist (root `variables.tf`, `aws/variables.tf`, `main.tf` pass-through, `terraform.tfvars.example`, `docs/docs/components/terraform.md` table, plus any `docs/docs/setup.md` mentions) — all in the same commit.
- `alb_dns_name` / `acm_certificate_arn` outputs go from both `terraform/aws/outputs.tf` and root `terraform/outputs.tf`; the matching fields go from `TfOutputs` in `ConfigService.ts` (lines declaring/parsing them) and from the preload `gsd-api.ts` mirror type, with tests and the e2e `tfstate.fixture.json` updated to match.

### D8: Two PRs, terraform-first

- **PR 1 — `feat(terraform): replace ALB with in-task Caddy TLS sidecar`** (Part of #292): sidecar + EFS access points + SG rework + full ALB/ACM deletion + Lambda env/IAM trim + variable-checklist docs. Deployed Lambdas tolerate the missing env vars (D5), so nothing breaks between PRs.
- **PR 2 — `refactor: remove ALB code paths and outputs after sidecar cutover`** (Closes #292): dead-code removal in both Lambdas + tests, `TfOutputs`/`gsd-api` cleanup, IAM deploy-policy trim in `docs/docs/setup.md`, CLAUDE.md architecture note.

The IAM deploy-policy trim (`elasticloadbalancing:*`, `acm:*`) **must not ship in PR 1**: the `terraform apply` that destroys the ALB stack itself needs those actions. It lands in PR 2, gated on the destroy apply having run.

## Risks / Trade-offs

- **[R1] ACME cold-start race** — on first HTTPS boot, Caddy starts issuing before the `{game}.{zone}` record exists (the Lambda UPSERTs only once the task reports RUNNING; TTL 30 s plus resolver propagation). Initial validations will fail. → Caddy retries issuance with exponential backoff and its retry schedule stays under Let's Encrypt's 5-failed-validations/account/hostname/hour limit; issuance completes within minutes of DNS propagating. EFS persistence (D3) makes this a once-per-game event, and Caddy falls back to its secondary CA (ZeroSSL) if Let's Encrypt is persistently unreachable. Residual risk accepted; DNS-01 fallback (D2) documented if reality disagrees.
- **[R2] Let's Encrypt rate limits** — 5 duplicate certs/week, 50 certs/domain/week. → Certs + ACME account key persist on EFS; only a deliberate wipe of the `{game}-certs` access point or `/data` contents restarts issuance. Migration/testing should avoid deleting the access point once certs are issued.
- **[R3] Expired-cert cold start** — renewals only run while the task is up (no persistent process); a game idle for >90 days boots with an expired cert and must reissue, re-entering the R1 window. → Same retry path handles it; frequency is bounded by actual usage patterns and stays trivially within rate limits. Accepted.
- **[R4] Watchdog false-activity from ports 80/443** — internet scanner background noise on two publicly-open web ports lands on the same ENI the watchdog samples (`NetworkPacketsIn`), potentially keeping an idle server above `watchdog_min_packets` (default 100/15 min). Caddy's own background traffic (OCSP, renewal checks) is negligible inbound. → Ship with current thresholds; the exposure is comparable to today's raw-game-port exposure for non-HTTPS games. If foundry stops auto-idling in practice, raise `watchdog_min_packets` (existing variable — no schema change). Monitored, not pre-tuned.
- **[R5] SG dependency ordering at destroy** — `aws_security_group.game_servers` currently holds ingress rules referencing the ALB SG; both change in one apply. → Terraform resolves this (in-place ingress update precedes ALB SG destroy). If AWS still reports `DependencyViolation`, a targeted two-step apply (`-target=aws_security_group.game_servers`, then full) is the documented recovery; no config change needed.
- **[R6] HTTPS downtime during migration** — the apply deletes the static alias record and the ALB while producing a new task-definition revision; a task already running keeps using the old revision with no ALB in front of it. → Migration plan requires the HTTPS game be stopped during the cutover apply (or restarted immediately after). Acceptable for a personal-scale stack; called out in the PR body.
- **[R7] Essential sidecar takes the game down with it** — a Caddy crash stops the whole task mid-session. → Caddy is extremely stable as a static-config reverse proxy; the alternative (zombie unreachable-but-billing task) is strictly worse (D4). Sidecar logs stream to the game's CloudWatch group (`caddy` prefix) for post-mortems.
- **[R8] Sidecar resource contention** — Caddy shares the task's existing CPU/memory allocation; no per-container limits are set. → Caddy idles at a few MB and proxies at line rate with negligible CPU for one game's traffic. No per-game task sizing changes.

## Migration Plan

1. Merge PR 1; run `npm run app:build:lambdas` then `terraform apply` **while the HTTPS game(s) are stopped**. The apply: creates `{game}-certs` access points, new task-def revisions with the sidecar, public 443/80 ingress; destroys the ALB, listeners, target groups, listener rules, ALB SG, ACM cert + validation records, and static alias records; updates both Lambdas' env (no `HTTPS_GAMES`/`ALB_TARGET_GROUPS`).
2. Verify no orphans: `aws elbv2 describe-load-balancers` and `describe-target-groups` return empty; `aws acm list-certificates` has no stack cert; the ALB SG is gone.
3. Start the HTTPS game. Confirm: A record appears for `{game}.{zone}`; valid HTTPS within ~2 min of RUNNING (allowing first-boot issuance); Caddy logs show a successful ACME order.
4. Restart the task; confirm Caddy logs show cert reuse (no new ACME order).
5. Merge PR 2 (dead code, outputs/types, IAM policy trim, docs). Rebuild Lambdas + `terraform apply` to redeploy the slimmed handlers.
6. **Rollback:** `git revert` PR 1 and re-apply — the ALB stack is fully declarative and reprovisions in minutes (ACM DNS validation is the slowest step). Nothing in the sidecar path is stateful except issued certs, which are harmless to abandon.

## Open Questions

- Exact Caddy image tag to pin (`caddy:2-alpine` vs a full-version pin like `caddy:2.8.4-alpine`) — decide at implementation; must not be `latest`.
- Whether to set an ACME contact email (Caddy works without one; adding one via container command would be config-only — no new Terraform variable unless an operator-facing knob is truly needed).
- Whether `caddy reverse-proxy` CLI flags cover any per-game proxy quirk Foundry surfaces in testing (e.g. large-upload limits); fallback is an inline Caddyfile via `command: ["caddy", "run", "--adapter", "caddyfile", ...]` with the config passed through an environment variable — still no image build.
