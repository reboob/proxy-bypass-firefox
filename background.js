"use strict";

/*
 * Фоновая часть. Держит список исключений, решает для каждого запроса
 * "проксировать или нет" и отдаёт UI актуальное состояние.
 *
 * Ключевой момент API proxy.onRequest в Firefox:
 *
 *   - возврат undefined  -> используется прокси по умолчанию (настройки Firefox,
 *                          PAC, автоопределение и т.д.) — то есть поведение
 *                          полностью сохраняется;
 *   - возврат {type:"direct"}  НЕ даёт прямого соединения, если в Firefox уже
 *                          настроен прокси: Firefox трактует "direct" как
 *                          "использовать прокси по умолчанию"
 *                          (toolkit/components/extensions/ProxyChannelFilter.sys.mjs,
 *                          createProxyInfoFromData());
 *   - возврат [null]    -> цепочка прокси обрывается на null, соединение идёт
 *                          напрямую. Это единственный способ принудительно
 *                          обойти уже настроенный прокси.
 *
 * Поэтому DIRECT возвращается именно как [null], а для проксирования —
 * undefined.
 */

const DEFAULTS = {
  enabled: true,
  rules: [],
  tabs: {},
  matchRequestUrl: true,
  bypassNonTab: false,
  verbose: false,
};

const STORAGE_KEYS = Object.keys(DEFAULTS);
const LOG_LIMIT = 200;

const state = {
  enabled: DEFAULTS.enabled,
  rules: [],
  matchers: [],
  tabs: new Map(),
  matchRequestUrl: DEFAULTS.matchRequestUrl,
  bypassNonTab: DEFAULTS.bypassNonTab,
  verbose: DEFAULTS.verbose,
  ready: false,
  stats: { total: 0, direct: 0, proxied: 0, startedAt: Date.now() },
  lastDetails: null,
  log: [],
  lastError: null,
};

/* ------------------------------------------------------------------ storage */

async function persist() {
  const tabs = {};
  for (const [id, entry] of state.tabs) {
    tabs[id] = { url: entry.url, addedAt: entry.addedAt };
  }
  await browser.storage.local.set({
    enabled: state.enabled,
    rules: state.rules,
    tabs,
    matchRequestUrl: state.matchRequestUrl,
    bypassNonTab: state.bypassNonTab,
    verbose: state.verbose,
  });
}

async function loadState() {
  const stored = await browser.storage.local.get(STORAGE_KEYS);

  state.enabled = typeof stored.enabled === "boolean" ? stored.enabled : DEFAULTS.enabled;
  state.matchRequestUrl =
    typeof stored.matchRequestUrl === "boolean" ? stored.matchRequestUrl : DEFAULTS.matchRequestUrl;
  state.bypassNonTab =
    typeof stored.bypassNonTab === "boolean" ? stored.bypassNonTab : DEFAULTS.bypassNonTab;
  state.verbose = typeof stored.verbose === "boolean" ? stored.verbose : DEFAULTS.verbose;
  state.rules = Array.isArray(stored.rules)
    ? stored.rules.filter((item) => typeof item === "string" && item.trim())
    : [];
  state.matchers = PB.compileRules(state.rules);

  state.tabs = new Map();
  const storedTabs = stored.tabs && typeof stored.tabs === "object" ? stored.tabs : {};
  for (const [key, value] of Object.entries(storedTabs)) {
    const id = Number(key);
    if (!Number.isInteger(id) || id < 0) {
      continue;
    }
    state.tabs.set(id, {
      tabId: id,
      url: (value && value.url) || "",
      addedAt: (value && value.addedAt) || Date.now(),
    });
  }

  await pruneStaleTabs();
  state.ready = true;
}

/** Убирает из списка вкладки, которых больше нет (перезапуск браузера и т.п.). */
async function pruneStaleTabs() {
  let changed = false;
  for (const id of [...state.tabs.keys()]) {
    try {
      const tab = await browser.tabs.get(id);
      const entry = state.tabs.get(id);
      if (!entry.url && tab && tab.url) {
        entry.url = tab.url;
        changed = true;
      }
    } catch {
      state.tabs.delete(id);
      changed = true;
    }
  }
  if (changed) {
    await persist();
  }
  return changed;
}

/* ------------------------------------------------------------------ решение */

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function matchesRule(url) {
  if (!url) {
    return false;
  }
  for (const matcher of state.matchers) {
    if (matcher.test(url)) {
      return matcher.raw;
    }
  }
  return null;
}

/**
 * @returns {null|string} null — проксировать как обычно,
 *                          строка — почему запрос идёт напрямую.
 */
function findBypassReason(details) {
  if (!state.enabled) {
    return null;
  }

  const tabId = typeof details.tabId === "number" ? details.tabId : -1;

  if (tabId !== -1) {
    if (state.tabs.has(tabId)) {
      return "вкладка в списке";
    }
  } else if (state.bypassNonTab) {
    return "запрос не из вкладки";
  }

  if (!state.matchers.length) {
    return null;
  }

  const candidates = [details.documentUrl, details.originUrl];
  if (state.matchRequestUrl) {
    candidates.push(details.url);
  }

  for (const candidate of candidates) {
    const rule = matchesRule(candidate);
    if (rule) {
      return `правило «${rule}»`;
    }
  }

  return null;
}

let lastDetailsAt = 0;

function record(details, reason) {
  state.stats.total++;
  if (reason) {
    state.stats.direct++;
  } else {
    state.stats.proxied++;
  }

  if (!state.verbose) {
    if (Date.now() - lastDetailsAt > 200) {
      lastDetailsAt = Date.now();
      state.lastDetails = {
        tabId: details.tabId,
        frameId: details.frameId,
        parentFrameId: details.parentFrameId,
        type: details.type,
        url: details.url,
        documentUrl: details.documentUrl,
        originUrl: details.originUrl,
        method: details.method,
        timeStamp: Date.now(),
      };
    }
    return;
  }

  state.lastDetails = {
    tabId: details.tabId,
    frameId: details.frameId,
    parentFrameId: details.parentFrameId,
    type: details.type,
    url: details.url,
    documentUrl: details.documentUrl,
    originUrl: details.originUrl,
    method: details.method,
    timeStamp: Date.now(),
  };

  state.log.unshift({
    time: Date.now(),
    direct: Boolean(reason),
    reason,
    tabId: details.tabId,
    host: hostOf(details.url) || details.url.slice(0, 60),
    type: details.type,
  });
  if (state.log.length > LOG_LIMIT) {
    state.log.length = LOG_LIMIT;
  }
}

function handleProxyRequest(details) {
  let reason = null;
  try {
    reason = findBypassReason(details);
  } catch (error) {
    state.lastError = String(error && error.message ? error.message : error);
    console.error("[proxy-bypass]", error);
    return undefined;
  }

  record(details, reason);

  // [null] обрывает цепочку прокси и даёт прямое соединение.
  // undefined — "использовать прокси по умолчанию", как если бы расширения не было.
  return reason ? [null] : undefined;
}

browser.proxy.onRequest.addListener(handleProxyRequest, { urls: ["<all_urls>"] });

browser.proxy.onError.addListener((error) => {
  state.lastError = JSON.stringify(error);
  console.error("[proxy-bypass] onError", error);
});

/* -------------------------------------------------------------------- вкладки */

function tabInfo(entry) {
  return { tabId: entry.tabId, url: entry.url, addedAt: entry.addedAt };
}

async function setTabBypass(tabId, url, bypassed) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    return;
  }
  if (bypassed) {
    state.tabs.set(tabId, { tabId, url: url || "", addedAt: Date.now() });
  } else {
    state.tabs.delete(tabId);
  }
  await persist();
  await refreshBadge();
}

let badgeTimer = null;

/** Значок обновляем пачками: tabs.onUpdated прилетает очень часто. */
function scheduleBadgeRefresh() {
  if (badgeTimer !== null) {
    return;
  }
  badgeTimer = setTimeout(() => {
    badgeTimer = null;
    refreshBadge();
  }, 250);
}

async function refreshBadge() {
  try {
    const count = state.tabs.size;
    await browser.browserAction.setBadgeText({ text: count ? String(count) : "" });
    await browser.browserAction.setBadgeBackgroundColor({ color: "#2e7d32" });

    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const bypassed = Boolean(tab && state.tabs.has(tab.id));
    await browser.browserAction.setIcon({
      path: bypassed ? "icons/icon-bypass.svg" : "icons/icon.svg",
    });
    await browser.browserAction.setTitle({
      title: bypassed
        ? "Proxy Bypass: вкладка идёт напрямую"
        : "Proxy Bypass: проксировать как обычно",
    });
  } catch (error) {
    console.warn("[proxy-bypass] badge", error);
  }
}

browser.tabs.onRemoved.addListener(async (tabId) => {
  if (state.tabs.delete(tabId)) {
    await persist();
    await refreshBadge();
  }
});

browser.tabs.onActivated.addListener(scheduleBadgeRefresh);
browser.tabs.onUpdated.addListener((tabId, info) => {
  if (state.tabs.has(tabId) && info.url) {
    state.tabs.get(tabId).url = info.url;
    persist();
  }
  if (info.url || info.status) {
    scheduleBadgeRefresh();
  }
});

/* -------------------------------------------------------------------- правила */

async function addRule(rule) {
  const value = PB.normalizeRuleInput(rule);
  if (!value) {
    return { ok: false, error: "Пустое правило" };
  }
  if (state.rules.some((item) => item.toLowerCase() === value.toLowerCase())) {
    return { ok: true, duplicate: true, rules: state.rules.slice() };
  }
  state.rules.push(value);
  state.matchers = PB.compileRules(state.rules);
  await persist();
  return { ok: true, rules: state.rules.slice() };
}

async function removeRule(rule) {
  state.rules = state.rules.filter((item) => item !== rule);
  state.matchers = PB.compileRules(state.rules);
  await persist();
  return { ok: true, rules: state.rules.slice() };
}

/* ---------------------------------------------------------------- сообщения */

async function serializableState() {
  const proxySettings = await browser.proxy.settings.get({}).catch((error) => ({
    error: String(error),
  }));
  const incognitoAllowed = await browser.extension
    .isAllowedIncognitoAccess()
    .catch(() => false);

  return {
    enabled: state.enabled,
    matchRequestUrl: state.matchRequestUrl,
    bypassNonTab: state.bypassNonTab,
    verbose: state.verbose,
    rules: state.rules.slice(),
    matchers: state.matchers.map((m) => ({ raw: m.raw, kind: m.kind, describe: m.describe })),
    tabs: [...state.tabs.values()].map(tabInfo),
    stats: { ...state.stats },
    log: state.log.slice(0, 50),
    lastDetails: state.lastDetails,
    lastError: state.lastError,
    proxySettings,
    incognitoAllowed,
    listenerRegistered: browser.proxy.onRequest.hasListener(handleProxyRequest),
  };
}

browser.runtime.onMessage.addListener((message) => {
  if (!message || typeof message.type !== "string") {
    return undefined;
  }

  switch (message.type) {
    case "state":
      return serializableState();

    case "setFlag":
      if (!(message.key in DEFAULTS) || message.key === "rules" || message.key === "tabs") {
        return Promise.resolve({ ok: false, error: "Неизвестный параметр" });
      }
      state[message.key] = Boolean(message.value);
      return persist()
        .then(() => refreshBadge())
        .then(() => ({ ok: true, value: state[message.key] }));

    case "toggleTab":
      return setTabBypass(
        message.tabId,
        message.url,
        message.bypassed !== undefined ? Boolean(message.bypassed) : !state.tabs.has(message.tabId),
      ).then(() => ({ ok: true, bypassed: state.tabs.has(message.tabId) }));

    case "removeTab":
      return setTabBypass(message.tabId, "", false).then(() => ({ ok: true }));

    case "clearTabs":
      state.tabs.clear();
      return persist().then(() => refreshBadge()).then(() => ({ ok: true }));

    case "addRule":
      return addRule(message.rule);

    case "removeRule":
      return removeRule(message.rule);

    case "clearRules":
      state.rules = [];
      state.matchers = [];
      return persist().then(() => ({ ok: true, rules: [] }));

    case "clearLog":
      state.log = [];
      return Promise.resolve({ ok: true });

    case "prune":
      return pruneStaleTabs().then(() => refreshBadge()).then(() => ({ ok: true }));

    default:
      return undefined;
  }
});

browser.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") {
    return;
  }
  // Расширение может быть запущено в двух профилях/окнах — держим состояние
  // в актуальном состоянии, если что-то изменилось извне.
  let dirty = false;
  if (changes.enabled) {
    state.enabled = Boolean(changes.enabled.newValue);
    dirty = true;
  }
  if (changes.matchRequestUrl) {
    state.matchRequestUrl = Boolean(changes.matchRequestUrl.newValue);
    dirty = true;
  }
  if (changes.bypassNonTab) {
    state.bypassNonTab = Boolean(changes.bypassNonTab.newValue);
    dirty = true;
  }
  if (changes.verbose) {
    state.verbose = Boolean(changes.verbose.newValue);
    dirty = true;
  }
  if (changes.rules) {
    state.rules = Array.isArray(changes.rules.newValue) ? changes.rules.newValue : [];
    state.matchers = PB.compileRules(state.rules);
    dirty = true;
  }
  if (changes.tabs) {
    const tabs = new Map();
    const raw = changes.tabs.newValue || {};
    for (const [key, value] of Object.entries(raw)) {
      const id = Number(key);
      if (Number.isInteger(id) && id >= 0) {
        tabs.set(id, { tabId: id, url: (value && value.url) || "", addedAt: (value && value.addedAt) || 0 });
      }
    }
    state.tabs = tabs;
    dirty = true;
  }
  if (dirty) {
    refreshBadge();
  }
});

loadState()
  .then(() => refreshBadge())
  .catch((error) => {
    state.lastError = String(error);
    console.error("[proxy-bypass] init", error);
  });
