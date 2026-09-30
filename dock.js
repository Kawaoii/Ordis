/* ==========================================================
   ORDIS DOCK - iOS-style snap docking for app panels
   ==========================================================
   Interaction model, taken from the iOS home screen:

     1. PRESS AND HOLD a panel tab. It lifts after ~380ms with a scale-up and a
        shadow - that is the "pick up" cue, so a plain click still just switches
        panels and an accidental brush across the strip never starts a drag.
     2. DRAG. The panel follows the cursor. While it is over the dock strip the
        other tabs reflow live (FLIP) and a drop marker snaps between them, so the
        layout you are aiming at is the layout you get.
     3. DRAG AWAY from the strip and the panel tears off into a floating glass
        window that keeps following the cursor.
     4. FLOATING PANELS snap to a grid field while dragging and while resizing,
        so windows line up instead of drifting into an untidy pile.

   WHY A SEPARATE MODULE
   ---------------------
   renderer.js owns panel visibility and lazy loading, and it treats #content as
   the "checklist" panel itself (getPanelRefs maps checklist -> #content). That
   means the panels are children of the content container, and anything docked
   into that container would be hidden whenever a different panel is shown.
   So the dock lives in its own layer above #content, and only ever moves panel
   elements in and out of that layer. renderer.js keeps doing what it already
   does correctly.

   PERFORMANCE
   -----------
   Torn-off panels are the only extra live surfaces, and they are few. Cards
   still never get a backdrop-filter (120+ of those stalled the renderer), and
   the drag uses transform only, so the pointer path stays on the compositor.
*/
(function () {
  'use strict';

  /* ---------------------------------------------------------
     Registry
     ---------------------------------------------------------
     `id` matches the keys getPanelRefs() returns, so focusing a tab can hand off
     to the existing showPanel() instead of reimplementing panel switching. */
  /* Icons are chosen to name the category, not to decorate the row.
   *
   * A rail is a set of icons the player reads rather than reads, so each one has to look
   * like the thing it opens. Material ligatures are the wrong tool for the rest: there is
   * no glyph for an Argon Crystal or a Void Trace, and reaching for a near-miss instead
   * ("a riven is a mod", said a comment that used to sit right here) gives two tabs the
   * same picture and hides which one the player is in. The items the game itself gives a
   * face to - a Void Trace, an Argon Crystal, a riven - use its art, the same way the
   * Archgun and Amp categories already do. */
  var PANELS = [
    { id: 'checklist', label: 'Equipment', icon: 'sports_martial_arts', el: '#content', nav: null, minW: 520, minH: 320 },
    /* Mods is a view of the item grid, not a second copy of it.
     *
     * The dock floats a panel by moving its element into a window, so two tabs pointing
     * at #content would both claim the same node and one of them would take it away from
     * the other. A view instead names the category and hands the grid to it, which is
     * what the old row in the equipment rail did anyway - the same grid, one category
     * over. `view` is also why it is not torn off: there is only one grid, so there is
     * nothing separate to put in a window. */
    { id: 'mods', label: 'Mods', icon: 'extension', el: '#content', nav: null, minW: 520, minH: 320, view: { category: 'Mods' } },
    { id: 'market', label: 'Market', icon: 'storefront', el: '#market-panel', nav: '#nav-market', minW: 480, minH: 300 },
    { id: 'analytics', label: 'Analytics', icon: 'insights', el: '#trade-analytics-panel', nav: '#nav-trade-analytics', minW: 460, minH: 300 },
    { id: 'prime', label: 'Prime Resurgence', icon: 'workspace_premium', el: '#prime-panel', nav: '#nav-prime-resurgence', minW: 440, minH: 280 },
    // The relic the player is actually holding, not a decorative box.
    { id: 'relics', label: 'Relics', icon: 'assets/void-trace.png', fallbackIcon: 'filter_vintage', el: '#relics-panel', nav: '#nav-relics', minW: 440, minH: 300 },
    { id: 'arcanes', label: 'Arcanes', icon: 'auto_awesome', el: '#arcanes-panel', nav: '#nav-arcanes', minW: 440, minH: 300 },
    // The riven rune itself. The "extension" mod glyph is what this used to be, which is
    // why Rivens and Mods looked like the same tab.
    { id: 'rivens', label: 'Rivens', icon: 'assets/riven-rune.png', fallbackIcon: 'extension', el: '#riven-panel', nav: null, minW: 460, minH: 340 },
    { id: 'cycles', label: 'Cycles', icon: 'cyclone', el: '#cycles-panel', nav: '#nav-cycles', minW: 420, minH: 300 },
    { id: 'compare', label: 'Compare', icon: 'compare_arrows', el: '#compare-panel', nav: '#nav-compare', minW: 480, minH: 320 },
    { id: 'recommendations', label: 'Recommendations', icon: 'lightbulb', el: '#recommendations-panel', nav: '#nav-mastery-recommendations', minW: 460, minH: 320 },
    // Argon Crystal, the resource every relic run is chasing.
    { id: 'resources', label: 'Resources', icon: 'assets/argon-crystal.png', fallbackIcon: 'hardware', el: '#resource-search-panel', nav: '#nav-resource-search', minW: 420, minH: 300 },
    { id: 'settings', label: 'Settings', icon: 'settings', el: '#settings-page', nav: null, minW: 480, minH: 320 }
  ];


  /* Snap field. Panels align to these fractions of the workspace, which is what
     makes two windows line up without any manual nudging. */
  var COLS = 12;
  var ROWS = 8;
  var SNAP_TOLERANCE = 0.045; // ~4.5% of the workspace, generous enough to feel magnetic
  var DRAG_THRESHOLD = 5; // px before a press can become a drag
  var TEAR_OFF_MARGIN = 90; // px below the strip before a drag counts as a tear-off
  var STORE_KEY = 'ordis.dock.v1';
  var CAT_STORE_KEY = 'ordis.dock.categories.v1';

  var byId = {};
  PANELS.forEach(function (p) { byId[p.id] = p; });

  var state = {
    order: PANELS.map(function (p) { return p.id; }),
    floats: {},   // id -> {x, y, w, h, z}
    active: 'checklist'
  };

  var dom = {};
  var drag = null;
  /* Float z-range starts at 1000 and is capped below the strip's 5000, so a window
     can never cover the dock strip. See the note in ordis-design.css.
     Once the cap is hit, the oldest window simply stops coming forward, which is
     preferable to blocking the only way to dock a panel back. */
  var zTop = 1000;
  var Z_MAX = 4800;

  /* ---------------------------------------------------------
     Persistence
     ---------------------------------------------------------
     Layout is a user preference, so it is restored on launch. Anything unknown is
     discarded rather than trusted: a stale id pointing at a renamed panel would
     otherwise silently blank the strip. */
  function load() {
    var raw;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { return; }
    if (!raw) return;
    var saved;
    try { saved = JSON.parse(raw); } catch (e) { return; }
    if (!saved) return;

    if (Array.isArray(saved.order)) {
      var valid = saved.order.filter(function (id) { return !!byId[id]; });
      PANELS.forEach(function (p) { if (valid.indexOf(p.id) === -1) valid.push(p.id); });
      state.order = valid;
    }
    if (saved.floats && typeof saved.floats === 'object') {
      Object.keys(saved.floats).forEach(function (id) {
        var f = saved.floats[id];
        if (!byId[id] || !f) return;
        var n = Number(f.x), w = Number(f.w), h = Number(f.h);
        if (!isFinite(n) || !isFinite(w) || !isFinite(h)) return;
        state.floats[id] = { x: n, y: Number(f.y) || 0, w: w, h: h, z: Number(f.z) || ++zTop };
        if (state.floats[id].z > zTop) zTop = state.floats[id].z;
      });
    }
    if (saved.active && byId[saved.active]) state.active = saved.active;
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* private mode */ }
  }

  /* ---------------------------------------------------------
     Geometry
     --------------------------------------------------------- */
  function workspace() {
    var r = dom.layer.getBoundingClientRect();
    return { w: r.width, h: r.height, left: r.left, top: r.top };
  }

  function snap(value, total, steps) {
    var step = total / steps;
    var snapped = Math.round(value / step) * step;
    return Math.abs(snapped - value) <= step * SNAP_TOLERANCE ? snapped : value;
  }

  function snapPoint(x, y) {
    var ws = workspace();
    return {
      x: Math.min(Math.max(snap(x, ws.w, COLS), 0), ws.w),
      y: Math.min(Math.max(snap(y, ws.h, ROWS), 0), ws.h)
    };
  }

  function snapSize(w, h) {
    var ws = workspace();
    return {
      w: Math.min(Math.max(snap(w, ws.w, COLS), 0), ws.w),
      h: Math.min(Math.max(snap(h, ws.h, ROWS), 0), ws.h)
    };
  }

  /* ---------------------------------------------------------
     Snap zones + preview
     ---------------------------------------------------------
     The complaint this fixes: all four edges used the same 46px trigger, so near
     a corner the app could not tell whether you wanted left, right, top or
     bottom, and it silently guessed. Two changes:

       1. The zone you are aiming at is now decided by where the CURSOR is, not
          by how close the window's edge happens to be. Cursor left-of-centre
          picks left, above picks top, and so on. That is how Windows decides,
          and it removes the guess entirely.
       2. A preview rectangle shows the exact region the window will take, so
          the outcome is visible before you let go rather than discovered after.

     Edge zones are also widened at the sides of the screen and narrowed at the
     top, because the dock strip already occupies the bottom. */
  function snapZoneFor(pointerX, pointerY) {
    var ws = workspace();
    var EDGE = 90;          // how close to an edge counts as "aiming at it"
    var TOP = 110;          // taller zone at the top: the title bar lives there
    var BOTTOM = 70;        // shorter at the bottom, the dock strip is in the way
    var midX = ws.left + ws.w / 2;
    var midY = ws.top + ws.h / 2;

    var zone = null;
    if (pointerY - ws.top <= TOP) zone = 'top';
    else if ((ws.top + ws.h) - pointerY <= BOTTOM) zone = 'bottom';
    else if (pointerX - ws.left <= EDGE) zone = 'left';
    else if (ws.left + ws.w - pointerX <= EDGE) zone = 'right';

    // Near a corner the vertical choice wins, because a top/bottom tile spans the
    // full width and is the more deliberate gesture of the two.
    return zone;
  }

  function zoneRect(zone) {
    var ws = workspace();
    var usableH = Math.max(200, stripTopLimit());
    var halfW = Math.round(ws.w / 2);
    var halfH = Math.round(usableH / 2);
    if (zone === 'left') return { x: 0, y: 0, w: halfW, h: usableH };
    if (zone === 'right') return { x: ws.w - halfW, y: 0, w: halfW, h: usableH };
    if (zone === 'top') return { x: 0, y: 0, w: ws.w, h: halfH };
    if (zone === 'bottom') return { x: 0, y: usableH - halfH, w: ws.w, h: halfH };
    return null;
  }

  function showSnapPreview(zone) {
    if (!dom.preview) return;
    var r = zoneRect(zone);
    if (!r) { dom.preview.classList.remove('is-visible'); return; }
    var ws = workspace();
    dom.preview.style.left = (ws.left + r.x) + 'px';
    dom.preview.style.top = (ws.top + r.y) + 'px';
    dom.preview.style.width = r.w + 'px';
    dom.preview.style.height = r.h + 'px';
    dom.preview.classList.add('is-visible');
  }

  function hideSnapPreview() {
    if (dom.preview) dom.preview.classList.remove('is-visible');
  }

  /* ---------------------------------------------------------
     Edge snapping - windows snap to each other
     ---------------------------------------------------------
     Snapping to a fixed grid alone leaves a pile of windows that never line up
     with each other, which is the part that looks untidy. This collects the
     candidate edges from every other open window plus the workspace bounds, and
     pulls the dragged/resized window onto the nearest one.

     Each candidate contributes a set of lines on both axes:
       - left/top edges, so window A's left can meet window B's left
       - right/bottom edges, so A's right can meet B's right
       - a mid-line for each axis, so a window can sit centred against another
     Workspace edges and the two halves/quarters are included, so dragging to an
     edge offers a predictable tile rather than a free-floating position.
  */
  var EDGE_TOLERANCE = 14; // px - generous enough to feel magnetic

  function collectSnapLines(excludeId) {
    var ws = workspace();
    var xs = [0, Math.round(ws.w / 2), ws.w];
    var ys = [0, Math.round(ws.h / 2), ws.h];

    Object.keys(state.floats).forEach(function (id) {
      if (id === excludeId) return;
      var f = state.floats[id];
      if (!f) return;
      xs.push(f.x, f.x + f.w, f.x + Math.round(f.w / 2));
      ys.push(f.y, f.y + f.h, f.y + Math.round(f.h / 2));
    });

    return {
      // left, right and centre for x; top, bottom and centre for y
      x: { start: xs.slice(), end: xs.slice(), mid: xs.slice() },
      y: { start: ys.slice(), end: ys.slice(), mid: ys.slice() },
      ws: ws
    };
  }

  function nearestLine(value, lines) {
    var best = null, bestDist = EDGE_TOLERANCE;
    for (var i = 0; i < lines.length; i++) {
      var d = Math.abs(lines[i] - value);
      if (d <= bestDist) { bestDist = d; best = lines[i]; }
    }
    return best;
  }

  /* Nudges a rect so one of its edges lands on a neighbouring window's edge.
     `w`/`h` are respected for the end/centre lines, so a window snapped to
     another's left edge also gets its right edge considered. */
  function snapRectToNeighbours(rect, excludeId) {
    var L = collectSnapLines(excludeId);
    var out = { x: rect.x, y: rect.y, w: rect.w, h: rect.h, snappedX: false, snappedY: false };

    // X: try left edge, then right edge, then centre.
    var hit = nearestLine(rect.x, L.x.start);
    if (hit === null) {
      hit = nearestLine(rect.x + rect.w, L.x.end);
      if (hit !== null) out.x = hit - rect.w;
    }
    if (hit === null) {
      var mid = rect.x + Math.round(rect.w / 2);
      hit = nearestLine(mid, L.x.mid);
      if (hit !== null) out.x = hit - Math.round(rect.w / 2);
    }
    if (hit !== null) out.snappedX = true;

    // Y: same treatment.
    hit = nearestLine(rect.y, L.y.start);
    if (hit === null) {
      hit = nearestLine(rect.y + rect.h, L.y.end);
      if (hit !== null) out.y = hit - rect.h;
    }
    if (hit === null) {
      var midY = rect.y + Math.round(rect.h / 2);
      hit = nearestLine(midY, L.y.mid);
      if (hit !== null) out.y = hit - Math.round(rect.h / 2);
    }
    if (hit !== null) out.snappedY = true;

    return out;
  }

  /* Full snap for a window being dragged.
     Order of preference, strongest signal first:
       1. Edge tiling - dragged against a workspace edge, the window becomes that
          half. This is what makes two windows sit side by side: you do not have
          to size the first one by hand, you just push the second one against an
          edge and it fills its side.
       2. Neighbour edges - line up flush with another open window.
       3. The fixed grid.
     Finally a clamp, so a window can never leave the workspace. */
  function snapFloatPosition(x, y, w, h, excludeId, zone) {
    var ws = workspace();

    // 1. Edge tiling, chosen by the zone the cursor is aiming at.
    if (zone) {
      var r = zoneRect(zone);
      if (r) return clampRect(r.x, r.y, r.w, r.h);
    }

    // 2. Neighbour edges, then the fixed grid.
    var p = snapPoint(x, y);
    var snapped = snapRectToNeighbours({ x: p.x, y: p.y, w: w, h: h }, excludeId);
    return clampRect(
      snapped.snappedX ? snapped.x : p.x,
      snapped.snappedY ? snapped.y : p.y,
      w, h
    );
  }

  /* Keeps a window reachable.
     A missed drop used to be unrecoverable: the title bar is the only grab area,
     so a window pushed past an edge or left underneath the dock strip could not
     be picked up again at all - the panel was gone until the app restarted.

     Two rules prevent that:
       1. The whole grab area (the title bar) must stay inside the visible
          workspace, so it can always be clicked.
       2. The window is kept clear of the dock strip, because the strip is
          pointer-active and would otherwise swallow the drag.
     Nothing is ever allowed to go off-screen. */
  var TITLEBAR_H = 38;
  var STRIP_CLEARANCE = 56;

  function stripTopLimit() {
    var ws = workspace();
    if (!dom.strip) return ws.h;
    var r = dom.strip.getBoundingClientRect();
    if (r.height === 0) return ws.h; // strip is hidden (everything torn off)
    return (r.top - ws.top) - STRIP_CLEARANCE;
  }

  function clampRect(x, y, w, h) {
    var ws = workspace();
    var maxX = Math.max(0, ws.w - TITLEBAR_H);
    var bottomLimit = stripTopLimit();
    var maxY = Math.max(0, bottomLimit - TITLEBAR_H);
    return {
      x: Math.min(Math.max(x, 0), maxX),
      y: Math.min(Math.max(y, 0), maxY),
      // Never let a window exceed the workspace, or it cannot be fully recovered.
      w: Math.min(w, ws.w),
      h: Math.min(h, ws.h)
    };
  }

  /* ---------------------------------------------------------
     Build
     --------------------------------------------------------- */
  function build() {
    var app = document.querySelector('.app-container');
    if (!app) return false;

    var layer = document.createElement('div');
    layer.className = 'dock-layer';

    var strip = document.createElement('div');
    strip.className = 'dock-strip glass';
    strip.setAttribute('role', 'tablist');
    strip.setAttribute('aria-label', 'Panel dock - press and hold to rearrange');

    var marker = document.createElement('div');
    marker.className = 'dock-drop-marker';

    var floatLayer = document.createElement('div');
    floatLayer.className = 'dock-float-layer';

    var preview = document.createElement('div');


    preview.className = 'dock-snap-preview';



    var guides = document.createElement('div');
    guides.className = 'dock-guides';

    var hint = document.createElement('div');
    hint.className = 'dock-empty-hint';
    hint.innerHTML =
      '<div class="dock-empty-card glass">' +
      '<span class="material-icons-round dock-empty-icon">picture_in_picture_alt</span>' +
      '<p class="dock-empty-title"><span id="dock-empty-label">This panel</span> is open in its own window.</p>' +
      '<button class="dock-empty-btn" type="button" data-act="dock-active">Dock it back to the strip</button>' +
      '</div>';

    layer.appendChild(strip);
    layer.appendChild(marker);
    layer.appendChild(guides);
    layer.appendChild(preview);
    layer.appendChild(hint);
    layer.appendChild(floatLayer);
    app.appendChild(layer);

    dom = {
      layer: layer, strip: strip, marker: marker, floatLayer: floatLayer,
      guides: guides, preview: preview, tabs: {}, hint: hint, hintLabel: hint.querySelector('#dock-empty-label')
    };
    return true;
  }

  /* A tab's tooltip. Split out because two places need it: buildTab on first render, and
     setTabMeta when a count arrives later. Building the string twice is how the two
     drifted, with the count quietly vanishing from the hover after a redraw. */
  function tabTitle(panel) {
    return panel.label + ' - press and hold to rearrange' +
      (panel.note ? ' (' + panel.note + ')' : '');
  }

  function buildTab(panel) {
    var tab = document.createElement('button');
    tab.className = 'dock-tab glass';
    tab.type = 'button';
    tab.dataset.panel = panel.id;
    tab.setAttribute('role', 'tab');
    tab.title = tabTitle(panel);


    var icon;
    /* An icon is either a font ligature or a picture of the thing.
     *
     * The rail used to assume a ligature and put the panel name straight into the text
     * node, which fails quietly: a missing ligature renders as its own name as text, so
     * the tab ends up captioned "assets/argon-crystal.png" instead of drawing a crystal.
     * A path is checked for a file extension instead, which is the only way to tell the
     * two apart from the single string the panel list carries. */
    if (/\.(png|webp|svg|jpe?g)$/i.test(panel.icon)) {
      icon = document.createElement('img');
      icon.className = 'dock-tab-icon dock-tab-art';
      icon.src = panel.icon;
      icon.alt = '';
      icon.setAttribute('aria-hidden', 'true');
      /* The art is dropped in as a file, so it can be missing on any given checkout
       * without the tab going blank. A failed load swaps in the glyph it replaced rather
       * than leaving a hole in the rail, which is the whole reason the art is optional. */
      icon.addEventListener('error', function () {
        var glyph = document.createElement('span');
        glyph.className = 'material-icons-round dock-tab-icon';
        glyph.textContent = panel.fallbackIcon || 'category';
        if (icon.parentNode) icon.parentNode.replaceChild(glyph, icon);
      });
    } else {
      icon = document.createElement('span');
      icon.className = 'material-icons-round dock-tab-icon';
      icon.textContent = panel.icon;
    }


    var label = document.createElement('span');
    label.className = 'dock-tab-label';
    label.textContent = panel.label;

    tab.appendChild(icon);
    tab.appendChild(label);
    return tab;
  }

  function renderStrip() {
    dom.strip.textContent = '';
    dom.tabs = {};
    state.order.forEach(function (id) {
      var panel = byId[id];
      if (!panel || state.floats[id]) return; // torn-off panels live in the float layer
      var tab = buildTab(panel);
      dom.tabs[id] = tab;
      dom.strip.appendChild(tab);
    });
    syncActive();
  }

  /* Reorders the EXISTING tab nodes instead of rebuilding them. Rebuilding would
     throw away the element references the FLIP pass needs to measure, so the
     tabs would teleport instead of sliding. */
  function syncStripOrder() {
    state.order.forEach(function (id) {
      var tab = dom.tabs[id];
      if (tab) dom.strip.appendChild(tab); // appendChild moves, it does not clone
    });
    syncActive();
  }

  function syncActive() {
    PANELS.forEach(function (p) {
      var tab = dom.tabs[p.id];
      if (!tab) return;
      var on = p.id === state.active;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    syncStripVisibility();
  }

  /* The strip disappears when every panel is torn off.
     An empty pill of icons with nothing in it is just clutter over the workspace,
     and leaving it visible is actively misleading - it suggests there is
     somewhere to drop a window back when there is not. It comes back the moment
     a panel is docked. */
  function syncStripVisibility() {
    if (!dom.strip) return;
    var docked = PANELS.filter(function (p) { return !state.floats[p.id]; });
    dom.strip.classList.toggle('is-empty', docked.length === 0);
    dom.strip.setAttribute('aria-hidden', docked.length === 0 ? 'true' : 'false');
  }

  /* ---------------------------------------------------------
     Focus
     ---------------------------------------------------------
     Hands off to renderer.js so lazy loading, animations and nav highlighting all
     keep working. The dock only ever decides *which* panel, never how it shows. */
  /* The content area goes completely empty once every panel is torn off, which
     left a large dead region with no explanation. This is a placeholder that
     says where the panel went and offers to put it back, shown only while the
     active panel is a floating window. */
  function syncEmptyState() {
    if (!dom.hint) return;
    var active = state.active;
    var isFloating = !!state.floats[active];
    dom.hint.classList.toggle('is-visible', isFloating);
    if (isFloating) {
      var panel = byId[active];
      var label = dom.hintLabel;
      if (label && panel) label.textContent = panel.label;
    }
  }

  /* Panels living in a floating window must never be hidden.
     applyPanelVisibility() hides every panel except the one being shown, which
     is correct for docked panels but wrong for floats: opening a second window
     hid the first one, leaving an empty frame with 200 loaded cards behind it.

     renderer.js only ever knows about #content, so the floats are re-revealed
     from here after any panel switch. */
  function revealFloatingPanels() {
    Object.keys(state.floats).forEach(function (id) {
      var el = document.querySelector(byId[id] ? byId[id].el : '#' + id);
      if (el) el.classList.remove('hidden');
    });
  }

  function focus(id) {
    if (!byId[id]) return;
    state.active = id;
    save();
    syncActive();
    syncEmptyState();
    if (typeof window.showPanel === 'function') {
      try {
        // showPanel is async and applies its visibility pass *after* an await,
        // so revealing here synchronously ran before the hide and lost. The
        // floats are re-revealed once the switch has actually completed.
        var result = window.showPanel(id, true);
        if (result && typeof result.then === 'function') {
          result.then(revealFloatingPanels, revealFloatingPanels);
        } else {
          revealFloatingPanels();
        }
      } catch (e) { /* panel not mounted yet */ }
    }
  }

  /* ---------------------------------------------------------
     FLIP reflow
     ---------------------------------------------------------
     When the drop index changes, tabs must slide rather than jump. FLIP records
     the old rects, the DOM reorder happens, then each tab is inverted and played
     back with a transition. */
  function reflow(mutate) {
    var tabs = Array.prototype.slice.call(dom.strip.children);
    var before = {};
    tabs.forEach(function (t) { before[t.dataset.panel] = t.getBoundingClientRect(); });

    mutate();

    tabs.forEach(function (t) {
      if (!t.isConnected) return;
      var after = t.getBoundingClientRect();
      var prev = before[t.dataset.panel];
      if (!prev) return;
      var dx = prev.left - after.left;
      var dy = prev.top - after.top;
      if (!dx && !dy) return;
      t.style.transition = 'none';
      t.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      /* Force a reflow so the browser registers the inverted position before the
         transition is re-enabled, otherwise the tab teleports. */
      void t.offsetWidth;
      t.style.transition = '';
      t.style.transform = '';
    });
  }

  function dropIndexFor(clientX) {
    var kids = Array.prototype.slice.call(dom.strip.children).filter(function (t) { return t !== drag.ghost; });
    for (var i = 0; i < kids.length; i++) {
      var r = kids[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return kids.length;
  }

  /* ---------------------------------------------------------
     Drag
     --------------------------------------------------------- */
  function onPointerDown(e) {
    if (e.button !== 0) return;
    var tab = e.target.closest ? e.target.closest('.dock-tab') : null;
    if (!tab || !dom.strip.contains(tab)) return;
    if (drag) return;

    var panel = byId[tab.dataset.panel];
    if (!panel) return;

    drag = {
      id: panel.id,
      tab: tab,
      panel: panel,
      startX: e.clientX,
      startY: e.clientY,
      originX: e.clientX,
      originY: e.clientY,
      armed: false,
      lifted: false,
      floating: false,
      index: null
    };

    /* No long-press timer. Browsers (Brave, Chrome) start dragging a tab the
       moment it moves, and this is what the dock was asked to feel like. The
       earlier 380ms hold was iOS behaviour and it read as "nothing happens" to
       anyone dragging deliberately - and a tab could be moved but not torn off
       unless the pointer lingered. */
    tab.setPointerCapture(e.pointerId);
  }

  function lift(x, y) {
    if (!drag || drag.armed) return;
    drag.armed = true;
    drag.lifted = true;
    drag.ghost = drag.tab;
    var r = drag.tab.getBoundingClientRect();
    drag.offsetX = drag.originX - r.left;
    drag.offsetY = drag.originY - r.top;
    dom.ghost = drag.ghost;

    drag.ghost.classList.add('is-lifted');
    document.body.classList.add('is-docking');
    moveGhost(x, y);
  }

  function moveGhost(x, y) {
    if (!drag || !drag.ghost) return;
    var r = drag.ghost.getBoundingClientRect();
    drag.ghost.style.transform =
      'translate(' + (x - drag.offsetX - r.left) + 'px,' + (y - drag.offsetY - r.top) + 'px) scale(1.06)';
    drag.ghost.style.left = x - drag.offsetX + 'px';
    drag.ghost.style.top = y - drag.offsetY + 'px';
  }

  function onPointerMove(e) {
    if (!drag) return;

    if (!drag.armed) {
      if (Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY) < DRAG_THRESHOLD) return;
      // Browser behaviour: crossing the threshold lifts the tab straight away.
      lift(e.clientX, e.clientY);
    }

    moveGhost(e.clientX, e.clientY);

    var stripRect = dom.strip.getBoundingClientRect();
    var overStrip = e.clientY >= stripRect.top - 8 && e.clientY <= stripRect.bottom + 8;

    // Dragging clear of the strip band tears the panel off. The strip is docked
    // to the bottom, so "away from it" means upward into the content area.
    if (!drag.floating && !overStrip) {
      tearOff(e.clientX, e.clientY);
      return;
    }

    if (drag.floating) {
      positionFloat(e.clientX, e.clientY);
      return;
    }

    var idx = dropIndexFor(e.clientX);
    if (idx === drag.index) return;
    drag.index = idx;
    showMarker(idx);
  }

  function showMarker(index) {
    var kids = Array.prototype.slice.call(dom.strip.children).filter(function (t) { return t !== drag.ghost; });
    var stripRect = dom.strip.getBoundingClientRect();
    var left;
    if (!kids.length) left = 0;
    else if (index >= kids.length) left = kids[kids.length - 1].getBoundingClientRect().right - stripRect.left;
    else left = kids[index].getBoundingClientRect().left - stripRect.left;
    dom.marker.style.transform = 'translateX(' + left + 'px)';
    dom.marker.classList.add('is-visible');
  }

  function onPointerUp(e) {
    if (!drag) return;
    var wasFloating = drag.floating;
    var id = drag.id;
    var index = drag.index;
    var ghost = drag.ghost;
    document.body.classList.remove('is-docking');
    dom.marker.classList.remove('is-visible');
    dom.guides.classList.remove('is-visible');

    if (drag.floatEl) {
      commitFloat(id, e.clientX, e.clientY);
    } else if (ghost) {
      ghost.classList.remove('is-lifted');
      ghost.style.transform = '';
      ghost.style.left = '';
      ghost.style.top = '';
      commitReorder(id, index);
    }

    drag = null;
    dom.ghost = null;
    if (wasFloating) renderStrip();
  }

  function cancelPress() {
    if (!drag) return;
    drag = null;
  }

  function commitReorder(id, index) {
    if (index === null || index === undefined) return;
    var current = state.order.indexOf(id);
    if (current === -1) return;

    // The marker index is counted over the strip's children excluding the lifted
    // tab, so a target to the right of the origin is one slot further along once
    // the dragged tab is put back.
    var target = index > current ? index - 1 : index;
    if (target === current) return;

    reflow(function () {
      state.order.splice(current, 1);
      state.order.splice(target, 0, id);
      save();
      syncStripOrder();
    });
  }

  /* ---------------------------------------------------------
     Tear-off + floating windows
     --------------------------------------------------------- */
  function tearOff(x, y) {
    if (drag.floating) return;
    var panel = drag.panel;
    /* A view has no element of its own to put in a window. Tearing off Mods would move
     * the item grid that Equipment is also using, so the grid would follow the new
     * window and leave the old tab blank. */
    if (panel && panel.view) return;
    var el = document.querySelector(panel.el);
    if (!el) return;


    drag.floating = true;
    dom.ghost.style.display = 'none';

    var wrap = document.createElement('div');
    wrap.className = 'dock-float glass';
    wrap.dataset.panel = panel.id;
    wrap.style.zIndex = nextZ();

    var bar = document.createElement('div');
    bar.className = 'dock-float-bar';
    bar.innerHTML =
      '<span class="material-icons-round dock-float-icon">' + panel.icon + '</span>' +
      '<span class="dock-float-title"></span>' +
      '<button class="dock-float-btn" data-act="pin" title="Pin this window above the others">' +
      '<span class="material-icons-round">push_pin</span></button>' +
      '<button class="dock-float-btn" data-act="minimize" title="Minimize this window">' +
      '<span class="material-icons-round">remove</span></button>' +
      '<button class="dock-float-btn" data-act="close" title="Close window">' +
      '<span class="material-icons-round">close</span></button>';

    var body = document.createElement('div');
    body.className = 'dock-float-body';

    wrap.appendChild(bar);
    wrap.appendChild(body);
    /* Handles are built here, not only on the restore-from-storage path. A float
       created by tearing a tab off previously had no resize affordance at all,
       because decorateFloats() only ran once during startup. */
    buildHandles(wrap);
    dom.floatLayer.appendChild(wrap);

    /* The checklist panel is #content itself, so it can never be moved into the
       float layer without destroying the whole app. It stays docked. */
    if (panel.id === 'checklist') {
      drag.floating = false;
      dom.ghost.style.display = '';
      wrap.remove();
      return;
    }

    body.appendChild(el);
    drag.floatEl = wrap;
    drag.floatBar = bar;

    /* Default size and placement.
       Two problems with the old fixed 720x460 at the cursor:
         - 720px is wider than half the workspace, so two windows could never
           actually sit side by side without being shrunk by hand first.
         - every window landed on top of the previous one, so a second tear-off
           looked like nothing happened.
       The cascade step is deliberately larger than the title bar. The title bar
       is the only grab area, so a window tucked under the previous one cannot
       be picked up at all - a 34px step buried it completely. */
    var ws = workspace();
    var openCount = Object.keys(state.floats).length;
    var f = {
      w: Math.max(panel.minW, Math.min(760, Math.round(ws.w * 0.56))),
      h: Math.max(panel.minH, Math.min(520, Math.round(ws.h * 0.62)))
    };
    var stepX = 30 * openCount;
    var stepY = (TITLEBAR_H + 12) * openCount; // clears the bar of the window above
    var px = 40 + stepX;
    var py = 30 + stepY;
    var maxY = stripTopLimit() - f.h;
    if (maxY > 0) py = Math.min(py, maxY);
    if (py < 0) py = 0;
    var placed = clampRect(px, py, f.w, f.h);

    state.floats[panel.id] = { x: placed.x, y: placed.y, w: placed.w, h: placed.h, z: nextZ() };
    applyFloat(panel.id);
    dom.guides.classList.add('is-visible');
    save();

    /* Moving the element is not enough: every panel starts life with the `hidden`
       class, so a torn-off window would sit there empty and merely show whatever
       was behind it through the glass. Focusing runs the normal visibility pass,
       which resolves panels by id and so works from inside the float layer. */
    focus(panel.id);
  }

  function positionFloat(x, y) {
    if (!drag || !drag.floatEl) return;
    var ws = workspace();
    var f = state.floats[drag.id] || { w: 720, h: 460 };
    var c = snapFloatPosition(x - drag.offsetX, y - drag.offsetY, f.w, f.h, drag.id);
    drag.floatEl.style.left = (ws.left + c.x) + 'px';
    drag.floatEl.style.top = (ws.top + c.y) + 'px';
  }

  function applyFloat(id) {
    var f = state.floats[id];
    var el = dom.floatLayer.querySelector('.dock-float[data-panel="' + id + '"]');
    if (!f || !el) return;
    var ws = workspace();
    // Re-clamped on every apply so a window restored from a previous session at a
    // size larger than the current window cannot start off-screen.
    var c = clampRect(f.x, f.y, f.w, f.h);
    f.x = c.x; f.y = c.y; f.w = c.w; f.h = c.h;
    el.style.left = (ws.left + f.x) + 'px';
    el.style.top = (ws.top + f.y) + 'px';
    el.style.width = f.w + 'px';
    el.style.height = f.h + 'px';
    el.style.zIndex = f.pinned ? PIN_Z + (f.z - 1000) : f.z;
  }

  function commitFloat(id, x, y) {
    var f = state.floats[id];
    if (!f) return;
    var ws = workspace();
    var p = snapPoint(Math.min(Math.max(x - 60, 0), ws.w), Math.min(Math.max(y - 20, 0), ws.h));
    f.x = p.x;
    f.y = p.y;
    applyFloat(id);
    dom.guides.classList.remove('is-visible');
    save();
  }

  function redock(id) {
    var f = state.floats[id];
    if (!f) return;
    var wrap = dom.floatLayer.querySelector('.dock-float[data-panel="' + id + '"]');
    var panel = byId[id];
    if (wrap && panel) {
      /* Return the panel to the content container, before the float layer would
         otherwise clip it, and let renderer.js re-run its own layout. */
      var host = document.getElementById('content') || document.querySelector('.content');
      if (host && panel.id !== 'checklist') host.appendChild(wrap.querySelector('.dock-float-body').firstElementChild);
      wrap.remove();
    }
    delete state.floats[id];
    save();
    renderStrip();
    syncEmptyState();
    focus(id);
  }

  function closeFloat(id) {
    var wrap = dom.floatLayer.querySelector('.dock-float[data-panel="' + id + '"]');
    if (wrap) {
      var body = wrap.querySelector('.dock-float-body');
      var panel = byId[id];
      var inner = body ? body.firstElementChild : null;
      if (inner && panel && panel.id !== 'checklist') {
        (document.getElementById('content') || document.querySelector('.content')).appendChild(inner);
      }
      wrap.remove();
    }
    delete state.floats[id];
    save();
    renderStrip();
  }

  function nextZ() {
    if (zTop >= Z_MAX) {
      // Re-base so the most recently raised window is still on top of the others.
      var all = dom.floatLayer.querySelectorAll('.dock-float');
      for (var i = 0; i < all.length; i++) all[i].style.zIndex = 1000 + i;
      zTop = 1000 + all.length;
    }
    return ++zTop;
  }

  /* ---------------------------------------------------------
     Pin and minimize
     ---------------------------------------------------------
     Pin keeps a window above every other float permanently, so raising an
     unpinned window never covers it. Minimized windows collapse to just their
     title bar and stay out of the way until restored; they keep their position
     so restoring puts the window back where it was. Both are persisted. */
  function isPinned(id) { return !!(state.floats[id] && state.floats[id].pinned); }
  function isMinimized(id) { return !!(state.floats[id] && state.floats[id].minimized); }

  /* Pinned floats sit above the ordinary z-range, so clicking around can never
     push an unpinned window over one the user deliberately kept on top. */
  var PIN_Z = 6000;

  function applyPinState(id) {
    var el = dom.floatLayer.querySelector('.dock-float[data-panel="' + id + '"]');
    if (!el || !state.floats[id]) return;
    var f = state.floats[id];
    el.classList.toggle('is-pinned', !!f.pinned);
    el.classList.toggle('is-minimized', !!f.minimized);
    // A locked window shows no grab handles and no drag cursor, so it does not
    // look like it can be moved or resized.
    el.classList.toggle('is-locked', !!f.pinned);
    if (!f.minimized) el.style.zIndex = f.pinned ? PIN_Z + (f.z - 1000) : f.z;
  }

  function togglePin(id) {
    var f = state.floats[id];
    if (!f) return;
    f.pinned = !f.pinned;
    applyPinState(id);
    save();
  }

  function toggleMinimize(id) {
    var f = state.floats[id];
    if (!f) return;
    f.minimized = !f.minimized;
    applyPinState(id);
    save();
  }

  function applyAllPinStates() { Object.keys(state.floats).forEach(applyPinState); }

  function raise(id) {
    var f = state.floats[id];
    if (f && f.pinned) return; // pinned windows stay on top
    var el = dom.floatLayer.querySelector('.dock-float[data-panel="' + id + '"]');
    if (!f || !el) return;
    f.z = nextZ();
    el.style.zIndex = f.z;
    save();
  }

  /* ---------------------------------------------------------
     Resize
     ---------------------------------------------------------
     Snaps to the same field as dragging, so a resized window lines up with every
     other window instead of landing on an arbitrary width. */
  function startResize(e, id, edge) {
    if (isPinned(id)) return; // locked
    e.preventDefault();
    e.stopPropagation();
    var f = state.floats[id];
    var el = dom.floatLayer.querySelector('.dock-float[data-panel="' + id + '"]');
    if (!f || !el) return;
    raise(id);

    var start = { x: e.clientX, y: e.clientY, w: f.w, h: f.h, fx: f.x, fy: f.y };
    var panel = byId[id];
    var guides = dom.guides;
    guides.classList.add('is-visible');

    function move(ev) {
      var dx = ev.clientX - start.x;
      var dy = ev.clientY - start.y;
      var w = start.w, h = start.h, x = start.fx, y = start.fy;

      if (edge.indexOf('e') !== -1) w = start.w + dx;
      if (edge.indexOf('s') !== -1) h = start.h + dy;
      if (edge.indexOf('w') !== -1) { w = start.w - dx; x = start.fx + dx; }
      if (edge.indexOf('n') !== -1) { h = start.h - dy; y = start.fy + dy; }

      w = Math.max(w, panel.minW);
      h = Math.max(h, panel.minH);

      var snapped = snapSize(w, h);
      /* When resizing from the left or top the origin has to move by the same
         amount the snapped size did, or the window grows but its left edge
         slides the wrong way. */
      if (edge.indexOf('w') !== -1) x = start.fx + (start.w - snapped.w);
      if (edge.indexOf('n') !== -1) y = start.fy + (start.h - snapped.h);

      /* Let the edge being dragged meet a neighbouring window's edge, so growing
         a window to fill the space beside another lines them up instead of
         stopping a few pixels short. Only the dragged axes are considered, so
         the opposite edge stays put. */
      var cand = { x: x, y: y, w: snapped.w, h: snapped.h };
      var lockedX = edge.indexOf('w') !== -1 || edge.indexOf('e') !== -1;
      var lockedY = edge.indexOf('n') !== -1 || edge.indexOf('s') !== -1;
      var near = snapRectToNeighbours(cand, id);

      if (lockedX) {
        if (edge.indexOf('e') !== -1 && near.snappedX) {
          snapped.w = Math.max(panel.minW, near.x + near.w - cand.x);
        } else if (edge.indexOf('w') !== -1 && near.snappedX) {
          var newW = Math.max(panel.minW, cand.x + cand.w - near.x);
          snapped.w = newW;
          x = near.x;
        }
      }
      if (lockedY) {
        if (edge.indexOf('s') !== -1 && near.snappedY) {
          snapped.h = Math.max(panel.minH, near.y + near.h - cand.y);
        } else if (edge.indexOf('n') !== -1 && near.snappedY) {
          var newH = Math.max(panel.minH, cand.y + cand.h - near.y);
          snapped.h = newH;
          y = near.y;
        }
      }

      f.x = x; f.y = y; f.w = snapped.w; f.h = snapped.h;
      applyFloat(id);
    }
    function up() {
      guides.classList.remove('is-visible');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      save();
    }

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /* ---------------------------------------------------------
     Category rail
     ---------------------------------------------------------
     The equipment categories used to be sidebar buttons. They are filters on the
     checklist rather than panels, so they sit in their own rail above the item
     grid - but they get the same treatment as the panel dock: press and hold to
     pick up, drag to reorder with a snapping marker, order persisted.

     Deliberately simpler than the panel dock. Categories cannot be torn off -
     there is nothing to tear them off *from* except the grid, and floating a
     filter would hide which list it is filtering.
  */
  var cat = { drag: null, order: null };

  function loadCategoryOrder() {
    var stored = null;
    try { stored = JSON.parse(localStorage.getItem(CAT_STORE_KEY) || 'null'); } catch (e) { stored = null; }
    if (Array.isArray(stored) && stored.length) cat.order = stored;
    if (!cat.order) cat.order = currentCategoryOrder();
  }

  function currentCategoryOrder() {
    var rail = document.getElementById('category-rail');
    if (!rail) return [];
    return Array.prototype.slice
      .call(rail.querySelectorAll('.nav-item'))
      .map(function (n) { return n.id; });
  }

  function saveCategoryOrder() {
    try { localStorage.setItem(CAT_STORE_KEY, JSON.stringify(cat.order)); } catch (e) { /* private mode */ }
  }

  function applyCategoryOrder() {
    var rail = document.getElementById('category-rail');
    if (!rail) return;
    var marker = document.getElementById('category-marker');
    if (marker) rail.insertBefore(marker, rail.firstChild); // keep the marker first
    cat.order.forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.classList.contains('nav-item') && rail.contains(el)) rail.appendChild(el);
    });
  }

  function catIndexFor(clientX) {
    var rail = document.getElementById('category-rail');
    var kids = Array.prototype.slice.call(rail.querySelectorAll('.nav-item'));
    for (var i = 0; i < kids.length; i++) {
      var r = kids[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return kids.length;
  }

  function showCatMarker(index) {
    var rail = document.getElementById('category-rail');
    var marker = document.getElementById('category-marker');
    if (!rail || !marker) return;
    var kids = Array.prototype.slice.call(rail.querySelectorAll('.nav-item'));
    var railRect = rail.getBoundingClientRect();
    var left;
    if (!kids.length) left = 0;
    else if (index >= kids.length) left = kids[kids.length - 1].getBoundingClientRect().right - railRect.left - 3;
    else left = kids[index].getBoundingClientRect().left - railRect.left;
    marker.style.transform = 'translateX(' + left + 'px)';
    marker.classList.add('is-visible');
  }

  function onCatPointerDown(e) {
    if (e.button !== 0 || cat.drag) return;
    var rail = document.getElementById('category-rail');
    if (!rail) return;
    var item = e.target.closest ? e.target.closest('.nav-item') : null;
    if (!item || !rail.contains(item)) return;

    cat.drag = {
      id: item.id,
      el: item,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX - item.getBoundingClientRect().left,
      index: null,
      armed: false
    };
    /* Same browser behaviour as the panel dock: movement past the threshold
       picks the chip up. No long-press. */
  }

  function liftCat(e) {
    if (!cat.drag || cat.drag.armed) return;
    cat.drag.armed = true;
    var item = cat.drag.el;
    var r = item.getBoundingClientRect();
    item.classList.add('is-lifted');
    document.body.classList.add('is-docking');
    item.style.left = r.left + 'px';
    item.style.top = r.top + 'px';
  }

  function onCatPointerMove(e) {
    if (!cat.drag) return;
    if (!cat.drag.armed) {
      if (Math.abs(e.clientX - cat.drag.startX) + Math.abs(e.clientY - cat.drag.startY) < DRAG_THRESHOLD) return;
      liftCat(e);
    }

    var el = cat.drag.el;
    var r = el.getBoundingClientRect();
    el.style.transform = 'translate(' + (e.clientX - cat.drag.offsetX - r.left) + 'px, 0) scale(1.05)';

    var idx = catIndexFor(e.clientX);
    if (idx === cat.drag.index) return;
    cat.drag.index = idx;
    showCatMarker(idx);
  }

  function onCatPointerUp() {
    if (!cat.drag) return;
    document.body.classList.remove('is-docking');
    var marker = document.getElementById('category-marker');
    if (marker) marker.classList.remove('is-visible');

    var el = cat.drag.el;
    el.classList.remove('is-lifted');
    el.style.transform = '';
    el.style.left = '';
    el.style.top = '';

    var id = cat.drag.id;
    var index = cat.drag.index;
    cat.drag = null;

    if (index === null) return;
    var current = cat.order.indexOf(id);
    if (current === -1) return;
    var target = index > current ? index - 1 : index;
    if (target === current) return;
    cat.order.splice(current, 1);
    cat.order.splice(target, 0, id);
    applyCategoryOrder();
    saveCategoryOrder();
  }

  function initCategoryRail() {
    var rail = document.getElementById('category-rail');
    if (!rail) return;
    loadCategoryOrder();
    applyCategoryOrder();

    // Suppress the click that follows a drag, so releasing a chip does not also
    // switch the category it was just repositioned.
    rail.addEventListener('click', function (e) {
      if (document.body.classList.contains('is-docking')) {
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);

    rail.addEventListener('pointerdown', onCatPointerDown);
    window.addEventListener('pointermove', onCatPointerMove);
    window.addEventListener('pointerup', onCatPointerUp);
    window.addEventListener('pointercancel', onCatPointerUp);
  }

  /* ---------------------------------------------------------
     Wiring
     --------------------------------------------------------- */
  function onLayerPointerDown(e) {
    // Resize handles win over the drag handler.
    var handle = e.target.closest ? e.target.closest('.dock-resize') : null;
    if (handle) {
      var wrap = handle.closest('.dock-float');
      if (wrap) startResize(e, wrap.dataset.panel, handle.dataset.edge);
      return;
    }

    var floatEl = e.target.closest ? e.target.closest('.dock-float') : null;
    if (floatEl) {
      if (e.target.closest('.dock-float-bar')) {
        raise(floatEl.dataset.panel);
        startFloatDrag(e, floatEl.dataset.panel);
        return;
      }
      if (!e.target.closest('.dock-float-body')) raise(floatEl.dataset.panel);
      return;
    }

    onPointerDown(e);
  }

  /* The dock/close buttons are handled here rather than on pointerdown so that
     keyboard activation works: pressing Enter or Space on a focused button fires
     click but not pointerdown, which previously made the buttons unusable
     without a mouse. */
  function onLayerClick(e) {
    var btn = e.target.closest ? e.target.closest('.dock-float-btn') : null;
    if (btn) {
      var wrap = btn.closest('.dock-float');
      if (!wrap) return;
      if (btn.dataset.act === 'pin') togglePin(wrap.dataset.panel);
      else if (btn.dataset.act === 'minimize') toggleMinimize(wrap.dataset.panel);
      else if (btn.dataset.act === 'close') closeFloat(wrap.dataset.panel);
      else if (btn.dataset.act === 'dock') redock(wrap.dataset.panel);
      return;
    }

    var tab = e.target.closest ? e.target.closest('.dock-tab') : null;
    if (tab && !drag) focus(tab.dataset.panel);
  }

  /* Pinned means LOCKED, not just "kept on top": the window is frozen where it
     is and cannot be moved or resized until unpinned. Unpinning leaves it in
     exactly the same spot and hands back full drag and resize. */
  function startFloatDrag(e, id) {
    if (isPinned(id)) return;
    var f = state.floats[id];
    var el = dom.floatLayer.querySelector('.dock-float[data-panel="' + id + '"]');
    if (!f || !el) return;
    e.preventDefault();
    var ws = workspace();
    var start = { x: e.clientX, y: e.clientY, fx: f.x, fy: f.y };
    dom.guides.classList.add('is-visible');

    function move(ev) {
      var z = snapZoneFor(ev.clientX, ev.clientY);
      if (z) { showSnapPreview(z); } else { hideSnapPreview(); }
      var p = snapFloatPosition(start.fx + (ev.clientX - start.x), start.fy + (ev.clientY - start.y), f.w, f.h, id, z);
      f.x = p.x; f.y = p.y;
      /* The whole rect is applied, not just the position. Snapping against an
         edge returns a *tile* - a different size as well as a different place -
         so writing back only x/y left the window at its old size and the two
         windows still overlapped. */
      f.w = p.w; f.h = p.h;
      el.style.left = (ws.left + p.x) + 'px';
      el.style.top = (ws.top + p.y) + 'px';
      el.style.width = p.w + 'px';
      el.style.height = p.h + 'px';
    }

    function up() {
      dom.guides.classList.remove('is-visible');
      hideSnapPreview();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      save();
    }

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function buildHandles(wrap) {
    ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].forEach(function (edge) {
      var h = document.createElement('div');
      h.className = 'dock-resize dock-resize-' + edge;
      h.dataset.edge = edge;
      wrap.appendChild(h);
    });
  }

  function decorateFloats() {
    Array.prototype.slice.call(dom.floatLayer.querySelectorAll('.dock-float')).forEach(function (wrap) {
      if (wrap.querySelector('.dock-resize')) return;
      var panel = byId[wrap.dataset.panel];
      var title = wrap.querySelector('.dock-float-title');
      if (title && panel) title.textContent = panel.label;
      buildHandles(wrap);
    });
  }

  function init() {
    load();
    if (!build()) return;
    initCategoryRail();

    renderStrip();
    // Rebuild any windows that were floating when the app was last closed.
    Object.keys(state.floats).forEach(function (id) { mountFloat(id); });
    decorateFloats();
    // Restored floats hold hidden panels, so run one visibility pass to reveal
    // the active one. Deferred a tick so renderer.js has finished its own init.
    setTimeout(function () { focus(state.active); }, 300);

    dom.layer.addEventListener('pointerdown', onLayerPointerDown);
    dom.layer.addEventListener('click', onLayerClick);
    dom.layer.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act="dock-active"]') : null;
      if (b) redock(state.active);
    });
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', cancelPress);

    // Sidebar nav keeps working and syncs the dock highlight.
    PANELS.forEach(function (p) {
      if (!p.nav) return;
      var nav = document.querySelector(p.nav);
      if (nav) nav.addEventListener('click', function () { focus(p.id); });
    });

    window.addEventListener('resize', function () {
      Object.keys(state.floats).forEach(function (id) { applyFloat(id); });
    });
  }

  function mountFloat(id) {
    var panel = byId[id];
    var f = state.floats[id];
    if (!panel || !f || panel.id === 'checklist') return;
    var el = document.querySelector(panel.el);
    if (!el) return;
    var wrap = document.createElement('div');
    wrap.className = 'dock-float glass';
    wrap.dataset.panel = id;
    var bar = document.createElement('div');
    bar.className = 'dock-float-bar';
    bar.innerHTML =
      '<span class="material-icons-round dock-float-icon">' + panel.icon + '</span>' +
      '<span class="dock-float-title">' + panel.label + '</span>' +
      '<button class="dock-float-btn" data-act="pin" title="Pin this window above the others"><span class="material-icons-round">push_pin</span></button>' +
      '<button class="dock-float-btn" data-act="minimize" title="Minimize this window"><span class="material-icons-round">remove</span></button>' +
      '<button class="dock-float-btn" data-act="close" title="Close window"><span class="material-icons-round">close</span></button>';
    var body = document.createElement('div');
    body.className = 'dock-float-body';
    wrap.appendChild(bar);
    wrap.appendChild(body);
    dom.floatLayer.appendChild(wrap);
    body.appendChild(el);
    applyFloat(id);
    applyPinState(id);
  }

  window.OrdisDock = {
    focus: focus,
    /* The panel registry, shared with splitview.js. The rail and the split panes are
       built from the same list the strip uses, so a panel added here shows up in both
       without a second edit. */
    panels: PANELS,
    /* Tear a panel off into a floating window at a point, without a drag in progress.
       The rail's gesture ends outside the workspace and needs exactly the behaviour
       tearOff() already implements, so this fakes the minimum drag state it reads
       rather than duplicating the window-building code. */
    tearOffPanel: function (id, x, y) {
      var panel = byId[id];
      if (!panel || panel.id === 'checklist' || !dom.ghost) return false;
      drag = {
        panel: panel,
        id: panel.id,
        floating: false,
        floatEl: null,
        floatBar: null,
        offsetX: 40,
        offsetY: 18,
        startX: x,
        startY: y
      };
      tearOff(x, y);
      drag = null;
      return true;
    },

    /* Called by renderer.js whenever a panel is shown by any route.
       Without this the dock's highlight only tracked panels the dock itself
       switched to, so a relic link or a "Used By" jump would open a panel while
       the strip still highlighted the old one. */
    sync: function (id) {
      revealFloatingPanels();
      if (!byId[id] || id === state.active) return;
      state.active = id;
      syncActive();
      syncEmptyState();
      save();
    },

    /* Add to a tab's tooltip, so a fact that used to live in a rail badge is not simply
     * lost when the row becomes a tab. Passing null clears it.
     *
     * renderStrip() rebuilds every tab from the panel list, so anything written straight
     * onto a tab is lost the next time the strip re-renders. It is kept here and re-applied
     * in buildTab instead, or the count would appear once and then vanish on the next
     * drag. */
    setTabMeta: function (id, note) {
      var panel = byId[id];
      if (!panel) return;
      if (note) panel.note = note; else delete panel.note;
      if (!dom.tabs || !dom.tabs[id]) return;
      var tab = dom.tabs[id];
      tab.title = tabTitle(panel);
    },

    teardown: function () {
      if (!dom.layer) return;
      Object.keys(state.floats).forEach(function (id) { redock(id); });
      dom.layer.remove();
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
