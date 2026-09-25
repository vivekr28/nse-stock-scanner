// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES — CSV parsing, symbol normalization, date parsing, formatters
// ═══════════════════════════════════════════════════════════════════════════════

// ── HTML escaping (for values interpolated into innerHTML) ──────────────────────
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── CSV Parsing ──────────────────────────────────────────────────────────────
function parseCSV(text) {
  // Strip UTF-8 BOM if present and normalize line endings
  text = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];

  // Parse a single CSV line respecting quoted fields (handles commas inside quotes)
  function splitCSVLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            current += '"'; i++; // escaped quote
          } else {
            inQuotes = false;
          }
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          fields.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
    }
    fields.push(current.trim());
    return fields;
  }

  const headers = splitCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = splitCSVLine(lines[i]);
    if (vals.length < headers.length - 1) continue;
    const row = {};
    headers.forEach((h, j) => { row[h] = vals[j] || ''; });
    rows.push(row);
  }
  return rows;
}

// ── Symbol Normalization ─────────────────────────────────────────────────────
function normalizeSymbol(s) {
  return (s || '').trim().toLowerCase().replace(/[&\-]/g, '_');
}

// ── Number Parsing ───────────────────────────────────────────────────────────
function parseNum(v) {
  if (v === undefined || v === null || v === '' || v === '-') return NaN;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return n;
}

// ── Column Name Resolution ───────────────────────────────────────────────────
function findCol(obj, candidates) {
  for (const c of candidates) {
    if (obj.hasOwnProperty(c)) return c;
    // Case-insensitive match
    const keys = Object.keys(obj);
    const match = keys.find(k => k.replace(/[\s_]/g, '').toLowerCase() === c.replace(/[\s_]/g, '').toLowerCase());
    if (match) return match;
  }
  return candidates[0]; // fallback
}

// ── Date Parsing ─────────────────────────────────────────────────────────────
function parseDate(s) {
  if (!s) return 0;
  // Try various formats: DD-MMM-YYYY, DD-Mon-YYYY
  const d = new Date(s);
  if (!isNaN(d)) return d.getTime();
  // DDMMYYYY
  if (/^\d{8}$/.test(s)) {
    return new Date(s.slice(4), parseInt(s.slice(2,4))-1, s.slice(0,2)).getTime();
  }
  return 0;
}

// ── Progress Bar ─────────────────────────────────────────────────────────────
function showProgress(label, pct, detail) {
  // Show the loader section so progress bar is visible
  const loader = document.getElementById('loaderSection');
  if (loader) loader.style.display = 'block';
  const wrap = document.getElementById('progressWrap');
  wrap.classList.add('active');
  document.getElementById('progressLabel').textContent = label;
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressDetail').textContent = detail || '';
}

function hideProgress() {
  document.getElementById('progressWrap').classList.remove('active');
  // Hide the loader section once loading is done
  const loader = document.getElementById('loaderSection');
  if (loader) loader.style.display = 'none';
}

// ── Formatters ───────────────────────────────────────────────────────────────
function fmt2(v) { return isNaN(v) ? '-' : Number(v).toFixed(2); }

function fmtPct(v) { return isNaN(v) ? '-' : (v >= 0 ? '+' : '') + Number(v).toFixed(2) + '%'; }

function fmtLakh(v) {
  if (isNaN(v) || v === 0) return '-';
  if (v >= 10000000) return (v / 10000000).toFixed(2) + ' Cr';
  if (v >= 100000) return (v / 100000).toFixed(2) + ' L';
  return Number(v).toLocaleString('en-IN');
}

// Format turnover: input is in lakhs, display in crores (1 Cr = 100 L)
function fmtTurnoverCr(v) {
  if (isNaN(v) || v === 0) return '-';
  const cr = v / 100;
  if (cr >= 1000) return cr.toFixed(0).replace(/\B(?=(\d{2})+(\d)(?!\d))/g, ',') + ' Cr';
  if (cr >= 10) return cr.toFixed(1) + ' Cr';
  if (cr >= 1) return cr.toFixed(2) + ' Cr';
  return cr.toFixed(2) + ' Cr';
}

// Format market cap in crores
function fmtCr(v) {
  if (isNaN(v) || v === 0) return '-';
  if (v >= 100000) return (v / 100000).toFixed(1) + ' L Cr';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'K Cr';
  return v.toFixed(0) + ' Cr';
}

// ── Industry Relative Strength Score ─────────────────────────────────────────
// Shared by industry.js (Industry Analysis tab) and screener.js (F9 filter) so
// the same industry can't silently show a different RS score in the two tabs.
// Composite score (0-100): breadth rank (40%) + avg monthly change rank (30%)
// + proximity-to-52W-high rank (30%), each percentile-ranked within indList.
// Mutates each item in indList in place, adding *_rank and rsScore fields.
// Expects each item to already have: stockCount, breadth, avgMonthlyChange, avgDist52H.
function computeRSScores(indList) {
  if (indList.length === 0) return;
  const rankNorm = (arr, key, higherBetter) => {
    const sorted = [...arr].sort((a, b) => higherBetter ? a[key] - b[key] : b[key] - a[key]);
    const n = sorted.length;
    sorted.forEach((item, i) => { item[`${key}_rank`] = n > 1 ? (i / (n - 1)) * 100 : 50; });
  };
  rankNorm(indList, 'breadth', true);
  rankNorm(indList, 'avgMonthlyChange', true);
  rankNorm(indList, 'avgDist52H', false);
  indList.forEach(ind => {
    ind.rsScore = (ind.breadth_rank || 0) * 0.4 + (ind.avgMonthlyChange_rank || 0) * 0.3 + (ind.avgDist52H_rank || 0) * 0.3;
  });
}
