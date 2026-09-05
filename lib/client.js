/**
 * Browser half of dsh-tailscale-serve: make the DSH web GUI usable on the
 * phone that the tailnet URL is for.
 *
 * Why this lives in the tailscale plugin: exposing DSH over the tailnet is
 * only half of "use DSH from your phone". The shipped layout is desktop-only
 * (the shell wants a 280px sidebar plus a 748px chat column), so at phone
 * width panels squeeze each other and nowrap content paints over its
 * neighbours. The shell adaptation remains stylesheet-driven so DSH's own
 * components, state and buttons stay in charge. The one component here is the
 * non-loopback workspace directory flow required by the phone.
 *
 * The entire client half mounts only on a non-loopback page (`isLoopback ===
 * false`, the phone's Tailscale URL). The PC's 127.0.0.1 page keeps DSH exactly
 * as shipped at every window size — no stylesheet, no watcher, no directory
 * flow. Within a phone page the shell-layout rules additionally live inside
 * `@media (max-width: 820px)`, so desktop-width tablets stay untouched too.
 *
 * Selector strategy: DSH ships CSS modules with per-build hashed class names
 * (`pI_x6G_sidebarCol`), so exact names would break on every DSH upgrade. We
 * match the stable suffix instead (`[class*="_sidebarCol"]`) and anchor on the
 * shell's state attributes (`data-sidebar-collapsed`, `data-details-collapsed`).
 * Where a suffix is not unique across bundles (`_frame`, `_row`, `_panel`) the
 * element is identified by a child it must contain via `:has()` rather than by
 * its own name.
 *
 * Everything is `!important` on purpose: client plugin bundles inject their
 * stylesheets when they load, which is after this one, so equal-specificity
 * rules would lose the source-order tie.
 *
 * The settings plane is DSH's PRIVILEGED_METHODS set, whose gate uses
 * `isTrustedApiRequest(request, [])` with a hardcoded empty trusted-host list.
 * The plugin's trusted RPC channel proxies a deliberately narrow slice of it
 * for the phone (tailnet-membership auth): `llm.discoverModels`, the read-only
 * `settings.describe` (secrets redacted by the provider), `settings.update`
 * scoped to the `agent-presets` namespace so the Agent-preset picker works,
 * and the model-config save path — `settings.mutate` on `llm-*` provider
 * namespaces plus `credentials.describe`/`set`/`unset` for the API-key field.
 * Everything else — remaining settings writes, permission rows — stays
 * loopback-only. The local loopback page keeps DSH's native directory picker. A non-loopback page (the phone's Tailscale URL)
 * shadows the client directory-flow slots and uses this plugin's own trusted
 * RPC for listing/creating directories, so it never invokes privileged
 * `host.pickDirectory`. Chat, trajectory and the already-configured model
 * catalog remain browser-safe.
 */

window.__ModuleLoader__.load({
	id: "dsh-tailscale-serve",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = typeof require === "function" ? require("react") : null;
		const primitives = typeof require === "function" ? require("@deepseek-ai/dsh-client-ui-primitives") : null;

		/** Stable id so a reload/HMR replaces the sheet instead of stacking copies. */
		const STYLE_ID = "dsh-tailscale-serve-mobile-fit";

		/**
		 * Width below which the desktop three-column shell stops working. The
		 * shell wants 280 + 748 + gutters, about 1060px; 820 keeps phones and
		 * small tablets on the mobile shell and leaves desktop windows alone.
		 */
		const BREAKPOINT = "820px";

		/** The same breakpoint for the JS side, so the two can never drift apart. */
		const BREAKPOINT_QUERY = `(max-width: ${BREAKPOINT})`;

		/** Dynamic directory-flow service dependencies. */
		const inject = ["slots", "connection", "settingsScope"];

		/** Private trusted Connection RPC used by the phone-side directory browser. */
		const DIRECTORY_RPC_CHANNEL = "/tailscale-serve";

		/** Stable id for the custom directory browser's component stylesheet. */
		const PICKER_STYLE_ID = "dsh-tailscale-serve-directory-picker";

		/** Shell frame: the grid whose direct child is the sidebar column. */
		const FRAME = "div:has(> [class*=\"_sidebarCol\"])";

		/** Composer footer row: the flex row holding the tool cluster. */
		const INPUT_ROW = "[class*=\"_row\"]:has(> [class*=\"_tools\"])";

		/** Conversation header: the one carrying the breadcrumb trail. */
		const CHAT_HEADER = "[class*=\"_header\"]:has([class*=\"_crumbs\"])";

		/** Settings dialog: the panel containing the section nav list. */
		const SETTINGS = "[class*=\"_panel\"]:has([class*=\"_navList\"])";

		/** Trajectory table/details splitter. */
		const SPLIT = "[class*=\"_split\"]";

		/**
		 * Gap between the two copies of a tickering label, in px. The stylesheet
		 * spends it as padding on the duplicate and the measurement adds it to the
		 * travel distance, so it has to be one shared number.
		 */
		const MARQUEE_GAP = 28;

		/** Ticker speed in px/s — the same reading pace whatever the name's length. */
		const MARQUEE_SPEED = 26;

		/**
		 * The name's viewing window. Used twice: as the cap on a label that fits,
		 * and as the fixed width of one that tickers.
		 */
			const MARQUEE_WINDOW = "28vw";

		/**
		 * Stacking order we impose, bottom to top: dim scrim (50) < sidebar
		 * drawer (60) < details sheet (70) < overlay layer (80). The overlay
		 * layer ships at z-index 20 and carries modals including Settings, so it
		 * has to be lifted above the drawer, or opening Settings from the
		 * expanded sidebar would render behind it.
		 */
		const CSS = `
@media (max-width: ${BREAKPOINT}) {

  /* -- Shell ---------------------------------------------------------- */

  /* DSH keeps a 56px compact rail even when its sidebar state is collapsed.
     On a phone that permanent strip costs too much space, so both inactive
     panel tracks go to zero and the conversation owns the full frame. The
     sidebar still mounts: its own toggle is lifted out as the floating opener
     below, preserving DSH's state and accessibility instead of cloning them. */
  /* Keep the chat track stable while the native layout state changes. The
     expanded sidebar is an overlay, so the conversation remains mounted and
     visible behind it instead of being pushed out of the viewport. */
  ${FRAME}[data-sidebar-collapsed] {
    grid-template-columns: 0 minmax(0, 1fr) 0 !important;
  }
  ${FRAME}:not([data-sidebar-collapsed]) {
    grid-template-columns: min(84vw, 300px) minmax(0, 1fr) 0 !important;
  }

  /* Collapsed rail: zero-width and transparent, with only the native toggle
     allowed to escape as the floating opener. */
  ${FRAME}[data-sidebar-collapsed] > [class*="_sidebarCol"] {
    overflow: visible !important;
    border-right: none !important;
    background: transparent !important;
    pointer-events: auto !important;
  }
  ${FRAME}[data-sidebar-collapsed] > [class*="_sidebarCol"] > [class*="_root"][class*="_collapsed"] {
    width: 0 !important;
    height: 0 !important;
    padding: 0 !important;
    overflow: visible !important;
  }
  ${FRAME}[data-sidebar-collapsed] [class*="_root"][class*="_collapsed"] > :not([class*="_logoRow"]) {
    display: none !important;
  }
  ${FRAME}[data-sidebar-collapsed] [class*="_root"][class*="_collapsed"] > [class*="_logoRow"] {
    width: 0 !important;
    height: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
    overflow: visible !important;
  }

  /* The button is fixed only while collapsed. In the expanded drawer it stays
     in DSH's own header, where the close control belongs. */
  ${FRAME}[data-sidebar-collapsed] [class*="_toggle"] {
    appearance: none !important;
    position: fixed !important;
    /* Header row: 8px top inset + 28px control. Centre this 36px button on it. */
    top: calc(env(safe-area-inset-top) + 4px) !important;
    left: calc(env(safe-area-inset-left) + 8px) !important;
    z-index: 65 !important;
    width: 36px !important;
    height: 36px !important;
    color: var(--dsw-alias-label-primary) !important;
    background: var(--dsw-alias-button-floating-fill) !important;
    border: none !important;
    border-radius: 999px !important;
    outline: none !important;
    box-shadow: none !important;
    overflow: hidden !important;
    -webkit-tap-highlight-color: transparent !important;
    pointer-events: auto !important;
  }
  ${FRAME}[data-sidebar-collapsed] [class*="_toggle"]:focus,
  ${FRAME}[data-sidebar-collapsed] [class*="_toggle"]:focus-visible,
  ${FRAME}[data-sidebar-collapsed] [class*="_logoRow"]:focus-within {
    outline: none !important;
    box-shadow: none !important;
  }
  /* The collapsed toggle ships two glyphs stacked in one button: a brand mark
     ('_railMark', the fish) and a panel icon, and DSH swaps them with
     '.toggle:hover .railMark { display: none }'. A touch screen never satisfies
     :hover, so on the phone BOTH glyphs paint inside this 36px circle. Force the
     swap that hover would have done: the floating button has to read as "open
     the menu", not as a logo. The mark is '_railMark' — an earlier '_railFish'
     here matched nothing in any shipped bundle, so the fish was never hidden. */
  ${FRAME}[data-sidebar-collapsed] [class*="_toggle"] [class*="_panelIcon"] {
    display: inline !important;
  }
  ${FRAME}[data-sidebar-collapsed] [class*="_toggle"] [class*="_railMark"] {
    display: none !important;
  }

  /* Touch Tooltip is not useful on phones; retain the button aria-label. */
  ${FRAME} [class*="_sidebarCol"] [class*="_logoRow"] > [role="tooltip"] {
    display: none !important;
  }

  /* Column resize handles: no col-resize on touch, and they sit over content. */
  ${FRAME} > [class*="_handle"] {
    display: none !important;
  }

  /* Expanded sidebar: the chat stays mounted underneath while this panel covers
     its left edge. This is the previously verified geometry; no fixed ancestor
     or transform is applied to the whole shell. */
  ${FRAME}:not([data-sidebar-collapsed]) > [class*="_sidebarCol"] {
    position: absolute !important;
    top: 0 !important;
    bottom: 0 !important;
    left: 0 !important;
    width: min(84vw, 300px) !important;
    z-index: 60 !important;
    box-shadow: 0 0 24px rgba(0, 0, 0, 0.45) !important;
  }
  ${FRAME}:not([data-sidebar-collapsed]) > [class*="_sidebarCol"] > [class*="_root"] {
    width: 100% !important;
    max-width: 100% !important;
  }

  /* Dim the chat behind the open drawer without taking pointer input. */
  ${FRAME}::after {
    content: "" !important;
    position: absolute !important;
    inset: 0 !important;
    z-index: 50 !important;
    background: rgba(0, 0, 0, 0.38) !important;
    opacity: 0 !important;
    transition: opacity 120ms linear !important;
    pointer-events: none !important;
  }
  ${FRAME}:not([data-sidebar-collapsed])::after {
    opacity: 1 !important;
  }

  /* The details column needs no rule. computeColumns lands on its last branch
     at phone width (56 + 300 + 640 never fits), which returns details:0 — so
     DSH already gives the column a 0px track and it is simply not shown here.
     An earlier version floated it full-screen for the case where it opened;
     that case does not exist, and the rule was one more way for a panel to
     cover the whole shell. */

  /* DSH keeps the details subtree mounted at a zero-width track when closed.
     Hide that dormant subtree on phones so its close button cannot become a
     stray off-screen focus target. When details opens, the data attribute is
     removed and the panel returns normally. */
  ${FRAME}[data-details-collapsed] > [class*="_detailsCol"] {
    visibility: hidden !important;
    pointer-events: none !important;
  }

  /* Modals and toasts must stay above the drawer and the sheet. */
  ${FRAME} > [class*="_overlayLayer"] {
    z-index: 80 !important;
  }

  /* Give anchored popovers a little room to bleed out of the chat column.
     Several of them are absolutely positioned against a narrow ancestor near
     the left of a row — the context meter is width:264px with right:0, which
     resolves to a left edge outside the column — and the column ships
     overflow:hidden, so the first characters were being sliced off.
     Using clip rather than visible: it still bounds runaway content, and unlike
     visible (or hidden) it creates no scroll container at all, so nothing can
     programmatically scroll the column sideways and shift the whole chat. */
  ${FRAME} > [class*="_centerCol"] {
    overflow: clip !important;
    overflow-clip-margin: 60px !important;
  }

  /* -- Conversation header -------------------------------------------- */

  /* 12px/28px/20px of chrome around a title that then had to ellipsise to two
     characters. Tighten the frame and let the breadcrumb use what it frees. */
  ${CHAT_HEADER} {
    --dsh-mobile-header-left: 52px;
    padding: 8px 8px 0 var(--dsh-mobile-header-left) !important;
  }
  /* Give the session name its own first row. DSH normally places breadcrumbs
     and every header action in one flex line, so the name is the first item to
     disappear on a narrow phone. display:contents lets the existing children
     participate in this grid without moving or cloning any React nodes. */
  ${CHAT_HEADER} [class*="_titleRow"] {
    display: grid !important;
    grid-template-columns: minmax(0, 1fr) auto !important;
    grid-template-areas:
      "session utilities"
      "actions actions" !important;
    column-gap: 2px !important;
    row-gap: 2px !important;
    min-height: 0 !important;
  }
  ${CHAT_HEADER} [class*="_titleCluster"] {
    display: contents !important;
  }
  ${CHAT_HEADER} [class*="_crumbs"] {
    grid-area: session !important;
    width: 100% !important;
    min-width: 0 !important;
    overflow: hidden !important;
  }
  ${CHAT_HEADER} [class*="_crumbCurrent"][data-dsh-marquee] {
    width: 100% !important;
    max-width: 100% !important;
  }
  ${CHAT_HEADER} [class*="_crumbCurrent"][data-dsh-marquee]::before,
  ${CHAT_HEADER} [class*="_crumbCurrent"][data-dsh-marquee]::after {
    color: var(--dsw-alias-label-primary) !important;
    font-weight: 500 !important;
  }
  ${CHAT_HEADER} [class*="_crumbSeg"]:last-child {
    flex: 1 1 auto !important;
    min-width: 0 !important;
  }
  ${CHAT_HEADER} [class*="_crumb"]:not([class*="_crumbs"]):not([class*="_crumbSeg"]) {
    max-width: 100% !important;
    min-width: 0 !important;
    padding: 2px 3px !important;
  }
  ${CHAT_HEADER} [class*="_headerActions"] {
    grid-area: actions !important;
    width: calc(100% + var(--dsh-mobile-header-left) - 19px) !important;
    min-width: 0 !important;
    margin-left: calc(19px - var(--dsh-mobile-header-left)) !important;
    padding-left: 0 !important;
    gap: 0 !important;
    white-space: nowrap !important;
    overflow-x: auto !important;
    overflow-y: hidden !important;
    scrollbar-width: none !important;
  }
  ${CHAT_HEADER} [class*="_headerActions"] > * {
    display: flex !important;
    flex: none !important;
    align-items: center !important;
    min-width: max-content !important;
  }
  /* The preset badge (极简模式/标准模式/…) is a read-only session label, and
     a fixed max-width here was squeezing it below its text's natural width, so
     the last character got clipped by its own overflow:hidden. It must never
     give way: flex:0 0 auto keeps it from shrinking inside its row item and
     min-width:max-content pins it to the width its text actually needs. The
     actions row scrolls, so a long custom preset name costs nothing but a
     thumb-swipe instead of an unreadable badge. */
  ${CHAT_HEADER} [class*="_headerActions"] [class*="_label"] {
    flex: 0 0 auto !important;
    min-width: max-content !important;
    max-width: none !important;
    font-size: 11px !important;
  }
  ${CHAT_HEADER} [class*="_headerActions"] button {
    min-width: 0 !important;
    padding-left: 0 !important;
    padding-right: 0 !important;
    font-size: 11px !important;
  }
  ${CHAT_HEADER} [class*="_headerActions"] [class*="_count"] {
    margin-left: 2px !important;
    margin-right: 2px !important;
  }
  ${CHAT_HEADER} [class*="_headerUtilities"] {
    grid-area: utilities !important;
    align-self: center !important;
    margin-left: 2px !important;
    gap: 2px !important;
  }
  ${CHAT_HEADER} [class*="_sessionLogButton"] {
    min-width: 0 !important;
    width: auto !important;
    height: 28px !important;
    padding: 4px 6px !important;
    font-size: 11px !important;
  }

  /* Header popovers ship left-anchored and 336px wide. Their triggers live near
     the right edge on a phone, so that geometry pushes most of each panel beyond
     the viewport. Anchor the panels to the trigger's right edge and cap them to
     the actual visual viewport; rows then ellipsise inside instead of clipping.
     Their own max-height is measured against 100vh — the LARGE viewport on
     mobile Chrome — which is the second reason they need overriding here.

     The structural anchors deliberately avoid CSS-module build hashes.
     '_metricToken' occurs only in the subagent bundle and '_rowDot' only in the
     jobs bundle, so neither anchor can pull in an unrelated menu. */
  ${CHAT_HEADER} [class*="_root"]:has([class*="_metricToken"]),
  ${CHAT_HEADER} [class*="_root"]:has([class*="_rowDot"]) {
    position: relative !important;
  }
  ${CHAT_HEADER} [class*="_menu"]:has([class*="_metricToken"]),
  ${CHAT_HEADER} [class*="_menu"]:has([class*="_rowDot"]) {
    box-sizing: border-box !important;
    position: fixed !important;
    top: calc(env(safe-area-inset-top) + 44px) !important;
    left: calc(env(safe-area-inset-left) + 8px) !important;
    right: calc(env(safe-area-inset-right) + 8px) !important;
    width: auto !important;
    max-width: none !important;
    max-height: min(58dvh, calc(100dvh - 88px)) !important;
    overflow-x: hidden !important;
    overflow-y: auto !important;
  }
  ${CHAT_HEADER} [class*="_menu"]:has([class*="_rowDot"]) [class*="_row"] {
    min-width: 0 !important;
  }
  ${CHAT_HEADER} [class*="_menu"]:has([class*="_rowDot"]) [class*="_kind"],
  ${CHAT_HEADER} [class*="_menu"]:has([class*="_rowDot"]) [class*="_status"],
  ${CHAT_HEADER} [class*="_menu"]:has([class*="_rowDot"]) [class*="_duration"] {
    flex-shrink: 1 !important;
    min-width: 0 !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
  }

  /* Keep the two primary views under the right thumb. Conversation remains the
     default view, but is ordered last so it sits nearest the screen edge. */
  ${CHAT_HEADER} [role="tablist"] {
    justify-content: flex-end !important;
    gap: 24px !important;
    padding-left: 0 !important;
    padding-right: 4px !important;
  }
  ${CHAT_HEADER} [role="tab"]:nth-child(1) {
    order: 2 !important;
  }
  ${CHAT_HEADER} [role="tab"]:nth-child(2) {
    order: 1 !important;
  }

  /* On the narrowest supported phones the text in the export capsule costs
     more than a quarter of the row. Its download glyph and aria semantics are
     enough here; wider phones retain the full label. */
  @media (max-width: 375px) {
    ${CHAT_HEADER} {
      --dsh-mobile-header-left: 48px;
      padding-left: var(--dsh-mobile-header-left) !important;
      padding-right: 4px !important;
    }
    ${CHAT_HEADER} [class*="_sessionLogButton"] {
      width: 28px !important;
      height: 28px !important;
      padding: 0 !important;
      border-radius: 50% !important;
    }
    ${CHAT_HEADER} [class*="_sessionLogButton"] span {
      display: none !important;
    }
    ${CHAT_HEADER} [class*="_headerActions"] [class*="_label"] {
      min-width: max-content !important;
      max-width: none !important;
    }
    ${CHAT_HEADER} [role="tablist"] {
      gap: 18px !important;
    }
  }

  @media (max-width: 340px) {
    ${CHAT_HEADER} [class*="_headerActions"] button {
      font-size: 10px !important;
    }
    ${CHAT_HEADER} [class*="_headerActions"] [class*="_count"] {
      margin-left: 1px !important;
      margin-right: 1px !important;
    }
  }

  /* -- Chat column gutters -------------------------------------------- */

  /* The chat scroller pads itself by calc(side-clearance + 16px) on each side,
     which is 32px per side of dead black at phone width. */
  :root {
    --dsh-composer-side-clearance: 4px !important;
  }
  [class*="_scrollBody"] [class*="_scroll"] {
    padding-left: 10px !important;
    padding-right: 10px !important;
  }

  /* -- Composer footer row -------------------------------------------- */

  /* Row layout is _tools (the + button) / _modes (permission + model pickers)
     / _trailing (slot + send). _trailing ships flex:none, so whenever the row
     overflows something else must yield — and if nothing does, the send button
     is what gets pushed off the edge.
     flex-basis:0 on _modes is the load-bearing part: it makes _modes contribute
     nothing to the row's base size, so the base is just the + button and the
     send button and the row can never overflow. _modes then grows into whatever
     is left and its pickers ellipsise inside that, which is also what stops the
     permission shield from painting over the model name. */
  ${INPUT_ROW} {
    flex-wrap: nowrap !important;
    justify-content: flex-start !important;
    gap: 2px !important;
    padding: 2px 6px 6px !important;
  }
  ${INPUT_ROW} > [class*="_tools"] {
    flex: 0 0 auto !important;
    gap: 2px !important;
  }
  ${INPUT_ROW} [class*="_add"] + [role="tooltip"] {
    display: none !important;
  }
  ${INPUT_ROW} > [class*="_modes"] {
    flex: 0 1 auto !important;
    min-width: 0 !important;
    gap: 4px !important;
  }
  /* _trailing is where the squeeze has to land. It holds the model picker AND
     the send button, and ships flex:none — so when the row overflows it cannot
     give way, and the send button (its last child) is what leaves the card.
     flex-basis:0 lets it take only the leftover width; min-width:0 on every
     descendant is required as well, because each nested flex item defaults to
     min-width:auto and any one of them would prop the box open from inside.
     The send button then keeps its size while the model label absorbs the
     shortfall. */
  ${INPUT_ROW} > [class*="_trailing"] {
    flex: 1 1 auto !important;
    min-width: 0 !important;
    gap: 4px !important;
    justify-content: flex-start !important;
  }
  ${INPUT_ROW} > [class*="_trailing"] > [class*="_primary"] {
    margin-left: auto !important;
  }
  ${INPUT_ROW} > [class*="_modes"] *,
  ${INPUT_ROW} > [class*="_trailing"] * {
    min-width: 0 !important;
  }
  /* The send button is never the one that yields. */
  ${INPUT_ROW} [class*="_primary"] {
    flex: 0 0 auto !important;
  }
  /* Reclaim the pickers' own side padding — 8px of lead-in on each trigger is
     most of the gap that was showing between the + button and the shield. The
     :not()s matter: a bare [class*="_trigger"] also catches _triggerLabel and
     _triggerIcon, and padding on the label skews the overflow measurement the
     marquee depends on. */
  ${INPUT_ROW} [class*="_trigger"]:not([class*="_triggerLabel"]):not([class*="_triggerIcon"]),
  ${INPUT_ROW} [class*="_select"] {
    max-width: 100% !important;
    min-width: 0 !important;
    padding-left: 2px !important;
    padding-right: 2px !important;
  }
  /* The label must stay shrinkable so it, and not the row, absorbs the squeeze —
     that is what makes it measurably clipped and therefore scannable. The cap is
     what bounds the whole cluster: with the name window fixed, nothing in
     _trailing can grow enough to push the send button out, whatever the model is
     called. 28vw (MARQUEE_WINDOW) is roughly two thirds of the width the longest
     current name wanted, and being viewport-relative it holds up on a wider
     screen. Change it in one place: the constant feeds this cap and the ticking
     label's fixed width, and the two must stay identical. */
  ${INPUT_ROW} [class*="_triggerLabel"] {
    min-width: 0 !important;
    max-width: ${MARQUEE_WINDOW} !important;
  }

  /* The model name is allowed to be cut — there is not room for it and the send
     button both. Instead of an ellipsis that hides the tail for good, the name
     tickers: it drifts left at a steady pace, and the instant its last character
     passes the left edge its first character is already arriving at the right,
     with no blank interval between.
     Seamlessness needs two copies of the text chasing each other, and the text
     is a bare text node, so the duplicate is a pseudo-element fed from an
     attribute the watcher writes. Travel is one copy plus the gap, so when copy
     one has fully left, copy two sits exactly where copy one began — the
     animation restarting is then pixel-identical and invisible.
     The label is the clipping box (overflow:hidden lives on it), so only the
     pseudo-element copies move. Transforming the label itself would drag its
     clipping window along and let the text escape over the + button and shield.
     Only labels that are actually clipped get the attribute (see markMarquee) —
     a name that fits never moves. */
  [data-dsh-marquee] {
    /* The label is a fixed compositor viewport. The text copies inside it move
       with transform, so the ticker never invalidates flex layout or paint for
       the composer card while the model streams. */
    position: relative !important;
    display: block !important;
    width: ${MARQUEE_WINDOW} !important;
    flex: none !important;
    text-overflow: clip !important;
    white-space: nowrap !important;
    overflow: hidden !important;
    text-indent: 0 !important;
    contain: layout paint !important;
  }
  [data-dsh-marquee]::before,
  [data-dsh-marquee]::after {
    content: attr(data-dsh-text);
    position: absolute;
    top: 0;
    left: 0;
    color: var(--dsw-alias-label-secondary);
    font-size: 13px;
    font-weight: 500;
    line-height: 20px;
    white-space: nowrap;
    will-change: transform;
    transform: translate3d(0, 0, 0);
  }
  /* The travel variable already includes the shared gap. Adding padding here
     would put copy two one extra gap away and make the loop visibly jump. */
  [data-dsh-marquee]::after {
    left: var(--dsh-marquee-text, 0px);
  }
  [data-dsh-marquee] {
    color: transparent !important;
    line-height: 20px !important;
  }
  [data-dsh-marquee] {
    --dsh-marquee-cycle: var(--dsh-marquee-duration, 8s);
  }
  [data-dsh-marquee]::before,
  [data-dsh-marquee]::after {
    animation: dsh-mfit-marquee-copy var(--dsh-marquee-cycle) linear infinite !important;
  }
  @keyframes dsh-mfit-marquee-copy {
    from { transform: translate3d(0, 0, 0); }
    to { transform: translate3d(calc(-1 * var(--dsh-marquee-text, 0px)), 0, 0); }
  }

  /* -- Message action row --------------------------------------------- */

  /* Why the copy and branch buttons looked missing on the phone: they are not
     missing, they were pushed off the right edge. The row renders the timing
     labels first, and those are hidden behind @media (hover:hover) on the
     desktop — a condition no touch screen satisfies — so on the phone they are
     permanently visible AND white-space:nowrap, consuming the width the two
     buttons needed. Dropping the timings restores the buttons and matches the
     desktop's resting appearance; the same numbers are still in the session
     stats line at the bottom. */
  [class*="_timeStart"],
  [class*="_timeEnd"],
  [class*="_runTimeDot"] {
    display: none !important;
  }

  /* Keep copy and branch only. The like/dislike pair is the sole pair carrying
     aria-pressed (they are toggles), which identifies them without depending on
     a per-build class hash or on a translated aria-label. This hides them at
     phone width only — the buttons and their plugin are untouched, and the
     desktop is outside this media query entirely. */
  [class*="_action"][aria-pressed],
  [class*="_noteOpen"] {
    display: none !important;
  }

  /* -- Trajectory table ----------------------------------------------- */

  /* The pane is overflow:hidden horizontally and every cell ellipsises, so a
     long command is simply unreadable. Let the rows keep their natural width
     and scroll the pane sideways instead. */
  [class*="_tablePane"] {
    overflow: auto !important;
  }
  [class*="_tablePane"] [class*="_eventInner"] {
    min-width: max-content !important;
  }
  [class*="_tablePane"] [class*="_contentText"],
  [class*="_tablePane"] [class*="_inlineResultText"],
  [class*="_tablePane"] [class*="_collapsedTurnText"] {
    overflow: visible !important;
    text-overflow: clip !important;
  }

  /* -- Trajectory details --------------------------------------------- */

  /* Shipped as a side-by-side column: width clamp(320px,38%,440px) capped by
     max-width:calc(100% - 280px), which on a 344px pane resolves to 64px, so
     tapping a row opened a panel too narrow to show anything. Taking the full
     width of the splitter gives it room while leaving it inside its own box:
     an earlier attempt used position:absolute with inset:0 and escaped the
     splitter entirely, covering the header and the tabs — including the panel's
     own close button, which left no way back to the conversation. */
  ${SPLIT} > [class*="_details"] {
    width: 100% !important;
    max-width: 100% !important;
    flex: 1 1 100% !important;
    border-left: none !important;
  }
  [class*="_detailsResizeHandle"] {
    display: none !important;
  }
  /* One scroller, and put it on the body. The sheet nests four scroll areas
     (_detailBody, _detailBodySummary, _overview, _compactedSummary) plus
     _overviewSection children that share the height via flex:1 1 0 and clip
     themselves. Nested touch scrolling is unusable, and _detailBodySummary
     ships overflow:hidden, which cut long tool output off outright. */
  [class*="_detailBody"] {
    overflow-x: hidden !important;
    overflow-y: auto !important;
    -webkit-overflow-scrolling: touch;
  }
  [class*="_detailBodySummary"],
  [class*="_overview"],
  [class*="_compactedSummary"],
  [class*="_promptDiffSections"] {
    overflow: visible !important;
    flex: none !important;
    max-height: none !important;
  }

  /* -- Settings dialog ------------------------------------------------ */

  /* Stack the 188px section nav above the content and scroll it sideways. */
  ${SETTINGS} {
    flex-direction: column !important;
    max-width: calc(100vw - 12px) !important;
    height: min(800px, 100dvh - 24px) !important;
    border-radius: 18px !important;
  }
  ${SETTINGS} [class*="_nav"]:has(> [class*="_navList"]) {
    box-sizing: border-box !important;
    width: 100% !important;
    flex-direction: row !important;
    align-items: center !important;
    gap: 8px !important;
    padding: 10px 12px !important;
    overflow-x: auto !important;
    -webkit-overflow-scrolling: touch;
  }
  ${SETTINGS} [class*="_navTitle"] {
    display: none !important;
  }
  ${SETTINGS} [class*="_navList"] {
    flex-direction: row !important;
  }
  ${SETTINGS} [class*="_navCell"] {
    flex: none !important;
    white-space: nowrap !important;
  }
  /* The scroller is _options, but it can only scroll if every flex ancestor
     may shrink. _content ships without min-height:0, which in the stacked
     column above pins the panel open and kills vertical scrolling entirely. */
  ${SETTINGS} [class*="_content"] {
    min-height: 0 !important;
  }
  ${SETTINGS} [class*="_header"] {
    height: auto !important;
    padding: 8px 10px 4px 12px !important;
  }
  ${SETTINGS} [class*="_options"] {
    padding: 0 12px 16px !important;
  }
  /* Theme cubes are flex:180px, one per row at phone width, each then growing
     to full width. A smaller basis puts three across. */
  [class*="_cubeRow"] {
    gap: 6px !important;
  }
  [class*="_themeCube"] {
    flex: 1 1 84px !important;
    padding: 12px 6px !important;
    border-radius: 12px !important;
  }

  /* -- Hero greeting -------------------------------------------------- */

  /* 26px type in a grid of 34px logo + text + badge. The desktop column has
     room for it; at phone width CJK breaks anywhere, so the greeting wraps to
     two lines and the badge drifts. */
  [class*="_headline"]:has([class*="_headlineText"]) {
    grid-template-columns: 28px auto auto !important;
    column-gap: 6px !important;
    font-size: 21px !important;
    line-height: 28px !important;
  }
  [class*="_heroWorkspaceRow"] {
    padding-left: 8px !important;
  }

  /* -- Session stats line --------------------------------------------- */

  /* Ships white-space:nowrap + text-overflow:ellipsis, so on the phone
     everything past "LLM 3s" is simply unreachable. Same footprint, but
     swipeable — the scrollbar is hidden so it still reads as one quiet line. */
  [class*="_root"]:has(> [class*="_sep"]) {
    padding-left: 10px !important;
    padding-right: 10px !important;
    overflow-x: auto !important;
    text-overflow: clip !important;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }

  /* -- Shared menus --------------------------------------------------- */

  /* The shared menu surface ships min-width:218px/max-width:360px — wider than
     the entire chat column at phone width, which pushes the column's content
     sideways. Cap it to the column: the viewport less the 44px rail and a
     visible margin on each side, so an open menu is never flush against the
     screen edge. For the row metrics, borrow DSH's own compact menu numbers
     (_compactList halves _item from 40px/8px-10px) rather than inventing sizes. */
  [class*="_list_"],
  [class*="_submenu_"] {
    max-width: calc(100vw - 76px) !important;
  }
  [class*="_item_"] {
    min-height: 32px !important;
    gap: 6px !important;
    padding: 5px 8px !important;
    font-size: 13px !important;
    line-height: 20px !important;
  }
  [class*="_label_"] {
    padding: 4px 8px !important;
  }
  /* A 100vh cap is wrong on mobile Chrome: that is the LARGE viewport, taller
     than what is actually visible, so a menu sized against it runs off the
     bottom of the screen with no way to scroll. An anchored menu opening from
     mid-screen only owns the space below it either way. */
  [class*="_scrollable_"],
  [role="menu"],
  [role="listbox"] {
    max-height: min(58dvh, calc(100dvh - 24px)) !important;
    overflow-y: auto !important;
  }

  /* -- Global overflow guards ----------------------------------------- */

  /* Nothing may widen the document: a wide body makes the whole page rock
     sideways, which reads as broken rather than as one wide block. */
  html, body {
    max-width: 100vw !important;
    overflow-x: hidden !important;
  }
  body {
    -webkit-text-size-adjust: 100% !important;
  }
  pre {
    max-width: 100% !important;
    overflow-x: auto !important;
    -webkit-overflow-scrolling: touch;
  }
  img, svg, video, canvas {
    max-width: 100% !important;
  }

  /* No generic anchored-popover cap here, deliberately, and worth recording
     because its absence looks like an omission. Every wide floating surface DSH
     ships already clamps itself against the viewport: the cordis panel is
     420px/max-width:calc(100vw - 24px), the feedback note panel
     320px/max-width:min(360px, 100vw - 24px), the settings panel
     800px/max-width:calc(100vw - 48px), and the subagent and jobs menus are
     336px/max-width:min(400px, 100vw - 32px). What those two menus do NOT
     clamp is their position, which is why they are re-anchored above rather
     than merely narrowed. A previous [class*="_popover"] rule here matched no
     class in any shipped bundle; it was removed instead of being widened,
     because a broader match would have caught surfaces that are already
     correct. */

  /* The context meter panel is anchored to the right side of the composer and
     can be wider than the remaining chat column. Keep the full panel visible
     on phones instead of letting its left edge fall behind the viewport.
     _colorMessages is unique to the conversation bundle, so it anchors this
     panel without a build hash. */
  [class*="_panel"]:has([class*="_colorMessages"]) {
    box-sizing: border-box !important;
    position: fixed !important;
    left: calc(env(safe-area-inset-left) + 8px) !important;
    right: calc(env(safe-area-inset-right) + 8px) !important;
    bottom: calc(env(safe-area-inset-bottom) + 56px) !important;
    width: auto !important;
    max-width: none !important;
    max-height: min(58dvh, calc(100dvh - 80px)) !important;
    overflow: auto !important;
    z-index: 100 !important;
  }
  /* The model picker is right-anchored to a trigger that moves with the
     composer controls. On narrow phones that can resolve partly outside the
     chat column. Detach only this picker from its anchor and place its single
     pane inside the visual viewport; model and effort subviews reuse the same
     element, so both stay in bounds. */
  [class*="_root"]:has(> [class*="_trigger"] > [class*="_triggerLabel"])
    > [class*="_menu"][role="menu"] {
    box-sizing: border-box !important;
    position: fixed !important;
    left: calc(env(safe-area-inset-left) + 8px) !important;
    right: calc(env(safe-area-inset-right) + 8px) !important;
    bottom: calc(env(safe-area-inset-bottom) + 88px) !important;
    width: auto !important;
    max-width: none !important;
    max-height: min(58dvh, calc(100dvh - 112px)) !important;
    overflow-x: hidden !important;
    overflow-y: auto !important;
    z-index: 100 !important;
  }
  /* Centred dialogs get the full width — they have no anchor to overflow. */
  [role="dialog"] {
    max-width: calc(100vw - 16px) !important;
  }

  /* Keep the composer clear of the gesture bar. env() resolves to 0 where
     there is no inset, so this is inert on hardware that does not need it. */
  [class*="_composerSeat"] {
    padding-bottom: env(safe-area-inset-bottom) !important;
  }
}
`;

		/**
		 * Mount the stylesheet, replacing any previous copy.
		 * @returns a teardown that removes it again.
		 */
		function mount() {
			document.getElementById(STYLE_ID)?.remove();
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = CSS;
			document.head.appendChild(style);
			return () => style.remove();
		}

		/** The directory picker is a real component, so its CSS is always mounted. */
		function mountDirectoryPickerStyle() {
			document.getElementById(PICKER_STYLE_ID)?.remove();
			const style = document.createElement("style");
			style.id = PICKER_STYLE_ID;
			style.textContent = `
.dsh-ts-picker-dialog.dsh-ts-picker-dialog {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 0;
  width: min(680px, calc(100vw - 24px));
  height: min(520px, calc(100dvh - 24px));
  padding: 0;
  overflow: hidden;
}
.dsh-ts-picker-shell {
  display: contents;
  color: var(--dsw-alias-label-primary);
}
.dsh-ts-picker-header {
  flex: none;
  padding: 16px 18px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l3);
}
.dsh-ts-picker-title {
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 510;
  line-height: 24px;
}
.dsh-ts-picker-path-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.dsh-ts-picker-computer,
.dsh-ts-picker-path-button {
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 6px;
  padding: 2px 5px;
  font: inherit;
  font-size: 13px;
  line-height: 20px;
}
.dsh-ts-picker-computer:hover,
.dsh-ts-picker-path-button:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-ts-picker-chevron {
  color: var(--dsw-alias-label-tertiary);
  flex: none;
}
.dsh-ts-picker-path-input {
  box-sizing: border-box;
  min-width: 0;
  width: 100%;
  height: 30px;
  color: var(--dsw-alias-label-primary);
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  outline: 0;
  padding: 4px 8px;
  font-size: 13px;
}
.dsh-ts-picker-body {
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 14px 18px;
}
.dsh-ts-picker-drive-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}
.dsh-ts-picker-drive,
.dsh-ts-picker-folder {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 10px;
  text-align: left;
  font: inherit;
}
.dsh-ts-picker-drive {
  min-height: 54px;
  background: var(--dsw-alias-bg-layer-2);
}
.dsh-ts-picker-drive:hover,
.dsh-ts-picker-folder:hover,
.dsh-ts-picker-folder[data-selected="true"] {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-ts-picker-drive-mark {
  flex: none;
  width: 30px;
  height: 30px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 7px;
  display: grid;
  place-items: center;
  color: var(--dsw-alias-button-info-fill);
  font-size: 11px;
  font-weight: 700;
}
.dsh-ts-picker-folder-icon {
  flex: none;
  color: var(--dsw-alias-label-secondary);
}
.dsh-ts-picker-name {
  min-width: 0;
  flex: 1 1 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 500;
}
.dsh-ts-picker-status,
.dsh-ts-picker-truncated,
.dsh-ts-picker-error,
.dsh-ts-picker-empty {
  padding: 8px 4px;
  font-size: 12px;
  line-height: 18px;
}
.dsh-ts-picker-status,
.dsh-ts-picker-truncated,
.dsh-ts-picker-empty { color: var(--dsw-alias-label-secondary); }
.dsh-ts-picker-error { color: var(--dsw-alias-state-error-primary); }
.dsh-ts-picker-footer {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 12px 16px 16px;
  border-top: 1px solid var(--dsw-alias-border-l3);
}
.dsh-ts-picker-footer-gap { flex: 1 1 0; }
.dsh-ts-picker-action { min-width: 72px; }
@media (max-width: ${BREAKPOINT}) {
  .dsh-ts-picker-dialog.dsh-ts-picker-dialog {
    width: calc(100vw - 12px);
    height: min(620px, calc(100dvh - 12px));
  }
  .dsh-ts-picker-header { padding: 14px 12px 9px; }
  .dsh-ts-picker-body { padding: 10px 8px 14px; }
  .dsh-ts-picker-footer {
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px 8px;
    padding: 10px 10px calc(10px + env(safe-area-inset-bottom));
  }
  .dsh-ts-picker-footer-gap { display: none; }
  .dsh-ts-picker-action { min-width: 64px; }
}
`;
			document.head.appendChild(style);
			return () => style.remove();
		}

		const h = (...args) => react.createElement(...args);
		function pickerLabels() {
			const zh = typeof navigator !== "undefined" && /^zh(?:-|$)/i.test(navigator.language ?? "");
			return zh ? {
				title: "选择工作区目录",
				computer: "此电脑",
				home: "主目录",
				loading: "加载中…",
				error: "无法读取目录",
				empty: "没有可用的磁盘",
				emptyFolder: "此文件夹为空",
				newFolder: "新建文件夹",
				folderName: "文件夹名称",
				create: "创建",
				cancel: "取消",
				open: "打开",
				edit: "编辑路径",
				showHidden: "显示隐藏文件",
				truncated: "目录条目过多，仅显示前 1,000 项",
			} : {
				title: "Select Workspace Directory",
				computer: "This PC",
				home: "Home",
				loading: "Loading…",
				error: "Could not read directory",
				empty: "No available drives",
				emptyFolder: "This folder is empty",
				newFolder: "New folder",
				folderName: "Folder name",
				create: "Create",
				cancel: "Cancel",
				open: "Open",
				edit: "Edit path",
				showHidden: "Show hidden files",
				truncated: "More than 1,000 entries — showing the first 1,000",
			};
		}

		function errorText(reason) {
			return reason instanceof Error ? reason.message : String(reason);
		}

		/**
		 * Directory-flow occupant for Windows-style drive navigation. `computer`
		 * is UI state only; every path handed to the Host and workspace owner is
		 * real. Hosts without drive roots fall back to their ordinary home view.
		 */
		function DriveDirectoryFlow(props) {
			const labels = pickerLabels();
			const [computer, setComputer] = react.useState(true);
			const [drives, setDrives] = react.useState(null);
			const [listing, setListing] = react.useState(null);
			const [loading, setLoading] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [pathDraft, setPathDraft] = react.useState(null);
			const [newFolder, setNewFolder] = react.useState(null);
			const [newFolderName, setNewFolderName] = react.useState("");
			const [creating, setCreating] = react.useState(false);
			const [showHidden, setShowHidden] = react.useState(false);
			const openRef = react.useRef(false);
			const generation = react.useRef(0);
			const controller = react.useRef(null);

			const stopRequest = () => {
				controller.current?.abort();
				controller.current = null;
			};

			const loadHome = react.useCallback(() => {
				stopRequest();
				const seq = ++generation.current;
				const ac = new AbortController();
				controller.current = ac;
				setLoading(true);
				setError(null);
				props.listDirectory(undefined, ac.signal).then((next) => {
					if (seq !== generation.current) return;
					setComputer(false);
					setListing(next);
					setLoading(false);
				}, (reason) => {
					if (seq !== generation.current) return;
					setLoading(false);
					setError(errorText(reason));
				});
			}, [props.listDirectory]);

			const loadDirectory = react.useCallback((path) => {
				if (typeof path !== "string" || path.trim() === "") return;
				stopRequest();
				const seq = ++generation.current;
				const ac = new AbortController();
				controller.current = ac;
				setLoading(true);
				setError(null);
				setPathDraft(null);
				props.listDirectory(path, ac.signal).then((next) => {
					if (seq !== generation.current) return;
					setComputer(false);
					setListing(next);
					setLoading(false);
				}, (reason) => {
					if (seq !== generation.current) return;
					setLoading(false);
					setError(errorText(reason));
				});
			}, [props.listDirectory]);

			react.useEffect(() => {
				if (!props.open) {
					openRef.current = false;
					// Invalidate before aborting so the rejection loses the seq guard
					// instead of painting an abort error banner after reopening.
					generation.current += 1;
					stopRequest();
					return;
				}
				if (openRef.current) return;
				openRef.current = true;
				setDrives(null);
				setListing(null);
				setError(null);
				setPathDraft(null);
				setNewFolder(null);
				setShowHidden(false);
				stopRequest();
				const seq = ++generation.current;
				const ac = new AbortController();
				controller.current = ac;
				setComputer(true);
				setLoading(true);
				props.listDrives(ac.signal).then((next) => {
					if (seq !== generation.current) return;
					const roots = Array.isArray(next) ? next.filter((path) => typeof path === "string" && /^[A-Za-z]:\\$/u.test(path)) : [];
					if (roots.length === 0) {
						loadHome();
						return;
					}
					setDrives([...new Set(roots)].sort((a, b) => a.localeCompare(b)));
					setLoading(false);
				}, () => {
					if (seq !== generation.current) return;
					loadHome();
				});
			}, [props.open, props.listDrives, loadHome]);

			react.useEffect(() => () => {
				generation.current += 1;
				stopRequest();
			}, []);

			if (!props.open) return null;
			const crumbs = listing?.crumbs ?? [];
			const entries = listing?.entries?.filter((entry) => showHidden || !entry.hidden) ?? [];
			const targetPath = listing?.path ?? null;
			const targetName = listing?.path?.split(/[\\/]/u).filter(Boolean).at(-1) ?? "";
			const driveRootAvailable = drives !== null;
			const parentBusy = props.busy || creating;
			const submitPath = () => {
				if (parentBusy) return;
				const path = pathDraft?.trim();
				if (path) loadDirectory(path);
			};
			const confirmFolder = () => {
				if (!targetPath || parentBusy || newFolderName.trim() === "") return;
				setCreating(true);
				setError(null);
				props.createDirectory(targetPath, newFolderName.trim()).then((created) => {
					setCreating(false);
					setNewFolder(null);
					setNewFolderName("");
					loadDirectory(created);
				}, (reason) => {
					setCreating(false);
					setError(errorText(reason));
				});
			};
			const pathCrumbs = computer ? [] : crumbs;
			return h(primitives.Modal, {
				open: props.open,
				onClose: () => {
					if (!parentBusy && newFolder === null) props.onCancel();
				},
				title: labels.title,
				className: "dsh-ts-picker-dialog",
				headless: true,
			}, h("div", { className: "dsh-ts-picker-shell" },
				h("div", { className: "dsh-ts-picker-header" },
					h("h2", { className: "dsh-ts-picker-title" }, labels.title),
					pathDraft !== null ? h("input", {
						className: "dsh-ts-picker-path-input",
						value: pathDraft,
						"aria-label": labels.edit,
						autoFocus: true,
						disabled: loading || parentBusy,
						onChange: (event) => setPathDraft(event.target.value),
						onKeyDown: (event) => {
							// isComposing: a Chinese IME's candidate-confirmation Enter
							// must not submit the half-typed path.
							if (event.key === "Enter" && !event.nativeEvent.isComposing) {
								event.preventDefault();
								submitPath();
							}
							if (event.key === "Escape") setPathDraft(null);
						},
					}) : h("div", { className: "dsh-ts-picker-path-row", role: "navigation" },
						h("button", {
							type: "button",
							className: "dsh-ts-picker-computer",
							disabled: parentBusy,
							onClick: () => {
								if (driveRootAvailable) {
									// Invalidate before aborting: the aborted listing's rejection
									// must fail the seq guard, not surface as an error banner.
									// The dropped rejection can no longer clear `loading`, so do
									// it here — the drive grid only renders when it is false.
									generation.current += 1;
									stopRequest();
									setComputer(true);
									setListing(null);
									setError(null);
									setLoading(false);
								} else loadHome();
							},
						}, driveRootAvailable ? labels.computer : labels.home),
						...pathCrumbs.map((crumb, index) => h(react.Fragment, { key: crumb.path },
							index === 0 && h(primitives.IconChevronRightOutline14, { className: "dsh-ts-picker-chevron", size: 12 }),
							h("button", {
								type: "button",
								className: "dsh-ts-picker-path-button",
								disabled: loading || parentBusy,
								onClick: () => loadDirectory(crumb.path),
							}, crumb.name),
						)),
						h("button", {
							type: "button",
							className: "dsh-ts-picker-path-button",
							"aria-label": labels.edit,
							disabled: loading || parentBusy,
							onClick: () => setPathDraft(listing?.path ?? ""),
						}, "✎"),
					)
				),
				h("div", { className: "dsh-ts-picker-body" },
					loading && h("div", { className: "dsh-ts-picker-status", role: "status" }, labels.loading),
					!loading && computer && drives !== null && h("div", { className: "dsh-ts-picker-drive-grid", role: "list" },
						drives.map((drive) => h("button", {
							type: "button",
							className: "dsh-ts-picker-drive",
							key: drive,
							disabled: parentBusy,
							onClick: () => loadDirectory(drive),
							role: "listitem",
							}, h("span", { className: "dsh-ts-picker-drive-mark", "aria-hidden": true }, drive.slice(0, 2)), h("span", { className: "dsh-ts-picker-name" }, drive)))),
					!loading && computer && drives?.length === 0 && h("div", { className: "dsh-ts-picker-empty" }, labels.empty),
					!loading && !computer && entries.length === 0 && h("div", { className: "dsh-ts-picker-empty" }, labels.emptyFolder),
					!loading && !computer && entries.map((entry) => h("button", {
						type: "button",
						className: "dsh-ts-picker-folder",
						key: entry.path,
						disabled: parentBusy,
						onClick: () => loadDirectory(entry.path),
						}, h(primitives.IconFolderClose16, { className: "dsh-ts-picker-folder-icon", size: 16 }), h("span", { className: "dsh-ts-picker-name" }, entry.name), h(primitives.IconChevronRightOutline14, { size: 12 }))),
					!loading && !computer && listing?.truncated === true && h("div", { className: "dsh-ts-picker-truncated", role: "note" }, labels.truncated),
					error !== null && h("div", { className: "dsh-ts-picker-error", role: "alert" }, error),
				),
				h("div", { className: "dsh-ts-picker-footer" },
					h(primitives.Button, {
						variant: "outline",
						icon: h(primitives.IconPlusOutline16, { size: 14 }),
						disabled: computer || loading || parentBusy,
						onClick: () => {
							setNewFolder("");
							setNewFolderName("");
						},
					}, labels.newFolder),
					h("button", {
						type: "button",
						className: "dsh-ts-picker-path-button",
						disabled: computer || parentBusy,
						onClick: () => setShowHidden((value) => !value),
						"aria-pressed": showHidden,
					}, labels.showHidden),
					h("span", { className: "dsh-ts-picker-footer-gap" }),
					h(primitives.Button, { variant: "outline", className: "dsh-ts-picker-action", disabled: parentBusy, onClick: props.onCancel }, labels.cancel),
					h(primitives.Button, { variant: "primary", className: "dsh-ts-picker-action", disabled: parentBusy || computer || targetPath === null || loading, onClick: () => !parentBusy && !loading && !computer && targetPath !== null && props.onPicked(targetPath) }, labels.open),
				),
				newFolder !== null && h(primitives.Modal, {
					open: true,
					onClose: () => !creating && setNewFolder(null),
					title: labels.newFolder,
					headless: true,
				}, h("div", { style: { padding: "22px 24px 20px", display: "flex", flexDirection: "column", gap: "12px" } },
					h("h3", { style: { margin: 0, fontSize: "16px" } }, labels.newFolder),
					h("input", {
						autoFocus: true,
						value: newFolderName,
						"aria-label": labels.folderName,
						disabled: creating,
						onChange: (event) => setNewFolderName(event.target.value),
						onKeyDown: (event) => event.key === "Enter" && !event.nativeEvent.isComposing && confirmFolder(),
					}),
					error !== null && h("div", { className: "dsh-ts-picker-error", role: "alert", style: { margin: 0 } }, error),
					h("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px" } },
						h(primitives.Button, { variant: "outline", disabled: creating, onClick: () => setNewFolder(null) }, labels.cancel),
						h(primitives.Button, { variant: "primary", disabled: creating || newFolderName.trim() === "", onClick: confirmFolder }, labels.create),
					),
				),
				),
			));
		}

		/**
		 * Run a phone-only side effect for exactly as long as the breakpoint holds,
		 * re-evaluating on every crossing.
		 *
		 * The stylesheet above is live-responsive for free: the browser drops the
		 * @media block the moment the viewport grows past the breakpoint. The JS
		 * half is not, and the gap is reachable rather than theoretical — a 390x844
		 * phone is 844px wide in landscape, which is past this 820px breakpoint. So
		 * a page opened in landscape and then rotated to portrait used to get the
		 * mobile CSS with none of the mobile JS: no keyboard-aware viewport, and
		 * neither focus guard. Binding through here keeps the two halves in step in
		 * both directions.
		 * @param enter - installs the effect and returns its teardown.
		 * @returns a teardown that unbinds the listener and any live effect.
		 */
		function whilePhone(enter) {
			const query = window.matchMedia(BREAKPOINT_QUERY);
			let off = null;
			const sync = () => {
				if (query.matches && off === null) {
					off = enter() ?? (() => {});
					return;
				}
				if (!query.matches && off !== null) {
					off();
					off = null;
				}
			};
			sync();
			query.addEventListener("change", sync);
			return () => {
				query.removeEventListener("change", sync);
				if (off !== null) {
					off();
					off = null;
				}
			};
		}

		/**
		 * Let the soft keyboard shorten the layout viewport instead of covering it.
		 *
		 * Android Chrome defaults to `interactive-widget=resizes-visual`: the
		 * keyboard shrinks the visual viewport while the layout viewport keeps its
		 * full height. DSH's composer is `position:absolute; bottom:0` inside a
		 * `height:100%` shell, so it stays pinned to the bottom of that unchanged
		 * layout viewport — which is the part now hidden behind the keyboard. (A
		 * taller composer looked partly fine for the same reason: it grows upward
		 * out of the covered strip.) `resizes-content` makes the keyboard shorten
		 * the layout viewport, so the shell gets shorter and `bottom:0` lands above
		 * the keyboard on its own — no scroll offsets to chase, no visualViewport
		 * listeners to keep in sync.
		 *
		 * Breakpoint gating is `whilePhone`'s job, not this function's.
		 * @returns a teardown restoring the page's own viewport declaration.
		 */
		function tuneViewport() {
			const meta = document.querySelector('meta[name="viewport"]');
			if (meta === null) return () => {};
			const original = meta.getAttribute("content") ?? "";
			const parts = original.split(",").map((part) => part.trim()).filter(Boolean);
			const hadWidget = parts.some((part) => part.startsWith("interactive-widget="));
			const hadFit = parts.some((part) => part.startsWith("viewport-fit="));
			if (hadWidget && hadFit) return () => {};
			if (!hadWidget) parts.push("interactive-widget=resizes-content");
			if (!hadFit) parts.push("viewport-fit=cover");
			meta.setAttribute("content", parts.join(", "));
			return () => meta.setAttribute("content", original);
		}

		/** Marks a picker label whose text does not fit, so the sheet may scan it. */
		const MARQUEE_ATTR = "data-dsh-marquee";
		/** Per-element travel distance for the ticker: one copy plus the gap. */
		const MARQUEE_VAR = "--dsh-marquee-text";

		/** Per-element cycle time, derived from the travel so the pace is constant. */
		const MARQUEE_DURATION_VAR = "--dsh-marquee-duration";

		/** Holds the label's own text for the pseudo-element duplicate to render. */
		const MARQUEE_TEXT_ATTR = "data-dsh-text";

			/** Overflowing model labels and the current session breadcrumb may ticker. */
			const MARQUEE_SELECTOR = '[class*="_triggerLabel"], [class*="_crumbCurrent"]';

		/**
		 * Natural-width cache, keyed by element: a label is only re-measured when
		 * its text or its box actually changed. Without it every coalesced pass
		 * would re-measure, and re-adding the attribute restarts the CSS animation,
		 * so a name would jump back to its start instead of scanning. The stored
		 * width is deliberately the one that reads AFTER the mark is applied or
		 * cleared — see the note at the write below.
		 */
		const measured = new WeakMap();

		/**
		 * Flag the labels that are actually clipped and publish each one's exact
		 * overflow, so the scan animation travels precisely as far as it needs to
		 * and a label that fits stays perfectly still. Measuring is the only way
		 * to know: CSS cannot ask whether text overflows.
		 */
		function markMarquee() {
			if (!window.matchMedia(BREAKPOINT_QUERY).matches) return;
			for (const el of document.querySelectorAll(MARQUEE_SELECTOR)) {
				const text = el.textContent ?? "";
				const prev = measured.get(el);
				if (prev !== undefined && prev.text === text && prev.box === el.clientWidth) continue;

				// Take the measurement with the ticker switched off: text-indent is back
				// at 0 and, with no duplicate rendered, scrollWidth is one copy's width.
				el.removeAttribute(MARQUEE_ATTR);
				el.removeAttribute(MARQUEE_TEXT_ATTR);
				el.style.removeProperty(MARQUEE_VAR);
				el.style.removeProperty(MARQUEE_DURATION_VAR);
				const box = el.clientWidth;
				const natural = el.scrollWidth;
				if (natural - box > 1) {
					const travel = natural + MARQUEE_GAP;
					el.style.setProperty(MARQUEE_VAR, `${String(travel)}px`);
					el.style.setProperty(MARQUEE_DURATION_VAR, `${String(Math.round((travel / MARQUEE_SPEED) * 10) / 10)}s`);
					el.setAttribute(MARQUEE_TEXT_ATTR, text);
					el.setAttribute(MARQUEE_ATTR, "");
				}
				// Cache the width as it reads in the state the next pass will find,
				// which is only the same number when the label was not ticking. A
				// ticking label is `width:${MARQUEE_WINDOW}; flex:none`, so a label
				// that the composer row had squeezed narrower than that window
				// measures one width here and a wider one afterwards. Caching the
				// pre-apply figure made that comparison fail forever: every pass
				// re-measured, and re-adding the attribute restarted the animation,
				// so the name jumped back to its start instead of scanning.
				measured.set(el, { text, box: el.clientWidth });
			}
		}

		/**
		 * Keep those marks current: the label changes when the model or permission
		 * preset changes, and the available width changes on rotation. Streaming a
		 * reply mutates the DOM continuously, so measurements are coalesced onto a
		 * timer instead of running per mutation.
		 * @returns a teardown that stops observing and clears every mark.
		 */
			function watchMarquee() {
				if (typeof MutationObserver !== "function") return () => {};
				let queued = false;
				const schedule = () => {
					if (queued) return;
					queued = true;
					requestAnimationFrame(() => {
						queued = false;
						markMarquee();
					});
				};
				const observer = new MutationObserver((records) => {
					for (const record of records) {
						if (record.type !== "childList" && record.type !== "characterData") continue;
						const target = record.target instanceof Element ? record.target : record.target.parentElement;
						if (target?.closest(MARQUEE_SELECTOR) || target?.querySelector?.(MARQUEE_SELECTOR)) {
							schedule();
							break;
						}
					}
				});
				observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
				window.addEventListener("resize", schedule);
				schedule();
				return () => {
					observer.disconnect();
					window.removeEventListener("resize", schedule);
					for (const el of document.querySelectorAll(MARQUEE_SELECTOR)) {
						el.removeAttribute(MARQUEE_ATTR);
						el.removeAttribute(MARQUEE_TEXT_ATTR);
						el.style.removeProperty(MARQUEE_VAR);
						el.style.removeProperty(MARQUEE_DURATION_VAR);
						measured.delete(el);
					}
				};
			}


			/**
			 * DSH intentionally focuses the composer whenever sessionId changes. On a
			 * phone, a session row tap remains the active user gesture while that effect
			 * runs, so focusing the textarea opens the soft keyboard over the selected
			 * conversation. Suppress only that one sidebar-driven focus. A direct tap on
			 * the composer is not marked and keeps the native keyboard behavior.
			 * Breakpoint gating is `whilePhone`'s job, not this function's.
			 */
			function guardSidebarSessionFocus() {
				let pending = 0;
				let timer = null;
				const clear = () => {
					pending = 0;
					if (timer !== null) {
						clearTimeout(timer);
						timer = null;
					}
				};
				const onPointerDown = (event) => {
					const target = event.target;
					if (!(target instanceof Element)) return;
					const row = target.closest('[class*="_sidebarCol"] [role="treeitem"]');
					if (row === null) return;
					pending = performance.now();
					if (timer !== null) clearTimeout(timer);
					timer = setTimeout(clear, 1200);
				};
				const onFocusIn = (event) => {
					if (pending === 0 || performance.now() - pending > 1200) return;
					const target = event.target;
					if (!(target instanceof HTMLTextAreaElement)) return;
					if (!target.closest('[class*="_composerSeat"]')) return;
					target.blur();
					clear();
				};
				document.addEventListener("pointerdown", onPointerDown, true);
				document.addEventListener("focusin", onFocusIn, true);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown, true);
					document.removeEventListener("focusin", onFocusIn, true);
					clear();
				};
			}

			/**
			 * Keep the command menu touch gesture from focusing the composer.
			 * Breakpoint gating is `whilePhone`'s job, not this function's.
			 */
			function guardCommandButtonFocus() {
				const selector = '[class*="_row"]:has(> [class*="_tools"]) [class*="_add"][aria-haspopup="listbox"]';
				const commandButton = (target) => target instanceof Element ? target.closest(selector) : null;
				const onPointerDown = (event) => {
					if (commandButton(event.target) === null) return;
					const active = document.activeElement;
					if (active instanceof HTMLTextAreaElement && active.closest('[class*="_composerSeat"]')) active.blur();
				};
				const onMouseDown = (event) => {
					if (commandButton(event.target) === null) return;
					event.preventDefault();
					event.stopPropagation();
				};
				document.addEventListener("pointerdown", onPointerDown, true);
				document.addEventListener("mousedown", onMouseDown, true);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown, true);
					document.removeEventListener("mousedown", onMouseDown, true);
				};
			}

			async function callDirectoryRpc(connection, endpoint, payload, signal) {
				const result = await connection.rpc.call(DIRECTORY_RPC_CHANNEL, endpoint, payload, signal);
				if (!result.ok) throw new Error(result.error.message);
				return result.value;
			}

			async function listDriveRoots(connection, signal) {
				const value = await callDirectoryRpc(connection, "listDrives", {}, signal);
				const roots = value?.drives;
				if (!Array.isArray(roots)) throw new Error("drive list response is invalid");
				return roots;
			}

			async function listRemoteDirectory(connection, path, signal) {
				const payload = path === undefined ? {} : { path };
				return await callDirectoryRpc(connection, "listDirectory", payload, signal);
			}

			async function createRemoteDirectory(connection, path, name) {
				const value = await callDirectoryRpc(connection, "createDirectory", { path, name });
				if (typeof value?.path !== "string") throw new Error("directory creation response is invalid");
				return value.path;
			}

			/**
			 * Route the settings page's loopback-only calls through the trusted RPC
			 * channel. DSH pins `llm.discoverModels`, `settings.describe`,
			 * `settings.update`, `settings.mutate` and the `credentials.*` methods
			 * to loopback; the phone's page is same-origin over the tailnet URL, so
			 * the matching `POST /api/…` requests are rewritten here to
			 * `/tailscale-serve/<endpoint>`, which the host serves with DSH's own
			 * services. The reply is re-enveloped exactly like a server response so
			 * the settings page's schema parsing is unaffected. The write surface is
			 * deliberately narrow: `settings.update` is proxied only for the
			 * `agent-presets` namespace (the Agent-preset picker), `settings.mutate`
			 * only for `llm-*` provider namespaces (the model-config page), and
			 * credentials only for env-var-shaped refs — the rest of the settings
			 * plane stays loopback-only. Install/teardown is idempotent across HMR
			 * re-applies.
			 */
			/** The only request paths the settings proxy may intercept. */
			const PROXIED_SETTINGS_PATHS = new Set([
				"/api/llm.discoverModels",
				"/api/settings.describe",
				"/api/settings.update",
				"/api/settings.mutate",
				"/api/credentials.describe",
				"/api/credentials.set",
				"/api/credentials.unset",
			]);

			function installSettingsProxy(ctx) {
				if (typeof window?.fetch !== "function") return () => {};
				const original = window.__dshTailscaleServeFetchOriginal ?? window.fetch.bind(window);
				window.__dshTailscaleServeFetchOriginal = original;
				const proxied = async (input, init) => {
					let pathname = "";
					try {
						pathname = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url ?? input), window.location.href).pathname;
					} catch {
						return original(input, init);
					}
					if ((init?.method ?? "GET").toUpperCase() !== "POST") return original(input, init);
					// Route by path before touching the body: chat sends and other
					// big POST payloads must not pay a JSON.parse on every call.
					if (!PROXIED_SETTINGS_PATHS.has(pathname)) return original(input, init);
					let body = null;
					try {
						body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
					} catch {
						return original(input, init);
					}
					const route = pathname === "/api/llm.discoverModels" && body?.method === "llm.discoverModels" ? { endpoint: "discoverModels", payload: body.payload ?? {} }
						: pathname === "/api/settings.describe" && body?.method === "settings.describe" ? { endpoint: "settingsDescribe", payload: body.payload ?? {} }
						: pathname === "/api/settings.update" && body?.method === "settings.update" && body?.payload?.ns === "agent-presets" ? { endpoint: "settingsUpdateAgentPreset", payload: body.payload }
						: pathname === "/api/settings.mutate" && body?.method === "settings.mutate" && typeof body?.payload?.ns === "string" && body.payload.ns.startsWith("llm-") ? { endpoint: "settingsMutate", payload: body.payload }
						: pathname === "/api/credentials.describe" && body?.method === "credentials.describe" ? { endpoint: "credentialsDescribe", payload: body.payload ?? {} }
						: pathname === "/api/credentials.set" && body?.method === "credentials.set" ? { endpoint: "credentialsSet", payload: body.payload }
						: pathname === "/api/credentials.unset" && body?.method === "credentials.unset" ? { endpoint: "credentialsUnset", payload: body.payload }
						: null;
					if (route === null) return original(input, init);
					const envelope = (result) => new Response(JSON.stringify({ type: "server-response", rpcId: body.rpcId, result }), { status: 200, headers: { "content-type": "application/json" } });
					try {
						const value = await callDirectoryRpc(ctx.connection, route.endpoint, route.payload);
						return envelope({ ok: true, value });
					} catch (error) {
						return envelope({ ok: false, error: { code: "internal", message: error instanceof Error ? error.message : String(error), details: { issues: [] } } });
					}
				};
				// This assignment IS the install: without it the router never wraps
				// window.fetch and every proxied settings call hits the raw /api
				// fence (403 on the phone). The teardown below only unassigns what
				// this line assigned.
				window.fetch = proxied;
				return () => {
					// Restore only if our own wrapper is still installed. Two overlapping
					// generations (HMR re-apply) would otherwise read the shared marker
					// after the newer teardown deleted it and set fetch to undefined.
					if (window.fetch !== proxied) return;
					window.fetch = window.__dshTailscaleServeFetchOriginal;
					delete window.__dshTailscaleServeFetchOriginal;
				};
			}

			/**
			 * Give the phone's settings mirror a real, writable describe view.
			 *
			 * On a non-loopback page DSH substitutes a process-local "memory" mirror
			 * that never calls `settings.describe`, so every settings row reads
			 * writable:false and the Agent-preset picker is disabled (and its menu is
			 * force-closed). The write that picker would perform is exactly the
			 * proxied `settings.update` for the agent-presets namespace, so the phone
			 * CAN persist a preset; only the mirror's mode is wrong. `describe()`
			 * returns the shared mirror object, so flipping its persistence to host
			 * and loading it (after the fetch proxy above is installed) populates the
			 * real view — the row's next load() then enables and stays open. The
			 * other settings sections also render their real values, read-only, since
			 * their write path remains memory-bound.
			 */
			function seedSettingsMirror(ctx) {
				if (typeof queueMicrotask !== "function") return;
				queueMicrotask(() => {
					try {
						const scope = ctx?.get?.("settingsScope") ?? ctx?.settingsScope ?? null;
						const mirror = scope?.describe?.() ?? null;
						if (mirror !== null && typeof mirror.load === "function" && mirror.persistence === "memory") {
							mirror.persistence = "host";
							mirror.load();
						}
					} catch {
						// best-effort seed: a missing or reshaped mirror is not fatal —
						// the settings page keeps its stock memory-bound behavior
					}
				});
			}

			/** Shadow the native flow only on the phone's non-loopback/Tailscale page. */
			function registerDirectoryPicker(ctx) {
				if (react === null || primitives === null || ctx?.slots === undefined || ctx?.connection === undefined || ctx.connection.isLoopback !== false) return;
				// The bounded-unary default (30s) is tight for a big session list
				// over a cellular direct path; a hung host still fails, just later.
				try { ctx.connection.timeoutMs = 120000; } catch {}
				ctx.effect(() => mountDirectoryPickerStyle(), "tailscale-serve: directory picker stylesheet");
				ctx.effect(() => installSettingsProxy(ctx), "tailscale-serve: settings plane proxy");
				seedSettingsMirror(ctx);
				const injected = () => ({
					listDirectory: (path, signal) => listRemoteDirectory(ctx.connection, path, signal),
					createDirectory: (path, name) => createRemoteDirectory(ctx.connection, path, name),
					listDrives: (signal) => listDriveRoots(ctx.connection, signal),
				});
				// `priority: -100` records intent only: the client runner overrides the
				// priority of every non-chain (single) slot via its own allocatePriority,
				// so what actually shadows the stock picker is this bundle registering
				// after it. tools/mobile-qa.mjs QA-04 guards the outcome — on a remote
				// page the dialog that appears must be this plugin's picker dialog.
				ctx.slots.inject("conversation.hero.workspace.directoryFlow", () => ctx.slots.inject("sidebar.workspaces.directoryFlow", function* () {
					yield ctx.slots.register({
						name: "conversation.hero.workspace.directoryFlow",
						priority: -100,
						inject: injected,
					}, DriveDirectoryFlow);
					yield ctx.slots.register({
						name: "sidebar.workspaces.directoryFlow",
						priority: -100,
						inject: injected,
					}, DriveDirectoryFlow);
				}));
			}

		/**
		 * Client plugin body — phone pages only. A loopback (PC) page returns
		 * before anything mounts, so installing this plugin cannot change the
		 * local DSH at any window width; `isLoopback` unknown counts as loopback.
		 *
		 * On a phone page the sheet still gates itself with its own
		 * `@media (max-width: 820px)` block, and `markMarquee` re-checks the
		 * breakpoint on every pass. The other effects change state the media
		 * query cannot reach — a meta attribute and two document-level capture
		 * listeners — so they are bound through `whilePhone`, which installs and
		 * removes them as the breakpoint is crossed.
		 *
		 * Opening the phone page with `?nomobilefit=1` skips the mobile-fit half
		 * but keeps the directory flow, which is the remote functionality itself.
		 * That split is the reliable way to tell a layout fault in this sheet
		 * apart from one in DSH itself: load the same URL with and without the
		 * flag and compare.
		 * @param ctx - client root context (used only for teardown, when present).
		 */
		function apply(ctx) {
			if (ctx?.connection?.isLoopback !== false) return;
			registerDirectoryPicker(ctx);
			if (window.location.search.includes("nomobilefit")) return;
			const teardowns = [
				mount(),
				watchMarquee(),
				whilePhone(tuneViewport),
				whilePhone(guardSidebarSessionFocus),
				whilePhone(guardCommandButtonFocus),
			];
			const teardown = () => {
				for (const off of teardowns) off();
			};
			if (typeof ctx?.effect === "function") {
				ctx.effect(() => teardown, "tailscale-serve: mobile fit stylesheet");
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.callDirectoryRpc = callDirectoryRpc;
		exports.createRemoteDirectory = createRemoteDirectory;
		exports.listRemoteDirectory = listRemoteDirectory;
		exports.listDriveRoots = listDriveRoots;
		return module.exports;
	},
});
