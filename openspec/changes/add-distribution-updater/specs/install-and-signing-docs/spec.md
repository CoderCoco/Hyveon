## ADDED Requirements

### Requirement: Per-OS unsigned-MVP install instructions

The documentation site SHALL include `docs/docs/install.md` covering installation of the unsigned packaged app on each supported OS: macOS (right-click → Open to bypass Gatekeeper), Windows (SmartScreen "More info → Run anyway"), and Linux (AppImage `chmod +x` then run). The page MUST render in the Docusaurus site and state clearly that builds are unsigned for the MVP and why the OS warnings appear.

#### Scenario: Install doc renders with all three OS sections

- **WHEN** the Docusaurus site is built
- **THEN** the install page renders with distinct macOS, Windows, and Linux sections, each giving the exact steps to get past the unsigned-binary warning and launch the app

#### Scenario: Doc points at where to download artifacts

- **WHEN** an operator reads the install page
- **THEN** it links to the project's GitHub Releases page as the source of the `.exe` / `.dmg` / `.AppImage` artifacts

### Requirement: README links to the install instructions

The project `README.md` SHALL contain a top-level "Install" link pointing at the published install documentation so new users can find it without browsing the docs tree.

#### Scenario: README install link present

- **WHEN** a user views the repository README
- **THEN** an Install link near the top resolves to the install documentation page

### Requirement: Code-signing roadmap document

The documentation site SHALL include `docs/docs/code-signing-roadmap.md` describing the path to signed releases: Apple Developer program enrollment (~$99/yr) plus electron-builder notarization configuration for macOS, Azure Trusted Signing (~$10/month) for Windows, and the flow for enabling auto-update once both are in place. The document MUST record cost and ownership notes for future maintainers, the current blockers, and MUST note that `hardenedRuntime: false` in `electron-builder.yml` is intentional and stays until macOS signing lands.

#### Scenario: Roadmap captures decisions, costs, and blockers

- **WHEN** the Docusaurus site is built
- **THEN** the code-signing roadmap page renders with the macOS signing/notarization plan, the Windows Azure Trusted Signing plan, per-platform cost estimates, ownership notes, and current blockers

#### Scenario: hardenedRuntime caveat documented

- **WHEN** a maintainer consults the roadmap before touching `electron-builder.yml`
- **THEN** the document explains that `hardenedRuntime: false` must remain until macOS code signing is in place, and describes what changes when signing arrives (including flipping `enableAutoUpdate` guidance)
