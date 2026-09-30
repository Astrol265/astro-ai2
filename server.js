/**
 * ASTRO SIGNALS — SINGLE FILE VERSION
 * -----------------------------------
 * Render:
 *   Build command: (leave empty)
 *   Start command: node server.js
 *
 * Environment variables:
 *   GEMINI_API_KEY = your Google Gemini API key
 *   GEMINI_MODEL   = gemini-3.5-flash-lite   (optional)
 *   PORT           = supplied automatically by Render
 *
 * IMPORTANT:
 * - This version does NOT claim a signal is guaranteed.
 * - During the 3-minute analysis window the server continuously collects
 *   fresh 1-minute market snapshots.
 * - One Gemini request is used at the end of the 3-minute analysis window.
 *   This keeps the design suitable for a small daily Gemini quota.
 * - If no asset passes the confidence/technical filters, the app returns
 *   NO TRADE instead of forcing a signal.
 * - The completed-signal evaluator is null-safe and never reads
 *   currentSignal.time after currentSignal has been cleared.
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 10000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

// User requested UTC-4 for the displayed application time.
const DISPLAY_UTC_OFFSET_MINUTES = -4 * 60;

// 3-minute pre-signal analysis period.
const ANALYSIS_MS = 3 * 60 * 1000;

// During analysis, take a snapshot every 20 seconds.
// This gives 9 snapshots over the 3-minute period.
const SNAPSHOT_MS = 20 * 1000;

// Signal expiry/evaluation period: 5 minutes.
const SIGNAL_DURATION_MS = 5 * 60 * 1000;

// Candidate crypto markets. Binance supplies live public market data.
// They are quoted in USDT, which is displayed as USD-equivalent.
const WATCHLIST = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "AVAXUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "LINKUSDT",
  "LTCUSDT"
];

const state = {
  phase: "idle",
  analysisStartedAt: null,
  analysisEndsAt: null,
  snapshots: [],
  latestScan: null,
  currentSignal: null,
  history: [],
  lastAi: null,
  errors: [],
  lastTickAt: null
};

// ---------- Basic helpers ----------

function now() {
  return Date.now();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function round(n, digits = 4) {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function symbolLabel(symbol) {
  return symbol.endsWith("USDT")
    ? symbol.slice(0, -4) + "/USD"
    : symbol;
}

function displayTime(ts = now()) {
  const d = new Date(ts + DISPLAY_UTC_OFFSET_MINUTES * 60 * 1000);
  return d.toISOString().slice(0, 19).replace("T", " ") + " UTC-4";
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}

function html(res, body) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function safeJsonParse(text) {
  if (!text) return null;

  let cleaned = String(text).trim();

  // Remove markdown fences if Gemini returns them.
  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (_) {}

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(cleaned.slice(first, last + 1));
    } catch (_) {}
  }

  return null;
}

// ---------- HTTP fetch helper using Node built-ins ----------

function fetchText(url, options = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : require("http");

    const req = lib.request(
      u,
      {
        method: options.method || "GET",
        headers: options.headers || {},
      },
      res => {
        let data = "";

        res.setEncoding("utf8");
        res.on("data", chunk => {
          data += chunk;
        });

        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
          }
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("Request timed out"));
    });

    req.on("error", reject);
    req.end(options.body || undefined);
  });
}

async function getJSON(url, options = {}, timeoutMs = 15000) {
  const text = await fetchText(url, options, timeoutMs);
  return JSON.parse(text);
}

// ---------- Technical analysis ----------

function closes(candles) {
  return candles.map(c => Number(c[4]));
}

function highs(candles) {
  return candles.map(c => Number(c[2]));
}

function lows(candles) {
  return candles.map(c => Number(c[3]));
}

function volumes(candles) {
  return candles.map(c => Number(c[5]));
}

function sma(values, period) {
  if (values.length < period) return null;
  const a = values.slice(-period);
  return a.reduce((x, y) => x + y, 0) / period;
}

function ema(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }

  return e;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = Math.max(0, diff);
    const loss = Math.max(0, -diff);

    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function macd(values) {
  const e12 = ema(values, 12);
  const e26 = ema(values, 26);

  if (e12 == null || e26 == null) {
    return { line: null, signal: null, histogram: null };
  }

  const macdSeries = [];
  const start = Math.max(26, 12);

  // Rebuild a MACD series over the available closes.
  for (let i = start - 1; i < values.length; i++) {
    const slice = values.slice(0, i + 1);
    const a = ema(slice, 12);
    const b = ema(slice, 26);
    if (a != null && b != null) macdSeries.push(a - b);
  }

  const line = macdSeries[macdSeries.length - 1] ?? null;
  const signal = macdSeries.length >= 9
    ? ema(macdSeries, 9)
    : null;

  return {
    line,
    signal,
    histogram:
      line != null && signal != null
        ? line - signal
        : null
  };
}

function atr(candles, period = 14) {
  if (candles.length <= period) return null;

  const tr = [];

  for (let i = 1; i < candles.length; i++) {
    const high = Number(candles[i][2]);
    const low = Number(candles[i][3]);
    const previousClose = Number(candles[i - 1][4]);

    tr.push(
      Math.max(
        high - low,
        Math.abs(high - previousClose),
        Math.abs(low - previousClose)
      )
    );
  }

  return sma(tr, period);
}

function priceChange(values, bars) {
  if (values.length <= bars) return 0;
  const a = values[values.length - 1];
  const b = values[values.length - 1 - bars];
  return b ? ((a - b) / b) * 100 : 0;
}

function buildIndicators(candles, ticker = {}) {
  const c = closes(candles);
  const h = highs(candles);
  const l = lows(candles);
  const v = volumes(candles);

  const last = c[c.length - 1];

  const e9 = ema(c, 9);
  const e21 = ema(c, 21);
  const e50 = ema(c, 50);
  const s20 = sma(c, 20);
  const r = rsi(c, 14);
  const m = macd(c);
  const a = atr(c, 14);

  const avgVol = sma(v, 20);
  const currentVol = v[v.length - 1];

  const volumeRatio =
    avgVol && avgVol > 0 ? currentVol / avgVol : 1;

  const trendPoints = [];

  if (e9 != null && e21 != null)
    trendPoints.push(e9 > e21 ? 1 : -1);

  if (e21 != null && e50 != null)
    trendPoints.push(e21 > e50 ? 1 : -1);

  if (last != null && e50 != null)
    trendPoints.push(last > e50 ? 1 : -1);

  if (m.histogram != null)
    trendPoints.push(m.histogram > 0 ? 1 : -1);

  if (r != null) {
    if (r > 52 && r < 70) trendPoints.push(1);
    else if (r < 48 && r > 30) trendPoints.push(-1);
  }

  const trendScore =
    trendPoints.length
      ? trendPoints.reduce((a, b) => a + b, 0) / trendPoints.length
      : 0;

  let technicalDirection = trendScore >= 0 ? "UP" : "DOWN";

  // Momentum contribution.
  const momentum1m = priceChange(c, 1);
  const momentum5m = priceChange(c, 5);
  const momentum15m = priceChange(c, 15);

  const momentumScore =
    clamp(momentum1m / 0.15, -1, 1) * 0.25 +
    clamp(momentum5m / 0.50, -1, 1) * 0.40 +
    clamp(momentum15m / 1.20, -1, 1) * 0.35;

  // Avoid buying an already extremely overbought move or shorting an
  // extremely oversold move without confirmation.
  let rsiQuality = 0;
  if (r != null) {
    if (r >= 52 && r <= 68) rsiQuality = 1;
    else if (r >= 32 && r <= 48) rsiQuality = -1;
    else if (r > 75) rsiQuality = -0.4;
    else if (r < 25) rsiQuality = 0.4;
  }

  const combined =
    trendScore * 0.55 +
    momentumScore * 0.30 +
    rsiQuality * 0.15;

  const technicalConfidence =
    clamp(50 + Math.abs(combined) * 45, 50, 95);

  if (combined > 0.08) technicalDirection = "UP";
  else if (combined < -0.08) technicalDirection = "DOWN";
  else technicalDirection = "WAIT";

  return {
    price: last,
    ema9: e9,
    ema21: e21,
    ema50: e50,
    sma20: s20,
    rsi14: r,
    macdLine: m.line,
    macdSignal: m.signal,
    macdHistogram: m.histogram,
    atr14: a,
    volumeRatio,
    change1m: momentum1m,
    change5m: momentum5m,
    change15m: momentum15m,
    trendScore,
    momentumScore,
    combinedScore: combined,
    direction: technicalDirection,
    confidence: round(technicalConfidence, 1),
    bid: ticker.bidPrice ? Number(ticker.bidPrice) : null,
    ask: ticker.askPrice ? Number(ticker.askPrice) : null,
    quoteVolume24h: ticker.quoteVolume ? Number(ticker.quoteVolume) : null,
    high24h: ticker.highPrice ? Number(ticker.highPrice) : null,
    low24h: ticker.lowPrice ? Number(ticker.lowPrice) : null
  };
}

async function getMarket(symbol) {
  const base = "https://api.binance.com/api/v3";

  const [candles, ticker] = await Promise.all([
    getJSON(`${base}/klines?symbol=${symbol}&interval=1m&limit=120`),
    getJSON(`${base}/ticker/24hr?symbol=${symbol}`)
  ]);

  const indicators = buildIndicators(candles, ticker);

  return {
    symbol,
    label: symbolLabel(symbol),
    fetchedAt: now(),
    indicators
  };
}

async function scanAllMarkets() {
  const results = [];

  for (const symbol of WATCHLIST) {
    try {
      const market = await getMarket(symbol);
      results.push(market);
    } catch (err) {
      results.push({
        symbol,
        label: symbolLabel(symbol),
        error: err.message
      });
    }
  }

  const valid = results
    .filter(x => x.indicators && !x.error)
    .sort((a, b) => {
      const ca = Math.abs(a.indicators.combinedScore);
      const cb = Math.abs(b.indicators.combinedScore);
      return cb - ca;
    });

  return {
    timestamp: now(),
    markets: results,
    bestTechnical: valid[0] || null
  };
}

// ---------- Three-minute analysis engine ----------

function snapshotSummary(snapshot) {
  return snapshot.markets
    .filter(m => m.indicators)
    .map(m => ({
      symbol: m.label,
      price: m.indicators.price,
      direction: m.indicators.direction,
      confidence: m.indicators.confidence,
      rsi14: round(m.indicators.rsi14 ?? 0, 2),
      macdHistogram: round(m.indicators.macdHistogram ?? 0, 8),
      volumeRatio: round(m.indicators.volumeRatio ?? 0, 2),
      change1m: round(m.indicators.change1m ?? 0, 3),
      change5m: round(m.indicators.change5m ?? 0, 3),
      change15m: round(m.indicators.change15m ?? 0, 3),
      combinedScore: round(m.indicators.combinedScore ?? 0, 4)
    }));
}

function aggregateSnapshots() {
  const bySymbol = new Map();

  for (const snap of state.snapshots) {
    for (const market of snap.markets || []) {
      if (!market.indicators) continue;

      if (!bySymbol.has(market.symbol)) {
        bySymbol.set(market.symbol, []);
      }

      bySymbol.get(market.symbol).push(market);
    }
  }

  const aggregated = [];

  for (const [symbol, arr] of bySymbol.entries()) {
    const first = arr[0];
    const last = arr[arr.length - 1];

    const firstPrice = first.indicators.price;
    const lastPrice = last.indicators.price;

    const windowChange =
      firstPrice && lastPrice
        ? ((lastPrice - firstPrice) / firstPrice) * 100
        : 0;

    const scores = arr.map(x => x.indicators.combinedScore);
    const confidence = arr.map(x => x.indicators.confidence);

    const avgScore =
      scores.reduce((a, b) => a + b, 0) / scores.length;

    const avgConfidence =
      confidence.reduce((a, b) => a + b, 0) / confidence.length;

    // Stability: how often the technical direction agrees with the
    // final direction.
    const finalDirection =
      avgScore > 0.08 ? "UP" :
      avgScore < -0.08 ? "DOWN" :
      "WAIT";

    const agreement = arr.filter(x =>
      x.indicators.direction === finalDirection
    ).length / arr.length;

    aggregated.push({
      symbol,
      label: symbolLabel(symbol),
      snapshots: arr.length,
      firstPrice,
      lastPrice,
      windowChange,
      avgScore,
      avgConfidence,
      agreement,
      finalDirection,
      latest: last.indicators
    });
  }

  return aggregated.sort((a, b) => {
    const aScore =
      Math.abs(a.avgScore) * 0.55 +
      a.agreement * 0.30 +
      (a.avgConfidence / 100) * 0.15;

    const bScore =
      Math.abs(b.avgScore) * 0.55 +
      b.agreement * 0.30 +
      (b.avgConfidence / 100) * 0.15;

    return bScore - aScore;
  });
}

// ---------- Gemini ----------

async function askGemini(aggregated) {
  if (!GEMINI_API_KEY) {
    return {
      available: false,
      error: "GEMINI_API_KEY is not configured.",
      recommendation: null
    };
  }

  const compact = aggregated.slice(0, 8).map(x => ({
    pair: x.label,
    snapshots: x.snapshots,
    windowChangePct: round(x.windowChange, 4),
    averageTechnicalScore: round(x.avgScore, 5),
    averageTechnicalConfidence: round(x.avgConfidence, 2),
    directionAgreement: round(x.agreement * 100, 1),
    technicalDirection: x.finalDirection,
    latest: {
      price: x.latest.price,
      rsi14: round(x.latest.rsi14 ?? 0, 3),
      macdHistogram: round(x.latest.macdHistogram ?? 0, 8),
      volumeRatio: round(x.latest.volumeRatio ?? 0, 3),
      change1m: round(x.latest.change1m ?? 0, 4),
      change5m: round(x.latest.change5m ?? 0, 4),
      change15m: round(x.latest.change15m ?? 0, 4)
    }
  }));

  const prompt = `
You are the second-stage market-analysis engine for Astro Signals.

You are NOT allowed to claim certainty or guarantee a successful trade.
Your job is to select the strongest candidate only when the supplied
market evidence is sufficiently aligned. Otherwise return NO TRADE.

The data below comes from live 1-minute Binance market candles collected
continuously for approximately 3 minutes. Use the technical evidence,
momentum, RSI, MACD histogram, volume ratio, price movement and direction
stability.

Important rules:
1. Do not invent prices or indicators.
2. Do not use outside market facts that are not supplied.
3. Do not force a candidate.
4. If evidence is mixed, choose NO TRADE.
5. A "confidence" value is an estimate of signal quality, NOT a probability
   of winning and NOT a guarantee.
6. Prefer a stable direction across multiple snapshots over a single spike.
7. The final direction must be UP or DOWN for a trade candidate.
8. Only recommend a candidate if your confidence is at least 75.
9. If the best candidate is below 75 or has direction agreement below 65%,
   return NO TRADE.
10. Return JSON only.

Return exactly:
{
  "decision": "TRADE" or "NO_TRADE",
  "pair": "BTC/USD",
  "direction": "UP" or "DOWN" or "WAIT",
  "confidence": 0,
  "reason": "short evidence-based explanation",
  "riskFlags": ["..."],
  "dataQuality": 0
}

Market data:
${JSON.stringify(compact)}
`;

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;

  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json",
      maxOutputTokens: 600
    }
  };

  try {
    const response = await fetchText(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY
      },
      body: JSON.stringify(payload)
    }, 30000);

    const data = JSON.parse(response);

    const text =
      data?.candidates?.[0]?.content?.parts
        ?.map(p => p.text || "")
        .join("") || "";

    const parsed = safeJsonParse(text);

    if (!parsed) {
      return {
        available: true,
        error: "Gemini returned a response that could not be parsed.",
        recommendation: null,
        raw: text.slice(0, 1000)
      };
    }

    return {
      available: true,
      error: null,
      recommendation: parsed
    };
  } catch (err) {
    return {
      available: true,
      error: err.message,
      recommendation: null
    };
  }
}

// ---------- Signal creation ----------

function findLocalCandidate(aggregated) {
  // Strict enough to avoid forcing trades.
  return aggregated.find(x =>
    x.finalDirection !== "WAIT" &&
    x.avgConfidence >= 72 &&
    x.agreement >= 0.65 &&
    Math.abs(x.avgScore) >= 0.08
  ) || null;
}

function normalizeAiRecommendation(ai, aggregated) {
  if (!ai || !ai.recommendation) return null;

  const r = ai.recommendation;

  const decision =
    String(r.decision || "").toUpperCase();

  const pair =
    String(r.pair || "").toUpperCase();

  const direction =
    String(r.direction || "").toUpperCase();

  const confidence = Number(r.confidence);

  if (decision !== "TRADE") return null;

  if (!["UP", "DOWN"].includes(direction)) return null;

  if (!Number.isFinite(confidence) || confidence < 75) return null;

  const found = aggregated.find(x =>
    x.label.toUpperCase() === pair ||
    x.symbol.toUpperCase() === pair.replace("/", "")
  );

  if (!found) return null;

  // Do not allow Gemini to override a strongly contradictory local signal.
  if (found.finalDirection !== direction) return null;

  if (found.agreement < 0.65) return null;

  return {
    pair: found.label,
    symbol: found.symbol,
    direction,
    confidence: clamp(confidence, 0, 100),
    reason: String(r.reason || "Technical and AI evidence aligned."),
    riskFlags: Array.isArray(r.riskFlags) ? r.riskFlags.slice(0, 5) : [],
    dataQuality: Number.isFinite(Number(r.dataQuality))
      ? clamp(Number(r.dataQuality), 0, 100)
      : 85,
    source: "Gemini + technical consensus",
    market: found
  };
}

function createSignal(candidate, aiRec) {
  if (!candidate && !aiRec) return null;

  const chosen = aiRec || {
    pair: candidate.label,
    symbol: candidate.symbol,
    direction: candidate.finalDirection,
    confidence: Math.min(89, candidate.avgConfidence),
    reason:
      "Technical consensus passed the minimum filters, but Gemini was unavailable.",
    riskFlags: ["AI confirmation unavailable"],
    dataQuality: 75,
    source: "Technical consensus",
    market: candidate
  };

  // Do not create a weak signal.
  if (chosen.confidence < 75) return null;

  const created = now();

  return {
    id: `${created}-${Math.random().toString(36).slice(2, 8)}`,
    time: created,
    symbol: chosen.symbol,
    pair: chosen.pair,
    direction: chosen.direction,
    confidence: round(chosen.confidence, 1),
    reason: chosen.reason,
    riskFlags: chosen.riskFlags || [],
    dataQuality: round(chosen.dataQuality ?? 80, 1),
    source: chosen.source,
    entryPrice: chosen.market?.latest?.price ?? chosen.market?.lastPrice ?? null,
    expiresAt: created + SIGNAL_DURATION_MS,
    status: "ACTIVE"
  };
}

// ---------- IMPORTANT NULL-SAFE COMPLETED-SIGNAL EVALUATOR ----------

async function evaluateCompletedSignal(signalSnapshot) {
  // NEVER use currentSignal directly here.
  // The active signal may already have been cleared by another task.
  const signal = signalSnapshot;

  if (!signal || !signal.symbol || !signal.time) {
    console.log("No valid completed signal supplied; evaluation skipped.");
    return null;
  }

  try {
    const market = await getMarket(signal.symbol);

    const currentPrice = market?.indicators?.price;

    if (!Number.isFinite(currentPrice)) {
      throw new Error("No current market price was returned.");
    }

    const entry = Number(signal.entryPrice);

    if (!Number.isFinite(entry) || entry <= 0) {
      throw new Error("Completed signal has no valid entry price.");
    }

    const movePct = ((currentPrice - entry) / entry) * 100;

    let success = false;

    if (signal.direction === "UP") {
      success = currentPrice > entry;
    } else if (signal.direction === "DOWN") {
      success = currentPrice < entry;
    }

    return {
      id: signal.id,
      pair: signal.pair,
      direction: signal.direction,
      signalTime: signal.time,
      signalTimeDisplay: displayTime(signal.time),
      evaluatedAt: now(),
      evaluatedAtDisplay: displayTime(),
      entryPrice: entry,
      exitPrice: currentPrice,
      movePct: round(movePct, 5),
      result: success ? "SUCCESS" : "FAILED",
      success
    };
  } catch (err) {
    console.error("Completed signal evaluation failed:", err.message);

    state.errors.push({
      time: now(),
      message: `Could not evaluate completed signal: ${err.message}`
    });

    state.errors = state.errors.slice(-10);
    return null;
  }
}

async function finalizeSignal() {
  // Take a stable copy BEFORE changing currentSignal.
  const signalSnapshot =
    state.currentSignal
      ? { ...state.currentSignal }
      : null;

  if (!signalSnapshot) {
    return;
  }

  // Clear the active signal only after making the immutable snapshot.
  state.currentSignal = null;
  state.phase = "idle";

  const result =
    await evaluateCompletedSignal(signalSnapshot);

  if (result) {
    state.history.unshift(result);
    state.history = state.history.slice(0, 50);
  }
}

// ---------- Main analysis cycle ----------

async function runAnalysisCycle() {
  if (state.phase === "analyzing" || state.phase === "signal") {
    return;
  }

  state.phase = "analyzing";
  state.analysisStartedAt = now();
  state.analysisEndsAt = now() + ANALYSIS_MS;
  state.snapshots = [];
  state.latestScan = null;
  state.lastAi = null;

  const deadline = state.analysisEndsAt;

  while (now() < deadline) {
    try {
      const scan = await scanAllMarkets();

      state.latestScan = scan;
      state.lastTickAt = now();

      state.snapshots.push(scan);

      // Keep memory bounded.
      state.snapshots = state.snapshots.slice(-12);
    } catch (err) {
      state.errors.push({
        time: now(),
        message: `Market scan failed: ${err.message}`
      });
      state.errors = state.errors.slice(-10);
    }

    const remaining = deadline - now();
    if (remaining <= 0) break;

    await sleep(Math.min(SNAPSHOT_MS, remaining));
  }

  // Aggregate the whole 3-minute observation period.
  const aggregated = aggregateSnapshots();

  // Gemini gets the 3-minute evidence once.
  const ai = await askGemini(aggregated);
  state.lastAi = ai;

  const localCandidate = findLocalCandidate(aggregated);
  const aiCandidate = normalizeAiRecommendation(ai, aggregated);

  // If Gemini is available, require Gemini confirmation.
  // This is intentional: the requested app should not label a pair
  // as the "AI choice" when the AI did not confirm it.
  let finalCandidate = null;

  if (GEMINI_API_KEY) {
    finalCandidate = aiCandidate;
  } else {
    finalCandidate = localCandidate;
  }

  const signal = createSignal(localCandidate, finalCandidate);

  if (signal) {
    state.currentSignal = signal;
    state.phase = "signal";

    // Schedule evaluation from the signal's own immutable data.
    setTimeout(async () => {
      await finalizeSignal();
    }, SIGNAL_DURATION_MS);
  } else {
    state.phase = "idle";
    state.currentSignal = null;
  }
}

// ---------- API ----------

function performance() {
  const completed = state.history.length;
  const success = state.history.filter(x => x.success).length;
  const rate = completed ? (success / completed) * 100 : 0;

  return {
    completed,
    success,
    failed: completed - success,
    rate: round(rate, 1)
  };
}

function publicState() {
  const remaining =
    state.analysisEndsAt
      ? Math.max(0, state.analysisEndsAt - now())
      : 0;

  const latestMarkets =
    state.latestScan?.markets
      ?.filter(x => x.indicators)
      ?.map(x => ({
        pair: x.label,
        price: x.indicators.price,
        direction: x.indicators.direction,
        confidence: x.indicators.confidence,
        rsi: round(x.indicators.rsi14 ?? 0, 2),
        macd: round(x.indicators.macdHistogram ?? 0, 8),
        volumeRatio: round(x.indicators.volumeRatio ?? 0, 2),
        change5m: round(x.indicators.change5m ?? 0, 3)
      })) || [];

  return {
    ok: true,
    phase: state.phase,
    analysisStartedAt: state.analysisStartedAt,
    analysisEndsAt: state.analysisEndsAt,
    analysisRemainingMs: remaining,
    analysisRemainingSec: Math.ceil(remaining / 1000),
    snapshotCount: state.snapshots.length,
    lastTickAt: state.lastTickAt,
    currentSignal: state.currentSignal
      ? {
          ...state.currentSignal,
          timeDisplay: displayTime(state.currentSignal.time),
          expiresAtDisplay: displayTime(state.currentSignal.expiresAt)
        }
      : null,
    latestMarkets,
    ai: state.lastAi
      ? {
          available: state.lastAi.available,
          error: state.lastAi.error || null,
          recommendation: state.lastAi.recommendation || null
        }
      : null,
    performance: performance(),
    history: state.history.slice(0, 20),
    errors: state.errors.slice(-5),
    displayTime: displayTime()
  };
}

// ---------- Front-end ----------

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Astro Signals AI</title>
<style>
:root{
  --bg:#061226;
  --card:#0b1930;
  --card2:#102845;
  --line:#21456e;
  --text:#eef5ff;
  --muted:#91a8c5;
  --green:#28d78a;
  --red:#ff5e6c;
  --yellow:#ffc84a;
  --blue:#48a9ff;
}
*{box-sizing:border-box}
body{
  margin:0;
  background:linear-gradient(180deg,#061226,#07172d 70%,#061226);
  color:var(--text);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
}
.wrap{max-width:1000px;margin:auto;padding:18px}
header{
  display:flex;justify-content:space-between;gap:15px;align-items:center;
  padding:10px 0 18px
}
h1{margin:0;font-size:28px}
h2{margin:0 0 14px;font-size:20px}
.sub{color:var(--muted);font-size:13px}
.card{
  background:rgba(11,25,48,.96);
  border:1px solid var(--line);
  border-radius:22px;
  padding:18px;
  margin:14px 0;
  box-shadow:0 10px 30px rgba(0,0,0,.18)
}
.hero{
  background:linear-gradient(135deg,#0c2442,#0c3d39);
  border-color:#1b765c
}
.row{display:flex;gap:12px;flex-wrap:wrap}
.stat{
  flex:1;min-width:130px;
  background:#0c203b;border:1px solid var(--line);
  border-radius:15px;padding:15px
}
.big{font-size:29px;font-weight:800}
.green{color:var(--green)}
.red{color:var(--red)}
.yellow{color:var(--yellow)}
.blue{color:var(--blue)}
button{
  border:0;border-radius:13px;padding:12px 16px;
  background:#126b52;color:white;font-weight:800;
  font-size:15px
}
button.secondary{background:#163252}
table{width:100%;border-collapse:collapse}
th,td{
  text-align:left;padding:10px 7px;
  border-bottom:1px solid #173451;font-size:13px
}
th{color:var(--muted)}
.pill{
  display:inline-block;padding:6px 10px;border-radius:999px;
  background:#17375a;font-weight:800;font-size:12px
}
.signal{
  font-size:38px;font-weight:900;letter-spacing:.5px
}
.note{
  background:#102d4b;border-radius:14px;padding:13px;
  color:#d9e8fb;line-height:1.5
}
.warning{
  background:#3a2d0c;border:1px solid #725b17;
  color:#ffe7a1;border-radius:14px;padding:13px
}
.error{
  background:#3a121a;border:1px solid #7a2633;
  color:#ffd6dc;border-radius:14px;padding:13px
}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.small{font-size:12px;color:var(--muted)}
.progress{
  height:10px;background:#071529;border-radius:999px;
  overflow:hidden;margin:12px 0
}
.bar{height:100%;width:0;background:var(--blue);transition:width .4s}
#markets{overflow:auto}
footer{text-align:center;color:var(--muted);font-size:12px;padding:20px}
</style>
</head>
<body>
<div class="wrap">
<header>
  <div>
    <h1>🤖 Astro Signals</h1>
    <div class="sub">Live market scan • AI confirmation • UTC-4</div>
  </div>
  <button onclick="startAnalysis()">Start 3-Min Analysis</button>
</header>

<div class="card hero">
  <div class="small">SYSTEM STATUS</div>
  <div id="status" class="big">Loading…</div>
  <div id="clock" class="sub"></div>
  <div class="progress"><div id="bar" class="bar"></div></div>
  <div id="analysisText" class="note">
    The system observes multiple live markets for 3 minutes before selecting a candidate.
  </div>
</div>

<div id="signalCard" class="card">
  <h2>🎯 Current Signal</h2>
  <div id="signal">No active signal.</div>
</div>

<div class="card">
  <h2>🤖 Astro AI</h2>
  <div id="ai" class="note">
    Gemini confirmation will be shown here after the 3-minute analysis.
  </div>
</div>

<div class="card">
  <h2>📊 Live Market Scan</h2>
  <div id="markets">Loading live data…</div>
</div>

<div class="card">
  <h2>📈 Performance</h2>
  <div class="row">
    <div class="stat"><div id="completed" class="big">0</div><div class="small">Completed</div></div>
    <div class="stat"><div id="success" class="big green">0</div><div class="small">Success</div></div>
    <div class="stat"><div id="rate" class="big">0%</div><div class="small">Evaluated rate</div></div>
  </div>
</div>

<div class="card">
  <h2>🧾 Evaluation History</h2>
  <div id="history">No completed signals yet.</div>
</div>

<div id="errorsCard" class="card" style="display:none">
  <h2>⚠️ System Messages</h2>
  <div id="errors"></div>
</div>

<footer>
  Analysis is not a guarantee of outcome. The app can return NO TRADE when evidence is not strong enough.
</footer>
</div>

<script>
async function api(path, options={}) {
  const r = await fetch(path, options);
  return r.json();
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;");
}

function fmtPrice(n) {
  if (!Number.isFinite(Number(n))) return "—";
  const x = Number(n);
  if (x >= 1000) return x.toLocaleString(undefined,{maximumFractionDigits:2});
  if (x >= 1) return x.toLocaleString(undefined,{maximumFractionDigits:4});
  return x.toLocaleString(undefined,{maximumFractionDigits:8});
}

function render(s) {
  document.getElementById("clock").textContent = s.displayTime;

  let status = s.phase === "analyzing"
    ? "ANALYZING LIVE CHARTS"
    : s.phase === "signal"
      ? "SIGNAL ACTIVE"
      : "READY";

  document.getElementById("status").textContent = status;

  const pct = s.phase === "analyzing"
    ? Math.max(0, Math.min(100,
        ((180 - s.analysisRemainingSec) / 180) * 100))
    : s.phase === "signal" ? 100 : 0;

  document.getElementById("bar").style.width = pct + "%";

  document.getElementById("analysisText").innerHTML =
    s.phase === "analyzing"
      ? "Collecting live 1-minute candles and technical snapshots. <b>" +
        s.analysisRemainingSec + "s</b> remaining. Snapshots: " +
        s.snapshotCount
      : s.phase === "signal"
        ? "The selected signal is being evaluated for 5 minutes using subsequent market data."
        : "Waiting to begin a new 3-minute market-analysis cycle.";

  const signal = s.currentSignal;
  const signalEl = document.getElementById("signal");

  if (!signal) {
    signalEl.innerHTML =
      '<div class="sub">No active signal. The system will not force a trade when evidence is weak.</div>';
  } else {
    signalEl.innerHTML = \`
      <div class="pill">\${esc(signal.pair)}</div>
      <div class="signal \${signal.direction==="UP"?"green":"red"}">
        \${signal.direction === "UP" ? "▲ UP" : "▼ DOWN"}
      </div>
      <div class="row">
        <div class="stat">
          <div class="big">\${esc(signal.confidence)}%</div>
          <div class="small">AI/technical confidence</div>
        </div>
        <div class="stat">
          <div class="big">\${fmtPrice(signal.entryPrice)}</div>
          <div class="small">Entry reference</div>
        </div>
      </div>
      <div class="note">
        <b>Reason:</b> \${esc(signal.reason)}<br>
        <span class="small">Created: \${esc(signal.timeDisplay)} • Expires: \${esc(signal.expiresAtDisplay)}</span>
      </div>
    \`;
  }

  const ai = s.ai;
  if (!ai) {
    document.getElementById("ai").innerHTML =
      "No Gemini analysis has been completed yet.";
  } else if (ai.error) {
    document.getElementById("ai").innerHTML =
      '<div class="warning"><b>Gemini:</b> ' + esc(ai.error) + '</div>';
  } else {
    const r = ai.recommendation;
    document.getElementById("ai").innerHTML = r
      ? '<b>Decision:</b> ' + esc(r.decision) +
        '<br><b>Pair:</b> ' + esc(r.pair) +
        '<br><b>Direction:</b> ' + esc(r.direction) +
        '<br><b>Confidence:</b> ' + esc(r.confidence) + '%' +
        '<br><b>Reason:</b> ' + esc(r.reason || "") +
        '<br><span class="small">Confidence is an estimate, not a guarantee.</span>'
      : "Gemini did not confirm a trade. The system returned NO TRADE.";
  }

  const rows = s.latestMarkets || [];
  if (!rows.length) {
    document.getElementById("markets").innerHTML =
      '<div class="sub">Waiting for live market data…</div>';
  } else {
    document.getElementById("markets").innerHTML = \`
      <table>
        <thead><tr>
          <th>Pair</th><th>Price</th><th>Direction</th>
          <th>Conf.</th><th>RSI</th><th>5m</th><th>Vol</th>
        </tr></thead>
        <tbody>
          \${rows.map(m => \`
            <tr>
              <td><b>\${esc(m.pair)}</b></td>
              <td>\${fmtPrice(m.price)}</td>
              <td class="\${m.direction==="UP"?"green":m.direction==="DOWN"?"red":"yellow"}">
                \${esc(m.direction)}
              </td>
              <td>\${esc(m.confidence)}%</td>
              <td>\${esc(m.rsi)}</td>
              <td>\${esc(m.change5m)}%</td>
              <td>\${esc(m.volumeRatio)}x</td>
            </tr>\`).join("")}
        </tbody>
      </table>\`;
  }

  document.getElementById("completed").textContent = s.performance.completed;
  document.getElementById("success").textContent = s.performance.success;
  document.getElementById("rate").textContent = s.performance.rate + "%";

  if (!s.history.length) {
    document.getElementById("history").innerHTML =
      '<div class="sub">No completed signals yet.</div>';
  } else {
    document.getElementById("history").innerHTML = \`
      <table>
        <thead><tr>
          <th>Pair</th><th>Signal</th><th>Entry</th>
          <th>Exit</th><th>Move</th><th>Result</th>
        </tr></thead>
        <tbody>
          \${s.history.map(h => \`
            <tr>
              <td>\${esc(h.pair)}</td>
              <td>\${esc(h.direction)}</td>
              <td>\${fmtPrice(h.entryPrice)}</td>
              <td>\${fmtPrice(h.exitPrice)}</td>
              <td>\${esc(h.movePct)}%</td>
              <td class="\${h.success?"green":"red"}"><b>\${esc(h.result)}</b></td>
            </tr>\`).join("")}
        </tbody>
      </table>\`;
  }

  const errs = s.errors || [];
  const ec = document.getElementById("errorsCard");
  if (errs.length) {
    ec.style.display = "block";
    document.getElementById("errors").innerHTML =
      errs.map(e => '<div class="warning" style="margin:6px 0">' +
        esc(e.message) + '</div>').join("");
  } else {
    ec.style.display = "none";
  }
}

async function refresh() {
  try {
    const s = await api("/api/state");
    render(s);
  } catch (e) {
    document.getElementById("status").textContent = "CONNECTION ERROR";
  }
}

async function startAnalysis() {
  try {
    await api("/api/start", {method:"POST"});
    refresh();
  } catch(e) {}
}

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;

// ---------- HTTP server ----------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/") {
      return html(res, PAGE);
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      return json(res, 200, publicState());
    }

    if (req.method === "POST" && url.pathname === "/api/start") {
      if (state.phase === "analyzing" || state.phase === "signal") {
        return json(res, 409, {
          ok: false,
          message: "An analysis or signal is already active."
        });
      }

      // Start in background so the HTTP request returns immediately.
      runAnalysisCycle().catch(err => {
        state.phase = "idle";
        state.errors.push({
          time: now(),
          message: `Analysis cycle failed: ${err.message}`
        });
        state.errors = state.errors.slice(-10);
      });

      return json(res, 200, {
        ok: true,
        message: "3-minute analysis started."
      });
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        time: now(),
        phase: state.phase,
        geminiConfigured: Boolean(GEMINI_API_KEY)
      });
    }

    return json(res, 404, {ok:false, error:"Not found"});
  } catch (err) {
    return json(res, 500, {
      ok:false,
      error: err.message
    });
  }
});

server.listen(PORT, () => {
  console.log(`Astro Signals listening on port ${PORT}`);
  console.log(`Gemini model: ${GEMINI_MODEL}`);
  console.log(`Gemini configured: ${Boolean(GEMINI_API_KEY)}`);
});

// Start the first analysis automatically after the server boots.
// Render restarts will therefore continue generating fresh analysis.
setTimeout(() => {
  runAnalysisCycle().catch(err => {
    state.phase = "idle";
    state.errors.push({
      time: now(),
      message: `Startup analysis failed: ${err.message}`
    });
  });
}, 3000);
