# Prerequisite Detection

## ADDED Requirements

### Requirement: Binary detection service
The desktop main process SHALL provide a prerequisite-detection service that probes for the `terraform` and `aws` binaries by executing the platform lookup command (`which` on POSIX, `where.exe` on Windows, via the existing `lookupCommandFor` helper) with `execFile`, and SHALL return a result of shape `{ found: boolean, path?: string, version?: string }` per tool. Detection MUST run against the PATH repaired by `fix-path-bootstrap` at app boot so GUI-launched sessions on macOS/Linux see the same binaries a terminal would. The service MUST NOT read `process.env` directly in business logic — environment access goes through a service seam that tests can stub with `vi.spyOn`.

#### Scenario: Both tools installed
- **WHEN** the service checks prerequisites on a machine with `terraform` and `aws` on PATH
- **THEN** it returns `found: true` for both tools, each with the resolved absolute binary path and a parsed version string

#### Scenario: A tool is missing
- **WHEN** the lookup command exits non-zero for `aws`
- **THEN** the service returns `{ found: false }` for `aws` without throwing, and the result for `terraform` is unaffected

#### Scenario: Lookup command itself fails
- **WHEN** `execFile` rejects for reasons other than a not-found exit (e.g. spawn failure)
- **THEN** the service treats the tool as not found rather than crashing the wizard

### Requirement: Version parsing
The detection service SHALL parse tool versions from `terraform version` and `aws --version` output, handling current Terraform 1.x output (including the JSON-capable `terraform version` first line `Terraform vX.Y.Z`) and AWS CLI v2 output (`aws-cli/X.Y.Z ...`). Unparseable version output MUST degrade to `found: true` with `version` undefined rather than reporting the tool missing. The wizard SHALL compare the resolved Terraform version against a pinned minimum version constant and report the tool as unsatisfied when it is older.

#### Scenario: Terraform 1.x version output
- **WHEN** `terraform version` prints `Terraform v1.9.4` on its first line
- **THEN** the service reports `version: '1.9.4'`

#### Scenario: AWS CLI v2 version output
- **WHEN** `aws --version` prints `aws-cli/2.17.0 Python/3.11.9 ...`
- **THEN** the service reports `version: '2.17.0'`

#### Scenario: Terraform older than the pinned minimum
- **WHEN** the detected Terraform version is below the pinned minimum supported version
- **THEN** the check result marks Terraform as not satisfying prerequisites and includes the minimum required version so the UI can display it

### Requirement: Prerequisite check IPC
The prerequisite check SHALL be exposed to the renderer via an IPC-only controller message pattern `wizard.prereqs.check` (bridged by `registerIpcMainBridges`), mirrored in the preload as `gsd.wizard.checkPrereqs()` with a typed entry in `gsd-api.ts`. The renderer MUST NOT probe PATH or spawn processes itself.

#### Scenario: Renderer requests a prerequisite check
- **WHEN** the renderer invokes `gsd.wizard.checkPrereqs()`
- **THEN** the main process runs the detection service and resolves with per-tool `{ found, path?, version? }` results

### Requirement: Install-prerequisites wizard step
The first wizard step SHALL display the detection result per tool, render OS-specific install instructions (macOS, Windows, Linux — chosen from the platform reported by the main process) with links to the vendor download pages, and provide a "Re-check" button that re-invokes the prerequisite check. The step MUST block progression until both tools are detected as satisfied, and the wizard MUST NEVER attempt to install either tool itself (no elevation).

#### Scenario: Missing tool blocks progression
- **WHEN** the check reports `terraform` as not found
- **THEN** the step shows install instructions for the operator's OS, the Next/Continue control is disabled, and no auto-install is attempted

#### Scenario: Re-check after installing
- **WHEN** the operator installs the missing tool and clicks "Re-check"
- **THEN** the step re-invokes `gsd.wizard.checkPrereqs()` and, once both tools are satisfied, enables progression to the next step

#### Scenario: Correct instructions per platform
- **WHEN** the step renders on each of macOS, Windows, and Linux
- **THEN** the install instructions shown match that platform (e.g. `brew`/installer/`winget`/package-manager guidance respectively)
