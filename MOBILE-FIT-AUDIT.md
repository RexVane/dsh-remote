# Mobile-fit audit and test report

**Target** `lib/client.js` (phone adaptation of the DSH web GUI) plus `lib/index.js`, `package.json`, `cordis.patch.yml`
**Verified against** DSH web build serving `index-CA9Bpko5.js` / `index-BNMwCG9c.css`, 44 client bundles, at `http://127.0.0.1:3080`
**Status** 3 real defects found and fixed, 5 suspected defects investigated and cleared, automated verification added

This report closes items 6–9 of the original task list. It also records what was *not* verified, and why, so nobody has to re-derive it.

---

## 1. Method

The earlier round of work drove a real browser and checked geometry at ten viewport widths. That evidence stands and is not repeated here. What it could not see is a rule that **silently matches nothing** — the failure mode that this stylesheet is most exposed to, because DSH ships CSS modules with per-build hashed class names and a stale selector produces no error, no warning, and a perfectly normal-looking desktop.

So this round attacked the problem from the other side: every selector in the sheet was checked against the bundles the running DSH actually serves, and the JavaScript half was executed under a stub browser to test its behaviour directly.

A key correction happened mid-audit and is worth recording. The first selector sweep searched a corpus that **included this plugin's own bundle**, so every selector matched itself and the sweep reported all-clear. Re-running with the plugin excluded is what surfaced the two dead selectors below. Any future sweep must exclude `dsh-tailscale-serve` from the corpus.

---

## 2. Defects found and fixed

### 2.1 The fish logo was never hidden on the floating button — `_railFish` matched nothing

**Severity** high (visible on every phone page load; contradicts a stated design requirement)

The collapsed sidebar toggle renders two glyphs in one button:

```js
<span className={railMark}>  <FishLogo size={24} />   // brand mark
<IconPanelLeft className={panelIcon} />                // "open menu" affordance
```

and DSH swaps them on hover only:

```css
.hHd-Xa_toggle .hHd-Xa_panelIcon { display: none }
.hHd-Xa_toggle:hover .hHd-Xa_panelIcon { display: inline }
.hHd-Xa_toggle:hover .hHd-Xa_railMark { display: none }
```

A touch screen never satisfies `:hover`. The sheet forced the panel icon visible but tried to hide the mark with `[class*="_railFish"]` — **a class that occurs in no shipped bundle**. The intended class is `_railMark`. Result: both the fish and the panel icon painted inside the same 36px circle.

**Fixed** `_railFish` → `_railMark`, with the hover mechanism recorded in the comment so the rule is not "simplified" away later.

**Evidence** confirmed in a real headless browser against the running DSH. Reintroducing the original selector makes the fish reappear at every phone width, and the fix hides it at every phone width:

```
with _railFish (original)            with _railMark (fixed)
FAIL 320x568: fish mark visible      ok 320x568: fish mark hidden
FAIL 340x720: fish mark visible      ok 340x720: fish mark hidden
… 9 widths, all failing              … 9 widths, all passing
```

### 2.2 The model-name marquee restarted continuously instead of scanning

**Severity** medium (the untested "跑马灯" item; depends on width, permanent when triggered)

`markMarquee` cached each label's width to avoid re-measuring, but it compared measurements taken in **two different style states**: the cached width was read with `data-dsh-marquee` removed, while the next pass compared it against the width read with the attribute present — and the attribute pins the label to `width: 28vw; flex: none`.

When the composer row squeezes the label *narrower* than that window — reachable at 320–360px with a long permission label and a long model name, since DSH ships `_triggerLabel { min-width: 0; overflow: hidden }` — the two numbers can never agree. Every pass then re-measured, and re-adding the attribute **restarts the CSS animation**, so the name jumped back to its start instead of scanning. The code's own comment says the cache exists precisely to prevent this.

**Fixed** the cache now stores the width as it reads in the state the next pass will actually find.

**Evidence** the regression test drives a label that is 80px idle and 109px ticking. Against the pre-fix code it records the churn directly:

```
FAIL  later passes churned the mark
      (-data-dsh-marquee -data-dsh-text +data-dsh-text +data-dsh-marquee   ← pass 2
       -data-dsh-marquee -data-dsh-text +data-dsh-text +data-dsh-marquee)  ← pass 3
```

After the fix, later passes make **zero** attribute changes.

### 2.3 Rotating a phone across the breakpoint permanently lost the phone-only JavaScript

**Severity** medium (reproducible on any phone opened in landscape, and on tablets)

`tuneViewport`, `guardSidebarSessionFocus` and `guardCommandButtonFocus` each early-returned a no-op when the breakpoint did not match **at `apply()` time**, and were never reconsidered.

A 390×844 phone is **844px wide in landscape — past the 820px breakpoint**. Open the page in landscape, rotate to portrait, and the mobile CSS applies while none of the mobile JavaScript does: no keyboard-aware viewport (the soft keyboard covers the composer), and neither focus guard (a sidebar tap and the command button both pop the keyboard over the content). The CSS half is live-responsive for free; the JS half was decided once.

`markMarquee` re-checks the breakpoint on every pass, so the marquee already self-healed — the pattern was known, just applied inconsistently.

**Fixed** added `whilePhone(enter)`, which binds a `matchMedia` `change` listener and installs or tears down the effect on every crossing, in both directions. `mount` and `watchMarquee` stay unconditional and unchanged: the sheet gates itself with `@media`, and `markMarquee` already re-checks.

**Evidence** against the pre-fix code the regression test reports `FAIL no breakpoint listener registered — rotation cannot be noticed`. After the fix it confirms the viewport is tuned on rotation into portrait and **restored** on rotation back.

### 2.4 Cleanup carried out alongside

| Change | Why |
|---|---|
| Removed the `[class*="_popover"]` rule | Matched nothing in any bundle, plugin or shell. See §3.2 — it was also unnecessary. |
| Comment said `22vw`, constant was `28vw` | Doc drift on a load-bearing number that feeds two rules. Corrected and tied to the constant name. |
| Repaired a JSDoc block split by a blank line | `apply()`'s doc comment had broken mid-sentence. |
| Normalised stray 3-tab indentation | `tuneViewport` and the guards were indented inconsistently with the rest of the file. |
| Stale comments about a "250ms watcher" | The watcher is `requestAnimationFrame`-coalesced, not timer-based. |

---

## 3. Suspected defects that turned out to be correct

Recorded so they are not "fixed" into actual bugs later.

### 3.1 The trailing-underscore selectors are deliberate

`[class*="_item_"]`, `_list_`, `_label_`, `_submenu_`, `_scrollable_` look like typos next to `[class*="_sidebarCol"]`. They are not. **DSH uses two naming schemes**, and the sheet correctly targets both:

| Source | Scheme | Example |
|---|---|---|
| UI plugin bundles | `hash_name` | `hHd-Xa_sidebarCol` |
| App shell (`/assets`) | `_name_hash` | `_item_19372` |

The shell classes back the shared menu primitives, so the trailing underscore is required to match them. The first version of the verifier only fetched plugin bundles and wrongly reported all five as dead; it now fetches the shell assets too.

### 3.2 The wide floating panels already clamp themselves

The removed `_popover` rule was aimed at surfaces that all ship their own viewport clamp:

| Element | Ships |
|---|---|
| cordis panel | `width:420px; max-width:calc(100vw - 24px)` |
| feedback note panel | `width:320px; max-width:min(360px, 100vw - 24px)` |
| settings panel | `width:800px; max-width:calc(100vw - 48px)` |
| subagent / jobs menu | `width:336px; max-width:min(400px, 100vw - 32px)` |

What the two menus do **not** clamp is their *position* — both are `position:absolute; left:0` under a trigger near the right edge — which is why they are re-anchored rather than merely narrowed. That distinction is now in the comment.

The `_section` elements at 720/760px that first looked like overflow risks are `max-width`, not `width`. Harmless.

### 3.3 Everything else checked

- `${SETTINGS}` = `[class*="_panel"]:has([class*="_navList"])` resolves correctly: `VOzbGW_panel` contains `VOzbGW_navList` in the same bundle.
- The breadcrumb correctly escapes the generic marquee `width: 28vw` on specificity (4 attributes vs 1), so the session name still spans the full header row.
- `lib/index.js`, `package.json` and `cordis.patch.yml` are mutually consistent; the plugin is correctly linked into the web profile and its bundle is served (`/plugins/dsh-tailscale-serve/client.js`).
- All stable `[class*="…"]` selectors resolve against the current build.

### 3.4 Literal build hashes are prohibited

The former `h8S2Va` (subagent menu), `QsffPG` (jobs menu) and `JObwrW` (context meter) selectors pinned the stylesheet to one DSH build. They have been removed. The same rules now rely only on structural selectors anchored by bundle-unique child suffixes: `_metricToken`, `_rowDot` and `_colorMessages`.

The verifier now rejects every `[class*="…"]` token that does not start at a stable `_name` suffix. This is an offline failure, not a live-build warning, so a new literal build hash cannot enter the stylesheet even when DSH is not running.

---

## 4. Verification

Two complementary suites, both reproducible.

### 4.1 Static — `npm run check`

`node --check` on both halves, then `tools/verify-mobile-fit.mjs`:

```
[1] loads under a stub browser, produces a 34,788-char stylesheet
[1b] loopback leaves the native directory flow untouched; a non-loopback page
     shadows it with the drive-aware flow and uses the plugin's private RPC
[2] braces balanced; no empty blocks; no declarations outside a block;
    103 rules in 4 @media blocks; every rule inside the mobile guard
[3] no stray backtick inside the CSS literal
[4] stable selectors checked against 42 plugin bundles + 4 shell assets — all resolve;
    no hard-coded CSS-module build hashes
[5] regression: a steady label is measured once, not every pass
[6] regression: crossing the breakpoint installs and removes the phone-only JS

PASS — 0 failures, 0 warnings
```

The directory-flow check is intentionally split by origin rather than viewport:
the PC's loopback page keeps DeepSeek Harness's native picker even in a narrow
window, while the phone's Tailscale page keeps the web picker across rotation.
The Host retains its native directory-picker capability; remote list/create
operations use this plugin's own trusted RPC instead of changing the global
DSH picker backend.

Both regression sections were **confirmed to fail against the pre-fix code** before being accepted — a check nobody has watched fail is not evidence. The verifier is overridable via `MOBILE_FIT_SOURCE` for exactly that purpose.

### 4.2 Live geometry — `npm run verify:live`

`tools/verify-mobile-geometry.mjs` drives headless Chrome over CDP using Node's built-in WebSocket — no Playwright, no `npm install`. It boots the real DSH page, then resizes through the matrix and measures what actually laid out. It is read-only: it resizes, measures and screenshots, and never clicks anything that would create a session.

Ten viewports, all passing:

| Viewport | | Viewport | |
|---|---|---|---|
| 320×568 smallest | pass | 412×915 Pixel | pass |
| 340×720 narrow android | pass | 430×932 Pro Max | pass |
| 360×780 common android | pass | 440×956 largest phone | pass |
| 375×667 iPhone SE | pass | 820×1180 breakpoint edge | pass |
| 390×844 iPhone 14/15 | pass | 1200×900 desktop (sheet off) | pass |

Asserted at every phone width: no horizontal document overflow; the floating opener is visible, 36×36, and inside the viewport at 8,4; the collapsed rail track is genuinely `0px`; the fish mark is hidden and the panel icon visible; and the keyboard-aware viewport meta is applied. At 1200px it asserts the opposite — that the toggle is back to `position: static`, i.e. the sheet does not leak past its breakpoint.

Resize settling is polled rather than slept on; a fixed delay made the desktop step flaky. Verified stable across three consecutive runs.

Fresh screenshots: `gui-test-screenshots/360x780-verified.png`, `390x844-verified.png`.

### 4.3 Packaging

`npm pack --dry-run`: 5 files, 80,015 B unpacked. `tools/` and this report are correctly excluded from the published package.

### One trap worth knowing

A backtick typed inside the `CSS` template literal ends it early and breaks the whole plugin. This happened during this very audit — a comment written with backticks around `` `_railMark` `` produced `SyntaxError: Unexpected identifier`. Section [3] of the static verifier exists because of it. Use straight quotes inside that literal.

---

## 5. Remaining limits

| Item | Status |
|---|---|
| Interaction sequences (open the drawer, switch session, open menus and Settings) | Not re-driven this round. The earlier browser session had already walked these and reported them passing; this round verified the *selectors and geometry* they depend on, which is the layer that had gone stale. |
| Scroll smoothness / jank | Not measured. Needs a real device or a profiler; headless emulation would not be representative. |
| Real-device confirmation | Recommended below. Headless Chrome emulates width and `mobile`, but not a touch screen's absent `:hover`, a real soft keyboard, or real rotation. |

**Recommended sanity check on an actual phone**, now that geometry and selectors are proven, is three quick observations:

1. The floating button shows a single panel icon — no fish behind it. *(Fixed in §2.1, verified in emulation.)*
2. A long model name scans smoothly and continuously instead of stuttering back to its start. *(Fixed in §2.2; the restart was proven by test, but the visual smoothness is worth one look.)*
3. Open in landscape, rotate to portrait, tap a sidebar session row — the keyboard must **not** cover the conversation. *(Fixed in §2.3; needs real rotation and a real keyboard.)*
