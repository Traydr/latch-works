const LAYOUT_STORAGE_KEY = "gather-box-layout-preview";

const SITE_PROFILES = {
  kemono: {
    key: "kemono",
    label: "Kemono",
    outputLabel: "Gallery images",
    saveRuleSummary: "Creates nested folders by source type, creator, then post title.",
    folderPattern: "{type}/{creator}/{post}/",
    folderExample: "fanbox/CreatorName/Post_Title/",
    filePattern: "Original CDN filenames",
    url: "https://kemono.cr/fanbox/user/24921130/post/11471817",
    previewPath: "Archive/fanbox/CreatorName/Post_Title/"
  },
  fanbox: {
    key: "fanbox",
    label: "pixiv FANBOX",
    outputLabel: "Gallery images",
    saveRuleSummary: "Creates a creator folder, then a post subfolder with title and ID.",
    folderPattern: "{creator}/{title}-{post_id}/",
    folderExample: "creator/Post_Title-11929835/",
    filePattern: "Original CDN filenames",
    credentialsNote: "Session cookies included by default.",
    url: "https://creator.fanbox.cc/posts/11929835",
    previewPath: "Archive/creator/Post_Title-11929835/"
  },
  ao3: {
    key: "archiveofourown",
    label: "Archive of Our Own",
    outputLabel: "Server PDF",
    saveRuleSummary: "Saves a single PDF directly in the chosen site folder.",
    folderPattern: "(site folder root)",
    folderExample: "Author-Title.pdf",
    filePattern: "{author}-{title}.pdf",
    credentialsNote: "Session cookies included by default.",
    url: "https://archiveofourown.org/works/18187196",
    previewPath: "Archive/Author-Title.pdf"
  }
};

const ATLAS_PROFILES = [
  SITE_PROFILES.kemono,
  SITE_PROFILES.fanbox,
  {
    key: "myhentaigallery",
    label: "MyHentaiGallery",
    outputLabel: "Gallery images",
    folderPattern: "{title}/",
    folderExample: "Gallery_Title/"
  },
  SITE_PROFILES.ao3,
  {
    key: "hentaifoundry-stories",
    label: "Hentai Foundry Stories",
    outputLabel: "Server PDF",
    folderPattern: "(site folder root)",
    folderExample: "Author-Title.pdf"
  },
  {
    key: "fanfiction-net",
    label: "FanFiction.Net",
    outputLabel: "Generated PDF",
    folderPattern: "(site folder root)",
    folderExample: "Author-Title.pdf"
  }
];

function initLayoutSwitcher() {
  const main = document.querySelector("main.popup");
  const buttons = document.querySelectorAll(".layout-switcher-btn");
  if (!main) return;

  const stored = sessionStorage.getItem(LAYOUT_STORAGE_KEY);
  const initial = stored && /^[1-5]$/.test(stored) ? stored : "1";
  applyLayout(main, buttons, initial);

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const layout = button.dataset.layout;
      if (!layout) return;
      sessionStorage.setItem(LAYOUT_STORAGE_KEY, layout);
      applyLayout(main, buttons, layout);
    });
  }
}

function applyLayout(main, buttons, layout) {
  main.dataset.layout = layout;
  document.body.dataset.layout = layout;
  for (const button of buttons) {
    button.classList.toggle("layout-switcher-btn-active", button.dataset.layout === layout);
    button.setAttribute("aria-pressed", button.dataset.layout === layout ? "true" : "false");
  }
}

function renderAtlas(activeKey) {
  const container = document.getElementById("siteAtlasRows-mini");
  if (!container) return;

  container.innerHTML = ATLAS_PROFILES.map((profile) => `
    <article class="site-atlas-row${profile.key === activeKey ? " site-atlas-row-active" : ""}" data-site-key="${profile.key}" role="listitem">
      <div class="site-atlas-row-head">
        <span class="site-atlas-row-label">${profile.label}</span>
        <span class="site-atlas-row-output">${profile.outputLabel}</span>
      </div>
      <p class="site-atlas-row-pattern mono">${profile.folderPattern}</p>
      <p class="site-atlas-row-example">${profile.folderExample}</p>
    </article>
  `).join("");
}

function applySite(siteAlias) {
  const profile = SITE_PROFILES[siteAlias];
  if (!profile) return;

  document.getElementById("siteLabel-mini").textContent = profile.label;
  document.getElementById("siteOutput-mini").textContent = profile.outputLabel;
  document.getElementById("siteSaveRule-mini").textContent = profile.saveRuleSummary;
  document.getElementById("sitePathPattern-mini").textContent = profile.folderPattern;
  document.getElementById("sitePathExample-mini").textContent = profile.folderExample;
  document.getElementById("siteFilePattern-mini").textContent = profile.filePattern;
  document.getElementById("pageStatus-mini").textContent = profile.label;
  document.getElementById("pageDetail-mini").textContent = profile.url;

  const credentials = document.getElementById("siteCredentialsNote-mini");
  if (profile.credentialsNote) {
    credentials.textContent = profile.credentialsNote;
    credentials.hidden = false;
  } else {
    credentials.hidden = true;
  }

  const preview = document.getElementById("destinationPreview-mini");
  preview.textContent = profile.previewPath;
  preview.hidden = false;

  renderAtlas(profile.key);

  for (const button of document.querySelectorAll(".preview-site-btn")) {
    button.classList.toggle("preview-site-btn-active", button.dataset.site === siteAlias);
  }
}

function initSiteSwitcher() {
  for (const button of document.querySelectorAll(".preview-site-btn")) {
    button.addEventListener("click", () => {
      applySite(button.dataset.site);
    });
  }

  const hashSite = location.hash.replace(/^#preview=/, "");
  applySite(SITE_PROFILES[hashSite] ? hashSite : "kemono");
}

initLayoutSwitcher();
initSiteSwitcher();
