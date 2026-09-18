# Archway Tutor

A Socratic study partner that refuses to just hand over the answer: it asks what you
already tried, then walks you toward the solution one question at a time.

It is an NYU Archway example, and the concept it demonstrates is **system-prompt design
plus multi-turn state** — how much of a tutor's behaviour lives in the prompt rather than
in the code, and how a hint ladder is nothing more than extra turns appended to the same
message array.

## Try it

<https://andrewbuildsnyu.github.io/archway-tutor/>

It runs entirely in your browser and is already pointed at the Archway. Nothing is installed
and nothing is proxied through a server of ours.

## Get a key

Issue yourself one from the Archway portal, at `/portal` on the gateway.

**Make it a low-quota key.** Anything a browser app holds is visible to anyone who opens
the developer tools on that page, including whoever borrows your laptop. Give it a small
monthly token limit and rotate it when you are done with it. The key is kept in
`sessionStorage`, so it disappears when you close the tab.

## Run it locally

```
git clone https://github.com/AndrewBuildsNYU/archway-tutor.git
cd archway-tutor
```

Then open `index.html` — double-click it, or serve the folder with any static file
server. There is no build step, no npm, no dependencies.

Pointing it at a *different* Archway (your own deployment, say) needs that gateway to
list this page's origin in `NYU_CORS_ALLOWED_ORIGINS`. A browser will not let the request
leave otherwise, and the error box will tell you so.

## How it works

The interesting part is `TUTOR_SYSTEM_PROMPT`, built per subject by `buildSystemPrompt()`
in `assets/app.js`. "Be a Socratic tutor" is not enough on its own: the moment a student
pastes a problem and says *just tell me*, a model's default helpfulness wins and it hands
over the answer key. What holds is naming the failure modes explicitly — answering
outright, stacking three questions into one turn, lecturing, condescending — and fixing
the shape of a single turn. Open the collapsed **See the system prompt** panel in the app
and read the whole thing; that is the point of the panel.

The hint ladder is deliberately unglamorous. There is no separate model call, no
temperature trick, no second prompt. Pressing **Give me a hint** appends one more
user-role turn to the same conversation saying which tier to give:

- **tier 1** — a conceptual nudge, no method named
- **tier 2** — names the method or theorem and why it fits, without applying it
- **tier 3** — writes the first concrete step, then hands the pen back

The tiers are defined once in the system prompt so each tier request lands the same way
instead of being re-improvised. **I give up** sends the turn that lifts the
withholding rule and asks for the worked solution plus the insight that was missed; after
that the ladder is spent. Every bubble shows the exact text that was sent, under *what
this sent to the model*.

Everything else is the shared client: `assets/archway.js` holds the key, streams the
completion, renders the `X-NYU-*` readout after each turn, and turns gateway errors into
advice. Model output is written with `textContent` only — never `innerHTML` — because a
model's output is untrusted input.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Markup, the two views, and the handful of layout rules this app adds |
| `assets/app.js` | System prompt, hint ladder, session state, turn handling |
| `assets/archway.js` | Shared Archway client: key panel, models, streaming, readout, errors |
| `assets/archway.css` | Shared design system: tokens, components, dark mode |

MIT licensed.
