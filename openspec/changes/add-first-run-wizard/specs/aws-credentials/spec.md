# AWS Credentials

## ADDED Requirements

### Requirement: AWS profile discovery
The desktop main process SHALL provide an `AwsProfileService` that parses `~/.aws/credentials` and `~/.aws/config` (resolving the home directory through a service seam, not raw `process.env`) and returns an array of `{ profileName, region? }` summaries. The result set MUST match the profile list `aws configure list-profiles` produces for the same files (including `profile <name>` section aliasing in `~/.aws/config`). The service MUST NOT return access key IDs or secret keys in the summary, and the profile-list IPC response MUST NOT contain key material.

#### Scenario: Profiles exist in both files
- **WHEN** `~/.aws/credentials` defines `default` and `personal`, and `~/.aws/config` sets `region` for `profile personal`
- **THEN** the service returns both profiles, with `personal` carrying its configured region and no key material in any entry

#### Scenario: Missing credential files
- **WHEN** neither `~/.aws/credentials` nor `~/.aws/config` exists
- **THEN** the service returns `[]` without raising an error

#### Scenario: Renderer lists profiles over IPC
- **WHEN** the renderer invokes the profile-list IPC method (`gsd.wizard.listAwsProfiles()`)
- **THEN** it receives only `{ profileName, region? }` summaries — secret values never cross the IPC boundary

### Requirement: safeStorage paste-flow encryption
When the operator pastes an access key ID and secret access key, the main process SHALL encrypt both values via `SafeStorageService` (`safeStorage.encryptString`) and store them in electron-store under `creds.aws.<profileName>`, where the ad-hoc profile name defaults to `gsd-pasted`. The ciphertext persisted in `electron-store.json` MUST be opaque to file inspection (never the plaintext key). Decryption MUST occur only in the main process, inside `CloudProviderModule` factories (or equivalent main-process consumers) — decrypted values are never sent to the renderer or logged.

#### Scenario: Pasted keys are stored encrypted
- **WHEN** the operator submits pasted `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` values
- **THEN** electron-store persists them under `creds.aws.gsd-pasted` as safeStorage ciphertext, and grepping `electron-store.json` for the plaintext values finds nothing

#### Scenario: Round-trip decryption in the main process
- **WHEN** a main-process consumer reads the stored paste-flow credentials
- **THEN** decryption returns the exact original strings

#### Scenario: safeStorage unavailable
- **WHEN** OS-level encryption is unavailable (per `SafeStorageService`'s degrade path)
- **THEN** the paste flow surfaces an explicit error to the wizard instead of silently storing plaintext

### Requirement: Pick-or-paste credentials wizard step
The credentials wizard step SHALL present a dropdown of discovered `~/.aws` profiles and a "paste keys instead" affordance that opens a form for access key ID, secret access key, and region. Submitting the paste form MUST invoke the safeStorage paste-flow. The region selector SHALL default from the selected profile's configured region while allowing override. The chosen credential source (profile name or pasted-profile reference, plus region) SHALL round-trip to the main process and persist for later wizard steps and normal app operation.

#### Scenario: Selecting an existing profile
- **WHEN** the operator picks a profile from the dropdown and continues
- **THEN** the main process records that profile as the active credential source with the region defaulted from the profile

#### Scenario: Pasting keys instead
- **WHEN** the operator opens the paste form and submits key ID, secret, and region
- **THEN** the safeStorage encryption flow runs, the stored profile (`gsd-pasted` by default) becomes the active credential source, and the wizard advances

#### Scenario: Region override
- **WHEN** the operator changes the region away from the profile default before continuing
- **THEN** the overridden region is what persists as the active region
