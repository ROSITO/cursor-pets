import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { watch as fsWatch, unwatchFile, watchFile, type Stats } from "node:fs";
import type { Dirent, FSWatcher } from "node:fs";
import * as path from "node:path";
import { ChildProcess, execFileSync, spawn } from "node:child_process";
import * as https from "node:https";
import * as vscode from "vscode";

type PetMood = "idle" | "focused" | "happy" | "waiting" | "concerned";
type PetNotificationLevel = "info" | "success" | "warning" | "error";

interface PetAsset {
  type: "css" | "image" | "spritesheet";
  entry: string;
  frames?: number;
  row?: number;
  /** Row for the brief wave / emphasis loop after a notification (GitPets card hover). */
  notifyRow?: number;
  notifyFrames?: number;
  /** Walk-cycle rows while dragging the floating window (directional). */
  walkRowDown?: number;
  walkRowLeft?: number;
  walkRowRight?: number;
  walkRowUp?: number;
  walkFrames?: number;
  /** @deprecated Prefer notifyRow — still read by older manifests. */
  runRow?: number;
  /** @deprecated Prefer notifyFrames. */
  runFrames?: number;
  scale?: number;
  frameWidth?: number;
  frameHeight?: number;
  sheetWidth?: number;
  sheetHeight?: number;
}

interface PetDefinition {
  id: string;
  name: string;
  author: string;
  description: string;
  sourceUrl: string;
  asset: PetAsset;
  states: PetMood[];
}

interface PetCatalog {
  version: number;
  source: string;
  pets: PetDefinition[];
}

interface PetNotification {
  id: string;
  level: PetNotificationLevel;
  title: string;
  body: string;
  source: string;
  createdAt: string;
}

interface PetState {
  enabled: boolean;
  mood: PetMood;
  message: string;
  selectedPetId: string;
  animationLevel: "still" | "subtle" | "playful";
  diagnostics: {
    errors: number;
    warnings: number;
  };
  notifications: PetNotification[];
  unreadNotifications: number;
  /** Epoch ms — floating pet plays notifyRow until this time after an announcement. */
  notificationWaveUntil?: number;
}

interface WebviewAction {
  type: "cursorPets.action";
  action:
    | "selectPet"
    | "toggleEnabled"
    | "resetPet"
    | "importManifest"
    | "importGitPetsUrl"
    | "openSource"
    | "floatPet"
    | "clearNotifications";
  petId?: string;
  enabled?: boolean;
  url?: string;
}

interface FloatingPetSnapshot {
  state: PetState;
  pet: PetDefinition | undefined;
  options: {
    backgroundOpacity: number;
    messageOpacity: number;
    showFrame: boolean;
  };
}

const VIEW_ID = "cursorPets.petView";
const INACTIVITY_MS = 90_000;

export function activate(context: vscode.ExtensionContext): void {
  console.log("CursorPets activated.");
  const controller = new CursorPetsController(context);
  context.subscriptions.push(controller);
}

export function deactivate(): void {}

class CursorPetsController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly provider: CursorPetsViewProvider;
  private readonly statusBar: vscode.StatusBarItem;
  private readonly floatingHost: FloatingPetHost;
  private inactivityTimer: NodeJS.Timeout | undefined;
  private startupTimers: NodeJS.Timeout[] = [];
  private catalog: PetCatalog = { version: 1, source: "empty", pets: [] };
  private state: PetState;
  private lastDiagnostics = { errors: 0, warnings: 0 };
  private agentTranscriptWatchClosers: Array<() => void> = [];
  private agentTranscriptPollTimer: NodeJS.Timeout | undefined;
  private lastAgentTranscriptFingerprint = "";
  /** When `tasks.reactToProcessExit` is on, we announce on `onDidEndTaskProcess` and skip the generic `onDidEndTask` success for the same execution. */
  private readonly taskProcessExitAnnounced = new WeakMap<vscode.TaskExecution, true>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.state = this.createInitialState();
    this.provider = new CursorPetsViewProvider(
      context,
      () => this.state,
      () => this.catalog,
      (message) => this.handleWebviewAction(message)
    );
    this.floatingHost = new FloatingPetHost(context, () => void this.onFloatOpenChatSignal());
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 80);
    this.statusBar.command = "cursorPets.showPet";
    this.statusBar.tooltip = "Show CursorPets";
    this.disposables.push(
      this.statusBar,
      vscode.window.registerWebviewViewProvider(VIEW_ID, this.provider, {
        webviewOptions: { retainContextWhenHidden: true }
      }),
      vscode.commands.registerCommand("cursorPets.showPet", () => vscode.commands.executeCommand(`${VIEW_ID}.focus`)),
      vscode.commands.registerCommand("cursorPets.hidePet", () => this.updateEnabled(false)),
      vscode.commands.registerCommand("cursorPets.resetPet", () => this.resetPet()),
      vscode.commands.registerCommand("cursorPets.selectPet", () => this.selectPet()),
      vscode.commands.registerCommand("cursorPets.importPetManifest", () => this.importPetManifest()),
      vscode.commands.registerCommand("cursorPets.importGitPetsUrl", () => this.importGitPetsUrl()),
      vscode.commands.registerCommand("cursorPets.announceNotification", () => this.announceNotificationFromInput()),
      vscode.commands.registerCommand("cursorPets.testNotification", () =>
        this.announce("info", "Cursor notification", "This is what a pet announcement looks like.", "CursorPets")
      ),
      vscode.commands.registerCommand("cursorPets.clearNotifications", () => this.clearNotifications()),
      vscode.commands.registerCommand("cursorPets.startFloatingPet", () => this.openFloatingPet()),
      vscode.commands.registerCommand("cursorPets.installLoginLaunchAgent", () => this.installLoginLaunchAgent()),
      vscode.commands.registerCommand("cursorPets.uninstallLoginLaunchAgent", () => this.uninstallLoginLaunchAgent()),
      vscode.commands.registerCommand("cursorPets.diagnoseStartup", () => this.diagnoseStartup()),
      vscode.commands.registerCommand("cursorPets.announceFromClipboard", () => this.announceFromClipboard()),
      vscode.commands.registerCommand("cursorPets.openChat", () => void this.openCursorChat()),
      vscode.workspace.onDidSaveTextDocument((document) => this.announce("success", "File saved", path.basename(document.fileName), "Workspace")),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.react("focused", `Editing ${path.basename(editor.document.fileName)}.`);
        }
      }),
      vscode.languages.onDidChangeDiagnostics(() => this.refreshDiagnostics()),
      vscode.tasks.onDidStartTask((event) => this.announce("info", "Task started", event.execution.task.name, "Tasks")),
      vscode.tasks.onDidEndTaskProcess((event) => this.handleTaskProcessEnd(event)),
      vscode.tasks.onDidEndTask((event) => this.handleTaskEnd(event)),
      vscode.debug.onDidStartDebugSession((session) => this.announce("info", "Debug started", session.name, "Debug")),
      vscode.debug.onDidTerminateDebugSession((session) => this.announce("success", "Debug ended", session.name, "Debug")),
      vscode.window.onDidStartTerminalShellExecution((event) => this.watchTerminalShellOutput(event)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("cursorPets")) {
          this.reloadConfiguration();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.startAgentTranscriptWatchers();
      })
    );

    void this.loadCatalog().then(() => {
      this.ensureSelectedPetExists();
      this.refreshDiagnostics();
      this.touchActivity("CursorPets is awake.");
      this.render();
      this.scheduleAutoFloat();
      this.startAgentTranscriptWatchers();
    });
  }

  dispose(): void {
    this.stopAgentTranscriptWatchers();
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
    }
    this.clearAutoFloatTimers();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    if (vscode.workspace.getConfiguration("cursorPets").get("float.keepAliveOnReload", true)) {
      console.log("CursorPets leaving floating helper alive during shutdown.");
    } else {
      this.floatingHost.dispose();
    }
  }

  private createInitialState(): PetState {
    const config = vscode.workspace.getConfiguration("cursorPets");
    return {
      enabled: config.get("enabled", true),
      mood: "idle",
      message: "Ready when you are.",
      selectedPetId: config.get("pet", "nukey-preview"),
      animationLevel: config.get("animationLevel", "subtle"),
      diagnostics: { errors: 0, warnings: 0 },
      notifications: [],
      unreadNotifications: 0
    };
  }

  private async loadCatalog(): Promise<void> {
    const builtInCatalog = await this.readCatalog(this.context.asAbsolutePath(path.join("pets", "pets.json")));
    const importedCatalog = await this.readImportedCatalog();
    const config = vscode.workspace.getConfiguration("cursorPets");
    const customPath = config.get("petCatalogSource", "").trim();

    if (!customPath) {
      this.catalog = {
        version: 1,
        source: importedCatalog.pets.length > 0 ? "local-preview + imported-gitpets" : builtInCatalog.source,
        pets: [...builtInCatalog.pets, ...importedCatalog.pets]
      };
      return;
    }

    try {
      const customCatalog = await this.readCatalog(customPath);
      this.catalog = {
        version: customCatalog.version,
        source: customCatalog.source || customPath,
        pets: [...builtInCatalog.pets, ...importedCatalog.pets, ...customCatalog.pets]
      };
    } catch (error) {
      this.catalog = builtInCatalog;
      vscode.window.showWarningMessage(`CursorPets could not load the custom pet catalog: ${String(error)}`);
    }
  }

  private async readCatalog(filePath: string): Promise<PetCatalog> {
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as PetCatalog;
    if (!Array.isArray(parsed.pets)) {
      throw new Error("Invalid pet manifest: missing pets array.");
    }
    return parsed;
  }

  private async readImportedCatalog(): Promise<PetCatalog> {
    try {
      return await this.readCatalog(this.importedCatalogPath);
    } catch {
      return { version: 1, source: "imported-gitpets", pets: [] };
    }
  }

  private get importedCatalogPath(): string {
    return path.join(this.context.globalStorageUri.fsPath, "imported-pets.json");
  }

  private ensureSelectedPetExists(): void {
    if (this.catalog.pets.some((pet) => pet.id === this.state.selectedPetId)) {
      return;
    }
    this.state.selectedPetId = this.catalog.pets[0]?.id ?? "nukey-preview";
  }

  private reloadConfiguration(): void {
    const next = this.createInitialState();
    this.state = {
      ...this.state,
      enabled: next.enabled,
      selectedPetId: next.selectedPetId,
      animationLevel: next.animationLevel
    };
    void this.loadCatalog().then(() => {
      this.ensureSelectedPetExists();
      this.render();
      this.scheduleAutoFloat();
      this.startAgentTranscriptWatchers();
    });
  }

  private clearAutoFloatTimers(): void {
    for (const timer of this.startupTimers) {
      clearTimeout(timer);
    }
    this.startupTimers = [];
  }

  private stopAgentTranscriptWatchers(): void {
    if (this.agentTranscriptPollTimer) {
      clearTimeout(this.agentTranscriptPollTimer);
      this.agentTranscriptPollTimer = undefined;
    }
    for (const close of this.agentTranscriptWatchClosers) {
      try {
        close();
      } catch {
        // ignore
      }
    }
    this.agentTranscriptWatchClosers.length = 0;
  }

  private startAgentTranscriptWatchers(): void {
    this.stopAgentTranscriptWatchers();
    const cfg = vscode.workspace.getConfiguration("cursorPets");
    if (!cfg.get("agentTranscripts.enabled", true)) {
      return;
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const root = agentTranscriptsRootForWorkspace(folder.uri.fsPath);
      void fs.mkdir(root, { recursive: true }).catch(() => undefined);
      try {
        const watcher = fsWatch(root, { recursive: true }, () => this.scheduleAgentTranscriptPoll());
        this.agentTranscriptWatchClosers.push(() => watcher.close());
      } catch {
        // Missing until first Agent session in this workspace.
      }
    }
    this.scheduleAgentTranscriptPoll();
  }

  private scheduleAgentTranscriptPoll(): void {
    if (this.agentTranscriptPollTimer) {
      clearTimeout(this.agentTranscriptPollTimer);
    }
    this.agentTranscriptPollTimer = setTimeout(() => {
      this.agentTranscriptPollTimer = undefined;
      void this.pollAgentAssistantOutput();
    }, 550);
  }

  private async pollAgentAssistantOutput(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("cursorPets");
    if (!cfg.get("agentTranscripts.enabled", true)) {
      return;
    }
    const minChars = clamp(cfg.get("agentTranscripts.minChars", 24) as number, 8, 500);
    const maxBody = clamp(cfg.get("agentTranscripts.maxChars", 3200) as number, 200, 8000);
    const tailBytes = clamp(cfg.get("agentTranscripts.tailBytes", 800_000) as number, 60_000, 2_000_000);

    let newestPath: string | undefined;
    let newestM = 0;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const root = agentTranscriptsRootForWorkspace(folder.uri.fsPath);
      const paths = await collectAgentJsonlPaths(root);
      for (const p of paths) {
        try {
          const st = await fs.stat(p);
          if (st.mtimeMs > newestM) {
            newestM = st.mtimeMs;
            newestPath = p;
          }
        } catch {
          // ignore
        }
      }
    }
    if (!newestPath) {
      return;
    }
    let tail: string;
    try {
      tail = await readFileTailUtf8(newestPath, tailBytes);
    } catch {
      return;
    }
    const text = lastAssistantTextFromJsonlTail(tail);
    if (!text || text.length < minChars) {
      return;
    }
    const clipped = text.length > maxBody ? `${text.slice(0, maxBody - 3)}...` : text;
    const fp = createHash("sha256").update(clipped).digest("hex").slice(0, 24);
    if (fp === this.lastAgentTranscriptFingerprint) {
      return;
    }
    this.lastAgentTranscriptFingerprint = fp;
    const project =
      vscode.workspace.name ?? vscode.workspace.workspaceFolders?.[0]?.name ?? "Cursor";
    this.announce("info", "", clipped, "Cursor Agent", project);
  }

  private updateEnabled(enabled: boolean): void {
    void vscode.workspace.getConfiguration("cursorPets").update("enabled", enabled, vscode.ConfigurationTarget.Global);
    this.state.enabled = enabled;
    this.react(enabled ? "idle" : "waiting", enabled ? "Back on watch." : "I'll keep quiet.");
  }

  private resetPet(): void {
    this.react("idle", "Reset and ready.");
  }

  private handleTaskProcessEnd(event: vscode.TaskProcessEndEvent): void {
    const useExit = vscode.workspace.getConfiguration("cursorPets").get<boolean>("tasks.reactToProcessExit", true);
    if (!useExit) {
      return;
    }
    const name = event.execution.task.name;
    const code = event.exitCode;
    this.taskProcessExitAnnounced.set(event.execution, true);
    if (code === undefined) {
      this.announce("warning", "Task stopped", name, "Tasks");
      return;
    }
    if (code === 0) {
      this.announce("success", "Task succeeded", `${name} (exit 0)`, "Tasks");
      return;
    }
    this.announce("error", "Task failed", `${name} exited with code ${code}`, "Tasks");
  }

  private handleTaskEnd(event: vscode.TaskEndEvent): void {
    const useExit = vscode.workspace.getConfiguration("cursorPets").get<boolean>("tasks.reactToProcessExit", true);
    if (useExit && this.taskProcessExitAnnounced.has(event.execution)) {
      this.taskProcessExitAnnounced.delete(event.execution);
      return;
    }
    this.announce("success", "Task finished", event.execution.task.name, "Tasks");
  }

  /** Confirms in the UI that the float strip signal was received, then focuses chat. */
  private onFloatOpenChatSignal(): void {
    void vscode.window.setStatusBarMessage("$(comment-discussion) CursorPets — ouverture du chat…", 4500);
    console.log("CursorPets: float strip signal → open chat");
    void this.openCursorChatAfterFloatButton();
  }

  /** Float strip: the Swift window is another app — Cursor must become frontmost or workbench chat commands no-op. */
  private async macOSActivateCursorApplication(): Promise<void> {
    if (process.platform !== "darwin") {
      return;
    }
    const appName = vscode.env.appName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = `tell application "${appName}" to activate`;
    await Promise.race([
      new Promise<void>((resolve) => {
        const child = spawn("/usr/bin/osascript", ["-e", script], { stdio: "ignore" });
        child.once("error", () => resolve());
        child.once("close", () => resolve());
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 800))
    ]);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Float strip: activate Cursor, then reveal Agent / auxiliary UI before the generic focus chain. */
  private async openCursorChatAfterFloatButton(): Promise<void> {
    await this.macOSActivateCursorApplication();
    await this.delay(200);
    const run = async (id: string): Promise<void> => {
      try {
        await vscode.commands.executeCommand(id);
      } catch {
        /* missing in some builds */
      }
    };
    await run("workbench.action.openAgentsView");
    await this.delay(120);
    await run("workbench.action.focusAuxiliaryBar");
    await this.delay(120);
    await run("aichat.view");
    await this.delay(100);
    await run("workbench.action.chat.focusInput");
    await this.delay(80);
    await run("workbench.action.chat.focusInput");
    await this.openCursorChat();
  }

  /**
   * Brings Cursor’s **ongoing** Agent / chat to the front when possible.
   * Avoids leading with `workbench.action.chat.open`, which often starts a **new** thread.
   */
  private async openCursorChat(): Promise<void> {
    const tryExec = async (id: string): Promise<boolean> => {
      try {
        await vscode.commands.executeCommand(id);
        return true;
      } catch {
        return false;
      }
    };

    const tryFocusInput = (): Promise<boolean> => tryExec("workbench.action.chat.focusInput");

    if (await tryFocusInput()) {
      return;
    }

    const revealThenFocusInput = [
      "aichat.view",
      "workbench.action.openAgentsView",
      "workbench.action.toggleAgentsFromKeyboard",
      "workbench.action.focusAuxiliaryBar",
      "workbench.action.chat.toggle",
      "workbench.action.toggleAgents",
      "workbench.action.toggleAuxiliaryBar"
    ];

    for (const id of revealThenFocusInput) {
      if (await tryExec(id)) {
        await tryFocusInput();
        return;
      }
    }

    if (await tryExec("workbench.action.chat.open")) {
      return;
    }

    void vscode.window.showWarningMessage(
      "CursorPets could not focus AI chat. Use Cursor’s Agent / Chat shortcut (often Cmd+L or Cmd+I) from the keyboard."
    );
  }

  private handleWebviewAction(message: WebviewAction): void {
    if (message.type !== "cursorPets.action") {
      return;
    }

    switch (message.action) {
      case "selectPet":
        if (message.petId) {
          void this.selectPetById(message.petId);
        }
        break;
      case "toggleEnabled":
        this.updateEnabled(message.enabled ?? !this.state.enabled);
        break;
      case "resetPet":
        this.resetPet();
        break;
      case "importManifest":
        void this.importPetManifest();
        break;
      case "importGitPetsUrl":
        void this.importGitPetsUrl();
        break;
      case "openSource":
        if (message.url) {
          void this.openSource(message.url);
        }
        break;
      case "floatPet":
        void this.openFloatingPet();
        break;
      case "clearNotifications":
        this.clearNotifications();
        break;
    }
  }

  private async selectPet(): Promise<void> {
    const items = this.catalog.pets.map((pet) => ({
      label: pet.name,
      description: `by ${pet.author}`,
      detail: pet.description,
      pet
    }));
    const selected = await vscode.window.showQuickPick(items, {
      title: "Select CursorPet",
      placeHolder: "Choose a GitPets-compatible pet"
    });

    if (!selected) {
      return;
    }

    this.state.selectedPetId = selected.pet.id;
    await this.selectPetById(selected.pet.id);
  }

  private async selectPetById(petId: string): Promise<void> {
    const pet = this.catalog.pets.find((candidate) => candidate.id === petId);
    if (!pet) {
      vscode.window.showWarningMessage(`CursorPets could not find pet "${petId}".`);
      return;
    }

    this.state.selectedPetId = pet.id;
    await vscode.workspace.getConfiguration("cursorPets").update("pet", pet.id, vscode.ConfigurationTarget.Global);
    this.announce("success", "Pet selected", `${pet.name} joined the workspace.`, "CursorPets");
  }

  private async importPetManifest(): Promise<void> {
    const mode = await vscode.window.showQuickPick(
      [
        { label: "Import GitPets URL from clipboard", description: "Copy the GitPets URL first, then choose this option", action: "gitpetsClipboard" },
        { label: "Import GitPets URL", description: "Paste a URL such as https://gitpets.com/pets/steve-80aac76c", action: "gitpets" },
        { label: "Import local manifest", description: "Choose a CursorPets JSON manifest file", action: "manifest" }
      ],
      { title: "Import CursorPet" }
    );

    if (!mode) {
      return;
    }

    if (mode.action === "gitpets") {
      await this.importGitPetsUrl();
      return;
    }

    if (mode.action === "gitpetsClipboard") {
      await this.importGitPetsUrlFromClipboard();
      return;
    }

    const picked = await vscode.window.showOpenDialog({
      title: "Import CursorPets Manifest",
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { JSON: ["json"] }
    });

    const manifestPath = picked?.[0]?.fsPath;
    if (!manifestPath) {
      return;
    }

    await vscode.workspace.getConfiguration("cursorPets").update("petCatalogSource", manifestPath, vscode.ConfigurationTarget.Global);
    await this.loadCatalog();
    this.ensureSelectedPetExists();
    this.announce("success", "Pet manifest imported", path.basename(manifestPath), "CursorPets");
  }

  private async importGitPetsUrl(): Promise<void> {
    const clipboardValue = await vscode.env.clipboard.readText();
    const url = await vscode.window.showInputBox({
      title: "Import GitPets pet",
      prompt: "Paste a GitPets pet URL.",
      placeHolder: "https://gitpets.com/pets/steve-80aac76c",
      value: isGitPetsPetUrl(clipboardValue) ? clipboardValue.trim() : undefined,
      ignoreFocusOut: true,
      validateInput: (value) => validateGitPetsPetUrl(value)
    });

    if (!url) {
      return;
    }

    await this.importGitPetsUrlValue(url);
  }

  private async importGitPetsUrlFromClipboard(): Promise<void> {
    const url = (await vscode.env.clipboard.readText()).trim();
    const validation = validateGitPetsPetUrl(url);
    if (validation) {
      vscode.window.showWarningMessage(`${validation} Clipboard currently contains: ${url || "(empty)"}`);
      return;
    }

    await this.importGitPetsUrlValue(url);
  }

  private async importGitPetsUrlValue(url: string): Promise<void> {
    try {
      const normalizedUrl = normalizeGitPetsPetUrl(url);
      const pet = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Importing GitPets pet",
          cancellable: false
        },
        () => fetchGitPetsDefinition(normalizedUrl)
      );
      await this.saveImportedPet(pet);
      await this.loadCatalog();
      await this.selectPetById(pet.id);
      this.announce("success", "GitPets import complete", pet.name, "CursorPets");
      vscode.window.showInformationMessage(`Imported ${pet.name} from GitPets.`);
    } catch (error) {
      this.announce("error", "GitPets import failed", String(error), "CursorPets");
      vscode.window.showErrorMessage(`CursorPets could not import that GitPets URL: ${String(error)}`);
    }
  }

  private async saveImportedPet(pet: PetDefinition): Promise<void> {
    await fs.mkdir(path.dirname(this.importedCatalogPath), { recursive: true });
    const importedCatalog = await this.readImportedCatalog();
    const pets = importedCatalog.pets.filter((candidate) => candidate.id !== pet.id);
    pets.push(pet);
    await fs.writeFile(
      this.importedCatalogPath,
      `${JSON.stringify({ version: 1, source: "imported-gitpets", pets }, null, 2)}\n`,
      "utf8"
    );
  }

  private async openSource(url: string): Promise<void> {
    try {
      const uri = vscode.Uri.parse(url);
      await vscode.env.openExternal(uri);
    } catch {
      vscode.window.showWarningMessage(`CursorPets could not open source URL: ${url}`);
    }
  }

  private async openFloatingPet(announceLaunch = true): Promise<void> {
    if (process.platform !== "darwin") {
      vscode.window.showWarningMessage("CursorPets floating mode is currently implemented for macOS only.");
      return;
    }

    const pet = this.catalog.pets.find((candidate) => candidate.id === this.state.selectedPetId);
    try {
      await this.floatingHost.show(this.createFloatingSnapshot(pet));
      if (announceLaunch) {
        this.announce("success", "Floating pet launched", pet?.name ?? "CursorPet", "CursorPets");
      }
    } catch (error) {
      console.error("CursorPets floating pet launch failed.", error);
      this.announce("error", "Floating pet failed", String(error), "CursorPets");
      vscode.window.showErrorMessage(`CursorPets could not launch floating mode: ${String(error)}`);
    }
  }

  private scheduleAutoFloat(): void {
    this.clearAutoFloatTimers();
    if (!vscode.workspace.getConfiguration("cursorPets").get("float.autoStart", true)) {
      console.log("CursorPets auto-start disabled.");
      return;
    }

    for (const delay of [250, 1_500, 5_000, 10_000]) {
      const timer = setTimeout(() => {
        console.log(`CursorPets auto-start attempt after ${delay}ms.`);
        void this.openFloatingPet(false);
      }, delay);
      this.startupTimers.push(timer);
    }
  }

  private diagnoseStartup(): void {
    const config = vscode.workspace.getConfiguration("cursorPets");
    const message = [
      "CursorPets diagnostics",
      `enabled=${config.get("enabled", true)}`,
      `float.autoStart=${config.get("float.autoStart", true)}`,
      `platform=${process.platform}`,
      `helper=${this.floatingHost.helperPath}`,
      `state=${this.floatingHost.snapshotPath}`,
      `openChatSignal=${this.floatingHost.openChatSignalPath}`
    ].join("\n");
    vscode.window.showInformationMessage(message, { modal: true });
    console.log(message);
  }

  private async installLoginLaunchAgent(): Promise<void> {
    try {
      const pet = this.catalog.pets.find((candidate) => candidate.id === this.state.selectedPetId);
      await this.floatingHost.installLaunchAgent(this.createFloatingSnapshot(pet));
      vscode.window.showInformationMessage("CursorPets LaunchAgent installed. The floating pet will start at macOS login.");
    } catch (error) {
      vscode.window.showErrorMessage(`CursorPets could not install LaunchAgent: ${String(error)}`);
    }
  }

  private async uninstallLoginLaunchAgent(): Promise<void> {
    try {
      await this.floatingHost.uninstallLaunchAgent();
      vscode.window.showInformationMessage("CursorPets LaunchAgent uninstalled.");
    } catch (error) {
      vscode.window.showErrorMessage(`CursorPets could not uninstall LaunchAgent: ${String(error)}`);
    }
  }

  private watchTerminalShellOutput(event: vscode.TerminalShellExecutionStartEvent): void {
    if (!vscode.workspace.getConfiguration("cursorPets").get("terminal.announceOutput", false)) {
      return;
    }

    void this.collectTerminalOutput(event.execution, event.terminal);
  }

  private async collectTerminalOutput(execution: vscode.TerminalShellExecution, terminal: vscode.Terminal): Promise<void> {
    const config = vscode.workspace.getConfiguration("cursorPets");
    const maxChars = clamp(config.get("terminal.maxOutputChars", 220), 80, 1000);
    let output = "";

    try {
      for await (const chunk of execution.read()) {
        output = trimTerminalOutput(`${output}${stripAnsi(chunk)}`, maxChars);
        if (output.length >= maxChars) {
          break;
        }
      }
    } catch (error) {
      console.log("CursorPets could not read terminal output.", error);
      return;
    }

    const cleaned = trimTerminalOutput(output, maxChars);
    if (!cleaned) {
      return;
    }

    const projectTitle = resolveProjectTitleForTerminal(terminal);
    this.announce(
      "info",
      shortCommand(execution.commandLine.value || "Terminal command"),
      cleaned,
      "Terminal",
      projectTitle
    );
  }

  private refreshDiagnostics(): void {
    if (!vscode.workspace.getConfiguration("cursorPets").get("reactToDiagnostics", true)) {
      return;
    }

    const diagnostics = vscode.languages.getDiagnostics();
    let errors = 0;
    let warnings = 0;
    for (const [, entries] of diagnostics) {
      for (const entry of entries) {
        if (entry.severity === vscode.DiagnosticSeverity.Error) {
          errors += 1;
        }
        if (entry.severity === vscode.DiagnosticSeverity.Warning) {
          warnings += 1;
        }
      }
    }

    this.state.diagnostics = { errors, warnings };
    if (errors === this.lastDiagnostics.errors && warnings === this.lastDiagnostics.warnings) {
      return;
    }
    this.lastDiagnostics = { errors, warnings };

    if (errors > 0) {
      this.announce("error", "Diagnostics changed", `${errors} error${errors === 1 ? "" : "s"} to inspect.`, "Diagnostics");
      return;
    }
    if (warnings > 0) {
      this.announce("warning", "Diagnostics changed", `${warnings} warning${warnings === 1 ? "" : "s"} nearby.`, "Diagnostics");
      return;
    }
    this.announce("success", "Diagnostics clear", "No errors or warnings.", "Diagnostics");
  }

  private async announceFromClipboard(): Promise<void> {
    const raw = (await vscode.env.clipboard.readText()).trim();
    if (!raw) {
      vscode.window.showWarningMessage("Clipboard is empty — copy a Cursor Chat reply (or any text) first.");
      return;
    }
    const maxChars = 3_500;
    const text = raw.length > maxChars ? `${raw.slice(0, maxChars - 3)}...` : raw;
    const project =
      vscode.workspace.name ?? vscode.workspace.workspaceFolders?.[0]?.name ?? "Cursor";
    this.announce("info", "", text, "Clipboard", project);
  }

  private async announceNotificationFromInput(): Promise<void> {
    const body = await vscode.window.showInputBox({
      title: "Announce with CursorPets",
      prompt: "Message for the pet to announce.",
      placeHolder: "Build finished, tests failed, deploy completed..."
    });

    if (!body) {
      return;
    }

    this.announce("info", "Cursor notification", body, "Manual");
  }

  private announce(
    level: PetNotificationLevel,
    title: string,
    body: string,
    source: string,
    messageHeadline?: string
  ): void {
    const notificationTitle = messageHeadline ?? title;
    const notificationBody =
      messageHeadline !== undefined
        ? body.length > 0
          ? title.length > 0
            ? `${title}\n${body}`
            : body
          : title
        : body;
    const notification: PetNotification = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      level,
      title: notificationTitle,
      body: notificationBody,
      source,
      createdAt: new Date().toISOString()
    };
    const mood = notificationMood(level);
    let message: string;
    if (messageHeadline !== undefined) {
      let detail: string;
      if (body.length > 0) {
        detail = title.length > 0 ? `${title}\n${body}` : body;
      } else {
        detail = title;
      }
      message = `${messageHeadline}\n${detail}`;
    } else {
      message = body ? `${title}: ${body}` : title;
    }
    this.state = {
      ...this.state,
      mood,
      message,
      notifications: [notification, ...this.state.notifications].slice(0, 8),
      unreadNotifications: Math.min(this.state.unreadNotifications + 1, 99),
      notificationWaveUntil: Date.now() + 2_600
    };
    this.touchActivity(message);
    this.render();
  }

  private clearNotifications(): void {
    this.state = {
      ...this.state,
      notifications: [],
      unreadNotifications: 0,
      message: "Notifications cleared.",
      mood: "idle",
      notificationWaveUntil: undefined
    };
    this.render();
  }

  private react(mood: PetMood, message: string): void {
    this.state = { ...this.state, mood, message };
    this.touchActivity(message);
    this.render();
  }

  private touchActivity(message?: string): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
    }
    this.inactivityTimer = setTimeout(() => {
      this.state = {
        ...this.state,
        mood: "waiting",
        message: message === "I'll keep quiet." ? "Still quiet." : "Quiet moment. I am still here."
      };
      this.render();
    }, INACTIVITY_MS);
  }

  private render(): void {
    const pet = this.catalog.pets.find((candidate) => candidate.id === this.state.selectedPetId);
    this.statusBar.text = this.state.enabled ? `$(sparkle) ${pet?.name ?? "CursorPet"}` : "$(circle-slash) CursorPets";
    this.statusBar.show();
    this.provider.update();
    void this.floatingHost.update(this.createFloatingSnapshot(pet));
  }

  private createFloatingSnapshot(pet: PetDefinition | undefined): FloatingPetSnapshot {
    const config = vscode.workspace.getConfiguration("cursorPets");
    return {
      state: this.state,
      pet,
      options: {
        backgroundOpacity: clamp(config.get("float.backgroundOpacity", 0), 0, 1),
        messageOpacity: clamp(config.get("float.messageOpacity", 0.42), 0, 1),
        showFrame: config.get("float.showFrame", false)
      }
    };
  }
}

class FloatingPetHost implements vscode.Disposable {
  private static readonly launchAgentLabel = "com.cursorpets.float";
  private process: ChildProcess | undefined;
  private readonly statePath: string;
  private readonly signalPath: string;
  private readonly scriptPath: string;
  private signalFileWatchActive = false;
  private lastHandledFloatSignal = "";
  private signalDebounce: NodeJS.Timeout | undefined;
  private readonly onOpenChatFromFloat: () => void;

  constructor(context: vscode.ExtensionContext, onOpenChatFromFloat: () => void) {
    this.onOpenChatFromFloat = onOpenChatFromFloat;
    this.statePath = path.join(context.globalStorageUri.fsPath, "floating-pet-state.json");
    this.signalPath = path.join(path.dirname(this.statePath), "floating-pet-open-chat.signal");
    this.scriptPath = context.asAbsolutePath(path.join("floating-host", "macos", "CursorPetsFloat.swift"));
    if (process.platform === "darwin") {
      void this.ensureSignalFileAndWatcher();
    }
  }

  get helperPath(): string {
    return this.scriptPath;
  }

  get snapshotPath(): string {
    return this.statePath;
  }

  get openChatSignalPath(): string {
    return this.signalPath;
  }

  private async ensureSignalFileAndWatcher(): Promise<void> {
    await fs.mkdir(path.dirname(this.signalPath), { recursive: true });
    await fs.writeFile(this.signalPath, "0\n", "utf8").catch(() => undefined);
    this.ensureSignalWatcher();
  }

  private ensureSignalWatcher(): void {
    if (process.platform !== "darwin" || this.signalFileWatchActive) {
      return;
    }
    this.signalFileWatchActive = true;
    // `fs.watch` often misses updates when another process replaces the file (Swift atomic write).
    // `watchFile` stat-polls and reliably sees mtime/size changes on macOS.
    watchFile(this.signalPath, { interval: 200 }, (curr: Stats, prev: Stats) => {
      if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) {
        return;
      }
      void (async () => {
        try {
          const t = (await fs.readFile(this.signalPath, "utf8")).trim();
          if (t === "" || t === "0") {
            return;
          }
          if (t === this.lastHandledFloatSignal) {
            return;
          }
          this.lastHandledFloatSignal = t;
          if (this.signalDebounce) {
            clearTimeout(this.signalDebounce);
          }
          this.signalDebounce = setTimeout(() => {
            console.log("CursorPets: float open-chat signal file changed");
            this.onOpenChatFromFloat();
          }, 80);
        } catch {
          /* missing file or race */
        }
      })();
    });
  }

  async show(snapshot: FloatingPetSnapshot): Promise<void> {
    await this.update(snapshot);
    await this.ensureSignalFileAndWatcher();

    if (this.process && !this.process.killed && isPidAlive(this.process.pid)) {
      console.log("CursorPets floating helper already running.");
      return;
    }

    this.process = undefined;
    if (process.platform === "darwin") {
      killAllFloatingPetSwiftProcesses();
    }

    console.log("CursorPets launching floating helper.", this.scriptPath);
    const floatingProcess = spawn("/usr/bin/swift", [this.scriptPath, this.signalPath, this.statePath], {
      detached: true,
      stdio: "ignore"
    });
    floatingProcess.unref();
    floatingProcess.on("exit", () => {
      if (this.process === floatingProcess) {
        this.process = undefined;
      }
    });
    this.process = floatingProcess;
  }

  async update(snapshot: FloatingPetSnapshot): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.writeFile(this.statePath, JSON.stringify(snapshot), "utf8");
  }

  async installLaunchAgent(snapshot: FloatingPetSnapshot): Promise<void> {
    await this.update(snapshot);
    await this.ensureSignalFileAndWatcher();
    const launchAgentsDir = path.join(process.env.HOME ?? "", "Library", "LaunchAgents");
    const plistPath = path.join(launchAgentsDir, `${FloatingPetHost.launchAgentLabel}.plist`);
    await fs.mkdir(launchAgentsDir, { recursive: true });
    await fs.writeFile(plistPath, this.createLaunchAgentPlist(), "utf8");
    await runCommand("/bin/launchctl", ["unload", plistPath]).catch(() => undefined);
    await runCommand("/bin/launchctl", ["load", plistPath]);
  }

  async uninstallLaunchAgent(): Promise<void> {
    const plistPath = path.join(process.env.HOME ?? "", "Library", "LaunchAgents", `${FloatingPetHost.launchAgentLabel}.plist`);
    await runCommand("/bin/launchctl", ["unload", plistPath]).catch(() => undefined);
    await fs.rm(plistPath, { force: true });
  }

  private createLaunchAgentPlist(): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${FloatingPetHost.launchAgentLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/swift</string>
    <string>${escapePlistString(this.scriptPath)}</string>
    <string>${escapePlistString(this.signalPath)}</string>
    <string>${escapePlistString(this.statePath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>/tmp/cursorpets-float.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/cursorpets-float.err</string>
</dict>
</plist>
`;
  }

  dispose(): void {
    if (this.signalDebounce) {
      clearTimeout(this.signalDebounce);
    }
    if (this.signalFileWatchActive) {
      unwatchFile(this.signalPath);
      this.signalFileWatchActive = false;
    }
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
  }
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

function isPidAlive(pid: number | undefined): boolean {
  if (pid === undefined || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killAllFloatingPetSwiftProcesses(): void {
  try {
    execFileSync("pkill", ["-f", "CursorPetsFloat.swift"], { stdio: "ignore" });
  } catch {
    // pkill exits 1 when nothing matched
  }
}

function escapePlistString(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

class CursorPetsViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getState: () => PetState,
    private readonly getCatalog: () => PetCatalog,
    private readonly onAction: (message: WebviewAction) => void
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(this.context.asAbsolutePath("media")),
        vscode.Uri.file(this.context.asAbsolutePath("pets"))
      ]
    };
    webviewView.webview.onDidReceiveMessage((message: WebviewAction) => this.onAction(message));
    webviewView.webview.html = this.getHtml(webviewView.webview);
    this.update();
  }

  update(): void {
    if (!this.view) {
      return;
    }
    void this.view.webview.postMessage({
      type: "cursorPets.update",
      state: this.getState(),
      catalog: this.getCatalog()
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.file(this.context.asAbsolutePath(path.join("media", "main.js"))));
    const styleUri = webview.asWebviewUri(vscode.Uri.file(this.context.asAbsolutePath(path.join("media", "main.css"))));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https: data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>CursorPets</title>
</head>
<body>
  <main id="app" class="app" aria-live="polite">
    <section class="pet-stage">
      <div id="pet" class="pet nukey-preview idle subtle" role="img" aria-label="CursorPet">
        <div class="pet-shadow"></div>
        <div class="pet-body">
          <div class="pet-ear pet-ear-left"></div>
          <div class="pet-ear pet-ear-right"></div>
          <div class="pet-face">
            <span class="eye eye-left"></span>
            <span class="eye eye-right"></span>
            <span class="mouth"></span>
          </div>
        </div>
      </div>
    </section>
    <section class="pet-info">
      <div class="eyebrow" id="source">local-preview</div>
      <h1 id="petName">CursorPet</h1>
      <p id="message">Ready when you are.</p>
      <div class="toolbar" aria-label="CursorPets actions">
        <button id="toggleEnabled" type="button">Pause</button>
        <button id="resetPet" type="button">Reset</button>
        <button id="floatPet" type="button">Float</button>
        <button id="importManifest" type="button">Import</button>
      </div>
      <dl>
        <div>
          <dt>Mood</dt>
          <dd id="mood">idle</dd>
        </div>
        <div>
          <dt>Diagnostics</dt>
          <dd id="diagnostics">0 errors, 0 warnings</dd>
        </div>
      </dl>
      <p class="attribution" id="attribution">GitPets-compatible local preview.</p>
      <button id="openSource" class="link-button" type="button">Open source</button>
      <section class="notifications" aria-labelledby="notificationsTitle">
        <div class="section-heading">
          <h2 id="notificationsTitle">Notifications</h2>
          <button id="clearNotifications" class="mini-button" type="button">Clear</button>
        </div>
        <div id="notificationList" class="notification-list"></div>
      </section>
      <section class="picker" aria-labelledby="pickerTitle">
        <h2 id="pickerTitle">Pets</h2>
        <div id="petList" class="pet-list"></div>
      </section>
    </section>
  </main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let index = 0; index < 32; index += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function notificationMood(level: PetNotificationLevel): PetMood {
  switch (level) {
    case "error":
      return "concerned";
    case "warning":
      return "focused";
    case "success":
      return "happy";
    case "info":
    default:
      return "focused";
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getTerminalShellCwd(terminal: vscode.Terminal): vscode.Uri | undefined {
  const withShell = terminal as vscode.Terminal & {
    shellIntegration?: { cwd?: vscode.Uri };
  };
  const fromShell = withShell.shellIntegration?.cwd;
  if (fromShell) {
    return fromShell;
  }
  const opts = terminal.creationOptions;
  if (opts && typeof opts === "object" && "cwd" in opts) {
    const raw = (opts as { cwd?: string | vscode.Uri }).cwd;
    if (typeof raw === "string" && raw.length > 0) {
      return vscode.Uri.file(raw);
    }
    if (raw instanceof vscode.Uri) {
      return raw;
    }
  }
  return undefined;
}

function resolveProjectTitleForTerminal(terminal: vscode.Terminal): string {
  const cwd = getTerminalShellCwd(terminal);
  if (cwd) {
    const folder = vscode.workspace.getWorkspaceFolder(cwd);
    if (folder) {
      return folder.name;
    }
    const base = path.basename(cwd.fsPath);
    if (base && base !== "." && base !== "/") {
      return base;
    }
  }
  if (vscode.workspace.name) {
    return vscode.workspace.name;
  }
  const first = vscode.workspace.workspaceFolders?.[0];
  if (first) {
    return first.name;
  }
  return "Cursor";
}

type AgentTranscriptLine = {
  role?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
};

function agentTranscriptsRootForWorkspace(workspaceFsPath: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const norm = path.normalize(workspaceFsPath);
  const stripped = norm.replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-");
  return path.join(home, ".cursor", "projects", stripped, "agent-transcripts");
}

async function collectAgentJsonlPaths(agentRoot: string): Promise<string[]> {
  let dirEntries: Dirent[];
  try {
    dirEntries = await fs.readdir(agentRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const entry of dirEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const sub = path.join(agentRoot, String(entry.name));
    let files: string[];
    try {
      files = await fs.readdir(sub);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith(".jsonl")) {
        paths.push(path.join(sub, f));
      }
    }
  }
  return paths;
}

async function readFileTailUtf8(filePath: string, maxTailBytes: number): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const size = stat.size;
    if (size === 0) {
      return "";
    }
    const readSize = Math.min(maxTailBytes, size);
    const start = size - readSize;
    const buffer = Buffer.alloc(readSize);
    await handle.read(buffer, 0, readSize, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

function extractAssistantVisibleText(line: unknown): string | undefined {
  if (!line || typeof line !== "object") {
    return undefined;
  }
  const L = line as AgentTranscriptLine;
  if (L.role !== "assistant" || !Array.isArray(L.message?.content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const block of L.message.content) {
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  const joined = parts.join("\n").trim();
  if (!joined) {
    return undefined;
  }
  const cleaned = joined
    .split("\n")
    .map((ln) => ln.trim())
    .filter((ln) => ln.length > 0 && ln !== "[REDACTED]")
    .join("\n")
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function lastAssistantTextFromJsonlTail(tailContent: string): string | undefined {
  const lines = tailContent.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (!line) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const text = extractAssistantVisibleText(parsed);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "");
}

function trimTerminalOutput(value: string, maxChars: number): string {
  const cleaned = value
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();

  if (cleaned.length <= maxChars) {
    return cleaned;
  }

  return `...${cleaned.slice(cleaned.length - maxChars + 3)}`;
}

function shortCommand(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 44) {
    return trimmed;
  }
  return `${trimmed.slice(0, 41)}...`;
}

async function fetchGitPetsDefinition(url: string): Promise<PetDefinition> {
  const html = await fetchText(url);
  const slug = new URL(url).pathname.split("/").filter(Boolean).at(-1);
  if (!slug) {
    throw new Error("Missing GitPets slug.");
  }

  const decodedHtml = html.replace(/\\"/g, "\"");
  const petsMatch = html.match(/"pets":(\[.*?\]),"showSearch"/s) ?? decodedHtml.match(/"pets":(\[.*?\]),"showSearch"/s);
  if (!petsMatch) {
    throw new Error("Could not find GitPets pet metadata on the page.");
  }

  const [rawPet] = JSON.parse(petsMatch[1]) as Array<{
    petId: string;
    slug: string;
    displayName: string;
    description: string;
    sourceUrl: string;
    spritesheetUrl: string;
  }>;

  if (!rawPet?.spritesheetUrl) {
    throw new Error("GitPets metadata did not include a spritesheet URL.");
  }

  const author = rawPet.sourceUrl.match(/^https:\/\/github\.com\/([^/]+)/)?.[1] ?? "GitPets";

  return {
    id: `gitpets-${rawPet.slug ?? slug}`,
    name: rawPet.displayName,
    author: `@${author}`,
    description: rawPet.description,
    sourceUrl: url,
    asset: {
      type: "spritesheet",
      entry: rawPet.spritesheetUrl,
      frames: 6,
      row: 0,
      notifyRow: 3,
      notifyFrames: 4,
      walkRowDown: 0,
      walkRowLeft: 2,
      walkRowRight: 1,
      walkRowUp: 4,
      walkFrames: 4,
      scale: 0.84,
      frameWidth: 192,
      frameHeight: 208,
      sheetWidth: 1536,
      sheetHeight: 1872
    },
    states: ["idle", "focused", "happy", "waiting", "concerned"]
  };
}

function validateGitPetsPetUrl(value: string): string | undefined {
  if (!isGitPetsPetUrl(value)) {
    return "Use a GitPets pet URL like https://gitpets.com/pets/steve-80aac76c";
  }
  return undefined;
}

function isGitPetsPetUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "https:" && parsed.hostname === "gitpets.com" && /^\/pets\/[a-z0-9-]+\/?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function normalizeGitPetsPetUrl(value: string): string {
  const parsed = new URL(value.trim());
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  return parsed.toString();
}

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = https
      .get(url, { timeout: 15_000 }, (response) => {
        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error(`HTTP ${response.statusCode}`));
          response.resume();
          return;
        }

        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => resolve(data));
      })
      .on("error", reject);
    request.on("timeout", () => {
      request.destroy(new Error("GitPets request timed out after 15 seconds."));
    });
  });
}
