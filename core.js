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

  /* ---------- 3. Merge pages into one row per DMX address, with checks ---------- */
  function buildRows(pagesTokens, library) {
    library = library || FIXTURE_LIBRARY;
    const byKey = new Map();
    const conflicts = [];
    for (const pt of pagesTokens) {
      const { pairs, loneAddrs } = pairTokens(pt.addrs, pt.chans);
      for (const p of pairs) {
        const key = p.addr.universe + '/' + p.addr.address;
        const prev = byKey.get(key);
        if (!prev) byKey.set(key, { universe: p.addr.universe, address: p.addr.address, channel: p.chan.channel, pages: [p.addr.page] });
        else {
          if (!prev.pages.includes(p.addr.page)) prev.pages.push(p.addr.page);
          if (prev.channel == null) prev.channel = p.chan.channel;
          else if (prev.channel !== p.chan.channel) conflicts.push({ key, channels: [prev.channel, p.chan.channel], page: p.addr.page });
        }
      }
      for (const a of loneAddrs) {
        const key = a.universe + '/' + a.address;
        if (!byKey.has(key)) byKey.set(key, { universe: a.universe, address: a.address, channel: null, pages: [a.page] });
      }
    }
    const rows = [...byKey.values()].sort((p, q) => p.universe - q.universe || p.address - q.address);

    // footprint = gap to next address in same universe
    rows.forEach((r, i) => {
      const n = rows[i + 1];
      r.footprint = (n && n.universe === r.universe) ? n.address - r.address : null;
    });
    // last fixture in a universe: assume same footprint as the one before if it was the same gap pattern
    rows.forEach((r, i) => {
      if (r.footprint == null) {
        const p = rows[i - 1];
        r.footprintGuess = (p && p.universe === r.universe) ? p.footprint : null;
      }
    });
    // suggest fixture from footprint (only if exactly one library match)
    rows.forEach(r => {
      const fp = r.footprint != null ? r.footprint : r.footprintGuess;
      const hits = library.filter(f => f.footprint === fp);
      r.suggestions = hits;
      r.fixture = hits.length === 1 ? hits[0].name + ' (' + hits[0].mode + ')' : '';
    });

    // checks
    const issues = [];
    conflicts.forEach(c => issues.push({ type: 'conflict', msg: `${c.key} has channel ${c.channels[0]} on one page and ${c.channels[1]} on page ${c.page}` }));
    rows.filter(r => r.channel == null).forEach(r => issues.push({ type: 'missing', msg: `${r.universe}.${r.address} has no channel number next to it` }));
    const seen = new Map();
    rows.forEach(r => { if (r.channel != null) { const k = r.channel; seen.set(k, (seen.get(k) || []).concat(r.universe + '.' + r.address)); } });
    for (const [ch, list] of seen) if (list.length > 1) issues.push({ type: 'duplicate', msg: `Channel ${ch} is on ${list.join(' and ')}` });
    // gaps inside a run of channels (e.g. 501,502,504)
    const chs = [...seen.keys()].sort((a, b) => a - b);
    for (let i = 1; i < chs.length; i++) {
      const g = chs[i] - chs[i - 1];
      if (g > 1 && g < 5 && Math.floor(chs[i] / 100) === Math.floor(chs[i - 1] / 100)) {
        const missing = []; for (let c = chs[i - 1] + 1; c < chs[i]; c++) missing.push(c);
        issues.push({ type: 'gap', msg: `Channel ${missing.join(', ')} not found between ${chs[i - 1]} and ${chs[i]}` });
      }
    }
    return { rows, issues };
  }

  function sortForLabels(rows) {
    return rows.slice().sort((a, b) => (a.channel ?? 1e9) - (b.channel ?? 1e9) || a.universe - b.universe || a.address - b.address);
  }

  /* ---------- 4. Word document on the Avery 16-per-sheet layout ----------
     A4, 8 rows × 3 columns (column 2 is a 3 mm gutter), cells 9.906 × 3.387 cm,
     paragraph style "Avery Style 1", cells vertically centred. One table per sheet,
     separated by a 1 pt page-break paragraph so sheets don't drift. */
  const TW = { cellW: 5616, gutter: 170, rowH: 1920, pageW: 11906, pageH: 16838 };
  TW.marginX = Math.round((TW.pageW - (TW.cellW * 2 + TW.gutter)) / 2);   // ≈ 4.4 mm
  TW.marginTop = Math.round((TW.pageH - TW.rowH * 8) / 2);                // ≈ 13 mm

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function para(text, halfPts, bold) {
    if (text === '' || text == null) return `<w:p><w:pPr><w:pStyle w:val="AveryStyle1"/></w:pPr></w:p>`;
    return `<w:p><w:pPr><w:pStyle w:val="AveryStyle1"/></w:pPr><w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="${halfPts}"/><w:szCs w:val="${halfPts}"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
  }

  function labelCell(lbl, border) {
    const b = border === 'none' ? '' :
      `<w:tcBorders>${['top', 'left', 'bottom', 'right'].map(s => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="${border === 'black' ? '000000' : 'C8C8C8'}"/>`).join('')}</w:tcBorders>`;
    const body = lbl
      ? para(lbl.fixture || '', 28, false) + para(lbl.channel != null ? String(lbl.channel) : '', 56, true) + para(lbl.universe + '.' + lbl.address, 28, false)
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

  const api = { FIXTURE_LIBRARY, extractTokens, extractLegend, pairTokens, buildRows, sortForLabels, buildDocx, mergeRuns, _TW: TW };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.KudosLabels = api;
})(this);
