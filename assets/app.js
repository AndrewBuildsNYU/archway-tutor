/* Archway Tutor. Owns the system prompt, the hint ladder, and the two-view
   session state machine. Keys, transport, readout and error rendering belong to
   archway.js and are not reimplemented here. */
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }

  // One line per subject, appended to the shared rules. A tutor that opens the
  // same way for a proof and for an essay feels generic, and students stop
  // trusting it; the subject note is what makes the first question sound like it
  // came from someone who has taught the material.
  var SUBJECT_NOTES = {
    "Mathematics": "Ask for their setup and their notation before any algebra. Domain, units and the " +
      "edge cases are questions you ask, not corrections you make.",
    "Physics": "Insist on the picture first: what is the system, what acts on it, what is conserved. " +
      "Symbols all the way through; numbers only at the very end.",
    "Chemistry": "Anchor on what the species actually are and what is conserved - mass, charge, " +
      "electrons - before any calculation gets written down.",
    "Biology": "Push for mechanism and for level: which structure, in which cell, under which " +
      "condition. \"It just does\" is never the end of an answer.",
    "Computer Science": "Ask for the invariant, the base case, or one small concrete input before any " +
      "code. Have them trace their own example rather than reading them yours.",
    "Economics": "Make them state the agent, the constraint and what is being maximised before any " +
      "graph, derivative or diagram appears.",
    "Writing": "Never rewrite their sentence. Ask what the sentence is trying to do, and where a " +
      "reader would stop believing it.",
    "Other": "Ask what the question is really testing before working on the surface of it."
  };

  // Why this prompt is long: "be a Socratic tutor" collapses the moment a student
  // pastes a problem and says "just tell me" - the model's default helpfulness
  // wins and it produces the answer key. What holds is naming the failure modes
  // (answering outright, stacking questions, lecturing, condescending), fixing
  // the shape of a turn, and defining the ladder tiers here so the per-tier turns
  // this app sends land consistently instead of being re-improvised each time.
  var TUTOR_SYSTEM_PROMPT = [
    "You are a Socratic tutor in a one-to-one session with a university student working on a " +
      "{{SUBJECT}} problem. Your job is to make the student arrive at the answer themselves. A " +
      "correct answer they did not derive is a failed session.",
    "",
    "How you work:",
    "1. Never state the final answer, the final result, or the finished passage while hints " +
      "remain. You may confirm or question a step the student has taken. You may not take the " +
      "last step for them.",
    "2. Open the session by asking what they have already tried and where it stopped working. Do " +
      "not attempt any part of the problem before they answer that.",
    "3. Ask exactly one focused question per turn. Not two, not a list. Then stop and wait.",
    "4. Escalate concreteness only when the student is stuck: they say so, they guess twice, or " +
      "they answer with confusion rather than with work. Otherwise stay one level above where " +
      "they already are.",
    "5. Never be condescending. No \"obviously\", no \"as I already said\", no praise for trivial " +
      "steps. Talk to them as a capable person who has not met this particular idea yet.",
    "6. Wrong work is the material, not an error to correct. Ask the question that makes the " +
      "mistake visible to them instead of pointing at it.",
    "7. Keep turns under about 120 words. A wall of text is a lecture, and a lecture ends the " +
      "dialogue.",
    "8. If the student asks you to just give the answer, say plainly that you would rather walk " +
      "them into it, mention once that the app has a button for the full worked solution, and " +
      "carry on with your next question.",
    "",
    "Subject note: {{SUBJECT_NOTE}}",
    "",
    "The interface gives the student a three-tier hint ladder and a separate button that asks for " +
      "the full solution. When a turn tells you which tier to give, give exactly that tier and " +
      "nothing past it:",
    "- Tier 1 is a conceptual nudge. Point at the idea or the part of the problem that matters. " +
      "Name nothing procedural.",
    "- Tier 2 names the method, rule, theorem or structure that applies and says in one sentence " +
      "why it fits this problem. Do not apply it.",
    "- Tier 3 sets up the first concrete step - the first line of work, the first equation, the " +
      "first sentence of the argument - then stops and hands the pen back.",
    "",
    "Write plain prose. No headings, no markdown tables, no bullet lists unless the student asks " +
      "for one. Write mathematics the way you would say it aloud in plain text."
  ].join("\n");

  // split/join rather than replace(): a subject note is prose, and replace()
  // would read a stray "$&" in it as a backreference.
  function buildSystemPrompt(subject) {
    var note = SUBJECT_NOTES[subject] || SUBJECT_NOTES.Other;
    return TUTOR_SYSTEM_PROMPT
      .split("{{SUBJECT}}").join(subject)
      .split("{{SUBJECT_NOTE}}").join(note);
  }

  // Sent as ordinary user turns. Bracketed so the model reads them as interface
  // events rather than as something the student typed.
  var HINT_TURNS = [
    "[The student pressed \"Give me a hint\" - this is hint 1 of 3.] Give the tier 1 hint only: one " +
      "conceptual nudge toward the idea that matters here. Name no method or formula, compute " +
      "nothing, do not restate the problem back at length. End with a single question that checks " +
      "whether the nudge landed.",
    "[The student pressed \"Give me a hint\" - this is hint 2 of 3.] Give the tier 2 hint: name the " +
      "method, rule, theorem or structure that applies, and say in one sentence why it is the right " +
      "fit for this problem. Do not apply it and do not compute. End with a single question asking " +
      "them to take the first step with it.",
    "[The student pressed \"Give me a hint\" - this is hint 3 of 3, the last one.] Give the tier 3 " +
      "hint: set up the first concrete step for them - the first line of work and nothing more - " +
      "then stop and ask them to carry it forward. Still do not finish the problem and still do not " +
      "state the answer."
  ];

  var SOLUTION_TURN =
    "[The student pressed \"I give up - show me the worked solution\".] The hint ladder is finished " +
    "and the rule about withholding the answer no longer applies. Give the complete solution step " +
    "by step, saying for each step what it does and why it is the sensible or legal move. Then a " +
    "final short paragraph that begins \"The insight you were missing:\" naming the one idea that " +
    "unlocks this problem and the signal that should make them reach for it next time. Do not " +
    "scold and do not congratulate.";

  var TEMPERATURE = 0.6;
  var MAX_TOKENS_TURN = 700;
  var MAX_TOKENS_SOLUTION = 1500;

  var state = {
    started: false,
    subject: "",
    system: "",
    model: "",
    messages: [],
    hintsUsed: 0,
    solutionShown: false,
    busy: false,
    controller: null,
    // Bumped whenever a session begins or ends. A turn aborted by "New session"
    // still settles a moment later, and without this its callbacks would push a
    // half-streamed reply into the next session's history.
    epoch: 0
  };

  var hasKey = false;
  var modelsReady = false;

  var setupView = $("setup-view");
  var sessionView = $("session-view");
  var setupLock = $("setup-lock");
  var subjectSel = $("subject");
  var modelSel = $("model");
  var modelSpin = $("model-spin");
  var modelHintText = $("model-hint-text");
  var modelRetry = $("model-retry");
  var problemEl = $("problem");
  var startBtn = $("start");
  var startHint = $("start-hint");
  var setupError = $("setup-error");
  var previewText = $("preview-text");

  var sessionTitle = $("session-title");
  var sessionModel = $("session-model");
  var problemEcho = $("problem-echo");
  var transcript = $("transcript");
  var errorBox = $("error-box");
  var readout = $("readout");
  var readoutWrap = $("readout-wrap");
  var replyEl = $("reply");
  var sendBtn = $("send");
  var hintBtn = $("hint");
  var hintCounter = $("hint-counter");
  var pips = $("pips").querySelectorAll(".pip");
  var ladderNote = $("ladder-note");
  var turnStatus = $("turn-status");
  var stopBtn = $("stop");
  var giveUpBtn = $("give-up");
  var giveUpNote = $("give-up-note");
  var newBtn = $("new-session");
  var liveText = $("live-text");

  // Each async trigger carries its own spinner and its own label span, so the
  // button that started a turn is the one that shows the turn running.
  function btnLabel(btn) { return btn.querySelector("[data-label]"); }

  function setWorking(btn, on) {
    if (!btn) return;
    var spin = btn.querySelector("[data-spin]");
    if (spin) spin.classList.toggle("hidden", !on);
    btn.classList.toggle("is-busy", !!on);
  }

  function setTurnStatus(text) {
    turnStatus.textContent = text || "";
  }

  /* Ending a session abandons whatever turn was in flight, so the triggers it
     left spinning are cleared here rather than by that turn's own finally. */
  function resetWorking() {
    setWorking(startBtn, false);
    setWorking(sendBtn, false);
    setWorking(hintBtn, false);
    setWorking(giveUpBtn, false);
  }

  // renderReadout owns the strip itself but knows nothing about the labelled
  // block around it, which must not sit on the page with nothing under it.
  function showReadout(headers, extra) {
    Archway.renderReadout(readout, headers || null, extra);
    readoutWrap.classList.toggle("hidden", !headers);
  }

  function updateSetupControls() {
    var ready = hasKey && modelsReady;
    var hasProblem = problemEl.value.trim() !== "";

    subjectSel.disabled = !hasKey;
    problemEl.disabled = !hasKey;
    modelSel.disabled = !ready;
    startBtn.disabled = !ready || !hasProblem;
    setupLock.classList.toggle("hidden", hasKey);

    // Say what is missing rather than leaving a dead button to be puzzled over.
    if (!hasKey) startHint.textContent = "Connect your Archway key above to begin.";
    else if (!modelsReady) startHint.textContent = "Waiting for the model list.";
    else if (!hasProblem) startHint.textContent = "Paste the problem above, then start.";
    else startHint.textContent = "Nothing is sent until you press this.";
  }

  var LADDER_NOTES = [
    "Tier 1 points at the idea that matters. No method, no numbers.",
    "Tier 2 names the method or theorem and why it fits, without applying it.",
    "Tier 3 sets up the first line of work, then hands the pen back."
  ];

  function ladderNoteText() {
    if (state.solutionShown) {
      return "The worked solution is on the transcript. Start a new session for another problem.";
    }
    if (state.hintsUsed >= HINT_TURNS.length) {
      return "The ladder is spent. The worked solution is the only rung left.";
    }
    return LADDER_NOTES[state.hintsUsed];
  }

  function updateSessionControls() {
    var ready = state.started && hasKey && !state.busy;
    var spent = state.solutionShown || state.hintsUsed >= HINT_TURNS.length;

    sendBtn.disabled = !ready;
    hintBtn.disabled = !ready || spent;
    giveUpBtn.disabled = !ready || state.solutionShown;
    replyEl.disabled = !state.started || state.busy;
    newBtn.disabled = state.busy;
    stopBtn.classList.toggle("hidden", !state.busy);

    hintCounter.textContent = spent ? "Hints spent" : "Hint " + (state.hintsUsed + 1) + " of 3";
    hintCounter.className = "badge " + (spent ? "badge--warn" : "badge--accent");
    ladderNote.textContent = ladderNoteText();

    for (var i = 0; i < pips.length; i++) {
      var used = i < state.hintsUsed || state.solutionShown;
      var next = !spent && i === state.hintsUsed;
      pips[i].classList.toggle("is-used", used);
      pips[i].classList.toggle("is-next", next);
      // The rung captions are read out as a list; aria-current is what tells a
      // screen reader which of the three is the one a press would spend.
      if (next) pips[i].setAttribute("aria-current", "step");
      else pips[i].removeAttribute("aria-current");
    }

    if (!giveUpArmed) {
      btnLabel(giveUpBtn).textContent = state.solutionShown
        ? "Worked solution shown"
        : GIVE_UP_IDLE;
    }
  }

  function setBusy(busy) {
    state.busy = busy;
    transcript.setAttribute("aria-busy", busy ? "true" : "false");
    if (busy) disarmGiveUp();
    updateSessionControls();
  }

  // --- "I give up" is one press away from ending the ladder, so it takes two.
  // Weight without alarm: the second press is the same button, said plainly.
  var GIVE_UP_IDLE = "Show the worked solution";
  var GIVE_UP_NOTE = "Ends the hint ladder for this problem.";
  var giveUpArmed = false;
  var giveUpTimer = null;

  function disarmGiveUp() {
    if (giveUpTimer) {
      clearTimeout(giveUpTimer);
      giveUpTimer = null;
    }
    if (!giveUpArmed) return;
    giveUpArmed = false;
    giveUpBtn.classList.remove("is-armed");
    btnLabel(giveUpBtn).textContent = GIVE_UP_IDLE;
    giveUpNote.textContent = GIVE_UP_NOTE;
  }

  function armGiveUp() {
    giveUpArmed = true;
    giveUpBtn.classList.add("is-armed");
    btnLabel(giveUpBtn).textContent = "Press again to give up";
    giveUpNote.textContent =
      "This spends the rest of the ladder and asks for the full worked solution.";
    giveUpTimer = setTimeout(disarmGiveUp, 7000);
  }

  function renderPreview() {
    previewText.textContent = buildSystemPrompt(subjectSel.value);
  }

  function scrollTranscript() {
    transcript.scrollTop = transcript.scrollHeight;
  }

  function addBubble(roleLabel, isUser) {
    var wrap = Archway.el("div", isUser ? "msg msg--user" : "msg");
    wrap.appendChild(Archway.el("div", "msg__role", roleLabel));
    var body = Archway.el("div", "msg__body");
    wrap.appendChild(body);
    transcript.appendChild(wrap);
    scrollTranscript();
    return { el: wrap, body: body };
  }

  // Interface turns show a short label, so the thread stays readable, plus the
  // exact text that went to the model - reading that is half the lesson.
  function addStudentBubble(text, sent) {
    var bubble = addBubble("You", true);
    bubble.body.textContent = text;
    if (sent && sent !== text) {
      var peek = Archway.el("details", "sent-peek");
      peek.appendChild(Archway.el("summary", null, "What this sent to the model"));
      peek.appendChild(Archway.el("pre", "prompt-view", sent));
      bubble.el.appendChild(peek);
    }
    scrollTranscript();
    return bubble;
  }

  function runTurn(opts) {
    if (state.busy || !state.started) return;

    var epoch = state.epoch;
    var target = opts.errorTarget || errorBox;
    Archway.clear(target);
    showReadout(null);

    state.messages.push({ role: "user", content: opts.content });
    var studentBubble = addStudentBubble(opts.label, opts.content);
    var tutorBubble = addBubble("Tutor", false);
    tutorBubble.body.classList.add("streaming");

    state.controller = new AbortController();
    setBusy(true);
    setWorking(opts.trigger, true);
    setTurnStatus(opts.status || "The tutor is thinking.");

    var endStatus = "";
    var streamed = "";

    function dropTurn() {
      state.messages.pop();
      studentBubble.el.remove();
      tutorBubble.el.remove();
    }

    Archway.streamChat({
      model: state.model,
      messages: state.messages.slice(),
      system: state.system,
      maxTokens: opts.maxTokens || MAX_TOKENS_TURN,
      temperature: TEMPERATURE,
      signal: state.controller.signal
    }, function (fragment, full) {
      if (epoch !== state.epoch) return;
      streamed = full;
      tutorBubble.body.textContent = full;
      scrollTranscript();
    }).then(function (res) {
      if (epoch !== state.epoch) return;
      state.messages.push({ role: "assistant", content: res.text });
      tutorBubble.body.textContent = res.text;
      showReadout(res.headers, { ms: res.ms });
      scrollTranscript();
    }).catch(function (err) {
      if (epoch !== state.epoch) return;
      if (err && err.name === "AbortError") {
        endStatus = "Stopped.";
        if (streamed) {
          // The model must later see exactly what the student saw, partial or not.
          state.messages.push({ role: "assistant", content: streamed });
          tutorBubble.el.appendChild(Archway.el("p", "xs muted", "Stopped early."));
          return;
        }
        // Nothing arrived: drop the turn so pressing the button again does not
        // duplicate it in the history.
        dropTurn();
        if (opts.onFail) opts.onFail();
        return;
      }
      dropTurn();
      Archway.renderError(target, err);
      if (opts.onFail) opts.onFail();
    }).finally(function () {
      tutorBubble.body.classList.remove("streaming");
      // A turn from a previous session must not clear the spinner of the one
      // that replaced it. Both paths that bump the epoch reset the buttons
      // themselves, so nothing is left spinning either way.
      if (epoch !== state.epoch) return;
      setWorking(opts.trigger, false);
      state.controller = null;
      setTurnStatus(endStatus);
      setBusy(false);
      scrollTranscript();
    });
  }

  function startSession() {
    var problem = problemEl.value.trim();
    if (!problem || !hasKey || !modelsReady) return;

    state.epoch += 1;
    state.started = true;
    state.subject = subjectSel.value;
    state.system = buildSystemPrompt(state.subject);
    state.model = modelSel.value;
    state.messages = [];
    state.hintsUsed = 0;
    state.solutionShown = false;

    disarmGiveUp();
    resetWorking();
    Archway.clear(transcript);
    Archway.clear(errorBox);
    showReadout(null);
    Archway.clear(setupError);
    setTurnStatus("");
    replyEl.value = "";

    sessionTitle.textContent = state.subject + " session";
    // Which model is answering is part of the lesson, so it is on screen for
    // the whole session rather than only in the readout after a turn lands.
    var chosen = modelSel.options[modelSel.selectedIndex];
    sessionModel.textContent = chosen ? chosen.textContent : state.model;
    problemEcho.textContent = problem;
    liveText.textContent = state.system;

    setupView.classList.add("hidden");
    sessionView.classList.remove("hidden");
    updateSessionControls();
    replyEl.focus();

    var opener = "Here is the problem I'm working on:\n\n" + problem;
    runTurn({
      label: opener,
      content: opener,
      maxTokens: MAX_TOKENS_TURN,
      trigger: startBtn,
      status: "Opening the session.",
      // A failed opener leaves an empty session, so send them back to setup - and
      // put the error where they will be looking when they land.
      errorTarget: setupError,
      onFail: function () {
        state.started = false;
        sessionView.classList.add("hidden");
        setupView.classList.remove("hidden");
        problemEl.focus();
      }
    });
  }

  function sendReply() {
    var text = replyEl.value.trim();
    if (!text || state.busy || !state.started) return;
    replyEl.value = "";
    runTurn({
      label: text,
      content: text,
      maxTokens: MAX_TOKENS_TURN,
      trigger: sendBtn
    });
  }

  function askHint() {
    if (state.busy || !state.started || state.solutionShown) return;
    var tier = state.hintsUsed;
    if (tier >= HINT_TURNS.length) return;

    state.hintsUsed = tier + 1;
    updateSessionControls();

    runTurn({
      label: "Give me a hint (" + (tier + 1) + " of 3)",
      content: HINT_TURNS[tier],
      maxTokens: MAX_TOKENS_TURN,
      trigger: hintBtn,
      status: "Writing hint " + (tier + 1) + " of 3.",
      onFail: function () {
        state.hintsUsed = tier;
        updateSessionControls();
      }
    });
  }

  function askSolution() {
    if (state.busy || !state.started || state.solutionShown) return;
    state.solutionShown = true;
    updateSessionControls();

    runTurn({
      label: "I give up - show me the worked solution",
      content: SOLUTION_TURN,
      maxTokens: MAX_TOKENS_SOLUTION,
      trigger: giveUpBtn,
      status: "Working the solution through.",
      onFail: function () {
        state.solutionShown = false;
        updateSessionControls();
      }
    });
  }

  function newSession() {
    if (state.controller) state.controller.abort();
    state.controller = null;
    state.epoch += 1;
    state.started = false;
    state.messages = [];
    state.hintsUsed = 0;
    state.solutionShown = false;
    disarmGiveUp();
    resetWorking();
    setBusy(false);

    Archway.clear(transcript);
    Archway.clear(errorBox);
    showReadout(null);
    Archway.clear(setupError);
    setTurnStatus("");
    replyEl.value = "";
    problemEl.value = "";

    sessionView.classList.add("hidden");
    setupView.classList.remove("hidden");
    updateSessionControls();
    updateSetupControls();
    problemEl.focus();
  }

  function setModelPlaceholder(text) {
    Archway.clear(modelSel);
    modelSel.appendChild(Archway.el("option", null, text));
  }

  function loadModels() {
    modelsReady = false;
    setModelPlaceholder("Loading models...");
    modelSpin.classList.remove("hidden");
    modelRetry.classList.add("hidden");
    modelHintText.textContent = "Asking the Archway which models this key can reach.";
    updateSetupControls();
    Archway.clear(setupError);

    return Archway.listModels().then(function (models) {
      if (!models || !models.length) {
        setModelPlaceholder("No models available");
        modelHintText.textContent = "This key reaches no chat model.";
        modelRetry.classList.remove("hidden");
        setupError.appendChild(buildAlert(
          "No models available",
          "This key cannot reach any chat model. Ask whoever issued it to attach a provider policy."
        ));
        return;
      }
      // Any alias starting with "claude" wins if the gateway carries one; otherwise
      // the helper falls back to the first model in the list.
      Archway.fillModelSelect(modelSel, models, "claude");
      modelsReady = true;
      modelHintText.textContent =
        models.length === 1
          ? "1 model is available to this key."
          : models.length + " models are available to this key.";
    }).catch(function (err) {
      setModelPlaceholder("Model list unavailable");
      modelHintText.textContent = "The model list could not be loaded.";
      modelRetry.classList.remove("hidden");
      Archway.renderError(setupError, err);
    }).finally(function () {
      modelSpin.classList.add("hidden");
      updateSetupControls();
    });
  }

  function buildAlert(title, body) {
    var box = Archway.el("div", "alert");
    box.appendChild(Archway.el("div", "alert__title", title));
    box.appendChild(Archway.el("p", "small", body));
    return box;
  }

  Archway.mountThemeToggle($("theme-toggle"));
  renderPreview();
  updateSetupControls();
  updateSessionControls();

  Archway.mountKeyPanel($("key-mount"), {
    onReady: function () {
      hasKey = true;
      updateSetupControls();
      updateSessionControls();
      loadModels();
    },
    onClear: function () {
      hasKey = false;
      modelsReady = false;
      if (state.controller) state.controller.abort();
      setModelPlaceholder("Connect a key first");
      modelSpin.classList.add("hidden");
      modelRetry.classList.add("hidden");
      modelHintText.textContent = "Every model your key can reach, through one gateway.";
      updateSetupControls();
      updateSessionControls();
    }
  });

  subjectSel.addEventListener("change", renderPreview);
  problemEl.addEventListener("input", updateSetupControls);
  startBtn.addEventListener("click", startSession);
  sendBtn.addEventListener("click", sendReply);
  hintBtn.addEventListener("click", askHint);
  newBtn.addEventListener("click", newSession);
  modelRetry.addEventListener("click", loadModels);

  giveUpBtn.addEventListener("click", function () {
    if (state.busy || !state.started || state.solutionShown) return;
    if (!giveUpArmed) {
      armGiveUp();
      return;
    }
    disarmGiveUp();
    askSolution();
  });

  // Anything that is not the second press is a change of mind.
  giveUpBtn.addEventListener("blur", disarmGiveUp);
  replyEl.addEventListener("focus", disarmGiveUp);

  stopBtn.addEventListener("click", function () {
    if (state.controller) state.controller.abort();
  });

  // Ctrl/Cmd+Enter only: a bare Enter belongs to the textarea, where a student is
  // mid-thought and wants a new line.
  function submitOnModEnter(el, run) {
    el.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        run();
      }
    });
  }
  submitOnModEnter(problemEl, startSession);
  submitOnModEnter(replyEl, sendReply);

  // Escape is the one global hotkey, and it is safe inside a textarea: it types
  // nothing, so it cannot collide with someone mid-sentence.
  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape") return;
    if (giveUpArmed) {
      disarmGiveUp();
      return;
    }
    if (state.busy && state.controller) state.controller.abort();
  });
})();
