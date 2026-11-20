/**
 * The script that watches what a person does on a page while they teach a Bot. It is run in an isolated world of the
 * page: it sees the page's elements and the person's real events, but the page's own scripts cannot see it, call it
 * or add to what it has seen. It only listens (it never clicks, types or changes anything on the page), and it only
 * keeps events a person made (`isTrusted`), not ones a page made up.
 *
 * What it sends is raw: the name of what was touched and, for typing, what was typed. A field that holds a password,
 * a card or a code is recognised here, so what was typed in it is never even read; the app checks again and keeps
 * its own rules (see `teach.ts`). It is a string, not a function, because a function is rewritten by the build, and
 * what runs in the page must be exactly what is tested here.
 *
 * `window.__deyinTeach.drain()` hands over what was seen since the last call, and forgets it.
 */
export const TEACH_PAGE_SCRIPT = String.raw`(function () {
  var root = typeof window !== "undefined" ? window : globalThis;
  if (root.__deyinTeach) return true;
  var MAX = 500;
  var buffer = [];
  var SECRET_NAME = /pass(word|code|phrase)?|pwd|secret|token|api[\s_-]?key|otp|one[\s-]?time|2fa|verification code|security code|cvv|cvc|card[\s_-]?(number|no)|credit card|iban|ssn|social security|\bpin\b/i;
  var SECRET_AUTOCOMPLETE = /password|cc-|one-time-code/i;
  var CLICKABLE = "a,button,summary,label,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[role=checkbox],[role=radio],[role=switch],input[type=submit],input[type=button],input[type=checkbox],input[type=radio],input[type=reset]";
  var NOT_TYPED = /^(checkbox|radio|button|submit|reset|file|image|range|color|hidden)$/i;

  function push(event) {
    if (buffer.length >= MAX) buffer.shift();
    buffer.push(event);
  }
  function attr(el, name) {
    try {
      var value = el.getAttribute(name);
      return typeof value === "string" ? value : "";
    } catch (error) {
      return "";
    }
  }
  function clean(text) {
    return String(text == null ? "" : text).replace(/\s+/g, " ").trim().slice(0, 80);
  }
  function tag(el) {
    return String(el.tagName || "").toLowerCase();
  }
  function typeOf(el) {
    return String(el.type || attr(el, "type") || "").toLowerCase();
  }
  function labelOf(el) {
    var text = clean(attr(el, "aria-label"));
    if (text) return text;
    var by = attr(el, "aria-labelledby");
    if (by) {
      var parts = [];
      var ids = by.split(/\s+/);
      for (var i = 0; i < ids.length; i += 1) {
        var named = ids[i] ? document.getElementById(ids[i]) : null;
        if (named) parts.push(clean(named.textContent));
      }
      text = clean(parts.join(" "));
      if (text) return text;
    }
    var labels = el.labels;
    if (labels && labels.length) {
      text = clean(labels[0].textContent);
      if (text) return text;
    }
    return clean(attr(el, "placeholder")) || clean(attr(el, "title")) || clean(attr(el, "alt")) || clean(attr(el, "name")) || clean(attr(el, "id"));
  }
  function isSecret(el) {
    if (typeOf(el) === "password") return true;
    if (SECRET_AUTOCOMPLETE.test(attr(el, "autocomplete"))) return true;
    return SECRET_NAME.test(labelOf(el)) || SECRET_NAME.test(attr(el, "name")) || SECRET_NAME.test(attr(el, "id"));
  }
  function describe(el) {
    var name = tag(el);
    var kind = typeOf(el);
    var role = attr(el, "role").toLowerCase();
    var word = "item";
    if (name === "a" || role === "link") word = "link";
    else if (name === "button" || role === "button" || kind === "submit" || kind === "button" || kind === "reset") word = "button";
    else if (kind === "checkbox" || role === "checkbox" || role === "switch") word = "checkbox";
    else if (kind === "radio" || role === "radio" || role === "option") word = "option";
    else if (role === "tab") word = "tab";
    else if (role === "menuitem") word = "menu item";
    else if (name === "summary") word = "section";
    var text = clean(attr(el, "aria-label"));
    if (!text && (kind === "submit" || kind === "button" || kind === "reset")) text = clean(el.value);
    if (!text) text = clean(el.innerText || el.textContent);
    if (!text) text = labelOf(el);
    return text ? word + ' "' + text + '"' : "a " + word;
  }
  function mine(event) {
    return event && event.isTrusted === true && event.target && event.target.nodeType === 1;
  }
  function isField(el) {
    var name = tag(el);
    if (name === "textarea") return true;
    if (name === "input") return !NOT_TYPED.test(typeOf(el));
    return el.isContentEditable === true;
  }

  document.addEventListener("click", function (event) {
    if (!mine(event)) return;
    var el = event.target;
    var clickable = el.closest ? el.closest(CLICKABLE) : null;
    if (!clickable) {
      if (isField(el) || tag(el) === "select") return;
      clickable = el;
    }
    push({ kind: "click", target: describe(clickable) });
  }, true);

  document.addEventListener("input", function (event) {
    if (!mine(event)) return;
    var el = event.target;
    if (!isField(el)) return;
    var secret = isSecret(el);
    var text = "";
    if (!secret) text = String(el.value !== undefined ? el.value : el.textContent);
    push({ kind: "type", target: labelOf(el) || "a field", text: text, secret: secret });
  }, true);

  document.addEventListener("change", function (event) {
    if (!mine(event)) return;
    var el = event.target;
    if (tag(el) !== "select") return;
    var chosen = el.selectedOptions && el.selectedOptions.length ? el.selectedOptions[0] : null;
    push({ kind: "choose", target: labelOf(el) || "a menu", value: chosen ? clean(chosen.textContent) : clean(el.value) });
  }, true);

  document.addEventListener("keydown", function (event) {
    if (!mine(event)) return;
    var key = event.key;
    if (key !== "Enter" && key !== "Escape") return;
    if (key === "Enter" && tag(event.target) === "textarea") return;
    push({ kind: "press", key: key });
  }, true);

  root.__deyinTeach = {
    drain: function () {
      var out = buffer;
      buffer = [];
      return out;
    }
  };
  return true;
})()`;

/** What the app runs to take what the page script has seen so far. Nothing, when the script is not in the page. */
export const TEACH_DRAIN_SCRIPT = `(function () {
  var root = typeof window !== "undefined" ? window : globalThis;
  return root.__deyinTeach ? root.__deyinTeach.drain() : [];
})()`;
