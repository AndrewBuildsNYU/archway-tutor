/* NYU Archway - shared browser client for the example apps.
 *
 * One file, no build step, no dependencies, no module system. Plain <script>
 * and a global on purpose: a student who clones the repo and double-clicks
 * index.html gets a working app from file://, which `type="module"` would
 * break on its own CORS rules before any of this ran.
 *
 * What lives here is everything that is the same in all five demos: where the
 * key is kept, how a call is made, how the stream is parsed, and how the
 * X-NYU-* headers are turned into the readout strip. An app file should only
 * ever describe its own idea.
 *
 * Four rules this file does not break:
 *
 *   1. The key lives in sessionStorage, never localStorage. Closing the tab
 *      forgets it. A key pasted into a web page is browser-exposed however
 *      carefully it is held, so the honest mitigation is a short life and a
 *      low quota, not a clever hiding place.
 *   2. credentials: "omit" on every call. Nothing here should ever ride on a
 *      cookie, and on a same-origin deployment an attached session cookie
 *      would make a broken key look like a working one.
 *   3. Model output is written with textContent by the caller. There is no
 *      innerHTML anywhere in this file. Model output is untrusted input.
 *   4. Every response is checked for the mock header. A demo that silently
 *      presents mock output as a real vendor answer is lying to its user.
 */

(function (global) {
  "use strict";

  // The Archway these examples call. Deployment detail, deliberately invisible:
  // it is never rendered, never put in an error message, and there is no field
  // to change it. Someone running their own gateway edits this one line.
  //
  // Keeping it out of the UI is not secrecy theatre - a base URL a visitor can
  // retype is a base URL a visitor can be *told* to retype, and an app whose
  // endpoint is a text box is one screenshot away from sending an NYU key to
  // somebody else's server.
  var BASE_URL = "https://srv1990842.hstgr.cloud";

  var STORE_KEY = "nyu-archway:key";
  var STORE_THEME = "nyu-archway:theme";

  // ---------------------------------------------------------------- storage

  // Private-mode browsers and blocked site data make every one of these throw
  // rather than return null, so each access is guarded and the app must stay
  // usable when storage is simply unavailable.
  function read(key) {
    try {
      return global.sessionStorage.getItem(key);
    } catch (err) {
      return null;
    }
  }

  function write(key, value) {
    try {
      if (value === null || value === undefined || value === "") {
        global.sessionStorage.removeItem(key);
      } else {
        global.sessionStorage.setItem(key, value);
      }
    } catch (err) {
      /* Not fatal: the app keeps the value in memory for this page view. */
    }
  }

  var memoryKey = null;

  function getKey() {
    return memoryKey || read(STORE_KEY) || "";
  }

  function setKey(value) {
    memoryKey = value || null;
    write(STORE_KEY, value);
  }

  /* A key is the only thing an app waits for. */
  function hasKey() {
    return getKey().trim().length > 0;
  }

  // ------------------------------------------------------------------ misc

  function uuid() {
    if (global.crypto && global.crypto.randomUUID) {
      return global.crypto.randomUUID().replace(/-/g, "");
    }
    var out = "";
    for (var i = 0; i < 32; i += 1) {
      out += Math.floor(Math.random() * 16).toString(16);
    }
    return out;
  }

  function el(tag, className, text) {
    var node = global.document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  /* A vendor may send `content` as a string, as null, or as an array of typed
   * parts. Every call site wants a string. */
  function flattenContent(content) {
    if (typeof content === "string") return content;
    if (!content) return "";
    if (Array.isArray(content)) {
      return content
        .map(function (part) {
          if (typeof part === "string") return part;
          if (part && typeof part.text === "string") return part.text;
          return "";
        })
        .join("");
    }
    return "";
  }

  function formatInt(value) {
    if (value === null || value === undefined || value === "") return "-";
    var n = Number(value);
    if (!isFinite(n)) return String(value); // "unlimited" arrives as a literal
    return n.toLocaleString();
  }

  // ----------------------------------------------------------------- error

  function ArchwayError(message, detail) {
    this.name = "ArchwayError";
    this.message = message;
    this.detail = detail || {};
  }
  ArchwayError.prototype = Object.create(Error.prototype);

  /* Both envelopes live under /v1: the OpenAI surface answers
   * {"error":{message,type,param,code}} and /v1/messages answers
   * {"type":"error","error":{type,message}} with no code. Read defensively. */
  function messageFromBody(body, status) {
    if (body && body.error) {
      if (typeof body.error === "string") return body.error;
      if (body.error.message) return body.error.message;
    }
    if (body && typeof body.detail === "string") return body.detail;
    return "The gateway returned HTTP " + status + ".";
  }

  function codeFromBody(body) {
    if (body && body.error && typeof body.error === "object") {
      return body.error.code || body.error.type || "";
    }
    return "";
  }

  // --------------------------------------------------------------- headers

  var READOUT_FIELDS = [
    ["Provider", "x-nyu-provider"],
    ["Model", "x-nyu-model"],
    ["Upstream", "x-nyu-upstream-model"],
    ["Tokens used", "x-nyu-tokens-used"],
    ["Remaining", "x-nyu-tokens-remaining"],
    ["Window", "x-nyu-quota-window"],
    ["Request id", "x-nyu-request-id"],
  ];

  function readHeaders(response) {
    var out = {};
    for (var i = 0; i < READOUT_FIELDS.length; i += 1) {
      out[READOUT_FIELDS[i][1]] = response.headers.get(READOUT_FIELDS[i][1]);
    }
    out["x-nyu-mock"] = response.headers.get("x-nyu-mock");
    out["x-nyu-tokens-limit"] = response.headers.get("x-nyu-tokens-limit");
    out["x-nyu-quota-resets"] = response.headers.get("x-nyu-quota-resets");
    out["x-nyu-response-time-ms"] = response.headers.get("x-nyu-response-time-ms");
    return out;
  }

  /* Render the gateway readout into a container. This strip is the whole
   * reason these apps are Archway demos: it shows which vendor actually served
   * the call, what it cost, what is left, and whether a vendor was involved at
   * all. Every value comes from a response header - see
   * secops.headers.CORSConfig.expose_headers for why a browser can read them. */
  function renderReadout(container, headers, extra) {
    if (!container) return;
    clear(container);

    // Own the strip class rather than trusting the page to have set it. The
    // children below are meaningless without the flex container, and a missing
    // class on the host element is invisible until someone looks at a rendered
    // readout - so the helper that knows the markup applies it.
    container.classList.add("readout");

    if (!headers) {
      container.classList.add("hidden");
      return;
    }
    container.classList.remove("hidden");

    if (headers["x-nyu-mock"] === "true") {
      var badge = el("span", "badge badge--warn", "Mock response");
      badge.title =
        "No active vendor credential for this provider, so the Archway answered " +
        "from its mock adapter. Token accounting is still real.";
      container.appendChild(badge);
    }

    for (var i = 0; i < READOUT_FIELDS.length; i += 1) {
      var label = READOUT_FIELDS[i][0];
      var value = headers[READOUT_FIELDS[i][1]];
      if (!value) continue;
      if (label === "Request id") value = String(value).slice(0, 8);
      if (label === "Tokens used" || label === "Remaining") value = formatInt(value);

      var item = el("div", "readout__item");
      item.appendChild(el("span", "readout__label", label));
      item.appendChild(el("span", "readout__value", value));
      container.appendChild(item);
    }

    if (extra && extra.ms) {
      var timing = el("div", "readout__item");
      timing.appendChild(el("span", "readout__label", "Elapsed"));
      timing.appendChild(el("span", "readout__value", (extra.ms / 1000).toFixed(1) + "s"));
      container.appendChild(timing);
    }
  }

  // ------------------------------------------------------------------ http

  function request(path, options) {
    options = options || {};
    var key = getKey().trim();
    if (!key) {
      return Promise.reject(
        new ArchwayError("No Archway API key yet. Paste your sk-nyu-â€¦ key above to begin.", {
          code: "missing_api_key",
        })
      );
    }

    var headers = {
      Authorization: "Bearer " + key,
      // Pinning our own id makes the response header, the id inside the body
      // and the row in usage_events agree, so a user quoting it to the Archway
      // team names a call that can actually be found.
      "x-nyu-request-id": uuid(),
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    return global
      .fetch(BASE_URL + path, {
        method: options.method || "GET",
        headers: headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        credentials: "omit",
        signal: options.signal,
      })
      .catch(function (err) {
        if (err && err.name === "AbortError") throw err;
        // A blocked CORS preflight and an unreachable host are the same opaque
        // TypeError with no status, so this cannot say which it was. It names
        // neither - the address is not the visitor's to debug.
        throw new ArchwayError(
          "Could not reach the Archway. It may be temporarily unavailable, or this " +
            "page may not be cleared to call it. Try again in a moment.",
          { code: "network_error" }
        );
      });
  }

  function requestJson(path, options) {
    return request(path, options).then(function (response) {
      return response
        .json()
        .catch(function () {
          return null;
        })
        .then(function (body) {
          if (!response.ok) {
            throw new ArchwayError(messageFromBody(body, response.status), {
              status: response.status,
              code: codeFromBody(body),
              headers: readHeaders(response),
            });
          }
          return { body: body, headers: readHeaders(response) };
        });
    });
  }

  // ---------------------------------------------------------------- models

  /* GET /v1/models returns only what THIS key may call, so the picker is
   * already scoped to the caller's permissions. `id` is the alias to send;
   * there is no public_alias field in the response. */
  function listModels() {
    return requestJson("/v1/models").then(function (result) {
      var data = (result.body && result.body.data) || [];
      return data.filter(function (m) {
        return m && m.modality !== "embedding";
      });
    });
  }

  function fillModelSelect(select, models, preferred) {
    if (!select) return;
    clear(select);

    var groups = {};
    var order = [];
    models.forEach(function (m) {
      var name = m.provider || m.owned_by || "Other";
      if (!groups[name]) {
        groups[name] = [];
        order.push(name);
      }
      groups[name].push(m);
    });

    order.forEach(function (name) {
      var group = global.document.createElement("optgroup");
      group.label = name;
      groups[name].forEach(function (m) {
        var option = global.document.createElement("option");
        option.value = m.id;
        option.textContent = m.display_name || m.id;
        group.appendChild(option);
      });
      select.appendChild(group);
    });

    if (preferred) {
      var match = models.filter(function (m) {
        return m.id === preferred || m.id.indexOf(preferred) === 0;
      })[0];
      if (match) select.value = match.id;
    }
  }

  // ------------------------------------------------------------- key access

  /* GET /v1/key - what this key is, and which vendors it unlocks, in one call.
   *
   * The answer is scoped to the key that asks, so it doubles as the cheapest
   * validity check there is: a 200 means the key authenticated, and it costs no
   * tokens to learn that. Nothing about the key's owner is in the response -
   * these pages are browser apps holding somebody else's key, and the gateway
   * treats the person behind it as none of their business.
   *
   * Resolves the body: {key_prefix, name, expires_at, scope, providers: [...]}.
   */
  function describeKey() {
    return requestJson("/v1/key").then(function (result) {
      return result.body || {};
    });
  }

  /* GET /v1/providers - just the vendor list, each entry carrying the aliases
   * this key may send and how much of that vendor's allowance is left. The
   * companion to listModels(): same scoping, grouped the other way. */
  function listProviders() {
    return requestJson("/v1/providers").then(function (result) {
      return (result.body && result.body.data) || [];
    });
  }

  /* One-line summary of a provider entry, for a tooltip. */
  function providerSummary(provider) {
    var name = provider.display_name || provider.id || "This provider";
    if (provider.mock) {
      return (
        name +
        ": NYU holds no active vendor credential, so calls are answered by the " +
        "Archway's mock adapter. Token accounting is still real."
      );
    }
    var quota = provider.quota;
    if (!quota) return name;
    if (quota.exhausted) {
      return name + ": this key has spent its token allowance for the current window.";
    }
    if (quota.remaining === null || quota.remaining === undefined) {
      return name + ": no token limit on this key.";
    }
    return (
      name + ": " + formatInt(quota.remaining) + " tokens left this " + (quota.window || "window") + "."
    );
  }

  /* Pick one model per provider, for the comparison demo. */
  function onePerProvider(models, limit) {
    var seen = {};
    var out = [];
    models.forEach(function (m) {
      var provider = m.provider || m.owned_by || "Other";
      if (seen[provider]) return;
      seen[provider] = true;
      out.push(m);
    });
    return limit ? out.slice(0, limit) : out;
  }

  // ------------------------------------------------------------------ chat

  /* Build a /v1/chat/completions body.
   *
   * `system` is NOT a field on this endpoint - the gateway forwards an unknown
   * top-level key verbatim to the vendor, which then 400s with a complaint
   * that reads like an upstream outage. A system prompt must be a message with
   * role "system", which is what this does.
   */
  function chatBody(opts) {
    var messages = [];
    if (opts.system) messages.push({ role: "system", content: String(opts.system) });
    (opts.messages || []).forEach(function (m) {
      messages.push({ role: m.role, content: flattenContent(m.content) });
    });

    var body = {
      model: opts.model,
      messages: messages,
      // A real boolean: bool("false") is true on the gateway side, so a string
      // here would stream when the caller asked for JSON.
      stream: opts.stream === true,
    };

    // A non-numeric max_tokens escapes as a 500 rather than a 400, so coerce
    // and drop it entirely if it is not a usable number.
    if (opts.maxTokens !== undefined && opts.maxTokens !== null && opts.maxTokens !== "") {
      var n = Number(opts.maxTokens);
      if (isFinite(n) && n > 0) body.max_tokens = Math.floor(n);
    }
    if (typeof opts.temperature === "number" && isFinite(opts.temperature)) {
      body.temperature = opts.temperature;
    }
    if (opts.stream === true) body.stream_options = { include_usage: true };
    return body;
  }

  /* Non-streaming completion. Resolves {text, usage, headers}. */
  function chat(opts) {
    return requestJson("/v1/chat/completions", {
      method: "POST",
      body: chatBody(opts),
      signal: opts.signal,
    }).then(function (result) {
      var choice = (result.body && result.body.choices && result.body.choices[0]) || {};
      var message = choice.message || {};
      return {
        // content is nullable on an empty or tool-only turn.
        text: flattenContent(message.content),
        finishReason: choice.finish_reason || "",
        usage: (result.body && result.body.usage) || null,
        headers: result.headers,
      };
    });
  }

  /* Streaming completion.
   *
   * onDelta(textFragment) is called for each content fragment.
   * Resolves {text, usage, headers} once the stream ends.
   *
   * The awkward parts of this endpoint, all handled below:
   *   - the first frame may be a role-only delta with no content key
   *   - a usage frame has choices: [] so choices[0] is undefined
   *   - a synthesised terminal frame carries an empty delta
   *   - a mid-stream failure arrives as an error frame under HTTP 200
   */
  function streamChat(opts, onDelta) {
    var started = Date.now();
    return request("/v1/chat/completions", {
      method: "POST",
      body: chatBody(
        Object.assign({}, opts, { stream: true })
      ),
      signal: opts.signal,
    }).then(function (response) {
      var headers = readHeaders(response);

      if (!response.ok) {
        return response
          .json()
          .catch(function () {
            return null;
          })
          .then(function (body) {
            throw new ArchwayError(messageFromBody(body, response.status), {
              status: response.status,
              code: codeFromBody(body),
              headers: headers,
            });
          });
      }

      if (!response.body || !response.body.getReader) {
        throw new ArchwayError(
          "This browser cannot read a streaming response. Turn streaming off to continue.",
          { code: "no_stream_support" }
        );
      }

      var reader = response.body.getReader();
      var decoder = new TextDecoder("utf-8");
      var buffer = "";
      var text = "";
      var usage = null;

      function handleFrame(payload) {
        if (payload === "[DONE]") return;

        var data;
        try {
          data = JSON.parse(payload);
        } catch (err) {
          return; // a partial or non-JSON frame is not worth failing the run
        }

        // Headers were flushed long ago, so a mid-stream failure can only
        // arrive as a frame. response.ok is still true here.
        if (data.error) {
          throw new ArchwayError(messageFromBody(data, 200), {
            code: codeFromBody(data),
            headers: headers,
            midStream: true,
          });
        }

        if (data.usage) usage = data.usage;

        var choice = data.choices && data.choices[0];
        if (!choice) return; // the usage frame has choices: []

        var fragment = flattenContent(choice.delta && choice.delta.content);
        if (fragment) {
          text += fragment;
          if (onDelta) onDelta(fragment, text);
        }
      }

      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) {
            return {
              text: text,
              usage: usage,
              headers: headers,
              ms: Date.now() - started,
            };
          }

          buffer += decoder.decode(chunk.value, { stream: true });

          // Frames are separated by a blank line. Anything after the last one
          // is a partial frame and stays in the buffer.
          var parts = buffer.split("\n\n");
          buffer = parts.pop();

          for (var i = 0; i < parts.length; i += 1) {
            var lines = parts[i].split("\n");
            for (var j = 0; j < lines.length; j += 1) {
              var line = lines[j];
              if (line.indexOf("data:") !== 0) continue;
              handleFrame(line.slice(5).trim());
            }
          }
          return pump();
        });
      }

      return pump();
    });
  }

  // ------------------------------------------------------------- key panel

  /* Mount the connect-your-key panel.
   *
   * Every demo carries the same one so that a student who has used any of them
   * knows where the key goes in all the others. The panel collapses to a
   * one-line status bar once a key is present, and reopens on demand.
   */
  function mountKeyPanel(mountNode, options) {
    options = options || {};
    var onReady = options.onReady || function () {};
    var onClear = options.onClear || function () {};

    var panel = el("section", "keypanel");
    var bar = el("div", "keybar hidden");

    // --- the form -----------------------------------------------------
    var head = el("div", "keypanel__head");
    var lock = el("span", "keypanel__icon");
    lock.setAttribute("aria-hidden", "true");
    lock.textContent = "â€¢";
    var headText = el("div");
    headText.appendChild(el("h2", "keypanel__title", "Connect your Archway key"));
    headText.appendChild(
      el(
        "p",
        "keypanel__sub",
        "Paste the key issued to you. Every request this page makes is signed with it and " +
          "metered against your own quota."
      )
    );
    head.appendChild(lock);
    head.appendChild(headText);

    var keyField = el("div", "field");
    var keyLabel = el("label", null, "Archway API key");
    keyLabel.setAttribute("for", "archway-key");

    var keyWrap = el("div", "keyinput");
    var keyInput = el("input");
    keyInput.type = "password";
    keyInput.id = "archway-key";
    keyInput.className = "mono";
    keyInput.placeholder = "sk-nyu-â€¦";
    keyInput.autocomplete = "off";
    keyInput.spellcheck = false;
    keyInput.setAttribute("aria-describedby", "archway-key-hint");

    // Revealing a pasted key is the only way to check it was pasted whole, and
    // it is the visitor's own screen.
    var peek = el("button", "keyinput__peek", "Show");
    peek.type = "button";
    peek.setAttribute("aria-label", "Show the key");

    keyWrap.appendChild(keyInput);
    keyWrap.appendChild(peek);

    var keyHint = el(
      "p",
      "field__hint",
      "Held for this browser tab only â€” closing it forgets the key."
    );
    keyHint.id = "archway-key-hint";

    keyField.appendChild(keyLabel);
    keyField.appendChild(keyWrap);
    keyField.appendChild(keyHint);

    var actions = el("div", "keypanel__actions");
    var connect = el("button", "btn btn--primary", "Connect");
    connect.type = "button";
    var status = el("span", "keypanel__status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    actions.appendChild(connect);
    actions.appendChild(status);

    var warn = el("div", "keypanel__warn");
    var warnMark = el("span", "keypanel__warn-mark", "!");
    warnMark.setAttribute("aria-hidden", "true");
    var warnText = el("p", "keypanel__warn-text");
    warnText.appendChild(el("strong", null, "Use a low-quota key. "));
    warnText.appendChild(
      global.document.createTextNode(
        "This app runs entirely in your browser, so the key you paste is visible to " +
          "anyone with access to this screen. That is fine for a demo key with a small " +
          "allowance, and wrong for a key you use anywhere else."
      )
    );
    warn.appendChild(warnMark);
    warn.appendChild(warnText);

    panel.appendChild(head);
    panel.appendChild(keyField);
    panel.appendChild(actions);
    panel.appendChild(warn);

    // --- the collapsed bar --------------------------------------------
    var dot = el("span", "keybar__dot");
    dot.setAttribute("aria-hidden", "true");
    var barText = el("span", "keybar__text");
    // Filled in asynchronously once the gateway says what this key reaches.
    var access = el("span", "keybar__access");
    access.setAttribute("role", "status");
    access.setAttribute("aria-live", "polite");
    var change = el("button", "btn btn--sm btn--ghost", "Change");
    change.type = "button";
    var forget = el("button", "btn btn--sm btn--ghost keybar__forget", "Forget key");
    forget.type = "button";
    bar.appendChild(dot);
    bar.appendChild(barText);
    bar.appendChild(access);
    bar.appendChild(el("span", "spacer"));
    bar.appendChild(change);
    bar.appendChild(forget);

    mountNode.appendChild(panel);
    mountNode.appendChild(bar);

    function setPeek(on) {
      keyInput.type = on ? "text" : "password";
      peek.textContent = on ? "Hide" : "Show";
      peek.setAttribute("aria-label", (on ? "Hide" : "Show") + " the key");
    }

    /* Say what the connected key actually unlocks.
     *
     * A key is not a uniform grant: it is scoped to some subset of the vendors
     * NYU fronts, and one of those may already be out of tokens or have no
     * credential behind it. A visitor who can see that before picking a model
     * does not have to discover it from a 403 halfway through a demo.
     *
     * Every failure here is swallowed on purpose. This is a courtesy strip; a
     * gateway that cannot answer it must not stop the app from running, and the
     * first real call reports a bad key perfectly well on its own.
     */
    function paintAccess() {
      clear(access);
      describeKey().then(
        function (info) {
          clear(access);
          (info.providers || []).forEach(function (provider) {
            var tone = "";
            if (provider.mock) tone = " badge--warn";
            else if (provider.quota && provider.quota.exhausted) tone = " badge--bad";

            var badge = el("span", "badge" + tone, provider.display_name || provider.id);
            badge.title = providerSummary(provider);
            access.appendChild(badge);
          });
        },
        function () {
          /* Left empty: see above. */
        }
      );
    }

    function showConnected() {
      // The prefix only - enough to tell two keys apart, not enough to use one.
      // The gateway address is deliberately absent: it is not the visitor's to
      // know or to change.
      barText.textContent = "Connected Â· " + getKey().slice(0, 14) + "â€¦";
      panel.classList.add("hidden");
      bar.classList.remove("hidden");
      paintAccess();
    }

    function showForm(message) {
      panel.classList.remove("hidden");
      bar.classList.add("hidden");
      clear(access);
      status.textContent = message || "";
      status.classList.toggle("is-error", false);
      keyInput.focus();
    }

    function fail(message) {
      status.textContent = message;
      status.classList.add("is-error");
      keyInput.focus();
    }

    connect.addEventListener("click", function () {
      var value = keyInput.value.trim();

      if (!value) return fail("Paste a key first.");
      if (value.indexOf("sk-nyu-") !== 0) return fail("An Archway key starts with sk-nyu-");
      if (value.length < 20) return fail("That key looks truncated. Copy the whole thing.");

      setKey(value);
      keyInput.value = "";
      setPeek(false);
      status.textContent = "";
      status.classList.remove("is-error");
      showConnected();
      onReady();
    });

    peek.addEventListener("click", function () {
      setPeek(keyInput.type === "password");
      keyInput.focus();
    });

    keyInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") connect.click();
    });

    keyInput.addEventListener("input", function () {
      if (status.classList.contains("is-error")) {
        status.textContent = "";
        status.classList.remove("is-error");
      }
    });

    change.addEventListener("click", function () {
      showForm("");
    });

    forget.addEventListener("click", function () {
      setKey("");
      showForm("Key forgotten.");
      onClear();
    });

    if (hasKey()) {
      showConnected();
      // Defer so the caller finishes wiring its own handlers first.
      global.setTimeout(onReady, 0);
    }

    return {
      showForm: showForm,
      showConnected: showConnected,
    };
  }

  // ----------------------------------------------------------------- theme

  /* Apply the stored theme. Called both from a pre-paint inline script in the
   * page head (which is why it must be safe to run before DOMContentLoaded)
   * and from the toggle. */
  function applyTheme(theme) {
    var root = global.document.documentElement;
    if (theme === "dark" || theme === "light") {
      root.setAttribute("data-theme", theme);
    } else {
      root.removeAttribute("data-theme");
    }
  }

  function initTheme() {
    var stored = null;
    try {
      stored = global.localStorage.getItem(STORE_THEME);
    } catch (err) {
      stored = null;
    }
    applyTheme(stored);
    return stored;
  }

  function mountThemeToggle(button) {
    if (!button) return;

    function current() {
      var explicit = global.document.documentElement.getAttribute("data-theme");
      if (explicit) return explicit;
      return global.matchMedia && global.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }

    function paint() {
      var now = current();
      button.textContent = now === "dark" ? "Light mode" : "Dark mode";
      button.setAttribute("aria-label", "Switch to " + (now === "dark" ? "light" : "dark") + " mode");
    }

    button.addEventListener("click", function () {
      var next = current() === "dark" ? "light" : "dark";
      applyTheme(next);
      try {
        global.localStorage.setItem(STORE_THEME, next);
      } catch (err) {
        /* a per-viewer convenience; not worth failing over */
      }
      paint();
    });

    paint();
  }

  // --------------------------------------------------------------- errors

  /* Render an error into a container, with the extra sentence that turns each
   * of the common gateway refusals into something actionable. */
  function renderError(container, error) {
    if (!container) return;
    clear(container);
    container.classList.remove("hidden");

    var box = el("div", "alert");
    var code = (error && error.detail && error.detail.code) || "";
    var status = error && error.detail && error.detail.status;

    var title = "Something went wrong";
    var advice = "";

    if (code === "missing_api_key" || code === "invalid_api_key" || status === 401) {
      title = "That key was not accepted";
      advice =
        "Check you copied the whole sk-nyu- key, and that it has not been revoked in the portal.";
    } else if (code === "quota_exceeded") {
      title = "Token quota exhausted";
      advice =
        "This key has spent its allowance for this provider and window. Try a model from " +
        "another provider, or ask the Archway team for an increase.";
    } else if (code === "rate_limit_exceeded") {
      title = "Rate limited";
      advice = "That is a burst limit, separate from your token quota. Wait a moment and retry.";
    } else if (code === "permission_denied" || status === 403) {
      title = "Not permitted for this key";
      advice = "This key is scoped away from that provider or model. Pick another model.";
    } else if (code === "model_not_found" || status === 404) {
      title = "Unknown model";
      advice = "Reload the model list â€” the catalogue may have changed.";
    } else if (code === "network_error" || code === "cors_origin_not_allowed") {
      title = "Could not reach the gateway";
    }

    box.appendChild(el("span", "alert__title", title));
    box.appendChild(el("span", null, (error && error.message) || String(error)));
    if (advice) box.appendChild(el("span", "xs", advice));
    container.appendChild(box);
  }

  // ---------------------------------------------------------------- export

  global.Archway = {
    ArchwayError: ArchwayError,

    getKey: getKey,
    setKey: setKey,
    hasKey: hasKey,

    request: request,
    requestJson: requestJson,
    listModels: listModels,
    describeKey: describeKey,
    listProviders: listProviders,
    providerSummary: providerSummary,
    fillModelSelect: fillModelSelect,
    onePerProvider: onePerProvider,
    chat: chat,
    streamChat: streamChat,
    chatBody: chatBody,

    mountKeyPanel: mountKeyPanel,
    renderReadout: renderReadout,
    renderError: renderError,
    initTheme: initTheme,
    applyTheme: applyTheme,
    mountThemeToggle: mountThemeToggle,

    el: el,
    clear: clear,
    flattenContent: flattenContent,
    formatInt: formatInt,
    uuid: uuid,
  };
})(window);
