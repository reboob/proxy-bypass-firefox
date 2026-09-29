"use strict";

const el = (id) => document.getElementById(id);

let currentTab = null;
let snapshot = null;

async function send(message) {
  return browser.runtime.sendMessage(message);
}

async function load() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || null;
  snapshot = await send({ type: "state" });
  render();
}

function render() {
  el("enabled").checked = snapshot.enabled;

  const url = currentTab && currentTab.url ? currentTab.url : "";
  el("tab-url").textContent = url || "недоступно";
  const bypassed = Boolean(currentTab && snapshot.tabs.some((t) => t.tabId === currentTab.id));
  el("tab-bypass").checked = bypassed;
  el("tab-bypass").disabled = !currentTab || currentTab.id < 0;
  el("add-site").disabled = !url || !/^https?:/i.test(url);

  el("rules-count").textContent = snapshot.rules.length ? `${snapshot.rules.length}` : "";
  el("rules").textContent = "";
  const empty = el("rules-empty");
  if (!snapshot.rules.length) {
    empty.hidden = false;
  } else {
    empty.hidden = true;
  }

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

    const remove = document.createElement("button");
    remove.className = "remove";
    remove.type = "button";
    remove.title = `Убрать правило «${rule}»`;
    remove.textContent = "×";
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      await send({ type: "removeRule", rule });
      await load();
    });
    li.appendChild(remove);

    el("rules").appendChild(li);
  }
}

el("enabled").addEventListener("change", async (event) => {
  await send({ type: "setFlag", key: "enabled", value: event.target.checked });
  await load();
});

el("tab-bypass").addEventListener("change", async (event) => {
  await send({
    type: "toggleTab",
    tabId: currentTab.id,
    url: currentTab.url,
    bypassed: event.target.checked,
  });
  await load();
});

el("add-site").addEventListener("click", async () => {
  const host = new URL(currentTab.url).hostname;
  const hint = el("tab-hint");
  hint.textContent = "";
  const result = await send({ type: "addRule", rule: host });
  if (!result.ok) {
    hint.textContent = result.error;
    return;
  }
  await load();
});

el("open-options").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

load().catch((error) => {
  el("tab-hint").textContent = String(error);
});
