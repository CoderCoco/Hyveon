# in-task-tls-termination

TLS for HTTPS-enabled game servers terminates inside the Fargate task via a Caddy sidecar with Let's Encrypt certificates persisted on EFS. No load-balancer or ACM resources exist, and HTTPS games share the Lambda-managed DNS lifecycle used by every other game.

## ADDED Requirements

### Requirement: Caddy TLS sidecar for HTTPS games

For every game with `https = true` in the `game_servers` map, the ECS task definition MUST include a Caddy reverse-proxy sidecar container (official `caddy` image, version-pinned) exposing ports 443 and 80 and proxying to the game container's first declared port over localhost. The sidecar MUST be generated via `for_each` from the `game_servers` map — no hand-written per-game resources — and MUST be marked `essential` so a dead proxy stops the whole task instead of leaving an unreachable, billing task. Sidecar logs MUST stream to the game's existing CloudWatch log group under a distinct stream prefix. Task definitions of games with `https = false` MUST NOT contain the sidecar.

#### Scenario: HTTPS game task definition includes the sidecar

- **WHEN** `terraform apply` runs with a game configured `https = true`
- **THEN** that game's task definition contains two containers: the game container (unchanged ports and mounts) and an essential Caddy sidecar with port mappings 443/tcp and 80/tcp reverse-proxying `{game}.{hosted_zone_name}` to `localhost:{first container port}`, logging to `/ecs/{game}-server` with a `caddy` stream prefix

#### Scenario: Non-HTTPS game task definition is unchanged

- **WHEN** `terraform apply` runs with a game configured `https = false` (or `https` omitted)
- **THEN** that game's task definition contains only the game container, with no Caddy sidecar, no 443/80 port mappings, and no cert volume

#### Scenario: Flipping https on a game requires only a tfvars edit

- **WHEN** an operator sets `https = true` on an existing game in `terraform.tfvars` and applies
- **THEN** the sidecar container, cert access point, and security-group ingress all materialize without editing any other Terraform file

### Requirement: HTTPS served with automatically-issued certificates

The sidecar MUST obtain and serve a valid publicly-trusted certificate for `{game}.{hosted_zone_name}` via ACME (HTTP-01 and/or TLS-ALPN-01 challenges) with no custom image, no ECR repository, and no ACME-related IAM permissions on the task role. Because DNS for the task is created asynchronously by the update-dns Lambda after the task reaches RUNNING, issuance MUST tolerate initial challenge failures and retry with backoff until the record propagates, staying within Let's Encrypt failed-validation rate limits.

#### Scenario: Valid HTTPS shortly after task start

- **WHEN** an HTTPS game task reaches RUNNING and the update-dns Lambda has upserted the `{game}.{hosted_zone_name}` A record
- **THEN** `https://{game}.{hosted_zone_name}` serves the game over TLS with a valid publicly-trusted certificate within approximately 2 minutes (first-ever boot may take slightly longer for initial ACME issuance)

#### Scenario: Cold-start issuance survives DNS propagation delay

- **WHEN** the sidecar starts before the game's DNS record exists or has propagated, causing initial ACME challenges to fail
- **THEN** the sidecar retries issuance with backoff and completes successfully once DNS resolves, without operator intervention

### Requirement: Certificate persistence across task restarts

Each HTTPS game MUST have a dedicated EFS access point (`{game}-certs`, created via `for_each` over the HTTPS games) mounted at the sidecar's data directory (`/data`) so issued certificates and the ACME account key survive task stops and restarts. A task restart MUST reuse the persisted certificate rather than performing a new ACME order.

#### Scenario: Restart reuses the persisted certificate

- **WHEN** an HTTPS game task is stopped and started again while its certificate is still valid
- **THEN** the sidecar serves the previously-issued certificate immediately and its logs show no new ACME order

#### Scenario: Per-game cert access point exists

- **WHEN** `terraform apply` runs with at least one HTTPS game
- **THEN** each HTTPS game has its own EFS access point rooted at an isolated per-game directory, mounted only on that game's sidecar container at `/data`

### Requirement: HTTPS games use the Lambda-managed DNS lifecycle

HTTPS games MUST use the same update-dns Lambda A-record path as every other game: UPSERT `{game}.{hosted_zone_name}` to the task's public IP on RUNNING, DELETE on STOPPED. Terraform MUST NOT manage per-game DNS records (no static alias records), and neither the update-dns nor the watchdog Lambda code SHALL contain any load-balancer target-registration path, `ALB_TARGET_GROUPS`/`HTTPS_GAMES` configuration, or `elasticloadbalancing` IAM permissions.

#### Scenario: A record follows the HTTPS game task

- **WHEN** an HTTPS game task transitions to RUNNING and later to STOPPED
- **THEN** the update-dns Lambda upserts an A record pointing at the task's public IP on RUNNING and deletes it on STOPPED, identically to a non-HTTPS game

#### Scenario: No target-group code paths remain

- **WHEN** the update-dns and watchdog Lambda sources and their Terraform wiring are inspected after the change
- **THEN** no ELBv2 API calls, no `ALB_TARGET_GROUPS` or `HTTPS_GAMES` environment variables, and no `elasticloadbalancing` IAM statements exist

### Requirement: Security-group ingress for HTTPS games

The game-servers security group MUST allow public ingress on 443/tcp and 80/tcp when at least one HTTPS game exists (port 80 is required for the ACME HTTP-01 challenge and the HTTP-to-HTTPS redirect). The raw container ports of HTTPS games MUST NOT have public ingress — the sidecar reaches the game over localhost inside the task. Non-HTTPS games' port ingress rules remain unchanged.

#### Scenario: HTTPS ports open, raw game port closed

- **WHEN** `terraform apply` runs with at least one HTTPS game
- **THEN** the game-servers security group has 0.0.0.0/0 ingress on 443/tcp and 80/tcp, and no ingress rule exposing the HTTPS game's raw container port

#### Scenario: No HTTPS games means no web ports

- **WHEN** `terraform apply` runs with no HTTPS games configured
- **THEN** the game-servers security group contains no 443/80 ingress rules

### Requirement: No load-balancer or ACM resources

The stack SHALL NOT provision any Elastic Load Balancing or ACM resources: no load balancer, listeners, listener rules, target groups, ALB security group, ACM certificate, or ACM validation records. The `acm_certificate_domain` variable and the `alb_dns_name` / `acm_certificate_arn` outputs MUST be removed from both the root module and the `aws` module, along with the matching fields in the management app's parsed `TfOutputs` shape. After the removal apply, the account MUST contain no orphaned ELB or ACM resources from this stack.

#### Scenario: Apply with HTTPS games creates zero ELB resources

- **WHEN** `terraform apply` completes on a configuration with at least one `https = true` game
- **THEN** `aws elbv2 describe-load-balancers` and `aws elbv2 describe-target-groups` return no resources for this stack, and no stack ACM certificate exists

#### Scenario: Stopped HTTPS game accrues no fixed cost

- **WHEN** an HTTPS game task is stopped
- **THEN** no HTTPS-related resource continues to bill hourly (EFS cert storage of a few KB and the free access point are the only remnants)
