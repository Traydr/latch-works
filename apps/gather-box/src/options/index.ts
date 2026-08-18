import * as z from "zod/mini";
import {
  CredentialsChoiceSchema,
  CredentialsModeSchema,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type CredentialsChoice,
  type GatherBoxSettings
} from "../shared/settings";
import { LISTED_SITES, type SiteKey } from "../shared/sites";
import { getGatherSource } from "../shared/source-catalog";

interface SettingsFormElements {
  form: HTMLFormElement;
  downloadConcurrency: HTMLInputElement;
  mediaCompatibilityMode: HTMLInputElement;
  verboseLogging: HTMLInputElement;
  pageShortcutsEnabled: HTMLInputElement;
  toggleCommandShortcut: HTMLElement;
  downloadCommandShortcut: HTMLElement;
  credentialsMode: HTMLSelectElement;
  perSiteCredentials: HTMLElement;
  saveStatus: HTMLElement;
}

document.addEventListener("DOMContentLoaded", () => {
  void init();
});

async function init(): Promise<void> {
  const elements = getFormElements();
  const settings = await loadSettings();

  renderPerSiteCredentials(elements.perSiteCredentials, settings);
  applySettingsToForm(elements, settings);
  await renderCommandShortcuts(elements);

  elements.credentialsMode.addEventListener("change", () => {
    elements.perSiteCredentials.hidden = elements.credentialsMode.value !== "perSite";
  });

  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void handleSave(elements);
  });
}

function getFormElements(): SettingsFormElements {
  return {
    form: requireElement("settingsForm", HTMLFormElement),
    downloadConcurrency: requireElement("downloadConcurrency", HTMLInputElement),
    mediaCompatibilityMode: requireElement("mediaCompatibilityMode", HTMLInputElement),
    verboseLogging: requireElement("verboseLogging", HTMLInputElement),
    pageShortcutsEnabled: requireElement("pageShortcutsEnabled", HTMLInputElement),
    toggleCommandShortcut: requireElement("toggleCommandShortcut", HTMLElement),
    downloadCommandShortcut: requireElement("downloadCommandShortcut", HTMLElement),
    credentialsMode: requireElement("credentialsMode", HTMLSelectElement),
    perSiteCredentials: requireElement("perSiteCredentials", HTMLElement),
    saveStatus: requireElement("saveStatus", HTMLElement)
  };
}

async function renderCommandShortcuts(elements: SettingsFormElements): Promise<void> {
  const commands = await chrome.commands.getAll();
  const shortcuts = new Map(commands.map((command) => [command.name, command.shortcut]));
  elements.toggleCommandShortcut.textContent = shortcuts.get("toggle-gather-box") || "Not assigned";
  elements.downloadCommandShortcut.textContent =
    shortcuts.get("download-active-tab") || "Not assigned";
}

function renderPerSiteCredentials(container: HTMLElement, settings: GatherBoxSettings): void {
  container.innerHTML = "";

  for (const site of LISTED_SITES) {
    const row = document.createElement("div");
    row.className = "per-site-row";

    const label = document.createElement("label");
    label.textContent = site.label;
    label.htmlFor = `credentials-${site.key}`;

    const select = document.createElement("select");
    select.id = `credentials-${site.key}`;
    select.dataset.siteKey = site.key;
    select.innerHTML = `
      <option value="default">Site default</option>
      <option value="include">Include cookies</option>
      <option value="omit">Omit cookies</option>
    `;

    const current = settings.credentialsPerSite[site.key];
    select.value = current ?? "default";

    row.append(label, select);
    container.appendChild(row);
  }
}

function applySettingsToForm(elements: SettingsFormElements, settings: GatherBoxSettings): void {
  elements.downloadConcurrency.value = String(settings.downloadConcurrency);
  elements.mediaCompatibilityMode.checked = settings.mediaCompatibilityMode;
  elements.verboseLogging.checked = settings.verboseLogging;
  elements.pageShortcutsEnabled.checked = settings.pageShortcutsEnabled;
  elements.credentialsMode.value = settings.credentialsMode;
  elements.perSiteCredentials.hidden = settings.credentialsMode !== "perSite";

  const folderMode = settings.useGlobalFolder ? "global" : "perSite";
  const folderInput = elements.form.querySelector<HTMLInputElement>(
    `input[name="folderMode"][value="${folderMode}"]`
  );
  if (folderInput) {
    folderInput.checked = true;
  }

}

async function handleSave(elements: SettingsFormElements): Promise<void> {
  const folderMode = elements.form.querySelector<HTMLInputElement>('input[name="folderMode"]:checked')
    ?.value;
  const settings: GatherBoxSettings = {
    downloadConcurrency: Number(elements.downloadConcurrency.value),
    mediaCompatibilityMode: elements.mediaCompatibilityMode.checked,
    verboseLogging: elements.verboseLogging.checked,
    pageShortcutsEnabled: elements.pageShortcutsEnabled.checked,
    useGlobalFolder: folderMode === "global",
    credentialsMode: z
      .catch(CredentialsModeSchema, DEFAULT_SETTINGS.credentialsMode)
      .parse(elements.credentialsMode.value),
    credentialsPerSite: readPerSiteCredentials(elements.perSiteCredentials)
  };

  await saveSettings(settings);
  elements.saveStatus.textContent = "Settings saved.";
  window.setTimeout(() => {
    elements.saveStatus.textContent = "";
  }, 2500);
}

function readPerSiteCredentials(container: HTMLElement) {
  const result: Partial<Record<SiteKey, CredentialsChoice>> = {};

  for (const select of container.querySelectorAll<HTMLSelectElement>("select[data-site-key]")) {
    // The option rows are rendered from GATHER_SOURCES, so every data-site-key is a catalog key.
    const source = getGatherSource(select.dataset.siteKey ?? "");
    const choice = CredentialsChoiceSchema.safeParse(select.value);
    if (source && choice.success) {
      result[source.key] = choice.data;
    }
  }

  return result;
}

function requireElement<T extends HTMLElement>(id: string, constructor: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) {
    throw new Error(`Missing required options element: ${id}`);
  }

  return element;
}
