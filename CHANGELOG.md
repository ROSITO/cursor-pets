# Changelog

## 0.14.5

- **Float → chat focus**: after the signal file is detected, CursorPets now runs **`osascript`** (`tell application "<appName>" to activate` using `vscode.env.appName`) so **Cursor becomes the frontmost app** before `openAgentsView` / `focusAuxiliaryBar` / `aichat.view` / `chat.focusInput`. Clicking the float leaves Cursor in the background, so workbench commands were previously a no-op for focus. macOS may prompt once for **Automation** permission to let Cursor control itself via Apple Events.
- **Documentation**: `README.md` and `BESOINS.md` describe the full **float → signal file → extension → activate Cursor → focus Agent/chat** path, LaunchAgent **four** `ProgramArguments`, and the optional **Automation** prompt.

## 0.14.4

- **Float “Ouvrir le chat”**: real **`NSButton`** (native hit-testing + hover press) instead of a drawn strip + manual `mouseDown`; small **haptic** on press; **`window.performDrag`** on the rest of the panel so dragging still works.
- **Feedback**: when the extension sees the signal file change, it shows a **status bar message** (“CursorPets — ouverture du chat…”) and logs to the **Extension Host** console so you can tell “click worked” even if Cursor’s focus commands behave oddly.

## 0.14.3

- **Float → chat**: replaced `fs.watch` on the signal file with **`fs.watchFile`** (stat polling), because **`fs.watch` often misses Swift’s atomic file replace** on macOS, so the extension never ran `openCursorChat`.
- **Float strip click**: write the signal with **`FileManager.createFile`** (reliable replace of file contents for polling).
- **Float strip handler**: call **`workbench.action.openAgentsView`** once before the usual focus sequence so **`chat.focusInput`** has a surface to attach to.

## 0.14.2

- **Floating window (macOS)**: bottom strip **« Ouvrir le chat Cursor »** — click writes `floating-pet-open-chat.signal` next to the float state JSON; the extension watches it and runs **`openCursorChat`** (same logic as the palette: focus ongoing Agent / chat when possible). Swift is spawned as `swift …/CursorPetsFloat.swift <signal-path> <state-json>` (state remains **last**); LaunchAgent plist includes both paths. Re-install the Login LaunchAgent if you still have an older two-argument plist.

## 0.14.1

- **`CursorPets: Open AI Chat`** (`cursorPets.openChat`): prefers **focusing the current chat / Agent session** (`workbench.action.chat.focusInput`, then `aichat.view`, Agents view, auxiliary bar, toggles). **`workbench.action.chat.open`** is only used as a **last resort**, because it often starts a **new** conversation when tried first.

## 0.14.0

- **Floating pet (macOS) reset to the last known-good Git baseline** (`4638596`, pre–spritesheet-cache experiments): restored **`CursorPetsFloat.swift`** to that simpler implementation (`NSImage(data:)` + `Data(contentsOf:)` for `pet.asset.entry`, no ImageIO-only paths, no extra JSON fields).
- **Extension host**: `FloatingPetHost` again writes the snapshot JSON as-is (no disk sprite cache, no `floatSpritesheetLocalPath`, no signal file / `fs.watch` for “open chat from float”). Spawn and LaunchAgent plist use **two** arguments after `swift`: **script path** and **state JSON path**.
- **CLI fix**: Swift reads the state path as **`CommandLine.arguments.dropFirst().last`** so it stays correct when extra arguments are ever added ahead of the path.
- **Trade-off**: GitPets spritesheets that only load reliably via the removed cache path may again show the **yellow placeholder** if `swift` cannot fetch or decode the remote asset; the next fix should be a single measured change, not stacked workarounds. **Open AI Chat** remains available via the command palette (`cursorPets.openChat`); the float window no longer includes the bottom chat strip from later versions.

## 0.13.3

- **Floating spritesheet**: added **`floatSpritesheetLocalPath`** on the float JSON snapshot so Swift **always loads the cached file from that path** while **`pet.asset.entry` stays the original https URL** (avoids confusing decode / cache round-trips). Swift reads `floatSpritesheetLocalPath` first, then falls back to `asset.entry`.
- **Download**: if **`fetch` fails**, retry the same URL with **`https.get`** (redirects + 45s timeout), matching environments where `fetch` misbehaves.

## 0.13.2

- **Floating Steve / WebP regression**: WebP decoded via ImageIO was wrapped in `NSImage(cgImage:size:)`, which often makes `cgImage(forProposedRect:)` return **nil** so **nothing** was drawn and the UI fell back to the yellow placeholder. Fixed by building the image with **`NSBitmapImageRep(cgImage:)`** + `addRepresentation`, and a **`drawSpritesheetPet`** fallback that reads **`NSBitmapImageRep.cgImage`**.
- **Float cache**: do not treat **`//…`** URLs as POSIX paths; **re-download** if the cached file is not a real image (magic-byte sniff: JPEG, PNG, WebP, GIF).

## 0.13.1

- **Floating spritesheet**: Swift now decodes **WebP** via **ImageIO / `CGImageSource`** when `NSImage(data:)` fails (common cause of the yellow placeholder even with a valid cached file).
- **Float cache download**: uses a **browser-like User-Agent**, **Accept** for images, and **Referer: https://gitpets.com/** for GitPets CDN URLs; drops tiny / corrupt cache files and re-fetches; writes an absolute **POSIX path** (`fsPath`) into the snapshot JSON for Swift `Data(contentsOf:)` (avoids `file://` edge cases).

## 0.13.0

- **Floating pet**: remote **spritesheet** URLs are **cached to disk** by the extension and the float receives a **`file://` URL**, so GitPets-style pets (e.g. Steve) render in the float instead of the yellow **placeholder** when HTTPS load from Swift failed.
- **Chat from float only (by default in the UI)**: removed the sidebar **“Ouvrir le chat Cursor”** banner, the panel **AI chat** toolbar control, the **status-bar** chat chip, and the **view-title** menu entry. Use **`CursorPets: Open AI Chat`** from the Command Palette when the float is closed, or **`Ouvrir le chat Cursor`** on the **floating** window (dedicated strip at the bottom, always above the pet drawing).

## 0.12.3

- **Floating pet (macOS)** now includes a **Chat** button at the bottom of the window. It writes to a small signal file that the extension watches so **Cursor AI chat** opens from the desktop float, not only from the sidebar panel.
- LaunchAgent plist now passes the **signal file path** as a third argument (still compatible with older two-arg invocations via derived path next to `floating-pet-state.json`).

## 0.12.2

- Fixed **`view/title` menu when clause**: `view == cursorPets.petView` never matched (dots parsed as nested context). Now **`view == 'cursorPets.petView'`** so the chat icon appears on the Pet view header.
- **Status bar** chat entry shows the label **“AI chat”** next to the icon, is **`show()`n on activation**, not only after the first render.
- Added a **full-width banner** at the top of the Pet panel: **“Ouvrir le chat Cursor”**.

## 0.12.1

- **AI chat access** is easier to find: **comment icon** in the **status bar** (left of the pet chip), **view title** action on the Pet sidebar, and a clearer **“AI chat”** panel button (primary styling). Webview script no longer crashes if `#openChat` is missing.
- **Open chat** tries more workbench commands in order (`openAgentsView`, auxiliary bar toggle, etc.) and no longer skips commands that were absent from `getCommands()` but still executable.

## 0.12.0

- Added **`cursorPets.tasks.reactToProcessExit`** (default on): task announcements now reflect **process exit codes** (success for 0, error for non-zero, warning when terminated without a code). Tasks without an underlying process still get the generic “Task finished” line.
- Documented **Open AI Chat**, **Announce Clipboard**, and the French requirements doc in **`README.md`**; linked **`BESOINS.md`** from the development section.
- Updated **`BESOINS.md`** backlog notes for task/build reactions and command-list maintenance.

## 0.11.0

- Added a **Chat** toolbar button in the CursorPets panel to open Cursor AI chat / agent via workbench commands, with fallbacks when command IDs differ by build.
- Added the **CursorPets: Open AI Chat** command (`cursorPets.openChat`) and matching activation event.
- Adjusted the panel toolbar grid to fit the new control (three columns).
- Added **`BESOINS.md`**, a French requirements / roadmap checklist for the plugin.

## 0.10.0

- Added terminal shell output announcements for the floating message bubble when shell integration is available.
- Added terminal output length settings and ANSI cleanup.

## 0.9.0

- Added floating window movement detection.
- Switched spritesheet row while the floating window moves so the pet runs in the drag direction.

## 0.8.0

- Added macOS LaunchAgent install and uninstall commands for login-time floating pet startup.
- Restored eager activation and startup diagnostic commands in the packaged manifest.
- Kept transparent floating frame defaults.

## 0.7.5

- Made the floating pet frame fully transparent by default.
- Added `cursorPets.float.showFrame` to optionally restore the rounded frame.

## 0.7.4

- Kept the floating helper alive during Cursor reload by default.
- Added `cursorPets.float.keepAliveOnReload`.

## 0.7.3

- Added multiple delayed auto-float attempts after activation.
- Added manual start and startup diagnostic commands.

## 0.7.2

- Added eager activation to make auto-float reliable after Cursor reload.
- Added extension-host logs for activation and floating helper launch.

## 0.7.1

- Added startup activation so CursorPets can auto-launch the floating pet without manually opening the extension view.

## 0.7.0

- Added automatic floating pet launch on activation.
- Added configurable floating window and message opacity.
- Made the floating window background more transparent by default.

## 0.6.3

- Moved the floating message bubble lower and reserved a separate pet drawing area so text no longer overlaps the pet.

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
