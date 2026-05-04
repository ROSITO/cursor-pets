# CursorPets PRD

## 1. Summary

CursorPets is a Cursor-compatible developer companion that brings GitPets-style Codex pets into the editor experience. The pet responds to coding activity, workspace signals, and optional user interactions. It should make Cursor feel more personal while staying respectful of focus and screen space.

## 2. Problem

Developer tools are powerful but often emotionally flat. Cursor already adds an agentic coding layer, but there is room for a lighter, ambient presence that gives feedback, delight, and continuity during everyday work.

The challenge is to create a companion that feels alive without becoming distracting, gimmicky, or technically fragile.

## 3. Goals

- Create a charming visual companion inside Cursor.
- Let users choose pets from a GitPets-compatible catalog.
- React to real editor context in small, meaningful ways.
- Keep the MVP compatible with Cursor through the VS Code extension API.
- Provide simple controls for visibility, animation intensity, and behavior.
- Establish a foundation that can later support Cursor-specific plugin and MCP capabilities.

## 4. Non-Goals

- Full-screen overlays across the entire editor.
- Replacing Cursor Agent, chat, or built-in AI workflows.
- Collecting analytics or sending code outside the local machine.
- Scraping or redistributing GitPets assets without permission.
- Complex gamification in the first release.
- A marketplace-ready polished asset system in the MVP.

## 5. Target Users

- Cursor users who enjoy playful development environments.
- Developers who want a softer, more personal workspace.
- Indie hackers and builders who like ambient feedback loops.
- Teams looking for a small morale layer in shared tooling.

## 6. MVP User Experience

The user installs CursorPets and sees a small pet in a dedicated Cursor/VS Code view. The pet idles quietly while the user codes. It reacts when files are saved, when diagnostics appear or clear, when the user switches files, and when the workspace has been inactive for a while.

The user can choose a pet from a GitPets-compatible picker. Each pet shows its name, author, short description, and source attribution. The user can open the Command Palette to show, hide, reset, or configure the pet. Settings allow the experience to be subtle by default.

## 7. GitPets Integration Requirements

- Support [GitPets](https://gitpets.com/) as the intended pet catalog source.
- Model pet metadata independently from the rendering engine.
- Track at minimum:
  - pet id
  - name
  - author
  - description
  - source URL
  - asset location
  - supported animation states
- Preserve creator attribution in the UI.
- Do not bundle GitPets assets until redistribution rights are clear.
- Prefer an official API, manifest, export format, or collaboration path over scraping.
- If no official source exists, provide a local manifest/import flow where users can add pets they are allowed to use.

## 8. Functional Requirements

- Render a pet in a Webview View.
- Render pets selected from a GitPets-compatible manifest.
- Provide a pet picker.
- Maintain pet mood/state in the extension host.
- Send state updates from the extension host to the webview.
- React to file save events.
- React to active editor changes.
- React to diagnostics count changes.
- Detect basic inactivity.
- Provide commands:
  - `CursorPets: Show Pet`
  - `CursorPets: Hide Pet`
  - `CursorPets: Reset Pet`
  - `CursorPets: Select Pet`
  - `CursorPets: Import Pet Manifest`
- Provide configuration:
  - `cursorPets.enabled`
  - `cursorPets.animationLevel`
  - `cursorPets.pet`
  - `cursorPets.petCatalogSource`
  - `cursorPets.reactToDiagnostics`

## 9. Technical Requirements

- Implement as a TypeScript VS Code extension.
- Use `WebviewViewProvider` for the main pet surface.
- Use strict Content Security Policy for webview assets.
- Use `asWebviewUri` for local webview resources.
- Avoid network calls in the MVP unless the user explicitly imports or syncs a catalog.
- Keep all state local.
- Define a local `pets.json` manifest schema.
- Keep pet metadata, pet asset loading, and mood state separate.
- Support current Cursor builds that are compatible with standard VS Code extensions.

## 10. Product Constraints

- Cursor/VS Code extensions cannot reliably draw arbitrary floating overlays above the full editor UI.
- The MVP should use supported workbench surfaces: sidebar/panel webview and status bar.
- Webview performance must remain lightweight.
- The pet must not open automatically in intrusive ways.
- GitPets ownership, licensing, and asset access need to be confirmed before bundling any third-party pet content.

## 11. Success Metrics

For the MVP:

- The extension can be installed locally in Cursor.
- The pet appears reliably in a Webview View.
- At least one sample pet can be loaded from a local manifest.
- The pet reacts to at least three editor signals.
- User settings work without restarting Cursor.
- The extension can be packaged as a `.vsix`.

For later public release:

- Positive early user feedback on delight versus distraction.
- Low CPU and memory usage.
- Clear install and uninstall path.
- Compatibility with Cursor and VS Code.

## 12. Milestones

### Milestone 1: Documentation and Scaffold

- Create README and PRD.
- Scaffold TypeScript extension.
- Add basic package metadata.
- Add local development instructions.

### Milestone 2: Visible Pet

- Add Webview View.
- Render initial pet UI.
- Add local pet manifest schema.
- Add show, hide, and reset commands.

### Milestone 3: Reactive Pet

- Add editor event listeners.
- Add mood state machine.
- Add webview message updates.

### Milestone 4: Packaging

- Add build scripts.
- Add extension packaging flow.
- Test local installation in Cursor.

### Milestone 5: GitPets Compatibility

- Confirm GitPets asset access and usage rights.
- Add GitPets-compatible metadata mapping.
- Add pet picker with attribution.
- Add catalog import or sync flow.

## 13. Open Questions

- How should official GitPets assets be accessed from CursorPets?
- Is there an official GitPets API, manifest endpoint, or export format?
- What are the licensing and redistribution rules for GitPets pet assets?
- Should CursorPets collaborate directly with GitPets or remain an independent compatible client?
- Should the first pet be sprite-based, CSS-based, canvas-based, or Lottie-based?
- Should CursorPets support VS Code officially, or only Cursor?
- Should pet state persist globally or per workspace?
- What should the first pet personality be?
- Should later versions include MCP tools for Cursor Agent interaction?
