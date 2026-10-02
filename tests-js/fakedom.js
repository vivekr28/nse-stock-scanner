'use strict';
// A minimal fake page for running js/*.js render functions under Node: document.getElementById returns a
// persistent stand-in element (so the code can set .innerHTML / .textContent / .style and read .value / .checked
// back), pre-seeded from `values`. The tests then read what the code wrote, e.g. dom.el('sectorBody').innerHTML.
//
//   const dom = installFakeDom(sandbox, { sectorSort: 'avg_change', 'indMinStocks': '1' });
//   dom.el('someToggle').checked = true;
function installFakeDom(sandbox, values = {}) {
  const els = {};
  const make = (id) => ({
    id, value: values[id] !== undefined ? values[id] : '', checked: false, innerHTML: '', textContent: '',
    style: {}, dataset: {}, options: [], selectedOptions: [{ textContent: '' }], children: [], className: '',
    classList: { toggle() {}, contains: () => false, add() {}, remove() {} },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, setAttribute() {}, focus() {},
    querySelector: () => null, querySelectorAll: () => [], getContext: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 400 }),
  });
  const el = (id) => els[id] || (els[id] = make(id));
  Object.assign(sandbox.document, {
    getElementById: el,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => make('created'),
  });
  return { el, els };
}

module.exports = { installFakeDom };
