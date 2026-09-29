"use strict";

/*
 * Общие правила сопоставления URL/хостов.
 * Файл подключается и в background, и в popup/options, поэтому экспортирует
 * глобальный объект PB (никаких модулей — MV2 background грузит список скриптов).
 *
 * Два вида правил:
 *
 *   1) Правило-URL.   Появляется, если в правиле есть схема или "/":
 *                     "https://site.ru", "*://site.ru/api", "example.com/api".
 *                     Без "*" — префикс (совпадает сам адрес и всё после него
 *                     через /, ?, #, :), с "*" — шаблон.
 *
 *   2) Правило-Хост.  Всё остальное: "example.com", "*.local", "192.168.*",
 *                     "localhost:8080". Без "*" хост совпадает вместе со своими
 *                     поддоменами ("example.com" => example.com, a.example.com,
 *                     a.b.example.com, но НЕ "notexample.com").
 */

const PB = (() => {
  const SCHEME_RE = /^(https?|wss?|ftp|file|\*):\/\//i;

  function escapeRegExp(str) {
    return str.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }

  function wildcardToRegExp(str) {
    let out = "";
    for (const ch of str) {
      out += ch === "*" ? "[\\s\\S]*" : escapeRegExp(ch);
    }
    return out;
  }

  function normalizeHost(host) {
    try {
      return new URL("http://" + host).hostname.toLowerCase();
    } catch {
      return host.toLowerCase();
    }
  }

  function effectivePort(url) {
    if (url.port) {
      return url.port;
    }
    switch (url.protocol) {
      case "https:":
      case "wss:":
        return "443";
      case "http:":
      case "ws:":
        return "80";
      case "ftp:":
        return "21";
      default:
        return "";
    }
  }

  function compileUrlRule(raw) {
    const value = raw.trim();

    // "*://host/path" — схема подстановочная, сравниваем без неё.
    const anyScheme = /^\*:(?:\/\/)?/.test(value);
    const body = anyScheme ? value.replace(/^\*:(?:\/\/)?/, "") : value;
    const normalize = (url) => {
      const lower = url.toLowerCase();
      return anyScheme ? lower.replace(/^[a-z0-9+.-]+:(\/\/)?/, "") : lower;
    };

    if (body.includes("*")) {
      const rx = new RegExp("^" + wildcardToRegExp(body) + "$", "i");
      return {
        raw: value,
        kind: "url",
        describe: "URL по шаблону",
        test: (url) => rx.test(normalize(url)),
      };
    }

    const prefix = body.toLowerCase();
    return {
      raw: value,
      kind: "url",
      describe: "URL по префиксу",
      test: (url) => {
        const candidate = normalize(url);
        return (
          candidate === prefix ||
          candidate.startsWith(prefix + "/") ||
          candidate.startsWith(prefix + "?") ||
          candidate.startsWith(prefix + "#") ||
          candidate.startsWith(prefix + ":")
        );
      },
    };
  }

  function compileHostRule(raw) {
    const rule = raw.trim().toLowerCase();

    let hostPart = rule;
    let port = null;
    const colon = rule.lastIndexOf(":");
    if (colon > 0 && /^\d+$/.test(rule.slice(colon + 1))) {
      hostPart = rule.slice(0, colon);
      port = rule.slice(colon + 1);
    }

    let hostRx;
    if (hostPart.includes("*")) {
      hostRx = new RegExp("^" + wildcardToRegExp(hostPart) + "$");
    } else {
      const host = normalizeHost(hostPart);
      // "(?:label\.)*host" — хост и любые его поддомены, но не "nothost".
      hostRx = new RegExp(
        "^(?:[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?\\.)*" + escapeRegExp(host) + "$",
      );
    }

    return {
      raw,
      kind: "host",
      describe: port
        ? `Хост и поддомены, порт ${port}`
        : "Хост и его поддомены",
      test: (url) => {
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          return false;
        }
        if (!parsed.hostname) {
          return false;
        }
        if (!hostRx.test(parsed.hostname.toLowerCase())) {
          return false;
        }
        return port === null || effectivePort(parsed) === port;
      },
    };
  }

  // "example.com/path" -> "*://example.com/path", чтобы это не уехало в хост.
  function asRuleValue(raw) {
    const value = String(raw || "").trim();
    if (!value) {
      return "";
    }
    if (SCHEME_RE.test(value) || value.includes("/")) {
      return value.includes("://") ? value : `*://${value.replace(/^\/+/, "")}`;
    }
    return value;
  }

  function compileRule(raw) {
    if (typeof raw !== "string") {
      return null;
    }
    const value = asRuleValue(raw);
    if (!value) {
      return null;
    }
    return SCHEME_RE.test(value) ? compileUrlRule(value) : compileHostRule(value);
  }

  function compileRules(list) {
    const out = [];
    for (const item of list || []) {
      const matcher = compileRule(item);
      if (matcher) {
        out.push(matcher);
      }
    }
    return out;
  }

  return { compileRule, compileRules, normalizeRuleInput: asRuleValue, effectivePort };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = PB;
}
