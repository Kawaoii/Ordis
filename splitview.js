/* ==========================================================
   ORDIS SPLIT VIEW - left icon rail and side-by-side panes
   ==========================================================
   Two jobs, both aimed at the same thing: getting two panels on screen together
   without a seam between them.

     1. THE RAIL. A vertical column of panel icons down the left edge. It replaces
        the floating pill at the bottom of the window, which had two problems: it
        covered the last row of whatever list was open, and its rounded ends made
        the window look like it was floating a toolbar rather than being one app.

     2. THE SPLIT. Drag a rail icon onto the workspace and the panel joins the open
        one as a second pane. The divider between them drags, and either pane can
        be closed.

   THREE PANES, THREE ARRANGEMENTS, NO OTHERS
   -------------------------------------------
   The layout used to be hardcoded to exactly two panes in one row with a single
   divider, which meant a third panel could not be opened at all and the only
   arrangement on offer was side by side. It is now up to three, and there are
   exactly three ways they can sit:

     1. one pane, filling everything
     2. two panes side by side
     3. one pane on the left, two stacked on the right

   Those are the only three. A free-form grid is what produces the mess in the
   screenshots: a pane dragged to a quarter of the window, a third one wedged into
   whatever space was left, rows of unequal height. Constraining the shape is what
   makes a drag predictable. Adding a fourth pane when three are open replaces the
   oldest rather than reflowing everything.

   WHY NOTHING IS EVER LEFT BROKEN
   ------------------------------
   A drag that moves a pane and re-renders the whole layout on every pointer frame is
   what produced panes stuck half off screen and dividers detached from their
   content. The pane under the pointer is never moved. Instead the arrangement is
   computed and a preview outline is drawn in the space that pane will occupy, and
   nothing changes until the pointer is released. There is no state in which a pane
   is out of place, because a pane is only ever either in its slot or not yet.

   WHY THE PANELS ARE MOVED, NOT CLONED
   -------------------------------------
   renderer.js already owns panel visibility and lazy loading, and getPanelRefs()
   resolves panels by id from anywhere in the document. So a pane takes the real
   element rather than a copy, and showing it is the same code path the strip uses.
   A clone would have meant two live copies of every list, which is the kind of thing
   that works until it does not.

   PERSISTENCE
   -----------
   Which panels are open and how far the divider sits are a user preference, so both
   are saved. Anything naming a panel that no longer exists is dropped rather than
   trusted, the same way the strip's saved order is.
   ========================================================== */
(function () {
  'use strict';

  var STORE_KEY = 'ordis.split.v2';
  var RAIL_WIDTH = 60;
  var DIVIDER_MIN = 260;   // px, so a pane can never be dragged shut entirely
  var DRAG_THRESHOLD = 6;  // px before a press on the rail becomes a drag
  var MAX_PANES = 3;

  var rail = null;
  var workspace = null;
  var panesHost = null;
  var ghost = null;
  var state = { panes: [], ratio: 0.5, columnRatio: 0.5, rowRatio: 0.5 };
  var drag = null;
  var dividerDrag = null;

  /* The three arrangements, as a function of how many panes are open.
   *
   * One and two panes are forced. Three has a choice, and the choice is remembered,
   * so a layout the player built by dragging is the one they get back after a
   * restart. `threeTall` means one on the left and two stacked on the right. */
  function layoutFor(count, preferred) {
    if (count <= 1) return 'single';
    if (count === 2) return 'row';
    return preferred === 'row' ? 'row' : 'threeTall';
  }

  function dock() {
    return window.OrdisDock || null;
  }

  function panels() {
    var d = dock();
    return d && d.panels ? d.panels : [];
  }

  function panelById(id) {
    var list = panels();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* Resolve a panel's element by reference, not by selector.
   *
   * renderPanes empties the host with textContent = '' before rebuilding, which detaches
   * every panel element from the document. A querySelector after that finds nothing, and
   * the pane came out empty. The element is captured first and re-attached by reference,
   * so emptying the host cannot lose it. Elements already inside a pane are looked up
   * there rather than by selector, which is the same problem one step earlier. */
  function elFor(panel) {
    if (!panel) return null;
    var inPane = panesHost && panesHost.querySelector(panel.el);
    if (inPane) return inPane;
    return document.querySelector(panel.el);
  }

  /* Called before the host is emptied, so every panel element is captured while it is
   * still in the document. */
  function capturePanelElements(ids) {
    var found = {};
    ids.forEach(function (id) {
      var panel = panelById(id);
      if (!panel) return;
      var el = panesHost ? panesHost.querySelector(panel.el) : null;
      if (!el) el = document.querySelector(panel.el);
      if (el) found[id] = el;
    });
    return found;
  }

  /* ---------------------------------------------------------
     Persistence
     --------------------------------------------------------- */
  function load() {
    var raw;
    try { raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { raw = null; }
    if (!raw || typeof raw !== 'object') return;

    var kept = [];
    var seen = {};
    (Array.isArray(raw.panes) ? raw.panes : []).slice(0, MAX_PANES).forEach(function (id) {
      // A saved id that no longer resolves would render an empty pane forever, so it
      // is dropped here instead of at paint time.
      if (panelById(id) && !seen[id]) { seen[id] = true; kept.push(id); }
    });
    if (kept.length) state.panes = kept;

    ['ratio', 'columnRatio', 'rowRatio'].forEach(function (key) {
      var r = Number(raw[key]);
      if (isFinite(r) && r > 0.15 && r < 0.85) state[key] = r;
    });
    if (raw.threeLayout === 'row' || raw.threeLayout === 'threeTall') state.threeLayout = raw.threeLayout;
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        panes: state.panes,
        ratio: state.ratio,
        columnRatio: state.columnRatio,
        rowRatio: state.rowRatio,
        threeLayout: state.threeLayout
      }));
    } catch (e) { /* private mode: the layout just will not persist */ }
  }

  /* ---------------------------------------------------------
     Build
     --------------------------------------------------------- */
  function build() {
    var app = document.querySelector('.app-container');
    if (!app) return false;

    // The workspace wraps the panels. It is inserted before the first panel so the
    // existing elements end up inside it, which keeps their original order and means
    // nothing has to be moved on startup just to get a container around them.
    workspace = document.createElement('div');
    workspace.className = 'split-workspace';
    panesHost = document.createElement('div');
    panesHost.className = 'split-panes';
    workspace.appendChild(panesHost);

    var first = app.querySelector('.content, .market-panel, .rivens-panel, [id$="-panel"]');
    if (first && first.parentNode === app) app.insertBefore(workspace, first);
    else app.appendChild(workspace);

    /* Every panel has to end up inside the workspace, not just the one the workspace
     * was inserted before.
     *
     * Leaving the rest as siblings of the workspace split the panels across two
     * containers. The leftovers stayed flex children of .app-container, so when one of
     * them was shown it filled the whole window: the Star Chart panel's "under
     * construction" overlay, which is meant to sit inside its own panel, covered the
     * entire app on every launch with no way to dismiss it. Moving them all is the only
     * arrangement where a panel that is not open is simply not in the layout. */
    panels().forEach(function (panel) {
      var el = document.querySelector(panel.el);
      if (el && el.parentNode !== panesHost) workspace.appendChild(el);
    });

    rail = document.createElement('nav');
    rail.className = 'split-rail';
    rail.setAttribute('aria-label', 'Panels');

    ghost = document.createElement('div');
    ghost.className = 'split-ghost';

    /* Order in this flex row is the whole layout, so the rail has to be inserted
     * before the workspace rather than appended after it. Appending put the rail on
     * the right-hand edge, which is not where a navigation rail belongs. */
    app.insertBefore(rail, workspace);
    app.appendChild(ghost);

    renderRail();
    attachLens();
    attachIconFallbacks();
    return true;
  }

  /* The rail and the dock strip are two renderings of one panel list, and this is the
   * icon field they disagree on.
   *
   * The strip accepts a ligature, an image path, or drawn markup, told apart by the first
   * character. This one did not: it dropped panel.icon straight into innerHTML, so a drawn
   * icon arrived as its own source text and an image path arrived as the words
   * "assets/void-trace.png" on a button. Both are in the list now, so the rail rendered
   * the Rivens and Mods tabs as source code.
   *
   * A failed image is swapped for the panel's glyph from a delegated listener, because an
   * inline onerror attribute cannot be written here without it breaking on the nested
   * quotes - and when it did break, the two panels whose art is not in the repo yet simply
   * rendered an empty 0x0 box. An absent file is a normal state, not an error: the art is
   * optional, and the rail has to read the same with or without it. */
  function railIconMarkup(panel) {
    var icon = panel && panel.icon;
    if (!icon) return '';
    if (icon.charAt(0) === '<') return icon;
    if (/\.(png|webp|svg|jpe?g)$/i.test(icon)) {
      return '<img class="dock-tab-art" src="' + icon + '" alt="" aria-hidden="true" ' +
        'data-fallback-icon="' + (panel.fallbackIcon || 'category') + '">';
    }
    return icon;
  }

  function attachIconFallbacks() {
    if (!rail || rail.dataset.iconFallbackBound === '1') return;
    rail.dataset.iconFallbackBound = '1';
    /* Capture phase: error does not bubble, so a listener on the rail only ever hears its
     * own failures unless it is registered for capture. */
    rail.addEventListener('error', function (e) {
      var img = e.target;
      if (!img || img.tagName !== 'IMG') return;
      var glyph = document.createElement('span');
      glyph.className = 'material-icons-round';
      glyph.textContent = img.dataset.fallbackIcon || 'category';
      if (img.parentNode) img.parentNode.replaceChild(glyph, img);
    }, true);
  }

  /* The lens: one circle that rides the rail and magnifies the icon under the cursor.
   *
   * It is a single element moved with a transform, not a circle per button. With one per
   * button, the boundary between two neighbours is a moment where two of them each think
   * they are the hovered one, and the effect stutters exactly where the eye is tracking
   * it. One lens has one position and no boundary to disagree about.
   *
   * Position is read from the button's own box rather than from the pointer, so the lens
   * snaps to whole icons. Following the raw pointer position put the lens between two
   * icons, magnifying the gap. */
  var lens = null;
  var lensHideTimer = null;

  function ensureLens() {
    if (lens || !rail) return lens;
    lens = document.createElement('div');
    lens.className = 'split-rail-lens';
    lens.setAttribute('aria-hidden', 'true');
    rail.appendChild(lens);
    return lens;
  }

  function lensTo(btn) {
    if (!btn || !rail) return;
    ensureLens();
    var btnBox = btn.getBoundingClientRect();
    var railBox = rail.getBoundingClientRect();
    /* Rail-relative, because the lens is absolutely positioned inside the rail and not in
     * the viewport. The first version of this read railBox.top + btnBox.top - railBox.top,
     * which cancels down to btnBox.top - a viewport coordinate fed to a rail-relative
     * transform, which put the lens one button low for every icon. Subtracting the rail's
     * own offset is the whole of the fix.
     *
     * The centre of the icon, not the gap after it: the lens is wider than a button, so
     * centring it between two icons would magnify the space between them. */
    var y = btnBox.top - railBox.top + btnBox.height / 2;
    lens.style.transform = 'translate3d(0,' + y.toFixed(1) + 'px,0)';
    rail.classList.add('has-lens');

    /* Tag the one icon the lens is over.
     *
     * The magnification used to hang off the rail having a lens at all, which matched
     * every button in the column: thirteen icons grew together and the effect read as
     * "bigger icons" rather than as a magnifier. The lens has to name its own icon, so
     * the class moves with it and the previous holder is cleared - otherwise the icon
     * left behind stays swollen when the lens moves on. */
    var previous = rail.querySelector('.split-rail-btn.is-lensed');
    if (previous && previous !== btn) previous.classList.remove('is-lensed');
    btn.classList.add('is-lensed');
  }

  function hideLens() {
    if (!rail) return;
    rail.classList.remove('has-lens');
    var lensed = rail.querySelector('.split-rail-btn.is-lensed');
    if (lensed) lensed.classList.remove('is-lensed');
    /* Held briefly on the way out, or the lens vanishes the instant the pointer crosses
     * the gap between two icons and the rail flickers. */
    clearTimeout(lensHideTimer);
    lensHideTimer = setTimeout(function () {
      if (rail && !rail.classList.contains('has-lens') && lens) lens.style.opacity = '';
    }, 180);
  }

  /* Where each icon is, measured once and reused.
   *
   * getBoundingClientRect forces a synchronous layout, so calling it in a loop on every
   * pointermove made moving the mouse across the rail recalculate the geometry of the
   * whole document once per pixel. That is the read/write thrash that made the rail feel
   * like it was dragging through syrup, and it was the only thing running on that path.
   *
   * The boxes only change when the rail is re-rendered, scrolled, or resized, so they are
   * measured on those and read from the cache the rest of the time. The cache is dropped
   * rather than trusted across a re-render, because a stale box sends the lens to an icon
   * that has moved and there is no way to tell that apart from it being right. */
  var lensBoxes = null;

  function measureLensBoxes() {
    lensBoxes = [];
    if (!rail) return lensBoxes;
    var buttons = rail.querySelectorAll('.split-rail-btn');
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i].getBoundingClientRect();
      lensBoxes.push({ btn: buttons[i], top: b.top, mid: b.top + b.height / 2, bottom: b.bottom });
    }
    return lensBoxes;
  }

  function invalidateLensBoxes() { lensBoxes = null; }

  function nearestRailButton(clientY) {
    if (!lensBoxes) measureLensBoxes();
    var best = null;
    var bestDist = Infinity;
    for (var i = 0; i < lensBoxes.length; i++) {
      var d = Math.abs(clientY - lensBoxes[i].mid);
      if (d < bestDist) { bestDist = d; best = lensBoxes[i].btn; }
    }
    return best;
  }

  /* Pointer handling, without a frame throttle.
   *
   * A requestAnimationFrame version was tried and removed. Coalescing to one move per
   * frame is correct in principle, but the pending flag is only cleared by the callback
   * firing, and rAF does not fire for an occluded or hidden window. The lens then wedged
   * on whichever icon it had reached and stopped following the pointer for good - worse
   * than doing too much work, because there is no way back.
   *
   * The cost it was avoiding is already gone: the boxes are cached, so a move is now a
   * handful of subtractions against measured values rather than a forced layout per
   * pixel. That was the whole of the jank. */
  function lensFromPointer(e) {
    lensTo(nearestRailButton(e.clientY));
  }


  function attachLens() {
    if (!rail || rail.dataset.lensBound === '1') return;
    rail.dataset.lensBound = '1';
    ensureLens();
    /* Anything that moves an icon invalidates the boxes: the rail scrolling, the window
       resizing, and fonts landing after first paint. */
    rail.addEventListener('scroll', invalidateLensBoxes, { passive: true });
    window.addEventListener('resize', invalidateLensBoxes);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(invalidateLensBoxes);

    rail.addEventListener('pointermove', function (e) {
      if (e.pointerType === 'touch') return;
      lensFromPointer(e);
    });
    rail.addEventListener('pointerleave', hideLens);
    /* Keyboard focus moves the lens too, or tabbing through the rail would light nothing
     * and the magnified icon would stay wherever the mouse last was. */
    rail.addEventListener('focusin', function (e) {
      var btn = e.target.closest && e.target.closest('.split-rail-btn');
      if (btn) lensTo(btn);
    });
    rail.addEventListener('focusout', hideLens);
  }

  function renderRail() {
    if (!rail) return;
    rail.textContent = '';
    /* The lens is a child of the rail, so clearing the rail destroyed it - and because
     * attachLens is bound once, it was never put back. Any re-render left a rail that
     * looked fine and had no magnifier, which is the kind of fault that only shows up
     * after something unrelated has already refreshed the rail. It is taken out before
     * the clear and put back after, rather than re-created, so its transition state
     * survives. */
    if (lens && lens.parentNode === rail) rail.removeChild(lens);
    panels().forEach(function (panel) {

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'split-rail-btn';
      btn.dataset.panel = panel.id;
      btn.title = panel.label;
      /* The floating label reads from this. The title stays as well: it is what a
       * screen reader announces and what shows if the hover label is ever suppressed. */
      btn.dataset.label = panel.label;
      btn.setAttribute('aria-label', panel.label);
      btn.innerHTML = '<span class="material-icons-round">' + railIconMarkup(panel) + '</span>';
      rail.appendChild(btn);
    });
    syncRail();
    if (lens) rail.appendChild(lens);
    invalidateLensBoxes();
  }


  function syncRail() {
    if (!rail) return;
    var open = state.panes;
    Array.prototype.forEach.call(rail.children, function (btn) {
      var id = btn.dataset.panel;
      var idx = open.indexOf(id);
      btn.classList.toggle('is-active', idx === 0);
      btn.classList.toggle('is-open', idx > -1);
      btn.setAttribute('aria-current', idx === 0 ? 'page' : 'false');
    });
  }

  /* ---------------------------------------------------------
     Panes
     --------------------------------------------------------- */
  function renderPanes() {
    if (!panesHost) return;

    /* Everything is resolved before anything is removed. Emptying the host detaches
     * whatever was in it, so a panel looked up afterwards is simply gone, and the pane
     * renders empty. This is the single reason the three-pane layout showed one pane. */
    var wanted = state.panes.slice(0, MAX_PANES);
    var captured = capturePanelElements(wanted);
    var orphans = [];
    Array.prototype.slice.call(panesHost.querySelectorAll('.split-pane-body > *')).forEach(function (el) {
      orphans.push(el);
    });

    panesHost.textContent = '';

    // Anything that was in a pane but no longer is goes back to the workspace, so a
    // closed pane does not take its panel out of the app with it.
    var stillOpen = wanted.slice();
    orphans.forEach(function (el) {
      if (stillOpen.indexOf(el.id) === -1 && el.parentNode === panesHost.parentNode) {
        panesHost.parentNode.appendChild(el);
      }
    });

    if (!wanted.length) {
      panesHost.classList.add('is-empty');
      panesHost.removeAttribute('data-layout');
      return;
    }
    panesHost.classList.remove('is-empty');

    var layout = layoutFor(wanted.length, state.threeLayout);
    panesHost.setAttribute('data-layout', layout);

    /* The arrangement is expressed as nesting, not as one flat flex row.
     *
     * A three-pane layout with one tall pane and two stacked ones cannot be built from
     * a single row of siblings: the two on the right have to be in a column together or
     * the row grows to three and the heights are wrong. So for that one arrangement a
     * column is built, the two right-hand panes and their divider go into it, and the
     * left pane and its divider sit beside it. Every other arrangement is a plain row.
     *
     * The divider is created with the pane it separates rather than appended at the end,
     * which is what put a single divider in the wrong place once there was more than
     * one. */
    function makePane(id, slot) {
      var panel = panelById(id);
      var el = captured[id];
      if (!panel || !el) return null;

      var pane = document.createElement('section');
      pane.className = 'split-pane';
      pane.dataset.panel = id;
      pane.dataset.slot = slot;

      var head = document.createElement('header');
      head.className = 'split-pane-head';
      head.innerHTML =
        '<span class="material-icons-round split-pane-icon">' + panel.icon + '</span>' +
        '<span class="split-pane-title"></span>' +
        '<button class="split-pane-close" type="button" title="Close this pane">' +
        '<span class="material-icons-round">close</span></button>';
      // Filled through textContent rather than baked into the markup above: the label
      // comes from the panel registry and must not be interpolated into HTML.
      head.querySelector('.split-pane-title').textContent = panel.label;

      var body = document.createElement('div');
      body.className = 'split-pane-body';

      pane.appendChild(head);
      pane.appendChild(body);
      body.appendChild(el);
      return pane;
    }

    function makeDivider(axis) {
      var divider = document.createElement('div');
      divider.className = 'split-divider';
      divider.setAttribute('role', 'separator');
      divider.setAttribute('aria-orientation', axis === 'row' ? 'horizontal' : 'vertical');
      divider.dataset.axis = axis;
      divider.title = 'Drag to resize';
      return divider;
    }

    if (layout === 'threeTall') {
      var column = document.createElement('div');
      column.className = 'split-column';
      var left = makePane(wanted[0], 'primary');
      var upper = makePane(wanted[1], 'secondary');
      var lower = makePane(wanted[2], 'tertiary');
      if (left) panesHost.appendChild(left);
      if (left && (upper || lower)) panesHost.appendChild(makeDivider('column'));
      if (upper) column.appendChild(upper);
      if (upper && lower) column.appendChild(makeDivider('row'));
      if (lower) column.appendChild(lower);
      if (column.childNodes.length) panesHost.appendChild(column);
    } else {
      wanted.forEach(function (id, index) {
        var pane = makePane(id, index === 0 ? 'primary' : index === 1 ? 'secondary' : 'tertiary');
        if (!pane) return;
        if (index > 0 && panesHost.lastElementChild) panesHost.appendChild(makeDivider('column'));
        panesHost.appendChild(pane);
      });
    }

    applyRatio();
    return reveal();
  }

  function applyRatio() {
    if (!panesHost) return;
    var count = state.panes.length;
    var layout = layoutFor(count, state.threeLayout);
    panesHost.classList.toggle('is-split', count > 1);
    panesHost.classList.toggle('is-three', count === 3);
    // Column ratio drives the divider between left and right. Row ratio drives the one
    // inside the stacked column. Both are written every time so a divider being
    // dragged and a layout switching can never leave a stale value behind.
    panesHost.style.setProperty('--split-ratio', String(state.ratio));
    panesHost.style.setProperty('--column-ratio', String(layout === 'threeTall' ? state.columnRatio : state.ratio));
    panesHost.style.setProperty('--row-ratio', String(state.rowRatio));
  }

  /* Showing a pane is the same visibility pass the rest of the app uses, so a panel
   * that is already loaded stays loaded and a panel that was never opened still runs
   * its lazy init.
   *
   * renderer.js owns visibility for the primary panel and its showPanel is async, so
   * this must not race it. Toggling `hidden` here before or after the call lost: the
   * pending showPanel resolved afterwards and hid the panel again, which is what left
   * a blank pane on screen. The primary is handed to showPanel and left alone; only
   * the secondary, which renderer.js has no concept of, is forced visible. */
  async function reveal() {
    const primaryId = state.panes[0];
    if (!primaryId) return;

    if (typeof window.showPanel === 'function') {
      try { await window.showPanel(primaryId); } catch (err) { /* the rail retry will follow */ }
    }
    var primaryEl = elFor(panelById(primaryId));
    if (primaryEl) primaryEl.classList.remove('hidden');

    // Everything past the first pane is ours alone.
    for (var i = 1; i < state.panes.length; i++) {
      var el = elFor(panelById(state.panes[i]));
      if (el) el.classList.remove('hidden');
    }

    if (dock() && typeof dock().sync === 'function') dock().sync(primaryId);
  }

  /**
   * Called by renderer.js whenever a panel is shown by any route.
   *
   * This is what stops the two of us disagreeing about which panel is open. The split
   * view used to assume it was in charge, and the first thing renderer.js did on
   * startup was show a panel the split view knew nothing about, leaving a blank pane
   * and a loose panel side by side.
   */
  function follow(id) {
    if (!id || !panelById(id)) return;
    var at = state.panes.indexOf(id);
    if (at === 0) return;                       // already primary
    if (at > 0) {                               // already open: promote it
      var next = state.panes.slice();
      next.splice(at, 1);
      next.unshift(id);
      setPanes(next, true);
      return;
    }
    /* A panel renderer.js opened that the split view did not know about. It becomes
     * primary and joins whatever was already open, up to the cap, rather than
     * replacing it. Replacing meant showing a panel always collapsed the layout back
     * to a single pane, which is what made the split view feel like it kept forgetting
     * itself. */
    setPanes([id].concat(state.panes).slice(0, MAX_PANES), true);
  }

  function setPanes(next, keepRatio) {
    var wanted = Array.isArray(next) ? next : [];
    var kept = [];
    for (var i = 0; i < wanted.length && kept.length < MAX_PANES; i++) {
      var id = wanted[i];
      if (id && panelById(id) && kept.indexOf(id) === -1) kept.push(id);
    }
    state.panes = kept;
    if (!keepRatio) state.ratio = 0.5;
    renderPanes();
    syncRail();
    save();
  }

  /* A plain click on a rail tab switches the primary panel. It does not open a pane.
   *
   * It used to prepend, so with one panel open every click made a second one: click
   * through the rail and the workspace fills with panes, none of them chosen, until it
   * hits the cap of three and starts dropping the ones you had. Adding a panel is a drag
   * onto the workspace, and only a drag. The name says what it does; the body did not.
   *
   * The rest of the panes survive a switch, so losing a third one to open a fourth is not
   * a side effect of replacing the primary - it is the cap doing its job. */
  /* Panels that do something rather than open something.
   *
   * Trade mode flips a flag and has no element, so there is nothing to put in a pane and
   * nothing to show. It is described once on the panel and both rails ask here, because
   * the two rails have separate gesture paths and the dock's copy of this guard was never
   * reached from the split rail - which is how a Trade button that lit up and did nothing
   * existed. */
  function actionPanel(id) {
    var panel = panelById(id);
    return panel && panel.action ? panel.action : null;
  }

  function runActionPanel(name) {
    if (name === 'trade' && typeof window.OrdisTradeModeToggle === 'function') {
      window.OrdisTradeModeToggle();
    }
  }

  function openPrimary(id) {
    /* Trade mode is a switch, not a place, and it has no element to put in a pane.
     * Handled here as well as in the dock's focus(), because the split rail has its own
     * gesture path and never went through that function - so the rail's Trade button lit
     * up and did nothing at all. */
    var action = actionPanel(id);
    if (action) { runActionPanel(action); return; }

    if (state.panes[0] === id) return;
    var at = state.panes.indexOf(id);
    if (at > 0) {
      var next = state.panes.slice();
      next.splice(at, 1);
      next.unshift(id);

      setPanes(next, true);
      return;
    }
    setPanes([id].concat(state.panes.slice(1)), true);

  }

  function splitWith(id) {
    if (!state.panes.length) { setPanes([id]); return; }
    if (state.panes.indexOf(id) > -1) { openPrimary(id); return; }
    /* A fourth panel replaces the oldest rather than reflowing. Three is the cap, and
     * dropping the oldest is the arrangement that needs no new shape. */
    setPanes(state.panes.concat([id]).slice(-MAX_PANES), true);
  }

  /* Toggle between the two three-pane arrangements. Only meaningful with three open,
   * and doing nothing with fewer is deliberate: a player rearranging a two-pane split
   * should not be surprised by the panels moving. */
  function cycleThreeLayout() {
    if (state.panes.length !== MAX_PANES) return false;
    state.threeLayout = state.threeLayout === 'row' ? 'threeTall' : 'row';
    renderPanes();
    save();
    return true;
  }

  function closePane(id) {
    var next = state.panes.filter(function (p) { return p !== id; });
    setPanes(next);
  }

  /* ---------------------------------------------------------
     Rail interaction
     --------------------------------------------------------- */
  function onRailPointerDown(e) {
    var btn = e.target.closest ? e.target.closest('.split-rail-btn') : null;
    if (!btn) return;
    var id = btn.dataset.panel;
    drag = {
      id: id,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      target: null
    };
    btn.setPointerCapture && btn.setPointerCapture(e.pointerId);
    window.addEventListener('pointermove', onRailPointerMove);
    window.addEventListener('pointerup', onRailPointerUp);
    window.addEventListener('pointercancel', onRailPointerUp);
  }

  function onRailPointerMove(e) {
    if (!drag) return;
    var dx = e.clientX - drag.startX;
    var dy = e.clientY - drag.startY;

    if (!drag.active) {
      // A plain click switches panels. Only a real movement becomes a drag, so
      // brushing across the rail never starts rearranging anything.
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      drag.active = true;
      document.body.classList.add('is-split-dragging');
      if (ghost) {
        var panel = panelById(drag.id);
        ghost.innerHTML = '<span class="material-icons-round">' + (panel ? panel.icon : 'apps') + '</span>' +
          '<span>' + (panel ? panel.label : drag.id) + '</span>';
        ghost.style.display = 'flex';
      }
    }

    if (ghost) {
      ghost.style.transform = 'translate(' + (e.clientX - RAIL_WIDTH / 2) + 'px,' + (e.clientY - 18) + 'px)';
    }

    // What is under the cursor decides what a release would do, and the same hit test
    // runs again on release, so the preview cannot disagree with the result.
    drag.target = hitTest(e.clientX, e.clientY);
    highlightTarget(drag.target);
  }

  /* What a release would do, decided by what is under the pointer.
   *
   * Dropping onto a pane puts the dragged panel in that pane's slot, so a player can
   * move a panel between the left, top-right and bottom-right positions by dragging it
   * onto the one it should replace. Previously every drop over the workspace was the
   * same answer, "add it to the end", so a drag could never actually place anything and
   * the ghost suggested otherwise. Dropping on empty workspace still appends. */
  function hitTest(x, y) {
    var under = document.elementFromPoint(x, y);

    if (rail && under && rail.contains(under)) {
      var btn = under.closest ? under.closest('.split-rail-btn') : null;
      if (btn && btn.dataset.panel !== drag.id) return { kind: 'split', id: btn.dataset.panel };
      return null;
    }

    if (workspace && under && workspace.contains(under)) {
      var pane = under.closest ? under.closest('.split-pane') : null;
      if (pane && pane.dataset.panel && pane.dataset.panel !== drag.id) {
        return { kind: 'into', id: pane.dataset.panel, slot: pane.dataset.slot };
      }
      if (pane && pane.dataset.panel === drag.id) return { kind: 'keep' };
      return { kind: 'append' };
    }
    return { kind: 'float' };
  }

  /* The outline showing where the dragged panel will land. */
  var preview = null;

  function showPreview(target) {
    if (!target || (target.kind !== 'into' && target.kind !== 'append')) { hidePreview(); return; }
    if (!workspace) { hidePreview(); return; }

    var box;
    if (target.kind === 'into') {
      var pane = panesHost.querySelector('.split-pane[data-panel="' + cssEscape(target.id) + '"]');
      box = pane ? pane.getBoundingClientRect() : null;
    } else {
      var host = panesHost.getBoundingClientRect();
      box = { left: host.left, top: host.top, width: host.width, height: host.height };
    }
    if (!box) { hidePreview(); return; }

    if (!preview) {
      preview = document.createElement('div');
      preview.className = 'split-drop-preview';
      workspace.appendChild(preview);
    }
    preview.style.left = (box.left - workspace.getBoundingClientRect().left) + 'px';
    preview.style.top = (box.top - workspace.getBoundingClientRect().top) + 'px';
    preview.style.width = box.width + 'px';
    preview.style.height = box.height + 'px';
  }

  function hidePreview() {
    if (preview && preview.parentNode) preview.parentNode.removeChild(preview);
    preview = null;
  }

  /* Attribute values come from the panel registry, so they are escaped rather than
   * dropped into a selector unquoted. */
  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function highlightTarget(target) {
    if (!rail || !workspace) return;
    Array.prototype.forEach.call(rail.children, function (btn) {
      btn.classList.toggle('is-drop', !!target && target.kind === 'split' && btn.dataset.panel === target.id);
    });
    workspace.classList.toggle('is-drop', !!target && (target.kind === 'append' || target.kind === 'into'));
    if (target && target.kind === 'into' && panesHost) {
      var pane = panesHost.querySelector('.split-pane[data-panel="' + cssEscape(target.id) + '"]');
      if (pane) pane.classList.add('is-drop-target');
    }
    Array.prototype.forEach.call(panesHost ? panesHost.querySelectorAll('.split-pane.is-drop-target') : [],
      function (p) { if (!pane || p !== pane) p.classList.remove('is-drop-target'); });
    showPreview(target);
  }

  function onRailPointerUp(e) {
    window.removeEventListener('pointermove', onRailPointerMove);
    window.removeEventListener('pointerup', onRailPointerUp);
    window.removeEventListener('pointercancel', onRailPointerUp);
    if (!drag) return;

    var wasActive = drag.active;
    var target = wasActive ? hitTest(e.clientX, e.clientY) : null;
    var id = drag.id;
    drag = null;

    document.body.classList.remove('is-split-dragging');
    if (ghost) ghost.style.display = 'none';
    highlightTarget(null);
    hidePreview();

    if (!wasActive) { openPrimary(id); return; }
    if (!target) return;
    if (target.kind === 'keep') return;                 // dropped on itself
    if (target.kind === 'split') { splitWith(target.id); return; }
    if (target.kind === 'into') { moveToSlot(id, target.id); return; }
    if (target.kind === 'append') { splitWith(id); return; }
    if (dock() && typeof dock().tearOffPanel === 'function') dock().tearOffPanel(id, e.clientX, e.clientY);
  }

  /* Put `id` in the slot currently held by `onto`, shifting what was there. The panel
   * being dropped on is not lost, it moves: dropping Rivens onto the pane holding
   * Resources makes Resources the second pane, not no pane. */
  function moveToSlot(id, onto) {
    var next = state.panes.filter(function (p) { return p !== id; });
    var at = next.indexOf(onto);
    if (at === -1) { setPanes(next.concat([id]), true); return; }
    next.splice(at, 0, id);
    setPanes(next, true);
  }

  /* ---------------------------------------------------------
     Divider
     --------------------------------------------------------- */
  function onDividerPointerDown(e) {
    var divider = e.target.closest ? e.target.closest('.split-divider') : null;
    if (!divider || !workspace) return;
    e.preventDefault();
    /* Which ratio this divider owns, and along which axis, is decided from the
     * arrangement rather than guessed. A divider inside the stacked column splits top
     * from bottom, so dragging it sideways must do nothing, and dragging the left-hand
     * one up and down must do nothing either. Before this there was one ratio and every
     * divider moved it, so in a three-pane layout two dividers fought over the same
     * number and the layout juddered. */
    var axis = divider.dataset.axis === 'row' ? 'row' : 'column';
    var key = axis === 'row' ? 'rowRatio' : (state.panes.length === MAX_PANES ? 'columnRatio' : 'ratio');
    dividerDrag = {
      axis: axis,
      key: key,
      startX: e.clientX,
      startY: e.clientY,
      startRatio: state[key]
    };
    document.body.classList.add('is-divider-dragging');
    if (axis === 'row') document.body.classList.add('is-row-divider');
    divider.setPointerCapture && divider.setPointerCapture(e.pointerId);
    window.addEventListener('pointermove', onDividerPointerMove);
    window.addEventListener('pointerup', onDividerPointerUp);
    window.addEventListener('pointercancel', onDividerPointerUp);
  }

  function onDividerPointerMove(e) {
    if (!dividerDrag || !workspace) return;
    var rect = workspace.getBoundingClientRect();
    // The rail eats into the workspace, so a horizontal ratio is measured against the
    // panes area rather than the window, otherwise the divider drifts as it is dragged.
    var usableW = rect.width - RAIL_WIDTH;
    var next;

    if (dividerDrag.axis === 'row') {
      /* Measured inside the stacked column, not the workspace, or the top pane would
       * grow with the window instead of with the space it actually has. */
      var column = panesHost ? panesHost.querySelector('.split-column') : null;
      var box = column ? column.getBoundingClientRect() : rect;
      if (box.height <= 0) return;
      next = (e.clientY - box.top) / box.height;
    } else {
      if (usableW <= 0) return;
      next = (e.clientX - rect.left - RAIL_WIDTH) / usableW;
    }

    var clamped = Math.min(0.85, Math.max(0.15, next));
    if (clamped === state[dividerDrag.key]) return;
    state[dividerDrag.key] = clamped;
    applyRatio();
  }

  function onDividerPointerUp() {
    window.removeEventListener('pointermove', onDividerPointerMove);
    window.removeEventListener('pointerup', onDividerPointerUp);
    window.removeEventListener('pointercancel', onDividerPointerUp);
    document.body.classList.remove('is-divider-dragging', 'is-row-divider');
    if (dividerDrag) save();
    dividerDrag = null;
    if (!dividerDrag) return;
    dividerDrag = null;
    document.body.classList.remove('is-resizing-split');
    save();
  }

  function onPanesClick(e) {
    var close = e.target.closest ? e.target.closest('.split-pane-close') : null;
    if (close) {
      var pane = close.closest('.split-pane');
      if (pane) closePane(pane.dataset.panel);
      return;
    }
    // Clicking a pane's header brings it to the front of the pair, which is what makes
    // a two-pane layout feel like two tabs rather than one fixed arrangement.
    var head = e.target.closest ? e.target.closest('.split-pane-head') : null;
    if (head) {
      var p = head.closest('.split-pane');
      if (p && state.panes.length > 1 && state.panes[0] === p.dataset.panel) {
        setPanes([state.panes[1], state.panes[0]], true);
      }
    }
  }

  /* ---------------------------------------------------------
     Wiring
     --------------------------------------------------------- */
  function init() {
    if (!build()) return;
    load();

    rail.addEventListener('pointerdown', onRailPointerDown);
    panesHost.addEventListener('click', onPanesClick);
    panesHost.addEventListener('pointerdown', onDividerPointerDown);

    // The strip is what the rail replaces. Hiding it by class rather than by removing
    // it keeps the dock's own drag and tear-off code alive for the cases that still
    // reach it, and keeps its saved layout intact.
    document.body.classList.add('has-split-rail');

    if (!state.panes.length) {
      var active = document.querySelector('.split-rail-btn.is-active');
      state.panes = [active ? active.dataset.panel : (panels()[0] || {}).id].filter(Boolean);
    }
    Promise.resolve(renderPanes());
    syncRail();
    save();
  }

    window.OrdisSplit = {
      follow: follow,
      refresh: function () { renderRail(); },
      panes: function () { return state.panes.slice(); },
      /* Exposed so the arrangement can be switched without a drag: with three panes open
       * this is the only way to move between the one-left-two-right layout and the
       * three-in-a-row one. */
      cycleLayout: cycleThreeLayout,
      layout: function () { return layoutFor(state.panes.length, state.threeLayout); },
      open: splitWith,
      primary: openPrimary,
      close: closePane
    };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
