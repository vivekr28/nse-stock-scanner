// ═══════════════════════════════════════════════════════════════════════════════
// DATA PROCESSOR — process raw CSV data into computed indicators
// ═══════════════════════════════════════════════════════════════════════════════

function processData() {
  const data = Store.bhavData;

  // Figure out column names (NSE changes them sometimes)
  const sample = data[0] || {};
  const colSymbol = findCol(sample, ['SYMBOL', 'Symbol', 'TckrSymb']);
  const colSeries = findCol(sample, ['SERIES', 'Series', 'SctySrs']);
  const colDate   = findCol(sample, ['DATE1', 'Date', 'DATE', 'TradDt']);
  const colOpen   = findCol(sample, ['OPEN_PRICE', 'OPEN', 'Open', 'OpnPric']);
  const colHigh   = findCol(sample, ['HIGH_PRICE', 'HIGH', 'High', 'HghPric']);
  const colLow    = findCol(sample, ['LOW_PRICE', 'LOW', 'Low', 'LwPric']);
  const colClose  = findCol(sample, ['CLOSE_PRICE', 'CLOSE', 'Close', 'ClsPric']);
  const colLast   = findCol(sample, ['LAST_PRICE', 'LAST', 'Last', 'LastPric']);
  const colPrev   = findCol(sample, ['PREV_CLOSE', 'PREVCLOSE', 'PrevClose', 'PrvsClsgPric']);
  const colVol    = findCol(sample, ['TTL_TRD_QNTY', 'VOLUME', 'Volume', 'TtlTradgVol']);
  const colTurnover = findCol(sample, ['TURNOVER_LACS', 'TURNOVER', 'Turnover', 'TtlTrfVal']);
  const colTrades = findCol(sample, ['NO_OF_TRADES', 'TRADES', 'NoOfTrades', 'TtlNbOfTxsExctd']);
  const colDeliv  = findCol(sample, ['DELIV_QTY', 'DELIVQTY', 'DelivQty']);
  const colDelivPer = findCol(sample, ['DELIV_PER', 'DELIVPER', 'DelivPer']);
  const colISIN = findCol(sample, ['ISIN', 'Isin']);
  const colCompanyName = findCol(sample, ['COMPANY_NAME', 'CompanyName', 'FinInstrmNm']);

  // Group by ISIN
  Store.dailyBySymbol = {};
  Store.symbolToISIN = {};
  const dateSet = new Set();

  for (const row of data) {
    const sym = (row[colSymbol] || '').trim();
    const series = (row[colSeries] || '').trim();
    if (!sym || (series !== 'EQ' && series !== 'BE')) continue; // Only EQ and BE series

    const dateStr = (row[colDate] || '').trim();
    const open = parseNum(row[colOpen]);
    const high = parseNum(row[colHigh]);
    const low = parseNum(row[colLow]);
    const close = parseNum(row[colClose]);
    const last = parseNum(row[colLast]);
    const prev = parseNum(row[colPrev]);
    const vol = parseNum(row[colVol]);
    const turnover = parseNum(row[colTurnover]);
    const trades = parseNum(row[colTrades]);
    const delivQty = parseNum(row[colDeliv]);
    const delivPer = parseNum(row[colDelivPer]);
    const isin = (row[colISIN] || '').trim();
    const companyName = (row[colCompanyName] || '').trim();

    if (isNaN(close) || close <= 0) continue;

    dateSet.add(dateStr);

    const isinKey = isin;
    Store.symbolToISIN[normalizeSymbol(sym)] = isinKey;
    if (!Store.dailyBySymbol[isinKey]) Store.dailyBySymbol[isinKey] = [];
    Store.dailyBySymbol[isinKey].push({
      symbol: sym, series, date: dateStr,
      open, high, low, close, last, prev,
      vol, turnover, trades, delivQty, delivPer,
      isin, companyName
    });
  }

  // Sort dates
  Store.dates = Array.from(dateSet).sort((a, b) => parseDate(a) - parseDate(b));
  Store.latestDate = Store.dates[Store.dates.length - 1];

  // Sort each symbol's data by date
  for (const key in Store.dailyBySymbol) {
    Store.dailyBySymbol[key].sort((a, b) => parseDate(a.date) - parseDate(b.date));
  }

  // Compute indicators for each symbol
  Store.latestBySymbol = {};
  Store.staleStocks = [];
  for (const key in Store.dailyBySymbol) {
    const days = Store.dailyBySymbol[key];
    const latest = days[days.length - 1];
    if (latest.date !== Store.latestDate) {
      // Track stocks that have data but didn't trade on the latest day
      if (!Store.staleStocks) Store.staleStocks = [];
      Store.staleStocks.push({ symbol: latest.symbol, series: latest.series, lastTradeDate: latest.date, close: latest.close, tradingDays: days.length });
      continue;
    }

    // 20 SMA
    const closes = days.map(d => d.close);
    const sma20 = closes.length >= 20
      ? closes.slice(-20).reduce((s, v) => s + v, 0) / 20
      : NaN;

    // 52W high/low (approx 250 trading days)
    const lookback = Math.min(days.length, 250);
    const recentDays = days.slice(-lookback);
    const high52w = Math.max(...recentDays.map(d => d.high));
    const low52w = Math.min(...recentDays.map(d => d.low));

    // ADR % (average of (high-low)/close over last 20 days)
    const adrDays = days.slice(-20);
    const adr = adrDays.length > 0
      ? adrDays.reduce((s, d) => s + ((d.high - d.low) / d.close * 100), 0) / adrDays.length
      : 0;

    // Change %
    const changePct = latest.prev > 0 ? ((latest.close - latest.prev) / latest.prev * 100) : 0;

    // Distance from 52W high/low
    const distFrom52H = high52w > 0 ? ((high52w - latest.close) / high52w * 100) : 0;
    const distFrom52L = low52w > 0 ? ((latest.close - low52w) / low52w * 100) : 0;

    // Distance from 20 SMA
    const distFromSMA = !isNaN(sma20) && sma20 > 0 ? ((latest.close - sma20) / sma20 * 100) : NaN;

    // Sector info
    const sInfo = Store.sectorMap[normalizeSymbol(latest.symbol)] || { sector: '-', industry: '-', marketCap: 0 };

    // Monthly change % (22 trading sessions); if fewer days available, use change since listing
    const monthRef = days.length >= 22 ? days[days.length - 22] : days[0];
    const monthlyChangePct = monthRef.close > 0
      ? ((latest.close - monthRef.close) / monthRef.close * 100) : 0;

    Store.latestBySymbol[key] = {
      ...latest,
      isin: latest.isin, companyName: latest.companyName,
      sma20, high52w, low52w, adr, changePct, monthlyChangePct,
      distFrom52H, distFrom52L, distFromSMA,
      sector: (sInfo.sector && sInfo.sector !== '-') ? sInfo.sector : 'Undefined-Diversified',
      industry: (sInfo.industry && sInfo.industry !== '-') ? sInfo.industry : 'Undefined-Diversified',
      marketCap: sInfo.marketCap || 0,
      aboveSMA: !isNaN(sma20) && latest.close > sma20,
      tradingDays: days.length
    };
  }

  // Process price band data
  if (Store.loaded.band && Store.bandData.length > 0) {
    processBandData();
  }

  // Populate UI
  populateFilters();
  showDashboard();
}

function processBandData() {
  const bd = Store.bandData;
  const sample = bd[0] || {};

  // Try to identify columns
  const colSym = findCol(sample, ['Symbol', 'SYMBOL', 'symbol']);
  const colSeries = findCol(sample, ['Series', 'SERIES', 'series']);
  const colUpper = findCol(sample, ['Upper_Band', 'UPPER_BAND', 'High Price Band', 'HighPriceBand', 'Upper Band']);
  const colLower = findCol(sample, ['Lower_Band', 'LOWER_BAND', 'Low Price Band', 'LowPriceBand', 'Lower Band']);
  const colBandPct = findCol(sample, ['Price Band', 'PRICE_BAND', 'PriceBand', 'Band', 'Applicable Price Band']);
  const colDate = findCol(sample, ['Date', 'DATE', 'DATE1']);

  // Get latest date's band data
  let latestBandDate = null;
  if (colDate) {
    const bandDates = [...new Set(bd.map(r => r[colDate]).filter(Boolean))].sort();
    latestBandDate = bandDates[bandDates.length - 1];
  }

  for (const row of bd) {
    if (latestBandDate && colDate && row[colDate] !== latestBandDate) continue;

    const sym = (row[colSym] || '').trim();
    const series = (row[colSeries] || '').trim();
    if (!sym || (series !== 'EQ' && series !== 'BE')) continue; // Only EQ and BE series
    const isinKey = Store.symbolToISIN[normalizeSymbol(sym)];
    if (!isinKey) continue; // skip if symbol not in bhavcopy

    const upper = parseNum(row[colUpper]);
    const lower = parseNum(row[colLower]);
    const bandPct = (row[colBandPct] || '').trim();

    Store.bandBySymbol[isinKey] = { upper, lower, bandPct };

    // Merge into latestBySymbol
    if (Store.latestBySymbol[isinKey]) {
      Store.latestBySymbol[isinKey].upperBand = upper;
      Store.latestBySymbol[isinKey].lowerBand = lower;
      Store.latestBySymbol[isinKey].bandPct = bandPct;
      // Did it hit circuit?
      const close = Store.latestBySymbol[isinKey].close;
      const high = Store.latestBySymbol[isinKey].high;
      const low = Store.latestBySymbol[isinKey].low;
      Store.latestBySymbol[isinKey].hitUC = !isNaN(upper) && upper > 0 && high >= upper * 0.999;
      Store.latestBySymbol[isinKey].hitLC = !isNaN(lower) && lower > 0 && low <= lower * 1.001;
    }
  }
}
