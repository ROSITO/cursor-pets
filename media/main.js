const petEl = document.querySelector("#pet");
const petNameEl = document.querySelector("#petName");
const messageEl = document.querySelector("#message");
const moodEl = document.querySelector("#mood");
const diagnosticsEl = document.querySelector("#diagnostics");
const attributionEl = document.querySelector("#attribution");
const sourceEl = document.querySelector("#source");
const appEl = document.querySelector("#app");
const petListEl = document.querySelector("#petList");
const toggleEnabledEl = document.querySelector("#toggleEnabled");
const resetPetEl = document.querySelector("#resetPet");
const importManifestEl = document.querySelector("#importManifest");
const floatPetEl = document.querySelector("#floatPet");
const openSourceEl = document.querySelector("#openSource");
const notificationListEl = document.querySelector("#notificationList");
const clearNotificationsEl = document.querySelector("#clearNotifications");
const vscode = acquireVsCodeApi();

let latestState;
let latestCatalog;
let selectedPet;

toggleEnabledEl.addEventListener("click", () => {
  vscode.postMessage({
    type: "cursorPets.action",
    action: "toggleEnabled",
    enabled: !latestState?.enabled
  });
});

resetPetEl.addEventListener("click", () => {
  vscode.postMessage({ type: "cursorPets.action", action: "resetPet" });
});

importManifestEl.addEventListener("click", () => {
  vscode.postMessage({ type: "cursorPets.action", action: "importManifest" });
});

floatPetEl.addEventListener("click", () => {
  vscode.postMessage({ type: "cursorPets.action", action: "floatPet" });
});

clearNotificationsEl.addEventListener("click", () => {
  vscode.postMessage({ type: "cursorPets.action", action: "clearNotifications" });
});

openSourceEl.addEventListener("click", () => {
  if (!selectedPet?.sourceUrl) {
    return;
  }
  vscode.postMessage({
    type: "cursorPets.action",
    action: "openSource",
    url: selectedPet.sourceUrl
  });
});

window.addEventListener("message", (event) => {
  const payload = event.data;
  if (payload?.type !== "cursorPets.update") {
    return;
  }

  const { state, catalog } = payload;
  latestState = state;
  latestCatalog = catalog;
  const pet = catalog.pets.find((candidate) => candidate.id === state.selectedPetId) ?? catalog.pets[0];
  selectedPet = pet;

  appEl.classList.toggle("disabled", !state.enabled);
  petEl.className = [
    "pet",
    pet?.asset?.type === "css" ? pet.asset.entry : "gitpets-sprite",
    pet?.asset?.type === "spritesheet" ? "spritesheet-pet" : "",
    state.mood,
    state.animationLevel
  ].filter(Boolean).join(" ");
  petEl.style.removeProperty("--spritesheet-url");
  petEl.style.removeProperty("--pet-frames");
  petEl.style.removeProperty("--pet-row");
  petEl.style.removeProperty("--pet-scale");
  if (pet?.asset?.type === "spritesheet") {
    const frameWidth = pet.asset.frameWidth ?? 192;
    const frameHeight = pet.asset.frameHeight ?? 208;
    const sheetWidth = pet.asset.sheetWidth ?? 1536;
    const sheetHeight = pet.asset.sheetHeight ?? 1872;
    const sheetCols = sheetWidth / frameWidth;
    const sheetRows = sheetHeight / frameHeight;
    const frames = pet.asset.frames ?? 6;
    const row = pet.asset.row ?? 0;

    petEl.style.setProperty("--spritesheet-url", `url("${pet.asset.entry}")`);
    petEl.style.setProperty("--pet-frames", String(frames));
    petEl.style.setProperty("--pet-scale", String(pet.asset.scale ?? 1));
    petEl.style.setProperty("--frame-ratio", `${frameWidth} / ${frameHeight}`);
    petEl.style.setProperty("--sheet-cols", String(sheetCols));
    petEl.style.setProperty("--sheet-rows", String(sheetRows));
    petEl.style.setProperty("--sprite-y", `${-(row / sheetRows) * 100}%`);
    petEl.style.setProperty("--sprite-end-x", `${-(frames / sheetCols) * 100}%`);
  }
  petEl.setAttribute("aria-label", pet?.name ?? "CursorPet");

  petNameEl.textContent = state.enabled ? pet?.name ?? "CursorPet" : "CursorPets paused";
  messageEl.textContent = state.enabled ? state.message : "Disabled in settings.";
  moodEl.textContent = state.mood;
  diagnosticsEl.textContent = `${state.diagnostics.errors} errors, ${state.diagnostics.warnings} warnings`;
  attributionEl.textContent = pet ? `by ${pet.author} - ${pet.description}` : "No pet manifest loaded.";
  sourceEl.textContent = catalog.source || "local";
  toggleEnabledEl.textContent = state.enabled ? "Pause" : "Resume";
  openSourceEl.hidden = !pet?.sourceUrl;
  floatPetEl.disabled = false;
  floatPetEl.title = "Open pet in a floating desktop window.";
  renderNotifications();
  renderPetList();
});

function renderNotifications() {
  notificationListEl.replaceChildren();

  const notifications = latestState?.notifications ?? [];
  if (notifications.length === 0) {
    const empty = document.createElement("p");
    empty.className = "notification-empty";
    empty.textContent = "No notifications yet.";
    notificationListEl.append(empty);
    return;
  }

  for (const notification of notifications) {
    const item = document.createElement("article");
    item.className = "notification-item";
    item.dataset.level = notification.level;
    item.innerHTML = `
      <div class="notification-topline">
        <span class="notification-source"></span>
        <time class="notification-time"></time>
      </div>
      <strong class="notification-title"></strong>
      <p class="notification-body"></p>
    `;
    item.querySelector(".notification-source").textContent = notification.source;
    item.querySelector(".notification-time").textContent = formatNotificationTime(notification.createdAt);
    item.querySelector(".notification-title").textContent = notification.title;
    item.querySelector(".notification-body").textContent = notification.body;
    notificationListEl.append(item);
  }
}

function formatNotificationTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return "";
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderPetList() {
  petListEl.replaceChildren();

  for (const pet of latestCatalog?.pets ?? []) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "pet-option";
    item.dataset.selected = String(pet.id === latestState.selectedPetId);
    item.setAttribute("aria-pressed", String(pet.id === latestState.selectedPetId));
    item.innerHTML = `
      <span class="pet-option-name"></span>
      <span class="pet-option-meta"></span>
    `;
    item.querySelector(".pet-option-name").textContent = pet.name;
    item.querySelector(".pet-option-meta").textContent = `by ${pet.author}`;
    item.addEventListener("click", () => {
      vscode.postMessage({
        type: "cursorPets.action",
        action: "selectPet",
        petId: pet.id
      });
    });
    petListEl.append(item);
  }
}
