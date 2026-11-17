// Checklist tab (panel-checklist): the trader's own qualification rules, shown as a read-only reference.
// To refine the checklist, edit CHECKLIST_RULES below (title / detail text, add, remove or reorder items) and
// CHECKLIST_VERDICT for the footer line - the page redraws itself from this data, no other file needs to change.
// `details` is a list of short lines so a rule can grow into several points as it is refined.

const CHECKLIST_TITLE = 'Every Stock Must Clear These To Qualify';

const CHECKLIST_RULES = [
  {
    title: 'Deep Dive Template Fit',
    details: [
      'Cause → Consolidation → Effect. LF jump of 50–600% in the cause phase. Correction under ~25% from high. Consolidation ideally 15–30 days.'
    ]
  },
  {
    title: 'Consolidation Quality',
    details: [
      'No large red/purple dot days in the correction. Exception: over 10 days old, or that day’s high already taken out.'
    ]
  },
  {
    title: 'Liquidity',
    details: [
      'Minimum ₹25 crore daily traded value. Skip any 5% circuit stock outright.'
    ]
  },
  {
    title: 'Not Extended',
    details: [
      'Day 1, max Day 2. Up 3–4 days running = skip. +15–50%: 10MA undercut. +50–100%: 20MA. +100%+: avoid.'
    ]
  },
  {
    title: 'Six-Month High & Overhead Supply',
    details: [
      'View only the last 6 months. Must be near/at its 6-month high. Large red days = overhead supply → skip.'
    ]
  },
  {
    title: 'Relative Strength & Sector Confirmation',
    details: [
      'Outperforming the market, especially when Nifty is weak. 60%+ of sector rising together with volume.'
    ]
  },
  {
    title: 'Earnings Risk',
    details: [
      'No earnings announcement due in the next 5 days. Skip if results are imminent.'
    ]
  }
];

const CHECKLIST_VERDICT = 'Fail any one, and the stock doesn’t make the watchlist. No exceptions on quality.';

function checklistRender() {
  const root = document.getElementById('checklistRoot');
  if (!root) return;
  root.textContent = '';

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  root.appendChild(el('h3', 'cl-title', CHECKLIST_TITLE));

  const grid = el('div', 'cl-grid');
  // Two columns, filled top-to-bottom: the first half of the rules on the left, the rest on the right.
  const perCol = Math.ceil(CHECKLIST_RULES.length / 2);
  const cols = [el('div', 'cl-col'), el('div', 'cl-col')];
  CHECKLIST_RULES.forEach((rule, i) => {
    const item = el('div', 'cl-item');
    item.appendChild(el('span', 'cl-box'));
    const body = el('div', 'cl-body');
    body.appendChild(el('div', 'cl-rule-title', (i + 1) + ' · ' + rule.title));
    (rule.details || []).forEach(d => body.appendChild(el('div', 'cl-rule-detail', d)));
    item.appendChild(body);
    cols[i < perCol ? 0 : 1].appendChild(item);
  });
  if (CHECKLIST_VERDICT) cols[1].appendChild(el('div', 'cl-verdict', CHECKLIST_VERDICT));
  cols.forEach(c => grid.appendChild(c));
  root.appendChild(grid);
}

checklistRender();
