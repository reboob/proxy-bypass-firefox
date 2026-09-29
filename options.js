"use strict";

const el = (id) => document.getElementById(id);
const send = (message) => browser.runtime.sendMessage(message);

let snapshot = null;

function proxySummary(settings) {
  if (!settings) {
    return "не удалось прочитать";
  }
  if (settings.error) {
    return `ошибка: ${settings.error}`;
  }
  const value = settings.value || {};
  const level = settings.levelOfControl || "?";
  const type = value.proxyType || "unknown";
  let detail = "";
  switch (type) {
    case "manual":
      detail = value.http
        ? `${value.http.host}:${value.http.port}${
            value.socks ? ` + socks ${value.socks.host}:${value.socks.port}` : ""
          }${value.ssl ? " + ssl" : ""}`
        : "пусто";
      break;
    case "autoConfig":
      detail = value.autoConfigUrl || "";
      break;
    case "none":
      detail = "прямые соединения";
      break;
    case "system":
      detail = "системные настройки";
      break;
    case "autoDetect":
      detail = "автоопределение (WPAD)";
      break;
    default:
      detail = JSON.stringify(value);
  }
  return `${type}: ${detail} (уровень контроля: ${level})`;
}

function renderStats() {
  const { total, direct, proxied } = snapshot.stats;
  const elapsed = Math.max(1, Math.round((Date.now() - snapshot.stats.startedAt) / 1000));
  const container = el("stats");
  container.textContent = "";
  const items = [
    [direct, "напрямую"],
    [proxied, "через прокси"],
    [total, "всего запросов"],
    [`${elapsed} с`, "работает"],
  ];
  for (const [value, label] of items) {
    const div = document.createElement("div");
    div.className = "stat";
    const b = document.createElement("b");
    b.textContent = String(value);
    const span = document.createElement("span");
    span.textContent = label;
    div.append(b, span);
    container.appendChild(div);
  }
}

function renderDiagnostics() {
  const box = el("diagnostics");
  box.textContent = "";

  const add = (text, warn = false) => {
    const div = document.createElement("div");
    div.textContent = text;
    if (warn) {
      div.className = "warn";
    }
    box.appendChild(div);
  };

  add(`Прокси Firefox: ${proxySummary(snapshot.proxySettings)}`);
  add(
    snapshot.listenerRegistered
      ? "Слушатель proxy.onRequest зарегистрирован."
      : "Слушатель proxy.onRequest НЕ зарегистрирован — правила не работают.",
    !snapshot.listenerRegistered,
  );
  if (!snapshot.incognitoAllowed) {
    add(
      "Доступ к приватному окнам не разрешён (about:addons → «Разрешить в приватном окне»), " +
        "исключения в приватных вкладках работать не будут.",
      true,
    );
  }
  if (snapshot.lastError) {
    add(`Последняя ошибка: ${snapshot.lastError}`, true);
  }

  const details = snapshot.lastDetails;
  if (details) {
    add(
      `Последний запрос: tabId=${details.tabId} frameId=${details.frameId} type=${details.type} ` +
        `documentUrl=${details.documentUrl || "—"}`,
    );
    add(
      details.tabId === -1 || details.tabId === undefined
        ? "Внимание: в последнем запросе tabId = -1. Для обычных запросов вкладки он должен быть положительным."
        : "tabId определяется корректно — правила по вкладкам работают.",
      details.tabId === -1 || details.tabId === undefined,
    );
  } else {
    add("Запросов пока не было — откройте любую страницу и обновите.");
  }
}

function renderRules() {
  const list = el("rules");
  list.textContent = "";
  el("rules-empty").hidden = snapshot.rules.length > 0;

  const described = new Map(snapshot.matchers.map((m) => [m.raw, m.describe]));
  for (const rule of snapshot.rules) {
    const li = document.createElement("li");

    const name = document.createElement("span");
    name.className = "rule";
    name.textContent = rule;
    li.appendChild(name);

    const desc = document.createElement("span");
    desc.className = "desc";
    desc.textContent = described.get(rule) || "";
    li.appendChild(desc);

    li.appendChild(removeButton(`Убрать правило «${rule}»`, async () => {
      await send({ type: "removeRule", rule });
      await load();
    }));

    list.appendChild(li);
  }
}

function renderTabs() {
  const list = el("tabs");
  list.textContent = "";
  el("tabs-empty").hidden = snapshot.tabs.length > 0;

  for (const tab of snapshot.tabs) {
    const li = document.createElement("li");

    const url = document.createElement("span");
    url.className = "url";
    url.textContent = `#${tab.tabId} ${tab.url || "URL неизвестен"}`;
    li.appendChild(url);

    li.appendChild(removeButton("Убрать вкладку из списка", async () => {
      await send({ type: "removeTab", tabId: tab.tabId });
      await load();
    }));

    list.appendChild(li);
  }
}

function renderLog() {
  const list = el("log");
  list.textContent = "";
  el("log-empty").hidden = snapshot.log.length > 0;
  if (!snapshot.verbose) {
    el("log-empty").textContent = "Журнал выключен. Включите его в разделе «Параметры».";
    return;
  }
  el("log-empty").textContent = "Журнал пуст.";

  const time = new Intl.DateTimeFormat("ru", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  for (const entry of snapshot.log) {
    const li = document.createElement("li");

    const tag = document.createElement("span");
    tag.className = entry.direct ? "tag direct" : "tag proxy";
    tag.textContent = entry.direct ? "DIRECT" : "PROXY";
    li.appendChild(tag);

    const timeSpan = document.createElement("span");
    timeSpan.className = "desc";
    timeSpan.textContent = time.format(new Date(entry.time));
    li.appendChild(timeSpan);

    const host = document.createElement("span");
    host.className = "rule";
    host.textContent = `tab=${entry.tabId} ${entry.type} ${entry.host}${entry.reason ? ` — ${entry.reason}` : ""}`;
    li.appendChild(host);

    list.appendChild(li);
  }
}

function removeButton(title, onClick) {
  const button = document.createElement("button");
  button.className = "remove";
  button.type = "button";
  button.title = title;
  button.textContent = "×";
  button.addEventListener("click", onClick);
  return button;
}

function render() {
  el("enabled").checked = snapshot.enabled;
  el("match-request-url").checked = snapshot.matchRequestUrl;
  el("bypass-non-tab").checked = snapshot.bypassNonTab;
  el("verbose").checked = snapshot.verbose;

  renderStats();
  renderDiagnostics();
  renderRules();
  renderTabs();
  renderLog();
}

async function load() {
  snapshot = await send({ type: "state" });
  render();
}

el("enabled").addEventListener("change", (e) => setFlag("enabled", e.target.checked));
el("match-request-url").addEventListener("change", (e) => setFlag("matchRequestUrl", e.target.checked));
el("bypass-non-tab").addEventListener("change", (e) => setFlag("bypassNonTab", e.target.checked));
el("verbose").addEventListener("change", (e) => setFlag("verbose", e.target.checked));

async function setFlag(key, value) {
  await send({ type: "setFlag", key, value });
  await load();
}

el("rule-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = el("rule-input");
  const result = await send({ type: "addRule", rule: input.value });
  if (result.ok) {
    input.value = "";
    await load();
  }
});

el("clear-rules").addEventListener("click", async () => {
  if (confirm("Удалить все правила сайтов?")) {
    await send({ type: "clearRules" });
    await load();
  }
});

el("clear-tabs").addEventListener("click", async () => {
  if (confirm("Убрать все вкладки из списка?")) {
    await send({ type: "clearTabs" });
    await load();
  }
});

el("refresh").addEventListener("click", load);
el("clear-log").addEventListener("click", async () => {
  await send({ type: "clearLog" });
  await load();
});

load().catch((error) => {
  document.body.prepend(`Ошибка: ${error}`);
});
