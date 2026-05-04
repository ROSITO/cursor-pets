import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ChildProcess, spawn } from "node:child_process";
import * as https from "node:https";
import * as vscode from "vscode";

type PetMood = "idle" | "focused" | "happy" | "waiting" | "concerned";
type PetNotificationLevel = "info" | "success" | "warning" | "error";

interface PetAsset {
  type: "css" | "image" | "spritesheet";
  entry: string;
  frames?: number;
  row?: number;
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
}

const VIEW_ID = "cursorPets.petView";
const INACTIVITY_MS = 90_000;

export function activate(context: vscode.ExtensionContext): void {
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
  private catalog: PetCatalog = { version: 1, source: "empty", pets: [] };
  private state: PetState;
  private lastDiagnostics = { errors: 0, warnings: 0 };

  constructor(private readonly context: vscode.ExtensionContext) {
    this.state = this.createInitialState();
    this.provider = new CursorPetsViewProvider(
      context,
      () => this.state,
      () => this.catalog,
      (message) => this.handleWebviewAction(message)
    );
    this.floatingHost = new FloatingPetHost(context);
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
      vscode.workspace.onDidSaveTextDocument((document) => this.announce("success", "File saved", path.basename(document.fileName), "Workspace")),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.react("focused", `Editing ${path.basename(editor.document.fileName)}.`);
        }
      }),
      vscode.languages.onDidChangeDiagnostics(() => this.refreshDiagnostics()),
      vscode.tasks.onDidStartTask((event) => this.announce("info", "Task started", event.execution.task.name, "Tasks")),
      vscode.tasks.onDidEndTask((event) => this.announce("success", "Task finished", event.execution.task.name, "Tasks")),
      vscode.debug.onDidStartDebugSession((session) => this.announce("info", "Debug started", session.name, "Debug")),
      vscode.debug.onDidTerminateDebugSession((session) => this.announce("success", "Debug ended", session.name, "Debug")),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("cursorPets")) {
          this.reloadConfiguration();
        }
      })
    );

    void this.loadCatalog().then(() => {
      this.ensureSelectedPetExists();
      this.refreshDiagnostics();
      this.touchActivity("CursorPets is awake.");
      this.render();
    });
  }

  dispose(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.floatingHost.dispose();
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
    });
  }

  private updateEnabled(enabled: boolean): void {
    void vscode.workspace.getConfiguration("cursorPets").update("enabled", enabled, vscode.ConfigurationTarget.Global);
    this.state.enabled = enabled;
    this.react(enabled ? "idle" : "waiting", enabled ? "Back on watch." : "I'll keep quiet.");
  }

  private resetPet(): void {
    this.react("idle", "Reset and ready.");
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

  private async openFloatingPet(): Promise<void> {
    if (process.platform !== "darwin") {
      vscode.window.showWarningMessage("CursorPets floating mode is currently implemented for macOS only.");
      return;
    }

    const pet = this.catalog.pets.find((candidate) => candidate.id === this.state.selectedPetId);
    try {
      await this.floatingHost.show({ state: this.state, pet });
      this.announce("success", "Floating pet launched", pet?.name ?? "CursorPet", "CursorPets");
    } catch (error) {
      this.announce("error", "Floating pet failed", String(error), "CursorPets");
      vscode.window.showErrorMessage(`CursorPets could not launch floating mode: ${String(error)}`);
    }
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

  private announce(level: PetNotificationLevel, title: string, body: string, source: string): void {
    const notification: PetNotification = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      level,
      title,
      body,
      source,
      createdAt: new Date().toISOString()
    };
    const mood = notificationMood(level);
    const message = body ? `${title}: ${body}` : title;
    this.state = {
      ...this.state,
      mood,
      message,
      notifications: [notification, ...this.state.notifications].slice(0, 8),
      unreadNotifications: Math.min(this.state.unreadNotifications + 1, 99)
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
      mood: "idle"
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
    void this.floatingHost.update({ state: this.state, pet });
  }
}

class FloatingPetHost implements vscode.Disposable {
  private process: ChildProcess | undefined;
  private readonly statePath: string;
  private readonly scriptPath: string;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.statePath = path.join(context.globalStorageUri.fsPath, "floating-pet-state.json");
    this.scriptPath = context.asAbsolutePath(path.join("floating-host", "macos", "CursorPetsFloat.swift"));
  }

  async show(snapshot: FloatingPetSnapshot): Promise<void> {
    await this.update(snapshot);

    if (this.process && !this.process.killed) {
      return;
    }

    const floatingProcess = spawn("/usr/bin/swift", [this.scriptPath, this.statePath], {
      detached: true,
      stdio: "ignore"
    });
    floatingProcess.unref();
    this.process = floatingProcess;
  }

  async update(snapshot: FloatingPetSnapshot): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.writeFile(this.statePath, JSON.stringify(snapshot), "utf8");
  }

  dispose(): void {
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
  }
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
