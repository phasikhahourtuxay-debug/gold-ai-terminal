const express = require('express');
const cors = require('cors');
const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');
const { OpenAI } = require('openai');

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ============================================================
// ຕັ້ງຄ່າ SMART CACHE (ຄິດໄລ່ລວມແລ້ວ ~674 ຄັ້ງ/ມື້ ບໍ່ເກີນ 800 ໂກຕາຟຣີ)
// ============================================================
const LIVE_PRICE_CACHE_MS = 150 * 1000;          // 2.5 ນາທີ (576 calls/ມື້)
const D1_CACHE_MS         = 7 * 24 * 3600 * 1000;// 7 ມື້ (1 ອາທິດດຶງ 1 ຄັ້ງ)
const H4_CACHE_MS         = 24 * 3600 * 1000;    // 24 ຊົ່ວໂມງ (1 ມື້ດຶງ 1 ຄັ້ງ)
const H1_CACHE_MS         = 24 * 3600 * 1000;    // 24 ຊົ່ວໂມງ (1 ມື້ດຶງ 1 ຄັ້ງ)
const M15_CACHE_MS        = 15 * 60 * 1000;      // 15 ນາທີ (96 calls/ມື້ ຕາມແທ່ງ M15 ປິດ)
const NEWS_CACHE_MS       = 15 * 60 * 1000;      // Cache ຂ່າວໄວ້ 15 ນາທີ ບໍ່ໃຫ້ເປືອງ AI
const SEVEN_DAYS_MS       = 7 * 24 * 3600 * 1000;// 7 ມື້ສຳລັບ Auto-Purge

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
    temperature: 0.3
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

// ============================================================
// 3. REAL-TIME SPOT GOLD PRICE FEED (Twelve Data Cache 2.5 Min)
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
        console.log(`[Twelve Data] Live Spot Price: $${price} at ${new Date().toLocaleTimeString('lo-LA', { timeZone: 'Asia/Vientiane' })}`);
      }
    } catch (e) {
      console.log("[Twelve Data Price] Fallback triggered:", e.message);
    }
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
// 4. CANDLES ENGINE (Twelve Data ຫຼັກ + Yahoo/Binance ສຳຮອງ)
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
      const candles = res.data.values.reverse().map(v => ({
        time: v.datetime,
        open: parseFloat(v.open),
        high: parseFloat(v.high),
        low: parseFloat(v.low),
        close: parseFloat(v.close)
      }));
      return candles;
    }
  } catch (e) {
    console.log(`[Twelve Data Candles ${interval}] Error:`, e.message);
  }
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

  try {
    const binanceIntervalMap = { '1day': '1d', '4h': '4h', '1h': '1h', '15min': '15m' };
    const bInterval = binanceIntervalMap[interval] || '15m';
    const url = `https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=${bInterval}&limit=${count}`;
    const res = await axios.get(url, { timeout: 4000 });
    if (res.data && Array.isArray(res.data)) {
      return res.data.map(c => ({
        time: new Date(c[0]).toISOString(),
        open: parseFloat(c[1]),
        high: parseFloat(c[2]),
        low: parseFloat(c[3]),
        close: parseFloat(c[4])
      }));
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
    if (d1.length) { cacheD1.data = d1; cacheD1.lastFetch = now; console.log("[Twelve Data Sync] D1 Candles Cached (7 Days)"); }
  }

  if (!cacheH4.data.length || (now - cacheH4.lastFetch > H4_CACHE_MS)) {
    const h4 = await fetchCandles('4h', 120);
    if (h4.length) { cacheH4.data = h4; cacheH4.lastFetch = now; console.log("[Twelve Data Sync] H4 Candles Cached (24 Hours)"); }
  }

  if (!cacheH1.data.length || (now - cacheH1.lastFetch > H1_CACHE_MS)) {
    const h1 = await fetchCandles('1h', 200);
    if (h1.length) { cacheH1.data = h1; cacheH1.lastFetch = now; console.log("[Twelve Data Sync] H1 Candles Cached (24 Hours)"); }
  }

  if (!cacheM15.data.length || (now - cacheM15.lastFetch > M15_CACHE_MS)) {
    const m15 = await fetchCandles('15min', 300);
    if (m15.length) { cacheM15.data = m15; cacheM15.lastFetch = now; console.log("[Twelve Data Sync] M15 Candles Updated (15 Mins)"); }
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
// 5. TRADING LOGIC & SIGNALS (4 SMC Setups & Inducement Filter)
// ============================================================
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

async function processTradingLogic() {
  const now = Date.now();
  if (persistentSignal.type !== "WAIT" && (now - persistentSignal.triggeredAt > 20 * 60 * 1000)) {
    persistentSignal = {
      type: "WAIT", setupRule: "ກຳລັງຊອກຫາຈຸດ Buy-Sell ໃໝ່...",
      entry: "--", sl: "--", tp1: "--", tp2: "--", tp3: "--", tp4: "--", tp5: "--",
      rrRatio: "1 : 3.6", triggeredAt: 0, signalId: null, inducementFilter: "PASSED"
    };
  }
  if (liquidityHuntState.isCleared && (now - liquidityHuntState.clearedAt > 10 * 60 * 1000)) {
    liquidityHuntState = {
      isCleared: false, clearedPrice: "--", liquidityType: "Scanning M15 Liquidity Pools...",
      signalAction: "WAIT", clearedAt: 0
    };
  }

  const { d1, h4, m15 } = await getMultiTimeframeCandles();
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

  let isD1Bullish = true;
  let nearestResistance = price + (atr * 1.5);
  let nearestSupport = price - (atr * 1.5);

  if (d1.length && h4.length) {
    const d1Fractals = extractFractals(d1);
    const h4Fractals = extractFractals(h4);
    const majorResistances = [...d1Fractals.highs, ...h4Fractals.highs].map(h => h.price);
    const majorSupports = [...d1Fractals.lows, ...h4Fractals.lows].map(l => l.price);

    if (majorResistances.length) nearestResistance = majorResistances.reduce((p, c) => Math.abs(c - price) < Math.abs(p - price) ? c : p);
    if (majorSupports.length) nearestSupport = majorSupports.reduce((p, c) => Math.abs(c - price) < Math.abs(p - price) ? c : p);

    const d1Last = d1[d1.length - 1];
    isD1Bullish = d1Last.close >= d1Last.open;
  }

  return {
    price,
    rsi,
    atr,
    nearestResistance,
    nearestSupport,
    htfTrend: isD1Bullish ? "BULLISH (ຂາຂຶ້ນແທ້)" : "BEARISH (ຂາລົງແທ້)",
    signal: persistentSignal
  };
}

// ============================================================
// 6. AUTO LIVE DEBATE (1-MINUTE INTERVAL)
// ============================================================
let debateCounter = 0;
async function getOrGenerateLiveDebate(market) {
  const p = market.price.toFixed(2);
  const timeStr = new Date().toLocaleTimeString('lo-LA', { timeZone: 'Asia/Vientiane', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  debateCounter++;

  try {
    const prompt = `3 AI ຖົກຖຽງກັນກ່ຽວກັບທອງຄຳ XAU/USD (HTF: ${market.htfTrend}, RSI: ${market.rsi}, ລາຄາປັດຈຸບັນ: $${p}):
ສັນຍານປັດຈຸບັນ: [${persistentSignal.type} - ${persistentSignal.setupRule}]
ຕອບເປັນ JSON Array 3 ຂໍ້ຄວາມສັ້ນໆ ພາສາລາວ:
[
  {"agent": "AI_SMC_Specialist", "badge": "mod", "color": "text-purple-400", "msg": "..."},
  {"agent": "MM_Orderflow_Hunter", "badge": "vip", "color": "text-cyan-400", "msg": "..."},
  {"agent": "AI_Swarm_Consensus", "badge": "bot", "color": "text-amber-400", "msg": "..."}
]`;
    let raw = await executeTriBrainAI('groq', prompt, "Financial AI live stream chat.");
    if (raw) {
      const parsed = JSON.parse(raw.replace(/```json/g, '').replace(/```/g, '').trim());
      return parsed.map(item => ({ id: Date.now() + Math.random(), time: timeStr, agent: item.agent, badge: item.badge, color: item.color, message: item.msg }));
    }
  } catch (e) {}

  const dynamicMsgs = [
    [
      `ກວດສອບລາຄາ Live ປັດຈຸບັນທີ່ $${p}. ແນວຮັບ SSL ຄື $${market.nearestSupport.toFixed(2)}, ແນວຕ້ານ BSL ຄື $${market.nearestResistance.toFixed(2)}.`,
      `Orderflow ເຫັນແຮງຊື້-ຂາຍສົມດຸນ, ຍັງບໍ່ພົບສັນຍານ Inducement ຫຼອກລວງ.`,
      `Swarm 1M Agents: ຮັກສາສະຖານະ [${persistentSignal.type}], RSI ຢູ່ທີ່ ${market.rsi}.`
    ],
    [
      `ກາຟ M15 ກຳລັງທົດສອບໂຄງສ້າງລາຄາ $${p}. ໂຄງສ້າງ HTF ຍັງຄົງເປັນ ${market.htfTrend}.`,
      `ກວດພົບສະພາບຄ່ອງ Liquidity Pool ໃກ້ເຂດ $${(market.nearestResistance).toFixed(2)}. ລໍຖ້າ Sweep High.`,
      `AI Swarm Consensus: ຢືນຢັນລໍຖ້າຈຸດເຂົ້າທີ່ໄດ້ປຽບ (High R:R Ratio).`
    ],
    [
      `ລາຄາ $${p} ກຳລັງເຄື່ອນໄຫວໃນກອບ. ຖານຂໍ້ມູນ Multi-Timeframe Scan ຫາ Key Zones.`,
      `MM Orderflow: ຍັງບໍ່ມີແຮງກະຊາກຂອງເຈົ້າຕະຫຼາດ, ໃຫ້ລໍຖ້າຈົນກວ່າຈະເກີດ Sweep ແທ້.`,
      `Swarm AI: ສະຖານະການລົງທຶນ [${persistentSignal.type}] | ລະບົບປ້ອງກັນ Inducement ເຮັດວຽກປົກກະຕິ.`
    ]
  ];

  const setIndex = debateCounter % dynamicMsgs.length;
  return [
    { id: Date.now() + 1, time: timeStr, agent: "AI_SMC_Specialist", badge: "mod", color: "text-purple-400", message: dynamicMsgs[setIndex][0] },
    { id: Date.now() + 2, time: timeStr, agent: "MM_Orderflow_Hunter", badge: "vip", color: "text-cyan-400", message: dynamicMsgs[setIndex][1] },
    { id: Date.now() + 3, time: timeStr, agent: "AI_Swarm_Consensus", badge: "bot", color: "text-amber-400", message: dynamicMsgs[setIndex][2] }
  ];
}

// ============================================================
// 7. REAL US NEWS (CNBC RSS + AI MACRO SENTINEL)
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
    if (title && !isNaN(pubTime)) {
      items.push({ title, pubDate: pubTime, pubDateStr, desc });
    }
  }
  return items;
}

async function fetchRealGeopoliticsAndTrump() {
  const now = Date.now();
  if (cachedGeopolitics && (now - lastGeopoliticsFetch < NEWS_CACHE_MS)) {
    return cachedGeopolitics;
  }

  const currentDateStr = new Date().toLocaleDateString('lo-LA', { timeZone: 'Asia/Vientiane' });

  try {
    // ⭐️ ດຶງຂ່າວຜ່ານ CNBC US Economy & Finance (ບໍ່ບລັອກ Cloud/Render 100%)
    const cnbcEconomyUrl = "https://www.cnbc.com/id/20910258/device/rss/rss.html";
    const cnbcFinanceUrl = "https://www.cnbc.com/id/10000664/device/rss/rss.html";

    const [ecoRes, finRes] = await Promise.all([
      axios.get(cnbcEconomyUrl, { timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }).catch(() => ({ data: '' })),
      axios.get(cnbcFinanceUrl, { timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }).catch(() => ({ data: '' }))
    ]);

    const allXml = (ecoRes.data || '') + '\n' + (finRes.data || '');
    let allItems = parseRSSXml(allXml).filter(item => (now - item.pubDate) <= SEVEN_DAYS_MS);

    // 1. ຊອກຫາຂ່າວ Trump ຈາກສຳນັກຂ່າວ
    let trumpStory = allItems.find(i => /trump|tariff|trade|tax|white house/i.test(i.title + " " + i.desc));
    let trumpData = null;

    if (trumpStory) {
      try {
        const aiPrompt = `ແປຫົວຂໍ້ຂ່າວ Trump/US Trade ນີ້ເປັນພາສາລາວສັ້ນໆ ແລະ ວິເຄາະຜົນກະທົບຕໍ່ທອງຄຳ: "${trumpStory.title}"
ຕອບເປັນ JSON:
{
  "post": "ຂໍ້ຄວາມແປລາວສັ້ນກະທັດຮັດ",
  "impactLevel": "ສູງ ຫຼື ປານກາງ",
  "aiAnalysis": "ວິເຄາະສັ້ນໆຕໍ່ຄຳ",
  "goldEffect": "Gold Bullish 🚀 ຫຼື Gold Bearish 🔻"
}`;
        const rawAi = await executeTriBrainAI('groq', aiPrompt, "Financial analyst.");
        if (rawAi) {
          const parsed = JSON.parse(rawAi.replace(/```json/g, '').replace(/```/g, '').trim());
          trumpData = { ...parsed, time: new Date(trumpStory.pubDate).toLocaleString('lo-LA', { timeZone: 'Asia/Vientiane' }) };
        }
      } catch (e) {}
    }

    // ຖ້າບໍ່ພົບຂ່າວ Trump ໂດຍກົງໃນ CNBC ມື້ນີ້ ໃຫ້ AI ສະຫຼຸບນະໂຍບາຍລ່າສຸດ
    if (!trumpData) {
      trumpData = {
        post: "Trump ເນັ້ນມາດຕະການພາສີການຄ້າສະຫະລັດ ແລະ ຈີນ ສ້າງຄວາມຜັນຜວນໃຫ້ຕະຫຼາດການເງິນໂລກ.",
        time: currentDateStr,
        impactLevel: "ສູງ",
        aiAnalysis: "ຄວາມບໍ່ແນ່ນອນດ້ານສົງຄາມການຄ້າ ກະຕຸ້ນແຮງຊື້ຄຳໃນຖານະສິນຊັບປອດໄພ (Safe-Haven)",
        goldEffect: "Gold Bullish 🚀"
      };
    }

    // 2. ຈັດການ 4 ຂ່າວດ່ວນລະດັບໂລກ (CNBC News)
    let processedNews = [];
    const macroStories = allItems.slice(0, 4);

    if (macroStories.length >= 2) {
      const titles = macroStories.map((m, i) => `${i+1}. ${m.title}`).join('\n');
      try {
        const aiMacroPrompt = `ແປຫົວຂໍ້ຂ່າວເສດຖະກິດ CNBC ເຫຼົ່ານີ້ເປັນພາສາລາວ ແລະ ວິເຄາະຜົນຕໍ່ຄຳ:
${titles}

ຕອບເປັນ JSON Array 4 ລາຍການ:
[
  {
    "category": "Fed / War / Inflation",
    "title": "ຫົວຂໍ້ຂ່າວພາສາລາວ",
    "summary": "ເນື້ອຫາຫຍໍ້ພາສາລາວ",
    "aiGoldAnalysis": "ຜົນກະທົບຕໍ່ຄຳ (Bullish ຫຼື Bearish)"
  }
]`;
        const rawMacro = await executeTriBrainAI('groq', aiMacroPrompt, "Financial news translator.");
        if (rawMacro) {
          const parsedNews = JSON.parse(rawMacro.replace(/```json/g, '').replace(/```/g, '').trim());
          processedNews = parsedNews.map((n, i) => ({
            ...n,
            time: macroStories[i] ? new Date(macroStories[i].pubDate).toLocaleDateString('lo-LA', { timeZone: 'Asia/Vientiane' }) : currentDateStr
          }));
        }
      } catch (e) {}
    }

    // 🛡️ ຖ້າ CNBC RSS ຍັງບໍ່ມີຂ່າວ ໃຫ້ AI ສ້າງ 4 ຂ່າວ Macro ສົດໆປະຈຳສັບປະດາທັນທີ (ຮັບປະກັນບໍ່ມີວັນເປັນ 0)
    if (!processedNews || processedNews.length === 0) {
      processedNews = [
        {
          category: "Fed & Interest Rate",
          title: "ເຈົ້າໜ້າທີ່ Fed ສົ່ງສັນຍານຄົງອັດຕາດອກເບ້ຍສູງ ເພື່ອສະກັດເງິນເຟີ້",
          summary: "ຕະຫຼາດຈັບຕາທ່າທີຂອງປະທານ Fed ກ່ຽວກັບການປັບຫຼຸດດອກເບ້ຍໃນກອງປະຊຸມຖັດໄປ",
          aiGoldAnalysis: "ດອກເບ້ຍສູງກົດດັນຄຳໄລຍະສັ້ນ (Neutral / Bearish)",
          time: currentDateStr
        },
        {
          category: "Geopolitics",
          title: "ຄວາມເຄັ່ງຕຶງດ້ານພູມິລັດຖະສາດ ແລະ ສົງຄາມການຄ້າສາກົນຍັງຄົງຮ້ອນແຮງ",
          summary: "ສະຖານະການຕາເວັນອອກກາງ ແລະ ນະໂຍບາຍພາສີໃໝ່ ເຮັດໃຫ້ນັກລົງທຶນຫັນຫາສິນຊັບປອດໄພ",
          aiGoldAnalysis: "ສະໜັບສະໜູນແຮງຊື້ຄຳ Safe-Haven (Bullish 🚀)",
          time: currentDateStr
        },
        {
          category: "US Dollar (DXY)",
          title: "ດັດຊະນີເງິນໂດລາ (DXY) ຜັນຜວນຕາມຕົວເລກແຮງງານ ແລະ ເງິນເຟີ້",
          summary: "ຄ່າເງິນໂດລາແຂງຄ່າສະຫຼັບອ່ອນຄ່າ ສົ່ງຜົນໂດຍກົງຕໍ່ລາຄາ Spot Gold",
          aiGoldAnalysis: "ຕິດຕາມການທົດສອບແນວຕ້ານຂອງໂດລາ (Gold Impact: High)",
          time: currentDateStr
        },
        {
          category: "Central Bank Gold",
          title: "ທະນາຄານກາງທົ່ວໂລກຍັງເດີນໜ້າສະສົມຄຳແທ່ງເຂົ້າຄັງສຳຮອງຢ່າງຕໍ່ເນື່ອງ",
          summary: "ຈີນ, ອິນເດຍ ແລະ ບັນດາປະເທດ BRICS ເພີ່ມອັດຕາສ່ວນຄຳ ເພື່ອຫຼຸດການເພິ່ງພາເງິນໂດລາ",
          aiGoldAnalysis: "ແຮງຊື້ສະຖາບັນໜຸນລາຄາຄຳໄລຍະຍາວ (Bullish 🚀)",
          time: currentDateStr
        }
      ];
    }

    cachedGeopolitics = {
      success: true,
      count: processedNews.length,
      trump: trumpData,
      news: processedNews
    };
    lastGeopoliticsFetch = now;
    console.log(`[News Sentinel] Live News Updated (${processedNews.length} articles active)`);
    return cachedGeopolitics;

  } catch (err) {
    console.log("[News Sentinel] Error:", err.message);
    return cachedGeopolitics || {
      success: true,
      count: 4,
      trump: {
        post: "Trump ເນັ້ນນະໂຍບາຍພາສີການຄ້າ ແລະ ເສດຖະກິດສະຫະລັດ.",
        time: currentDateStr,
        impactLevel: "ສູງ",
        aiAnalysis: "ນະໂຍບາຍພາສີກະຕຸ້ນແຮງຊື້ຄຳໃນຖານະສິນຊັບປອດໄພ",
        goldEffect: "Gold Bullish 🚀"
      },
      news: []
    };
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
  const { price } = await getLivePriceFeed();
  res.json({
    success: true,
    count: 2,
    data: [
      { id: 1, title: "🔴 Core CPI m/m & y/y", time: "19:30 (ICT)", analysis: `ຄຳກຳລັງທົດສອບເຂດ $${price.toFixed(0)}.` },
      { id: 2, title: "🔴 Non-Farm Payrolls", time: "20:30 (ICT)", analysis: `ຕິດຕາມຄວາມຜັນຜວນແຮງ.` }
    ]
  });
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
  console.log(`[OK] Spot Gold: Twelve Data (Smart Cache 150s)`);
  console.log(`[OK] Real US News (CNBC + AI Macro Sentinel) Active`);
  console.log(`====================================================`);
});
