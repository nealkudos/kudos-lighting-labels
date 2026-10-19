/* Kudos Lighting Labels — core logic (no DOM).
   Shared by index.html and the Node test harness.
   Exposes: KudosLabels.extractTokens, pairTokens, buildRows, buildDocx, FIXTURE_LIBRARY */
(function (root) {
  'use strict';

  // Known fixture modes. footprint = DMX channels used (= address spacing).
  // Add to this list as new fixtures come in; the app also lets users add their own.
  const FIXTURE_LIBRARY = [
    { name: 'Robe LEDBeam 150', mode: 'Mode 1', footprint: 22 },
    { name: 'Robe LEDBeam 350', mode: 'Mode 1', footprint: 22 },
    { name: 'Robe Esprite', mode: 'Mode 3', footprint: 50 },
    { name: 'Robe Spikie', mode: 'Mode 1', footprint: 27 },
    { name: 'Ayrton Perseo Profile S', mode: 'Extended 61', footprint: 61 },
    { name: 'Martin MAC Aura XIP', mode: 'Extended 57', footprint: 57 },
    { name: 'Chauvet Color Strike M', mode: 'Mode 74', footprint: 74 },
    { name: 'LEDJ Spectra QX40 MKII', mode: 'Mode 25', footprint: 25 },
    { name: 'Astera AX9', mode: 'Mode 94', footprint: 8 }
  ];

  const ADDR_RE = /^(\d{1,2})\s*[\/.]\s*(\d{1,3})$/;   // 2/177 or 2.177
  const CHAN_RE = /^\d{3,4}$/;                          // 101, 1201

  /* ---------- 1. Text extraction ----------
     items: pdf.js textContent items for one page: {str, transform:[a,b,c,d,e,f], width, height}
     Vectorworks writes callouts as several runs and often rotates them, so runs are
     merged into words along their own baseline direction before matching. */
  function mergeRuns(items) {
    const runs = [];
    for (const it of items) {
      const s = (it.str || '');
      if (!s.trim()) { if (runs.length) runs[runs.length - 1].gapBreak = true; continue; }
      const [a, b] = it.transform;
      const size = Math.hypot(a, b) || Math.abs(it.height) || 10;
      const dx = a / size, dy = b / size;               // unit vector along baseline
      const ox = it.transform[4], oy = it.transform[5];
      runs.push({ str: s, ox, oy, dx, dy, size, width: it.width || s.length * size * 0.55 });
    }
    const words = [];
    let cur = null;
    for (const r of runs) {
      if (cur && !cur.gapBreak && sameDir(cur, r)) {
        const ex = cur.ox + cur.dx * cur.len, ey = cur.oy + cur.dy * cur.len;
        const along = (r.ox - ex) * cur.dx + (r.oy - ey) * cur.dy;
        const perp = -(r.ox - ex) * cur.dy + (r.oy - ey) * cur.dx;
        if (Math.abs(perp) < cur.size * 0.35 && along > -cur.size * 0.3 && along < cur.size * 0.15) {
          cur.str += r.str;
          cur.len = ((r.ox + r.dx * r.width) - cur.ox) * cur.dx + ((r.oy + r.dy * r.width) - cur.oy) * cur.dy;
          cur.gapBreak = r.gapBreak;
          continue;
        }
      }
      cur = { str: r.str, ox: r.ox, oy: r.oy, dx: r.dx, dy: r.dy, size: r.size, len: r.width, gapBreak: r.gapBreak };
      words.push(cur);
    }
    return words;
  }
  function sameDir(p, q) { return Math.abs(p.dx - q.dx) < 0.05 && Math.abs(p.dy - q.dy) < 0.05; }

  function centre(w) {
    // midpoint along baseline, nudged up by ~0.35 em perpendicular (text body centre)
    const mx = w.ox + w.dx * w.len / 2, my = w.oy + w.dy * w.len / 2;
    return { x: mx - w.dy * w.size * 0.35, y: my + w.dx * w.size * 0.35 };
  }

  function extractTokens(items, page) {
    const words = mergeRuns(items);
    const addrs = [], chans = [], other = [];
    for (const w of words) {
      for (const part of w.str.trim().split(/\s+/)) {
        const c = centre(w);
        const m = part.match(ADDR_RE);
        if (m) {
          const u = +m[1], a = +m[2];
          if (u === 0 || a === 0) continue;          // 0/0 = unpatched placeholder
          if (a > 512) continue;
          addrs.push({ universe: u, address: a, x: c.x, y: c.y, size: w.size, page });
        } else if (CHAN_RE.test(part)) {
          chans.push({ channel: +part, x: c.x, y: c.y, size: w.size, page });
        } else {
          other.push({ str: part, page });
        }
      }
    }
    return { addrs, chans, other, words };
  }

  /* ---------- 2. Pair each address with its nearest channel number ----------
     Greedy one-to-one by ascending distance, within maxEm × font size. */
  function pairTokens(addrs, chans, maxEm) {
    maxEm = maxEm || 4;
    const cand = [];
    addrs.forEach((a, i) => chans.forEach((c, j) => {
      if (a.page !== c.page) return;
      const d = Math.hypot(a.x - c.x, a.y - c.y);
      if (d <= maxEm * Math.max(a.size, c.size)) cand.push({ i, j, d });
    }));
    cand.sort((p, q) => p.d - q.d);
    const usedA = new Set(), usedC = new Set(), pairs = [];
    for (const k of cand) {
      if (usedA.has(k.i) || usedC.has(k.j)) continue;
      usedA.add(k.i); usedC.add(k.j);
      pairs.push({ addr: addrs[k.i], chan: chans[k.j] });
    }
    const loneAddrs = addrs.filter((_, i) => !usedA.has(i));
    return { pairs, loneAddrs };
  }

  /* ---------- 2b. Picture-only plans: OCR words -> tokens ----------
     words: [{text, conf, x0, y0, x1, y1, refined}] in page points (y down), from any rotation.
     Digits are ~0.72 of the em, so the bbox height is scaled to an em to keep pairing distances the same as text mode. */
  function overlap(a, b) {
    const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    if (w <= 0 || h <= 0) return 0;
    const area = (r) => (r.x1 - r.x0) * (r.y1 - r.y0);
    return (w * h) / Math.min(area(a), area(b));
  }
  /* Several reads of the same spot (different rotations and sizes) vote: overlapping finds are grouped,
     and the text with the highest total confidence wins. Valid patch tokens beat anything else. */
  const VALID_TOKEN = /^(\d{1,2}\/\d{1,3}|\/\d{1,3}|\d{3,4})$/;
  function dedupeWords(words) {
    const groups = [];
    words.slice().sort((p, q) => q.conf - p.conf).forEach(w => {
      const g = groups.find(g => overlap(g.box, w) > 0.4);
      if (g) g.items.push(w); else groups.push({ box: w, items: [w] });
    });
    return groups.map(g => {
      const tally = new Map();
      g.items.forEach(w => { const t = w.text.trim(); const v = VALID_TOKEN.test(t);
        const e = tally.get(t) || { score: 0, best: w, valid: v }; e.score += w.conf; if (w.conf > e.best.conf) e.best = w; tally.set(t, e); });
      const win = [...tally.values()].sort((p, q) => (q.valid - p.valid) || (q.score - p.score))[0];
      return Object.assign({}, win.best, { votes: g.items.filter(w => w.text.trim() === win.best.text.trim()).length });
    });
  }
  function tokensFromOcrWords(words, page, minConf) {
    minConf = minConf == null ? 60 : minConf;
    const addrs = [], chans = [], raws = [];
    for (const w of dedupeWords(words.filter(w => w.text && w.text.trim()))) {
      const t = w.text.trim();
      const cx = (w.x0 + w.x1) / 2, cy = (w.y0 + w.y1) / 2;
      const size = Math.min(w.x1 - w.x0, w.y1 - w.y0) / 0.72;
      // unclear address-like reads ("9254", "71256", "7/353" at low confidence) are kept for decoding next to a channel
      const weak = w.conf < 50 && (w.votes || 1) < 2 && !(w.conf >= 35 && w.refined);
      if (/^[\d\/]{3,7}$/.test(t) && /\d{2}/.test(t) && (t.includes('/') || t.length >= 4) && (weak || !ADDR_RE.test(t))) {
        raws.push({ text: t, x: cx, y: cy, size, page, conf: w.conf });
        if (weak || !ADDR_RE.test(t)) continue;
      }
      if (weak) continue;                                            // a weak read only counts if another read agrees
      const m = t.match(ADDR_RE), part = t.match(/^\/(\d{1,3})$/);   // "/353": universe hidden under a symbol
      if (m) {
        const u = +m[1], a = +m[2];
        if (u && a && a <= 512) addrs.push({ universe: u, address: a, x: cx, y: cy, size, page, ocr: true, box: w });
      } else if (part && +part[1] && +part[1] <= 512) {
        addrs.push({ universe: null, address: +part[1], x: cx, y: cy, size, page, ocr: true, box: w });
      } else if (CHAN_RE.test(t)) chans.push({ channel: +t, x: cx, y: cy, size, page, ocr: true, box: w });
    }
    return { addrs, chans, raws, other: [], words: [], ocr: true };
  }
  /* Channels that found no address after the first pass: where to look again, closer up. */
  function unpairedChannels(tokens) {
    const { pairs } = pairTokens(tokens.addrs, tokens.chans);
    const used = new Set(pairs.map(p => p.chan));
    return tokens.chans.filter(c => !used.has(c));
  }

  /* ---------- 2b'. Clean a picture before reading it ----------
     d: RGBA pixels (modified in place), w × h. digitPx: expected digit height in pixels.
     1) coloured ink -> paper (fixture symbols, blue labels);
     2) solid shapes much thicker than a pen stroke -> paper (filled fixture symbols touching the numbers);
     3) stretch grey text to black (some exports render callouts in mid grey). */
  function cleanPixels(d, w, h, digitPx) {
    const n = w * h, g = new Uint8Array(n);
    for (let i = 0, p = 0; p < n; i += 4, p++) {
      const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
      g[p] = (mx - mn > 50) ? 255 : (d[i] + d[i + 1] + d[i + 2]) / 3;
    }
    const k = Math.max(3, Math.round(0.45 * (digitPx || 20)));       // thicker than any stroke of a digit
    const W = w + 1;
    const I1 = new Int32Array(W * (h + 1));
    for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += g[y * w + x] < 110 ? 1 : 0; I1[(y + 1) * W + x + 1] = I1[y * W + x + 1] + row; } }
    // seeds: centres of k×k squares that are entirely dark — only solid shapes have them
    const removed = new Uint8Array(n), stack = new Int32Array(n);
    let sp = 0;
    const half = k >> 1;
    for (let y = half; y + k - half <= h; y++) for (let x = half; x + k - half <= w; x++) {
      const x0 = x - half, y0 = y - half, x1 = x0 + k, y1 = y0 + k;
      if (I1[y1 * W + x1] - I1[y0 * W + x1] - I1[y1 * W + x0] + I1[y0 * W + x0] === k * k) {
        const p = y * w + x; if (!removed[p]) { removed[p] = 1; stack[sp++] = p; }
      }
    }
    // grow each solid shape through everything dark it touches, so its thin edges and frames go too
    while (sp) {
      const p = stack[--sp], x = p % w, y = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx; if (!removed[q] && g[q] < 110) { removed[q] = 1; stack[sp++] = q; }
      }
    }
    // clear the removed shapes plus a small halo of anti-aliasing
    const r = Math.max(2, Math.round(k / 12));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!removed[y * w + x]) continue;
      for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++)
        for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) g[yy * w + xx] = 255;
    }
    // levels: anything at or below 60 is black, 215 and up is paper
    for (let i = 0, p = 0; p < n; i += 4, p++) {
      const v = Math.max(0, Math.min(255, Math.round((g[p] - 60) * 255 / 155)));
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    return d;
  }

  // A key line that gives a channel count: "x8 (37 channel/Mode 1)", "8x (97 Channel )", "4x 61 (Channel)", "(43 Ch)"
  function parseCountLine(text) {
    const t = text.replace(/[\u2018\u2019]/g, "'");
    const fp = t.match(/(\d{1,3})\s*\(?\s*ch(?:annel)?s?\b/i) || t.match(/\(\s*(\d{1,3})\s*ch/i);
    if (!fp) return null;
    const qty = t.match(/(?:^|[\s(])(\d{1,3})\s*[x×]\b/i) || t.match(/\b[x×]\s*(\d{1,3})\b/i);
    const mode = t.match(/mode\s*([\w.\-]+(?:\s+[\w.\-]+)?)/i);
    // where the count part starts: anything before it on the same line is the fixture name
    const starts = [fp.index, qty ? qty.index : Infinity, t.search(/\(/)].filter(i => i >= 0);
    const before = t.slice(0, Math.min(...starts)).trim();
    return { footprint: +fp[1], qty: qty ? +qty[1] : null, mode: mode ? 'Mode ' + mode[1].trim().replace(/\)+$/, '') : null, before };
  }
  const COUNT_RE = { test: (s) => !!parseCountLine(s) };
  function cleanFixtureName(s) {
    return s.replace(/@/g, ' ').replace(/\.gdtf\b/ig, '').replace(/\s+/g, ' ').trim();
  }
  function parseLegendLines(lines) {
    const out = [];
    const sorted = lines.filter(l => l.text && l.text.trim()).slice().sort((a, b) => a.y - b.y || a.x - b.x);
    sorted.forEach((l, i) => {
      const c = parseCountLine(l.text.trim());
      if (!c) return;
      const nameParts = [];
      const lh = l.h || 12;
      for (let j = i - 1; j >= 0 && nameParts.length < 2; j--) {
        const p = sorted[j];
        if (Math.abs(p.y - l.y) > lh * 4.5) break;                 // too far above
        if (Math.abs(p.x - l.x) > lh * 8) continue;                 // another part of the drawing at the same height
        if (/symbol\s*key|^key$/i.test(p.text.trim())) break;
        if (parseCountLine(p.text.trim())) break;                   // the entry above
        nameParts.unshift(p.text.trim());
      }
      if (c.before && /[a-z]{3}/i.test(c.before)) nameParts.push(c.before);
      const name = cleanFixtureName(nameParts.join(' '));
      if (!name || !/[a-z]{3}/i.test(name)) return;
      out.push({ name, mode: c.mode || c.footprint + ' Ch', footprint: c.footprint, qty: c.qty, fromDrawing: true });
    });
    return out;
  }

  /* ---------- 2d. Truss / position names (LX 1, LX2, Truss 3, FOH 1 …) ----------
     labels: [{name, x, y, page}] in the same coordinates as that page's tokens. */
  const POSITION_RE = /^(LX|TRUSS|BAR|PIPE|BOOM|FOH|TOWER|LADDER)\s*-?\s*(\d{1,2}[A-Z]?)$/i;
  function positionName(text) {
    const m = String(text).trim().replace(/[|.:]+$/, '').match(POSITION_RE);
    if (!m) return null;
    const head = m[1].toUpperCase();
    const pretty = ['LX', 'FOH'].includes(head) ? head : head[0] + head.slice(1).toLowerCase();
    return pretty + ' ' + m[2].toUpperCase();
  }
  function positionLabelsFromWords(words, page) {
    const out = [];
    words.forEach(w => { const n = positionName(w.str); if (n) { const c = centre(w); out.push({ name: n, x: c.x, y: c.y, page }); } });
    return out;
  }
  /* Fixtures on one truss sit in a line: group addresses that line up across or down the page,
     then give each group the nearest position name. */
  function assignPositions(rows, labels) {
    if (!labels.length) return;
    const pages = [...new Set(labels.map(l => l.page))];
    for (const page of pages) {
      const labs = labels.filter(l => l.page === page);
      const pts = [];
      rows.forEach(r => (r.at || []).forEach(a => { if (a.page === page) pts.push({ r, x: a.x, y: a.y, em: a.size || 8, page }); }));
      if (!pts.length) continue;
      const groups = new Map(lineGroups(pts).map((g, i) => [i, g]));
      for (const g of groups.values()) {
        const x0 = Math.min(...g.map(p => p.x)), x1 = Math.max(...g.map(p => p.x));
        const y0 = Math.min(...g.map(p => p.y)), y1 = Math.max(...g.map(p => p.y));
        const em = g[0].em;
        let best = null;
        labs.forEach(l => {
          const dx = Math.max(0, x0 - l.x, l.x - x1), dy = Math.max(0, y0 - l.y, l.y - y1);
          const d = Math.hypot(dx, dy);
          if (!best || d < best.d) best = { d, name: l.name };
        });
        if (best && best.d < 30 * em) g.forEach(p => { if (!p.r.position) p.r.position = best.name; });
      }
    }
  }

  /* An unclear address read beside channel 905: "9254" -> 254, "91254" -> 254 (slash read as 1), "/353" -> 353.
     Only a single possible reading is accepted. */
  function decodeAddress(raw, U) {
    const t = String(raw).replace(/[^\d\/]/g, ''), us = String(U), out = new Set();
    const tryFrom = (s) => {
      if (!s.startsWith(us)) return;
      const rest = s.slice(us.length);
      for (const sep of ['/', '', '1', '7']) {
        if (sep && !rest.startsWith(sep)) continue;
        const a = rest.slice(sep.length);
        if (/^\d{1,3}$/.test(a) && +a >= 1 && +a <= 512) out.add(+a);
      }
    };
    if (t.startsWith('/')) tryFrom(us + t);
    else {
      tryFrom(t);
      if (!out.size && t.length > 2) tryFrom(t.slice(1));             // a stray mark read in front ("37/353")
      if (!out.size && t.length > 2) tryFrom(us + t.slice(1));        // first digit misread ("8190" beside 603)
    }
    return out.size === 1 ? [...out][0] : null;
  }
  /* Rows whose callouts line up across or down the page (one truss or boom each). */
  function lineGroups(items) {                       // items: [{x, y, em, page, ref}]
    // one bad read can report a huge text size; keep every size near the plan's typical one
    const ems = items.map(it => it.em).sort((a, b) => a - b), med = ems.length ? ems[ems.length >> 1] : 8;
    items.forEach(it => { it.em = Math.min(Math.max(it.em, med * 0.6), med * 1.5); });
    // link down columns and along rows separately; each fixture joins whichever of its two lines is longer,
    // so neighbouring columns don't merge through their side-by-side rows
    const linkUp = (vertical) => {
      const parent = items.map((_, i) => i);
      const find = (i) => parent[i] === i ? i : (parent[i] = find(parent[i]));
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j]; if (a.page !== b.page) continue;
        const em = Math.max(a.em, b.em), dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
        if (vertical ? (dx < 1.5 * em && dy < 14 * em) : (dy < 1.5 * em && dx < 14 * em)) parent[find(i)] = find(j);
      }
      const root = items.map((_, i) => find(i)), size = new Map();
      root.forEach(r => size.set(r, (size.get(r) || 0) + 1));
      return { root, size };
    };
    const V = linkUp(true), Hh = linkUp(false);
    const groups = new Map();
    items.forEach((it, i) => {
      const sv = V.size.get(V.root[i]), sh = Hh.size.get(Hh.root[i]);
      const k = sv >= sh ? 'V' + V.root[i] : 'H' + Hh.root[i];
      if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it);
    });
    return [...groups.values()];
  }
  /* On one line of fixtures, a single channel whose first digit differs from all the rest is a misread (403 among 802–805). */
  function fixChannelOutliers(rows) {
    const dbg = api.debug || null;
    const items = [];
    rows.forEach(r => { const a = (r.at || [])[0]; if (a && r.channel != null && r.channel < 1000) items.push({ x: a.x, y: a.y, em: a.size || 8, page: a.page, ref: r }); });
    const used = new Set(rows.map(r => r.channel).filter(c => c != null));
    lineGroups(items).forEach(g => {
      if (dbg) dbg({ r: { x0: 0, y0: 0, x1: 0, y1: 0 }, rot: 'group', score: g.length, text: g.map(it => it.ref.channel + '@' + Math.round(it.x) + ',' + Math.round(it.y) + '/em' + it.em.toFixed(1)).join(' ') });
      if (g.length < 3) return;
      const count = new Map(); g.forEach(it => { const b = Math.floor(it.ref.channel / 100); count.set(b, (count.get(b) || 0) + 1); });
      const [top, n] = [...count].sort((a, b) => b[1] - a[1])[0];
      const outliers = g.filter(it => Math.floor(it.ref.channel / 100) !== top);
      if (n / g.length < 0.75 || outliers.length > Math.max(1, Math.floor(g.length / 5))) return;
      outliers.forEach(it => {
        const r = it.ref, c = top * 100 + (r.channel % 100);
        if (used.has(c) || c % 100 === 0) return;
        used.delete(r.channel); used.add(c);
        r.readChannel = r.channel; r.channel = c; r.inferred = 'channel-fixed';
      });
    });
  }

  /* ---------- 2e. Kudos numbering: channel 805 lives in universe 8 ----------
     When most of the plan follows that rule, use it to fill what the drawing hides:
     a universe digit covered by a fixture symbol, or the one channel number missing from a universe's run.
     Every row filled this way is marked inferred so it gets checked. */
  function repairByConvention(rows, orphans, footprints) {
    const H = (c) => Math.floor(c / 100);
    const paired = rows.filter(r => r.channel != null && r.universe != null);
    const follow = paired.filter(r => r.universe === H(r.channel)).length;
    if (paired.length < 4 || follow / paired.length < 0.75) return;
    const keyOf = (u, a) => u + '/' + a;
    const taken = new Set(rows.filter(r => r.universe != null).map(r => keyOf(r.universe, r.address)));
    // a) universe missing or misread on a row whose channel is clear
    rows.forEach(r => {
      if (r.channel == null) return;
      const u = H(r.channel);
      if (r.universe === u || taken.has(keyOf(u, r.address))) return;
      if (r.universe != null) taken.delete(keyOf(r.universe, r.address));
      r.inferred = r.universe == null ? 'universe-hidden' : 'universe-fixed';
      r.readUniverse = r.universe; r.universe = u; taken.add(keyOf(u, r.address));
    });
    // b) an address with no channel: the channel left over in that universe
    const used = new Set(rows.map(r => r.channel).filter(c => c != null));
    const lone = rows.filter(r => r.channel == null && r.universe != null);
    const universes = [...new Set(lone.map(r => r.universe))];
    universes.forEach(u => {
      const mine = lone.filter(r => r.universe === u);
      if (mine.length !== 1) return;
      const r = mine[0];
      const orphan = orphans.filter(o => o.universe == null && o.address == null && H(o.channel) === u);
      if (orphan.length === 1) {                                     // a channel was read but sat too far away
        r.channel = orphan[0].channel; r.inferred = 'channel-matched';
        orphans.splice(orphans.indexOf(orphan[0]), 1); return;
      }
      if (orphan.length) return;
      const idx = [...used].filter(c => H(c) === u).map(c => c % 100);
      if (!idx.length) return;
      const max = Math.max(...idx), missing = [];
      for (let i = 1; i <= max; i++) if (!idx.includes(i)) missing.push(i);
      const pick = missing.length === 1 ? missing[0] : missing.length === 0 ? max + 1 : null;
      if (pick == null) return;
      r.channel = u * 100 + pick; r.inferred = 'channel-gap'; used.add(r.channel);
    });
    const fpList = [...new Set((footprints || []).filter(Boolean))];
    const splits = (g) => { const out = new Set(); fpList.forEach(a => { if (fpList.includes(g - a)) out.add(a); }); return [...out]; };
    const oneDigitOff = (a, b) => { const x = String(a), y = String(b); return x.length === y.length && [...x].filter((ch, i) => ch !== y[i]).length === 1; };
    const sortedIn = (u) => rows.filter(r => r.universe === u).sort((p, q) => p.address - q.address);
    // d) an address one digit off from where the spacing says it must be (7.169 between 7.62 and 7.256 -> 7.159)
    if (fpList.length) [...new Set(rows.filter(r => r.universe != null).map(r => r.universe))].forEach(u => {
      const list = sortedIn(u);
      for (let i = 1; i < list.length - 1; i++) {
        const p = list[i - 1], r = list[i], n = list[i + 1];
        if (fpList.includes(r.address - p.address) && fpList.includes(n.address - r.address)) continue;
        const cands = splits(n.address - p.address).map(a => p.address + a).filter(c => oneDigitOff(c, r.address));
        if (cands.length === 1 && !taken.has(keyOf(u, cands[0]))) {
          taken.delete(keyOf(u, r.address)); r.readAddress = r.address; r.address = cands[0]; taken.add(keyOf(u, r.address)); r.inferred = 'address-fixed';
        }
      }
    });
    // e) a fixture missing between two others (6.62 … 6.190 with 64-ch fixtures either side -> one at 6.126)
    if (fpList.length) [...new Set(rows.filter(r => r.universe != null).map(r => r.universe))].forEach(u => {
      const list = sortedIn(u);
      for (let i = 0; i < list.length - 1; i++) {
        const p = list[i], n = list[i + 1], g = n.address - p.address;
        if (fpList.includes(g) || p.channel == null || n.channel == null) continue;
        const sp = splits(g); if (sp.length !== 1) continue;
        const addr = p.address + sp[0];
        if (taken.has(keyOf(u, addr))) continue;
        const between = (c) => c > Math.min(p.channel, n.channel) && c < Math.max(p.channel, n.channel);
        const oi = orphans.findIndex(o => o.universe == null && o.channel != null && Math.floor(o.channel / 100) === u && between(o.channel));
        let ch = null, how = 'gap-fill-read', at = [];
        if (oi >= 0 && orphans.filter(o => o.universe == null && o.channel != null && Math.floor(o.channel / 100) === u && between(o.channel)).length === 1) {
          ch = orphans[oi].channel; at = orphans[oi].at || []; orphans.splice(oi, 1);
        } else {
          const free = []; for (let c = Math.min(p.channel, n.channel) + 1; c < Math.max(p.channel, n.channel); c++) if (!rows.some(r => r.channel === c)) free.push(c);
          if (free.length !== 1) continue;
          ch = free[0]; how = 'gap-fill';
        }
        rows.push({ universe: u, address: addr, channel: ch, pages: p.pages.slice(), at, ocr: true, inferred: how });
        taken.add(keyOf(u, addr));
      }
    });
    // f) addresses with no channel, in a universe where channels rise with the address: give them the next free numbers in order
    [...new Set(rows.filter(r => r.universe != null && r.channel == null).map(r => r.universe))].forEach(u => {
      const list = sortedIn(u), known = list.filter(r => r.channel != null);
      if (known.length < 2 || known.some((r, i) => i && r.channel < known[i - 1].channel) || known.some(r => Math.floor(r.channel / 100) !== u)) return;
      const usedC = new Set(rows.map(r => r.channel).filter(c => c != null));
      let last = u * 100;
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (r.channel != null) { last = r.channel; continue; }
        const nextKnown = list.slice(i + 1).find(x => x.channel != null);
        let c = last + 1; while (usedC.has(c)) c++;
        if (nextKnown && c >= nextKnown.channel) continue;
        if (Math.floor(c / 100) !== u) continue;
        const oi = orphans.findIndex(o => o.channel === c && o.universe == null);
        if (oi >= 0) orphans.splice(oi, 1);
        r.channel = c; r.inferred = 'channel-order'; usedC.add(c); last = c;
      }
    });
    // c) a universe whose first address isn't 1, where the gap is exactly one fixture from the key:
    //    that fixture is at /1, hidden on the drawing, with the first channel of the universe
    const fps = new Set((footprints || []).filter(Boolean));
    const unis = [...new Set(rows.filter(r => r.universe != null).map(r => r.universe))];
    unis.forEach(u => {
      const inU = rows.filter(r => r.universe === u);
      const minA = Math.min(...inU.map(r => r.address));
      if (minA <= 1 || !fps.has(minA - 1)) return;
      const chans = inU.map(r => r.channel).filter(c => c != null);
      const c = u * 100 + 1;
      if (!chans.length || chans.includes(c) || Math.min(...chans) <= c) return;
      if (rows.some(r => r.channel === c && r.universe != null)) return;
      const o = orphans.findIndex(x => x.channel === c && x.universe == null);
      const at = o >= 0 ? orphans[o].at : [];
      if (o >= 0) orphans.splice(o, 1);
      rows.push({ universe: u, address: 1, channel: c, pages: inU[0].pages.slice(), at: at || [], ocr: true, inferred: o >= 0 ? 'leading-gap-read' : 'leading-gap' });
    });
  }

  /* ---------- 3. Merge pages into one row per DMX address, with checks ----------
     opts.legend: fixtures read from the drawing's key (name, mode, footprint, qty) — preferred over the library. */
  function buildRows(pagesTokens, library, opts) {
    library = library || FIXTURE_LIBRARY;
    opts = opts || {};
    const legend = opts.legend || [];
    const byKey = new Map();
    const conflicts = [];
    const loneChans = [];
    for (const pt of pagesTokens) {
      const { pairs, loneAddrs } = pairTokens(pt.addrs, pt.chans);
      const pairedChans = new Set(pairs.map(p => p.chan));
      for (const p of pairs) {
        const key = p.addr.universe + '/' + p.addr.address;
        const prev = byKey.get(key);
        const at = { page: p.addr.page, x: p.addr.x, y: p.addr.y, size: p.addr.size };
        if (!prev) byKey.set(key, { universe: p.addr.universe, address: p.addr.address, channel: p.chan.channel, pages: [p.addr.page], at: [at], ocr: !!pt.ocr });
        else {
          prev.at = (prev.at || []).concat(at);
          if (!prev.pages.includes(p.addr.page)) prev.pages.push(p.addr.page);
          if (prev.channel == null) prev.channel = p.chan.channel;
          else if (prev.channel !== p.chan.channel) conflicts.push({ key, channels: [prev.channel, p.chan.channel], page: p.addr.page });
        }
      }
      for (const a of loneAddrs) {
        const key = a.universe + '/' + a.address;
        const at = { page: a.page, x: a.x, y: a.y, size: a.size };
        if (!byKey.has(key)) byKey.set(key, { universe: a.universe, address: a.address, channel: null, pages: [a.page], at: [at], ocr: !!pt.ocr });
        else byKey.get(key).at.push(at);
      }
      // a channel with no clear address: decode the nearest unclear read beside it
      const usedRaw = new Set();
      pt.chans.forEach(c => {
        if (pairedChans.has(c) || !pt.raws || !pt.raws.length) return;
        const near = pt.raws.filter(w => !usedRaw.has(w) && Math.hypot(w.x - c.x, w.y - c.y) <= 4 * Math.max(w.size, c.size))
          .sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y));
        for (const w of near) {
          const a = decodeAddress(w.text, Math.floor(c.channel / 100));
          if (a == null) continue;
          const u = Math.floor(c.channel / 100), key = u + '/' + a;
          if (byKey.has(key)) continue;
          usedRaw.add(w); pairedChans.add(c);
          byKey.set(key, { universe: u, address: a, channel: c.channel, pages: [c.page], at: [{ page: c.page, x: w.x, y: w.y, size: w.size }], ocr: true, inferred: 'decoded', readAs: w.text });
          break;
        }
      });
      pt.chans.forEach(c => { if (!pairedChans.has(c)) loneChans.push({ channel: c.channel, page: c.page, ocr: !!pt.ocr, at: [{ page: c.page, x: c.x, y: c.y, size: c.size }] }); });
    }
    let rows = [...byKey.values()];

    // A channel number with no readable address beside it still gets a row when it belongs to a run
    // already on the plan (e.g. 101 when 102–106 were found). Dimensions like 3775 are ignored.
    const known = new Set(rows.map(r => r.channel).filter(c => c != null));
    const orphanRows = [];
    for (const c of loneChans) {
      if (known.has(c.channel)) continue;
      const block = Math.floor(c.channel / 100);
      const run = [...known].filter(k => Math.floor(k / 100) === block);
      if (run.length >= 2 && c.channel >= Math.min(...run) - 2 && c.channel <= Math.max(...run) + 2) {
        known.add(c.channel);
        orphanRows.push({ universe: null, address: null, channel: c.channel, pages: [c.page], at: c.at, ocr: c.ocr, fixture: '', suggestions: [] });
      }
    }

    fixChannelOutliers(rows.concat(orphanRows));
    repairByConvention(rows, orphanRows, legend.map(f => f.footprint).concat(legend.length ? [] : library.map(f => f.footprint)));
    orphanRows.push(...rows.filter(r => r.universe == null));        // address still unknown
    rows = rows.filter(r => r.universe != null).sort((p, q) => p.universe - q.universe || p.address - q.address);

    // footprint = gap to next address in same universe
    rows.forEach((r, i) => {
      const n = rows[i + 1];
      r.footprint = (n && n.universe === r.universe) ? n.address - r.address : null;
    });
    // last fixture in a universe: assume same footprint as the one before
    rows.forEach((r, i) => {
      if (r.footprint == null) {
        const p = rows[i - 1];
        r.footprintGuess = (p && p.universe === r.universe) ? p.footprint : null;
      }
    });
    // name from footprint: the drawing's own key first, then the library (only when exactly one matches)
    rows.forEach(r => {
      const fp = r.footprint != null ? r.footprint : r.footprintGuess;
      const fromKey = legend.filter(f => f.footprint === fp);
      const hits = fromKey.length ? fromKey : library.filter(f => f.footprint === fp);
      r.suggestions = hits;
      r.fixture = hits.length === 1 ? hits[0].name + ' (' + hits[0].mode + ')' : '';
      r.fromKey = fromKey.length === 1;
    });

    assignPositions(rows, opts.positions || []);
    const all = rows.concat(orphanRows);
    return { rows: all, issues: checkRows(all, conflicts, legend) };
  }

  function checkRows(rows, conflicts, legend) {
    const issues = [];
    (conflicts || []).forEach(c => issues.push({ type: 'conflict', msg: `${c.key} has channel ${c.channels[0]} on one page and ${c.channels[1]} on page ${c.page}` }));
    rows.filter(r => r.universe == null && r.channel != null).forEach(r => issues.push({ type: 'missing', msg: `Channel ${r.channel} has no readable address next to it. Add it in the table.` }));
    rows.filter(r => r.universe == null && r.channel == null).forEach(r => issues.push({ type: 'missing', msg: `An address ending /${r.address} has no readable universe or channel. Add it in the table, or remove it.` }));
    rows.filter(r => r.inferred).forEach(r => {
      const a = r.universe + '.' + r.address;
      const why = r.inferred === 'universe-hidden' ? `the universe digit is hidden on the drawing, so it was taken from the channel number`
        : r.inferred === 'universe-fixed' ? `the universe read as ${r.readUniverse}, which doesn't match channel ${r.channel}, so it was taken from the channel number`
        : r.inferred === 'channel-matched' ? `the channel number was matched to the only unpaired address in universe ${r.universe}`
        : r.inferred === 'leading-gap' ? `nothing readable at ${r.universe}.1, but universe ${r.universe} starts later by exactly one fixture from the key and ${r.channel} is missing, so it was added`
        : r.inferred === 'leading-gap-read' ? `channel ${r.channel} was read but its address wasn't; universe ${r.universe} starts later by exactly one fixture from the key, so it was placed at ${r.universe}.1`
        : r.inferred === 'address-fixed' ? `the address read as ${r.universe}.${r.readAddress}, one digit off from where the fixture spacing puts it`
        : r.inferred === 'gap-fill' ? `nothing readable here, but the spacing leaves room for exactly one fixture from the key and ${r.channel} is the only channel missing between its neighbours, so it was added`
        : r.inferred === 'gap-fill-read' ? `channel ${r.channel} was read but its address wasn't; the spacing leaves room for exactly one fixture here`
        : r.inferred === 'channel-order' ? `the address was read but not the channel; channels in universe ${r.universe} rise with the address, so it takes the next free number`
        : r.inferred === 'decoded' ? `the address read unclearly as "${r.readAs}" and was decoded using the channel's universe`
        : r.inferred === 'channel-fixed' ? `the channel read as ${r.readChannel}, the only one on its truss not starting with ${Math.floor(r.channel / 100)}`
        : `the channel number is hidden on the drawing; ${r.channel} is the only one missing from universe ${r.universe}`;
      issues.push({ type: 'inferred', msg: `${r.channel} at ${a}: ${why}. Check it.` });
    });
    rows.filter(r => r.universe != null && r.channel == null).forEach(r => issues.push({ type: 'missing', msg: `${r.universe}.${r.address} has no channel number next to it` }));
    const seen = new Map();
    rows.forEach(r => { if (r.channel != null) { const k = r.channel; seen.set(k, (seen.get(k) || []).concat(r.universe != null ? r.universe + '.' + r.address : 'no address')); } });
    for (const [ch, list] of seen) if (list.length > 1) issues.push({ type: 'duplicate', msg: `Channel ${ch} is on ${list.join(' and ')}` });
    const chs = [...seen.keys()].sort((a, b) => a - b);
    for (let i = 1; i < chs.length; i++) {
      const g = chs[i] - chs[i - 1];
      if (g > 1 && g < 5 && Math.floor(chs[i] / 100) === Math.floor(chs[i - 1] / 100)) {
        const missing = []; for (let c = chs[i - 1] + 1; c < chs[i]; c++) missing.push(c);
        issues.push({ type: 'gap', msg: `Channel ${missing.join(', ')} not found between ${chs[i - 1]} and ${chs[i]}` });
      }
    }
    // the key's quantities against what was found
    (legend || []).forEach(f => {
      if (f.qty == null) return;
      const label = f.name + ' (' + f.mode + ')';
      const n = rows.filter(r => r.fixture === label).length;
      if (n !== f.qty) issues.push({ type: 'count', msg: `The key says ${f.qty} × ${f.name}, but ${n} label${n === 1 ? ' is' : 's are'} set to it.` });
    });
    return issues;
  }

  function sortForLabels(rows) {
    return rows.slice().sort((a, b) => (a.channel ?? 1e9) - (b.channel ?? 1e9) || (a.universe ?? 99) - (b.universe ?? 99) || (a.address ?? 0) - (b.address ?? 0));
  }

  /* ---------- 4. Word document on the Avery 16-per-sheet layout ----------
     A4, 8 rows × 3 columns (column 2 is a 3 mm gutter), cells 9.906 × 3.387 cm,
     paragraph style "Avery Style 1", cells vertically centred. One table per sheet,
     separated by a 1 pt page-break paragraph so sheets don't drift. */
  const TW = { cellW: 5616, gutter: 170, rowH: 1920, pageW: 11906, pageH: 16838 };
  TW.marginX = Math.round((TW.pageW - (TW.cellW * 2 + TW.gutter)) / 2);   // ≈ 4.4 mm
  TW.marginTop = Math.round((TW.pageH - TW.rowH * 8) / 2);                // ≈ 13 mm

  /* Label lines under the channel: the address ("5.1"), then the truss ("LX 3") on its own line when known and shown */
  function addrLine(l) { return l.universe != null ? l.universe + '.' + l.address : ''; }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function para(text, halfPts, bold) {
    if (text === '' || text == null) return `<w:p><w:pPr><w:pStyle w:val="AveryStyle1"/></w:pPr></w:p>`;
    return `<w:p><w:pPr><w:pStyle w:val="AveryStyle1"/></w:pPr><w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="${halfPts}"/><w:szCs w:val="${halfPts}"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
  }

  function labelCell(lbl, border) {
    const b = border === 'none' ? '' :
      `<w:tcBorders>${['top', 'left', 'bottom', 'right'].map(s => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="${border === 'black' ? '000000' : 'C8C8C8'}"/>`).join('')}</w:tcBorders>`;
    const body = lbl
      ? para(lbl.fixture || '', 28, false) + para(lbl.channel != null ? String(lbl.channel) : '', 56, true) + para(addrLine(lbl), 28, false) + (lbl.position ? para(lbl.position, 28, false) : '')
      : para('', 28, false);
    return `<w:tc><w:tcPr><w:tcW w:w="${TW.cellW}" w:type="dxa"/>${b}<w:vAlign w:val="center"/></w:tcPr>${body}</w:tc>`;
  }
  function gutterCell() {
    return `<w:tc><w:tcPr><w:tcW w:w="${TW.gutter}" w:type="dxa"/><w:tcBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/></w:tcBorders></w:tcPr><w:p><w:pPr><w:pStyle w:val="AveryStyle1"/></w:pPr></w:p></w:tc>`;
  }

  function sheetTable(labels, border) {
    let rowsXml = '';
    for (let r = 0; r < 8; r++) {
      const L = labels[r * 2], R = labels[r * 2 + 1];
      rowsXml += `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${TW.rowH}" w:hRule="exact"/></w:trPr>${labelCell(L, border)}${gutterCell()}${labelCell(R, border)}</w:tr>`;
    }
    return `<w:tbl><w:tblPr><w:tblW w:w="${TW.cellW * 2 + TW.gutter}" w:type="dxa"/><w:tblLayout w:type="fixed"/>` +
      `<w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders>` +
      `<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="57" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="57" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
      `<w:tblGrid><w:gridCol w:w="${TW.cellW}"/><w:gridCol w:w="${TW.gutter}"/><w:gridCol w:w="${TW.cellW}"/></w:tblGrid>${rowsXml}</w:tbl>`;
  }

  const TINY_P = (brk) => `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr>${brk ? '<w:r><w:rPr><w:sz w:val="2"/></w:rPr><w:br w:type="page"/></w:r>' : ''}</w:p>`;

  function documentXml(labels, border) {
    const sheets = [];
    for (let i = 0; i < Math.max(labels.length, 1); i += 16) sheets.push(labels.slice(i, i + 16));
    let body = '';
    sheets.forEach((s, i) => { body += sheetTable(s, border) + TINY_P(i < sheets.length - 1); });
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr><w:pgSz w:w="${TW.pageW}" w:h="${TW.pageH}"/><w:pgMar w:top="${TW.marginTop}" w:right="${TW.marginX}" w:bottom="0" w:left="${TW.marginX}" w:header="0" w:footer="0" w:gutter="0"/><w:cols w:space="720"/></w:sectPr></w:body></w:document>`;
  }

  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:eastAsia="Arial"/><w:sz w:val="28"/><w:szCs w:val="28"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="AveryStyle1"><w:name w:val="Avery Style 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="0" w:right="0"/><w:jc w:val="center"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:color w:val="000000"/></w:rPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

  const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const core = (title) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>Kudos AV</dc:creator></cp:coreProperties>`;

  /* labels: [{fixture, channel, universe, address}] already in print order.
     opts: {border:'none'|'grey'|'black', title}. Returns a Promise of a Blob/Uint8Array via JSZip. */
  function buildDocx(JSZip, labels, opts) {
    opts = opts || {};
    const zip = new JSZip();
    zip.file('[Content_Types].xml', CONTENT_TYPES);
    zip.file('_rels/.rels', ROOT_RELS);
    zip.file('word/_rels/document.xml.rels', DOC_RELS);
    zip.file('word/document.xml', documentXml(labels, opts.border || 'grey'));
    zip.file('word/styles.xml', STYLES);
    zip.file('docProps/core.xml', core(opts.title || 'Lighting Labels'));
    return zip.generateAsync({ type: opts.type || 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  }

  /* ---------- 5. Print geometry (mm) shared by the PDF and the browser print layout ----------
     Same grid as the Word file, so all three outputs land on the same stickers. */
  const MM = (tw) => tw * 25.4 / 1440;
  const GEO = {
    pageW: 210, pageH: 297,
    top: MM(TW.marginTop), left: MM(TW.marginX),
    cellW: MM(TW.cellW), cellH: MM(TW.rowH), gutter: MM(TW.gutter),
    pt: { name: 14, chan: 28, addr: 14, minName: 8 }
  };
  const PT_MM = 25.4 / 72;
  function cellOrigin(i) {   // i = 0..15 on a sheet
    const col = i % 2, row = Math.floor(i / 2);
    return { x: GEO.left + col * (GEO.cellW + GEO.gutter), y: GEO.top + row * GEO.cellH };
  }
  /* Font size for the fixture line so it fits on one line; measure(text, pt) returns width in mm */
  function fitNamePt(text, measure) {
    const max = GEO.cellW - 4;
    let pt = GEO.pt.name;
    while (pt > GEO.pt.minName && measure(text, pt) > max) pt -= 0.5;
    return pt;
  }

  /* labels as for buildDocx. jsPDF: the jsPDF constructor. Returns the jsPDF document. */
  function buildPdf(jsPDF, labels, opts) {
    opts = opts || {};
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    doc.setProperties({ title: opts.title || 'Lighting Labels', creator: 'Kudos AV' });
    const measure = (t, pt) => { doc.setFontSize(pt); return doc.getTextWidth(t); };
    const sheets = Math.max(1, Math.ceil(labels.length / 16));
    for (let s = 0; s < sheets; s++) {
      if (s) doc.addPage('a4', 'portrait');
      for (let i = 0; i < 16; i++) {
        const { x, y } = cellOrigin(i);
        if (opts.border && opts.border !== 'none') {
          doc.setDrawColor(opts.border === 'black' ? 0 : 200); doc.setLineWidth(0.2);
          doc.rect(x, y, GEO.cellW, GEO.cellH);
        }
        const L = labels[s * 16 + i]; if (!L) continue;
        const namePt = fitNamePt(L.fixture || '', measure);
        const lh = (pt) => pt * PT_MM * 1.15;
        const hName = lh(GEO.pt.name), hChan = lh(GEO.pt.chan), hAddr = lh(GEO.pt.addr), hPos = L.position ? lh(GEO.pt.addr) : 0;
        const y0 = y + (GEO.cellH - (hName + hChan + hAddr + hPos)) / 2;
        const cx = x + GEO.cellW / 2;
        doc.setTextColor(0);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(namePt);
        if (L.fixture) doc.text(L.fixture, cx, y0 + hName * 0.78, { align: 'center' });
        doc.setFont('helvetica', 'bold'); doc.setFontSize(GEO.pt.chan);
        if (L.channel != null) doc.text(String(L.channel), cx, y0 + hName + hChan * 0.8, { align: 'center' });
        doc.setFont('helvetica', 'normal'); doc.setFontSize(GEO.pt.addr);
        if (addrLine(L)) doc.text(addrLine(L), cx, y0 + hName + hChan + hAddr * 0.78, { align: 'center' });
        if (L.position) doc.text(L.position, cx, y0 + hName + hChan + hAddr + hPos * 0.78, { align: 'center' });
      }
    }
    return doc;
  }

  /* Symbol key lines such as "Ayrton Perseo Profile S 6" -> fixture names shown on the drawing */
  const BRANDS = /^(Robe|Martin|Ayrton|Chauvet|Astera|LEDJ|Prolights|GLP|Cameo|Elation|Clay ?Paky|ETC|Look Solutions|SGM|Showtec|ADJ|Varytec|Claypaky|High End|Vari-?Lite|Acme|Portman|Ambersphere|Rosco|Litecraft|Briteq)\b/i;
  function extractLegend(words) {
    const out = new Map();
    for (const w of words) {
      const s = w.str.replace(/\s+/g, ' ').trim();
      const m = s.match(/^(.*?\S)\s+(\d{1,3})$/);
      const name = m ? m[1] : s;
      if (BRANDS.test(name) && name.length < 60 && !/\d+\/\d+/.test(name)) out.set(name, m ? +m[2] : null);
    }
    return [...out].map(([name, count]) => ({ name, count }));
  }

  const api = { decodeAddress, fixChannelOutliers, lineGroups, repairByConvention, parseCountLine, cleanPixels, addrLine, positionName, positionLabelsFromWords, assignPositions, FIXTURE_LIBRARY, extractTokens, extractLegend, tokensFromOcrWords, unpairedChannels, parseLegendLines, cleanFixtureName, checkRows, dedupeWords, pairTokens, buildRows, sortForLabels, buildDocx, buildPdf, fitNamePt, cellOrigin, GEO, mergeRuns, _TW: TW };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.KudosLabels = api;
})(this);
