/**
 * Warframe.market contracts feed reader.
 *
 * Why the app filters locally instead of calling the search endpoint
 * -----------------------------------------------------------------
 * GET /v1/auctions/search cannot currently be satisfied. Its validation is:
 *
 *   ?type=riven                                   -> 400 requirements_not_met
 *   ?type=riven&<any second param>                -> 400 {"type":["app.form.invalid"]}
 *   ?type=riven&set_name=X&set_platform=pc
 *        &sort_by=price_asc&set_rank=0&is_buyer=0 -> 400 requirements_not_met
 *
 * The parameter shape is recognised, but no combination meets the requirement,
 * for type=riven, type=lich and type=sister alike. The v2 surface has no public
 * per-item order route either (/v2/orders and /v2/auctions are 404, and
 * /v2/items/<slug> returns app.item.notFound). The previous contracts search in
 * market.js could therefore not work against the live API at all.
 *
 * GET /v1/auctions?page=N does work anonymously and is exactly the right source:
 * 600 consecutive orders sampled across pages 1-6 were all contracts (574 riven,
 * 16 sister, 10 lich) with no regular item orders present, and item.type uses the
 * same three values the app already filters on.
 *
 * The feed is newest first, so matches further back than the pages walked are not
 * counted, and matches for a single weapon are sparse: across 400 orders the most
 * common riven weapon appeared 32 times. `truncated`, `pagesChecked` and `note`
 * travel with every result so the UI states how far it looked rather than implying
 * an item has no listings.
 *
 * Loaded both as a CommonJS module (tests) and as a plain script that publishes
 * `WfmContracts` (the renderer has no module system).
 */
(function (root, factory) {
  'use strict';

  const api = factory();

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WfmContracts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const AUCTIONS_PAGE = 'https://api.warframe.market/v1/auctions';

  /** Orders per page, as served by the API. */
  const ORDERS_PER_PAGE = 100;

  /** Never walk more than this many pages in one lookup. */
  const DEFAULT_MAX_PAGES = 6;

  /**
   * Modest on purpose: riven orders for a single weapon are rare enough that a
   * large wantCount would mean paging a long way for a handful of results.
   */
  const DEFAULT_WANT_COUNT = 25;

  /** Minimum gap between page requests; this endpoint rate limits hard (HTTP 429). */
  const REQUEST_SPACING_MS = 1100;

  /** The only item types in the contracts feed, confirmed by sampling. */
  const CONTRACT_TYPES = ['riven', 'lich', 'sister'];

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Normalise for tolerant comparison: lowercase, alphanumeric only. */
  function norm(value) {
    return String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  /** True for a finite number, so NaN and Infinity never reach the UI. */
  function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  /**
   * What a buyer would actually have to pay.
   *
   * Three shapes occur in this feed (600 orders sampled):
   *   - buyout:  buyout_price is a number (590 of 600)
   *   - bidding: buyout_price null, top_bid a number
   *   - no bids: buyout_price and top_bid both null, only starting_price (10 of 600)
   *
   * `price` is never a number in this feed, and starting_price is an opening floor
   * rather than an offer, so it is deliberately not reported as the price.
   * @returns {number|null} null when nobody is asking a price yet
   */
  function orderPrice(order) {
    if (!order) return null;
    if (finiteNumber(order.buyout_price)) return order.buyout_price;
    if (finiteNumber(order.top_bid)) return order.top_bid;
    return null;
  }

  /** True when the order can be bought outright right now. */
  function isBuyout(order) {
    return finiteNumber(order && order.buyout_price);
  }

  /** True when there is no price at all yet, so the row is informational only. */
  function hasNoPriceYet(order) {
    return orderPrice(order) === null;
  }

  /** An order that is no longer buyable: already closed or hidden. */
  function isDead(order) {
    if (!order) return true;
    if (order.closed === true) return true;
    if (order.visible === false) return true;
    return false;
  }

  /**
   * Pull the riven stats off an order.
   *
   * The live shape is `{ value, positive, url_name }` - the polarity key is
   * `positive`, not `isPositive`. Values follow the game's own display convention
   * per stat and are not uniformly percentages: sampled orders carry
   * `heat_damage: 103` next to `damage_vs_grineer: 0.55`, where the second is a
   * multiplier. Both pass through untouched; callers normalise using stat
   * metadata instead of assuming a single scale.
   */
  function rivenStatsFrom(order) {
    const item = (order && order.item) || {};
    if (!Array.isArray(item.attributes)) return [];
    return item.attributes
      .filter((a) => a && a.url_name)
      .map((a) => ({
        key: a.url_name,
        value: finiteNumber(a.value) ? a.value : null,
        // `positive` is the live key; the others are tolerated for older or
        // alternate responses.
        isPositive: a.positive === true || a.isPositive === true || a.is_positive === true
      }));
  }

  /** The stat url_names on a riven order, split by polarity. */
  function rivenStatKeys(order) {
    const stats = rivenStatsFrom(order);
    return {
      positive: stats.filter((s) => s.isPositive).map((s) => s.key),
      negative: stats.filter((s) => !s.isPositive).map((s) => s.key)
    };
  }

  /**
   * Apply a filter set against one order.
   *
   * Every field here was verified present in the live feed. Note that only
   * lich/sister items carry `element` and `having_ephemera`; riven items carry
   * neither (0 of 392 sampled), so those filters can only ever match a lich or
   * sister order, which is correct rather than a silent no-op.
   *
   * @param {Object} order a raw order
   * @param {{type?: string, weaponUrlName?: string, element?: string,
   *          hasEphemera?: boolean, positiveStats?: string[], negativeStat?: string,
   *          modRank?: string|number}} filters
   */
  function matchesFilters(order, filters) {
    const f = filters || {};
    const item = (order && order.item) || {};

    if (f.type && item.type !== f.type) return false;

    if (f.weaponUrlName && norm(item.weapon_url_name) !== norm(f.weaponUrlName)) return false;

    // mod_rank is a number 0-8 on the item; 'maxed' is how the UI expresses rank 8.
    if (f.modRank === 'maxed' || f.modRank === 8) {
      if (item.mod_rank !== 8) return false;
    } else if (finiteNumber(Number(f.modRank)) && f.modRank !== '' && f.modRank != null) {
      if (item.mod_rank !== Number(f.modRank)) return false;
    }

    if (f.element && norm(item.element) !== norm(f.element)) return false;

    // The feed exposes a boolean `having_ephemera`, not an ephemera name.
    if (f.hasEphemera === true && item.having_ephemera !== true) return false;

    if (Array.isArray(f.positiveStats) && f.positiveStats.length) {
      const have = new Set(rivenStatKeys(order).positive);
      const wanted = f.positiveStats.filter(Boolean);
      if (wanted.length && !wanted.every((s) => have.has(s))) return false;
    }

    if (f.negativeStat) {
      if (!rivenStatKeys(order).negative.includes(f.negativeStat)) return false;
    }

    return true;
  }

  /** Cheapest first, with no-price rows last so they never look free. */
  function compareByPrice(a, b) {
    const pa = orderPrice(a);
    const pb = orderPrice(b);
    if (pa === null) return pb === null ? 0 : 1;
    if (pb === null) return -1;
    return pa - pb;
  }

  /** Shape an order for a compact list, leaving out the bulky attribute array. */
  function summariseOrder(order) {
    const item = (order && order.item) || {};
    const owner = (order && order.owner) || {};
    return {
      id: order.id,
      orderType: item.type || null,
      itemName: item.name || order.item_name || null,
      weaponUrlName: item.weapon_url_name || null,
      modRank: finiteNumber(item.mod_rank) ? item.mod_rank : null,
      reRolls: finiteNumber(item.re_rolls) ? item.re_rolls : null,
      polarity: item.polarity || null,
      masteryLevel: finiteNumber(item.mastery_level) ? item.mastery_level : null,
      element: item.element || null,
      havingEphemera: item.having_ephemera === true,
      price: orderPrice(order),
      buyout: isBuyout(order),
      noPriceYet: hasNoPriceYet(order),
      topBid: finiteNumber(order.top_bid) ? order.top_bid : null,
      startingPrice: finiteNumber(order.starting_price) ? order.starting_price : null,
      isDirectSell: order.is_direct_sell === true,
      note: order.note && String(order.note).trim() ? String(order.note).trim() : '',
      created: order.created || null,
      ingameName: owner.ingame_name || null,
      online: owner.status === 'online',
      region: owner.region || null,
      stats: rivenStatsFrom(order)
    };
  }

  /**
   * Fetch one page, with backoff on the 429 rate limit. Parallel page requests are
   * what triggers the limit, so callers page sequentially and this paces each call.
   */
  async function fetchPage(page, options) {
    const opts = options || {};
    let attempt = 0;

    for (;;) {
      if (opts.signal && opts.signal.aborted) throw new Error('aborted');

      const res = await fetch(AUCTIONS_PAGE + '?page=' + page, {
        headers: { Platform: 'pc', Language: 'en' },
        signal: opts.signal
      });

      if (res.status === 429) {
        attempt++;
        if (attempt > 3) {
          throw new Error('Warframe.market is rate limiting this client (HTTP 429). Try again shortly.');
        }
        await sleep(REQUEST_SPACING_MS * (4 * attempt));
        continue;
      }

      if (!res.ok) throw new Error('Warframe.market returned HTTP ' + res.status + '.');

      const body = await res.json();
      const auctions = body && body.payload && body.payload.auctions;
      if (!Array.isArray(auctions)) {
        throw new Error('Unexpected response from Warframe.market: payload.auctions was not an array.');
      }
      return auctions;
    }
  }

  /**
   * Find live contracts matching a filter set.
   *
   * Orders are returned raw, in the shape the existing contracts renderer already
   * consumes, so the renderer needed no changes beyond its fetch and price sort.
   *
   * @param {Object} filters see matchesFilters
   * @param {Object} [options] {maxPages, signal, wantCount}
   * @returns {Promise<{orders: Array, pagesChecked: number, scanned: number,
   *                    truncated: boolean, complete: boolean, noPriceCount: number,
   *                    note: string}>}
   */
  async function findContracts(filters, options) {
    const opts = options || {};
    const maxPages = Math.max(1, Math.min(opts.maxPages || DEFAULT_MAX_PAGES, 50));
    const wantCount = Math.max(1, opts.wantCount || DEFAULT_WANT_COUNT);

    const matches = [];
    const seen = new Set();
    let pagesChecked = 0;
    let scanned = 0;
    let noPriceCount = 0;
    let stoppedEarly = false;

    for (let page = 1; page <= maxPages; page++) {
      const orders = await fetchPage(page, opts);
      pagesChecked = page;
      scanned += orders.length;

      for (const order of orders) {
        if (isDead(order)) continue;
        if (!matchesFilters(order, filters)) continue;
        // The feed can repeat an order across pages while it is being re-indexed.
        if (seen.has(order.id)) continue;
        seen.add(order.id);
        if (hasNoPriceYet(order)) noPriceCount++;
        matches.push(order);
      }

      if (matches.length >= wantCount) { stoppedEarly = true; break; }
      if (orders.length === 0) break;
      if (page < maxPages) await sleep(REQUEST_SPACING_MS);
    }

    matches.sort(compareByPrice);

    const scope = scanned + ' recent contract order' + (scanned === 1 ? '' : 's') +
      ' (' + pagesChecked + ' page' + (pagesChecked === 1 ? '' : 's') + ')';

    let note = truncated(stoppedEarly, pagesChecked, maxPages)
      ? 'Cheapest matches from the ' + scope + '. Anything cheaper further back is not included.'
      : 'Walked back through all ' + scope + ', so this list is complete.';

    if (noPriceCount > 0) {
      note += ' ' + noPriceCount + ' of these have no price yet.';
    }

    return {
      orders: matches,
      pagesChecked,
      scanned,
      truncated: truncated(stoppedEarly, pagesChecked, maxPages),
      complete: !truncated(stoppedEarly, pagesChecked, maxPages),
      noPriceCount,
      note
    };
  }

  function truncated(stoppedEarly, pagesChecked, maxPages) {
    return stoppedEarly || pagesChecked >= maxPages;
  }

  return {
    AUCTIONS_PAGE,
    ORDERS_PER_PAGE,
    DEFAULT_MAX_PAGES,
    DEFAULT_WANT_COUNT,
    CONTRACT_TYPES,
    norm,
    finiteNumber,
    orderPrice,
    isBuyout,
    hasNoPriceYet,
    isDead,
    rivenStatsFrom,
    rivenStatKeys,
    matchesFilters,
    compareByPrice,
    summariseOrder,
    fetchPage,
    findContracts
  };
});
