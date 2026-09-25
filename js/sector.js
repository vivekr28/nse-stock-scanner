// ═══════════════════════════════════════════════════════════════════════════════
// SECTOR — sector-level analysis table and heatmap
// ═══════════════════════════════════════════════════════════════════════════════

function renderSectorAnalysis() {
  const sortBy = document.getElementById('sectorSort').value;
  const sectors = {};

  for (const key in Store.latestBySymbol) {
    const s = Store.latestBySymbol[key];
    const sec = s.sector || 'Unknown';
    if (!sectors[sec]) sectors[sec] = { stocks: [], totalTurnover: 0, totalChange: 0, above: 0, below: 0 };
    sectors[sec].stocks.push(s);
    sectors[sec].totalTurnover += (s.turnover || 0);
    sectors[sec].totalChange += (s.changePct || 0);
    if (s.aboveSMA) sectors[sec].above++;
    else sectors[sec].below++;
  }

  // Build sector summary
  const sectorList = Object.entries(sectors).map(([name, data]) => ({
    name,
    stockCount: data.stocks.length,
    avgChange: data.totalChange / data.stocks.length,
    totalTurnover: data.totalTurnover,
    breadth: data.stocks.length > 0 ? (data.above / data.stocks.length * 100) : 0,
    above: data.above,
    below: data.below,
    topGainer: data.stocks.sort((a, b) => b.changePct - a.changePct)[0],
    topLoser: data.stocks.sort((a, b) => a.changePct - b.changePct)[0],
  }));

  // Sort
  switch (sortBy) {
    case 'avg_change': sectorList.sort((a, b) => b.avgChange - a.avgChange); break;
    case 'breadth': sectorList.sort((a, b) => b.breadth - a.breadth); break;
    case 'turnover': sectorList.sort((a, b) => b.totalTurnover - a.totalTurnover); break;
    case 'stocks': sectorList.sort((a, b) => b.stockCount - a.stockCount); break;
  }

  // Sector table
  const head = document.getElementById('sectorHead');
  head.innerHTML = '<th>Sector</th><th>Stocks</th><th>Avg Chg%</th><th>Breadth (Above SMA)</th><th>Turnover (Cr)</th><th>Top Gainer</th><th>Top Loser</th>';

  const body = document.getElementById('sectorBody');
  body.innerHTML = sectorList.map(s => `
    <tr>
      <td style="font-weight:600">${s.name}</td>
      <td>${s.stockCount}</td>
      <td class="${s.avgChange>=0?'positive':'negative'}">${s.avgChange.toFixed(2)}%</td>
      <td>
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="flex:1;height:8px;background:var(--red);border-radius:4px;overflow:hidden;">
            <div style="width:${s.breadth}%;height:100%;background:var(--green);"></div>
          </div>
          <span style="font-size:11px;min-width:35px;">${s.breadth.toFixed(0)}%</span>
        </div>
      </td>
      <td>${fmtTurnoverCr(s.totalTurnover)}</td>
      <td class="positive">${s.topGainer ? s.topGainer.symbol + ' (' + fmtPct(s.topGainer.changePct) + ')' : '-'}</td>
      <td class="negative">${s.topLoser ? s.topLoser.symbol + ' (' + fmtPct(s.topLoser.changePct) + ')' : '-'}</td>
    </tr>
  `).join('');

  // Sector heatmap cards
  const grid = document.getElementById('sectorGrid');
  grid.innerHTML = sectorList.slice(0, 20).map(s => {
    const hue = s.avgChange >= 0 ? 142 : 0;
    const sat = Math.min(Math.abs(s.avgChange) * 20, 80);
    const bg = `hsla(${hue}, ${sat}%, 40%, 0.15)`;
    const border = `hsla(${hue}, ${sat}%, 50%, 0.3)`;
    return `
      <div class="sector-card" style="background:${bg};border-color:${border};">
        <h4>
          <span>${s.name}</span>
          <span class="${s.avgChange>=0?'positive':'negative'}">${s.avgChange.toFixed(2)}%</span>
        </h4>
        <table class="mini-table">
          <tr><td style="color:var(--text2)">Stocks</td><td style="text-align:right">${s.stockCount}</td></tr>
          <tr><td style="color:var(--text2)">Above SMA</td><td style="text-align:right;color:var(--green)">${s.above}</td></tr>
          <tr><td style="color:var(--text2)">Below SMA</td><td style="text-align:right;color:var(--red)">${s.below}</td></tr>
          <tr><td style="color:var(--text2)">Turnover</td><td style="text-align:right">${fmtTurnoverCr(s.totalTurnover)}</td></tr>
        </table>
      </div>
    `;
  }).join('');
}
