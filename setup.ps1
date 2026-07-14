#Requires -Version 5.1
<#
.SYNOPSIS
  Hyveon - Windows setup script (PowerShell equivalent of setup.sh).

.DESCRIPTION
  Checks prerequisites (Node.js 20+, Terraform, AWS CLI), installs missing tools
  where possible, installs npm workspaces, builds Lambda bundles, bootstraps the
  S3 + DynamoDB Terraform backend, and runs `terraform init`.
#>

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ScriptDir = $PSScriptRoot

Write-Host ""
Write-Host "  Hyveon - Setup"
Write-Host "  --------------------------------------"
Write-Host ""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Test-Command {
  param([string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# $ErrorActionPreference = 'Stop' only traps cmdlet errors, not native-exe exit codes.
# Wrap every native call with this so a non-zero exit code throws immediately.
function Invoke-Native {
  param([scriptblock]$Block)
  & $Block
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code $LASTEXITCODE."
  }
}

function Install-WithWinget {
  param([string]$PackageId, [string]$DisplayName)
  if (-not (Test-Command 'winget')) {
    Write-Host "  winget is not available. Please install $DisplayName manually."
    exit 1
  }
  Write-Host "  Installing $DisplayName via winget..."
  Invoke-Native { winget install --id $PackageId --silent --accept-package-agreements --accept-source-agreements }
  # Refresh PATH for the current session so subsequent Test-Command calls work.
  $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' +
              [System.Environment]::GetEnvironmentVariable('PATH', 'User')
}

# ---------------------------------------------------------------------------
# 1. Prerequisites
# ---------------------------------------------------------------------------

# Node.js 20+
if (-not (Test-Command 'node')) {
  Write-Host "  Node.js not found."
  Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js LTS'
  if (-not (Test-Command 'node')) {
    Write-Host "  Node.js still not found after install. Open a new terminal and re-run."
    exit 1
  }
}

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) {
  Write-Host "  Node.js 20+ required (detected $nodeMajor). Please upgrade and re-run."
  exit 1
}

# Terraform
if (-not (Test-Command 'terraform')) {
  Write-Host "  terraform not found — installing via winget..."
  Install-WithWinget 'HashiCorp.Terraform' 'Terraform'
  if (-not (Test-Command 'terraform')) {
    Write-Host "  Terraform still not found after install. Open a new terminal and re-run."
    exit 1
  }
}

# AWS CLI
if (-not (Test-Command 'aws')) {
  Write-Host "  AWS CLI not found — downloading and installing v2..."
  $msiPath = Join-Path $env:TEMP 'AWSCLIV2.msi'
  Invoke-WebRequest -Uri 'https://awscli.amazonaws.com/AWSCLIV2.msi' -OutFile $msiPath
  Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`" /qn /norestart" -Wait -Verb RunAs
  Remove-Item $msiPath -ErrorAction SilentlyContinue
  $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' +
              [System.Environment]::GetEnvironmentVariable('PATH', 'User')
  if (-not (Test-Command 'aws')) {
    Write-Host "  AWS CLI still not found after install. Open a new terminal and re-run."
    exit 1
  }
}

Write-Host "  Prerequisites found (node, terraform, aws cli)"

# ---------------------------------------------------------------------------
# 2. Install JS dependencies and build Lambda bundles
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "  Installing Node dependencies..."
Set-Location (Join-Path $ScriptDir 'app')
Invoke-Native { npm ci }

Write-Host ""
Write-Host "  Building Lambda bundles..."
Invoke-Native { npm run build:lambdas }

# ---------------------------------------------------------------------------
# 3. Bootstrap S3 backend + Terraform init
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "  Initializing Terraform..."
Set-Location (Join-Path $ScriptDir 'terraform')

$tfvarsPath = 'terraform.tfvars'
if (-not (Test-Path $tfvarsPath)) {
  Copy-Item 'terraform.tfvars.example' $tfvarsPath
  Write-Host "   Created terraform.tfvars from example - edit it with your settings."
}

# Parse project_name and aws_region from terraform.tfvars (fall back to defaults).
$tfvarsContent = Get-Content $tfvarsPath -Raw

$projectMatch = [regex]::Match($tfvarsContent, '(?m)^\s*project_name\s*=\s*"([^"]+)"')
$regionMatch  = [regex]::Match($tfvarsContent, '(?m)^\s*aws_region\s*=\s*"([^"]+)"')

$TfProject = if ($projectMatch.Success) { $projectMatch.Groups[1].Value } else { 'game-servers' }
$TfRegion  = if ($regionMatch.Success)  { $regionMatch.Groups[1].Value }  else { 'us-east-1' }

$TfStateBucket = "$TfProject-tf-state"
$TfLockTable   = "$TfProject-tf-locks"

Write-Host ""
Write-Host "  Bootstrapping S3 backend (bucket: $TfStateBucket, region: $TfRegion)..."

# S3 bucket
$bucketExists = $false
try {
  aws s3api head-bucket --bucket $TfStateBucket --region $TfRegion 2>$null
  $bucketExists = ($LASTEXITCODE -eq 0)
} catch { $bucketExists = $false }

if ($bucketExists) {
  Write-Host "   S3 bucket $TfStateBucket already exists - skipping."
} else {
  Write-Host "   Creating S3 bucket $TfStateBucket..."
  if ($TfRegion -eq 'us-east-1') {
    Invoke-Native { aws s3api create-bucket --bucket $TfStateBucket --region $TfRegion }
  } else {
    Invoke-Native {
      aws s3api create-bucket `
        --bucket $TfStateBucket `
        --region $TfRegion `
        --create-bucket-configuration "LocationConstraint=$TfRegion"
    }
  }
  Invoke-Native {
    aws s3api put-bucket-versioning `
      --bucket $TfStateBucket `
      --versioning-configuration Status=Enabled `
      --region $TfRegion
  }
  Invoke-Native {
    aws s3api put-public-access-block `
      --bucket $TfStateBucket `
      --public-access-block-configuration 'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true' `
      --region $TfRegion
  }
  Invoke-Native {
    aws s3api put-bucket-encryption `
      --bucket $TfStateBucket `
      --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}' `
      --region $TfRegion
  }
}

# DynamoDB lock table
$tableExists = $false
try {
  aws dynamodb describe-table --table-name $TfLockTable --region $TfRegion 2>$null
  $tableExists = ($LASTEXITCODE -eq 0)
} catch { $tableExists = $false }

if ($tableExists) {
  Write-Host "   DynamoDB table $TfLockTable already exists - skipping."
} else {
  Write-Host "   Creating DynamoDB lock table $TfLockTable..."
  Invoke-Native {
    aws dynamodb create-table `
      --table-name $TfLockTable `
      --attribute-definitions AttributeName=LockID,AttributeType=S `
      --key-schema AttributeName=LockID,KeyType=HASH `
      --billing-mode PAY_PER_REQUEST `
      --region $TfRegion
  }
  Write-Host "   Waiting for DynamoDB table to become ACTIVE..."
  Invoke-Native { aws dynamodb wait table-exists --table-name $TfLockTable --region $TfRegion }
}

# terraform init (with optional state migration)
$tfInitArgs = @(
  "-backend-config=bucket=$TfStateBucket"
  "-backend-config=key=$TfProject/terraform.tfstate"
  "-backend-config=region=$TfRegion"
  "-backend-config=dynamodb_table=$TfLockTable"
  "-backend-config=encrypt=true"
)

if (Test-Path 'terraform.tfstate') {
  Write-Host "   Local terraform.tfstate detected - migrating state to S3..."
  Invoke-Native { 'yes' | terraform init -migrate-state @tfInitArgs }
} else {
  Invoke-Native { terraform init @tfInitArgs }
}

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "  Setup complete!"
Write-Host ""
Write-Host "  Next steps:"
Write-Host "    1. Edit terraform/terraform.tfvars with your game servers and domain"
Write-Host "    2. Run: cd terraform; terraform plan"
Write-Host "    3. Run: cd terraform; terraform apply"
Write-Host "    4. Run the management app:"
Write-Host "         Dev:     cd app; npm run dev"
Write-Host "         Docker:  docker compose up --build"
Write-Host "    5. Open http://localhost:5173 (dev) or http://localhost:5000 (docker)"
Write-Host ""
Write-Host "  Discord bot setup (serverless):"
Write-Host "    - Open Credentials tab in the web UI and save the Application ID,"
Write-Host "      Bot Token, and Application Public Key from the Discord Developer Portal."
Write-Host "    - Copy the 'Interactions Endpoint URL' from the same tab and paste it"
Write-Host "      into the Discord Developer Portal under General Information."
Write-Host "    - Add a guild ID under the Guilds tab and click 'Register commands'."
Write-Host ""
