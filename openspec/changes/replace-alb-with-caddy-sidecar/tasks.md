# Tasks — replace-alb-with-caddy-sidecar

Two PRs (see design.md D8). PR 1 is terraform-focused and self-contained (deployed Lambdas tolerate the removed env vars). PR 2 removes the now-dead code and trims docs, and closes #292.

## 1. PR 1 — Terraform: Caddy sidecar (branch `claude/issue-292-caddy-sidecar-terraform`)

- [ ] 1.1 Create worktree: `git worktree add .worktrees/claude/issue-292-caddy-sidecar-terraform -b claude/issue-292-caddy-sidecar-terraform`
- [ ] 1.2 In `terraform/aws/main.tf`, add `aws_efs_access_point.caddy_data` with `for_each = local.https_games`, root directory `/{game}/caddy-data`, posix uid/gid 1000 (matching the game access points), tagged `{game}-certs`
- [ ] 1.3 In `aws_ecs_task_definition.game`, conditionally (only when `each.value.https`) add the `{game}-caddy-data` EFS volume and a Caddy sidecar container: pinned official `caddy` image, `essential = true`, port mappings 443/tcp + 80/tcp, command `caddy reverse-proxy --from {game}.{hosted_zone_name} --to localhost:{ports[0].container}`, `/data` mount on the caddy-data volume, awslogs to the game's log group with stream prefix `caddy`
- [ ] 1.4 Rework SG locals/rules in `terraform/aws/main.tf`: keep `direct_game_ports` (non-HTTPS) as-is; replace the ALB-scoped `https_game_ports` ingress with public 443/tcp + 80/tcp ingress created only when `length(local.https_games) > 0`; ensure HTTPS games' raw container ports get no ingress rule
- [ ] 1.5 Delete `terraform/aws/alb.tf` entirely (ALB, listeners, listener rules, target groups, ALB SG, ACM cert + validation records, static `https_game` alias records); move the `https_games` local (still needed) into `main.tf`, and drop `enable_alb` / `acm_domain`
- [ ] 1.6 In `terraform/aws/route53.tf`: remove `HTTPS_GAMES` and `ALB_TARGET_GROUPS` from the dns-updater Lambda env and the `elasticloadbalancing:*` statement from its IAM role policy; update the file header comment
- [ ] 1.7 In `terraform/aws/watchdog.tf`: remove `HTTPS_GAMES` and `ALB_TARGET_GROUPS` from the watchdog Lambda env and the `elasticloadbalancing:*` statement from its IAM role policy; update the header comment
- [ ] 1.8 Remove `alb_dns_name` and `acm_certificate_arn` outputs from `terraform/aws/outputs.tf` and root `terraform/outputs.tf`
- [ ] 1.9 Remove the `acm_certificate_domain` variable per the repo checklist, all in one commit: root `terraform/variables.tf`, `terraform/aws/variables.tf`, the `module "cloud"` pass-through in `terraform/main.tf`, the commented example in `terraform/terraform.tfvars.example`, the Variables table row in `docs/docs/components/terraform.md`, and any mention in `docs/docs/setup.md`
- [ ] 1.10 Update the `https` flag comment in both `variables.tf` copies and the `https` semantics in `docs/docs/components/terraform.md` (in-task Caddy sidecar + Let's Encrypt, not ALB); note the 443/80 ingress and first-boot issuance behaviour in `docs/docs/setup.md`
- [ ] 1.11 Gate: `terraform fmt -check -recursive`, `terraform validate`, and `tflint` (from `terraform/`) all pass
- [ ] 1.12 Open PR via `/pr`: title `feat(terraform): replace ALB with in-task Caddy TLS sidecar`, body first line `Part of #292`, including the migration note (apply with HTTPS games stopped; deploy-policy trim deferred to PR 2 because the destroy apply still needs `elasticloadbalancing`/`acm`)

## 2. Migration verification (after PR 1 merges, before PR 2)

- [ ] 2.1 With HTTPS game(s) stopped: `npm run app:build:lambdas`, then `terraform apply`
- [ ] 2.2 Verify no orphans: `aws elbv2 describe-load-balancers` and `aws elbv2 describe-target-groups` are empty for the stack; the stack ACM certificate and ALB security group are gone
- [ ] 2.3 Start the HTTPS game; confirm the update-dns Lambda upserts the `{game}.{zone}` A record and `https://{game}.{zone}` serves a valid certificate within ~2 min of RUNNING (first boot allows extra time for ACME issuance)
- [ ] 2.4 Restart the task; confirm Caddy logs show cert reuse (no new ACME order)
- [ ] 2.5 Confirm the watchdog still auto-stops the idle HTTPS game (watch one idle cycle; if scanner noise on 80/443 keeps it alive, note it for a `watchdog_min_packets` bump — no schema change)

## 3. PR 2 — Lambda/app dead-code removal + docs (branch `claude/issue-292-remove-alb-code`)

- [ ] 3.1 Create worktree: `git worktree add .worktrees/claude/issue-292-remove-alb-code -b claude/issue-292-remove-alb-code`
- [ ] 3.2 `app/packages/lambda/update-dns`: delete `handleHttps`, `registerAlb`/`deregisterAlb`, the ELBv2 client and `ALB_TARGET_GROUPS`/`HTTPS_GAMES` parsing; route all games through `handleDirect`; restore public-IP inclusion in the Discord pending-interaction message for HTTPS games; update `handler.test.ts` (drop ALB describe/register specs, add a spec that an HTTPS-flagged game follows the plain A-record path)
- [ ] 3.3 `app/packages/lambda/watchdog`: delete the ALB deregistration step and `ALB_TARGET_GROUPS`/`HTTPS_GAMES` parsing; update `handler.test.ts` accordingly
- [ ] 3.4 Remove `alb_dns_name` / `acm_certificate_arn` from `TfOutputs` in `app/packages/desktop-main/src/services/ConfigService.ts` (declaration + parse), the mirror type in `app/packages/desktop-preload/src/gsd-api.ts`, and any references in tests (`ConfigService.test.ts`, `preload.test.ts`) and the e2e `tfstate.fixture.json`
- [ ] 3.5 Trim `elasticloadbalancing:*` and `acm:*` from the `GameServerDeployAll` policy JSON in `docs/docs/setup.md` (only valid now that the destroy apply from task 2.1 has run)
- [ ] 3.6 Update `CLAUDE.md` architecture notes: HTTPS is in-task (Caddy sidecar + Let's Encrypt on EFS), no ALB; DNS path is uniform for all games
- [ ] 3.7 Gate: `npm run app:test` and `npm run app:lint` pass; `terraform fmt -check -recursive`, `terraform validate`, `tflint` still clean (no terraform edits expected, cheap to confirm)
- [ ] 3.8 Open PR via `/pr`: title `refactor: remove ALB code paths after Caddy sidecar cutover`, body first line `Closes #292`
