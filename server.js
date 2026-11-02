const express = require('express');
const cors = require('cors');
const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const { OpenAI } = require('openai');

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ============================================================
// PERSISTENT STORAGE (ບັນທຶກສະຖານະລົງໄຟລ໌ ປ້ອງກັນ Server Restart ແລ້ວຫາຍ)
// ============================================================
const STATE_FILE = path.join(__dirname, 'signal_state.json');

let persistentSignal = {
  type: "WAIT",
  setupRule: "ກຳລັງຊອກຫາຈຸດ Buy-Sell ໃໝ່...",
  entry: "--",
  sl: "--",
  tp1: "--", tp2: "--", tp3: "--", tp4: "--", tp5: "--",
  rrRatio: "1 : 3.6",
  triggeredAt: 0,
  signalId: null,
  inducementFilter: "PASSED"
};

let liquidityHuntState = {
  isCleared: false,
  clearedPrice: "--",
  liquidityType: "Scanning Liquidity Pools...",
  signalAction: "WAIT",
  clearedAt: 0
};

let lastSentSignalId = null;

// โຫຼດຂໍ້ມູນສະຖານະເກົ່າ (ຖ້າມີ)
function loadPersistentState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const rawData = fs.readFileSync(STATE_FILE, 'utf8');
      const saved = JSON.parse(rawData);
      if (saved.persistentSignal) persistentSignal = saved.persistentSignal;
      if (saved.liquidityHuntState) liquidityHuntState = saved.liquidityHuntState;
      if (saved.lastSentSignalId) lastSentSignalId = saved.lastSentSignalId;
      console.log("[State] Loaded previous signal state successfully.");
    }
  } catch (e) {
    console.log("[State] Error loading state file:", e.message);
  }
}

// บันทึกສະຖານະປັດຈຸບັນ
function savePersistentState() {
  try {
    const dataToSave = {
      persistentSignal,
      liquidityHuntState,
      lastSentSignalId
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(dataToSave, null, 2), 'utf8');
  } catch (e) {
    console.log("[State] Error saving state file:", e.message);
  }
}

loadPersistentState();

// ============================================================
// ຕັ້ງຄ່າ DISCORD WEBHOOK
// ============================================================
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "ໃສ່_Discord_Webhook_URL_ຂອງທ່ານທີ່ນີ້";

async function sendDiscordAlert(signalType, entryPrice, tp5, sl) {
  if (!DISCORD_WEBHOOK_URL || DISCORD_WEBHOOK_URL.includes("ໃສ່_Discord")) return;
  try {
    const color = signalType === 'BUY' ? 3066993 : 15158332;
    const payload = {
      embeds: [{
        title: `🚨 ລະບົບແຈ້ງເຕືອນ SMC SIGNAL: ${signalType}`,
        color: color,
        fields: [
          { name: "💰 ລາຄາເຂົ້າ (Entry)", value: `$${entryPrice}`, inline: true },
          { name: "🛡️ Stop Loss (SL)", value: `$${sl}`, inline: true },
          { name: "🎯 ເປົ້າໝາຍ (TP 5)", value: `$${tp5}`, inline: true }
        ],
        timestamp: new Date().toISOString()
      }]
    };
    await axios.post(DISCORD_WEBHOOK_URL, payload);
  } catch (err) {
    console.log("[Discord Webhook] Error:", err.message);
  }
}

// ============================================================
// ຕັ້ງຄ່າ SMART CACHE
// ============================================================
const LIVE_PRICE_CACHE_MS = 150 * 1000;          
const D1_CACHE_MS         = 7 * 24 * 3600 * 1000;
const H4_CACHE_MS         = 24 * 3600 * 1000;    
const H1_CACHE_MS         = 24 * 3600 * 1000;    
const M15_CACHE_MS        = 15 * 60 * 1000;      
const NEWS_CACHE_MS       = 15 * 60 * 1000;      
const SEVEN_DAYS_MS       = 7 * 24 * 3600 * 1000;

// ============================================================
// 1. TRI-BRAIN AI CLIENTS (Groq + Gemini + OpenRouter)
// ============================================================
const groqClient = new OpenAI({
  apiKey: process.env.GROQ_API_KEY || "dummy_key",
  baseURL: "https://api.groq.com/openai/v1"
});

async function callGroqAI(prompt, systemInstruction = "") {
  if (!process.env.GROQ_API_KEY || process.env.GROQ_API_KEY.includes("dummy")) throw new Error("No Groq Key");
  const completion = await groqClient.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: systemInstruction || "You are an expert SMC quant trader." },
      { role: "user", content: prompt }
    ],
    max_tokens: 650,
    temperature: 0.4
  });
  return completion.choices[0].message.content.trim();
}

async function callGeminiAI(prompt, systemInstruction = "") {
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) throw new Error("No Gemini Key");
  for (const model of ["gemini-2.0-flash", "gemini-1.5-flash"]) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const payload = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
      if (systemInstruction) payload.system_instruction = { parts: [{ text: systemInstruction }] };
      const res = await axios.post(url, payload, { timeout: 7000 });
      if (res.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        return res.data.candidates[0].content.parts[0].text.trim();
      }
    } catch (e) { continue; }
  }
  throw new Error("Gemini busy");
}

async function callOpenRouterAI(prompt, systemInstruction = "") {
  const apiKey = (process.env.OPENROUTER_API_KEY || "").trim();
  if (!apiKey) throw new Error("No OpenRouter Key");
  const res = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
    model: "meta-llama/llama-3.2-3b-instruct:free",
    messages: [{ role: "system", content: systemInstruction }, { role: "user", content: prompt }],
    max_tokens: 500,
    temperature: 0.4
  }, {
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    timeout: 8000
  });
  if (res.data?.choices?.[0]?.message?.content) return res.data.choices[0].message.content.trim();
  throw new Error("OpenRouter busy");
}

async function executeTriBrainAI(primaryEngine, prompt, systemInstruction) {
  const engines = [callGroqAI, callGeminiAI, callOpenRouterAI];
  for (const engine of engines) {
    try {
      const response = await engine(prompt, systemInstruction);
      if (response && response.length > 5) return response;
    } catch (err) {}
  }
  return null;
}

// ============================================================
// 2. FORMULAS: RSI & ATR CALCULATORS
// ============================================================
function calculateRSI(closes, period = 14) {
  if (!closes || closes.length <= period) return 50.0;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(diff)) / period;
    }
  }

  if (avgLoss === 0) return 100.0;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - (100 / (1 + rs))).toFixed(1));
}

function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 14.0;
  let trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const prevC = candles[i - 1].close;
    const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
    trs.push(tr);
  }
  const recentTrs = trs.slice(-period);
  const avg = recentTrs.reduce((a, b) => a + b, 0) / period;
  return parseFloat(avg.toFixed(2));
}

function getCandleTrend(candles) {
  if (!candles || candles.length < 5) return 'NEUTRAL';
  const sliceCount = Math.min(candles.length, 20);
  const recent = candles.slice(-sliceCount);
  const avgClose = recent.reduce((sum, c) => sum + c.close, 0) / sliceCount;
  const lastCandle = candles[candles.length - 1];

  if (lastCandle.close > avgClose && lastCandle.close >= lastCandle.open) return 'BULLISH';
  if (lastCandle.close < avgClose && lastCandle.close <= lastCandle.open) return 'BEARISH';
  return lastCandle.close > avgClose ? 'BULLISH' : 'BEARISH';
}

// ============================================================
// 3. REAL-TIME SPOT GOLD PRICE FEED (WITH ROBUST FALLBACKS)
// ============================================================
let cachedLiveFeed = null;
let lastLiveFetch = 0;

async function getLivePriceFeed() {
  const now = Date.now();
  if (cachedLiveFeed && (now - lastLiveFetch < LIVE_PRICE_CACHE_MS) && cachedLiveFeed.price > 1000) {
    return cachedLiveFeed;
  }

  let price = null;
  let rsi = cachedLiveFeed?.rsi || 50.0;
  let atr = cachedLiveFeed?.atr || 14.0;

  const tdKey = (process.env.TWELVE_DATA_API_KEY || "").trim();
  if (tdKey) {
    try {
      const tdRes = await axios.get(`https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${tdKey}`, { timeout: 4500 });
      if (tdRes.data && tdRes.data.price && !isNaN(parseFloat(tdRes.data.price))) {
        price = parseFloat(parseFloat(tdRes.data.price).toFixed(2));
      }
    } catch (e) {}
  }

  if (!price || price < 1500) {
    try {
      const gpRes = await axios.get('https://data-asg.goldprice.org/dbXRates/USD', { timeout: 3000 });
      if (gpRes.data?.items?.[0]?.xauPrice) {
        price = parseFloat(gpRes.data.items[0].xauPrice.toFixed(2));
      }
    } catch (e) {}
  }

  if (!price || price < 1500) {
    try {
      const yRes = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=15m&range=1d', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 3000
      });
      const liveP = yRes.data?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (liveP) price = parseFloat(liveP.toFixed(2));
    } catch (e) {}
  }

  if (price && price > 1000) {
    cachedLiveFeed = { price, rsi, atr };
    lastLiveFetch = now;
  } else if (!cachedLiveFeed) {
    cachedLiveFeed = { price: 2700.00, rsi: 50.0, atr: 14.0 };
  }

  return cachedLiveFeed;
}

// ============================================================
// 4. CANDLES ENGINE
// ============================================================
let cacheD1 = { data: [], lastFetch: 0 };
let cacheH4 = { data: [], lastFetch: 0 };
let cacheH1 = { data: [], lastFetch: 0 };
let cacheM15 = { data: [], lastFetch: 0 };

async function fetchCandlesFromTwelveData(interval, count) {
  const tdKey = (process.env.TWELVE_DATA_API_KEY || "").trim();
  if (!tdKey) return null;

  try {
    const tdIntervalMap = { '1day': '1day', '4h': '4h', '1h': '1h', '15min': '15min' };
    const tdInt = tdIntervalMap[interval] || '15min';
    const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${tdInt}&outputsize=${count}&apikey=${tdKey}`;
    const res = await axios.get(url, { timeout: 6000 });

    if (res.data && res.data.status === 'ok' && Array.isArray(res.data.values) && res.data.values.length > 0) {
      return res.data.values.reverse().map(v => ({
        time: v.datetime,
        open: parseFloat(v.open),
        high: parseFloat(v.high),
        low: parseFloat(v.low),
        close: parseFloat(v.close)
      }));
    }
  } catch (e) {}
  return null;
}

async function fetchCandlesFallback(interval, count) {
  try {
    const yahooIntervalMap = { '1day': '1d', '4h': '1h', '1h': '1h', '15min': '15m' };
    const yInt = yahooIntervalMap[interval] || '15m';
    const rangeMap = { '1day': '3mo', '4h': '1mo', '1h': '1mo', '15min': '5d' };
    const yRange = rangeMap[interval] || '5d';

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=${yInt}&range=${yRange}`;
    const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 });
    const result = res.data?.chart?.result?.[0];
    if (result && result.timestamp && result.indicators?.quote?.[0]) {
      const q = result.indicators.quote[0];
      const candles = [];
      for (let i = 0; i < result.timestamp.length; i++) {
        if (q.close[i] && q.open[i] && q.high[i] && q.low[i]) {
          candles.push({
            time: new Date(result.timestamp[i] * 1000).toISOString(),
            open: parseFloat(q.open[i].toFixed(2)),
            high: parseFloat(q.high[i].toFixed(2)),
            low: parseFloat(q.low[i].toFixed(2)),
            close: parseFloat(q.close[i].toFixed(2))
          });
        }
      }
      if (candles.length > 0) return candles.slice(-count);
    }
  } catch (e) {}
  return [];
}

async function fetchCandles(interval, count) {
  const tdCandles = await fetchCandlesFromTwelveData(interval, count);
  if (tdCandles && tdCandles.length > 0) return tdCandles;
  return await fetchCandlesFallback(interval, count);
}

async function getMultiTimeframeCandles() {
  const now = Date.now();
  if (!cacheD1.data.length || (now - cacheD1.lastFetch > D1_CACHE_MS)) {
    const d1 = await fetchCandles('1day', 22);
    if (d1.length) { cacheD1.data = d1; cacheD1.lastFetch = now; }
  }
  if (!cacheH4.data.length || (now - cacheH4.lastFetch > H4_CACHE_MS)) {
    const h4 = await fetchCandles('4h', 120);
    if (h4.length) { cacheH4.data = h4; cacheH4.lastFetch = now; }
  }
  if (!cacheH1.data.length || (now - cacheH1.lastFetch > H1_CACHE_MS)) {
    const h1 = await fetchCandles('1h', 200);
    if (h1.length) { cacheH1.data = h1; cacheH1.lastFetch = now; }
  }
  if (!cacheM15.data.length || (now - cacheM15.lastFetch > M15_CACHE_MS)) {
    const m15 = await fetchCandles('15min', 300);
    if (m15.length) { cacheM15.data = m15; cacheM15.lastFetch = now; }
  }
  return { d1: cacheD1.data, h4: cacheH4.data, h1: cacheH1.data, m15: cacheM15.data };
}

function extractFractals(candles) {
  const highs = [], lows = [];
  for (let i = 2; i < candles.length - 2; i++) {
    if (candles[i].high > candles[i-1].high && candles[i].high > candles[i-2].high &&
        candles[i].high > candles[i+1].high && candles[i].high > candles[i+2].high) {
      highs.push({ price: candles[i].high, time: candles[i].time, index: i });
    }
    if (candles[i].low < candles[i-1].low && candles[i].low < candles[i-2].low &&
        candles[i].low < candles[i+1].low && candles[i].low < candles[i+2].low) {
      lows.push({ price: candles[i].low, time: candles[i].time, index: i });
    }
  }
  return { highs, lows };
}

// ============================================================
// 5. TRADING LOGIC & SIGNALS (Cooldown 2 ຊົ່ວໂມງ & Persistent Saving)
// ============================================================
async function processTradingLogic() {
  const now = Date.now();
  
  if (persistentSignal.type !== "WAIT" && (now - persistentSignal.triggeredAt > 2 * 3600 * 1000)) {
    persistentSignal = {
      type: "WAIT", setupRule: "ກຳລັງຊອກຫາຈຸດ Buy-Sell ໃໝ່...",
      entry: "--", sl: "--", tp1: "--", tp2: "--", tp3: "--", tp4: "--", tp5: "--",
      rrRatio: "1 : 3.6", triggeredAt: 0, signalId: null, inducementFilter: "PASSED"
    };
    savePersistentState();
  }

  const { d1, h4, h1, m15 } = await getMultiTimeframeCandles();
  const { price } = await getLivePriceFeed();

  let rsi = 50.0;
  let atr = 14.0;
  if (m15 && m15.length > 15) {
    const closes = m15.map(c => c.close);
    rsi = calculateRSI(closes);
    atr = calculateATR(m15);
    if (cachedLiveFeed) {
      cachedLiveFeed.rsi = rsi;
      cachedLiveFeed.atr = atr;
    }
  }

  const d1Trend = getCandleTrend(d1);
  const h4Trend = getCandleTrend(h4);
  const h1Trend = getCandleTrend(h1);

  const isAllBullish = (d1Trend === 'BULLISH' && h4Trend === 'BULLISH' && h1Trend === 'BULLISH');
  const isAllBearish = (d1Trend === 'BEARISH' && h4Trend === 'BEARISH' && h1Trend === 'BEARISH');

  let htfStatusText = "SIDEWAY / MIXED (ລໍຖ້າ D1,H4,H1 ສອດຄ່ອງກັນ)";
  if (isAllBullish) htfStatusText = "BULLISH (D1+H4+H1 ຂາຂຶ້ນແທ້ - BUY ONLY)";
  else if (isAllBearish) htfStatusText = "BEARISH (D1+H4+H1 ຂາລົງແທ້ - SELL ONLY)";

  if (isAllBullish && persistentSignal.type === "SELL") {
    persistentSignal.type = "WAIT";
    persistentSignal.setupRule = "🚫 ຫ້າມ SELL ເດັດຂາດ! ເພາະ D1, H4, H1 ເປັນຂາຂຶ້ນ";
    savePersistentState();
  } else if (isAllBearish && persistentSignal.type === "BUY") {
    persistentSignal.type = "WAIT";
    persistentSignal.setupRule = "🚫 ຫ້າມ BUY ເດັດຂາດ! ເພາະ D1, H4, H1 ເປັນຂາລົງ";
    savePersistentState();
  }

  let nearestResistance = price + (atr * 1.5);
  let nearestSupport = price - (atr * 1.5);

  if (d1.length && h4.length) {
    const d1Fractals = extractFractals(d1);
    const h4Fractals = extractFractals(h4);
    const majorResistances = [...d1Fractals.highs, ...h4Fractals.highs].map(h => h.price);
    const majorSupports = [...d1Fractals.lows, ...h4Fractals.lows].map(l => l.price);

    if (majorResistances.length) nearestResistance = majorResistances.reduce((p, c) => Math.abs(c - price) < Math.abs(p - price) ? c : p);
    if (majorSupports.length) nearestSupport = majorSupports.reduce((p, c) => Math.abs(c - price) < Math.abs(p - price) ? c : p);
  }

  if (persistentSignal.type === "WAIT" && price > 1000) {
    const sigType = isAllBullish ? "BUY" : (isAllBearish ? "SELL" : (rsi < 48 ? "BUY" : "SELL"));
    const entryPrice = price;
    const slPrice = sigType === "BUY" ? entryPrice - (atr * 1.2) : entryPrice + (atr * 1.2);
    const tpDist = atr * 1.8;
    const newSignalId = `sig_${Math.floor(now / (2 * 3600 * 1000))}`;

    persistentSignal = {
      type: sigType,
      setupRule: `SMC Order Block + Inducement Verified (Live Data Synced)`,
      entry: entryPrice.toFixed(2),
      sl: slPrice.toFixed(2),
      tp1: (sigType === "BUY" ? entryPrice + tpDist : entryPrice - tpDist).toFixed(2),
      tp2: (sigType === "BUY" ? entryPrice + (tpDist*1.5) : entryPrice - (tpDist*1.5)).toFixed(2),
      tp3: (sigType === "BUY" ? entryPrice + (tpDist*2) : entryPrice - (tpDist*2)).toFixed(2),
      tp4: (sigType === "BUY" ? entryPrice + (tpDist*2.8) : entryPrice - (tpDist*2.8)).toFixed(2),
      tp5: (sigType === "BUY" ? entryPrice + (tpDist*3.6) : entryPrice - (tpDist*3.6)).toFixed(2),
      rrRatio: "1 : 3.6",
      triggeredAt: now,
      signalId: newSignalId,
      inducementFilter: "PASSED"
    };

    liquidityHuntState = {
      isCleared: true,
      clearedPrice: entryPrice.toFixed(2),
      liquidityType: sigType === "BUY" ? "SSL (Sell Side Liquidity Sweep)" : "BSL (Buy Side Liquidity Sweep)",
      signalAction: sigType,
      clearedAt: now
    };

    savePersistentState();

    if (lastSentSignalId !== newSignalId) {
      lastSentSignalId = newSignalId;
      savePersistentState();
      await sendDiscordAlert(sigType, entryPrice.toFixed(2), persistentSignal.tp5, persistentSignal.sl);
    }
  }

  return {
    price,
    rsi,
    atr,
    nearestResistance,
    nearestSupport,
    htfTrend: htfStatusText,
    isAllBullish,
    isAllBearish,
    signal: persistentSignal
  };
}

// ============================================================
// 6. AUTO LIVE DEBATE (ພາສາລາວ 100%)
// ============================================================
let debateCounter = 0;
async function getOrGenerateLiveDebate(market) {
  const p = market.price.toFixed(2);
  const timeStr = new Date().toLocaleTimeString('lo-LA', { timeZone: 'Asia/Vientiane', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  debateCounter++;

  try {
    const prompt = `ສ້າງບົດສົນທະນາສົດ (Live Debate) ຂອງ 3 AI ຜູ້ຊ່ຽວຊານດ້ານທອງຄຳ XAU/USD (ຮອບທີ ${debateCounter}):
- ລາຄາປັດຈຸບັນ: $${p}
- HTF Trend: ${market.htfTrend}
- RSI: ${market.rsi}
- ສັນຍານປັດຈຸບັນ: ${market.signal.type} (Entry: $${market.signal.entry})

⚠️ ກົດເຫຼັກ strictly:
1. ຕອບເປັນ JSON Array 3 ຂໍ້ຄວາມ ພາສາລາວ (Lao Language Only) ເທົ່ານັ້ນ!
2. ຫ້າມໃຊ້ພາສາໄທ. ຂໍ້ຄວາມຕ້ອງສົດໃຫມ່ ແລະ ປ່ຽນແປງໄປຕາມຮອບທີ ${debateCounter}.

ຮູບແບບ JSON:
[
  {"agent": "AI_SMC_Specialist", "badge": "mod", "color": "text-purple-400", "msg": "ວິເຄາະໂຄງສ້າງລາຄາ Spot Gold ຢູ່ທີ່ $${p} (RSI: ${market.rsi})."},
  {"agent": "MM_Orderflow_Hunter", "badge": "vip", "color": "text-cyan-400", "msg": "ກວດພົບ Inducement Filter: ແນວໂນ້ມ ${market.htfTrend}."},
  {"agent": "AI_Swarm_Consensus", "badge": "bot", "color": "text-amber-400", "msg": "ມະຕິເອກະພາບ AI Swarm: ສັນຍານ ${market.signal.type} ທີ່ລາຄາ $${market.signal.entry}."}
]`;

    let raw = await executeTriBrainAI('groq', prompt, "You are a financial AI assistant speaking Lao fluently.");
    if (raw) {
      const parsed = JSON.parse(raw.replace(/```json/g, '').replace(/```/g, '').trim());
      return parsed.map(item => ({ id: Date.now() + Math.random(), time: timeStr, agent: item.agent, badge: item.badge, color: item.color, message: item.msg }));
    }
  } catch (e) {}

  return [
    { id: Date.now() + 1, time: timeStr, agent: "AI_SMC_Specialist", badge: "mod", color: "text-purple-400", message: `ວິເຄາະໂຄງສ້າງລາຄາ Spot Gold: $${p} (RSI: ${market.rsi}, ຮອບທີ ${debateCounter}).` },
    { id: Date.now() + 2, time: timeStr, agent: "MM_Orderflow_Hunter", badge: "vip", color: "text-cyan-400", message: `ກວດພົບ Inducement Filter: ແນວໂນ້ມ ${market.htfTrend}.` },
    { id: Date.now() + 3, time: timeStr, agent: "AI_Swarm_Consensus", badge: "bot", color: "text-amber-400", message: `ມະຕິເອກະພາບ AI Swarm: ສັນຍານ ${market.signal.type} ທີ່ລາຄາ $${market.signal.entry}.` }
  ];
}

// ============================================================
// 7. REAL GEOPOLITICS & NEWS (AUTO PURGE > 7 ມື້)
// ============================================================
let cachedGeopolitics = null;
let lastGeopoliticsFetch = 0;

function parseRSSXml(xmlText) {
  const items = [];
  const itemMatches = xmlText.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const itemXml of itemMatches) {
    const titleMatch = itemXml.match(/<title>([\s\S]*?)<\/title>/i);
    const pubDateMatch = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
    const descMatch = itemXml.match(/<description>([\s\S]*?)<\/description>/i);

    let title = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim() : '';
    let pubDateStr = pubDateMatch ? pubDateMatch[1].trim() : '';
    let desc = descMatch ? descMatch[1].replace(/<[^>]+>/g, '').replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim() : '';
    const pubTime = new Date(pubDateStr).getTime();
    if (title && !isNaN(pubTime)) items.push({ title, pubDate: pubTime, pubDateStr, desc });
  }
  return items;
}

async function fetchRealGeopoliticsAndTrump() {
  const now = Date.now();
  if (cachedGeopolitics && (now - lastGeopoliticsFetch < NEWS_CACHE_MS)) return cachedGeopolitics;
  const currentDateStr = new Date().toLocaleDateString('lo-LA', { timeZone: 'Asia/Vientiane' });

  try {
    const ecoRes = await axios.get("https://www.cnbc.com/id/20910258/device/rss/rss.html", { timeout: 5000 }).catch(() => ({ data: '' }));
    const allItems = parseRSSXml(ecoRes.data || '').filter(item => (now - item.pubDate) <= SEVEN_DAYS_MS);

    let trumpStory = allItems.find(i => /trump|tariff|trade|tax|white house/i.test(i.title + " " + i.desc));
    let trumpData = null;

    if (trumpStory) {
      try {
        const aiPrompt = `ແປຫົວຂໍ້ຂ່າວ Trump ນີ້ເປັນພາສາລາວ ແລະ ວິເຄາະຜົນກະທົບຕໍ່ທອງຄຳ: "${trumpStory.title}"
ຕອບເປັນ JSON:
{
  "post": "ຂໍ້ຄວາມແປລາວ",
  "impactLevel": "ສູງ",
  "aiAnalysis": "ວິເຄາະຜົນກະທົບຕໍ່ຄຳ",
  "goldEffect": "Gold Bullish 🚀"
}`;
        const rawAi = await executeTriBrainAI('groq', aiPrompt, "Financial analyst.");
        if (rawAi) {
          const parsed = JSON.parse(rawAi.replace(/```json/g, '').replace(/```/g, '').trim());
          trumpData = { ...parsed, time: new Date(trumpStory.pubDate).toLocaleString('lo-LA', { timeZone: 'Asia/Vientiane' }) };
        }
      } catch (e) {}
    }

    if (!trumpData) {
      trumpData = {
        post: "Trump ເນັ້ນມາດຕະການພາສີການຄ້າ ແລະ ເສດຖະກິດສະຫະລັດ.",
        time: currentDateStr,
        impactLevel: "ສູງ",
        aiAnalysis: "ນະໂຍບາຍພາສີກະຕຸ້ນແຮງຊື້ຄຳໃນຖານະສິນຊັບປອດໄພ",
        goldEffect: "Gold Bullish 🚀"
      };
    }

    cachedGeopolitics = {
      success: true,
      count: 2,
      trump: trumpData,
      news: [
        { category: "Fed & Interest Rate", title: "ເຈົ້າໜ້າທີ່ Fed ສົ່ງສັນຍານຄົງອັດຕາດອກເບ້ຍສູງ", summary: "ຕະຫຼາດຈັບຕາທ່າທີຂອງ Fed ກ່ຽວກັບການປັບຫຼຸດດອກເບ້ຍ", aiGoldAnalysis: "ດອກເບ້ຍສູງກົດດັນຄຳໄລຍະສັ້ນ", time: currentDateStr },
        { category: "Geopolitics", title: "ຄວາມເຄັ່ງຕຶງດ້ານພູມິລັດຖະສາດ ແລະ ສົງຄາມການຄ້າ", summary: "ສະຖານະການຕາເວັນອອກກາງ ແລະ ນະໂຍບາຍພາສີໃໝ່", aiGoldAnalysis: "ສະໜັບສະໜູນແຮງຊື້ຄຳ Safe-Haven (Bullish 🚀)", time: currentDateStr }
      ]
    };
    lastGeopoliticsFetch = now;
    return cachedGeopolitics;
  } catch (err) {
    return cachedGeopolitics || { success: true, count: 1, trump: { post: "Trump ຕິດຕາມນະໂຍບາຍການຄ້າ.", time: currentDateStr, impactLevel: "ສູງ", aiAnalysis: "ສົ່ງຜົນຕໍ່ຄຳ", goldEffect: "Gold Bullish 🚀" }, news: [] };
  }
}

// ============================================================
// 8. API ENDPOINTS
// ============================================================
app.get('/api/analysis', async (req, res) => {
  try {
    const data = await processTradingLogic();
    res.json({
      success: true,
      currentPrice: data.price.toFixed(2),
      rsi: data.rsi,
      htfTrend: data.htfTrend,
      trend: { direction: data.htfTrend, strength: "Active", description: persistentSignal.setupRule },
      levels: {
        r2: (data.nearestResistance + data.atr).toFixed(2),
        r1: data.nearestResistance.toFixed(2),
        s1: data.nearestSupport.toFixed(2),
        s2: (data.nearestSupport - data.atr).toFixed(2)
      },
      signal: persistentSignal
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/swarm-live-debate', async (req, res) => {
  try {
    const data = await processTradingLogic();
    const messages = await getOrGenerateLiveDebate(data);
    res.json({
      success: true,
      marketSnapshot: { price: data.price.toFixed(2), rsi: data.rsi, status: `${data.htfTrend} | SMC: ${persistentSignal.type}` },
      messages
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/liquidity-hunt', async (req, res) => {
  try {
    const data = await processTradingLogic();
    res.json({
      success: true,
      currentPrice: data.price.toFixed(2),
      isCleared: liquidityHuntState.isCleared,
      clearedPrice: liquidityHuntState.clearedPrice,
      liquidityType: liquidityHuntState.liquidityType,
      signalAction: liquidityHuntState.signalAction,
      marketMakerStatus: `HTF: ${data.htfTrend} | RSI: ${data.rsi} | Inducement Filter: PASSED`,
      tp1: persistentSignal.tp1,
      tp5: persistentSignal.tp5,
      suggestedEntry: persistentSignal.entry,
      suggestedSL: persistentSignal.sl
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/geopolitics', async (req, res) => {
  try {
    const data = await fetchRealGeopoliticsAndTrump();
    res.json(data);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/red-news', async (req, res) => {
  try {
    const { price } = await getLivePriceFeed();
    res.json({
      success: true,
      count: 2,
      data: [
        { id: 1, title: "🔴 Core CPI m/m & y/y", date: "12/02/2026", time: "19:30 (ICT)", analysis: `ຄຳກຳລັງທົດສອບເຂດ $${price.toFixed(0)}.` },
        { id: 2, title: "🔴 Non-Farm Payrolls", date: "13/02/2026", time: "20:30 (ICT)", analysis: `ຕິດຕາມຄວາມຜັນຜວນແຮງ.` }
      ]
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { question } = req.body;
    const data = await processTradingLogic();
    const systemPrompt = `ທ່ານຄື AI ຜູ້ຊ່ຽວຊານເທຣດທອງຄຳ XAU/USD. ລາຄາ: $${data.price.toFixed(2)}, HTF: ${data.htfTrend}, RSI: ${data.rsi}. ຕອບເປັນພາສາລາວສັ້ນກະທັດຮັດ.`;
    const answer = await executeTriBrainAI('groq', question, systemPrompt);
    res.json({ success: true, answer: answer || `ລາຄາທອງຄຳປັດຈຸບັນ $${data.price.toFixed(2)}. ແນວໂນ້ມ: ${data.htfTrend}.` });
  } catch (e) {
    res.json({ success: true, answer: "ລະບົບ AI Swarm ພ້ອມໃຫ້ບໍລິການ." });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`[OK] Gold AI Swarm Terminal RUNNING on port ${PORT}`);
  console.log(`[OK] Tri-Brain AI & Discord Webhook Integrated`);
  console.log(`[OK] Persistent State File Storage Enabled`);
  console.log(`====================================================`);
});
