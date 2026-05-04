# Changelog

## 0.6.2

- Fixed floating pet text rendering so messages wrap across multiple lines instead of truncating on the first line.

## 0.6.1

- Improved floating pet message layout with a larger window, message bubble, two-line wrapping, and safer truncation.

## 0.6.0

- Added pet notification announcements.
- Added notification history in the CursorPets panel.
- Added clear notification and test notification commands.
- Added announcements for diagnostics, task lifecycle, debug lifecycle, saves, GitPets imports, and floating mode.

## 0.5.3

- Fixed GitPets spritesheet rendering to crop individual frames instead of showing the full sheet.
- Added frame and sheet dimension metadata for GitPets sprites.
- Updated the macOS floating helper to crop spritesheet frames correctly.

## 0.5.2

- Fixed GitPets metadata parsing for Next.js payloads that escape JSON strings.

## 0.5.1

- Added GitPets import from clipboard to avoid flaky input-box submission.
- Added progress feedback and request timeout for GitPets imports.
- Relaxed URL validation to accept trailing slashes.

## 0.5.0

- Added GitPets URL import for pet pages.
- Added remote spritesheet rendering in the CursorPets panel.
- Added imported pet persistence in extension global storage.
- Added basic spritesheet support to the macOS floating helper.

## 0.4.0

- Replaced browser Document Picture-in-Picture with a macOS native floating helper.
- The Float button now asks the extension host to launch an always-on-top desktop pet.
- The floating pet receives live state updates from CursorPets.

## 0.3.0

- Added experimental floating pet mode using Document Picture-in-Picture.
- Added a Float action to the CursorPets panel.
- Kept the sidebar pet as the fallback when PiP is unavailable.

## 0.2.0

- Added in-panel pet picker.
- Added in-panel pause, reset, import, and source actions.
- Added Webview-to-extension action handling.
- Added a versioned pet manifest JSON schema.

## 0.1.0

- Added initial Cursor/VS Code extension scaffold.
- Added CursorPets Webview View.
- Added local placeholder pets.
- Added basic mood reactions for editor activity.
