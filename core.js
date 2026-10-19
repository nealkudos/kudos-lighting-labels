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
  const VALID_TOKEN = /^(\d{1,2}\/\d{1,3}|\d{3,4})$/;
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
    const addrs = [], chans = [];
    for (const w of dedupeWords(words.filter(w => w.conf >= (w.refined ? 35 : minConf)))) {
      if (w.conf < 50 && (w.votes || 1) < 2) continue;            // a weak read only counts if another read agrees
      const t = w.text.trim();
      const cx = (w.x0 + w.x1) / 2, cy = (w.y0 + w.y1) / 2;
      const size = Math.min(w.x1 - w.x0, w.y1 - w.y0) / 0.72;
      const m = t.match(ADDR_RE);
      if (m) {
        const u = +m[1], a = +m[2];
        if (u && a && a <= 512) addrs.push({ universe: u, address: a, x: cx, y: cy, size, page, ocr: true, box: w });
      } else if (CHAN_RE.test(t)) chans.push({ channel: +t, x: cx, y: cy, size, page, ocr: true, box: w });
    }
    return { addrs, chans, other: [], words: [], ocr: true };
  }
  /* Channels that found no address after the first pass: where to look again, closer up. */
  function unpairedChannels(tokens) {
    const { pairs } = pairTokens(tokens.addrs, tokens.chans);
    const used = new Set(pairs.map(p => p.chan));
    return tokens.chans.filter(c => !used.has(c));
  }

  /* ---------- 2c. Symbol key with channel counts ----------
     lines: [{text, x, y}] top to bottom. Finds "x8 (37 channel/Mode 1)" style lines and the fixture name above. */
  const COUNT_RE = /(?:x\s*(\d{1,3})\s*)?\(\s*(\d{1,3})\s*ch(?:annel)?s?\b[^)]*?(?:[\/,;-]\s*(mode\s*[\w.\- ]+?))?\s*\)?\s*$/i;
  function cleanFixtureName(s) {
    return s.replace(/@/g, ' ').replace(/\.gdtf\b/ig, '').replace(/\s+/g, ' ').trim();
  }
  function parseLegendLines(lines) {
    const out = [];
    const sorted = lines.filter(l => l.text && l.text.trim()).slice().sort((a, b) => a.y - b.y || a.x - b.x);
    let lastCountIdx = -1;
    sorted.forEach((l, i) => {
      const m = l.text.trim().match(COUNT_RE);
      if (!m) return;
      const before = l.text.trim().slice(0, m.index).trim();       // name may be on the same line
      const nameParts = [];
      const lh = l.h || 12;
      for (let j = i - 1; j >= 0 && nameParts.length < 2; j--) {
        const p = sorted[j];
        if (Math.abs(p.y - l.y) > lh * 4.5) break;                 // too far above
        if (Math.abs(p.x - l.x) > lh * 8) continue;                 // another part of the drawing at the same height
        if (/symbol\s*key|^key$/i.test(p.text.trim())) break;
        if (COUNT_RE.test(p.text.trim())) break;                     // the entry above
        nameParts.unshift(p.text.trim());
      }
      if (before) nameParts.push(before);
      lastCountIdx = i;
      const name = cleanFixtureName(nameParts.join(' '));
      if (!name || !/[a-z]{3}/i.test(name)) return;
      const fp = +m[2];
      const mode = m[3] ? m[3].trim().replace(/^mode\s*/i, 'Mode ') : fp + ' Ch';
      out.push({ name, mode, footprint: fp, qty: m[1] ? +m[1] : null, fromDrawing: true });
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
      rows.forEach(r => (r.at || []).forEach(a => { if (a.page === page) pts.push({ r, x: a.x, y: a.y, em: a.size || 8 }); }));
      if (!pts.length) continue;
      const parent = pts.map((_, i) => i);
      const find = (i) => parent[i] === i ? i : (parent[i] = find(parent[i]));
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i], b = pts[j], em = Math.max(a.em, b.em);
        const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
        if ((dy < 1.5 * em && dx < 14 * em) || (dx < 1.5 * em && dy < 14 * em)) parent[find(i)] = find(j);
      }
      const groups = new Map();
      pts.forEach((p, i) => { const k = find(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); });
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
      pt.chans.forEach(c => { if (!pairedChans.has(c)) loneChans.push({ channel: c.channel, page: c.page, ocr: !!pt.ocr }); });
    }
    const rows = [...byKey.values()].sort((p, q) => p.universe - q.universe || p.address - q.address);

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
        orphanRows.push({ universe: null, address: null, channel: c.channel, pages: [c.page], ocr: c.ocr, fixture: '', suggestions: [] });
      }
    }

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
    rows.filter(r => r.universe == null).forEach(r => issues.push({ type: 'missing', msg: `Channel ${r.channel} has no readable address next to it. Add it in the table.` }));
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

  const api = { addrLine, positionName, positionLabelsFromWords, assignPositions, FIXTURE_LIBRARY, extractTokens, extractLegend, tokensFromOcrWords, unpairedChannels, parseLegendLines, cleanFixtureName, checkRows, dedupeWords, pairTokens, buildRows, sortForLabels, buildDocx, buildPdf, fitNamePt, cellOrigin, GEO, mergeRuns, _TW: TW };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.KudosLabels = api;
})(this);
