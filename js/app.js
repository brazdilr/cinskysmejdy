(() => {
  const CZ_PATH = "data/cz.json";
  const INTL_PATH = "data/intl.json";

  const button = document.querySelector(".audio-fab");
  const audio = document.getElementById("spot");
  if (!button || !audio) return;

  const label = button.querySelector(".label");
  const icon = button.querySelector(".icon");

  const isoFormatter = new Intl.DateTimeFormat("cs-CZ", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  function setState(isPlaying) {
    if (icon) icon.textContent = isPlaying ? "🔈" : "🔊";
    if (label) {
      label.textContent = isPlaying ? "stop" : "zní to povědomě?";
    }
  }

  function formatDate(isoString) {
    if (!isoString) return "";
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return "";
    return isoFormatter.format(d);
  }

  function createCard(item, isCz) {
    const card = document.createElement("article");
    card.className = "card";

    const title = document.createElement("h3");
    title.textContent = item.title || "Bez názvu";

    const meta = document.createElement("div");
    meta.className = "card-meta";
    const sourceSpan = document.createElement("span");
    if (isCz) sourceSpan.className = "accent";
    sourceSpan.textContent = item.source || "Neznámý zdroj";
    const dateStr = formatDate(item.publishedAt);
    meta.textContent = sourceSpan.textContent + (dateStr ? " — " + dateStr : "");
    if (isCz) {
      meta.innerHTML = "";
      meta.appendChild(sourceSpan);
      if (dateStr) {
        meta.appendChild(document.createTextNode(" — " + dateStr));
      }
    }

    card.appendChild(title);
    card.appendChild(meta);

    if (item.url) {
      card.addEventListener("click", () => {
        window.open(item.url, "_blank", "noopener,noreferrer");
      });
      card.setAttribute("role", "link");
      card.setAttribute("tabindex", "0");
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          window.open(item.url, "_blank", "noopener,noreferrer");
        }
      });
    }

    return card;
  }

  async function loadJson(path) {
    const res = await fetch(path, { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  async function initFeeds() {
    const czList = document.getElementById("cz-list");
    const intlList = document.getElementById("intl-list");
    const czStatus = document.getElementById("cz-status");
    const intlStatus = document.getElementById("intl-status");

    if (!czList || !intlList) return;
    if (czStatus) czStatus.textContent = "Načítám české zdroje…";
    if (intlStatus) intlStatus.textContent = "Načítám zahraniční zdroje…";

    try {
      const [czItems, intlItems] = await Promise.all([
        loadJson(CZ_PATH),
        loadJson(INTL_PATH),
      ]);

      czList.innerHTML = "";
      intlList.innerHTML = "";

      (czItems || []).forEach((item) => {
        czList.appendChild(createCard(item, true));
      });
      (intlItems || []).forEach((item) => {
        intlList.appendChild(createCard(item, false));
      });

      if (czStatus) {
        czStatus.textContent = czItems?.length
          ? `Počet článků: ${czItems.length}`
          : "Zatím žádné články.";
      }
      if (intlStatus) {
        intlStatus.textContent = intlItems?.length
          ? `Počet článků: ${intlItems.length}`
          : "Zatím žádné články.";
      }
    } catch (err) {
      if (czStatus) {
        czStatus.textContent = "Nepodařilo se načíst data.";
      }
      if (intlStatus) {
        intlStatus.textContent = "Nepodařilo se načíst data.";
      }
    }
  }

  button.addEventListener("click", async () => {
    if (audio.paused) {
      try {
        await audio.play();
        setState(true);
      } catch (err) {
        setState(false);
      }
    } else {
      audio.pause();
      setState(false);
    }
  });

  audio.addEventListener("ended", () => setState(false));

  window.addEventListener("DOMContentLoaded", () => {
    initFeeds();
  });
})();
