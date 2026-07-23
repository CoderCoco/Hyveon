# Replace always-on ALB with in-task Caddy TLS sidecar

## Why

The ALB provisioned for `https = true` games (`terraform/aws/alb.tf`) bills per hour of existence — ~$16.4/mo even with zero tasks running — and is the only resource in the stack that violates the core scale-to-zero design ("no persistent ECS Service, pay nothing when idle"). Terminating TLS inside the Fargate task with a Caddy sidecar makes HTTPS cost scale with actual play time, exactly like everything else.

## What Changes

- **Add a Caddy reverse-proxy sidecar container** to the ECS task definition of every `https = true` game (official `caddy` image, ports 443 + 80, `reverse_proxy → localhost:<container_port>`), driven entirely by the existing `game_servers` map via `for_each` — no hand-written per-game resources.
- **Let's Encrypt via Caddy automatic HTTPS** (HTTP-01 / TLS-ALPN-01) replaces the ACM certificate. Issued certs are persisted on a dedicated per-game EFS access point (`{game}-certs`) mounted at Caddy's `/data` so renewals survive task restarts and Let's Encrypt rate limits are never approached.
- **BREAKING (infra): delete the entire ALB stack** — `aws_lb.game_servers`, both listeners, per-game target groups + listener rules, `aws_security_group.alb`, `aws_acm_certificate.game_servers` + validation resources, and the static `aws_route53_record.https_game` alias records.
- **DNS unification**: HTTPS games return to the Lambda-managed A-record path (`update-dns` UPSERT on RUNNING / DELETE on STOPPED) used by every other game; the ALB target-registration branch and `ALB_TARGET_GROUPS` / `HTTPS_GAMES` env plumbing are removed from `lambda-update-dns` and `lambda-watchdog`.
- **Security group rework**: HTTPS games get public ingress on 443 + 80 (80 is required for the HTTP-01 challenge and HTTP→HTTPS redirect); their raw game port loses public ingress (only the sidecar reaches it via localhost inside the task).
- **BREAKING (variable): remove `acm_certificate_domain`** (root + module declarations, `main.tf` pass-through, tfvars example, docs) per the repo's Terraform-variable checklist.
- **Output/type cleanup**: drop `alb_dns_name` / `acm_certificate_arn` outputs (module + root) and the matching fields in `ConfigService`'s `TfOutputs` and the preload `gsd-api.ts` type.
- **Docs**: update `https` flag semantics in `docs/docs/components/terraform.md`, trim `elasticloadbalancing:*` / `acm:*` from the `GameServerDeployAll` IAM policy in `docs/docs/setup.md` (after the removal apply has run), and update the CLAUDE.md architecture notes.

## Capabilities

### New Capabilities

- `in-task-tls-termination`: TLS for HTTPS-enabled game servers terminates inside the Fargate task via a Caddy sidecar with Let's Encrypt certificates persisted on EFS; no load-balancer or ACM resources exist, and HTTPS games use the same Lambda-managed DNS lifecycle as every other game.

### Modified Capabilities

_None — `openspec/specs/` has no existing capability specs; all requirements land as ADDED under the new capability._

## Impact

- **Terraform**: `terraform/aws/alb.tf` (deleted), `terraform/aws/main.tf` (task definitions, SG locals/rules, EFS access points), `terraform/aws/route53.tf` + `terraform/aws/watchdog.tf` (Lambda env + IAM trim), `terraform/aws/outputs.tf`, `terraform/aws/variables.tf`, root `terraform/variables.tf` / `terraform/main.tf` / `terraform/outputs.tf`, `terraform/terraform.tfvars.example`.
- **Lambdas**: `app/packages/lambda/update-dns` (delete `handleHttps`, ELBv2 client, `ALB_TARGET_GROUPS`/`HTTPS_GAMES` parsing) and `app/packages/lambda/watchdog` (delete ALB deregistration) plus their tests.
- **App**: `app/packages/desktop-main/src/services/ConfigService.ts` (`TfOutputs` fields), `app/packages/desktop-preload/src/gsd-api.ts`, related tests, and the e2e `tfstate.fixture.json` if it carries ALB outputs.
- **Docs**: `docs/docs/setup.md` (IAM policy — single source of truth), `docs/docs/components/terraform.md`, `CLAUDE.md`.
- **Cost**: removes ~$16.4/mo fixed ELB cost; new marginal cost is effectively $0 (sidecar shares the task's existing CPU/memory; the extra EFS access point is free and stores KBs).
- **Operations**: first HTTPS boot per game performs ACME issuance after Lambda-managed DNS propagates (Caddy retries with backoff); subsequent boots reuse the persisted cert.
