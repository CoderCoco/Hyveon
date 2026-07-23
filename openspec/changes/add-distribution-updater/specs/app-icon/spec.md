## ADDED Requirements

### Requirement: Platform icon asset set exists in the repository

The repository SHALL contain a Hyveon icon asset set under `build/`: `build/icon.icns` (macOS), `build/icon.ico` (Windows, multi-size including 16/32/48/256 px), and `build/icon.png` (Linux, at least 512×512). All assets MUST be derived from a single master artwork (at least 1024×1024 source) that the operator supplies or explicitly approves — the visual design itself is a human/creative input, not something this change invents silently.

#### Scenario: Asset set generated from approved master artwork

- **WHEN** the operator supplies or approves a master icon image
- **THEN** `build/icon.icns`, `build/icon.ico`, and `build/icon.png` are generated from it at the required sizes and committed to the repository

#### Scenario: Placeholder acceptable pending final branding

- **WHEN** no final brand artwork is available at implementation time
- **THEN** an operator-approved placeholder icon is used so the packaging wiring is complete, and swapping in final artwork later requires only replacing the asset files

### Requirement: electron-builder packages the icon on every target

`electron-builder.yml` SHALL reference the icon assets so that the NSIS installer, DMG, and AppImage — and the running app's taskbar/dock and (Windows) Explorer entry for the installed exe — display the Hyveon icon instead of Electron's default.

#### Scenario: Packaged installers carry the icon

- **WHEN** `npm run desktop:package` runs on each platform (locally or via the CI matrix)
- **THEN** the produced `.exe`, `.dmg`, and `.AppImage` display the Hyveon icon, with any platform not verifiable locally documented as covered by the CI matrix

#### Scenario: Running app shows the icon

- **WHEN** the packaged app is installed and launched
- **THEN** the OS taskbar/dock shows the Hyveon icon, not the electron-builder default

### Requirement: Web renderer has a matching favicon

`app/packages/web/index.html` SHALL declare a `<link rel="icon">` referencing a favicon derived from the same artwork, so the dev server / browser preview tab shows the Hyveon icon.

#### Scenario: Dev preview tab shows the favicon

- **WHEN** the web renderer is served in dev or preview mode and opened in a browser
- **THEN** the browser tab displays the Hyveon favicon
