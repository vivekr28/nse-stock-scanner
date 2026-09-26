// ═══════════════════════════════════════════════════════════════════════════════
// DATA STORE — Central state for all dashboard data
// ═══════════════════════════════════════════════════════════════════════════════
const Store = {
  bhavData: [],         // all rows from bhavcopy
  bandData: [],         // all rows from price band
  sectorMap: {},        // symbol -> {sector, industry, ...}
  dates: [],            // sorted unique dates
  latestDate: null,
  symbols: [],          // unique symbols
  // Computed
  dailyBySymbol: {},    // ISIN -> [{date, open, high, low, close, isin, companyName, ...}]
  latestBySymbol: {},   // ISIN -> latest day row with computed fields
  sma20: {},            // symbol -> 20 SMA value
  high52w: {},          // symbol -> 52w high
  low52w: {},           // symbol -> 52w low
  adr: {},              // symbol -> average daily range %
  bandBySymbol: {},     // ISIN -> {upper, lower, bandPct}
  symbolToISIN: {},     // normalizedSymbol -> ISIN
  ewIndex: null,        // {cols, bars: [[date,open,high,low,close,turnover,count],...], constituentCount} or null
  unadjustedCorpActions: [], // [{isin, symbol, exDate, subject, close}] - recognized corp actions (demergers, etc.) NOT price-adjusted; see Data Quality tab
  adjustedCorpActions: [],   // [{isin, symbol, exDate, kind: 'split-bonus'|'demerger', detail, factor}] - every price adjustment applied (factor = what pre-ex-date prices were multiplied by); see Data Quality tab
  loaded: { bhav: false, band: false, sector: false },
  dashboardVisible: false
};
