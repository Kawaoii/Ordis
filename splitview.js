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

   WHY SEAMLESS MATTERS MORE THAN IT SOUNDS
   -----------------------------------------
   Two panes with a gap and rounded corners do not read as one window, they read as
   two windows sitting near each other. The gap shows the desktop behind, the
   corners show it too, and the whole thing stops looking like a single surface. So
   the split container is a flex row with no gap, the panes have square corners, and
   the only thing between them is a one pixel rule. Nothing floats above them either:
   no shadow, no margin, nothing that implies separation.

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

  var STORE_KEY = 'ordis.split.v1';
  var RAIL_WIDTH = 60;
  var DIVIDER_MIN = 260;   // px, so a pane can never be dragged shut entirely
  var DRAG_THRESHOLD = 6;  // px before a press on the rail becomes a drag

  var rail = null;
  var workspace = null;
  var panesHost = null;
  var ghost = null;
  var state = { panes: [], ratio: 0.5 };
  var drag = null;
  var dividerDrag = null;

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

  function elFor(panel) {
    return panel ? document.querySelector(panel.el) : null;
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
    (Array.isArray(raw.panes) ? raw.panes : []).slice(0, 2).forEach(function (id) {
      // A saved id that no longer resolves would render an empty pane forever, so it
      // is dropped here instead of at paint time.
      if (panelById(id) && !seen[id]) { seen[id] = true; kept.push(id); }
    });
    if (kept.length) state.panes = kept;

    var r = Number(raw.ratio);
    if (isFinite(r) && r > 0.15 && r < 0.85) state.ratio = r;
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ panes: state.panes, ratio: state.ratio }));
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
    return true;
  }

  function renderRail() {
    if (!rail) return;
    rail.textContent = '';
    panels().forEach(function (panel) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'split-rail-btn';
      btn.dataset.panel = panel.id;
      btn.title = panel.label;
      btn.setAttribute('aria-label', panel.label);
      btn.innerHTML = '<span class="material-icons-round">' + panel.icon + '</span>';
      rail.appendChild(btn);
    });
    syncRail();
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
    panesHost.textContent = '';

    // Anything that was in a pane but no longer is goes back to the workspace, so a
    // closed pane does not take its panel out of the app with it.
    var stillOpen = state.panes.slice();
    Array.prototype.slice.call(panesHost.querySelectorAll('.split-pane-body > *')).forEach(function (el) {
      if (stillOpen.indexOf(el.id) === -1 && el.parentNode === panesHost.parentNode) {
        panesHost.parentNode.appendChild(el);
      }
    });

    if (!state.panes.length) {
      panesHost.classList.add('is-empty');
      return;
    }
    panesHost.classList.remove('is-empty');

    state.panes.forEach(function (id, index) {
      var panel = panelById(id);
      var el = elFor(panel);
      if (!panel || !el) return;

      var pane = document.createElement('section');
      pane.className = 'split-pane';
      pane.dataset.panel = id;
      pane.dataset.slot = index === 0 ? 'primary' : 'secondary';

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
      panesHost.appendChild(pane);
      body.appendChild(el);
    });

    if (state.panes.length > 1 && !panesHost.querySelector('.split-divider')) {
      var divider = document.createElement('div');
      divider.className = 'split-divider';
      divider.setAttribute('role', 'separator');
      divider.setAttribute('aria-orientation', 'vertical');
      divider.title = 'Drag to resize';
      panesHost.appendChild(divider);
    }

    applyRatio();
    return reveal();
  }

  function applyRatio() {
    if (!panesHost) return;
    var two = state.panes.length > 1;
    panesHost.classList.toggle('is-split', two);
    panesHost.style.setProperty('--split-ratio', String(state.ratio));
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
    if (state.panes[0] === id) return;          // already primary
    if (state.panes[1] === id) { setPanes([id, state.panes[0]], true); return; }
    // A different panel was opened. It becomes the primary; whatever was primary drops
    // to a single pane again rather than being left behind as a stale shell.
    setPanes([id]);
  }

  function setPanes(next, keepRatio) {
    state.panes = next.slice(0, 2);
    if (!keepRatio) state.ratio = 0.5;
    renderPanes();
    syncRail();
    save();
  }

  function openPrimary(id) {
    if (state.panes[0] === id) return;
    // Clicking the icon of a panel already open in the second slot promotes it,
    // which is what people expect from a tab and avoids a pointless no-op.
    if (state.panes[1] === id) { setPanes([id, state.panes[0]], true); return; }
    setPanes([id]);
  }

  function splitWith(id) {
    if (!state.panes.length) { setPanes([id]); return; }
    if (state.panes.indexOf(id) > -1) { openPrimary(id); return; }
    setPanes([state.panes[0], id], true);
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

  function hitTest(x, y) {
    var overRail = rail && rail.contains(document.elementFromPoint(x, y));
    if (overRail) {
      var btn = document.elementFromPoint(x, y).closest('.split-rail-btn');
      if (btn && btn.dataset.panel !== drag.id) return { kind: 'split', id: btn.dataset.panel };
      return null;
    }
    if (workspace && workspace.contains(document.elementFromPoint(x, y))) {
      return { kind: 'split', id: drag.id, keep: true };
    }
    return { kind: 'float' };
  }

  function highlightTarget(target) {
    if (!rail || !workspace) return;
    Array.prototype.forEach.call(rail.children, function (btn) {
      btn.classList.toggle('is-drop', !!target && target.kind === 'split' && btn.dataset.panel === target.id);
    });
    workspace.classList.toggle('is-drop', !!target && target.kind === 'split');
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

    if (!wasActive) { openPrimary(id); return; }
    if (!target) return;
    if (target.kind === 'split' && target.keep) return; // dropped on its own pane
    if (target.kind === 'split') splitWith(target.id);
    else if (dock() && typeof dock().tearOffPanel === 'function') dock().tearOffPanel(id, e.clientX, e.clientY);
  }

  /* ---------------------------------------------------------
     Divider
     --------------------------------------------------------- */
  function onDividerPointerDown(e) {
    var divider = e.target.closest ? e.target.closest('.split-divider') : null;
    if (!divider || !workspace) return;
    e.preventDefault();
    dividerDrag = { startX: e.clientX, startRatio: state.ratio };
    document.body.classList.add('is-resizing-split');
    divider.setPointerCapture && divider.setPointerCapture(e.pointerId);
    window.addEventListener('pointermove', onDividerPointerMove);
    window.addEventListener('pointerup', onDividerPointerUp);
    window.addEventListener('pointercancel', onDividerPointerUp);
  }

  function onDividerPointerMove(e) {
    if (!dividerDrag || !workspace) return;
    var rect = workspace.getBoundingClientRect();
    if (rect.width <= 0) return;
    // The rail eats into the workspace, so the ratio is measured against the panes
    // area rather than the window, otherwise the divider drifts as it is dragged.
    var usable = rect.width - RAIL_WIDTH;
    if (usable <= 0) return;
    var next = (e.clientX - rect.left - RAIL_WIDTH) / usable;
    state.ratio = Math.min(0.85, Math.max(0.15, next));
    applyRatio();
  }

  function onDividerPointerUp() {
    window.removeEventListener('pointermove', onDividerPointerMove);
    window.removeEventListener('pointerup', onDividerPointerUp);
    window.removeEventListener('pointercancel', onDividerPointerUp);
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
    panes: function () { return state.panes.slice(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
