plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

config {
  call_module_type = "all"
}

plugin "aws" {
  enabled   = true
  version   = "0.32.0"
  source    = "github.com/terraform-linters/tflint-ruleset-aws"
  signature = "pgp" # GitHub Actions attestation API is currently broken (bundle field missing);
                     # see terraform-linters/tflint#2591. Switch back to attestation once fixed upstream.
}
