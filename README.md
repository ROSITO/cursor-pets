# CursorPets

CursorPets is a playful companion extension concept for Cursor. The goal is to bring GitPets-style Codex pets into the Cursor developer workflow: present enough to feel alive, quiet enough to stay out of the way, and useful enough to react to real coding context.

The project starts as a Cursor-compatible VS Code extension, because Cursor is built on the VS Code extension model. Later versions may add Cursor-specific agent capabilities through MCP, rules, or plugin packaging.

## GitPets Integration

The first product direction is to support pets from [GitPets](https://gitpets.com/). GitPets currently presents a public catalog of Codex pets with names, descriptions, authors, and "Add to Codex" actions.

CursorPets should make those pets usable in Cursor while respecting ownership and distribution constraints. Until GitPets provides or confirms an official asset API, manifest format, or redistribution license, the extension should treat GitPets support as an integration target rather than bundled third-party content.

Expected integration shape:

- Discover available GitPets pets from an authorized source.
- Store pet metadata such as name, author, description, source URL, and supported animations.
- Import or reference pet assets only through a permitted mechanism.
- Render selected pets inside Cursor using the local extension UI.
- Preserve author attribution in the pet picker and documentation.

## Vision

CursorPets should feel like a tiny coding companion rather than a productivity widget. It reacts to what is happening in the editor, celebrates progress, notices friction, and gives the workspace a bit of warmth without interrupting flow.

## MVP

The first version will focus on:

- A pet rendered inside a VS Code/Cursor Webview View.
- A pet picker seeded by GitPets-compatible metadata.
- A small state machine for moods such as idle, focused, happy, waiting, and concerned.
- Reactions to editor events such as file saves, active editor changes, diagnostics, and periods of inactivity.
- Basic user settings for enabling animations, choosing intensity, and selecting a pet.
- A minimal command palette integration for showing, hiding, and resetting the pet.

## Current Status

The repository now contains a local extension build:

- VS Code/Cursor extension manifest.
- Webview View in the Activity Bar.
- Local GitPets-compatible `pets/pets.json` manifest.
- Two placeholder pets for development.
- Mood reactions for file saves, active editor changes, diagnostics, and inactivity.
- Commands for showing, hiding, resetting, selecting a pet, and importing a manifest.
- In-panel controls for pausing, resetting, importing a manifest, opening attribution links, switching pets, and opening the **macOS floating** pet. **Return to the current Agent / chat** (focus ongoing session when possible) via **`CursorPets: Open AI Chat`** in the palette, or use the **« Ouvrir le chat Cursor »** button at the bottom of the native float (real `NSButton`; Cursor must be running). From the float, the extension briefly **activates the Cursor app** via AppleScript so the Agent UI can take keyboard focus; macOS may ask once for Automation permission. A short **status bar** message confirms the signal was received.
- GitPets URL import for pages such as `https://gitpets.com/pets/steve-80aac76c`.
- Clipboard-based GitPets import when the Cursor input box does not submit cleanly.
- Pet notification announcements for diagnostics, task/debug lifecycle events (including **task process exit codes** when available), saves, and CursorPets actions.
- In-panel notification history with clear action.
- Floating pet auto-starts by default and has configurable background/message opacity.
- CursorPets activates after Cursor startup so floating mode can open without manually opening the panel.
- CursorPets uses eager activation so auto-float starts reliably after Cursor reload.
- Floating pet stays alive across Cursor window reloads by default.
- Floating pet frame is fully transparent by default; enable `cursorPets.float.showFrame` to show it again.
- Optional macOS LaunchAgent can start the floating pet at login independently of Cursor.
- Terminal shell output can be announced in the floating text bubble when shell integration is available.
- Versioned pet manifest schema in `schemas/pet-manifest.schema.json`.

Floating mode uses a small macOS native helper because Cursor Webviews are iframe contexts and cannot use browser Document Picture-in-Picture directly. The sidebar pet remains the cross-platform fallback.

The included pets are placeholders. They are not official GitPets assets.

## Technical Direction

CursorPets will initially be implemented as a TypeScript extension using the VS Code Extension API.

Likely surfaces:

- `WebviewView` for the main pet UI.
- `StatusBarItem` for lightweight state or quick access.
- `workspace` and `window` events for editor context.
- `languages.getDiagnostics()` for error and warning awareness.
- Webview message passing for communication between the extension host and pet UI.
- A local pet manifest format for GitPets-compatible metadata and assets.

## Local Development

French requirements / backlog notes (`BESOINS.md`) are intentionally **not** versioned in this repository; keep a local copy if you use that checklist.

Install dependencies:

```sh
npm install
```

Compile the extension:

```sh
npm run compile
```

Run it locally:

1. Open this folder in Cursor or VS Code.
2. Run the "Run CursorPets Extension" debug configuration.
3. Open the CursorPets Activity Bar view.

Useful commands:

- `CursorPets: Show Pet`
- `CursorPets: Hide Pet`
- `CursorPets: Reset Pet`
- `CursorPets: Select Pet`
- `CursorPets: Import Pet Manifest`
- `CursorPets: Import GitPets URL`
- `CursorPets: Announce Notification`
- `CursorPets: Test Notification`
- `CursorPets: Clear Notifications`
- `CursorPets: Start Floating Pet`
- `CursorPets: Install Login LaunchAgent`
- `CursorPets: Uninstall Login LaunchAgent`
- `CursorPets: Diagnose Startup`
- `CursorPets: Announce Clipboard in Pet (e.g. AI reply)`
- `CursorPets: Open AI Chat`

Use **`cursorPets.tasks.reactToProcessExit`** to toggle exit-code–aware task announcements vs a single generic “Task finished” per task.

Terminal output announcements require Cursor/VS Code shell integration. CursorPets reads output from shell executions started after the extension is active; it cannot read arbitrary historical terminal text.

Note: CursorPets cannot intercept every native Cursor notification from the core product or other extensions because the VS Code/Cursor extension API exposes message creation APIs, not a global notification listener. The pet announces the editor signals and extension events that are available through supported APIs.

The CursorPets panel also includes direct controls for the common actions, so the Command Palette is no longer required for everyday use.

## macOS floating window and Agent chat

The native float is a **Swift** helper (`floating-host/macos/CursorPetsFloat.swift`), not a webview: it reads `floating-pet-state.json` and renders spritesheets (e.g. GitPets Steve) from `pet.asset.entry`.

- **Pet bubble text**: if `state.message` contains a **newline**, the **first line** is shown as a **bold title** and the **rest** as body (sidebar + float). Announcements already use `headline\ndetail`; other call sites can use the same pattern.
- **« Ouvrir le chat Cursor »** is a real **`NSButton`**. On click it overwrites `floating-pet-open-chat.signal` next to the state file (same global storage folder as the JSON).
- The extension uses **`fs.watchFile`** (not `fs.watch`) so macOS reliably sees each overwrite from the float process.
- It then shows a short **status bar** message, runs **AppleScript** to **`activate`** the Cursor app (`vscode.env.appName`), and runs a sequence of **`workbench` / `aichat` / `chat.focusInput`** commands so the **ongoing** Agent / chat surface can take focus—same intent as **`CursorPets: Open AI Chat`** from the palette.
- **Login LaunchAgent** must pass **four** arguments after `/usr/bin/swift`: **script path**, **signal path**, **state JSON path** (state is always last). Re-run **Install Login LaunchAgent** after upgrades if your plist is older.
- If macOS asks for **Automation** (Cursor controlling Cursor via Apple Events), allow it once; otherwise activation may be skipped and focus can still fail.

## Pet Manifest

CursorPets uses a local GitPets-compatible manifest shape:

```json
{
  "version": 1,
  "source": "local-preview",
  "pets": [
    {
      "id": "example-pet",
      "name": "Example Pet",
      "author": "Creator",
      "description": "Short pet description.",
      "sourceUrl": "https://gitpets.com/",
      "asset": {
        "type": "spritesheet",
        "entry": "https://gitpets.com/api/assets/pets/example/spritesheet.webp",
        "frames": 6,
        "row": 0,
        "scale": 0.84
      },
      "states": ["idle", "focused", "happy", "waiting", "concerned"]
    }
  ]
}
```

The full JSON schema lives at `schemas/pet-manifest.schema.json`.

## Future Ideas

- Multiple pet personalities.
- GitPets catalog sync if an official or stable source is available.
- Unlockable animations based on coding streaks.
- Richer test and build reactions (first step: task process exit codes are announced when the task runs a real process).
- Workspace-specific pet memory.
- Optional MCP server so Cursor Agent can interact with the pet.
- Cursor plugin packaging once the product shape is stable.

## Development Status

This repository now has a V1 scaffold and local extension implementation. The next implementation milestone is replacing placeholder pets with authorized GitPets-compatible assets or an official catalog integration.

## License

License to be decided.
