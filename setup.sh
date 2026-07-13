#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Hyveon — setup helper

Usage:
  ./setup.sh              First-time bootstrap (default).
                          Installs prereqs, builds Lambda bundles, creates the
                          S3+DynamoDB Terraform backend, and runs `terraform init`.
                          Also offers to bootstrap a versioned S3 bucket for
                          terraform.tfvars (terraform/bootstrap/) — set
                          GSD_TFVARS_BACKEND=s3 to opt in non-interactively,
                          or GSD_TFVARS_BACKEND=local to skip. Unset in a
                          non-interactive shell defaults to local (no-op).

  ./setup.sh add-game     Interactive: prompts for image/cpu/memory/ports and
                          prints an HCL snippet to paste into terraform.tfvars
                          under the `game_servers` map.

  ./setup.sh deploy       Rebuilds all Lambda bundles and runs `terraform plan`.
                          Use before `terraform apply` so the archive_file data
                          sources see fresh dist/handler.cjs files.

  ./setup.sh -h | --help  Show this message.
EOF
}

# ──────────────────────────────────────────────────────────────────────────────
# tfvars backend selection + S3 bootstrap
# ──────────────────────────────────────────────────────────────────────────────
#
# terraform/bootstrap/ is a separate, standalone Terraform module that
# provisions a *second*, distinct S3 bucket whose only job is to hold
# terraform.tfvars outside the operator's parent repo (see
# docs/docs/setup.md, "Bootstrap the tfvars bucket"). GSD_TFVARS_BACKEND
# picks how that bucket gets created:
#   - "local" (default): skip entirely — zero new AWS/Terraform calls. This
#     preserves today's behaviour for anyone managing tfvars by hand.
#   - "s3": `terraform apply` the bootstrap module, record the resulting
#     bucket name in .gsd/tfvars-bucket (parent-repo root, gitignored), and
#     seed the bucket with the local terraform.tfvars — but only if one
#     exists locally and the bucket doesn't already have an object at that
#     key, so re-running never re-uploads.
# When the env var is unset, an interactive TTY is prompted; a non-TTY
# session (CI, scripted runs) silently defaults to "local".
#
# Expects TF_PROJECT and TF_REGION to already be set by the caller (bootstrap
# derives them from terraform.tfvars before calling this).

bootstrap_tfvars_backend() {
  local backend="${GSD_TFVARS_BACKEND:-}"

  if [ -z "$backend" ]; then
    if [ -t 0 ]; then
      local reply
      read -rp "  Store terraform.tfvars in a versioned S3 bucket (terraform/bootstrap)? [y/N]: " reply
      case "$reply" in
        y|Y|yes|YES) backend="s3" ;;
        *) backend="local" ;;
      esac
    else
      backend="local"
    fi
  fi

  if [ "$backend" != "s3" ]; then
    echo "   tfvars backend: local (skipping S3 bootstrap — no AWS calls)"
    return 0
  fi

  echo ""
  echo "☁️   Bootstrapping tfvars S3 bucket (terraform/bootstrap)..."
  cd "$SCRIPT_DIR/terraform/bootstrap"
  terraform init -input=false
  terraform apply -auto-approve -input=false \
    -var="project_name=${TF_PROJECT}" \
    -var="aws_region=${TF_REGION}"

  local bucket
  bucket=$(terraform output -raw tfvars_bucket_name)

  mkdir -p "$SCRIPT_DIR/.gsd"
  echo "$bucket" >"$SCRIPT_DIR/.gsd/tfvars-bucket"
  echo "   Bucket name recorded at .gsd/tfvars-bucket: ${bucket}"

  local tfvars_file="$SCRIPT_DIR/terraform/terraform.tfvars"
  if [ -f "$tfvars_file" ]; then
    if aws s3api head-object --bucket "$bucket" --key terraform.tfvars --region "$TF_REGION" >/dev/null 2>&1; then
      echo "   s3://${bucket}/terraform.tfvars already exists — skipping upload."
    else
      echo "   Uploading local terraform.tfvars to s3://${bucket}/terraform.tfvars..."
      aws s3 cp "$tfvars_file" "s3://${bucket}/terraform.tfvars" --region "$TF_REGION"
    fi
  fi

  cd "$SCRIPT_DIR/terraform"
}

# ──────────────────────────────────────────────────────────────────────────────
# Bootstrap (the original setup.sh behaviour)
# ──────────────────────────────────────────────────────────────────────────────

bootstrap() {
  echo ""
  echo "  🎮  Hyveon — Setup"
  echo "  ──────────────────────────────────────"
  echo ""

  # 1. Check / install prerequisites

  # Node.js 20+
  if ! command -v node >/dev/null 2>&1; then
    echo "📥  Node.js not found — please install Node.js 20+ (e.g. via nvm) and re-run."
    exit 1
  fi
  NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
  if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "❌  Node.js 20+ required (detected $NODE_MAJOR)."
    exit 1
  fi

  # Terraform
  if ! command -v terraform >/dev/null 2>&1; then
    echo "📥  terraform not found — installing via official HashiCorp repo..."
    sudo apt-get update -qq && sudo apt-get install -y gnupg software-properties-common curl
    curl -fsSL https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
    echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" \
      | sudo tee /etc/apt/sources.list.d/hashicorp.list
    sudo apt-get update -qq && sudo apt-get install -y terraform
  fi

  # AWS CLI
  if ! command -v aws >/dev/null 2>&1; then
    echo "📥  AWS CLI not found — installing v2..."
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
    unzip -q /tmp/awscliv2.zip -d /tmp
    sudo /tmp/aws/install
    rm -rf /tmp/awscliv2.zip /tmp/aws
  fi

  echo "✅  Prerequisites found (node, terraform, aws cli)"

  # 2. Install JS dependencies and build lambda bundles.
  #
  # Each Lambda is an esbuild-produced single-file bundle at
  # packages/lambda/<name>/dist/handler.cjs. Terraform's `archive_file` resources
  # zip that up at apply time, so the bundles must exist on disk BEFORE
  # `terraform apply` can run. `npm run app:build:lambdas` does exactly that.
  echo ""
  echo "📦  Installing Node dependencies..."
  cd "$SCRIPT_DIR"
  npm ci
  echo ""
  echo "🧱  Building Lambda bundles..."
  npm run app:build:lambdas

  # 3. Bootstrap S3 backend, then Terraform init
  echo ""
  echo "🔧  Initializing Terraform..."
  cd "$SCRIPT_DIR/terraform"
  if [ ! -f terraform.tfvars ]; then
    cp terraform.tfvars.example terraform.tfvars
    echo "   Created terraform.tfvars from example — edit it with your settings."
  fi

  # Derive bucket/table names from terraform.tfvars (fall back to defaults).
  TF_PROJECT=$(grep -E '^project_name\s*=' terraform.tfvars | head -1 | sed 's/.*=\s*"\(.*\)".*/\1/')
  TF_REGION=$(grep -E '^aws_region\s*=' terraform.tfvars | head -1 | sed 's/.*=\s*"\(.*\)".*/\1/')
  TF_PROJECT="${TF_PROJECT:-hyveon}"
  TF_REGION="${TF_REGION:-us-east-1}"
  TF_STATE_BUCKET="${TF_PROJECT}-tf-state"
  TF_LOCK_TABLE="${TF_PROJECT}-tf-locks"

  bootstrap_tfvars_backend

  echo ""
  echo "☁️   Bootstrapping S3 backend (bucket: ${TF_STATE_BUCKET}, region: ${TF_REGION})..."

  # Create S3 bucket if it doesn't already exist.
  # us-east-1 is the only region that rejects --create-bucket-configuration.
  if aws s3api head-bucket --bucket "$TF_STATE_BUCKET" --region "$TF_REGION" 2>/dev/null; then
    echo "   S3 bucket ${TF_STATE_BUCKET} already exists — skipping."
  else
    echo "   Creating S3 bucket ${TF_STATE_BUCKET}..."
    if [ "$TF_REGION" = "us-east-1" ]; then
      aws s3api create-bucket \
        --bucket "$TF_STATE_BUCKET" \
        --region "$TF_REGION"
    else
      aws s3api create-bucket \
        --bucket "$TF_STATE_BUCKET" \
        --region "$TF_REGION" \
        --create-bucket-configuration "LocationConstraint=${TF_REGION}"
    fi
    aws s3api put-bucket-versioning \
      --bucket "$TF_STATE_BUCKET" \
      --versioning-configuration Status=Enabled \
      --region "$TF_REGION"
    aws s3api put-public-access-block \
      --bucket "$TF_STATE_BUCKET" \
      --public-access-block-configuration \
      "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" \
      --region "$TF_REGION"
    aws s3api put-bucket-encryption \
      --bucket "$TF_STATE_BUCKET" \
      --server-side-encryption-configuration \
      '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}' \
      --region "$TF_REGION"
  fi

  # Create DynamoDB lock table if it doesn't already exist.
  if aws dynamodb describe-table --table-name "$TF_LOCK_TABLE" --region "$TF_REGION" 2>/dev/null; then
    echo "   DynamoDB table ${TF_LOCK_TABLE} already exists — skipping."
  else
    echo "   Creating DynamoDB lock table ${TF_LOCK_TABLE}..."
    aws dynamodb create-table \
      --table-name "$TF_LOCK_TABLE" \
      --attribute-definitions AttributeName=LockID,AttributeType=S \
      --key-schema AttributeName=LockID,KeyType=HASH \
      --billing-mode PAY_PER_REQUEST \
      --region "$TF_REGION"
    echo "   Waiting for DynamoDB table to become ACTIVE..."
    aws dynamodb wait table-exists \
      --table-name "$TF_LOCK_TABLE" \
      --region "$TF_REGION"
  fi

  # If a local state file exists the backend is being migrated from local → S3.
  # Pass -migrate-state and auto-confirm so the script doesn't hang waiting for
  # interactive input.
  TF_INIT_FLAGS=(
    -backend-config="bucket=${TF_STATE_BUCKET}"
    -backend-config="key=${TF_PROJECT}/terraform.tfstate"
    -backend-config="region=${TF_REGION}"
    -backend-config="dynamodb_table=${TF_LOCK_TABLE}"
    -backend-config="encrypt=true"
  )
  if [ -f terraform.tfstate ]; then
    echo "   Local terraform.tfstate detected — migrating state to S3..."
    echo "yes" | terraform init -migrate-state "${TF_INIT_FLAGS[@]}"
  else
    terraform init "${TF_INIT_FLAGS[@]}"
  fi

  echo ""
  echo "  ✅  Setup complete!"
  echo ""
  echo "  Next steps:"
  echo "    1. Edit terraform/terraform.tfvars with your game servers and domain"
  echo "       (or run: ./setup.sh add-game)"
  echo "    2. Run: ./setup.sh deploy   # rebuilds lambdas + terraform plan"
  echo "    3. Run: cd terraform && terraform apply"
  echo "    4. Run the management app:"
  echo "         Dev:     npm run app:dev"
  echo "         Docker:  docker compose up --build"
  echo "    5. Open http://localhost:5173 (dev) or http://localhost:5000 (docker)"
  echo ""
  echo "  Discord bot setup (serverless):"
  echo "    - Open Credentials tab in the web UI and save the Application ID,"
  echo "      Bot Token, and Application Public Key from the Discord Developer Portal."
  echo "    - Copy the 'Interactions Endpoint URL' from the same tab and paste it"
  echo "      into the Discord Developer Portal under General Information."
  echo "    - Add a guild ID under the Guilds tab and click 'Register commands'."
  echo ""
}

# ──────────────────────────────────────────────────────────────────────────────
# add-game: interactive HCL snippet generator
# ──────────────────────────────────────────────────────────────────────────────
#
# Why print rather than auto-edit: terraform.tfvars is HCL with a nested map,
# and reliable in-place insertion would need a real HCL parser. Printing the
# snippet keeps the operator in control and avoids corrupting existing entries.

add_game() {
  echo ""
  echo "  🎮  Add a game server"
  echo "  ──────────────────────────────────────"
  echo ""
  echo "  This generates an HCL snippet to paste into the game_servers map in"
  echo "  terraform/terraform.tfvars. Press Enter to accept defaults shown in []."
  echo ""

  local name image cpu memory ports_raw https_in https
  read -rp "  Game name (lowercase, e.g. palworld): " name
  if [ -z "$name" ]; then
    echo "❌  Name is required." >&2
    exit 1
  fi
  if ! [[ "$name" =~ ^[a-z][a-z0-9-]*$ ]]; then
    echo "❌  Name must be lowercase letters/digits/dashes, starting with a letter." >&2
    exit 1
  fi

  read -rp "  Container image: " image
  if [ -z "$image" ]; then
    echo "❌  Image is required." >&2
    exit 1
  fi

  read -rp "  CPU units [2048]: " cpu
  cpu="${cpu:-2048}"

  read -rp "  Memory MB [8192]: " memory
  memory="${memory:-8192}"

  echo ""
  echo "  Ports — comma-separated as port/protocol (e.g. 8211/udp,27015/udp):"
  read -rp "  Ports: " ports_raw
  if [ -z "$ports_raw" ]; then
    echo "❌  At least one port is required." >&2
    exit 1
  fi

  read -rp "  HTTPS via ALB? [y/N]: " https_in
  case "$https_in" in
    y|Y|yes|YES) https=true ;;
    *) https=false ;;
  esac

  # Build the ports list, validating each entry as it goes.
  local ports_hcl=""
  IFS=',' read -ra port_pairs <<<"$ports_raw"
  for pair in "${port_pairs[@]}"; do
    pair="${pair// /}"
    if ! [[ "$pair" =~ ^([0-9]{1,5})/(tcp|udp)$ ]]; then
      echo "❌  Invalid port spec: '$pair' — expected NUMBER/(tcp|udp)." >&2
      exit 1
    fi
    local p="${BASH_REMATCH[1]}"
    local proto="${BASH_REMATCH[2]}"
    if (( p < 1 || p > 65535 )); then
      echo "❌  Port out of range: $p" >&2
      exit 1
    fi
    ports_hcl+=$(printf '\n        { container = %s, protocol = "%s" },' "$p" "$proto")
  done

  echo ""
  echo "  ──────────────────────────────────────"
  echo "  Paste this into the game_servers = { ... } map in terraform.tfvars:"
  echo "  ──────────────────────────────────────"
  cat <<EOF
    "${name}" = {
      image  = "${image}"
      cpu    = ${cpu}
      memory = ${memory}
      ports = [${ports_hcl}
      ]
      environment = [
        # { name = "EXAMPLE", value = "value" },
      ]
      volumes = [
        { name = "saves", container_path = "/data" },
      ]
      https = ${https}
    }
EOF
  echo ""
  echo "  Then run: ./setup.sh deploy"
  echo ""
}

# ──────────────────────────────────────────────────────────────────────────────
# deploy: rebuild Lambda bundles + terraform plan
# ──────────────────────────────────────────────────────────────────────────────
#
# Why this exists: `terraform apply` reads dist/handler.cjs via archive_file
# data sources, so a stale bundle silently ships old code. Folding the build
# step in front of plan removes that footgun.

deploy() {
  echo ""
  echo "  🚀  Build Lambdas + terraform plan"
  echo "  ──────────────────────────────────────"
  echo ""
  cd "$SCRIPT_DIR"
  echo "🧱  Building Lambda bundles..."
  npm run app:build:lambdas
  echo ""
  cd "$SCRIPT_DIR/terraform"
  echo "📋  Running terraform plan..."
  terraform plan
  echo ""
  echo "  Review the plan above. To apply: cd terraform && terraform apply"
  echo ""
}

# ──────────────────────────────────────────────────────────────────────────────
# Dispatch
# ──────────────────────────────────────────────────────────────────────────────

case "${1:-bootstrap}" in
  bootstrap|"")
    bootstrap
    ;;
  add-game)
    add_game
    ;;
  deploy)
    deploy
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "Unknown command: $1" >&2
    echo "" >&2
    usage >&2
    exit 1
    ;;
esac
