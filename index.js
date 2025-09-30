// index.js — FXシグナル → Cloudflare WorkerへPOST（PC不要、GitHub Actionsで実行）
import fetch from "node-fetch";

/**
 * ▼設定（環境変数）
 * 必須: FOREX_API_KEY, WORKER_URL
 * 任意: LINE_TO, PAIRS, SILENT_UTC
 * 例:
 *   PAIRS="USDJPY,EURUSD"
 *   SILENT_UTC="00:00-04:30"
 */
const {
  FOREX_API_KEY,
  WORKER_URL,
  LINE_TO,
  PAIRS = "USDJPY,EURUSD",
  SILENT_UTC = "00:00-04:30",
} = process.env;

if (!FOREX_API_KEY || !WORKER_URL) {
  console.error("Missing FOREX_API_KEY or WORKER_URL env.");
  process.exit(1);
}

// ---- データ取得: Alpha Vantage FX (無料枠あり) -----------------------------
async function getCandles(pair, interval = "60min", outputsize = "compact") {
  const from = pair.slice(0, 3);
  const to = pair.slice(3);
  const url =
    `https://www.alphavantage.co/query?function=FX_INTRADAY&from_symbol=${from}` +
    `&to_symbol=${to}&interval=${interval}&outputsize=${outputsize}&apikey=${FOREX_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`AlphaVantage ${pair} HTTP ${res.status}`);
  const json = await res.json();
  const series = json[`Time Series FX (${interval})`];
  if (!series) throw new Error(`No series for ${pair}: ${JSON.stringify(json).slice(0,200)}`);
  const candles = Object.entries(series)
    .map(([t, ohlc]) => ({
      time: new Date(t + "Z"),
      open: Number(ohlc["1. open"]),
      high: Number(ohlc["2. high"]),
      low: Number(ohlc["3. low"]),
      close: Number(ohlc["4. close"]),
    }))
    .sort((a, b) => a.time - b.time);
  return candles;
}

// ---- インジケータ ----------------------------------------------------------
function SMA(vals, period) {
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    if (i + 1 < period) { out.push(null); continue; }
    const slice = vals.slice(i + 1 - period, i + 1);
    out.push(slice.reduce((a, b) => a + b, 0) / period);
  }
  return out;
}
function EMA(vals, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = null;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (prev === null) prev = v;
    else prev = v * k + prev * (1 - k);
    out.push(prev);
  }
  for (let i = 0; i < period - 1; i++) out[i] = null;
  return out;
}
function RSI(vals, period = 14) {
  const out = new Array(vals.length).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const ch = vals[i] - vals[i - 1];
    if (ch >= 0) gains += ch; else losses -= ch;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = 100 - (100 / (1 + (avgGain / (avgLoss || 1e-8))));
  for (let i = period + 1; i < vals.length; i++) {
    const ch = vals[i] - vals[i - 1];
    const gain = Math.max(ch, 0);
    const loss = Math.max(-ch, 0);
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / (avgLoss || 1e-8);
    out[i] = 100 - (100 / (1 + rs));
  }
  return out;
}
function MACD(vals, fast = 12, slow = 26, signal = 9) {
  const emaFast = EMA(vals, fast);
  const emaSlow = EMA(vals, slow);
  const macd = vals.map((_, i) =>
    (emaFast[i] == null || emaSlow[i] == null) ? null : (emaFast[i] - emaSlow[i])
  );
  const macdVals = macd.map(v => v ?? 0);
  const signalArr = EMA(macdVals, signal).map((v, i) => (macd[i] == null ? null : v));
  const hist = macd.map((v, i) => (v == null || signalArr[i] == null) ? null : (v - signalArr[i]));
  return { macd, signal: signalArr, hist };
}
function Bollinger(vals, period = 20, mult = 2) {
  const basis = SMA(vals, period);
  const upper = new Array(vals.length).fill(null);
  const lower = new Array(vals.length).fill(null);
  for (let i = 0; i < vals.length; i++) {
    if (basis[i] == null) continue;
    const slice = vals.slice(i + 1 - period, i + 1);
    const mean = basis[i];
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
    const stdev = Math.sqrt(variance);
    upper[i] = mean + mult * stdev;
    lower[i] = mean - mult * stdev;
  }
  return { basis, upper, lower };
}

// ---- 戦略ルール ------------------------------------------------------------
function decideSignal(candles) {
  const closes = candles.map(c => c.close);
  const ema20 = EMA(closes, 20);
  const ema50 = EMA(closes, 50);
  const sma200 = SMA(closes, 200);
  const rsi14 = RSI(closes, 14);
  const { macd, signal } = MACD(closes, 12, 26, 9);
  const bb = Bollinger(closes, 20, 2);

  const i = closes.length - 1;
  const p = closes[i];
  const conds = {
    aboveSMA200: sma200[i] != null && p > sma200[i],
    belowSMA200: sma200[i] != null && p < sma200[i],
    emaBull: ema20[i] != null && ema50[i] != null && ema20[i] > ema50[i],
    emaBear: ema20[i] != null && ema50[i] != null && ema20[i] < ema50[i],
    rsiBull: rsi14[i] != null && rsi14[i] > 55,
    rsiBear: rsi14[i] != null && rsi14[i] < 45,
    macdBull: macd[i] != null && signal[i] != null && macd[i] > signal[i] && macd[i - 1] <= signal[i - 1],
    macdBear: macd[i] != null && signal[i] != null && macd[i] < signal[i] && macd[i - 1] >= signal[i - 1],
    bbOk: bb.upper[i] != null && bb.lower[i] != null && p > bb.lower[i] && p < bb.upper[i],
  };

  const scoreBuy = [conds.aboveSMA200, conds.emaBull, conds.rsiBull, conds.macdBull, conds.bbOk].filter(Boolean).length;
  const scoreSell = [conds.belowSMA200, conds.emaBear, conds.rsiBear, conds.macdBear, conds.bbOk].filter(Boolean).length;

  if (scoreBuy >= 4) return { side: "BUY", stars: "★★★".slice(0, Math.min(3, scoreBuy - 1)) || "★" };
  if (scoreSell >= 4) return { side: "SELL", stars: "★★★".slice(0, Math.min(3, scoreSell - 1)) || "★" };
  return null;
}

// ---- WorkersへPOST ---------------------------------------------------------
async function postToWorker({ short, detail, to }) {
  const payload = { type: "signal", line: { short, detail } };
  if (to) payload.to = to;

  const res = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Worker POST failed ${res.status}: ${t}`);
  }
}

function fmt(n, decimals = 5) {
  return Number(n).toFixed(decimals);
}

async function runPair(pair) {
  const candles = await getCandles(pair, "60min", "compact");
  if (candles.length < 210) throw new Error(`${pair}: not enough candles`);

  const sig = decideSignal(candles);
  if (!sig) {
    console.log(`${pair}: no signal`);
    return;
  }

  const p = candles[candles.length - 1].close;
  const short = `${sig.side === "BUY" ? "🔵BUY🔵" : "🔴SELL🔴"} ${pair} ${fmt(p, pair.endsWith("JPY") ? 3 : 5)} ${sig.stars}`;
  const detail = `1H 戦略条件合致。RSI/MACD/MA/BBで総合評価。SL/TPは直近高安で調整。`;

  await postToWorker({ short, detail, to: LINE_TO });
  console.log(`${pair}: posted -> LINE`);
}

async function main() {
  if (SILENT_UTC) {
    const [s, e] = SILENT_UTC.split("-");
    const now = new Date();
    const hm = now.getUTCHours() * 60 + now.getUTCMinutes();
    const toMin = (x) => { const [H, M] = x.split(":").map(Number); return H * 60 + (M || 0); };
    const sMin = toMin(s || "00:00"), eMin = toMin(e || "04:30");
    const inSilent = sMin <= eMin ? (hm >= sMin && hm <= eMin) : (hm >= sMin || hm <= eMin);
    if (inSilent) { console.log(`silent window ${SILENT_UTC}: skip`); return; }
  }

  const pairs = PAIRS.split(",").map(s => s.trim()).filter(Boolean);
  for (const pair of pairs) {
    try { await runPair(pair); }
    catch (e) { console.error(pair, String(e)); }
    await new Promise(r => setTimeout(r, 15000));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
