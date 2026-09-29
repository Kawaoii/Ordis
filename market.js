// ==========================================
//  WARFRAME MARKET MODULE
// ==========================================

(function () {
  'use strict';

  const MARKET_API = 'https://api.warframe.market/v2/items';
  const AUCTIONS_PAGE_URL = 'https://warframe.market/auctions';
  // Note: the v1 search endpoint cannot satisfy any filter combination (it answers
  // requirements_not_met for type=riven/lich/sister, with or without the full
  // legacy form), so contracts are read from the public /v1/auctions feed and
  // filtered locally by wfm-contracts.js. See that file for the probe results.
  const ORDERS_API_V2 = 'https://api.warframe.market/v2/orders/item';
  const ORDERS_API_V1 = 'https://api.warframe.market/v1/items';
  const STATS_API_V1 = 'https://api.warframe.market/v1/items';
  const CDN_BASE = 'https://warframe.market/static/assets/';
  const PLATINUM_ICON_PATH = 'assets/Platinum.png';
  const MARKET_CACHE_KEY = 'warframe_market_items_v3';
  const CONTRACTS_LOOKUP_CACHE_KEY = 'warframe_market_contract_lookups_v1';
  const MARKET_CACHE_TTL = 60 * 60 * 1000; // 1 hour
  const CONTRACTS_LOOKUP_CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours
  const ANALYTICS_STATS_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
  const ANALYTICS_ORDERS_CACHE_TTL = 90 * 1000; // 90 seconds
  const OVERLAY_PRICE_CACHE_TTL = 20 * 60 * 1000; // 20 minutes
  const OVERLAY_PRICE_REQUEST_TIMEOUT_MS = 2500;
  const CONTRACT_RESULTS_BATCH_SIZE = 60;
  const CONTRACT_ANY_EPHEMERA_VALUE = '__any_ephemera__';
  const RIVEN_WEAPONS_API = 'https://api.warframe.market/v2/riven/weapons';
  const RIVEN_ATTRIBUTES_API = 'https://api.warframe.market/v2/riven/attributes';
  const CONTRACT_FEED_API = 'https://api.warframe.market/v1/auctions';
  const PRIME_SET_PART_LIMIT = 10;
  const ANALYTICS_DEFAULT_PICK_NAMES = [
    'Arcane Energize',
    'Arcane Grace',
    'Primed Continuity',
    'Glaive Prime Set',
    'Harrow Prime Set',
    'Nekros Prime Set',
    'Aya',
    'Legendary Core'
  ];

let marketItems = [];
let marketGroups = [];
let filteredMarketItems = [];
let marketSearchQuery = '';
let marketCategory = 'all';
let currentOrdersSlug = null;
let currentOrdersItemName = null;
let currentOrdersWikiUrl = null;
let currentOrdersItemMeta = null;
let currentOrdersSetGroup = null;
// Bumped whenever the modal targets a different item, so a slow orders response for the
// previous item cannot render under the new item's heading.
let ordersOpenToken = 0;
let ordersOnlineOnly = false;
let ordersOnlineMode = 'all_online';
let ordersRefreshInterval = null;
let marketInitialized = false;
let marketViewMode = 'items';
let analyticsSearchQuery = '';
let analyticsSelectedSlug = '';
let analyticsCurrentItem = null;
let analyticsStatsCache = Object.create(null);
let analyticsOrdersCache = Object.create(null);
let overlayPriceCache = Object.create(null);
let overlayPriceRequests = Object.create(null);
let analyticsRequestToken = 0;
let contractsLookupData = null;
let contractsLookupPromise = null;
let contractsLookupError = '';
let contractsResults = [];
let contractsLoading = false;
let contractsError = '';

// Inventory service - tracks what the player owns
let inventoryService = {
   ownedItems: new Set(),      // Item names the player owns
   masteredItems: new Set(),   // Item names the player has mastered
   vaultedItems: new Set(),    // Item names that are currently vaulted
   
   // Load inventory from localStorage
   load: function() {
     try {
       const owned = localStorage.getItem('warframe_inventory_owned_items');
       if (owned) {
         this.ownedItems = new Set(JSON.parse(owned));
       }
     } catch (e) {
       console.error('Failed to load owned items from localStorage', e);
     }
     try {
       const mastered = localStorage.getItem('warframe_inventory_mastered_items');
       if (mastered) {
         this.masteredItems = new Set(JSON.parse(mastered));
       }
     } catch (e) {
       console.error('Failed to load mastered items from localStorage', e);
     }
     try {
       const vaulted = localStorage.getItem('warframe_inventory_vaulted_items');
       if (vaulted) {
         this.vaultedItems = new Set(JSON.parse(vaulted));
       }
     } catch (e) {
       console.error('Failed to load vaulted items from localStorage', e);
     }
   },
   
   // Save inventory to localStorage
   save: function() {
     try {
       localStorage.setItem('warframe_inventory_owned_items', JSON.stringify(Array.from(this.ownedItems)));
     } catch (e) {
       console.error('Failed to save owned items to localStorage', e);
     }
     try {
       localStorage.setItem('warframe_inventory_mastered_items', JSON.stringify(Array.from(this.masteredItems)));
     } catch (e) {
       console.error('Failed to save mastered items to localStorage', e);
     }
     try {
       localStorage.setItem('warframe_inventory_vaulted_items', JSON.stringify(Array.from(this.vaultedItems)));
     } catch (e) {
       console.error('Failed to save vaulted items to localStorage', e);
     }
   },
   
   // Initialize with empty sets - in a real implementation this would be populated from game data
   init: function() {
     // Load from localStorage
     this.load();
     // Stub: In reality, this would fetch from game data via Overwolf or WFM API
     // For now we'll leave empty - UI will show none owned
     // this.ownedItems.clear();
     // this.masteredItems.clear();
     // this.vaultedItems.clear();
   },
   
   // Check if item is owned
   isOwned: function(itemName) {
     return this.ownedItems.has(itemName);
   },
   
   // Check if item is mastered
   isMastered: function(itemName) {
     return this.masteredItems.has(itemName);
   },
   
   // Check if item is vaulted
   isVaulted: function(itemName) {
     return this.vaultedItems.has(itemName);
   },
   
   // Add an owned item
   addOwnedItem: function(itemName) {
     this.ownedItems.add(itemName);
     this.save();
   },
   
   // Remove an owned item
   removeOwnedItem: function(itemName) {
     this.ownedItems.delete(itemName);
     this.save();
   },
   
   // Toggle owned status
   toggleOwnedItem: function(itemName) {
     if (this.ownedItems.has(itemName)) {
       this.ownedItems.delete(itemName);
     } else {
       this.ownedItems.add(itemName);
     }
     this.save();
   },
   
   // Add a mastered item
   addMasteredItem: function(itemName) {
     this.masteredItems.add(itemName);
     this.save();
   },
   
   // Remove a mastered item
   removeMasteredItem: function(itemName) {
     this.masteredItems.delete(itemName);
     this.save();
   },
   
   // Toggle mastered status
   toggleMasteredItem: function(itemName) {
     if (this.masteredItems.has(itemName)) {
       this.masteredItems.delete(itemName);
     } else {
       this.masteredItems.add(itemName);
     }
     this.save();
   },
   
   // Add a vaulted item
   addVaultedItem: function(itemName) {
     this.vaultedItems.add(itemName);
     this.save();
   },
   
   // Remove a vaulted item
   removeVaultedItem: function(itemName) {
     this.vaultedItems.delete(itemName);
     this.save();
   },
   
   // Toggle vaulted status
   toggleVaultedItem: function(itemName) {
     if (this.vaultedItems.has(itemName)) {
       this.vaultedItems.delete(itemName);
     } else {
       this.vaultedItems.add(itemName);
     }
     this.save();
   },
   
   // Get count of owned parts for a set
   getOwnedPartCount: function(setGroup) {
     if (!setGroup || !setGroup.parts) return 0;
     let count = 0;
     for (const part of setGroup.parts) {
       if (this.ownedItems.has(part.name)) {
         count++;
       }
     }
     return count;
   },
   
   // Get count of mastered parts for a set
   getMasteredPartCount: function(setGroup) {
     if (!setGroup || !setGroup.parts) return 0;
     let count = 0;
     for (const part of setGroup.parts) {
       if (this.masteredItems.has(part.name)) {
         count++;
       }
     }
     return count;
   },
   
   // Get count of vaulted parts for a set
   getVaultedPartCount: function(setGroup) {
     if (!setGroup || !setGroup.parts) return 0;
     let count = 0;
     for (const part of setGroup.parts) {
       if (this.vaultedItems.has(part.name)) {
         count++;
       }
     }
     return count;
   }
 };

// Initialize inventory service
inventoryService.init();

// Expose globally for use in other modules (e.g., renderer.js)
window.inventoryService = inventoryService;

// Market inventory filter state
const MARKET_FILTER_STATE_KEY = 'market-inventory-filter-state';

let showOwnedOnly = false;
let showNotOwnedOnly = false;
let showVaultedOnly = false;
let showActiveOnly = false;
// Declared because applyMarketFilters() reads it. It was referenced but never
// defined, so the ReferenceError aborted every market load: the filter pass
// threw inside loadMarketItems()'s try block, which reported the failure as
// "Failed to fetch market items" even though the fetch had succeeded, and no
// items were ever rendered.
let showMasteredOnly = false;

// Load filter state from localStorage
(function loadMarketFilterState() {
  try {
    var raw = localStorage.getItem(MARKET_FILTER_STATE_KEY);
    if (!raw) return;
    var state = JSON.parse(raw);
    if (typeof state.showOwnedOnly === 'boolean') showOwnedOnly = state.showOwnedOnly;
    if (typeof state.showNotOwnedOnly === 'boolean') showNotOwnedOnly = state.showNotOwnedOnly;
    if (typeof state.showVaultedOnly === 'boolean') showVaultedOnly = state.showVaultedOnly;
    if (typeof state.showActiveOnly === 'boolean') showActiveOnly = state.showActiveOnly;
  } catch (e) {
    /* ignore corrupt state */
  }
})();

// Save filter state to localStorage
function saveMarketFilterState() {
  try {
    localStorage.setItem(MARKET_FILTER_STATE_KEY, JSON.stringify({
      showOwnedOnly: showOwnedOnly,
      showNotOwnedOnly: showNotOwnedOnly,
      showVaultedOnly: showVaultedOnly,
      showActiveOnly: showActiveOnly
    }));
  } catch (e) {
    /* quota exceeded */
  }
}
  // How far back the last local feed walk actually went, so the results can say so
  // rather than implying an empty result means no listings exist.
  let contractsCoverageNote = '';
  let contractsHasSearched = false;
  let contractsRequestToken = 0;
  let contractsVisibleCount = CONTRACT_RESULTS_BATCH_SIZE;
  let contractsFilters = createDefaultContractsFilters();

  const $ = function (sel) { return document.querySelector(sel); };

  function createDefaultContractsFilters(type) {
    return {
      type: type || 'riven',
      weaponUrlName: '',
      positiveStats: ['', '', ''],
      negativeStat: '',
      modRank: 'any',
      element: '',
      ephemera: '',
      sortBy: 'price_asc',
      quickSearch: ''
    };
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getMarketPanelRefs() {
      return {
        panel: $('#market-panel'),
        topbar: document.querySelector('#market-panel .content-topbar'),
        categoriesList: $('#market-categories-list'),
        contractsBtn: $('#market-contracts-btn'),
        contractsBtnLabel: $('#market-contracts-btn-label'),
        title: $('#market-panel-title'),
        count: $('#market-item-count'),
        grid: $('#market-grid'),
        contractsView: $('#contracts-view')
      };
    }


  function updateMarketPanelHeader() {
    var refs = getMarketPanelRefs();
    if (!refs.title || !refs.count) return;

    if (marketViewMode === 'contracts') {
      refs.title.textContent = 'Contracts';

      if (contractsLookupError) {
        refs.count.textContent = 'status unavailable';
      } else if (contractsLoading) {
        refs.count.textContent = 'Searching live auctions...';
      } else if (!canSearchContracts()) {
        refs.count.textContent = 'Pick filters for Rivens, Liches, or Sisters';
      } else if (!contractsHasSearched) {
        refs.count.textContent = 'Ready to search';
      } else {
        refs.count.textContent = getFilteredContractsResults().length + ' contracts';
      }
      return;
    }

    if (marketViewMode === 'my_orders') {
      refs.title.textContent = 'My Active Listings';
      refs.count.textContent = 'Managing your warframe.market orders';
      return;
    }

    refs.title.textContent = 'Warframe Market';
    refs.count.textContent = filteredMarketItems.length + ' items';
  }

  function renderMarketViewState() {
    var refs = getMarketPanelRefs();
    var isItems = marketViewMode === 'items';
    var isContracts = marketViewMode === 'contracts';
    var isMyOrders = marketViewMode === 'my_orders';

    if (refs.topbar) refs.topbar.classList.toggle('hidden', !isItems);
    if (refs.categoriesList) refs.categoriesList.classList.toggle('hidden', !isItems);
    if (refs.grid) refs.grid.classList.toggle('hidden', !isItems);
    if (refs.contractsView) refs.contractsView.classList.toggle('hidden', !isContracts);

    if (refs.contractsBtn) refs.contractsBtn.classList.toggle('active', isContracts);
    if (refs.contractsBtnLabel) refs.contractsBtnLabel.textContent = isContracts ? 'Back To Market' : 'Contracts';

    var myOrdersView = $('#my-orders-view');
    var myOrdersBtn = $('#market-my-orders-btn');
    if (myOrdersView) myOrdersView.classList.toggle('hidden', !isMyOrders);
    if (myOrdersBtn) myOrdersBtn.classList.toggle('active', isMyOrders);

    // The panel is tinted per view so the mode is readable at a glance: Contracts
    // carries the riven palette, because every contract on Warframe.market is a
    // riven trade. My Orders is deliberately left on the default tint - it is a
    // management screen, not a trade, and the listing colours already carry
    // their own meaning there.
    var panel = refs.panel;
    if (panel) {
      panel.classList.toggle('mode-contracts', isContracts);
      panel.classList.toggle('mode-my-orders', isMyOrders);
    }

    updateMarketPanelHeader();
  }

  async function setMarketViewMode(mode) {
    marketViewMode = mode === 'contracts' ? 'contracts' : (mode === 'my_orders' ? 'my_orders' : 'items');
    renderMarketViewState();

    if (marketViewMode === 'contracts') {
      try {
        await ensureContractsLookupData();
      } catch (err) {
        /* render fallback below */
      }
      renderContractsView();
      return;
    }

    if (marketViewMode === 'my_orders') {
      fetchAndRenderMyOrders();
      return;
    }

    applyMarketFilters();
  }

  function safeNameFromSlug(slug) {
    if (!slug) return 'Unknown Item';
    return String(slug)
      .replace(/^\/+/, '')
      .split(/[_-]+/)
      .filter(Boolean)
      .map(function (part) { return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(); })
      .join(' ');
  }

  function getMarketImageUrl(path) {
    if (!path) return '';
    if (/^https?:\/\//i.test(path)) return path;
    return CDN_BASE + String(path).replace(/^\/+/, '');
  }

  // Warframe Market serves item art from CDN_BASE, which sits behind the same
  // Cloudflare protection as the login flow and answers 403 for direct requests, so
  // every market thumbnail was rendering broken. The app's own item catalogue already
  // carries working art for most tradable items, so prefer that and keep the WFM URL
  // only as a last resort for items the catalogue does not know.
// Warframe Market splits a weapon into parts that have no catalogue or wiki page of
   // their own ("Acceltra Prime Barrel"), but the parent weapon is always present.
   // Try known part suffixes and the Set case to find the parent weapon art.
   function resolveLocalCatalogImage(name) {
     var bridge = window.warframeItemImageBridge;
     if (!bridge || typeof bridge.getImageUrlByName !== 'function') return null;
     var trimmed = String(name || '').trim();
     if (!trimmed) return null;

     // Known part suffixes that we can strip to find the parent weapon
     var knownSuffixes = [
       'Blueprint', 'Barrel', 'Receiver', 'Stock', 'Blade', 'Hilt', 'Guard', 'Motor',
       'Harness', 'Systems', 'Wings', 'Engines', 'Fuselage', 'Clip', 'Magazine', 'Trigger',
       'Stringer', 'Housing', 'Head', 'Frame', 'Chassis', 'Pylon', 'Optic', 'Scope', 'Muzzle',
       'Tip', 'Imprint', 'Core'
     ];

     var candidates = [];

     // 1. Try the exact name first (for non-part items that exist in the catalog)
     candidates.push({name: trimmed, isSameItem: true});

     // 2. If it ends with " Set", try the base (the set is the whole weapon)
     var setMatch = trimmed.match(/^(.+?)\s+Set$/i);
     if (setMatch) {
       candidates.push({name: setMatch[1], isSameItem: true});
     }

     // 3. Try stripping each known part suffix (case-insensitive)
     for (var i = 0; i < knownSuffixes.length; i++) {
       var suffix = knownSuffixes[i];
       if (trimmed.toLowerCase().endsWith(' ' + suffix.toLowerCase())) {
         var base = trimmed.substring(0, trimmed.length - suffix.length - 1).trim();
         if (base) {
           candidates.push({name: base, isSameItem: false});
         }
       }
     }

     // Try each candidate in order until we find a valid image URL
     for (var j = 0; j < candidates.length; j++) {
       var candidate = candidates[j];
       if (!candidate.name) continue;
       var url = '';
       try {
         url = bridge.getImageUrlByName(candidate.name) || '';
       } catch (err) {
         url = '';
       }
       if (url) {
         return { url: url, matchedName: candidate.name, isSameItem: candidate.isSameItem };
       }
     }

     return null;
   }

  function getLocalCatalogImageUrl(name) {
    var resolved = resolveLocalCatalogImage(name);
    return resolved ? resolved.url : '';
  }

// Second tier: the official wiki. The local catalogue has no entry for WFM-only
   // things such as mod effect names ("Primary Dexterity") or weapon parts
   // ("Acceltra Prime Barrel"), and WFM's own art is unreachable when Cloudflare
   // challenges the request, so the wiki fills the gap. Lookups are cached (including
   // misses) and batched, since a market page can hold hundreds of items.
   const WIKI_API = 'https://wiki.warframe.com/api.php';
   const WIKI_IMAGE_CACHE_KEY = 'wfm_wiki_image_cache_v2'; // v2 to clear stale misses
   const WIKI_BATCH_SIZE = 10;
   let wikiImageCache = null;
   let wikiQueue = [];
   let wikiBusy = false;
   let wikiRetries = 0;

  function loadWikiImageCache() {
    if (wikiImageCache) return wikiImageCache;
    try {
      wikiImageCache = JSON.parse(localStorage.getItem(WIKI_IMAGE_CACHE_KEY) || '{}') || {};
    } catch (err) {
      wikiImageCache = {};
    }
    return wikiImageCache;
  }

  function saveWikiImageCache() {
    try {
      localStorage.setItem(WIKI_IMAGE_CACHE_KEY, JSON.stringify(loadWikiImageCache()));
    } catch (err) {
      // A full or unavailable storage just means the cache is rebuilt next time.
    }
  }

  // The wiki hosts no weapon-specific part art (Acceltra Prime Barrel is an empty stub,
  // and File:AcceltraPrimeBarrel.png does not exist), but it does host generic part
  // silhouettes that are shared by every weapon. Pairing one of those with the parent
  // weapon's art tells you both which weapon and which part, which is the most a
  // trading grid can honestly show without WFM's blocked asset host.
  const MARKET_PART_ICON_FILES = {
    barrel: { prime: 'GenericGunPrimeBarrel.png', base: 'GenericGunBarrel.png' },
    receiver: { prime: 'GenericGunPrimeReceiver.png', base: 'GenericGunReceiver.png' },
    stock: { prime: 'GenericGunPrimeStock.png', base: 'GenericGunStock.png' },
    blade: { prime: 'GenericWeaponPrimeBlade.png', base: 'GenericWeaponBlade.png' },
    hilt: { prime: 'GenericWeaponPrimeHilt.png', base: 'GenericWeaponHilt.png' },
    guard: { prime: 'GenericWeaponPrimeGuard.png', base: 'GenericWeaponPrimeGuard.png' },
    motor: { prime: 'GenericWeaponMotor.png', base: 'GenericWeaponMotor.png' },
    harness: { prime: 'GenericArchwingHarnessPrime.png', base: 'GenericArchwingHarness.png' },
    systems: { prime: 'GenericArchwingSystemsPrime.png', base: 'GenericArchwingSystems.png' },
    wings: { prime: 'GenericArchwingWingsPrime.png', base: 'GenericArchwingWings.png' },
    engines: { prime: 'GenericLandingCraftEngines.png', base: 'GenericLandingCraftEngines.png' },
    fuselage: { prime: 'GenericLandingCraftFuselage.png', base: 'GenericLandingCraftFuselage.png' }
  };
  const PART_ICON_CACHE_KEY = 'wfm_wiki_part_icon_cache_v1';
  let partIconCache = null;
  let partIconPending = {};
  let partIconFlushTimer = null;

  function loadPartIconCache() {
    if (partIconCache) return partIconCache;
    try {
      partIconCache = JSON.parse(localStorage.getItem(PART_ICON_CACHE_KEY) || '{}') || {};
    } catch (err) {
      partIconCache = {};
    }
    return partIconCache;
  }

  function savePartIconCache() {
    try {
      localStorage.setItem(PART_ICON_CACHE_KEY, JSON.stringify(loadPartIconCache()));
    } catch (err) {
      // Non-fatal: the next render just re-asks the wiki.
    }
  }

  function getMarketPartIconTitle(name) {
    var trimmed = String(name || '').trim();
    var words = trimmed.split(/\s+/);
    if (words.length < 2) return '';
    var entry = MARKET_PART_ICON_FILES[words[words.length - 1].toLowerCase()];
    if (!entry) return '';
    return 'File:' + (/\bprime\b/i.test(trimmed) ? entry.prime : entry.base);
  }

  // Every card asks for its icon while the grid is being built, so collect them all and
  // resolve in a single API call. Thirteen distinct files, once, then served from cache.
  function requestMarketPartIcon(img, title) {
    var cached = loadPartIconCache()[title];
    if (cached) { img.src = cached; return; }
    if (!partIconPending[title]) partIconPending[title] = [];
    partIconPending[title].push(img);
    if (!partIconFlushTimer) partIconFlushTimer = setTimeout(flushMarketPartIcons, 0);
  }

  function flushMarketPartIcons() {
    partIconFlushTimer = null;
    var titles = Object.keys(partIconPending);
    if (!titles.length) return;
    var waiting = partIconPending;
    partIconPending = {};

    var dropAll = function () {
      for (var t = 0; t < titles.length; t++) {
        var els = waiting[titles[t]] || [];
        for (var e = 0; e < els.length; e++) if (els[e] && els[e].parentNode) els[e].parentNode.removeChild(els[e]);
      }
    };

    var url = WIKI_API + '?action=query&redirects=1&prop=imageinfo&iiprop=url&format=json&origin=*&titles=' +
      encodeURIComponent(titles.join('|'));

    fetch(url)
      .then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      })
      .then(function (json) {
        var byTitle = {};
        var pages = (json && json.query && json.query.pages) ? json.query.pages : {};
        for (var key in pages) {
          if (!Object.prototype.hasOwnProperty.call(pages, key)) continue;
          var page = pages[key];
          if (page && page.title) byTitle[String(page.title).toLowerCase()] = page;
        }
        var store = loadPartIconCache();
        for (var t = 0; t < titles.length; t++) {
          var wanted = titles[t];
          var found = byTitle[String(wanted).toLowerCase()];
          var src = (found && found.imageinfo && found.imageinfo[0] && found.imageinfo[0].url) || '';
          store[wanted] = src;
          var els = waiting[wanted] || [];
          for (var e = 0; e < els.length; e++) {
            if (!src) {
              if (els[e] && els[e].parentNode) els[e].parentNode.removeChild(els[e]);
            } else {
              els[e].src = src;
            }
          }
        }
        savePartIconCache();
      })
      .catch(dropAll);
  }

  // WFM's "X Set" is the complete weapon, but the wiki article is filed under the
  // base name, and parts ("X Barrel Blueprint") likewise resolve under the parent
  // weapon, so offer progressively shorter prefixes as fallbacks.
  function getWikiNameVariants(name) {
    var trimmed = String(name || '').trim();
    if (!trimmed) return [];

    var words = trimmed.split(/\s+/);
    var maxStrips = Math.min(2, Math.max(0, words.length - 1));
    var variants = [];
    for (var strip = 0; strip <= maxStrips; strip++) {
      var candidate = words.slice(0, words.length - strip).join(' ').trim();
      if (candidate && variants.indexOf(candidate) === -1) variants.push(candidate);
    }
    return variants;
  }

  function lookupWikiImageUrl(name, callback) {
    var variants = getWikiNameVariants(name);
    if (!variants.length) { callback(''); return; }

    var cache = loadWikiImageCache();
    for (var i = 0; i < variants.length; i++) {
      var cached = cache[variants[i]];
      if (cached) { callback(cached); return; }
    }

    enqueueWikiLookup(variants, callback);
  }

  function enqueueWikiLookup(variants, callback) {
    wikiQueue.push({ variants: variants, callback: callback });
    pumpWikiQueue();
  }

  // Lookups run one at a time with a short gap. A market page can queue hundreds of
  // names, and firing them all at once made the wiki rate-limit us; the failures were
  // swallowed, so those items silently kept no image.
  function pumpWikiQueue() {
    if (wikiBusy || !wikiQueue.length) return;
    wikiBusy = true;

    var entry = wikiQueue.shift();
    var cache = loadWikiImageCache();
    var hit = '';
    var wanted = [];
    for (var i = 0; i < entry.variants.length; i++) {
      var key = entry.variants[i];
      if (Object.prototype.hasOwnProperty.call(cache, key)) {
        if (cache[key]) hit = cache[key];
      } else {
        wanted.push(key);
      }
    }

    if (hit || !wanted.length) {
      entry.callback(hit);
      wikiBusy = false;
      pumpWikiQueue();
      return;
    }

    var titles = wanted.slice(0, WIKI_BATCH_SIZE);
    var url = WIKI_API + '?action=query&redirects=1&prop=pageimages&piprop=original&format=json&origin=*&titles=' +
      encodeURIComponent(titles.join('|'));

    fetch(url)
      .then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      })
      .then(function (json) {
        var byTitle = {};
        var pages = (json && json.query && json.query.pages) ? json.query.pages : {};
        for (var key in pages) {
          if (!Object.prototype.hasOwnProperty.call(pages, key)) continue;
          var page = pages[key];
          if (page && page.title) byTitle[String(page.title).toLowerCase()] = page;
        }
        var store = loadWikiImageCache();
        for (var t = 0; t < titles.length; t++) {
          var found = byTitle[String(titles[t]).toLowerCase()];
          store[titles[t]] = (found && found.original && found.original.source) || '';
        }
        saveWikiImageCache();
        wikiRetries = 0;

        var result = '';
        for (var v = 0; v < entry.variants.length; v++) {
          if (store[entry.variants[v]]) { result = store[entry.variants[v]]; break; }
        }
        entry.callback(result);
      })
      .catch(function () {
        // A failed request must not be cached as "no image", or the item would be
        // stuck without art forever. Retry a couple of times, then give up quietly.
        if (wikiRetries < 2) {
          wikiRetries++;
          wikiQueue.unshift(entry);
        } else {
          wikiRetries = 0;
          entry.callback('');
        }
      })
      .then(function () {
        wikiBusy = false;
        setTimeout(pumpWikiQueue, 120);
      });
  }

  // Resolve wiki art for a short, known list up front so the caller can render once
  // with final URLs instead of patching images in afterwards.
  function resolveWikiImagesForNames(names) {
    return new Promise(function (resolve) {
      var out = {};
      var pending = [];
      for (var i = 0; i < (names || []).length; i++) {
        var name = names[i];
        if (name && !getLocalCatalogImageUrl(name)) pending.push(name);
      }
      if (!pending.length) { resolve(out); return; }

      var left = pending.length;
      for (var j = 0; j < pending.length; j++) {
        (function (target) {
          lookupWikiImageUrl(target, function (url) {
            if (url) out[target] = url;
            left--;
            if (left === 0) resolve(out);
          });
        })(pending[j]);
      }
    });
  }

  // Point an already-rendered <img> at a wiki image once one is found. Items that
  // resolve locally never reach this, so it only fires for catalogue misses.
  function upgradeMarketImageFromWiki(img, name) {
    if (!img || !name) return;
    lookupWikiImageUrl(name, function (url) {
      if (!url) return;
      if (!img.isConnected) return;
      if (img.getAttribute('data-wiki-upgraded') === '1') return;
      img.setAttribute('data-wiki-upgraded', '1');
      img.style.display = '';
      img.src = url;
    });
  }

  function getMarketItemImageUrl(item, path) {
    var resolved = resolveLocalCatalogImage(item && item.name);
    if (resolved) return resolved.url;
    var source = (path === undefined || path === null) ? getMarketDisplayImage(item) : path;
    return getMarketImageUrl(source);
  }

  // Every reachable art source for a trading part is the parent weapon's picture, so five
  // cards would otherwise show the same thumbnail. Stamp the part they belong to on the
  // corner instead of downloading per-part art that no reachable host will serve.
  var MARKET_PART_BADGES = {
    blueprint: 'BP',
    barrel: 'BRL',
    receiver: 'RCV',
    stock: 'STK',
    blade: 'BLD',
    imprint: 'IMP',
    core: 'CORE',
    handle: 'HND',
    hilt: 'HLT',
    guard: 'GRD',
    grip: 'GRP',
    clip: 'CLP',
    magazine: 'MAG',
    trigger: 'TRG',
    stringer: 'STR',
    housing: 'HSG',
    head: 'HEAD',
    frame: 'FRM',
    chassis: 'CHS',
    pylon: 'PYL',
    optic: 'OPT',
    scope: 'SCP',
    muzzle: 'MUZ',
    tip: 'TIP'
  };

  function getMarketPartBadge(name) {
    var trimmed = String(name || '').trim();
    if (!trimmed) return '';
    var words = trimmed.split(/\s+/);
    if (words.length < 2) return '';
    var last = words[words.length - 1].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!last) return '';
    if (MARKET_PART_BADGES[last]) return MARKET_PART_BADGES[last];
    // Never collapse to a generic label: two different parts of the same weapon must not
    // render the same badge, or they look identical again.
    return last.slice(0, 3).toUpperCase();
  }

  // When the art belongs to the parent item rather than the exact part, say so in the
  // tooltip and mark the thumbnail. On a trading screen a Barrel icon that is really the
  // whole rifle should not pass unlabelled, and a grid of identical thumbnails is
  // unreadable.
  function labelMarketImageFallback(img, item, wrap) {
    if (!img || !item || !item.name) return;
    var resolved = resolveLocalCatalogImage(item.name);
    if (!resolved || resolved.isSameItem) return;
    if (resolved.matchedName === item.name) return;

    img.title = 'Showing artwork for "' + resolved.matchedName + '"';
    var target = wrap || (img.parentElement && img.parentElement.classList.contains('market-item-thumb') ? img.parentElement : null);
    if (!target || target.querySelector('.mi-part-badge')) return;

    var partLabel = item.name.split(/\s+/).pop();
    var badge = document.createElement('span');
    badge.className = 'mi-part-badge';
    var iconTitle = getMarketPartIconTitle(item.name);
    if (iconTitle) {
      // Real part silhouette from the wiki; the parent weapon stays as the main art.
      var icon = document.createElement('img');
      icon.className = 'mi-part-icon';
      icon.alt = '';
      icon.title = 'This listing is the ' + partLabel + ' of "' + resolved.matchedName + '".';
      requestMarketPartIcon(icon, iconTitle);
      badge.appendChild(icon);
    } else {
      badge.textContent = getMarketPartBadge(item.name) || 'PART';
    }
    badge.title = 'Artwork is the whole "' + resolved.matchedName + '". This listing is for the ' +
      partLabel + '.';
    target.appendChild(badge);
  }

  function getMarketDisplayImage(item) {
    if (!item) return '';
    return item.subIcon || item.thumb || item.icon || '';
  }

  function buildWikiUrl(item) {
    var direct = String(item && (item.wikiaUrl || item.wikiUrl) ? (item.wikiaUrl || item.wikiUrl) : '').trim();
    if (direct) return direct;

    var name = String(item && item.name ? item.name : '').trim();
    if (!name) return '';
    return 'https://warframe.fandom.com/wiki/' + encodeURIComponent(name.replace(/\s+/g, '_'));
  }

  function normalizeMarketName(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/[’'`]/g, '')
      .replace(/[^a-z0-9+]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function getCompanionImprintMarketName(name) {
    var raw = String(name || '').trim();
    if (!raw) return '';
    if (/^helminth charger$/i.test(raw)) return raw + ' Imprint';
    if (/(kubrow|kavat|vulpaphyla|predasite)$/i.test(raw)) return raw + ' Imprint';
    return '';
  }

  function getMarketNameCandidates(name) {
    var raw = String(name || '').trim();
    var base = normalizeMarketName(raw);
    if (!base) return [];

    var out = [];
    var imprintName = getCompanionImprintMarketName(raw);
    if (imprintName) out.push(normalizeMarketName(imprintName));
    out.push(base);
    out.push(base + ' blueprint');
    out.push(base + ' set');

    return out.filter(function (candidate, index, list) {
      return !!candidate && list.indexOf(candidate) === index;
    });
  }

  function findMarketItemByName(name) {
    var candidates = getMarketNameCandidates(name);
    if (candidates.length === 0) return null;

    for (var c = 0; c < candidates.length; c++) {
      var candidate = candidates[c];
      for (var i = 0; i < marketItems.length; i++) {
        if (normalizeMarketName(marketItems[i].name) === candidate) {
          return marketItems[i];
        }
      }
    }

    return null;
  }

  async function openItemByName(name) {
    if (marketViewMode !== 'items') {
      await setMarketViewMode('items');
    }

    if (!marketItems || marketItems.length === 0) {
      await loadMarketItems();
    }

    var item = findMarketItemByName(name);
    if (!item) {
      return { ok: false };
    }

    await openOrdersModal(item);
    return { ok: true, slug: item.slug, name: item.name };
  }

  async function searchItemByName(name) {
    if (marketViewMode !== 'items') {
      await setMarketViewMode('items');
    }

    if (!marketItems || marketItems.length === 0) {
      await loadMarketItems();
    }

    var input = $('#market-search-input');
    var clearBtn = $('#market-search-clear');
    var query = String(name || '').trim();

    marketSearchQuery = query;
    marketCategory = 'all';

    if (input) input.value = query;
    if (clearBtn) clearBtn.classList.toggle('hidden', !query);

    document.querySelectorAll('.market-cat-btn').forEach(function (b) { b.classList.remove('active'); });
    var allBtn = document.querySelector('.market-cat-btn[data-market-cat="all"]');
    if (allBtn) allBtn.classList.add('active');

    closeOrdersModal();
    applyMarketFilters();

    var grid = $('#market-grid');
    if (grid) grid.scrollTop = 0;

    return { ok: true, query: query };
  }

  // Tag → Category mapping
  //
  // Prime sets and prime parts used to be two categories. That split made no sense
  // once the grid groups a weapon together with its components: both filters then
  // showed the same set cards, differing only in whether a part matched. The parts
  // are reachable by opening their set, which is where they belong, so there is one
  // Prime category now.
  function getMarketCategory(tags) {
    if (!tags) return 'misc';
    if (tags.includes('mod') || tags.includes('stance') || tags.includes('aura')) return 'mods';
    if (tags.includes('arcane_enhancement') || tags.includes('arcane_helmet')) return 'arcanes';
    if (tags.includes('prime') && (tags.includes('set') || tags.includes('blueprint') || tags.includes('component'))) return 'prime';
    if (tags.includes('riven_mod')) return 'rivens';
    if (tags.includes('weapon') || tags.includes('set')) return 'weapons';
    if (tags.includes('blueprint')) return 'blueprints';
    if (tags.includes('gem') || tags.includes('fish') || tags.includes('lens') || tags.includes('ayatan_sculpture')) return 'resources';
    return 'misc';
  }

  function findMarketItemBySlug(slug) {
    var target = String(slug || '').trim();
    if (!target) return null;

    for (var i = 0; i < marketItems.length; i++) {
      if (marketItems[i] && marketItems[i].slug === target) {
        return marketItems[i];
      }
    }

    return null;
  }

  function formatPlatValue(value) {
    var num = Number(value);
    if (!isFinite(num)) return '--';
    var rounded = Math.round(num * 10) / 10;
    return (rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)) + 'p';
  }

  function formatSignedPlatValue(value) {
    var num = Number(value);
    if (!isFinite(num)) return '--';
    var prefix = num > 0 ? '+' : '';
    return prefix + formatPlatValue(num).replace(/p$/, '') + 'p';
  }

  function createPlatinumIcon(extraClass) {
    var icon = document.createElement('img');
    icon.className = 'platinum-icon' + (extraClass ? ' ' + extraClass : '');
    icon.src = PLATINUM_ICON_PATH;
    icon.alt = 'Platinum';
    icon.decoding = 'async';
    return icon;
  }

  function appendPlatinumAmount(parent, value, valueClass, iconClass) {
    if (!parent) return;
    var amount = document.createElement('span');
    amount.className = valueClass || 'plat-value';
    amount.textContent = String(value);
    parent.appendChild(amount);
    parent.appendChild(createPlatinumIcon(iconClass || ''));
  }

  function formatMetricNumber(value) {
    var num = Number(value);
    if (!isFinite(num)) return '--';
    return Math.round(num).toLocaleString();
  }

  function formatAnalyticsDate(value) {
    if (!value) return '--';
    var date = new Date(value);
    if (isNaN(date.getTime())) return '--';
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric'
    });
  }

  function formatAnalyticsTimestamp(value) {
    if (!value) return 'Waiting for market data';
    var date = new Date(value);
    if (isNaN(date.getTime())) return 'Waiting for market data';
    return 'Updated ' + date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }

  function clampNumber(value, min, max) {
    var num = Number(value);
    if (!isFinite(num)) num = 0;
    return Math.max(min, Math.min(max, num));
  }

  function formatPercentValue(value) {
    var num = Number(value);
    if (!isFinite(num)) return '--';
    var prefix = num > 0 ? '+' : '';
    return prefix + num.toFixed(Math.abs(num) >= 10 ? 0 : 1) + '%';
  }

  function getEntryPrice(entry) {
    if (!entry) return null;
    var keys = ['wa_price', 'avg_price', 'closed_price', 'median'];
    for (var i = 0; i < keys.length; i++) {
      var value = Number(entry[keys[i]]);
      if (isFinite(value) && value > 0) return value;
    }
    return null;
  }

  function getNumberOrNull(value) {
    var num = Number(value);
    return isFinite(num) && num > 0 ? num : null;
  }

  function getOrderPlatinum(order) {
    return getNumberOrNull(order && order.platinum);
  }

  function getBucketPriceLabel(bucket) {
    if (!bucket) return '--';
    return formatPlatValue(bucket.average) + ' avg / ' + formatMetricNumber(bucket.volume) + ' volume';
  }

  function getPrimeSetBaseName(item) {
    var name = String(item && item.name ? item.name : '').trim();
    return name.replace(/\s+set$/i, '').trim();
  }

  function isPrimeSetItem(item) {
    if (!item) return false;
    var tags = Array.isArray(item.tags) ? item.tags : [];
    if (tags.indexOf('prime') === -1) return false;
    if (item.category === 'prime') return tags.indexOf('set') !== -1;
    return false;
  }

  function findPrimeSetParts(setItem) {
    var baseName = getPrimeSetBaseName(setItem);
    var normalizedBase = normalizeMarketName(baseName);
    if (!normalizedBase) return [];

    var parts = [];
    var seen = Object.create(null);
    for (var i = 0; i < marketItems.length; i++) {
      var item = marketItems[i];
      if (!item || !item.slug || item.slug === setItem.slug || seen[item.slug]) continue;
      // Everything prime is one category now, so the parts are told apart by
      // carrying the prime tag without carrying set.
      if (item.category !== 'prime') continue;
      var tags = Array.isArray(item.tags) ? item.tags : [];
      if (tags.indexOf('set') !== -1) continue;

      var normalizedName = normalizeMarketName(item.name);
      if (normalizedName === normalizedBase) continue;
      if (normalizedName.indexOf(normalizedBase + ' ') !== 0) continue;

      seen[item.slug] = true;
      parts.push(item);
      if (parts.length >= PRIME_SET_PART_LIMIT) break;
    }

    return parts.sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  function getFairValue(model) {
    if (!model) return null;
    var values = [];
    if (isFinite(Number(model.avg7)) && Number(model.avg7) > 0) values.push({ value: Number(model.avg7), weight: 4 });
    if (isFinite(Number(model.avg30)) && Number(model.avg30) > 0) values.push({ value: Number(model.avg30), weight: 2 });
    if (model.bestSell && getOrderPlatinum(model.bestSell)) values.push({ value: getOrderPlatinum(model.bestSell), weight: 2 });
    if (model.bestBuy && getOrderPlatinum(model.bestBuy)) values.push({ value: getOrderPlatinum(model.bestBuy), weight: 1 });

    var totalWeight = 0;
    var totalValue = 0;
    for (var i = 0; i < values.length; i++) {
      totalWeight += values[i].weight;
      totalValue += values[i].value * values[i].weight;
    }

    return totalWeight > 0 ? totalValue / totalWeight : null;
  }

  function getMarketConfidence(model, insights) {
    if (!model) return 0;
    var orderCount = model.visibleSellOrders.length + model.visibleBuyOrders.length;
    var score = 20;
    score += Math.min(35, Number(model.volume7 || 0));
    score += Math.min(25, orderCount * 1.5);
    if (model.avg7) score += 8;
    if (model.avg30) score += 8;
    if (insights && insights.spreadPercent !== null && insights.spreadPercent > 45) score -= 12;
    if (model.visibleSellOrders.length === 0 || model.visibleBuyOrders.length === 0) score -= 10;
    return clampNumber(score, 0, 100);
  }

  function stripRewardOcrNoise(name) {
    return String(name || '')
      .replace(/\bowned\b/ig, ' ')
      .replace(/\bcrafted\b/ig, ' ')
      .replace(/\bblueprlnt\b/ig, 'Blueprint')
      .replace(/\bbiueprint\b/ig, 'Blueprint')
      .replace(/\bblacle\b/ig, 'Blade')
      .replace(/^\s*\d+\s+/, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isZeroValueRelicReward(name) {
    var normalized = normalizeMarketName(stripRewardOcrNoise(name));
    return normalized === 'forma blueprint';
  }

  async function ensureMarketItemsForOverlay() {
    if (marketItems && marketItems.length > 0) return;
    var cached = loadMarketCache();
     if (cached && cached.length > 0) {
      marketItems = refreshMarketItemCategories(cached);
      return;
    }


    var resp = await fetch(MARKET_API, {
      headers: { 'Accept': 'application/json' }
    });
    if (!resp.ok) throw new Error('Market catalog HTTP ' + resp.status);
    var json = await resp.json();
    var data = json.data || [];
    marketItems = data.map(function (item) {
      var en = item.i18n && item.i18n.en ? item.i18n.en : {};
      var slug = item.slug || item.url_name || '';
      return {
        id: item.id,
        slug: slug,
        name: en.name || item.item_name || item.name || safeNameFromSlug(slug),
        thumb: en.thumb || en.icon || item.thumb || item.icon || '',
        icon: en.icon || item.icon || '',
        subIcon: en.subIcon || en.sub_icon || item.subIcon || item.sub_icon || '',
        tags: item.tags || [],
        category: getMarketCategory(item.tags),
      };
    }).filter(function (item) { return !!item.slug; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
    saveMarketCache(marketItems);
  }

  function findBestOverlayMarketItem(name) {
    var cleaned = stripRewardOcrNoise(name);
    var exact = findMarketItemByName(cleaned);
    if (exact) return exact;

    var normalized = normalizeMarketName(cleaned);
    if (!normalized) return null;

    var best = null;
    var bestScore = 0;
    var compact = normalized.replace(/\s+/g, '');

    for (var i = 0; i < marketItems.length; i++) {
      var item = marketItems[i];
      var itemName = normalizeMarketName(item && item.name);
      if (!itemName) continue;
      var score = 0;
      if (itemName === normalized) {
        score = 100;
      } else if (itemName.indexOf(normalized) !== -1 || normalized.indexOf(itemName) !== -1) {
        score = 76;
      } else if (itemName.replace(/\s+/g, '') === compact) {
        score = 72;
      }

      if (score > bestScore) {
        best = item;
        bestScore = score;
      }
    }

    return bestScore >= 70 ? best : null;
  }

  function getOverlayStatsPrice(statsPayload) {
    var liveHistory = Array.isArray(statsPayload && statsPayload.statistics_live && statsPayload.statistics_live['48hours'])
      ? statsPayload.statistics_live['48hours']
      : [];
    var closedHistory = Array.isArray(statsPayload && statsPayload.statistics_closed && statsPayload.statistics_closed['90days'])
      ? statsPayload.statistics_closed['90days']
      : [];

    var latestLiveSell = getLatestEntryByType(liveHistory, 'sell');
    var latestClosed = closedHistory.length > 0 ? closedHistory[closedHistory.length - 1] : null;
    var price = getEntryPrice(latestLiveSell);
    if (isFinite(price) && price > 0) return price;

    price = getEntryPrice(latestClosed);
    if (isFinite(price) && price > 0) return price;

    return getWeightedAverage(closedHistory.slice(-7), 'wa_price');
  }

  function withOverlayPriceTimeout(promise) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('Overlay price request timed out'));
      }, OVERLAY_PRICE_REQUEST_TIMEOUT_MS);

      promise.then(function (value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }).catch(function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  function getOrderPlatNumber(order) {
    var price = Number(order && order.platinum);
    return Number.isFinite(price) && price > 0 ? price : null;
  }

  function isPcMarketOrder(order) {
    var platform = String(order && (order.platform || (order.user && order.user.platform)) || '')
      .toLowerCase()
      .replace(/[\s_-]+/g, '');
    return !platform || platform === 'pc';
  }

  function getStableOverlayOrderPrice(orders, orderType) {
    var candidates = [];
    var i;

    for (i = 0; i < orders.length; i++) {
      var order = orders[i];
      var price = getOrderPlatNumber(order);
      if (!price || !order || order.visible === false || order.order_type !== orderType || !isPcMarketOrder(order)) continue;
      candidates.push(order);
    }

    var online = candidates.filter(isOnlineSeller);
    var pool = online.length > 0 ? online : candidates;
    if (pool.length === 0) return null;

    pool.sort(function (a, b) {
      var pa = getOrderPlatNumber(a) || 0;
      var pb = getOrderPlatNumber(b) || 0;
      if (pa !== pb) return orderType === 'sell' ? pa - pb : pb - pa;
      return getStatusSortRank(a) - getStatusSortRank(b);
    });

    var prices = pool.map(getOrderPlatNumber).filter(function (price) {
      return Number.isFinite(price) && price > 0;
    });
    if (prices.length === 0) return null;

    var sampleSize = prices.length >= 5 ? 5 : (prices.length >= 3 ? 3 : 1);
    var sample = prices.slice(0, sampleSize);

    // Ignore one suspicious undercut/overbid when there are enough live orders.
    if (sample.length >= 3) {
      if (orderType === 'sell' && sample[0] < sample[1] * 0.65) {
        sample = sample.slice(1);
      } else if (orderType === 'buy' && sample[0] > sample[1] * 1.45) {
        sample = sample.slice(1);
      }
    }

    var sorted = sample.slice().sort(function (a, b) {
      return a - b;
    });
    var price = sorted[Math.floor(sorted.length / 2)];
    var matchedOrder = pool[0];
    for (i = 0; i < pool.length; i++) {
      if (getOrderPlatNumber(pool[i]) === price) {
        matchedOrder = pool[i];
        break;
      }
    }

    return {
      price: price,
      order: matchedOrder,
      orderCount: pool.length,
      onlineCount: online.length
    };
  }

  async function getOverlayLivePriceData(item) {
    var orders = await fetchOrdersV2(item.slug);
    var stableSell = getStableOverlayOrderPrice(orders, 'sell');
    var stableBuy = getStableOverlayOrderPrice(orders, 'buy');
    if (!stableSell || !Number.isFinite(Number(stableSell.price)) || Number(stableSell.price) <= 0) {
      return null;
    }

    var status = stableSell.order && stableSell.order.user ? stableSell.order.user.status : '';
    return {
      ok: true,
      name: item.name,
      slug: item.slug,
      price: Number(stableSell.price),
      sell: Number(stableSell.price),
      buy: stableBuy && Number.isFinite(Number(stableBuy.price)) ? Number(stableBuy.price) : null,
      label: formatPlatValue(stableSell.price),
      sellerStatus: status || 'online sellers',
      source: stableSell.onlineCount > 0 ? 'stable online sell orders' : 'stable visible sell orders',
      sampleCount: stableSell.orderCount
    };
  }

  async function getOverlayStatsPriceData(item) {
    var statsPayload = await fetchItemStatistics(item.slug, false);
    var statsPrice = getOverlayStatsPrice(statsPayload);
    if (!Number.isFinite(Number(statsPrice)) || Number(statsPrice) <= 0) return null;

    return {
      ok: true,
      name: item.name,
      slug: item.slug,
      price: Number(statsPrice),
      sell: Number(statsPrice),
      buy: null,
      label: formatPlatValue(statsPrice),
      sellerStatus: 'market average',
      source: 'market statistics'
    };
  }

  function cacheOverlayPrice(cacheKey, data) {
    overlayPriceCache[cacheKey] = {
      timestamp: Date.now(),
      data: data
    };
  }

  async function getOverlayPriceForItemName(name) {
    var cleaned = stripRewardOcrNoise(name);
    if (isZeroValueRelicReward(cleaned)) {
      return {
        input: name,
        ok: true,
        name: 'Forma Blueprint',
        slug: '',
        price: 0,
        sell: 0,
        buy: null,
        label: '0p',
        message: 'Not tradable on Warframe Market.'
      };
    }

    await ensureMarketItemsForOverlay();

    var item = findBestOverlayMarketItem(cleaned);
    if (!item || !item.slug) {
      return {
        input: name,
        ok: false,
        name: cleaned || name,
        price: null,
        message: 'No market listing matched.'
      };
    }

    var cacheKey = item.slug;
    var cached = overlayPriceCache[cacheKey];
    if (cached && Date.now() - cached.timestamp < OVERLAY_PRICE_CACHE_TTL) {
      return Object.assign({ input: name }, cached.data);
    }

    if (overlayPriceRequests[cacheKey]) {
      return overlayPriceRequests[cacheKey].then(function (data) {
        return Object.assign({ input: name }, data);
      });
    }

    overlayPriceRequests[cacheKey] = (async function () {
      var data = null;
      var livePricePromise = getOverlayLivePriceData(item).catch(function () {
        return null;
      });
      var statsPricePromise = getOverlayStatsPriceData(item).catch(function () {
        return null;
      });

      try {
        data = await withOverlayPriceTimeout(livePricePromise);
      } catch (err) {
        data = null;
      }

      if (!data) {
        data = await statsPricePromise;
      }

      if (!data) {
        data = {
          ok: false,
          name: item.name,
          slug: item.slug,
          price: null,
          sell: null,
          buy: null,
          label: '--',
          message: 'No usable market price found.'
        };
      }

      cacheOverlayPrice(cacheKey, data);
      return data;
    })().finally(function () {
      delete overlayPriceRequests[cacheKey];
    });

    return overlayPriceRequests[cacheKey].then(function (data) {
      return Object.assign({ input: name }, data);
    });
  }

  async function getRelicRewardOverlayPrices(names) {
    var list = Array.isArray(names) ? names : [];
    return Promise.all(list.map(async function (rawName) {
      var name = String(rawName || '').trim();
      if (!name) return null;
      try {
        return await getOverlayPriceForItemName(name);
      } catch (err) {
        return {
          input: name,
          ok: false,
          name: name,
          price: null,
          message: err && err.message ? err.message : 'Price unavailable.'
        };
      }
    })).then(function (results) {
      return results.filter(Boolean);
    });
  }

  async function warmRelicRewardOverlay() {
    try {
      await ensureMarketItemsForOverlay();
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err && err.message ? err.message : 'Market catalog unavailable.'
      };
    }
  }

  function getPriceDeltaPercent(current, baseline) {
    if (current == null || baseline == null) return null;
    var now = Number(current);
    var base = Number(baseline);
    if (!isFinite(now) || !isFinite(base) || base <= 0) return null;
    return ((now - base) / base) * 100;
  }

  function getWeekdayLabel(index) {
    return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][index] || 'Unknown';
  }

  function getHourWindowLabel(index) {
    var hour = Number(index);
    if (!isFinite(hour) || hour < 0) return 'Unknown hour';
    var start = String(hour).padStart(2, '0') + ':00';
    var endHour = (hour + 1) % 24;
    var end = String(endHour).padStart(2, '0') + ':00';
    return start + '-' + end;
  }

  function buildPriceBuckets(entries, options) {
    var config = options || {};
    var orderType = config.orderType || '';
    var mode = config.mode || 'weekday';
    var buckets = Object.create(null);

    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (!entry) continue;
      if (orderType && entry.order_type !== orderType) continue;
      var price = getEntryPrice(entry);
      if (!isFinite(price) || price <= 0) continue;
      var date = new Date(entry.datetime);
      if (isNaN(date.getTime())) continue;

      var key = mode === 'hour' ? date.getHours() : date.getDay();
      if (!buckets[key]) {
        buckets[key] = { key: key, totalPrice: 0, totalWeight: 0, volume: 0, count: 0 };
      }
      var volume = Number(entry.volume);
      var weight = isFinite(volume) && volume > 0 ? volume : 1;
      buckets[key].totalPrice += price * weight;
      buckets[key].totalWeight += weight;
      buckets[key].volume += weight;
      buckets[key].count++;
    }

    return Object.keys(buckets).map(function (key) {
      var bucket = buckets[key];
      return {
        key: Number(bucket.key),
        average: bucket.totalWeight > 0 ? bucket.totalPrice / bucket.totalWeight : null,
        volume: bucket.volume,
        count: bucket.count
      };
    }).filter(function (bucket) {
      return isFinite(bucket.average) && bucket.count > 0;
    });
  }

  function pickPriceBucket(entries, options) {
    var buckets = buildPriceBuckets(entries, options);
    if (!buckets.length) return null;
    var prefer = options && options.prefer === 'high' ? 'high' : 'low';
    buckets.sort(function (a, b) {
      if (prefer === 'high') return b.average - a.average;
      return a.average - b.average;
    });
    return buckets[0] || null;
  }

  function formatBucketLabel(bucket, mode) {
    if (!bucket) return 'Not enough data';
    return mode === 'hour' ? getHourWindowLabel(bucket.key) : getWeekdayLabel(bucket.key);
  }

  function countOrdersNearPrice(orders, orderType, price, tolerance) {
    var base = Number(price);
    if (!Array.isArray(orders) || !isFinite(base) || base <= 0) {
      return { count: 0, quantity: 0 };
    }

    var count = 0;
    var quantity = 0;
    for (var i = 0; i < orders.length; i++) {
      var order = orders[i];
      if (!order || order.visible === false || order.order_type !== orderType) continue;
      var platinum = Number(order.platinum);
      if (!isFinite(platinum) || platinum <= 0) continue;
      var inRange = orderType === 'sell'
        ? platinum <= base * (1 + tolerance)
        : platinum >= base * (1 - tolerance);
      if (!inRange) continue;
      count++;
      var orderQty = Number(order.quantity);
      quantity += isFinite(orderQty) && orderQty > 0 ? orderQty : 1;
    }

    return { count: count, quantity: quantity };
  }

  function getLiquidityProfile(model) {
    var orders = model.visibleSellOrders.length + model.visibleBuyOrders.length;
    var volume7 = Number(model.volume7 || 0);
    if (volume7 >= 60 || orders >= 45) {
      return { label: 'High liquidity', risk: 'Low risk', detail: 'Plenty of recent volume and live orders, so price checks are more reliable.' };
    }
    if (volume7 >= 18 || orders >= 16) {
      return { label: 'Medium liquidity', risk: 'Medium risk', detail: 'Usable market depth, but check current orders before committing.' };
    }
    return { label: 'Thin market', risk: 'High risk', detail: 'Few trades or live orders. Prices can jump quickly and stale listings matter more.' };
  }

  function getSignalLabel(score, good, neutral, weak) {
    if (score >= 70) return good;
    if (score >= 45) return neutral;
    return weak;
  }

  function buildTimingInsights(model) {
    var currentSell = model.bestSell ? Number(model.bestSell.platinum) : null;
    var currentBuy = model.bestBuy ? Number(model.bestBuy.platinum) : null;
    var discountVs30 = getPriceDeltaPercent(currentSell, model.avg30);
    var buyOrderVs30 = getPriceDeltaPercent(currentBuy, model.avg30);
    var trendPercent = getPriceDeltaPercent(model.avg7, model.avg30);
    var spreadPercent = model.bestSell && model.bestBuy
      ? getPriceDeltaPercent(model.bestSell.platinum, model.bestBuy.platinum)
      : null;

    var buyScore = 50;
    if (discountVs30 !== null) buyScore += -discountVs30 * 2.2;
    if (trendPercent !== null) buyScore += -trendPercent * 0.9;
    if (spreadPercent !== null && spreadPercent > 35) buyScore -= 8;
    if (model.visibleSellOrders.length < 4) buyScore -= 10;
    if (model.volume7 >= 25) buyScore += 6;
    buyScore = clampNumber(buyScore, 0, 100);

    var sellScore = 50;
    if (buyOrderVs30 !== null) sellScore += buyOrderVs30 * 2.2;
    if (trendPercent !== null) sellScore += trendPercent * 0.9;
    if (model.visibleBuyOrders.length < 4) sellScore -= 10;
    if (model.volume7 >= 25) sellScore += 6;
    sellScore = clampNumber(sellScore, 0, 100);

    var bestBuyDay = pickPriceBucket(model.closedHistory, { mode: 'weekday', prefer: 'low' });
    var bestSellDay = pickPriceBucket(model.closedHistory, { mode: 'weekday', prefer: 'high' });
    var bestBuyHour = pickPriceBucket(model.liveHistory, { mode: 'hour', orderType: 'sell', prefer: 'low' });
    var bestSellHour = pickPriceBucket(model.liveHistory, { mode: 'hour', orderType: 'buy', prefer: 'high' });
    var sellWall = countOrdersNearPrice(model.visibleSellOrders, 'sell', currentSell, 0.05);
    var buyWall = countOrdersNearPrice(model.visibleBuyOrders, 'buy', currentBuy, 0.05);
    var liquidity = getLiquidityProfile(model);
    var fairValue = getFairValue(model);
    var askVsFair = getPriceDeltaPercent(currentSell, fairValue);
    var bidVsFair = getPriceDeltaPercent(currentBuy, fairValue);
    var orderPressure = model.visibleBuyOrders.length - model.visibleSellOrders.length;
    var demandRatio = model.visibleSellOrders.length > 0
      ? model.visibleBuyOrders.length / model.visibleSellOrders.length
      : (model.visibleBuyOrders.length > 0 ? 99 : 0);
    var pressureLabel = 'Balanced market';
    if (demandRatio >= 1.35 || orderPressure >= 8) {
      pressureLabel = 'Buyer pressure';
    } else if (demandRatio <= 0.65 || orderPressure <= -8) {
      pressureLabel = 'Seller pressure';
    }
    var quickFlipMargin = currentBuy !== null && currentSell !== null ? currentBuy - currentSell : null;
    var confidenceScore = getMarketConfidence(model, { spreadPercent: spreadPercent });

    return {
      buyScore: buyScore,
      sellScore: sellScore,
      confidenceScore: confidenceScore,
      buyLabel: getSignalLabel(buyScore, 'Buy the dip', 'Watch for entry', 'Wait for cheaper'),
      sellLabel: getSignalLabel(sellScore, 'Sell into strength', 'List patiently', 'Hold or undercut'),
      discountVs30: discountVs30,
      buyOrderVs30: buyOrderVs30,
      trendPercent: trendPercent,
      spreadPercent: spreadPercent,
      askVsFair: askVsFair,
      bidVsFair: bidVsFair,
      fairValue: fairValue,
      pressureLabel: pressureLabel,
      demandRatio: demandRatio,
      quickFlipMargin: quickFlipMargin,
      bestBuyDay: bestBuyDay,
      bestSellDay: bestSellDay,
      bestBuyHour: bestBuyHour,
      bestSellHour: bestSellHour,
      sellWall: sellWall,
      buyWall: buyWall,
      liquidity: liquidity
    };
  }

  function getAnalyticsQuickPickItems() {
    var picks = [];
    var seen = Object.create(null);
    var i;

    for (i = 0; i < ANALYTICS_DEFAULT_PICK_NAMES.length; i++) {
      var exact = findMarketItemByName(ANALYTICS_DEFAULT_PICK_NAMES[i]);
      if (exact && !seen[exact.slug]) {
        seen[exact.slug] = true;
        picks.push(exact);
      }
    }

    if (picks.length >= 8) return picks.slice(0, 8);

    var preferredCategories = ['prime', 'arcanes', 'mods', 'weapons', 'resources'];
    for (i = 0; i < marketItems.length; i++) {
      var item = marketItems[i];
      if (!item || seen[item.slug]) continue;
      if (preferredCategories.indexOf(item.category) === -1) continue;
      seen[item.slug] = true;
      picks.push(item);
      if (picks.length >= 8) break;
    }

    return picks.slice(0, 8);
  }

  function getAnalyticsSearchResults() {
    var query = normalizeMarketName(analyticsSearchQuery);
    if (!query) return getAnalyticsQuickPickItems();

    return marketItems
      .map(function (item) {
        var normalized = normalizeMarketName(item.name);
        var index = normalized.indexOf(query);
        return {
          item: item,
          score: index === -1 ? Number.MAX_SAFE_INTEGER : index,
          normalized: normalized
        };
      })
      .filter(function (entry) { return entry.score !== Number.MAX_SAFE_INTEGER; })
      .sort(function (a, b) {
        if (a.score !== b.score) return a.score - b.score;
        if (a.normalized.length !== b.normalized.length) return a.normalized.length - b.normalized.length;
        return a.item.name.localeCompare(b.item.name);
      })
      .slice(0, 12)
      .map(function (entry) { return entry.item; });
  }

  function createAnalyticsPlaceholder(text) {
    var el = document.createElement('div');
    el.className = 'trade-analytics-empty-message';
    el.textContent = text;
    return el;
  }

  function saveContractsLookupCache(data) {
    try {
      localStorage.setItem(CONTRACTS_LOOKUP_CACHE_KEY, JSON.stringify({
        timestamp: Date.now(),
        data: data
      }));
    } catch (e) { /* ignore quota */ }
  }

  function loadContractsLookupCache() {
    try {
      var raw = localStorage.getItem(CONTRACTS_LOOKUP_CACHE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.data) return null;
      if (Date.now() - parsed.timestamp > CONTRACTS_LOOKUP_CACHE_TTL) return null;
      return parsed.data;
    } catch (e) {
      return null;
    }
  }

  function sortLookupList(items, labelKey) {
    return items.slice().sort(function (a, b) {
      return String(a[labelKey] || '').localeCompare(String(b[labelKey] || ''));
    });
  }

  function normalizeContractsLookups(state) {
    var riven = state && state.riven ? state.riven : {};
    var lich = state && state.lich ? state.lich : {};
    var sister = state && state.sister ? state.sister : {};

    return {
      rivenWeapons: sortLookupList((Array.isArray(riven.items) ? riven.items : []).map(function (item) {
        return {
          name: item.item_name || '',
          urlName: item.url_name || '',
          icon: item.icon || item.thumb || '',
          thumb: item.thumb || item.icon || '',
          rivenType: item.riven_type || '',
          group: item.group || '',
          masteryLevel: typeof item.mastery_level === 'number' ? item.mastery_level : 0
        };
      }).filter(function (item) { return !!item.urlName; }), 'name'),
      rivenAttributes: sortLookupList((Array.isArray(riven.attributes) ? riven.attributes : []).map(function (item) {
        return {
          name: item.effect || '',
          urlName: item.url_name || '',
          units: item.units || '',
          exclusiveTo: Array.isArray(item.exclusive_to) ? item.exclusive_to.slice() : [],
          positiveOnly: !!item.positive_only,
          negativeOnly: !!item.negative_only,
          searchOnly: !!item.search_only
        };
      }).filter(function (item) { return !!item.urlName; }), 'name'),
      lichWeapons: sortLookupList((Array.isArray(lich.weapons) ? lich.weapons : []).map(function (item) {
        return {
          name: item.item_name || '',
          urlName: item.url_name || '',
          icon: item.icon || item.thumb || '',
          thumb: item.thumb || item.icon || ''
        };
      }).filter(function (item) { return !!item.urlName; }), 'name'),
      lichEphemeras: sortLookupList((Array.isArray(lich.ephemeras) ? lich.ephemeras : []).map(function (item) {
        return {
          name: item.item_name || '',
          urlName: item.url_name || '',
          icon: item.icon || item.thumb || '',
          thumb: item.thumb || item.icon || '',
          element: item.element || ''
        };
      }).filter(function (item) { return !!item.urlName; }), 'name'),
      sisterWeapons: sortLookupList((Array.isArray(sister.weapons) ? sister.weapons : []).map(function (item) {
        return {
          name: item.item_name || '',
          urlName: item.url_name || '',
          icon: item.icon || item.thumb || '',
          thumb: item.thumb || item.icon || ''
        };
      }).filter(function (item) { return !!item.urlName; }), 'name'),
      sisterEphemeras: sortLookupList((Array.isArray(sister.ephemeras) ? sister.ephemeras : []).map(function (item) {
        return {
          name: item.item_name || '',
          urlName: item.url_name || '',
          icon: item.icon || item.thumb || '',
          thumb: item.thumb || item.icon || '',
          element: item.element || ''
        };
      }).filter(function (item) { return !!item.urlName; }), 'name')
    };
  }

  // Crossplay is absent by default server-side, so omitting it silently drops
  // every crossplay order from the results.
  function contractsApiHeaders() {
    return { Platform: 'pc', Language: 'en', Crossplay: 'true' };
  }

  async function fetchContractsJson(url) {
    var resp = await fetch(url, { headers: contractsApiHeaders() });
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' from ' + url.replace('https://api.warframe.market', ''));
    return resp.json();
  }

  /**
   * Riven weapons come from the public v2 endpoint.
   *
   * The previous bootstrap scraped the warframe.market website HTML for an
   * embedded `application-state` script. That is Cloudflare-protected and answers
   * HTTP 403 to a plain fetch, so `contractsLookupError` was always set and
   * renderContractsView() bailed out before rendering a single filter - the tab
   * was unusable even though the actual contract data path worked fine.
   */
  async function fetchRivenWeaponsLookup() {
    var json = await fetchContractsJson(RIVEN_WEAPONS_API);
    var list = Array.isArray(json && json.data) ? json.data : [];
    return list.map(function (entry) {
      var en = entry && entry.i18n && entry.i18n.en ? entry.i18n.en : {};
      return {
        name: en.name || entry.name || safeNameFromSlug(entry.slug || ''),
        urlName: entry.slug || entry.url_name || '',
        icon: en.icon || entry.icon || '',
        thumb: en.thumb || en.thumb || entry.thumb || '',
        rivenType: entry.riven_type || '',
        group: entry.group || '',
        masteryLevel: typeof entry.mastery_level === 'number' ? entry.mastery_level : 0
      };
    }).filter(function (entry) { return !!entry.urlName; });
  }

  /**
   * Riven attributes from the public v2 endpoint (32 entries, verified).
   *
   * The endpoint carries no polarity flag, so positive/negative are left false
   * and every attribute is offered in both dropdowns. That is deliberate: the
   * real check happens in wfm-contracts.js against the live order's attributes,
   * so a stat that can never appear as a bonus simply matches nothing. Hiding
   * options from a hardcoded list would have been the guessier failure.
   */
  async function fetchRivenAttributesLookup() {
    var json = await fetchContractsJson(RIVEN_ATTRIBUTES_API);
    var list = Array.isArray(json && json.data) ? json.data : [];
    return list.map(function (entry) {
      var en = entry && entry.i18n && entry.i18n.en ? entry.i18n.en : {};
      return {
        name: en.name || entry.name || safeNameFromSlug(entry.slug || ''),
        urlName: entry.slug || entry.url_name || '',
        units: entry.unit || '',
        exclusiveTo: [],
        positiveOnly: false,
        negativeOnly: false,
        searchOnly: false
      };
    }).filter(function (entry) { return !!entry.urlName; });
  }

  /**
   * Lich and Sister filter options, derived from the live contracts feed.
   *
   * There is no public endpoint for these lists (/v2/lich and /v2/sister are
   * 404, /v1/items?type=lich is 403), and the feed is dominated by rivens: page 1
   * held 99 riven and 1 lich order. So the weapon list is only what recent pages
   * have actually shown. The UI labels it as such and keeps free-text search as
   * the reliable route, rather than implying the list is complete.
   *
   * The feed exposes `having_ephemera` as a boolean and no ephemera name, which
   * is why there is no per-ephemera dropdown for these types.
   */
  async function fetchContractFeedLookups() {
    var weapons = { lich: [], sister: [] };
    var elements = [];
    var seenWeapon = { lich: {}, sister: {} };
    var seenElement = {};

    for (var page = 1; page <= 4; page++) {
      var json;
      try {
        json = await fetchContractsJson(CONTRACT_FEED_API + '?page=' + page);
      } catch (err) {
        // A partial walk still beats none; the first page is the valuable one.
        break;
      }
      var orders = json && json.payload && Array.isArray(json.payload.auctions) ? json.payload.auctions : [];
      if (orders.length === 0) break;

      for (var i = 0; i < orders.length; i++) {
        var item = (orders[i] && orders[i].item) || {};
        if (item.type !== 'lich' && item.type !== 'sister') continue;

        var urlName = item.weapon_url_name || '';
        if (urlName && !seenWeapon[item.type][urlName]) {
          seenWeapon[item.type][urlName] = true;
          weapons[item.type].push({
            name: safeNameFromSlug(urlName),
            urlName: urlName,
            icon: '',
            thumb: ''
          });
        }

        var element = String(item.element || '').trim();
        if (element && !seenElement[element]) {
          seenElement[element] = true;
          elements.push(element);
        }
      }
    }

    return {
      lichWeapons: sortLookupList(weapons.lich, 'name'),
      sisterWeapons: sortLookupList(weapons.sister, 'name'),
      elements: elements.sort()
    };
  }

  async function ensureContractsLookupData() {
    if (contractsLookupData) return contractsLookupData;
    if (contractsLookupPromise) return contractsLookupPromise;

    var cached = loadContractsLookupCache();
    if (cached) {
      contractsLookupData = cached;
      contractsLookupError = '';
      return contractsLookupData;
    }

    contractsLookupPromise = Promise.all([
      fetchRivenWeaponsLookup(),
      fetchRivenAttributesLookup(),
      fetchContractFeedLookups()
    ]).then(function (parts) {
      contractsLookupData = {
        rivenWeapons: sortLookupList(parts[0], 'name'),
        rivenAttributes: sortLookupList(parts[1], 'name'),
        lichWeapons: parts[2].lichWeapons,
        sisterWeapons: parts[2].sisterWeapons,
        contractElements: parts[2].elements,
        // Kept so the whisper builder's ephemera lookup cannot throw on a
        // cached payload written before these keys existed.
        lichEphemeras: [],
        sisterEphemeras: []
      };
      contractsLookupError = '';
      saveContractsLookupCache(contractsLookupData);
      return contractsLookupData;
    }).catch(function (err) {
      contractsLookupError = err && err.message ? err.message : 'Failed to load contracts';
      throw err;
    }).finally(function () {
      contractsLookupPromise = null;
    });

    return contractsLookupPromise;
  }

  function findLookupByUrl(list, urlName) {
    if (!Array.isArray(list)) return null;

    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].urlName === urlName) {
        return list[i];
      }
    }

    return null;
  }

  function getContractsWeaponOptions() {
    if (!contractsLookupData) return [];
    if (contractsFilters.type === 'riven') return contractsLookupData.rivenWeapons;
    if (contractsFilters.type === 'lich') return contractsLookupData.lichWeapons;
    return contractsLookupData.sisterWeapons;
  }

  function getContractsEphemeraOptions() {
    if (!contractsLookupData) return [];
    return contractsFilters.type === 'lich' ? contractsLookupData.lichEphemeras : contractsLookupData.sisterEphemeras;
  }

  /**
   * True when the selected contract type can offer per-ephemera filtering.
   *
   * The live feed carries `having_ephemera` as a boolean and never names the
   * ephemera, so there is nothing to populate a per-ephemera list with. The
   * boolean "Has Any Ephemera" filter still works and is offered instead.
   */
  function contractsSupportsEphemeraList() {
    return getContractsEphemeraOptions().length > 0;
  }

  function getRivenAttributeOptions(negative) {
    if (!contractsLookupData) return [];

    var selectedWeapon = findLookupByUrl(contractsLookupData.rivenWeapons, contractsFilters.weaponUrlName);
    var rivenType = selectedWeapon ? selectedWeapon.rivenType : '';

    return contractsLookupData.rivenAttributes.filter(function (attr) {
      if (!attr || attr.searchOnly) return false;
      if (negative && attr.positiveOnly) return false;
      if (!negative && attr.negativeOnly) return false;
      if (!rivenType || !Array.isArray(attr.exclusiveTo) || attr.exclusiveTo.length === 0) return true;
      return attr.exclusiveTo.indexOf(rivenType) !== -1;
    });
  }

  function getContractElementOptions() {
    var seen = Object.create(null);
    var out = [];

    function add(element) {
      var key = String(element || '').trim();
      if (!key || seen[key]) return;
      seen[key] = true;
      out.push({
        value: key,
        label: key.charAt(0).toUpperCase() + key.slice(1)
      });
    }

    // Elements observed on live lich/sister orders. Previously these were
    // derived from the ephemera list, which is now empty, so the feed is the
    // source instead - otherwise the element dropdown rendered with no options.
    var observed = contractsLookupData && Array.isArray(contractsLookupData.contractElements)
      ? contractsLookupData.contractElements
      : [];
    for (var o = 0; o < observed.length; o++) add(observed[o]);

    var ephemeras = getContractsEphemeraOptions();
    for (var i = 0; i < ephemeras.length; i++) add(ephemeras[i].element);

    return out.sort(function (a, b) { return a.label.localeCompare(b.label); });
  }

  function formatContractTypeLabel(type) {
    if (type === 'lich') return 'Kuva Lich';
    if (type === 'sister') return 'Sister Of Parvos';
    return 'Riven Mod';
  }

  function formatRelativeTime(value) {
    if (!value) return 'just now';
    var date = new Date(value);
    if (isNaN(date.getTime())) return 'just now';

    var diffMs = Date.now() - date.getTime();
    var diffMinutes = Math.max(0, Math.round(diffMs / 60000));
    if (diffMinutes < 1) return 'just now';
    if (diffMinutes < 60) return diffMinutes + 'm ago';

    var diffHours = Math.round(diffMinutes / 60);
    if (diffHours < 24) return diffHours + 'h ago';

    var diffDays = Math.round(diffHours / 24);
    if (diffDays < 7) return diffDays + 'd ago';

    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric'
    });
  }

  function formatContractAttributeValue(attribute, lookup) {
    var value = Number(attribute && attribute.value);
    if (!isFinite(value)) return '';

    var absValue = Math.abs(value);
    var prefix = value > 0 ? '+' : '-';
    var units = lookup && lookup.units ? lookup.units : '';
    var rendered = absValue % 1 === 0 ? absValue.toFixed(0) : absValue.toFixed(1);

    if (units === 'percent') return prefix + rendered + '%';
    if (units === 'multiply') return prefix + rendered + 'x';
    if (units === 'seconds') return prefix + rendered + 's';
    if (units === 'degrees') return prefix + rendered + 'deg';
    return prefix + rendered;
  }

  function getAuctionSearchText(auction) {
    var owner = auction && auction.owner ? auction.owner : {};
    var item = auction && auction.item ? auction.item : {};
    var searchParts = [
      wfmIngameName(owner),
      item.name,
      item.weapon_url_name,
      item.element,
      auction.note_raw
    ];

    if (Array.isArray(item.attributes)) {
      for (var i = 0; i < item.attributes.length; i++) {
        searchParts.push(item.attributes[i] && item.attributes[i].url_name ? item.attributes[i].url_name : '');
      }
    }

    return searchParts.join(' ').toLowerCase();
  }

  function getFilteredContractsResults() {
    var quickSearch = String(contractsFilters.quickSearch || '').toLowerCase().trim();
    var results = contractsResults.slice();

    if (quickSearch) {
      results = results.filter(function (auction) {
        return getAuctionSearchText(auction).indexOf(quickSearch) !== -1;
      });
    }

    results.sort(function (a, b) {
      // Price comes from buyout_price, else the current top bid. starting_price is
      // an opening floor rather than an offer, and bid-only auctions have it set to
      // 1, so using it here made unfilled auctions sort as if they cost 1 platinum.
      var aPrice = WfmContracts.orderPrice(a);
      var bPrice = WfmContracts.orderPrice(b);
      if (aPrice === null) return bPrice === null ? 0 : 1;
      if (bPrice === null) return -1;

      if (contractsFilters.sortBy === 'price_desc') {
        return bPrice - aPrice;
      }

      if (contractsFilters.sortBy === 'created_desc') {
        return new Date(b.created || 0).getTime() - new Date(a.created || 0).getTime();
      }

      return aPrice - bPrice;
    });

    return results;
  }

  function canSearchContracts() {
    if (contractsFilters.type === 'riven') return !!contractsFilters.weaponUrlName;
    if (contractsFilters.weaponUrlName) return true;
    if (contractsFilters.element) return true;
    if (contractsFilters.ephemera && contractsFilters.ephemera !== CONTRACT_ANY_EPHEMERA_VALUE) return true;
    return false;
  }

  async function searchContracts() {
    contractsError = '';
    contractsCoverageNote = '';

    if (!canSearchContracts()) {
      contractsResults = [];
      contractsHasSearched = false;
      contractsVisibleCount = CONTRACT_RESULTS_BATCH_SIZE;
      renderContractsView();
      return;
    }

    contractsLoading = true;
    contractsHasSearched = true;
    contractsVisibleCount = CONTRACT_RESULTS_BATCH_SIZE;
    renderContractsView();

    var requestToken = ++contractsRequestToken;
    try {
      // The live search endpoint rejects every filter combination, so the query
      // string is translated into a local filter over the public contracts feed.
      // Orders come back raw, in the shape this renderer already consumes.
      var selectedEphemera = findLookupByUrl(getContractsEphemeraOptions(), contractsFilters.ephemera);
      var elementFilter = contractsFilters.element;
      if (selectedEphemera && selectedEphemera.element) elementFilter = selectedEphemera.element;

      var filters = {
        type: contractsFilters.type,
        weaponUrlName: contractsFilters.weaponUrlName || '',
        modRank: contractsFilters.modRank === 'maxed' ? 'maxed' : '',
        element: elementFilter || '',
        hasEphemera: contractsFilters.ephemera === CONTRACT_ANY_EPHEMERA_VALUE || !!selectedEphemera,
        positiveStats: contractsFilters.type === 'riven' ? contractsFilters.positiveStats : [],
        negativeStat: contractsFilters.type === 'riven' ? (contractsFilters.negativeStat || '') : ''
      };

      var found = await WfmContracts.findContracts(filters, {
        maxPages: WfmContracts.DEFAULT_MAX_PAGES,
        wantCount: WfmContracts.DEFAULT_WANT_COUNT
      });

      if (requestToken !== contractsRequestToken) return;

      contractsResults = found.orders;
      contractsCoverageNote = found.note;
      contractsError = '';
    } catch (err) {
      if (requestToken !== contractsRequestToken) return;
      contractsResults = [];
      contractsCoverageNote = '';
      contractsError = err && err.message ? err.message : 'Failed to load contracts';
    } finally {
      if (requestToken === contractsRequestToken) {
        contractsLoading = false;
        renderContractsView();
      }
    }
  }

  function buildOptionsMarkup(options, selectedValue, emptyLabel) {
    var html = '';
    if (typeof emptyLabel === 'string') {
      html += '<option value="">' + escapeHtml(emptyLabel) + '</option>';
    }

    for (var i = 0; i < options.length; i++) {
      var option = options[i];
      var value = option.value;
      var selected = selectedValue === value ? ' selected' : '';
      html += '<option value="' + escapeHtml(value) + '"' + selected + '>' + escapeHtml(option.label) + '</option>';
    }

    return html;
  }

  function getContractsSummaryText() {
    if (contractsLoading) return 'Live Search';
    if (contractsFilters.type === 'riven') return 'Rivens';
    if (contractsFilters.type === 'lich') return 'Kuva Liches';
    return 'Sisters';
  }

  function getContractsSearchHint() {
    if (contractsFilters.type === 'riven') {
      return 'Pick a weapon first, then narrow with positive or negative stats.';
    }

    return 'Search by weapon, by element, by ephemera, or combine them for tighter results.';
  }

  function getContractsResultsTitle() {
    if (contractsFilters.type === 'riven') return 'Riven Contracts';
    if (contractsFilters.type === 'lich') return 'Kuva Lich Contracts';
    return 'Sister Contracts';
  }

  function getContractsResultsSubtext(filteredResults) {
    if (!canSearchContracts()) return 'Choose your filters above to load live warframe.market contracts.';
    if (contractsLoading) return 'Searching live warframe.market auctions...';
    if (contractsError) return 'Search unavailable right now.';
    if (!contractsHasSearched) return 'Press Search Contracts to load live listings for the current filters.';

    var total = filteredResults.length;
    if (total === 0) return 'No matching contracts were found for the current filters.';

    var rendered = Math.min(total, contractsVisibleCount);
    return 'Showing ' + rendered + ' of ' + total + ' matching contracts.';
  }

  function renderContractsView() {
    var refs = getMarketPanelRefs();
    if (!refs.contractsView) return;

    updateMarketPanelHeader();

    if (contractsLookupError && !contractsLookupData) {
      refs.contractsView.innerHTML = '' +
        '<div class="contracts-results-shell">' +
        '<div class="contracts-empty">' +
        '<h3 class="contracts-empty-title">Contracts unavailable</h3>' +
        '<p class="contracts-empty-copy">' + escapeHtml(contractsLookupError) + '</p>' +
        '</div>' +
        '</div>';
      return;
    }

    if (!contractsLookupData && contractsLookupPromise) {
      refs.contractsView.innerHTML = '' +
        '<div class="contracts-results-shell">' +
        '<div class="contracts-loading">' +
        '<h3 class="contracts-loading-title">Loading contracts</h3>' +
        '<p class="contracts-loading-copy">Fetching the live Riven, Lich, Sister, weapon, and ephemera lists from warframe.market.</p>' +
        '</div>' +
        '</div>';
      return;
    }

    var weaponOptions = getContractsWeaponOptions().map(function (item) {
      return { value: item.urlName, label: item.name };
    });
    var elementOptions = getContractElementOptions();
    var namedEphemeras = getContractsEphemeraOptions().map(function (item) {
      return { value: item.urlName, label: item.name };
    });
    // "Has Any Ephemera" is always offered because it is the only ephemera
    // filter the live feed can answer. Named entries are prepended only when a
    // real list exists, so the option is not a dead end.
    var ephemeraOptions = contractsSupportsEphemeraList()
      ? [{ value: CONTRACT_ANY_EPHEMERA_VALUE, label: 'Has Any Ephemera' }].concat(namedEphemeras)
      : [{ value: CONTRACT_ANY_EPHEMERA_VALUE, label: 'Has Any Ephemera' }];

    var positiveOptions = getRivenAttributeOptions(false).map(function (item) {
      return { value: item.urlName, label: item.name };
    });
    var negativeOptions = getRivenAttributeOptions(true).map(function (item) {
      return { value: item.urlName, label: item.name };
    });

    refs.contractsView.innerHTML = '' +
      '<section class="contracts-hero">' +
      '<div class="contracts-hero-top">' +
      '<div>' +
      '<div class="contracts-eyebrow">Warframe Market</div>' +
      '<h2 class="contracts-title">Contracts</h2>' +
      '<p class="contracts-subtitle">Browse live Rivens, Kuva Liches, and Sisters of Parvos with fast filters for weapon, ephemera, element, and attribute combinations.</p>' +
      '</div>' +
      '<div class="contracts-summary-badge"><span class="material-icons-round">hub</span>' + escapeHtml(getContractsSummaryText()) + '</div>' +
      '</div>' +
      '<div class="contracts-type-switch">' +
      '<button class="contracts-type-btn' + (contractsFilters.type === 'riven' ? ' active' : '') + '" type="button" data-contract-type="riven">Rivens</button>' +
      '<button class="contracts-type-btn' + (contractsFilters.type === 'lich' ? ' active' : '') + '" type="button" data-contract-type="lich">Kuva Liches</button>' +
      '<button class="contracts-type-btn' + (contractsFilters.type === 'sister' ? ' active' : '') + '" type="button" data-contract-type="sister">Sisters</button>' +
      '</div>' +
      '<div class="contracts-filter-grid">' +
      '<label class="contracts-field">' +
      '<span class="contracts-field-label">Weapon</span>' +
      '<select class="contracts-select" id="contracts-weapon-select">' +
      buildOptionsMarkup(weaponOptions, contractsFilters.weaponUrlName, 'Any weapon') +
      '</select>' +
      '</label>' +
      (contractsFilters.type === 'riven'
        ? (
          '<label class="contracts-field"><span class="contracts-field-label">Positive 1</span><select class="contracts-select" id="contracts-positive-0">' + buildOptionsMarkup(positiveOptions, contractsFilters.positiveStats[0], 'Any positive stat') + '</select></label>' +
          '<label class="contracts-field"><span class="contracts-field-label">Positive 2</span><select class="contracts-select" id="contracts-positive-1">' + buildOptionsMarkup(positiveOptions, contractsFilters.positiveStats[1], 'Any positive stat') + '</select></label>' +
          '<label class="contracts-field"><span class="contracts-field-label">Positive 3</span><select class="contracts-select" id="contracts-positive-2">' + buildOptionsMarkup(positiveOptions, contractsFilters.positiveStats[2], 'Any positive stat') + '</select></label>' +
          '<label class="contracts-field"><span class="contracts-field-label">Negative</span><select class="contracts-select" id="contracts-negative-select">' + buildOptionsMarkup(negativeOptions, contractsFilters.negativeStat, 'No preference') + '</select></label>' +
          '<label class="contracts-field"><span class="contracts-field-label">Rank</span><select class="contracts-select" id="contracts-rank-select"><option value="any"' + (contractsFilters.modRank === 'any' ? ' selected' : '') + '>Any rank</option><option value="maxed"' + (contractsFilters.modRank === 'maxed' ? ' selected' : '') + '>Maxed only</option></select></label>'
        )
        : (
          '<label class="contracts-field"><span class="contracts-field-label">Element</span><select class="contracts-select" id="contracts-element-select">' + buildOptionsMarkup(elementOptions, contractsFilters.element, 'Any element') + '</select></label>' +
          // The feed reports having_ephemera as a boolean and never names the
          // ephemera, so ephemeraOptions is normally just "Has Any Ephemera" -
          // the one ephemera filter the data can actually answer.
          '<label class="contracts-field"><span class="contracts-field-label">Ephemera</span><select class="contracts-select" id="contracts-ephemera-select">' + buildOptionsMarkup(ephemeraOptions, contractsFilters.ephemera, 'Any ephemera') + '</select></label>'
        )
      ) +
      '<label class="contracts-field"><span class="contracts-field-label">Sort</span><select class="contracts-select" id="contracts-sort-select"><option value="price_asc"' + (contractsFilters.sortBy === 'price_asc' ? ' selected' : '') + '>Price ascending</option><option value="price_desc"' + (contractsFilters.sortBy === 'price_desc' ? ' selected' : '') + '>Price descending</option><option value="created_desc"' + (contractsFilters.sortBy === 'created_desc' ? ' selected' : '') + '>Most recent</option></select></label>' +
      '<label class="contracts-field"><span class="contracts-field-label">Search Loaded Results</span><input class="contracts-control" id="contracts-quick-search" type="text" value="' + escapeHtml(contractsFilters.quickSearch) + '" placeholder="Seller, weapon, stat, note..."></label>' +
      '</div>' +
      '<div class="contracts-filter-actions">' +
      '<button class="btn btn-primary" id="contracts-apply-btn" type="button">Search Contracts</button>' +
      '<button class="btn btn-secondary" id="contracts-reset-btn" type="button">Reset Filters</button>' +
      '<span class="contracts-results-helper">' + escapeHtml(getContractsSearchHint()) + '</span>' +
      '</div>' +
      '</section>' +
      '<section class="contracts-results-shell">' +
      '<div class="contracts-results-head">' +
      '<div>' +
      '<h3 class="contracts-results-title">' + escapeHtml(getContractsResultsTitle()) + '</h3>' +
      '<div class="contracts-results-sub">' + escapeHtml(getContractsResultsSubtext(getFilteredContractsResults())) + '</div>' +
      '</div>' +
      '</div>' +
      '<div class="contracts-results" id="contracts-results-list"></div>' +
      '</section>';

    renderContractsResultsList($('#contracts-results-list'));
  }

  function renderContractsResultsList(listEl) {
    if (!listEl) return;
    listEl.textContent = '';

    if (contractsLoading) {
      var loadingEl = document.createElement('div');
      loadingEl.className = 'contracts-loading';
      loadingEl.innerHTML = '<h3 class="contracts-loading-title">Searching contracts</h3><p class="contracts-loading-copy">Pulling the latest live auctions from warframe.market.</p>';
      listEl.appendChild(loadingEl);
      return;
    }

    if (contractsError) {
      var errorEl = document.createElement('div');
      errorEl.className = 'contracts-empty';
      errorEl.innerHTML = '<h3 class="contracts-empty-title">Search failed</h3><p class="contracts-empty-copy">' + escapeHtml(contractsError) + '</p>';
      listEl.appendChild(errorEl);
      return;
    }

    if (!canSearchContracts()) {
      var promptEl = document.createElement('div');
      promptEl.className = 'contracts-empty';
      promptEl.innerHTML = '<h3 class="contracts-empty-title">Choose your filters</h3><p class="contracts-empty-copy">' + escapeHtml(getContractsSearchHint()) + '</p>';
      listEl.appendChild(promptEl);
      return;
    }

    if (!contractsHasSearched) {
      var readyEl = document.createElement('div');
      readyEl.className = 'contracts-empty';
      readyEl.innerHTML = '<h3 class="contracts-empty-title">Search is ready</h3><p class="contracts-empty-copy">Press Search Contracts to load live results for the current filters.</p>';
      listEl.appendChild(readyEl);
      return;
    }

    var filteredResults = getFilteredContractsResults();
    if (filteredResults.length === 0) {
      var emptyEl = document.createElement('div');
      emptyEl.className = 'contracts-empty';

      // An empty result means "none in the window we walked", which is not the same
      // as "none exist". The coverage note carries the distinction.
      var emptyCopy = contractsCoverageNote
        ? escapeHtml(contractsCoverageNote)
        : 'Try another weapon, relax one stat filter, or switch the contract type.';

      emptyEl.innerHTML = '<h3 class="contracts-empty-title">No contracts found</h3><p class="contracts-empty-copy">' + emptyCopy + '</p>';
      listEl.appendChild(emptyEl);
      return;
    }

    var fragment = document.createDocumentFragment();

    if (contractsCoverageNote) {
      var coverage = document.createElement('p');
      coverage.className = 'contracts-coverage-note';
      coverage.textContent = contractsCoverageNote;
      fragment.appendChild(coverage);
    }

    var limit = Math.min(filteredResults.length, contractsVisibleCount);
    for (var i = 0; i < limit; i++) {
      fragment.appendChild(createContractCard(filteredResults[i]));
    }

    listEl.appendChild(fragment);

    if (filteredResults.length > contractsVisibleCount) {
      var moreWrap = document.createElement('div');
      moreWrap.className = 'contracts-more';
      var moreBtn = document.createElement('button');
      moreBtn.className = 'btn btn-secondary';
      moreBtn.type = 'button';
      moreBtn.id = 'contracts-load-more-btn';
      moreBtn.textContent = 'Load Another ' + CONTRACT_RESULTS_BATCH_SIZE;
      moreWrap.appendChild(moreBtn);
      listEl.appendChild(moreWrap);
    }
  }

  function refreshContractsResults() {
    updateMarketPanelHeader();

    var resultsSub = document.querySelector('.contracts-results-sub');
    if (resultsSub) {
      resultsSub.textContent = getContractsResultsSubtext(getFilteredContractsResults());
    }

    renderContractsResultsList($('#contracts-results-list'));
  }

  function findContractAuctionById(auctionId) {
    for (var i = 0; i < contractsResults.length; i++) {
      if (contractsResults[i] && contractsResults[i].id === auctionId) {
        return contractsResults[i];
      }
    }
    return null;
  }

  function buildContractWhisperMessage(auction) {
    var item = auction && auction.item ? auction.item : {};
    var owner = auction && auction.owner ? auction.owner : {};
    var type = item.type || contractsFilters.type;
    var weapon = type === 'riven'
      ? findLookupByUrl(contractsLookupData.rivenWeapons, item.weapon_url_name)
      : findLookupByUrl(type === 'lich' ? contractsLookupData.lichWeapons : contractsLookupData.sisterWeapons, item.weapon_url_name);
    var ephemera = (type === 'lich' ? contractsLookupData.lichEphemeras : contractsLookupData.sisterEphemeras).filter(function (entry) {
      return item.having_ephemera && entry.element === item.element;
    })[0] || null;
    var weaponName = weapon ? weapon.name : safeNameFromSlug(item.weapon_url_name);
    // A bid-only auction with no bids yet has starting_price 1 and no buyout_price,
    // so the price has to come from the shared helper. When nobody is asking a
    // price, the whisper must not invent one.
    var currentPrice = WfmContracts.orderPrice(auction);
    var priceClause = currentPrice === null
      ? '. What is your asking price?'
      : ' for ' + currentPrice + ' platinum';
    var itemLabel = weaponName;

    if (type === 'riven') {
      itemLabel = weaponName + ' Riven';
      if (item.name) itemLabel += ' (' + String(item.name).replace(/-/g, ' ') + ')';
    } else if (type === 'lich') {
      itemLabel = weaponName + ' Kuva Lich';
    } else if (type === 'sister') {
      itemLabel = weaponName + ' Sister of Parvos';
    }

    if (type !== 'riven') {
      var detailParts = [];
      if (item.element) {
        detailParts.push(Number(item.damage || 0) + '% ' + String(item.element).replace(/^\w/, function (s) { return s.toUpperCase(); }) + ' bonus');
      }
      if (item.having_ephemera) {
        detailParts.push(ephemera ? '[' + ephemera.name + ']' : 'Ephemera');
      }
      if (detailParts.length > 0) {
        itemLabel += ' with ' + detailParts.join(' and ');
      }
    }

    return '/w ' + (wfmIngameName(owner) || 'Unknown') + ' Hi! I want to buy your ' + itemLabel + priceClause + '. (warframe companion app)';
  }

  async function copyContractWhisper(auction) {
    if (!auction) return;

    try {
      var message = buildContractWhisperMessage(auction);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(message);
      } else {
        var ta = document.createElement('textarea');
        ta.value = message;
        ta.setAttribute('readonly', 'readonly');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      showContractsToast('Seller whisper copied');
    } catch (err) {
      showContractsToast('Copy failed');
    }
  }

  function showContractsToast(text) {
    var existing = document.querySelector('.contracts-copy-toast');
    if (existing) existing.remove();

    var toast = document.createElement('div');
    toast.className = 'contracts-copy-toast';
    toast.textContent = text;
    document.body.appendChild(toast);

    setTimeout(function () {
      toast.classList.add('show');
    }, 10);

    setTimeout(function () {
      toast.classList.remove('show');
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 220);
    }, 1500);
  }

  function createContractCard(auction) {
    var card = document.createElement('article');
    card.className = 'contracts-card';

    var item = auction && auction.item ? auction.item : {};
    var owner = auction && auction.owner ? auction.owner : {};
    var type = item.type || contractsFilters.type;
    var weapon = type === 'riven'
      ? findLookupByUrl(contractsLookupData.rivenWeapons, item.weapon_url_name)
      : findLookupByUrl(type === 'lich' ? contractsLookupData.lichWeapons : contractsLookupData.sisterWeapons, item.weapon_url_name);
    var ephemera = (type === 'lich' ? contractsLookupData.lichEphemeras : contractsLookupData.sisterEphemeras).filter(function (entry) {
      return item.having_ephemera && entry.element === item.element;
    })[0] || null;

    var media = document.createElement('div');
    media.className = 'contracts-card-media';
    var mediaPath = weapon ? (weapon.icon || weapon.thumb) : '';
    if (mediaPath) {
      var img = document.createElement('img');
      img.src = getMarketItemImageUrl(weapon, mediaPath);
      img.alt = weapon.name || formatContractTypeLabel(type);
      img.loading = 'lazy';
      img.addEventListener('error', function () {
        img.style.display = 'none';
      });
      media.appendChild(img);
    } else {
      var placeholder = document.createElement('span');
      placeholder.className = 'material-icons-round';
      placeholder.textContent = type === 'riven' ? 'auto_awesome' : 'badge';
      media.appendChild(placeholder);
    }

    var main = document.createElement('div');
    main.className = 'contracts-card-main';

    var titleWrap = document.createElement('div');
    var title = document.createElement('h3');
    title.className = 'contracts-card-title';
    title.textContent = type === 'riven'
      ? (weapon ? weapon.name : safeNameFromSlug(item.weapon_url_name)) + ' Riven'
      : (weapon ? weapon.name : safeNameFromSlug(item.weapon_url_name)) + (type === 'lich' ? ' Kuva Lich' : ' Sister');
    var subtitle = document.createElement('p');
    subtitle.className = 'contracts-card-subtitle';
    subtitle.textContent = type === 'riven'
      ? String(item.name || '').replace(/-/g, ' ')
      : formatContractTypeLabel(type) + ' • ' + formatRelativeTime(auction.created);
    titleWrap.appendChild(title);
    titleWrap.appendChild(subtitle);
    main.appendChild(titleWrap);

    var chipRow = document.createElement('div');
    chipRow.className = 'contracts-chip-row';
    var typeChip = document.createElement('span');
    typeChip.className = 'contracts-chip is-type';
    typeChip.textContent = formatContractTypeLabel(type);
    chipRow.appendChild(typeChip);

    if (type !== 'riven') {
      var elementChip = document.createElement('span');
      elementChip.className = 'contracts-chip';
      elementChip.textContent = String(item.element || 'unknown').replace(/^\w/, function (s) { return s.toUpperCase(); }) + ' • ' + Number(item.damage || 0) + '%';
      chipRow.appendChild(elementChip);

      if (item.having_ephemera) {
        var ephChip = document.createElement('span');
        ephChip.className = 'contracts-chip';
        ephChip.textContent = ephemera ? ephemera.name : 'Has Ephemera';
        chipRow.appendChild(ephChip);
      }
    }

    main.appendChild(chipRow);

    if (type === 'riven' && Array.isArray(item.attributes) && item.attributes.length > 0) {
      var attrRow = document.createElement('div');
      attrRow.className = 'contracts-attr-row';

      for (var a = 0; a < item.attributes.length; a++) {
        var attribute = item.attributes[a];
        var attrLookup = findLookupByUrl(contractsLookupData.rivenAttributes, attribute && attribute.url_name ? attribute.url_name : '');
        var chip = document.createElement('span');
        chip.className = 'contracts-chip ' + (attribute && attribute.positive === false ? 'is-negative' : 'is-positive');
        chip.textContent = formatContractAttributeValue(attribute, attrLookup) + ' ' + (attrLookup ? attrLookup.name : safeNameFromSlug(attribute.url_name));
        attrRow.appendChild(chip);
      }

      main.appendChild(attrRow);

      var rivenMeta = document.createElement('div');
      rivenMeta.className = 'contracts-meta-row';
      [
        'MR ' + (item.mastery_level || 0),
        'Rank ' + (item.mod_rank || 0),
        'Rolls ' + (item.re_rolls || 0),
        String(item.polarity || 'Any').replace(/^\w/, function (s) { return s.toUpperCase(); })
      ].forEach(function (label) {
        var metaChip = document.createElement('span');
        metaChip.className = 'contracts-meta-chip';
        metaChip.textContent = label;
        rivenMeta.appendChild(metaChip);
      });
      main.appendChild(rivenMeta);
    }

    if (auction.note_raw) {
      var note = document.createElement('p');
      note.className = 'contracts-card-note';
      note.textContent = auction.note_raw;
      main.appendChild(note);
    }

    var side = document.createElement('div');
    side.className = 'contracts-card-side';

    var price = document.createElement('div');
    price.className = 'contracts-price';

    // starting_price is an opening floor, not an asking price, and a bid-only
    // auction with no bids still carries starting_price 1. Rendering that as the
    // price would advertise unfilled auctions for 1 platinum.
    var currentPrice = WfmContracts.orderPrice(auction);
    if (currentPrice === null) {
      var noPrice = document.createElement('span');
      noPrice.className = 'contracts-price-none';
      noPrice.textContent = 'No price yet';
      price.appendChild(noPrice);

      if (WfmContracts.finiteNumber(auction.starting_price)) {
        var opening = document.createElement('span');
        opening.className = 'contracts-price-hint';
        opening.textContent = 'opens at ' + auction.starting_price + ' plat';
        price.appendChild(opening);
      }
    } else {
      appendPlatinumAmount(price, currentPrice, 'contracts-price-main', 'contracts-price-icon');

      if (!WfmContracts.isBuyout(auction)) {
        var bidHint = document.createElement('span');
        bidHint.className = 'contracts-price-hint';
        bidHint.textContent = 'current bid';
        price.appendChild(bidHint);
      }
    }

    side.appendChild(price);

    var seller = document.createElement('div');
    seller.className = 'contracts-seller';
    var dot = document.createElement('span');
    dot.className = 'status-dot status-' + String(owner.status || 'offline');
    seller.appendChild(dot);
    var sellerName = document.createElement('span');
    sellerName.className = 'contracts-seller-name';
    sellerName.textContent = wfmIngameName(owner) || 'Unknown';
    seller.appendChild(sellerName);
    var sellerState = document.createElement('span');
    sellerState.textContent = String(owner.status || 'offline').toUpperCase();
    seller.appendChild(sellerState);
    side.appendChild(seller);

    var contactBtn = document.createElement('button');
    contactBtn.className = 'btn btn-secondary';
    contactBtn.type = 'button';
    contactBtn.dataset.contractAuctionId = auction.id;
    contactBtn.textContent = 'Contact Seller';
    side.appendChild(contactBtn);

    card.appendChild(media);
    card.appendChild(main);
    card.appendChild(side);

    return card;
  }

  async function openExternalUrl(url) {
    if (!url) return;

    if (window.electronAPI && typeof window.electronAPI.openExternal === 'function') {
      try {
        await window.electronAPI.openExternal(url);
        return;
      } catch (err) {
        console.warn('Failed to open external url:', err);
      }
    }

    window.open(url, '_blank', 'noopener');
  }

  // ---------- Data Loading ----------
  // The cache stores the API payload with the category already derived, so any
  // change to getMarketCategory is invisible until the cache expires - the Prime
  // filter read 0 because cached items still carried the old 'prime_sets' value.
  // Re-derive on read: it is cheap, and it makes a category change take effect
  // immediately instead of on a cache expiry nobody would notice.
  function refreshMarketItemCategories(items) {
    if (!items) return items;
    for (var i = 0; i < items.length; i++) {
      if (!items[i]) continue;
      items[i].category = getMarketCategory(items[i].tags);
    }
    return items;
  }

  async function loadMarketItems() {
      var cached = loadMarketCache();
      if (cached) {
        marketItems = refreshMarketItemCategories(cached);
        onMarketItemsLoaded();
        return;
      }


    showMarketLoading(true);
    // The fetch and the post-fetch render are separated so a render-side crash
    // is not misreported as a network failure. They used to share one try block,
    // which is how an undefined-variable crash inside the filter pass surfaced as
    // "Failed to fetch market items" and sent debugging after the wrong layer.
    try {
      var resp = await fetch(MARKET_API);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var json = await resp.json();
      var data = json.data || [];

      marketItems = data.map(function (item) {
        var en = item.i18n && item.i18n.en ? item.i18n.en : {};
        var slug = item.slug || item.url_name || '';
        return {
          id: item.id,
          slug: slug,
          name: en.name || item.item_name || item.name || safeNameFromSlug(slug),
          thumb: en.thumb || en.icon || item.thumb || item.icon || '',
          icon: en.icon || item.icon || '',
          subIcon: en.subIcon || en.sub_icon || item.subIcon || item.sub_icon || '',
          tags: item.tags || [],
          category: getMarketCategory(item.tags),
        };
      }).filter(function (item) { return !!item.slug; }).sort(function (a, b) { return a.name.localeCompare(b.name); });

      saveMarketCache(marketItems);
    } catch (err) {
      console.error('Failed to fetch market items:', err);
      showMarketError(err.message);
      return;
    }

    try {
      onMarketItemsLoaded();
    } catch (err) {
      // The data is good; only rendering failed. Say so, and keep the items
      // reachable instead of blanking the panel.
      console.error('Market items loaded but failed to render:', err);
      showMarketError('Market data loaded, but the list failed to render: ' + (err && err.message ? err.message : 'unknown error'));
    }
  }

  function saveMarketCache(items) {
    try {
      localStorage.setItem(MARKET_CACHE_KEY, JSON.stringify({
        timestamp: Date.now(), items: items
      }));
    } catch (e) { /* quota */ }
  }

  function loadMarketCache() {
    try {
      var raw = localStorage.getItem(MARKET_CACHE_KEY);
      if (!raw) return null;
      var c = JSON.parse(raw);
      if (Date.now() - c.timestamp > MARKET_CACHE_TTL) return null;
      return c.items;
    } catch (e) { return null; }
  }

  // ---------- UI Helpers ----------
  function showMarketLoading(show) {
    var el = $('#market-loading');
    if (el) el.classList.toggle('hidden', !show);
  }

  function showMarketError(msg) {
    showMarketLoading(false);
    var grid = $('#market-grid');
    if (!grid) return;
    grid.textContent = '';
    var errBox = document.createElement('div');
    errBox.className = 'market-error';
    errBox.textContent = 'Failed to load market: ' + msg;
    grid.appendChild(errBox);
  }

  function onMarketItemsLoaded() {
    showMarketLoading(false);
    marketGroups = buildMarketItemGroups(marketItems);
    applyMarketFilters();
    updateMarketCategoryCounts();
    renderTradeAnalyticsSearchResults();
  }

// ---------- Filters ----------
   function applyMarketFilters() {
     var normalizedQuery = String(marketSearchQuery || '').toLowerCase().trim();

     filteredMarketItems = marketGroups.filter(function (group) {
       if (marketCategory !== 'all') {
         // A set is shown under its own category, and also under a component's category
         // so filtering by "barrel" still surfaces the weapons that have one.
         var catHit = groupItem(group).category === marketCategory;
         if (!catHit && group.parts) {
           for (var p = 0; p < group.parts.length; p++) {
             if (group.parts[p].category === marketCategory) { catHit = true; break; }
           }
         }
         if (!catHit) return false;
       }
       
       // Inventory filters
       if (showOwnedOnly && !inventoryService.isOwned(group.name)) {
         // For sets, check if any part is owned
         if (group.parts) {
           var anyPartOwned = false;
           for (var p = 0; p < group.parts.length; p++) {
             if (inventoryService.isOwned(group.parts[p].name)) {
               anyPartOwned = true;
               break;
             }
           }
           if (!anyPartOwned) return false;
         } else {
           return false;
         }
       }
       
       if (showNotOwnedOnly && inventoryService.isOwned(group.name)) {
         // For sets, hide if any part is owned
         if (group.parts) {
           for (var p = 0; p < group.parts.length; p++) {
             if (inventoryService.isOwned(group.parts[p].name)) return false;
           }
         } else {
           return false;
         }
       }
       
       if (showMasteredOnly && !inventoryService.isMastered(group.name)) {
         // For sets, check if any part is mastered
         if (group.parts) {
           var anyPartMastered = false;
           for (var p = 0; p < group.parts.length; p++) {
             if (inventoryService.isMastered(group.parts[p].name)) {
               anyPartMastered = true;
               break;
             }
           }
           if (!anyPartMastered) return false;
         } else {
           return false;
         }
       }
       
       if (showVaultedOnly && !inventoryService.isVaulted(group.name)) {
         // For sets, show only if any part is vaulted
         if (group.parts) {
           var anyPartVaulted = false;
           for (var p = 0; p < group.parts.length; p++) {
             if (inventoryService.isVaulted(group.parts[p].name)) {
               anyPartVaulted = true;
               break;
             }
           }
           if (!anyPartVaulted) return false;
         } else {
           return false;
         }
       }
       
       if (showActiveOnly && inventoryService.isVaulted(group.name)) {
         // For sets, hide if any part is vaulted (active = not vaulted)
         if (group.parts) {
           for (var p = 0; p < group.parts.length; p++) {
             if (inventoryService.isVaulted(group.parts[p].name)) return false;
           }
         } else {
           return false;
         }
       }
       
       if (normalizedQuery) {
         if (String(group.name || '').toLowerCase().indexOf(normalizedQuery) === -1) {
           var nameHit = false;
           if (group.parts) {
             for (var q = 0; q < group.parts.length; q++) {
               if (String(group.parts[q].name || '').toLowerCase().indexOf(normalizedQuery) !== -1) { nameHit = true; break; }
             }
           }
           if (!nameHit) return false;
         }
       }
       return true;
     });
     renderMarketItems();
     updateMarketPanelHeader();
   }

  function groupItem(group) {
    return group.kind === 'set' ? group.setItem : group.item;
  }

  function updateMarketCategoryCounts() {
    var counts = { all: marketGroups.length };
    for (var i = 0; i < marketGroups.length; i++) {
      var group = marketGroups[i];
      var cat = groupItem(group).category;
      counts[cat] = (counts[cat] || 0) + 1;
    }
    document.querySelectorAll('.market-cat-btn').forEach(function (btn) {
      var cat = btn.dataset.marketCat;
      var badge = btn.querySelector('.market-cat-count');
      if (badge && counts[cat] !== undefined) {
        badge.textContent = counts[cat];
      }
    });
  }

  // ---------- Render Items ----------
  // WFM sells a weapon as a set plus its individual components, so a flat item list
  // spends most of the grid on "Acceltra Prime Barrel / Blueprint / Receiver / Stock",
  // all of which share the weapon's artwork and none of which is useful on its own.
  // Collapse each set into a single weapon card and let the parts be chosen on demand,
  // which is how the WFM site and set managers present a buildable item.
  const MARKET_PART_WORDS = [
    'Blueprint', 'Carapace', 'Cerebrum', 'Neuroptics', 'Chassis', 'Fuselage', 'Engines',
    'Receiver', 'Barrel', 'Stock', 'Blade', 'Hilt', 'Guard', 'Handle', 'Grip', 'Imprint',
    'Core', 'Motor', 'Stringer', 'Housing', 'Pylon', 'Optic', 'Scope', 'Muzzle', 'Systems',
    'Wings', 'Harness', 'Clip', 'Magazine', 'Trigger', 'Tip', 'Head', 'Frame', 'Link'
  ];
  const MARKET_SET_SUFFIX = /\s+Set$/i;

  function getMarketPartWord(name) {
    var words = String(name || '').trim().split(/\s+/);
    if (words.length < 2) return '';
    var last = words[words.length - 1];
    return MARKET_PART_WORDS.indexOf(last) === -1 ? '' : last;
  }

  // Key a component under the weapon it belongs to. WFM lists "<weapon> Set" rather
  // than a bare "<weapon>", so fall back to the set listing when only that exists.
  function getMarketSetKey(name, byName) {
    var partWord = getMarketPartWord(name);
    if (!partWord) return '';
    var base = String(name).trim().slice(0, -(partWord.length)).trim();
    if (!base) return '';
    if (byName[base]) return base;
    if (byName[base + ' Set']) return base + ' Set';
    return base;
  }

  function buildMarketItemGroups(items) {
    var byName = {};
    for (var i = 0; i < items.length; i++) byName[items[i].name] = items[i];

    var children = {};
    var loose = [];
    for (var n = 0; n < items.length; n++) {
      var key = getMarketSetKey(items[n].name, byName);
      if (key && key !== items[n].name) {
        if (!children[key]) children[key] = [];
        children[key].push(items[n]);
      } else {
        loose.push(items[n]);
      }
    }

    var groups = [];
    for (var c = 0; c < loose.length; c++) {
      var looseItem = loose[c];
      var setKey = byName[looseItem.name] ? looseItem.name : (byName[looseItem.name + ' Set'] ? looseItem.name + ' Set' : '');
      var parts = setKey ? (children[setKey] || []) : [];
      if (parts.length >= 2) {
        groups.push({
          kind: 'set',
          // The bare weapon name is what the catalogue and the wiki file the art under.
          name: looseItem.name.replace(MARKET_SET_SUFFIX, ''),
          setItem: byName[setKey] || looseItem,
          parts: parts.concat([byName[setKey]].filter(Boolean))
        });
        delete children[setKey];
      } else {
        groups.push({ kind: 'item', name: looseItem.name, item: looseItem });
      }
    }

    // Anything left over is a component whose weapon is not listed; keep it addressable.
    for (var left in children) {
      if (!Object.prototype.hasOwnProperty.call(children, left)) continue;
      for (var l = 0; l < children[left].length; l++) {
        groups.push({ kind: 'item', name: children[left][l].name, item: children[left][l] });
      }
    }

    return groups;
  }

  function renderMarketItems() {
    var grid = $('#market-grid');
    if (!grid) return;
    // clear existing cards only
    var existing = grid.querySelectorAll('.market-item-card, .market-empty, .market-error, .market-more-hint');
    for (var i = 0; i < existing.length; i++) existing[i].remove();

    if (filteredMarketItems.length === 0) {
      var emptyEl = document.createElement('div');
      emptyEl.className = 'market-empty';
      emptyEl.textContent = 'No items found';
      grid.appendChild(emptyEl);
      return;
    }

    var fragment = document.createDocumentFragment();
    var limit = Math.min(filteredMarketItems.length, 200); // show max 200
    for (var j = 0; j < limit; j++) {
      fragment.appendChild(createMarketCard(filteredMarketItems[j], j));
    }    if (filteredMarketItems.length > 200) {
      var moreEl = document.createElement('div');
      moreEl.className = 'market-more-hint';
      moreEl.textContent = (filteredMarketItems.length - 200) + ' more items. Use search to narrow.';
      fragment.appendChild(moreEl);
    }
    grid.appendChild(fragment);
  }

  function createMarketCard(entry, index) {
    var isSet = entry && entry.kind === 'set';
    // A set card is the weapon itself, so the bare weapon name is what the art resolves
    // against; a plain card is just the item.
    var item = isSet ? entry.setItem : entry.item;
    var artItem = isSet ? { name: entry.name, thumb: entry.setItem.thumb, image: entry.setItem.image } : entry.item;

    var card = document.createElement('div');
    card.className = 'market-item-card' + (isSet ? ' is-set' : '');
    card.style.animationDelay = Math.min(index * 8, 300) + 'ms';

    var imgWrap = document.createElement('div');
    imgWrap.className = 'market-item-thumb';
    var imagePath = getMarketDisplayImage(artItem);
    if (imagePath) {
      var img = document.createElement('img');
      img.src = getMarketItemImageUrl(artItem, imagePath);
      img.alt = entry.name;
      img.loading = 'lazy';
      img.addEventListener('error', function () {
        img.style.display = 'none';
        var ph = imgWrap.querySelector('.mi-placeholder');
        if (ph) ph.style.display = 'flex';
        // The catalogue and WFM's CDN both came up empty; try the wiki before giving up.
        upgradeMarketImageFromWiki(img, artItem.name);
      });
      imgWrap.appendChild(img);
      if (!isSet) {
        labelMarketImageFallback(img, artItem, imgWrap);
        if (!getLocalCatalogImageUrl(artItem.name)) {
          upgradeMarketImageFromWiki(img, artItem.name);
        }
      }
    }
    var placeholder = document.createElement('div');
    placeholder.className = 'mi-placeholder';
    placeholder.style.display = imagePath ? 'none' : 'flex';
    var phIcon = document.createElement('span');
    phIcon.className = 'material-icons-round';
    phIcon.textContent = 'storefront';
    placeholder.appendChild(phIcon);
    imgWrap.appendChild(placeholder);

    var info = document.createElement('div');
    info.className = 'market-item-info';
    var name = document.createElement('div');
    name.className = 'market-item-name';
    name.textContent = entry.name;
    name.title = entry.name;
var tagEl = document.createElement('div');
     tagEl.className = 'market-item-tag';
     if (isSet) {
       var ownedCount = 0;
       if (window.inventoryService) {
         for (var k = 0; k < entry.parts.length; k++) {
           if (window.inventoryService.isOwned(entry.parts[k].name)) {
             ownedCount++;
           }
         }
       }
       tagEl.textContent = ownedCount + '/' + entry.parts.length + ' parts';
       tagEl.title = 'Owned ' + ownedCount + ' of ' + entry.parts.length + ' parts';
     } else {
       tagEl.textContent = item.category.replace(/_/g, ' ');
     }

    info.appendChild(name);
    info.appendChild(tagEl);

card.appendChild(imgWrap);
     card.appendChild(info);

     // Owned badge for non-set items
     if (!isSet && window.inventoryService && window.inventoryService.isOwned(item.name)) {
       var ownedBadge = document.createElement('div');
       ownedBadge.className = 'owned-badge';
       ownedBadge.title = 'Owned';
       ownedBadge.innerHTML = '&check;';
       card.appendChild(ownedBadge);
     }

     card.addEventListener('click', function () {
       openOrdersModal(item, isSet ? entry : null);
     });

     return card;
  }

  // ---------- Orders Modal ----------
  async function openOrdersModal(item, setGroup) {
    var modal = $('#market-orders-modal');
    if (!modal) return;
    modal.classList.remove('hidden');

    var titleEl = $('#orders-item-name');
    var imgEl = $('#orders-item-img');
    var ordersBody = $('#orders-body');

    // Heading names whatever is actually being listed. When a component of a set
    // is targeted, the set name alone was ambiguous - it read "Soma Prime" over
    // a barrel's orders, which looks like the wrong item.
    var showingSet = !setGroup || !item || (setGroup.setItem && setGroup.setItem.slug === item.slug);
    if (titleEl) {
      titleEl.textContent = showingSet
        ? (setGroup ? setGroup.name : item.name)
        : item.name;
      if (!showingSet && setGroup) {
        titleEl.title = 'Part of ' + setGroup.name;
      } else {
        titleEl.title = '';
      }
    }
    if (imgEl) {
      // A set card shows the weapon, so ask for the bare weapon's art rather than the
      // "X Set" listing's, which is the same picture but resolves more reliably.
      var artItem = setGroup
        ? { name: setGroup.name, thumb: item.thumb, image: item.image }
        : item;
      imgEl.src = getMarketItemImageUrl(artItem);
      imgEl.alt = showingSet ? (setGroup ? setGroup.name : item.name) : item.name;
      imgEl.title = '';
    }

    // Set completion status
    // Remove any existing set completion element
    var existing = $('.orders-set-completion');
    if (existing) {
      existing.remove();
    }
    var setCompletionEl = document.createElement('div');
    setCompletionEl.className = 'orders-set-completion';
    if (setGroup) {
      // Calculate owned parts in the set
      var ownedCount = 0;
      for (var i = 0; i < setGroup.parts.length; i++) {
        var part = setGroup.parts[i];
        var partOwned = false;
        if (window.inventoryService) {
          partOwned = window.inventoryService.isOwned(part.name);
        } else {
          var ownedKey = 'warframe_inventory_owned_items';
          var owned = new Set(JSON.parse(localStorage.getItem(ownedKey) || '[]'));
          partOwned = owned.has(part.name);
        }
        if (partOwned) ownedCount++;
      }
      setCompletionEl.textContent = 'Owned: ' + ownedCount + '/' + setGroup.parts.length + ' parts';
    } else {
      // Single non-set item
      var itemOwned = false;
      if (window.inventoryService) {
        itemOwned = window.inventoryService.isOwned(item.name);
      } else {
        var ownedKey = 'warframe_inventory_owned_items';
        var owned = new Set(JSON.parse(localStorage.getItem(ownedKey) || '[]'));
        itemOwned = owned.has(item.name);
      }
      setCompletionEl.textContent = itemOwned ? 'Owned' : 'Not Owned';
    }
    // Insert after the image element (if exists) or after the title
    if (imgEl) {
      imgEl.insertAdjacentElement('afterend', setCompletionEl);
    } else {
      if (titleEl) {
        titleEl.insertAdjacentElement('afterend', setCompletionEl);
      }
    }

    renderOrdersPartsBar(setGroup || null, item);

    ordersBody.textContent = '';
    var loadMsg = document.createElement('div');
    loadMsg.className = 'orders-loading';
    loadMsg.textContent = 'Loading orders...';
    ordersBody.appendChild(loadMsg);

    currentOrdersSlug = item.slug;
    currentOrdersItemName = item.name;
    currentOrdersWikiUrl = buildWikiUrl(item);
    currentOrdersItemMeta = item;
    currentOrdersSetGroup = setGroup || null;
    ordersOnlineOnly = false;
    ordersOnlineMode = 'all_online';
    var token = ++ordersOpenToken;
    await fetchAndRenderOrders(item.slug, token);

    // Auto-refresh
    clearInterval(ordersRefreshInterval);
    ordersRefreshInterval = setInterval(function () {
      fetchAndRenderOrders(item.slug, ordersOpenToken);
    }, 60000);
  }

  // Choosing a component is the whole point of grouping the grid by set, so offer the
  // components as a row of chips above the orders. The weapon art carries over and the
  // wiki's generic silhouette says which component it is, since no reachable host has
  // per-component artwork.
  function renderOrdersPartsBar(setGroup, activeItem) {
    var bar = $('#orders-parts-bar');
    if (!bar) return;
    bar.textContent = '';
    bar.classList.add('hidden');
    if (!setGroup || !setGroup.parts || !setGroup.parts.length) return;

    drawOrdersPartsBar(bar, setGroup.parts, setGroup, activeItem);
    refreshOrdersPartsFromApi(bar, setGroup, activeItem);
  }

  function drawOrdersPartsBar(bar, parts, setGroup, activeItem) {
    bar.textContent = '';
    bar.classList.remove('hidden');

    var heading = document.createElement('div');
    heading.className = 'orders-parts-heading';

    // Say how much of the set is already owned. The components are listed right
    // below, and without a count the list reads as a menu rather than as a
    // build sheet - there is no way to tell at a glance what is still missing.
    var owned = 0;
    try {
      if (typeof inventoryService !== 'undefined' && typeof inventoryService.isOwned === 'function') {
        for (var o = 0; o < parts.length; o++) {
          if (inventoryService.isOwned(parts[o].name)) owned++;
        }
      }
    } catch (err) {
      owned = 0;
    }
    owned = Math.min(owned, parts.length);

    var headingText = document.createElement('span');
    headingText.textContent = 'Components';
    var headingCount = document.createElement('span');
    headingCount.className = 'orders-parts-count' + (owned === parts.length ? ' is-complete' : '');
    headingCount.textContent = owned + ' of ' + parts.length + ' owned';
    heading.appendChild(headingText);
    heading.appendChild(headingCount);
    bar.appendChild(heading);

    var row = document.createElement('div');
    row.className = 'orders-parts-row';

    for (var i = 0; i < parts.length; i++) {
      row.appendChild(createOrdersPartChip(parts[i], setGroup, activeItem, i === 0));
    }

    bar.appendChild(row);
  }

  /**
   * Ask Warframe.market which items actually belong to this set, rather than trusting
   * the local part-word list used to build the grid. /v2/items carries no set fields
   * at all, so grouping has to be inferred from names there, and that inference is
   * wrong for parts whose suffix was never anticipated - Glaive Prime ships a "Disc",
   * which the word list does not contain, so its parts bar was silently incomplete.
   *
   * The grid grouping is left as-is: there is no bulk source for set membership, and
   * one request per card would be worse than the inference it replaces. This only
   * fires when a set is actually opened, and falls back to the local list.
   */
  async function refreshOrdersPartsFromApi(bar, setGroup, activeItem) {
    var slug = (setGroup && setGroup.setItem && setGroup.setItem.slug) || '';
    if (!slug) return;

    var members = null;
    try {
      var res = await wfmFetch('https://api.warframe.market/v2/item/' + encodeURIComponent(slug) + '/set');
      var data = res && res.data;
      if (Array.isArray(data) && data.length > 1) members = data;
      else if (data && Array.isArray(data.items) && data.items.length > 1) members = data.items;
    } catch (err) {
      return;
    }
    if (!members) return;

    // Resolve each member against the loaded catalogue so the chips keep the same
    // shape as the local ones (image, name, slug, category).
    var parts = [];
    for (var i = 0; i < members.length; i++) {
      var it = members[i];
      var name = it && it.i18n && it.i18n.en ? it.i18n.en.name : '';
      if (!name) continue;
      var local = findMarketItemByName(name) || null;
      parts.push(local || {
        name: name,
        slug: it.slug,
        id: it.id,
        category: local ? local.category : '',
        thumb: it.i18n.en.thumb || '',
        image: it.i18n.en.icon || '',
        tags: it.tags || []
      });
    }
    if (parts.length < 2) return;

    // The bar may have been closed or pointed at another item while this was in flight.
    if (!$('#orders-parts-bar') || $('#orders-parts-bar') !== bar) return;
    if (!currentOrdersSetGroup || currentOrdersSetGroup.setItem !== setGroup.setItem) return;

    drawOrdersPartsBar(bar, parts, setGroup, activeItem);
  }

function createOrdersPartChip(part, setGroup, activeItem, isFirst) {
  var chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'orders-part-chip';
  if (isFirst || (activeItem && part.slug === activeItem.slug)) chip.classList.add('active');

  var thumb = document.createElement('span');
  thumb.className = 'orders-part-thumb';
  var img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.src = getMarketItemImageUrl(part, getMarketDisplayImage(part));
  img.addEventListener('error', function () {
    img.style.display = 'none';
  });
  thumb.appendChild(img);

  var iconTitle = getMarketPartIconTitle(part.name);
  if (iconTitle) {
    var icon = document.createElement('img');
    icon.className = 'orders-part-icon';
    icon.alt = '';
    requestMarketPartIcon(icon, iconTitle);
    thumb.appendChild(icon);
  }

  // Check if part is owned and add owned badge to thumb
  var isOwned = false;
  if (window.inventoryService) {
    isOwned = window.inventoryService.isOwned(part.name);
  } else {
    // Fallback: check localStorage directly
    var ownedKey = 'warframe_inventory_owned_items';
    var owned = new Set(JSON.parse(localStorage.getItem(ownedKey) || '[]'));
    isOwned = owned.has(part.name);
  }
  if (isOwned) {
    var ownedBadge = document.createElement('div');
    ownedBadge.className = 'owned-badge';
    ownedBadge.title = 'Owned';
    ownedBadge.innerHTML = '&check;';
    thumb.appendChild(ownedBadge);
  }

  var label = document.createElement('span');
  label.className = 'orders-part-label';
  label.textContent = / Set$/i.test(part.name) ? 'Complete set' : part.name.split(/\s+/).pop();

  chip.appendChild(thumb);
  chip.appendChild(label);
  chip.title = part.name;
  chip.addEventListener('click', function () {
    if (activeItem && part.slug === activeItem.slug) return;
    openOrdersModal(part, setGroup);
  });

  return chip;
}

  function closeOrdersModal() {
    var modal = $('#market-orders-modal');
    if (modal) modal.classList.add('hidden');
    clearInterval(ordersRefreshInterval);
    currentOrdersSlug = null;
    currentOrdersItemName = null;
    currentOrdersWikiUrl = null;
    currentOrdersItemMeta = null;
    currentOrdersSetGroup = null;
    ordersOnlineOnly = false;
    ordersOnlineMode = 'all_online';
  }

  /**
   * Open the orders window straight onto one component of a set.
   *
   * Searching the market for a part name only ever finds the parent set, because
   * set components are folded into the set's group and are not listed on their
   * own. So a shortcut from an item's craft parts has to resolve the part itself
   * and open its orders directly, which is what clicking the component chip in
   * the strip already did - this just makes it reachable from elsewhere.
   */
  async function openPartOrdersByName(partName) {
    var wanted = String(partName || '').trim().toLowerCase();
    if (!wanted) return { ok: false, message: 'No part name given.' };

    // The market catalogue loads lazily on first navigation, so a shortcut that
    // arrives before the panel was ever opened would find an empty group list
    // and wrongly report the part as unlisted.
    if (marketGroups.length === 0) {
      try {
        await loadMarketItems();
      } catch (err) {
        return { ok: false, message: 'Market data could not be loaded: ' + (err && err.message ? err.message : 'unknown error') };
      }
    }
    if (marketGroups.length === 0) {
      return { ok: false, message: 'Market data is not available yet.' };
    }

    for (var i = 0; i < marketGroups.length; i++) {
      var group = marketGroups[i];
      var candidates = [];
      if (group.kind === 'set') {
        candidates = group.parts || [];
      } else {
        candidates = [group.item];
      }
      for (var p = 0; p < candidates.length; p++) {
        var candidate = candidates[p];
        if (!candidate) continue;
        var name = String(candidate.name || '').trim().toLowerCase();
        // The set itself is listed in its own parts array under a "Set" name;
        // matching on it would reopen the set rather than a component.
        if (name === wanted && !/ set$/i.test(candidate.name || '')) {
          await openOrdersModal(candidate, group.kind === 'set' ? group : null);
          return { ok: true, item: candidate.name };
        }
      }
    }
    return { ok: false, message: 'No market listing found for "' + partName + '".' };
  }

  function isOnlineSeller(order) {
    var status = getNormalizedUserStatus(order);
    return status === 'online' || status === 'ingame';
  }

  function isInGameSeller(order) {
    var status = getNormalizedUserStatus(order);
    return status === 'ingame';
  }

  function getNormalizedUserStatus(order) {
    var raw = String(order && order.user ? order.user.status : 'offline')
      .toLowerCase()
      .replace(/[\s_-]+/g, '');
    if (raw === 'ingame') return 'ingame';
    if (raw === 'online') return 'online';
    return 'offline';
  }

  function getStatusSortRank(order) {
    var status = getNormalizedUserStatus(order);
    if (status === 'ingame') return 0;
    if (status === 'online') return 1;
    return 2;
  }

  function getOrderReputation(order) {
    if (!order || !order.user) return null;
    var rep = order.user.reputation;
    if (rep === null || typeof rep === 'undefined' || rep === '') return null;
    return rep;
  }

  function formatReputation(rep) {
    if (rep === null || typeof rep === 'undefined' || rep === '') return '--';
    var n = Number(rep);
    if (!isNaN(n)) {
      return n > 0 ? ('+' + n) : String(n);
    }
    return String(rep);
  }

  function getOrderRankValue(order) {
    if (!order) return null;
    var raw = order.rank;
    if (raw === null || typeof raw === 'undefined' || raw === '') raw = order.mod_rank;
    if (raw === null || typeof raw === 'undefined' || raw === '') return null;
    var numeric = Number(raw);
    if (Number.isFinite(numeric)) return Math.max(0, Math.floor(numeric));
    var clean = String(raw).trim();
    return clean ? clean : null;
  }

  function formatOrderRank(order) {
    var rank = getOrderRankValue(order);
    if (rank === null || typeof rank === 'undefined' || rank === '') return '--';
    return 'Rank ' + rank;
  }

  function itemSupportsOrderRank(itemMeta, sellOrders, buyOrders) {
    var category = itemMeta && itemMeta.category ? String(itemMeta.category) : '';
    var tags = Array.isArray(itemMeta && itemMeta.tags) ? itemMeta.tags : [];
    if (category === 'mods' || category === 'arcanes') return true;
    if (tags.indexOf('mod') !== -1 || tags.indexOf('stance') !== -1 || tags.indexOf('aura') !== -1) return true;
    if (tags.indexOf('arcane_enhancement') !== -1 || tags.indexOf('arcane_helmet') !== -1) return true;

    var allOrders = [].concat(sellOrders || [], buyOrders || []);
    return allOrders.some(function (order) {
      return getOrderRankValue(order) !== null;
    });
  }

  async function fetchAndRenderOrders(slug, token) {
    var ordersBody = $('#orders-body');
    if (!ordersBody) return;
    if (token !== undefined && token !== ordersOpenToken) return;

    try {
      var orders = await fetchOrdersV2(slug);
      // The item may have changed while this was in flight; that response is now stale.
      if (token !== undefined && token !== ordersOpenToken) return;

      // Filter visible orders
      var sellOrders = [];
      var buyOrders = [];
      for (var i = 0; i < orders.length; i++) {
        var o = orders[i];
        if (o.visible === false) continue;
        if (o.order_type === 'sell') sellOrders.push(o);
        else if (o.order_type === 'buy') buyOrders.push(o);
      }

      // Sort: in-game first, then online, then offline. Within each status sort by price.
      sellOrders.sort(function (a, b) {
        var sa = getStatusSortRank(a);
        var sb = getStatusSortRank(b);
        if (sa !== sb) return sa - sb;
        return a.platinum - b.platinum;
      });
      buyOrders.sort(function (a, b) {
        var sa = getStatusSortRank(a);
        var sb = getStatusSortRank(b);
        if (sa !== sb) return sa - sb;
        return b.platinum - a.platinum;
      });

      renderOrdersContent(ordersBody, sellOrders, buyOrders, {
        name: currentOrdersItemName || 'this item',
        wikiUrl: currentOrdersWikiUrl || '',
        category: currentOrdersItemMeta && currentOrdersItemMeta.category,
        tags: currentOrdersItemMeta && currentOrdersItemMeta.tags
      });
    } catch (err) {
      if (token !== undefined && token !== ordersOpenToken) return;
      ordersBody.textContent = '';
      var errEl = document.createElement('div');
      errEl.className = 'orders-error';
      errEl.textContent = 'Failed to load orders: ' + err.message;
      ordersBody.appendChild(errEl);
    }
  }

  async function fetchOrdersV2(slug) {
    var resp = await fetch(ORDERS_API_V2 + '/' + slug, {
      headers: { 'Accept': 'application/json' }
    });
    if (!resp.ok) {
      if (resp.status === 403 || resp.status === 404) {
        // Keep v1 fallback for environments that still allow legacy endpoint.
        return fetchOrdersV1(slug);
      }
      throw new Error('HTTP ' + resp.status);
    }

    var json = await resp.json();
    var data = Array.isArray(json.data) ? json.data : [];
    return data.map(function (o) {
      return {
        id: o.id,
        order_type: o.type,
        platinum: o.platinum,
        quantity: o.quantity,
        rank: typeof o.rank !== 'undefined' ? o.rank : o.mod_rank,
        mod_rank: typeof o.mod_rank !== 'undefined' ? o.mod_rank : o.rank,
        visible: o.visible,
        platform: o.user && o.user.platform,
        user: {
          status: o.user && o.user.status,
          ingame_name: (o.user && (o.user.ingameName || o.user.ingame_name)) || 'Unknown',
          reputation: o.user && (o.user.reputation || o.user.reputation_level || o.user.reputationLevel)
        }
      };
    });
  }

  async function fetchOrdersV1(slug) {
    var legacyResp = await fetch(ORDERS_API_V1 + '/' + slug + '/orders', {
      headers: { 'Accept': 'application/json' }
    });
    if (!legacyResp.ok) throw new Error('HTTP ' + legacyResp.status);
    var legacyJson = await legacyResp.json();
    return legacyJson.payload && legacyJson.payload.orders ? legacyJson.payload.orders : [];
  }

  async function fetchOrdersForAnalytics(slug, forceRefresh) {
    var key = String(slug || '').trim();
    if (!key) return [];

    var cached = analyticsOrdersCache[key];
    if (!forceRefresh && cached && (Date.now() - cached.timestamp) < ANALYTICS_ORDERS_CACHE_TTL) {
      return cached.data;
    }

    var data = await fetchOrdersV2(key);
    analyticsOrdersCache[key] = {
      timestamp: Date.now(),
      data: Array.isArray(data) ? data : []
    };
    return analyticsOrdersCache[key].data;
  }

  async function fetchItemStatistics(slug, forceRefresh) {
    var key = String(slug || '').trim();
    if (!key) return null;

    var cached = analyticsStatsCache[key];
    if (!forceRefresh && cached && (Date.now() - cached.timestamp) < ANALYTICS_STATS_CACHE_TTL) {
      return cached.data;
    }

    var resp = await fetch(STATS_API_V1 + '/' + key + '/statistics', {
      headers: {
        'Accept': 'application/json',
        'Platform': 'pc',
        'Language': 'en'
      }
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);

    var json = await resp.json();
    var payload = json && json.payload ? json.payload : {};
    analyticsStatsCache[key] = {
      timestamp: Date.now(),
      data: payload
    };
    return payload;
  }

  function getLatestEntryByType(entries, orderType) {
    if (!Array.isArray(entries)) return null;

    for (var i = entries.length - 1; i >= 0; i--) {
      var entry = entries[i];
      if (!entry) continue;
      if (!orderType || entry.order_type === orderType) {
        return entry;
      }
    }

    return null;
  }

  function getWeightedAverage(entries, valueKey) {
    if (!Array.isArray(entries) || entries.length === 0) return null;

    var totalVolume = 0;
    var totalValue = 0;
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (!entry) continue;

      var value = Number(entry[valueKey]);
      var volume = Number(entry.volume);
      if (!isFinite(value)) continue;

      var safeVolume = isFinite(volume) && volume > 0 ? volume : 1;
      totalVolume += safeVolume;
      totalValue += value * safeVolume;
    }

    if (totalVolume <= 0) return null;
    return totalValue / totalVolume;
  }

  function getVolumeTotal(entries) {
    if (!Array.isArray(entries)) return 0;

    var total = 0;
    for (var i = 0; i < entries.length; i++) {
      var volume = Number(entries[i] && entries[i].volume);
      if (isFinite(volume) && volume > 0) total += volume;
    }
    return total;
  }

  function getBestVisibleOrder(orders, orderType) {
    var filtered = [];
    var i;

    for (i = 0; i < orders.length; i++) {
      var order = orders[i];
      if (!order || order.visible === false || order.order_type !== orderType) continue;
      if (isOnlineSeller(order)) filtered.push(order);
    }

    if (filtered.length === 0) {
      for (i = 0; i < orders.length; i++) {
        var fallback = orders[i];
        if (!fallback || fallback.visible === false || fallback.order_type !== orderType) continue;
        filtered.push(fallback);
      }
    }

    if (filtered.length === 0) return null;

    filtered.sort(function (a, b) {
      if (orderType === 'sell') return Number(a.platinum || 0) - Number(b.platinum || 0);
      return Number(b.platinum || 0) - Number(a.platinum || 0);
    });

    return filtered[0] || null;
  }

  function buildTradeAnalyticsModel(item, statsPayload, orders) {
    var closedHistory = Array.isArray(statsPayload && statsPayload.statistics_closed && statsPayload.statistics_closed['90days'])
      ? statsPayload.statistics_closed['90days']
      : [];
    var liveHistory = Array.isArray(statsPayload && statsPayload.statistics_live && statsPayload.statistics_live['48hours'])
      ? statsPayload.statistics_live['48hours']
      : [];

    var closed7 = closedHistory.slice(-7);
    var closed30 = closedHistory.slice(-30);
    var recentClosed = closed7.slice().reverse();

    var latestClosed = closedHistory.length > 0 ? closedHistory[closedHistory.length - 1] : null;
    var latestLiveSell = getLatestEntryByType(liveHistory, 'sell');
    var latestLiveBuy = getLatestEntryByType(liveHistory, 'buy');
    var bestSell = getBestVisibleOrder(orders, 'sell');
    var bestBuy = getBestVisibleOrder(orders, 'buy');

    var avg7 = getWeightedAverage(closed7, 'wa_price');
    var avg30 = getWeightedAverage(closed30, 'wa_price');
    var volume7 = getVolumeTotal(closed7);
    var volume30 = getVolumeTotal(closed30);
    var spread = bestSell && bestBuy ? Number(bestSell.platinum) - Number(bestBuy.platinum) : null;
    var change7vs30 = isFinite(avg7) && isFinite(avg30) ? (avg7 - avg30) : null;

    var visibleSellOrders = orders.filter(function (order) {
      return order && order.visible !== false && order.order_type === 'sell';
    });
    var visibleBuyOrders = orders.filter(function (order) {
      return order && order.visible !== false && order.order_type === 'buy';
    });

    var model = {
      item: item,
      closedHistory: closedHistory,
      liveHistory: liveHistory,
      latestClosed: latestClosed,
      latestLiveSell: latestLiveSell,
      latestLiveBuy: latestLiveBuy,
      bestSell: bestSell,
      bestBuy: bestBuy,
      spread: spread,
      avg7: avg7,
      avg30: avg30,
      change7vs30: change7vs30,
      volume7: volume7,
      volume30: volume30,
      recentClosed: recentClosed,
      visibleSellOrders: visibleSellOrders,
      visibleBuyOrders: visibleBuyOrders
    };
    model.insights = buildTimingInsights(model);
    return model;
  }

  function getSnapshotPrice(snapshot) {
    if (!snapshot) return null;
    var sellPrice = getOrderPlatinum(snapshot.bestSell);
    if (sellPrice !== null) return { value: sellPrice, source: 'lowest sell' };
    if (getNumberOrNull(snapshot.avg7) !== null) return { value: snapshot.avg7, source: '7D avg' };
    if (getNumberOrNull(snapshot.avg30) !== null) return { value: snapshot.avg30, source: '30D avg' };
    return { value: null, source: 'no price' };
  }

  function buildItemPriceSnapshot(item, statsPayload, orders) {
    var closedHistory = Array.isArray(statsPayload && statsPayload.statistics_closed && statsPayload.statistics_closed['90days'])
      ? statsPayload.statistics_closed['90days']
      : [];
    var closed7 = closedHistory.slice(-7);
    var closed30 = closedHistory.slice(-30);
    var visibleSellOrders = (Array.isArray(orders) ? orders : []).filter(function (order) {
      return order && order.visible !== false && order.order_type === 'sell';
    });
    var visibleBuyOrders = (Array.isArray(orders) ? orders : []).filter(function (order) {
      return order && order.visible !== false && order.order_type === 'buy';
    });

    var snapshot = {
      item: item,
      bestSell: getBestVisibleOrder(Array.isArray(orders) ? orders : [], 'sell'),
      bestBuy: getBestVisibleOrder(Array.isArray(orders) ? orders : [], 'buy'),
      avg7: getWeightedAverage(closed7, 'wa_price'),
      avg30: getWeightedAverage(closed30, 'wa_price'),
      volume7: getVolumeTotal(closed7),
      volume30: getVolumeTotal(closed30),
      visibleSellOrders: visibleSellOrders,
      visibleBuyOrders: visibleBuyOrders,
      error: ''
    };
    var price = getSnapshotPrice(snapshot);
    snapshot.price = price.value;
    snapshot.priceSource = price.source;
    return snapshot;
  }

  async function buildPrimeSetPartSnapshot(part, forceRefresh) {
    try {
      var results = await Promise.all([
        fetchItemStatistics(part.slug, !!forceRefresh).catch(function () { return null; }),
        fetchOrdersForAnalytics(part.slug, !!forceRefresh).catch(function () { return []; })
      ]);
      return buildItemPriceSnapshot(part, results[0], results[1]);
    } catch (err) {
      return {
        item: part,
        bestSell: null,
        bestBuy: null,
        avg7: null,
        avg30: null,
        volume7: 0,
        volume30: 0,
        visibleSellOrders: [],
        visibleBuyOrders: [],
        price: null,
        priceSource: 'failed',
        error: err && err.message ? err.message : 'Could not price part'
      };
    }
  }

  async function buildPrimeSetProfitModel(setModel, forceRefresh) {
    if (!setModel || !isPrimeSetItem(setModel.item)) return null;

    var parts = findPrimeSetParts(setModel.item);
    var setSnapshot = {
      item: setModel.item,
      bestSell: setModel.bestSell,
      bestBuy: setModel.bestBuy,
      avg7: setModel.avg7,
      avg30: setModel.avg30,
      volume7: setModel.volume7,
      volume30: setModel.volume30,
      visibleSellOrders: setModel.visibleSellOrders,
      visibleBuyOrders: setModel.visibleBuyOrders
    };
    var setPrice = getSnapshotPrice(setSnapshot);

    var snapshots = await Promise.all(parts.map(function (part) {
      return buildPrimeSetPartSnapshot(part, !!forceRefresh);
    }));

    var pricedParts = snapshots.filter(function (snapshot) {
      return getNumberOrNull(snapshot.price) !== null;
    });
    var partsTotal = pricedParts.reduce(function (total, snapshot) {
      return total + Number(snapshot.price || 0);
    }, 0);
    var setValue = getNumberOrNull(setPrice.value);
    var partsValue = pricedParts.length > 0 ? partsTotal : null;
    var delta = setValue !== null && partsValue !== null ? partsValue - setValue : null;
    var route = 'Need more prices';
    if (delta !== null) {
      if (Math.abs(delta) < 1) {
        route = 'Either route is close';
      } else {
        route = delta > 0 ? 'Sell parts separately' : 'Sell the full set';
      }
    } else if (partsValue !== null) {
      route = 'Parts have clearer pricing';
    } else if (setValue !== null) {
      route = 'Set has clearer pricing';
    }

    return {
      setItem: setModel.item,
      parts: snapshots,
      pricedParts: pricedParts.length,
      totalParts: snapshots.length,
      setValue: setValue,
      setSource: setPrice.source,
      partsValue: partsValue,
      delta: delta,
      deltaPercent: delta !== null && setValue > 0 ? (delta / setValue) * 100 : null,
      route: route,
      allPartsPriced: snapshots.length > 0 && pricedParts.length === snapshots.length
    };
  }

  function renderTradeAnalyticsSearchResults() {
    var container = $('#trade-analytics-search-results');
    var summary = $('#trade-analytics-search-summary');
    if (!container) return;

    container.textContent = '';

    if (!marketItems.length) {
      container.appendChild(createAnalyticsPlaceholder('Unable to load the market catalog right now.'));
      if (summary) summary.textContent = 'Market catalog unavailable.';
      return;
    }

    var query = normalizeMarketName(analyticsSearchQuery);
    var results = getAnalyticsSearchResults();

    if (summary) {
      if (query) {
        summary.textContent = results.length > 0
          ? ('Showing ' + results.length + ' match' + (results.length === 1 ? '' : 'es') + ' for "' + analyticsSearchQuery + '".')
          : ('No market matches for "' + analyticsSearchQuery + '".');
      } else {
        summary.textContent = 'Quick picks from active public trading items.';
      }
    }

    if (results.length === 0) {
      container.appendChild(createAnalyticsPlaceholder('No matching items found. Try a different search term.'));
      return;
    }

    for (var i = 0; i < results.length; i++) {
      var item = results[i];
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'trade-analytics-result-item' + (item.slug === analyticsSelectedSlug ? ' active' : '');

      var thumb = document.createElement('div');
      thumb.className = 'trade-analytics-result-thumb';
      var imagePath = getMarketDisplayImage(item);
      if (imagePath) {
        var img = document.createElement('img');
        img.src = getMarketItemImageUrl(item, imagePath);
        img.alt = item.name;
        img.loading = 'lazy';
        img.addEventListener('error', function () {
          img.style.display = 'none';
        });
        thumb.appendChild(img);
      } else {
        var ph = document.createElement('span');
        ph.className = 'material-icons-round';
        ph.textContent = 'insights';
        thumb.appendChild(ph);
      }

      var copy = document.createElement('div');
      copy.className = 'trade-analytics-result-copy';
      var name = document.createElement('div');
      name.className = 'trade-analytics-result-name';
      name.textContent = item.name;
      var meta = document.createElement('div');
      meta.className = 'trade-analytics-result-meta';
      var tag = document.createElement('span');
      tag.className = 'trade-analytics-result-tag';
      tag.textContent = item.category.replace(/_/g, ' ');
      meta.appendChild(tag);
      copy.appendChild(name);
      copy.appendChild(meta);

      btn.appendChild(thumb);
      btn.appendChild(copy);
      btn.addEventListener('click', function (targetItem) {
        return function () {
          selectAnalyticsItem(targetItem, false);
        };
      }(item));
      container.appendChild(btn);
    }
  }

  function createInsightCard(config) {
    var card = document.createElement('div');
    card.className = 'trade-analytics-insight-card' + (config.kind ? ' ' + config.kind : '');

    var kicker = document.createElement('div');
    kicker.className = 'trade-analytics-insight-kicker';
    kicker.textContent = config.kicker || '';
    card.appendChild(kicker);

    var title = document.createElement('div');
    title.className = 'trade-analytics-insight-title';
    title.textContent = config.title || '--';
    card.appendChild(title);

    var body = document.createElement('div');
    body.className = 'trade-analytics-insight-body';
    body.textContent = config.body || '';
    card.appendChild(body);

    if (Array.isArray(config.tags) && config.tags.length) {
      var tagWrap = document.createElement('div');
      tagWrap.className = 'trade-analytics-insight-tags';
      for (var i = 0; i < config.tags.length; i++) {
        var tag = document.createElement('span');
        tag.className = 'trade-analytics-insight-tag';
        tag.textContent = config.tags[i];
        tagWrap.appendChild(tag);
      }
      card.appendChild(tagWrap);
    }

    return card;
  }

  function setPrimeSetCalculatorVisibility(visible) {
    var card = $('#trade-analytics-prime-set-card');
    if (card) card.classList.toggle('hidden', !visible);
  }

  function renderPrimeSetProfitLoading(item) {
    var container = $('#trade-analytics-prime-set');
    if (!container) return;
    if (!isPrimeSetItem(item)) {
      setPrimeSetCalculatorVisibility(false);
      container.textContent = '';
      return;
    }

    setPrimeSetCalculatorVisibility(true);
    container.textContent = '';
    var loading = document.createElement('div');
    loading.className = 'trade-analytics-empty-message';
    loading.textContent = 'Calculating full set vs part prices from live market data...';
    container.appendChild(loading);
  }

  function renderPrimeSetProfitError(message) {
    var container = $('#trade-analytics-prime-set');
    if (!container) return;
    setPrimeSetCalculatorVisibility(true);
    container.textContent = '';
    var error = document.createElement('div');
    error.className = 'trade-analytics-empty-message';
    error.textContent = message || 'Could not calculate Prime set profit right now.';
    container.appendChild(error);
  }

  function createPrimeProfitMetric(labelText, valueText, detailText, kind) {
    var card = document.createElement('div');
    card.className = 'prime-profit-metric' + (kind ? ' ' + kind : '');

    var label = document.createElement('div');
    label.className = 'prime-profit-label';
    label.textContent = labelText;

    var value = document.createElement('div');
    value.className = 'prime-profit-value';
    value.textContent = valueText;

    var detail = document.createElement('div');
    detail.className = 'prime-profit-detail';
    detail.textContent = detailText;

    card.appendChild(label);
    card.appendChild(value);
    card.appendChild(detail);
    return card;
  }

  function renderPrimeSetProfit(model) {
    var container = $('#trade-analytics-prime-set');
    if (!container) return;

    if (!model) {
      setPrimeSetCalculatorVisibility(false);
      container.textContent = '';
      return;
    }

    setPrimeSetCalculatorVisibility(true);
    container.textContent = '';

    if (!model.parts.length) {
      var empty = document.createElement('div');
      empty.className = 'trade-analytics-empty-message';
      empty.textContent = 'No matching Prime parts were found for this set in the market catalog.';
      container.appendChild(empty);
      return;
    }

    var summary = document.createElement('div');
    summary.className = 'prime-profit-summary';

    summary.appendChild(createPrimeProfitMetric(
      'Full Set Value',
      formatPlatValue(model.setValue),
      'Source: ' + model.setSource,
      'is-set'
    ));

    summary.appendChild(createPrimeProfitMetric(
      'Parts Total',
      formatPlatValue(model.partsValue),
      model.pricedParts + '/' + model.totalParts + ' parts priced',
      'is-parts'
    ));

    var deltaText = model.delta !== null ? formatSignedPlatValue(model.delta) : '--';
    var deltaDetail = model.deltaPercent !== null
      ? formatPercentValue(model.deltaPercent) + ' vs full set'
      : 'Waiting for enough comparable prices';
    summary.appendChild(createPrimeProfitMetric(
      'Best Route',
      model.route,
      deltaText + ' | ' + deltaDetail,
      model.delta > 0 ? 'is-positive' : (model.delta < 0 ? 'is-warning' : '')
    ));

    container.appendChild(summary);

    var note = document.createElement('div');
    note.className = 'prime-profit-note';
    note.textContent = 'Calculator uses the lowest visible sell order first. If a listing is missing, it falls back to the recent 7D/30D weighted average so the comparison still works.';
    container.appendChild(note);

    var table = document.createElement('table');
    table.className = 'prime-profit-table';
    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    ['Part', 'Price', 'Source', '7D Avg', 'Live Orders'].forEach(function (labelText) {
      var th = document.createElement('th');
      th.textContent = labelText;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    for (var i = 0; i < model.parts.length; i++) {
      var snapshot = model.parts[i];
      var tr = document.createElement('tr');
      var cells = [
        { text: snapshot.item && snapshot.item.name ? snapshot.item.name : 'Unknown part', cls: 'is-strong' },
        { text: formatPlatValue(snapshot.price), cls: getNumberOrNull(snapshot.price) !== null ? 'is-accent' : '' },
        { text: snapshot.error ? snapshot.error : snapshot.priceSource },
        { text: formatPlatValue(snapshot.avg7) },
        { text: snapshot.visibleSellOrders.length + ' sell / ' + snapshot.visibleBuyOrders.length + ' buy' }
      ];
      for (var c = 0; c < cells.length; c++) {
        var td = document.createElement('td');
        td.textContent = cells[c].text;
        if (cells[c].cls) td.classList.add(cells[c].cls);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    container.appendChild(table);
  }

  function renderTradeAnalyticsInsights(model, container) {
    if (!container) return;
    container.textContent = '';

    if (!model || !model.insights) {
      container.appendChild(createInsightCard({
        kicker: 'Market Timing',
        title: 'Waiting for data',
        body: 'Choose an item to load buy timing, sell timing, liquidity, and order-wall signals.'
      }));
      return;
    }

    var insights = model.insights;
    var buyDay = formatBucketLabel(insights.bestBuyDay, 'weekday');
    var sellDay = formatBucketLabel(insights.bestSellDay, 'weekday');
    var buyHour = formatBucketLabel(insights.bestBuyHour, 'hour');
    var sellHour = formatBucketLabel(insights.bestSellHour, 'hour');
    var currentSellText = formatPlatValue(model.bestSell && model.bestSell.platinum);
    var currentBuyText = formatPlatValue(model.bestBuy && model.bestBuy.platinum);
    var trendText = insights.trendPercent !== null ? formatPercentValue(insights.trendPercent) : '--';
    var discountText = insights.discountVs30 !== null ? formatPercentValue(insights.discountVs30) : '--';
    var spreadText = insights.spreadPercent !== null ? formatPercentValue(insights.spreadPercent) : '--';
    var fairText = formatPlatValue(insights.fairValue);
    var askVsFairText = insights.askVsFair !== null ? formatPercentValue(insights.askVsFair) : '--';
    var flipText = insights.quickFlipMargin !== null ? formatSignedPlatValue(insights.quickFlipMargin) : '--';

    container.appendChild(createInsightCard({
      kind: 'is-buy',
      kicker: 'Best Time To Buy',
      title: insights.buyLabel,
      body: 'Cheaper day: ' + buyDay + ' (' + getBucketPriceLabel(insights.bestBuyDay) + '). Best 48h sell window: ' + buyHour + ' (' + getBucketPriceLabel(insights.bestBuyHour) + '). Current lowest sell is ' + currentSellText + ', ' + discountText + ' versus the 30D average.',
      tags: ['Buy ' + Math.round(insights.buyScore) + '/100', 'Ask vs fair ' + askVsFairText]
    }));

    container.appendChild(createInsightCard({
      kind: 'is-sell',
      kicker: 'Best Time To Sell',
      title: insights.sellLabel,
      body: 'Stronger day: ' + sellDay + ' (' + getBucketPriceLabel(insights.bestSellDay) + '). Best 48h buy window: ' + sellHour + ' (' + getBucketPriceLabel(insights.bestSellHour) + '). Current highest buy is ' + currentBuyText + '; list patiently when sell score beats buy score.',
      tags: ['Sell ' + Math.round(insights.sellScore) + '/100', 'Trend ' + trendText]
    }));

    container.appendChild(createInsightCard({
      kind: insights.liquidity.risk === 'High risk' ? 'is-risk' : '',
      kicker: 'Liquidity & Risk',
      title: insights.liquidity.label,
      body: insights.liquidity.detail + ' 7D volume is ' + formatMetricNumber(model.volume7) + ' with ' + formatMetricNumber(model.visibleSellOrders.length + model.visibleBuyOrders.length) + ' visible orders.',
      tags: [insights.liquidity.risk, '30D volume ' + formatMetricNumber(model.volume30)]
    }));

    container.appendChild(createInsightCard({
      kicker: 'Order Walls',
      title: insights.sellWall.count + ' sellers / ' + insights.buyWall.count + ' buyers',
      body: insights.sellWall.quantity + ' sell quantity sits within 5% of the cheapest sell. ' + insights.buyWall.quantity + ' buy quantity sits within 5% of the best buy. Big walls usually slow price movement.',
      tags: ['Sell wall ' + insights.sellWall.quantity, 'Buy wall ' + insights.buyWall.quantity]
    }));

    container.appendChild(createInsightCard({
      kicker: 'Pressure & Confidence',
      title: insights.pressureLabel,
      body: 'Fair value estimate is ' + fairText + '. The current instant flip margin is ' + flipText + ' before trading friction. Confidence is based on order depth, recent volume, spread, and history coverage.',
      tags: ['Confidence ' + Math.round(insights.confidenceScore) + '/100', 'Spread ' + spreadText]
    }));
  }

  function renderTradeAnalyticsOverview(model) {
    var emptyState = $('#trade-analytics-empty-state');
    var overview = $('#trade-analytics-overview');
    var img = $('#trade-analytics-selected-img');
    var placeholder = $('#trade-analytics-selected-placeholder');
    var nameEl = $('#trade-analytics-selected-name');
    var categoryEl = $('#trade-analytics-selected-category');
    var updatedEl = $('#trade-analytics-selected-updated');
    var insightGrid = $('#trade-analytics-insights');
    var statGrid = $('#trade-analytics-stat-grid');

    if (!model) {
      if (emptyState) emptyState.classList.remove('hidden');
      if (overview) overview.classList.add('hidden');
      return;
    }

    if (emptyState) emptyState.classList.add('hidden');
    if (overview) overview.classList.remove('hidden');

    var resolvedItemImageUrl = getMarketItemImageUrl(model.item);
    if (img) {
      if (resolvedItemImageUrl) {
        img.src = resolvedItemImageUrl;
      } else {
        img.removeAttribute('src');
      }
      img.alt = model.item.name;
      img.classList.toggle('hidden', !resolvedItemImageUrl);
      img.onerror = function () {
        img.classList.add('hidden');
        if (placeholder) placeholder.classList.remove('hidden');
      };
      img.onload = function () {
        img.classList.remove('hidden');
        if (placeholder) placeholder.classList.add('hidden');
      };
    }
    if (placeholder) placeholder.classList.toggle('hidden', !!resolvedItemImageUrl);
    if (nameEl) nameEl.textContent = model.item.name;
    if (categoryEl) categoryEl.textContent = model.item.category.replace(/_/g, ' ');
    if (updatedEl) {
      var updatedFrom = (model.latestLiveSell && model.latestLiveSell.datetime) ||
        (model.latestLiveBuy && model.latestLiveBuy.datetime) ||
        (model.latestClosed && model.latestClosed.datetime) ||
        '';
      updatedEl.textContent = formatAnalyticsTimestamp(updatedFrom);
    }

    renderTradeAnalyticsInsights(model, insightGrid);

    if (!statGrid) return;
    statGrid.textContent = '';

    var statItems = [
      {
        label: 'Buy Score',
        value: model.insights ? Math.round(model.insights.buyScore) + '/100' : '--',
        detail: model.insights ? model.insights.buyLabel : 'Waiting for live market timing',
        kind: model.insights && model.insights.buyScore >= 70 ? 'is-positive' : ''
      },
      {
        label: 'Sell Score',
        value: model.insights ? Math.round(model.insights.sellScore) + '/100' : '--',
        detail: model.insights ? model.insights.sellLabel : 'Waiting for live market timing',
        kind: model.insights && model.insights.sellScore >= 70 ? 'is-positive' : ''
      },
      {
        label: 'Lowest Sell',
        value: formatPlatValue(model.bestSell && model.bestSell.platinum),
        detail: model.visibleSellOrders.length + ' visible sell orders'
      },
      {
        label: 'Highest Buy',
        value: formatPlatValue(model.bestBuy && model.bestBuy.platinum),
        detail: model.visibleBuyOrders.length + ' visible buy orders'
      },
      {
        label: 'Spread',
        value: formatPlatValue(model.spread),
        detail: (model.bestSell && model.bestBuy) ? 'Lowest sell minus highest buy' : 'Need both live buy and sell orders'
      },
      {
        label: '7D Closed Avg',
        value: formatPlatValue(model.avg7),
        detail: isFinite(model.change7vs30) ? ('vs 30D avg ' + formatSignedPlatValue(model.change7vs30)) : 'Compare against 30-day weighted average',
        kind: isFinite(model.change7vs30) ? (model.change7vs30 > 0 ? 'is-positive' : (model.change7vs30 < 0 ? 'is-negative' : '')) : ''
      },
      {
        label: '30D Closed Avg',
        value: formatPlatValue(model.avg30),
        detail: model.latestClosed ? ('Latest close ' + formatPlatValue(model.latestClosed.closed_price || model.latestClosed.avg_price) + ' on ' + formatAnalyticsDate(model.latestClosed.datetime)) : 'No recent closed history available'
      },
      {
        label: '7D Volume',
        value: formatMetricNumber(model.volume7),
        detail: '30D volume ' + formatMetricNumber(model.volume30)
      },
      {
        label: 'Market Risk',
        value: model.insights ? model.insights.liquidity.risk : '--',
        detail: model.insights ? model.insights.liquidity.label : 'Waiting for order depth'
      },
      {
        label: 'Fair Value',
        value: model.insights ? formatPlatValue(model.insights.fairValue) : '--',
        detail: model.insights && model.insights.askVsFair !== null ? ('Lowest sell is ' + formatPercentValue(model.insights.askVsFair) + ' vs fair value') : 'Weighted from live orders and recent history'
      },
      {
        label: 'Pressure',
        value: model.insights ? model.insights.pressureLabel : '--',
        detail: model.insights ? ('Buy/sell order ratio ' + (isFinite(model.insights.demandRatio) ? model.insights.demandRatio.toFixed(model.insights.demandRatio >= 10 ? 0 : 2) : '--')) : 'Waiting for live orders'
      },
      {
        label: 'Confidence',
        value: model.insights ? Math.round(model.insights.confidenceScore) + '/100' : '--',
        detail: 'Higher means price and timing signals have better market coverage',
        kind: model.insights && model.insights.confidenceScore >= 70 ? 'is-positive' : (model.insights && model.insights.confidenceScore < 40 ? 'is-negative' : '')
      }
    ];

    for (var i = 0; i < statItems.length; i++) {
      var card = document.createElement('div');
      card.className = 'trade-analytics-stat-card';
      var label = document.createElement('div');
      label.className = 'trade-analytics-stat-label';
      label.textContent = statItems[i].label;
      var value = document.createElement('div');
      value.className = 'trade-analytics-stat-value';
      if (statItems[i].kind) value.classList.add(statItems[i].kind);
      value.textContent = statItems[i].value;
      var detail = document.createElement('div');
      detail.className = 'trade-analytics-stat-detail';
      detail.textContent = statItems[i].detail;
      card.appendChild(label);
      card.appendChild(value);
      card.appendChild(detail);
      statGrid.appendChild(card);
    }
  }

  function renderTradeAnalyticsTable(targetId, headers, rows, emptyText) {
    var container = $(targetId);
    if (!container) return;
    container.textContent = '';

    if (!Array.isArray(rows) || rows.length === 0) {
      container.appendChild(createAnalyticsPlaceholder(emptyText));
      return;
    }

    var table = document.createElement('table');
    table.className = 'trade-analytics-table';

    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    for (var i = 0; i < headers.length; i++) {
      var th = document.createElement('th');
      th.textContent = headers[i];
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    for (var r = 0; r < rows.length; r++) {
      var tr = document.createElement('tr');
      for (var c = 0; c < rows[r].length; c++) {
        var cell = rows[r][c] || {};
        var td = document.createElement('td');
        td.textContent = cell.text || '--';
        if (cell.strong) td.classList.add('is-strong');
        if (cell.accent) td.classList.add('is-accent');
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    container.appendChild(table);
  }

  function renderTradeAnalyticsHistory(model) {
    if (!model) {
      renderTradeAnalyticsTable('#trade-analytics-history', [], [], 'Choose an item to inspect its recent closed history.');
      return;
    }

    var rows = model.recentClosed.map(function (entry) {
      var low = isFinite(Number(entry.min_price)) ? Number(entry.min_price) : null;
      var high = isFinite(Number(entry.max_price)) ? Number(entry.max_price) : null;
      return [
        { text: formatAnalyticsDate(entry.datetime), strong: true },
        { text: formatPlatValue(entry.avg_price), accent: true },
        { text: formatPlatValue(entry.closed_price) },
        { text: formatMetricNumber(entry.volume) },
        { text: (low !== null && high !== null) ? (formatPlatValue(low) + ' - ' + formatPlatValue(high)) : '--' }
      ];
    });

    renderTradeAnalyticsTable(
      '#trade-analytics-history',
      ['Date', 'Avg', 'Close', 'Volume', 'Range'],
      rows,
      'No closed history available for this item yet.'
    );
  }

  function renderTradeAnalyticsLive(model) {
    if (!model) {
      renderTradeAnalyticsTable('#trade-analytics-live', [], [], 'Choose an item to inspect its live buy and sell pressure.');
      return;
    }

    var sell = model.latestLiveSell || {};
    var buy = model.latestLiveBuy || {};
    var rows = [
      [
        { text: 'Avg Price', strong: true },
        { text: formatPlatValue(sell.avg_price), accent: true },
        { text: formatPlatValue(buy.avg_price), accent: true }
      ],
      [
        { text: 'Weighted Avg', strong: true },
        { text: formatPlatValue(sell.wa_price) },
        { text: formatPlatValue(buy.wa_price) }
      ],
      [
        { text: 'Median', strong: true },
        { text: formatPlatValue(sell.median) },
        { text: formatPlatValue(buy.median) }
      ],
      [
        { text: 'Volume', strong: true },
        { text: formatMetricNumber(sell.volume) },
        { text: formatMetricNumber(buy.volume) }
      ],
      [
        { text: 'Moving Avg', strong: true },
        { text: formatPlatValue(sell.moving_avg) },
        { text: formatPlatValue(buy.moving_avg) }
      ],
      [
        { text: 'Best Current Order', strong: true },
        { text: formatPlatValue(model.bestSell && model.bestSell.platinum) },
        { text: formatPlatValue(model.bestBuy && model.bestBuy.platinum) }
      ],
      [
        { text: 'Visible Orders', strong: true },
        { text: formatMetricNumber(model.visibleSellOrders.length) },
        { text: formatMetricNumber(model.visibleBuyOrders.length) }
      ]
    ];

    renderTradeAnalyticsTable(
      '#trade-analytics-live',
      ['Signal', 'Sell Side', 'Buy Side'],
      rows,
      'No live market data available for this item yet.'
    );
  }

  function setTradeAnalyticsLoadingState(item) {
    analyticsCurrentItem = item || analyticsCurrentItem;
    renderPrimeSetProfitLoading(analyticsCurrentItem);
    renderTradeAnalyticsOverview({
      item: analyticsCurrentItem || { name: 'Loading...', category: 'market' },
      latestClosed: null,
      latestLiveSell: null,
      latestLiveBuy: null,
      bestSell: null,
      bestBuy: null,
      spread: null,
      avg7: null,
      avg30: null,
      change7vs30: null,
      volume7: 0,
      volume30: 0,
      visibleSellOrders: [],
      visibleBuyOrders: []
    });
    renderTradeAnalyticsTable('#trade-analytics-history', [], [], 'Loading recent closed history...');
    renderTradeAnalyticsTable('#trade-analytics-live', [], [], 'Loading live market pressure...');
  }

  function renderTradeAnalyticsError(item, message) {
    if (isPrimeSetItem(item)) {
      renderPrimeSetProfitError('Prime set calculator paused because analytics failed: ' + message);
    } else {
      renderPrimeSetProfit(null);
    }
    renderTradeAnalyticsOverview(null);
    renderTradeAnalyticsTable('#trade-analytics-history', [], [], 'Failed to load analytics for ' + (item && item.name ? item.name : 'this item') + ': ' + message);
    renderTradeAnalyticsTable('#trade-analytics-live', [], [], 'Try refreshing this item in a moment.');
  }

  async function selectAnalyticsItem(item, forceRefresh) {
    if (!item || !item.slug) return;

    analyticsSelectedSlug = item.slug;
    analyticsCurrentItem = item;
    renderTradeAnalyticsSearchResults();
    setTradeAnalyticsLoadingState(item);

    var token = ++analyticsRequestToken;
    try {
      var results = await Promise.all([
        fetchItemStatistics(item.slug, !!forceRefresh),
        fetchOrdersForAnalytics(item.slug, !!forceRefresh)
      ]);
      if (token !== analyticsRequestToken) return;

      var model = buildTradeAnalyticsModel(item, results[0], Array.isArray(results[1]) ? results[1] : []);
      renderTradeAnalyticsOverview(model);
      renderTradeAnalyticsHistory(model);
      renderTradeAnalyticsLive(model);
      if (isPrimeSetItem(item)) {
        renderPrimeSetProfitLoading(item);
        try {
          var profitModel = await buildPrimeSetProfitModel(model, !!forceRefresh);
          if (token !== analyticsRequestToken) return;
          renderPrimeSetProfit(profitModel);
        } catch (profitErr) {
          if (token !== analyticsRequestToken) return;
          renderPrimeSetProfitError(profitErr && profitErr.message ? profitErr.message : 'Could not calculate Prime set profit.');
        }
      } else {
        renderPrimeSetProfit(null);
      }
    } catch (err) {
      if (token !== analyticsRequestToken) return;
      renderTradeAnalyticsError(item, err && err.message ? err.message : 'Unknown error');
    }
  }

  async function loadTradeAnalytics(forceRefresh) {
    if (!marketItems.length) {
      await loadMarketItems();
    }

    renderTradeAnalyticsSearchResults();

    if (!marketItems.length) {
      renderTradeAnalyticsOverview(null);
      renderTradeAnalyticsHistory(null);
      renderTradeAnalyticsLive(null);
      renderPrimeSetProfit(null);
      return;
    }

    if (analyticsCurrentItem && analyticsCurrentItem.slug) {
      await selectAnalyticsItem(analyticsCurrentItem, !!forceRefresh);
      return;
    }

    var quickPicks = getAnalyticsQuickPickItems();
    if (quickPicks.length > 0) {
      await selectAnalyticsItem(quickPicks[0], !!forceRefresh);
    } else {
      renderTradeAnalyticsOverview(null);
      renderTradeAnalyticsHistory(null);
      renderTradeAnalyticsLive(null);
      renderPrimeSetProfit(null);
    }
  }

  function renderOrdersContent(container, sellOrders, buyOrders, itemMeta) {
    container.textContent = '';

    // If connected, render user orders and order creation form at the top
    if (wfmSession.token && wfmSession.user) {
      var userOrdersBlock = renderUserOrdersSection(sellOrders, buyOrders, itemMeta);
      container.appendChild(userOrdersBlock);
    }

    var itemName = itemMeta && itemMeta.name ? itemMeta.name : 'this item';
    var wikiUrl = itemMeta && itemMeta.wikiUrl ? itemMeta.wikiUrl : '';
    var showRankColumn = itemSupportsOrderRank(itemMeta, sellOrders, buyOrders);

    var allOnlineSellOrders = sellOrders.filter(isOnlineSeller);
    var inGameSellOrders = sellOrders.filter(isInGameSeller);
    var safeMode = ordersOnlineMode === 'ingame_only' ? 'ingame_only' : 'all_online';
    var filteredSellOrders = ordersOnlineOnly
      ? (safeMode === 'ingame_only' ? inGameSellOrders : allOnlineSellOrders)
      : sellOrders;

    // Stats
    if (filteredSellOrders.length > 0) {
      var prices = filteredSellOrders.map(function (o) { return o.platinum; });
      var min = Math.min.apply(null, prices);
      var max = Math.max.apply(null, prices);
      var avg = Math.round(prices.reduce(function (s, v) { return s + v; }, 0) / prices.length);

      var statsBar = document.createElement('div');
      statsBar.className = 'orders-stats';
      statsBar.innerHTML = '';
      var statItems = [
        { label: 'Lowest', value: min, cls: 'stat-low', platinum: true },
        { label: 'Average', value: avg, cls: 'stat-avg', platinum: true },
        { label: 'Highest', value: max, cls: 'stat-high', platinum: true },
        { label: 'Sellers', value: String(filteredSellOrders.length), cls: '' },
        { label: 'Buyers', value: String(buyOrders.length), cls: '' },
      ];
      for (var s = 0; s < statItems.length; s++) {
        var si = document.createElement('div');
        si.className = 'orders-stat-item ' + statItems[s].cls;
        var sl = document.createElement('span');
        sl.className = 'orders-stat-label';
        sl.textContent = statItems[s].label;
        var sv = document.createElement('span');
        sv.className = 'orders-stat-value';
        if (statItems[s].platinum) {
          sv.classList.add('has-platinum-icon');
          appendPlatinumAmount(sv, statItems[s].value, 'orders-stat-plat-number', 'orders-stat-plat-icon');
        } else {
          sv.textContent = statItems[s].value;
        }
        si.appendChild(sl);
        si.appendChild(sv);
        statsBar.appendChild(si);
      }
      container.appendChild(statsBar);
    }

    var filterWrap = document.createElement('div');
    filterWrap.className = 'orders-filter-wrap';

    var legend = document.createElement('div');
    legend.className = 'orders-status-legend';
    var legendIngame = document.createElement('span');
    legendIngame.className = 'orders-status-legend-item';
    legendIngame.innerHTML = '<span class="status-dot status-ingame"></span>In Game';
    var legendOnline = document.createElement('span');
    legendOnline.className = 'orders-status-legend-item';
    legendOnline.innerHTML = '<span class="status-dot status-online"></span>Online';
    legend.appendChild(legendIngame);
    legend.appendChild(legendOnline);

    var filterLinks = document.createElement('div');
    filterLinks.className = 'orders-filter-links';

    if (wikiUrl) {
      var wikiBtn = document.createElement('button');
      wikiBtn.type = 'button';
      wikiBtn.className = 'orders-wiki-link';

      var wikiIcon = document.createElement('span');
      wikiIcon.className = 'material-icons-round';
      wikiIcon.textContent = 'open_in_new';

      var wikiLabel = document.createElement('span');
      wikiLabel.textContent = 'Wiki';

      wikiBtn.appendChild(wikiIcon);
      wikiBtn.appendChild(wikiLabel);
      wikiBtn.addEventListener('click', function () {
        window.open(wikiUrl, '_blank', 'noopener');
      });

      filterLinks.appendChild(wikiBtn);
    }

    var filterControls = document.createElement('div');
    filterControls.className = 'orders-filter-controls';

    var filterBtn = document.createElement('button');
    filterBtn.className = 'orders-online-filter' + (ordersOnlineOnly ? ' active' : '');
    filterBtn.textContent = ordersOnlineOnly ? 'Online Sellers Only: ON' : 'Online Sellers Only: OFF';
    filterBtn.addEventListener('click', function () {
      ordersOnlineOnly = !ordersOnlineOnly;
      renderOrdersContent(container, sellOrders, buyOrders, itemMeta);
    });

    var scopeSelect = document.createElement('select');
    scopeSelect.className = 'orders-online-scope';
    scopeSelect.disabled = !ordersOnlineOnly;
    var optAllOnline = document.createElement('option');
    optAllOnline.value = 'all_online';
    optAllOnline.textContent = 'All Online (' + allOnlineSellOrders.length + ')';
    var optInGameOnly = document.createElement('option');
    optInGameOnly.value = 'ingame_only';
    optInGameOnly.textContent = 'In Game Only (' + inGameSellOrders.length + ')';
    scopeSelect.appendChild(optAllOnline);
    scopeSelect.appendChild(optInGameOnly);
    scopeSelect.value = safeMode;
    scopeSelect.addEventListener('change', function () {
      ordersOnlineMode = scopeSelect.value;
      renderOrdersContent(container, sellOrders, buyOrders, itemMeta);
    });

    filterControls.appendChild(filterBtn);
    filterControls.appendChild(scopeSelect);
    filterWrap.appendChild(legend);
    filterWrap.appendChild(filterLinks);
    filterWrap.appendChild(filterControls);
    container.appendChild(filterWrap);

    // Tabs
    var tabsWrap = document.createElement('div');
    tabsWrap.className = 'orders-tabs';
    var sellTab = document.createElement('button');
    sellTab.className = 'orders-tab active';
    sellTab.textContent = 'Sellers (' + filteredSellOrders.length + ')';
    var buyTab = document.createElement('button');
    buyTab.className = 'orders-tab';
    buyTab.textContent = 'Buyers (' + buyOrders.length + ')';
    tabsWrap.appendChild(sellTab);
    tabsWrap.appendChild(buyTab);
    container.appendChild(tabsWrap);

    // Order lists
    var sellList = createOrderList(filteredSellOrders, 'sell', itemName, showRankColumn);
    var buyList = createOrderList(buyOrders, 'buy', itemName, showRankColumn);
    buyList.classList.add('hidden');
    container.appendChild(sellList);
    container.appendChild(buyList);

    sellTab.addEventListener('click', function () {
      sellTab.classList.add('active');
      buyTab.classList.remove('active');
      sellList.classList.remove('hidden');
      buyList.classList.add('hidden');
    });
    buyTab.addEventListener('click', function () {
      buyTab.classList.add('active');
      sellTab.classList.remove('active');
      buyList.classList.remove('hidden');
      sellList.classList.add('hidden');
    });
  }

  function createOrderList(orders, type, itemName, showRankColumn) {
    var list = document.createElement('div');
    list.className = 'orders-list';

    if (orders.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'orders-empty';
      empty.textContent = 'No ' + type + ' orders available';
      list.appendChild(empty);
      return list;
    }

    // Header
    var header = document.createElement('div');
    header.className = 'order-row order-header' + (showRankColumn ? ' has-rank' : '');
    var cols = showRankColumn
      ? ['Status', 'Player', 'Rank', 'Rep', 'Price', 'Quantity', 'Action']
      : ['Status', 'Player', 'Rep', 'Price', 'Quantity', 'Action'];
    for (var h = 0; h < cols.length; h++) {
      var hd = document.createElement('div');
      hd.className = 'order-col';
      hd.textContent = cols[h];
      header.appendChild(hd);
    }
    list.appendChild(header);

    for (var i = 0; i < orders.length; i++) {
      var o = orders[i];
      var row = document.createElement('div');
      row.className = 'order-row' + (showRankColumn ? ' has-rank' : '');

      // Status dot
      var statusCol = document.createElement('div');
      statusCol.className = 'order-col';
      var dot = document.createElement('span');
      var status = o.user ? o.user.status : 'offline';
      dot.className = 'status-dot status-' + status;
      dot.title = status;
      statusCol.appendChild(dot);

      // Player
      var playerCol = document.createElement('div');
      playerCol.className = 'order-col order-player';
      playerCol.textContent = wfmIngameName(o.user) || 'Unknown';

      var rankCol = null;
      if (showRankColumn) {
        rankCol = document.createElement('div');
        rankCol.className = 'order-col order-rank';
        rankCol.textContent = formatOrderRank(o);
      }

      // Reputation
      var repCol = document.createElement('div');
      repCol.className = 'order-col order-rep';
      repCol.textContent = formatReputation(getOrderReputation(o));

      // Price
      var priceCol = document.createElement('div');
      priceCol.className = 'order-col order-price';
      appendPlatinumAmount(priceCol, o.platinum, 'plat-value', 'plat-icon');

      // Quantity
      var qtyCol = document.createElement('div');
      qtyCol.className = 'order-col';
      qtyCol.textContent = o.quantity || 1;

      var actionCol = document.createElement('div');
      actionCol.className = 'order-col order-action';
      var actionBtn = document.createElement('button');
      actionBtn.className = 'btn btn-secondary order-action-btn';
      actionBtn.type = 'button';
      actionBtn.textContent = type === 'sell' ? 'Buy' : 'Sell';
      actionBtn.addEventListener('click', function (order, orderType, orderItemName) {
        return function (event) {
          event.stopPropagation();
          copyWhisper(order, orderType, orderItemName);
        };
      }(o, type, itemName));
      actionCol.appendChild(actionBtn);

      row.appendChild(statusCol);
      row.appendChild(playerCol);
      if (rankCol) row.appendChild(rankCol);
      row.appendChild(repCol);
      row.appendChild(priceCol);
      row.appendChild(qtyCol);
      row.appendChild(actionCol);

      list.appendChild(row);
    }

    return list;
  }

  function buildWhisperMessage(order, orderType, itemName) {
    var player = wfmIngameName(order && order.user) || 'Unknown';
    var price = order && typeof order.platinum !== 'undefined' ? String(order.platinum) : '?';
    var rank = getOrderRankValue(order);
    var rankedItemName = rank === null ? itemName : (itemName + ' rank ' + rank);
    if (orderType === 'sell') {
      return '/w ' + player + ' Hi! I want to buy your ' + rankedItemName + ' for ' + price + ' platinum. (warframe companion app)';
    }
    return '/w ' + player + ' Hi! I want to sell ' + rankedItemName + ' for ' + price + ' platinum. (warframe companion app)';
  }

  async function copyWhisper(order, orderType, itemName) {
    try {
      var message = buildWhisperMessage(order, orderType, itemName);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(message);
      } else {
        var ta = document.createElement('textarea');
        ta.value = message;
        ta.setAttribute('readonly', 'readonly');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      showCopyToast((orderType === 'sell' ? 'Buy' : 'Sell') + ' whisper copied');
    } catch (err) {
      showCopyToast('Copy failed');
    }
  }

  function showCopyToast(text) {
    var existing = document.querySelector('.orders-copy-toast');
    if (existing) existing.remove();

    var toast = document.createElement('div');
    toast.className = 'orders-copy-toast';
    toast.textContent = text;

    var modal = $('#market-orders-modal .modal');
    if (!modal) return;
    modal.appendChild(toast);

    setTimeout(function () {
      toast.classList.add('show');
    }, 10);

    setTimeout(function () {
      toast.classList.remove('show');
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 220);
    }, 1400);
  }

  function resetContractsFilters(nextType) {
    contractsFilters = createDefaultContractsFilters(nextType || contractsFilters.type);
    contractsResults = [];
    contractsCoverageNote = '';
    contractsError = '';
    contractsHasSearched = false;
    contractsVisibleCount = CONTRACT_RESULTS_BATCH_SIZE;
  }

  function handleContractsViewClick(event) {
    var typeBtn = event.target.closest('[data-contract-type]');
    if (typeBtn) {
      resetContractsFilters(typeBtn.dataset.contractType);
      renderContractsView();
      return;
    }

    var contactBtn = event.target.closest('[data-contract-auction-id]');
    if (contactBtn) {
      copyContractWhisper(findContractAuctionById(contactBtn.dataset.contractAuctionId));
      return;
    }

    if (event.target.id === 'contracts-apply-btn') {
      searchContracts();
      return;
    }

    if (event.target.id === 'contracts-reset-btn') {
      resetContractsFilters();
      renderContractsView();
      return;
    }

    if (event.target.id === 'contracts-load-more-btn') {
      contractsVisibleCount += CONTRACT_RESULTS_BATCH_SIZE;
      refreshContractsResults();
    }
  }

  function handleContractsViewChange(event) {
    var target = event.target;
    if (!target) return;

    if (target.id === 'contracts-weapon-select') {
      contractsFilters.weaponUrlName = target.value;
      contractsResults = [];
      contractsCoverageNote = '';
      contractsError = '';
      contractsHasSearched = false;
      contractsVisibleCount = CONTRACT_RESULTS_BATCH_SIZE;
      if (contractsFilters.type === 'riven') {
        contractsFilters.positiveStats = ['', '', ''];
        contractsFilters.negativeStat = '';
      }
      renderContractsView();
      return;
    }

    if (target.id === 'contracts-positive-0' || target.id === 'contracts-positive-1' || target.id === 'contracts-positive-2') {
      var index = Number(String(target.id).slice(-1));
      contractsFilters.positiveStats[index] = target.value;
      contractsResults = [];
      contractsCoverageNote = '';
      contractsError = '';
      contractsHasSearched = false;
      contractsVisibleCount = CONTRACT_RESULTS_BATCH_SIZE;
      renderContractsView();
      return;
    }

    if (target.id === 'contracts-negative-select') {
      contractsFilters.negativeStat = target.value;
      contractsResults = [];
      contractsCoverageNote = '';
      contractsError = '';
      contractsHasSearched = false;
      contractsVisibleCount = CONTRACT_RESULTS_BATCH_SIZE;
      renderContractsView();
      return;
    }

    if (target.id === 'contracts-rank-select') {
      contractsFilters.modRank = target.value || 'any';
      contractsResults = [];
      contractsCoverageNote = '';
      contractsError = '';
      contractsHasSearched = false;
      contractsVisibleCount = CONTRACT_RESULTS_BATCH_SIZE;
      renderContractsView();
      return;
    }

    if (target.id === 'contracts-element-select') {
      contractsFilters.element = target.value;
      contractsResults = [];
      contractsCoverageNote = '';
      contractsError = '';
      contractsHasSearched = false;
      contractsVisibleCount = CONTRACT_RESULTS_BATCH_SIZE;
      if (contractsFilters.ephemera) {
        var selectedEphemera = findLookupByUrl(getContractsEphemeraOptions(), contractsFilters.ephemera);
        if (selectedEphemera && selectedEphemera.element !== contractsFilters.element) {
          contractsFilters.ephemera = '';
        }
      }
      renderContractsView();
      return;
    }

    if (target.id === 'contracts-ephemera-select') {
      contractsFilters.ephemera = target.value;
      contractsResults = [];
      contractsCoverageNote = '';
      contractsError = '';
      contractsHasSearched = false;
      contractsVisibleCount = CONTRACT_RESULTS_BATCH_SIZE;
      var ephemera = findLookupByUrl(getContractsEphemeraOptions(), contractsFilters.ephemera);
      if (ephemera && ephemera.element) {
        contractsFilters.element = ephemera.element;
      }
      renderContractsView();
      return;
    }

    if (target.id === 'contracts-sort-select') {
      contractsFilters.sortBy = target.value || 'price_asc';
      refreshContractsResults();
    }
  }

  function handleContractsViewInput(event) {
    var target = event.target;
    if (!target) return;

    if (target.id === 'contracts-quick-search') {
      contractsFilters.quickSearch = String(target.value || '');
      refreshContractsResults();
    }
  }

  // =========================================================================
  //  WARFRAME.MARKET ACCOUNT INTEGRATION & ORDER ACTIONS
  // =========================================================================

  let wfmSession = {
    token: null,
    user: null
  };

  let wfmSocket = null;
  let wfmSocketStatus = 'invisible';

  function connectWfmSocket() {
    if (!wfmSession.token) return;

    if (wfmSocket) {
      try { wfmSocket.close(); } catch (e) { }
      wfmSocket = null;
    }

    if (typeof window.electronAPI === 'undefined' || typeof window.electronAPI.wfmSetCookie !== 'function') {
      console.warn('WFM Set Cookie API not available.');
      return;
    }

    window.electronAPI.wfmSetCookie(wfmSession.token).then(function (res) {
      try {
        console.log('Connecting WFM WebSocket...');
        wfmSocket = new WebSocket('wss://warframe.market/socket?platform=pc');

        wfmSocket.addEventListener('open', function () {
          console.log('WFM WebSocket connected.');
          sendWfmSocketStatus(wfmSocketStatus);
        });

        wfmSocket.addEventListener('message', function (event) {
          try {
            var msg = JSON.parse(event.data);
            if (msg.type === '@WS/USER/SET_STATUS' && msg.payload) {
              wfmSocketStatus = msg.payload;
              updateStatusSelectorUI();
            }
          } catch (e) { }
        });

        wfmSocket.addEventListener('close', function () {
          console.log('WFM WebSocket closed.');
          wfmSocket = null;
          if (wfmSession.token) {
            setTimeout(connectWfmSocket, 5000);
          }
        });

        wfmSocket.addEventListener('error', function (err) {
          console.error('WFM WebSocket error:', err);
        });
      } catch (err) {
        console.error('Failed to create WFM WebSocket:', err);
      }
    }).catch(function (err) {
      console.error('Failed to set session cookie:', err);
    });
  }

  function sendWfmSocketStatus(status) {
    wfmSocketStatus = status;
    if (wfmSocket && wfmSocket.readyState === WebSocket.OPEN) {
      wfmSocket.send(JSON.stringify({
        type: '@WS/USER/SET_STATUS',
        payload: status
      }));
    }
    updateStatusSelectorUI();
  }

  function updateStatusSelectorUI() {
    var select = $('#wfm-status-select');
    if (select) {
      select.value = wfmSocketStatus;
      if (wfmSocketStatus === 'ingame') {
        select.style.color = '#c89c3c';
        select.style.borderColor = '#c89c3c';
      } else if (wfmSocketStatus === 'online') {
        select.style.color = '#4caf50';
        select.style.borderColor = '#4caf50';
      } else {
        select.style.color = 'var(--text-dim)';
        select.style.borderColor = 'var(--border-color)';
      }
    }
  }

  function disconnectWfmSocket() {
    if (wfmSocket) {
      try { wfmSocket.close(); } catch (e) { }
      wfmSocket = null;
    }
  }

  function updateWfmHeaderUI() {
    var connectBtn = $('#market-connect-btn');
    var userBadge = $('#market-user-badge');
    var usernameLabel = $('#market-username-label');
    var myOrdersBtn = $('#market-my-orders-btn');

    if (wfmSession.token && wfmSession.user) {
      if (connectBtn) connectBtn.classList.add('hidden');
      if (userBadge) userBadge.classList.remove('hidden');
      if (usernameLabel) usernameLabel.textContent = wfmIngameName(wfmSession.user) || 'Connected';
      if (myOrdersBtn) myOrdersBtn.classList.remove('hidden');
      updateStatusSelectorUI();
    } else {
      if (connectBtn) connectBtn.classList.remove('hidden');
      if (userBadge) userBadge.classList.add('hidden');
      if (myOrdersBtn) myOrdersBtn.classList.add('hidden');
      if (marketViewMode === 'my_orders') {
        setMarketViewMode('items');
      }
    }
  }

  async function verifyWfmToken(token) {
    var cleanToken = token.trim();
    var authHeader = cleanToken.startsWith('JWT ') ? cleanToken : 'JWT ' + cleanToken;
    var json = await wfmFetch('https://api.warframe.market/v2/me', {
      headers: {
        'Authorization': authHeader
      }
    });
    if (!json || !json.data) {
      throw new Error('Invalid response payload');
    }
    return json.data;
  }

  /**
   * Take an already-verified session: store it, refresh the header, open the
   * socket and report success.
   *
   * Split out of connectWfmWithToken so the browser login, which the main
   * process has already verified against /v2/me, does not have to be verified a
   * second time over a path that can fail after the login window is gone.
   */
  function adoptWfmSession(token, user) {
    wfmSession.token = String(token || '').startsWith('JWT ') ? String(token).trim() : 'JWT ' + String(token || '').trim();
    wfmSession.user = user || null;
    localStorage.setItem('wfm_jwt_token', wfmSession.token);
    localStorage.setItem('wfm_user_info', JSON.stringify(user || null));

    updateWfmHeaderUI();
    connectWfmSocket();

    var statusEl = $('#wfm-login-status');
    if (statusEl) {
      statusEl.className = 'wfm-login-status success';
      var label = (user && (user.ingameName || user.ingame_name)) || 'your account';
      statusEl.textContent = 'Connected as ' + label + '!';
    }
    setTimeout(closeWfmLoginModal, 1200);
    return true;
  }

  async function connectWfmWithToken(token) {
    var statusEl = $('#wfm-login-status');
    if (statusEl) {
      statusEl.className = 'wfm-login-status loading';
      statusEl.textContent = 'Verifying JWT token...';
    }

    try {
      var user = await verifyWfmToken(token);
      return adoptWfmSession(token, user);
    } catch (err) {
      if (statusEl) {
        statusEl.className = 'wfm-login-status error';
        statusEl.textContent = 'Failed: ' + err.message;
      }
      return false;
    }
  }

  function disconnectWfm() {
    wfmSession.token = null;
    wfmSession.user = null;
    localStorage.removeItem('wfm_jwt_token');
    localStorage.removeItem('wfm_user_info');
    updateWfmHeaderUI();
    disconnectWfmSocket();
  }

  function initWfmSession() {
    var token = localStorage.getItem('wfm_jwt_token');
    var userJson = localStorage.getItem('wfm_user_info');
    if (token && userJson) {
      try {
        wfmSession.token = token;
        wfmSession.user = JSON.parse(userJson);
        updateWfmHeaderUI();
        connectWfmSocket();

        verifyWfmToken(token).then(function (user) {
          wfmSession.user = user;
          localStorage.setItem('wfm_user_info', JSON.stringify(user));
          updateWfmHeaderUI();
        }).catch(function (e) {
          console.error('Background token validation failed:', e);
        });
      } catch (err) {
        disconnectWfm();
      }
    }
  }

  // The v2 API returns `ingameName`; the v1 shape used `ingame_name`. Code written
  // against v1 read only the snake_case form, so seller names rendered as "Unknown",
  // the account badge showed "Connected" instead of the player's name, and
  // isMyOwnOrder() never matched anything, which hid your own listings in the
  // orders table. Read both here so the casing cannot drift across call sites.
  function wfmIngameName(user) {
    if (!user) return '';
    return String(user.ingameName || user.ingame_name || '').trim();
  }

  async function wfmFetch(url, options) {
    options = options || {};
    options.headers = options.headers || {};
    if (wfmSession.token) {
      options.headers['Authorization'] = wfmSession.token;
    }

    if (typeof window.electronAPI === 'undefined' || typeof window.electronAPI.wfmFetch !== 'function') {
      throw new Error('Electron API bridge not available.');
    }

    var res = await window.electronAPI.wfmFetch(url, options);

    if (!res.ok) {
      var errBody = res.body || {};
      var msg = 'HTTP ' + res.status;
      if (errBody.error) {
        if (typeof errBody.error === 'string') {
          msg = errBody.error;
        } else if (Array.isArray(errBody.error.request)) {
          msg = errBody.error.request.join(', ');
        } else if (errBody.error.inputs) {
          var inputs = errBody.error.inputs;
          msg = Object.keys(inputs).map(function (k) { return k + ': ' + inputs[k]; }).join('; ');
        }
      }
      throw new Error(msg);
    }
    return res.body;
  }

  function openWfmLoginModal() {
    var modal = $('#wfm-login-modal');
    if (modal) modal.classList.remove('hidden');
    var statusEl = $('#wfm-login-status');
    if (statusEl) statusEl.textContent = '';
  }

  function closeWfmLoginModal() {
    var modal = $('#wfm-login-modal');
    if (modal) modal.classList.add('hidden');
    // Also tear down the browser login window. Without this, dismissing the
    // modal left the Warframe Market window sitting on screen with no way to
    // close it from the app.
    if (window.electronAPI && typeof window.electronAPI.wfmLoginCancel === 'function') {
      window.electronAPI.wfmLoginCancel().catch(function () {});
    }
  }

  async function wfmCreateOrder(itemId, type, platinum, quantity, visible, extraParams) {
    var payload = {
      itemId: itemId,
      type: type,
      platinum: Number(platinum),
      quantity: Number(quantity),
      visible: !!visible
    };
    if (extraParams) {
      Object.assign(payload, extraParams);
    }
    return wfmFetch('https://api.warframe.market/v2/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  async function wfmUpdateOrder(orderId, platinum, quantity, visible, extraParams) {
    var payload = {
      platinum: Number(platinum),
      quantity: Number(quantity),
      visible: !!visible
    };
    if (extraParams) {
      Object.assign(payload, extraParams);
    }
    return wfmFetch('https://api.warframe.market/v2/order/' + orderId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  async function wfmDeleteOrder(orderId) {
    return wfmFetch('https://api.warframe.market/v2/order/' + orderId, {
      method: 'DELETE'
    });
  }

  function findMarketItemById(itemId) {
    if (!marketItems) return null;
    for (var i = 0; i < marketItems.length; i++) {
      if (marketItems[i].id === itemId) return marketItems[i];
    }
    return null;
  }

  function renderUserOrdersSection(sellOrders, buyOrders, itemMeta) {
    var section = document.createElement('div');
    section.className = 'wfm-user-orders-section';

    var title = document.createElement('div');
    title.className = 'wfm-section-title';
    title.innerHTML = '<span class="material-icons-round">shopping_bag</span>Your Orders & Actions';
    section.appendChild(title);

    var showRankColumn = itemSupportsOrderRank(itemMeta, sellOrders, buyOrders);
    var username = wfmIngameName(wfmSession.user).toLowerCase();

    var activeMyOrders = [];
    if (username) {
      var allOrders = [].concat(sellOrders || [], buyOrders || []);
      activeMyOrders = allOrders.filter(function (o) {
        return wfmIngameName(o.user).toLowerCase() === username;
      });
    }

    if (activeMyOrders.length > 0) {
      var list = document.createElement('div');
      list.className = 'wfm-active-orders-list';

      for (var i = 0; i < activeMyOrders.length; i++) {
        var o = activeMyOrders[i];
        var row = document.createElement('div');
        row.className = 'wfm-active-order-row';

        var info = document.createElement('div');
        info.className = 'wfm-active-order-info';

        var badge = document.createElement('span');
        badge.className = 'wfm-badge-type ' + o.order_type;
        badge.textContent = o.order_type;
        info.appendChild(badge);

        var details = document.createElement('span');
        var rankText = (showRankColumn && o.rank !== null && typeof o.rank !== 'undefined') ? ' (Rank ' + o.rank + ')' : '';
        details.innerHTML = 'Price: <strong class="has-platinum-icon plat-value">' + o.platinum + ' <img class="plat-icon" src="' + PLATINUM_ICON_PATH + '"></strong>' + rankText + ' | Qty: <strong>' + (o.quantity || 1) + '</strong> | Status: <strong>' + (o.visible !== false ? 'Visible' : 'Hidden') + '</strong>';
        info.appendChild(details);
        row.appendChild(info);

        var actions = document.createElement('div');
        actions.className = 'wfm-active-order-actions';

        var toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'btn-icon-only';
        toggleBtn.title = o.visible !== false ? 'Hide listing' : 'Show listing';
        toggleBtn.innerHTML = o.visible !== false ? '<span class="material-icons-round">visibility_off</span>' : '<span class="material-icons-round">visibility</span>';
        toggleBtn.addEventListener('click', function (order) {
          return async function (e) {
            e.stopPropagation();
            try {
              var extra = (showRankColumn && order.rank !== null) ? { rank: order.rank } : null;
              await wfmUpdateOrder(order.id, order.platinum, order.quantity, !order.visible, extra);
              await fetchAndRenderOrders(itemMeta.slug);
            } catch (err) {
              alert('Failed to toggle visibility: ' + err.message);
            }
          };
        }(o));
        actions.appendChild(toggleBtn);

        var deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btn-icon-only delete';
        deleteBtn.title = 'Delete listing';
        deleteBtn.innerHTML = '<span class="material-icons-round">delete</span>';
        deleteBtn.addEventListener('click', function (order) {
          return async function (e) {
            e.stopPropagation();
            if (!confirm('Delete this listing?')) return;
            try {
              await wfmDeleteOrder(order.id);
              await fetchAndRenderOrders(itemMeta.slug);
            } catch (err) {
              alert('Failed to delete listing: ' + err.message);
            }
          };
        }(o));
        actions.appendChild(deleteBtn);

        row.appendChild(actions);
        list.appendChild(row);
      }
      section.appendChild(list);
    }

    var form = document.createElement('div');
    form.className = 'wfm-create-order-grid';

    var grpType = document.createElement('div');
    grpType.className = 'form-group';
    grpType.innerHTML = '<label class="wfm-label">Type</label>';
    var selectType = document.createElement('select');
    selectType.className = 'wfm-input';
    selectType.style.padding = '8px 12px';
    selectType.innerHTML = '<option value="sell">Sell Request</option><option value="buy">Buy Request</option>';
    grpType.appendChild(selectType);
    form.appendChild(grpType);

    var grpPrice = document.createElement('div');
    grpPrice.className = 'form-group';
    grpPrice.innerHTML = '<label class="wfm-label">Price (Plat)</label>';
    var inputPrice = document.createElement('input');
    inputPrice.type = 'number';
    inputPrice.className = 'wfm-input';
    inputPrice.min = 1;
    inputPrice.value = 1;
    grpPrice.appendChild(inputPrice);
    form.appendChild(grpPrice);

    var grpQty = document.createElement('div');
    grpQty.className = 'form-group';
    grpQty.innerHTML = '<label class="wfm-label">Quantity</label>';
    var inputQty = document.createElement('input');
    inputQty.type = 'number';
    inputQty.className = 'wfm-input';
    inputQty.min = 1;
    inputQty.value = 1;
    grpQty.appendChild(inputQty);
    form.appendChild(grpQty);

    var inputRank = null;
    if (showRankColumn) {
      var grpRank = document.createElement('div');
      grpRank.className = 'form-group';
      grpRank.innerHTML = '<label class="wfm-label">Rank</label>';
      inputRank = document.createElement('input');
      inputRank.type = 'number';
      inputRank.className = 'wfm-input';
      inputRank.min = 0;
      inputRank.max = 10;
      inputRank.value = 0;
      grpRank.appendChild(inputRank);
      form.appendChild(grpRank);
    }

    var btnSubmit = document.createElement('button');
    btnSubmit.type = 'button';
    btnSubmit.className = 'btn btn-primary';
    btnSubmit.textContent = 'Post Order';
    btnSubmit.addEventListener('click', async function () {
      var typeVal = selectType.value;
      var priceVal = Number(inputPrice.value);
      var qtyVal = Number(inputQty.value);

      if (isNaN(priceVal) || priceVal <= 0) {
        alert('Please enter a valid price.');
        return;
      }
      if (isNaN(qtyVal) || qtyVal <= 0) {
        alert('Please enter a valid quantity.');
        return;
      }

      var extra = null;
      if (showRankColumn && inputRank) {
        var rankVal = Number(inputRank.value);
        if (!isNaN(rankVal) && rankVal >= 0) {
          extra = { rank: rankVal };
        }
      }

      btnSubmit.disabled = true;
      btnSubmit.textContent = 'Posting...';

      try {
        await wfmCreateOrder(itemMeta.id, typeVal, priceVal, qtyVal, true, extra);
        await fetchAndRenderOrders(itemMeta.slug);
      } catch (err) {
        alert('Failed to post order: ' + err.message);
        btnSubmit.disabled = false;
        btnSubmit.textContent = 'Post Order';
      }
    });
    form.appendChild(btnSubmit);

    section.appendChild(form);
    return section;
  }

  let selectedAddItem = null;

  function checkItemSupportsRank(item) {
    if (!item) return false;
    var category = item.category ? String(item.category) : '';
    var tags = Array.isArray(item.tags) ? item.tags : [];
    if (category === 'mods' || category === 'arcanes') return true;
    if (tags.indexOf('mod') !== -1 || tags.indexOf('stance') !== -1 || tags.indexOf('aura') !== -1) return true;
    if (tags.indexOf('arcane_enhancement') !== -1 || tags.indexOf('arcane_helmet') !== -1) return true;
    return false;
  }

  function renderAddOrderForm(container) {
    container.innerHTML = `
      <div class="wfm-section-title"><span class="material-icons-round">add_circle</span>Create New Listing</div>
      <div class="my-orders-add-form" style="display: flex; gap: 16px; align-items: flex-end; margin-bottom: 20px; background: rgba(255,255,255,0.02); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 16px;">
        <div class="form-group" style="position: relative; flex: 2; display: flex; flex-direction: column; gap: 6px;">
          <label class="wfm-label">Item Name</label>
          <input type="text" id="my-orders-add-search" class="wfm-input" placeholder="Type item name..." autocomplete="off">
          <div id="my-orders-add-suggestions" class="my-orders-suggestions hidden" style="position: absolute; top: 100%; left: 0; right: 0; background: #0a0a0f; border: 1px solid var(--border-color); border-radius: var(--radius-md); max-height: 200px; overflow-y: auto; z-index: 100; box-shadow: var(--shadow-lg);"></div>
        </div>
        <div class="form-group" style="flex: 1; display: flex; flex-direction: column; gap: 6px;">
          <label class="wfm-label">Type</label>
          <select id="my-orders-add-type" class="wfm-input" style="padding: 9px 12px; height: 38px;">
            <option value="sell">Sell</option>
            <option value="buy">Buy</option>
          </select>
        </div>
        <div class="form-group" style="flex: 1; display: flex; flex-direction: column; gap: 6px;">
          <label class="wfm-label">Price (Plat)</label>
          <input type="number" id="my-orders-add-price" class="wfm-input" min="1" value="1" style="height: 38px;">
        </div>
        <div class="form-group" style="flex: 1; display: flex; flex-direction: column; gap: 6px;">
          <label class="wfm-label">Quantity</label>
          <input type="number" id="my-orders-add-qty" class="wfm-input" min="1" value="1" style="height: 38px;">
        </div>
        <div class="form-group hidden" id="my-orders-add-rank-group" style="flex: 1; display: flex; flex-direction: column; gap: 6px;">
          <label class="wfm-label">Rank</label>
          <input type="number" id="my-orders-add-rank" class="wfm-input" min="0" value="0" style="height: 38px;">
        </div>
        <button type="button" class="btn btn-primary" id="my-orders-add-submit" style="height: 38px; min-width: 120px;">Post Listing</button>
      </div>
    `;

    var searchInput = $('#my-orders-add-search');
    var suggestionsDiv = $('#my-orders-add-suggestions');
    var typeSelect = $('#my-orders-add-type');
    var priceInput = $('#my-orders-add-price');
    var qtyInput = $('#my-orders-add-qty');
    var rankGroup = $('#my-orders-add-rank-group');
    var rankInput = $('#my-orders-add-rank');
    var submitBtn = $('#my-orders-add-submit');

    if (!searchInput || !suggestionsDiv || !submitBtn) return;

    searchInput.addEventListener('input', function () {
      var query = String(searchInput.value || '').trim().toLowerCase();
      if (!query || !marketItems) {
        suggestionsDiv.innerHTML = '';
        suggestionsDiv.classList.add('hidden');
        return;
      }

      var matches = marketItems.filter(function (item) {
        return item.name && item.name.toLowerCase().includes(query);
      }).slice(0, 10);

      if (matches.length === 0) {
        suggestionsDiv.innerHTML = '<div style="padding: 10px; color: var(--text-dim); font-size: 13px;">No items found</div>';
      } else {
        suggestionsDiv.innerHTML = '';
        matches.forEach(function (item) {
          var div = document.createElement('div');
          div.style.padding = '8px 12px';
          div.style.cursor = 'pointer';
          div.style.fontSize = '13px';
          div.style.borderBottom = '1px solid rgba(255,255,255,0.02)';
          div.className = 'suggestion-item';
          div.textContent = item.name;
          div.addEventListener('click', function () {
            searchInput.value = item.name;
            selectedAddItem = item;
            suggestionsDiv.classList.add('hidden');

            var supportsRank = checkItemSupportsRank(item);
            if (supportsRank) {
              if (rankGroup) rankGroup.classList.remove('hidden');
            } else {
              if (rankGroup) rankGroup.classList.add('hidden');
            }
          });
          suggestionsDiv.appendChild(div);
        });
      }
      suggestionsDiv.classList.remove('hidden');
    });

    document.addEventListener('click', function (e) {
      if (e.target !== searchInput && e.target !== suggestionsDiv) {
        suggestionsDiv.classList.add('hidden');
      }
    });

    submitBtn.addEventListener('click', async function () {
      if (!selectedAddItem || searchInput.value !== selectedAddItem.name) {
        alert('Please select a valid item from the suggestions dropdown list.');
        return;
      }

      var typeVal = typeSelect.value;
      var priceVal = Number(priceInput.value);
      var qtyVal = Number(qtyInput.value);

      if (isNaN(priceVal) || priceVal <= 0) {
        alert('Please enter a valid price.');
        return;
      }
      if (isNaN(qtyVal) || qtyVal <= 0) {
        alert('Please enter a valid quantity.');
        return;
      }

      var extra = null;
      var supportsRank = checkItemSupportsRank(selectedAddItem);
      if (supportsRank && rankInput) {
        var rankVal = Number(rankInput.value);
        if (!isNaN(rankVal) && rankVal >= 0) {
          extra = { rank: rankVal };
        }
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Posting...';

      try {
        await wfmCreateOrder(selectedAddItem.id, typeVal, priceVal, qtyVal, true, extra);

        searchInput.value = '';
        priceInput.value = '1';
        qtyInput.value = '1';
        if (rankInput) rankInput.value = '0';
        if (rankGroup) rankGroup.classList.add('hidden');
        selectedAddItem = null;

        alert('Listing posted successfully!');
        fetchAndRenderMyOrders();
      } catch (err) {
        alert('Failed to post order: ' + err.message);
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Post Listing';
      }
    });
  }

  async function fetchAndRenderMyOrders() {
    var view = $('#my-orders-view');
    if (!view) return;

    var formContainer = $('#my-orders-form-container');
    if (!formContainer) {
      formContainer = document.createElement('div');
      formContainer.id = 'my-orders-form-container';
      formContainer.className = 'my-orders-add-section';
      view.appendChild(formContainer);
      renderAddOrderForm(formContainer);
    }

    var listContainer = $('#my-orders-list-container');
    if (!listContainer) {
      listContainer = document.createElement('div');
      listContainer.id = 'my-orders-list-container';
      view.appendChild(listContainer);
    }

    listContainer.innerHTML = '<div class="orders-loading">Loading your active listings...</div>';

    try {
      var json = await wfmFetch('https://api.warframe.market/v2/orders/my');
      var orders = json.data || [];

      orders.sort(function (a, b) {
        var typeA = a.type || a.order_type || '';
        var typeB = b.type || b.order_type || '';
        if (typeA !== typeB) {
          return typeA === 'sell' ? -1 : 1;
        }
        var itemA = findMarketItemById(a.itemId || (a.item && a.item.id) || a.item);
        var itemB = findMarketItemById(b.itemId || (b.item && b.item.id) || b.item);
        var nameA = itemA ? itemA.name : '';
        var nameB = itemB ? itemB.name : '';
        return nameA.localeCompare(nameB);
      });

      if (orders.length === 0) {
        listContainer.innerHTML = '<div class="my-orders-empty">' +
          '<span class="material-icons-round">list_alt</span>' +
          '<p>You do not have any active orders on warframe.market.</p>' +
          '</div>';
        return;
      }

      listContainer.innerHTML = '';

      // A listing table is short, so resolve any wiki-only art (mod effect names,
      // weapon parts) before rendering rather than patching images in afterwards.
      var orderImageNames = [];
      for (var n = 0; n < orders.length; n++) {
        var nameForImage = '';
        if (orders[n].item && typeof orders[n].item === 'object') {
          var enForImage = orders[n].item.i18n && orders[n].item.i18n.en ? orders[n].item.i18n.en : null;
          nameForImage = orders[n].item.name || (enForImage && enForImage.name) || '';
        }
        if (!nameForImage) {
          var looked = findMarketItemById(orders[n].itemId || (orders[n].item && orders[n].item.id) || orders[n].item);
          if (looked) nameForImage = looked.name || '';
        }
        if (nameForImage) orderImageNames.push(nameForImage);
      }
      var preResolvedOrderImages = await resolveWikiImagesForNames(orderImageNames);

      var tableContainer = document.createElement('div');
      tableContainer.className = 'my-orders-table-container';

      var table = document.createElement('table');
      table.className = 'my-orders-table';

      var thead = document.createElement('thead');
      var headerRow = document.createElement('tr');
      var headers = ['Item', 'Type', 'Price', 'Quantity', 'Rank', 'Status', 'Actions'];
      for (var h = 0; h < headers.length; h++) {
        var th = document.createElement('th');
        th.textContent = headers[h];
        headerRow.appendChild(th);
      }
      thead.appendChild(headerRow);
      table.appendChild(thead);

      var tbody = document.createElement('tbody');
      for (var i = 0; i < orders.length; i++) {
        var o = orders[i];
        var oId = o.id;
        var oType = o.type || o.order_type || 'sell';
        var oPlat = o.platinum || 0;
        var oQty = o.quantity || 1;
        var oRank = typeof o.rank !== 'undefined' ? o.rank : (typeof o.mod_rank !== 'undefined' ? o.mod_rank : null);
        var oVisible = o.visible !== false;

        var itemId = o.itemId || (o.item && o.item.id) || o.item;
        var item = findMarketItemById(itemId);

        var tr = document.createElement('tr');

        var tdItem = document.createElement('td');
        var itemWrap = document.createElement('div');
        itemWrap.className = 'my-orders-item-cell';

        // An <img> with an empty src renders Chromium's broken-image symbol, so only
        // insert one when a source actually resolved. The order can still name the item
        // even when the catalogue lookup missed, so fall back to that for the image.
        var orderImageItem = item;
        if (!orderImageItem && o.item && typeof o.item === 'object') {
          var orderItemEn = o.item.i18n && o.item.i18n.en ? o.item.i18n.en : null;
          var orderItemName = o.item.name || (orderItemEn && orderItemEn.name) || '';
          if (orderItemName) orderImageItem = { name: orderItemName };
        }

        var img = document.createElement('img');
        img.className = 'my-orders-item-img';
        img.alt = item ? item.name : 'Unknown Item';

        var orderImageName = orderImageItem ? orderImageItem.name : '';
        // Resolved before the table is built, so the row renders once with a final
        // URL instead of flashing an empty cell and patching it in later.
        var orderImageUrl = preResolvedOrderImages[orderImageName] || getMarketItemImageUrl(orderImageItem);
        if (orderImageUrl) {
          img.src = orderImageUrl;
          // WFM's asset host can refuse the image outright; drop the element rather
          // than leaving Chromium's broken-image symbol sitting in the table.
          img.addEventListener('error', function () {
            // Hide rather than remove, so the wiki fallback can still revive this
            // element. Never leave a broken-image symbol in the table.
            img.style.display = 'none';
            upgradeMarketImageFromWiki(img, orderImageName);
          });
          itemWrap.appendChild(img);
          labelMarketImageFallback(img, orderImageItem);        }

        var nameSpan = document.createElement('span');
        nameSpan.textContent = item ? item.name : 'Unknown Item';

        itemWrap.appendChild(nameSpan);
        tdItem.appendChild(itemWrap);
        tr.appendChild(tdItem);

        var tdType = document.createElement('td');
        var typeBadge = document.createElement('span');
        typeBadge.className = 'wfm-badge-type ' + oType;
        typeBadge.textContent = oType;
        tdType.appendChild(typeBadge);
        tr.appendChild(tdType);

        var tdPrice = document.createElement('td');
        var priceInput = document.createElement('input');
        priceInput.type = 'number';
        priceInput.className = 'my-orders-input-plat';
        priceInput.value = oPlat;
        priceInput.min = 1;
        tdPrice.appendChild(priceInput);
        tr.appendChild(tdPrice);

        var tdQty = document.createElement('td');
        var qtyInput = document.createElement('input');
        qtyInput.type = 'number';
        qtyInput.className = 'my-orders-input-qty';
        qtyInput.value = oQty;
        qtyInput.min = 1;
        tdQty.appendChild(qtyInput);
        tr.appendChild(tdQty);

        var tdRank = document.createElement('td');
        tdRank.textContent = oRank !== null ? 'Rank ' + oRank : '--';
        tr.appendChild(tdRank);

        var tdStatus = document.createElement('td');
        var statusSpan = document.createElement('span');
        statusSpan.className = oVisible ? 'status-dot status-online' : 'status-dot status-offline';
        statusSpan.style.display = 'inline-block';
        statusSpan.title = oVisible ? 'Visible' : 'Hidden';
        tdStatus.appendChild(statusSpan);
        tr.appendChild(tdStatus);

        var tdActions = document.createElement('td');
        var actionWrap = document.createElement('div');
        actionWrap.style.display = 'flex';
        actionWrap.style.gap = '8px';

        var btnUpdate = document.createElement('button');
        btnUpdate.type = 'button';
        btnUpdate.className = 'btn-icon-only';
        btnUpdate.title = 'Save Changes';
        btnUpdate.innerHTML = '<span class="material-icons-round">save</span>';
        btnUpdate.addEventListener('click', function (orderId, typeVal, pInp, qInp, visVal, rVal) {
          return async function (e) {
            e.stopPropagation();
            var newPlat = Number(pInp.value);
            var newQty = Number(qInp.value);
            if (isNaN(newPlat) || newPlat <= 0 || isNaN(newQty) || newQty <= 0) {
              alert('Please enter valid inputs.');
              return;
            }
            try {
              var extra = rVal !== null ? { rank: rVal } : null;
              await wfmUpdateOrder(orderId, newPlat, newQty, visVal, extra);
              await fetchAndRenderMyOrders();
            } catch (err) {
              alert('Failed to update: ' + err.message);
            }
          };
        }(oId, oType, priceInput, qtyInput, oVisible, oRank));
        actionWrap.appendChild(btnUpdate);

        var btnToggle = document.createElement('button');
        btnToggle.type = 'button';
        btnToggle.className = 'btn-icon-only';
        btnToggle.title = oVisible ? 'Hide Listing' : 'Show Listing';
        btnToggle.innerHTML = oVisible ? '<span class="material-icons-round">visibility_off</span>' : '<span class="material-icons-round">visibility</span>';
        btnToggle.addEventListener('click', function (orderId, platVal, qtyVal, visVal, rVal) {
          return async function (e) {
            e.stopPropagation();
            try {
              var extra = rVal !== null ? { rank: rVal } : null;
              await wfmUpdateOrder(orderId, platVal, qtyVal, !visVal, extra);
              await fetchAndRenderMyOrders();
            } catch (err) {
              alert('Failed to toggle visibility: ' + err.message);
            }
          };
        }(oId, oPlat, oQty, oVisible, oRank));
        actionWrap.appendChild(btnToggle);

        var btnDelete = document.createElement('button');
        btnDelete.type = 'button';
        btnDelete.className = 'btn-icon-only delete';
        btnDelete.title = 'Delete Listing';
        btnDelete.innerHTML = '<span class="material-icons-round">delete</span>';
        btnDelete.addEventListener('click', function (orderId) {
          return async function (e) {
            e.stopPropagation();
            if (!confirm('Are you sure you want to delete this listing?')) return;
            try {
              await wfmDeleteOrder(orderId);
              await fetchAndRenderMyOrders();
            } catch (err) {
              alert('Failed to delete listing: ' + err.message);
            }
          };
        }(oId));
        actionWrap.appendChild(btnDelete);

        tdActions.appendChild(actionWrap);
        tr.appendChild(tdActions);

        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      tableContainer.appendChild(table);
      listContainer.appendChild(tableContainer);
    } catch (err) {
      listContainer.innerHTML = '<div class="orders-error">Failed to load orders: ' + err.message + '</div>';
    }
  }

  // ---------- Init on document ready ----------
  function initMarket() {
    if (marketInitialized) return;
    marketInitialized = true;

    // Market search
    var searchInput = $('#market-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', function (e) {
        marketSearchQuery = String(e.target.value || '');
        var clearBtn = $('#market-search-clear');
        if (clearBtn) clearBtn.classList.toggle('hidden', !marketSearchQuery);
        applyMarketFilters();
      });
    }

    var analyticsSearchInput = $('#trade-analytics-search-input');
    if (analyticsSearchInput) {
      analyticsSearchInput.addEventListener('input', function (e) {
        analyticsSearchQuery = String(e.target.value || '');
        var clearBtn = $('#trade-analytics-search-clear');
        if (clearBtn) clearBtn.classList.toggle('hidden', !analyticsSearchQuery);
        renderTradeAnalyticsSearchResults();
      });

      analyticsSearchInput.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        var results = getAnalyticsSearchResults();
        if (results.length > 0) {
          selectAnalyticsItem(results[0], false);
        }
      });
    }

    var searchClear = $('#market-search-clear');
    if (searchClear) {
      searchClear.addEventListener('click', function () {
        var inp = $('#market-search-input');
        if (inp) inp.value = '';
        marketSearchQuery = '';
        searchClear.classList.add('hidden');
        applyMarketFilters();
      });
    }

    var analyticsSearchClear = $('#trade-analytics-search-clear');
    if (analyticsSearchClear) {
      analyticsSearchClear.addEventListener('click', function () {
        var inp = $('#trade-analytics-search-input');
        if (inp) inp.value = '';
        analyticsSearchQuery = '';
        analyticsSearchClear.classList.add('hidden');
        renderTradeAnalyticsSearchResults();
      });
    }

    // Category buttons
    document.querySelectorAll('.market-cat-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.market-cat-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        marketCategory = btn.dataset.marketCat;
        applyMarketFilters();
      });
    });

    var analyticsRefreshBtn = $('#btn-trade-analytics-refresh');
    if (analyticsRefreshBtn) {
      analyticsRefreshBtn.addEventListener('click', function () {
        loadTradeAnalytics(true);
      });
    }

    var analyticsOpenOrdersBtn = $('#btn-trade-analytics-open-orders');
    if (analyticsOpenOrdersBtn) {
      analyticsOpenOrdersBtn.addEventListener('click', function () {
        if (analyticsCurrentItem) {
          openOrdersModal(analyticsCurrentItem);
        }
      });
    }

    var contractsToggleBtn = $('#market-contracts-btn');
    if (contractsToggleBtn) {
      contractsToggleBtn.addEventListener('click', function () {
        setMarketViewMode(marketViewMode === 'contracts' ? 'items' : 'contracts');
      });
    }

    var contractsView = $('#contracts-view');
    if (contractsView) {
      contractsView.addEventListener('click', handleContractsViewClick);
      contractsView.addEventListener('change', handleContractsViewChange);
      contractsView.addEventListener('input', handleContractsViewInput);
    }

    // Close modal
    var closeBtn = $('#orders-modal-close');
    if (closeBtn) closeBtn.addEventListener('click', closeOrdersModal);
    var modal = $('#market-orders-modal');
    if (modal) {
      modal.addEventListener('click', function (e) {
        if (e.target === modal) closeOrdersModal();
      });
    }

    // ESC key
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeOrdersModal();
    });

    // WFM Account UI bindings
    var connectBtn = $('#market-connect-btn');
    if (connectBtn) {
      connectBtn.addEventListener('click', openWfmLoginModal);
    }

    var disconnectBtn = $('#market-disconnect-btn');
    if (disconnectBtn) {
      disconnectBtn.addEventListener('click', disconnectWfm);
    }

    var statusSelect = $('#wfm-status-select');
    if (statusSelect) {
      statusSelect.addEventListener('change', function () {
        sendWfmSocketStatus(statusSelect.value);
      });
    }

    var loginCloseBtn = $('#wfm-login-close');
    if (loginCloseBtn) {
      loginCloseBtn.addEventListener('click', closeWfmLoginModal);
    }

    // Modal Form Submits
    //
    // These were previously bound twice, in two identical blocks, and the second
    // one also re-bound the credentials submit that no longer exists.
    var submitJwtBtn = $('#wfm-submit-jwt');
    if (submitJwtBtn) {
      submitJwtBtn.addEventListener('click', function () {
        var jwtInput = $('#wfm-jwt-input');
        var token = jwtInput ? String(jwtInput.value || '').trim() : '';
        if (!token) {
          alert('Please enter a JWT token.');
          return;
        }
        connectWfmWithToken(token);
      });
    }

    var browserLoginBtn = $('#wfm-browser-login');
    if (browserLoginBtn) {
      // Recoverable failures no longer end this call, so the main process pushes
      // progress here. Without this the panel would sit on "Opening..." forever
      // while the login window waited for a retry.
      if (window.electronAPI && typeof window.electronAPI.onWfmLoginStatus === 'function') {
        window.electronAPI.onWfmLoginStatus(function (payload) {
          var el = $('#wfm-login-status');
          if (!el || !payload) return;
          el.className = 'wfm-login-status error';
          el.textContent = payload.message || 'Login did not complete.';
        });
      }

      browserLoginBtn.addEventListener('click', async function () {
        var statusEl = $('#wfm-login-status');
        if (statusEl) {
          statusEl.className = 'wfm-login-status loading';
          statusEl.textContent = 'Opening Warframe Market login...';
        }

        try {
          var res = await window.electronAPI.wfmLoginBrowser();
          if (!res.ok) {
            throw new Error(res.message || 'Browser login failed.');
          }
          // The main process has already confirmed the token against /v2/me, so
          // the session is known good here. Re-verifying it in the renderer only
          // added a second failure point after the login window had closed.
          adoptWfmSession(res.token, res.user);
        } catch (err) {
          if (statusEl) {
            statusEl.className = 'wfm-login-status error';
            statusEl.textContent = 'Failed: ' + err.message;
          }
        }
      });
    }

    // WFM My Orders button toggle
    var myOrdersBtn = $('#market-my-orders-btn');
    if (myOrdersBtn) {
      myOrdersBtn.addEventListener('click', function () {
        setMarketViewMode(marketViewMode === 'my_orders' ? 'items' : 'my_orders');
      });
    }

// Initialize session from storage
     initWfmSession();

     renderMarketViewState();

     // Filter button UI update function
     function updateFilterButtonUI() {
       var ownedBtn = document.getElementById('filter-owned');
       if (ownedBtn) ownedBtn.classList.toggle('active', showOwnedOnly);
       var notOwnedBtn = document.getElementById('filter-not-owned');
       if (notOwnedBtn) notOwnedBtn.classList.toggle('active', showNotOwnedOnly);
       var vaultedBtn = document.getElementById('filter-vaulted');
       if (vaultedBtn) vaultedBtn.classList.toggle('active', showVaultedOnly);
       var activeBtn = document.getElementById('filter-active');
       if (activeBtn) activeBtn.classList.toggle('active', showActiveOnly);
     }

     // Setup filter button listeners
     function setupFilterButtons() {
       // Owned filter
       var ownedBtn = document.getElementById('filter-owned');
       if (ownedBtn) {
         ownedBtn.addEventListener('click', function() {
           showOwnedOnly = !showOwnedOnly;
           saveMarketFilterState();
           applyMarketFilters();
           updateFilterButtonUI();
         });
       }
       // Not Owned filter
       var notOwnedBtn = document.getElementById('filter-not-owned');
       if (notOwnedBtn) {
         notOwnedBtn.addEventListener('click', function() {
           showNotOwnedOnly = !showNotOwnedOnly;
           saveMarketFilterState();
           applyMarketFilters();
           updateFilterButtonUI();
         });
       }
       // Vaulted filter
       var vaultedBtn = document.getElementById('filter-vaulted');
       if (vaultedBtn) {
         vaultedBtn.addEventListener('click', function() {
           showVaultedOnly = !showVaultedOnly;
           saveMarketFilterState();
           applyMarketFilters();
           updateFilterButtonUI();
         });
       }
       // Active filter
       var activeBtn = document.getElementById('filter-active');
       if (activeBtn) {
         activeBtn.addEventListener('click', function() {
           showActiveOnly = !showActiveOnly;
           saveMarketFilterState();
           applyMarketFilters();
           updateFilterButtonUI();
         });
       }

       // Set initial button states based on loaded filter state
       updateFilterButtonUI();
     }

     // Check if DOM is ready
     if (document.readyState === 'loading') {
       document.addEventListener('DOMContentLoaded', setupFilterButtons);
     } else {
       setupFilterButtons();
     }
  }

  // Safety net for images that fail to load.
  //
  // Most render sites attach their own error handler, but a few do not, and an
  // <img> that 404s with no handler leaves Chromium's broken-image symbol in the
  // layout. That is not hypothetical: the analytics panel's default picks include
  // Arcane Energize and Arcane Grace, whose catalogue image names resolve to CDN
  // objects that return 404.
  //
  // This runs in the capture phase on the document so it also sees events from
  // images that have no handler of their own, and it only acts when the element
  // is still visible, so a site that already cleaned itself up is left alone.
  if (typeof document !== 'undefined' && !document.__imageErrorNetInstalled) {
    document.__imageErrorNetInstalled = true;
    document.addEventListener(
      'error',
      function (event) {
        var target = event.target;
        if (!target || target.tagName !== 'IMG') return;
        if (target.style && target.style.display === 'none') return;
        if (target.dataset && target.dataset.wfmFallbackTried) return;
        target.dataset.wfmFallbackTried = '1';
        // Prefer reviving from the wiki, which is how the rest of the market code
        // recovers a refused WFM asset host.
        try {
          if (typeof upgradeMarketImageFromWiki === 'function' && target.alt) {
            upgradeMarketImageFromWiki(target, target.alt);
            return;
          }
        } catch (e) { /* fall through to hiding */ }
        target.style.display = 'none';
      },
      true
    );
  }

  // The main process only learns the token via wfm-set-cookie, and that used to be
  // called from connectWfmSocket(), which sits behind initMarket(). The market module
  // initialises lazily on first visit, so after a restart the main process held no
  // token and every authenticated call answered 401 until the user happened to open
  // the Market tab. Rehydrating here means the session is usable immediately.
  async function rehydrateWfmSession() {
    if (wfmSession.token) return true;
    if (typeof window.electronAPI === 'undefined' || typeof window.electronAPI.wfmSetCookie !== 'function') {
      return false;
    }

    var token = '';
    try {
      token = String(localStorage.getItem('wfm_jwt_token') || '').trim();
    } catch (err) {
      return false;
    }
    if (!token) return false;

    try {
      var res = await window.electronAPI.wfmSetCookie(token);
      if (res && res.ok) {
        wfmSession.token = token;
        wfmSession.user = res.user || wfmSession.user;
        // Without this the header keeps showing "Connect Account" and the My Orders
        // button stays hidden, so the session looked logged out even though every
        // request was authenticated.
        updateWfmHeaderUI();
        return true;
      }
      // An expired token is the common case here, so drop it rather than leaving a
      // dead session that fails on every call.
      if (res && res.message) console.warn('Stored Warframe.market session is no longer valid:', res.message);
      disconnectWfm();
      return false;
    } catch (err) {
      return false;
    }
  }

  // Expose globally
  window.warframeMarket = {
    init: initMarket,
    rehydrateSession: rehydrateWfmSession,
    load: loadMarketItems,
    loadAnalytics: loadTradeAnalytics,
    openItemByName: openItemByName,
    searchItemByName: searchItemByName,
    openPartOrdersByName: openPartOrdersByName,
    getRelicRewardOverlayPrices: getRelicRewardOverlayPrices,
    warmRelicRewardOverlay: warmRelicRewardOverlay,
    showContracts: function () {
      return setMarketViewMode('contracts');
    },
  };

})();
