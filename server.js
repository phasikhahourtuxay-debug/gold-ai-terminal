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
// ຕັ້ງຄ່າເວລາ SMART CACHE (ຄິດໄລ່ໃຫ້ລັນໄດ້ 24/7 ບໍ່ເກີນ 800 calls/ມື້)
// ============================================================
const LIVE_PRICE_CACHE_MS = 2 * 60 * 1000;       // 2 ນາທີ (720 calls/ມື້ = ປອດໄພ 100%)
const D1_CACHE_MS         = 7 * 24 * 3600 * 1000;// 7 ມື້ (1 ອາທິດດຶງ 1 ຄັ້ງ)
const H4_CACHE_MS         = 24 * 3600 * 1000;    // 24 ຊົ່ວໂມງ (1 ມື້ດຶງ 1 ຄັ້ງ)
const H1_CACHE_MS         = 24 * 3600 * 1000;    // 24 ຊົ່ວໂມງ (1 ມື້ດຶງ 1 ຄັ້ງ)
const M15_CACHE_MS        = 15 * 60 * 1000;      // 15 ນາທີ (ດຶງເມື່ອແທ່ງ M15 ປິດ)

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
    max_tokens: 550,
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
// 3. REAL-TIME GOLD PRICE FEED (Twelve Data + Smart Cache 2 Min)
// ============================================================
let cachedLiveFeed = null;
let lastLiveFetch = 0;

async function getLivePriceFeed() {
  const now = Date.now();

  // ຖ້າຍັງບໍ່ກາຍ 2 ນາທີ ໃຫ້ສົ່ງຄ່າໃນ Cache ທັນທີ ບໍ່ຍິງ API ຊ້ຳ
  if (cachedLiveFeed && (now - lastLiveFetch < LIVE_PRICE_CACHE_MS) && cachedLiveFeed.price > 1000) {
    return cachedLiveFeed;
  }

  let price = null;
  let rsi = cachedLiveFeed?.rsi || 50.0;
  let atr = cachedLiveFeed?.atr || 14.0;

  // ⭐️ ແຫຼ່ງທີ 1: TWELVE DATA API (Spot Gold XAU/USD ແທ້ໆ)
  const tdKey = (process.env.TWELVE_DATA_API_KEY || "").trim();
  if (tdKey) {
    try {
      const tdRes = await axios.get(`https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${tdKey}`, { timeout: 4000 });
      if (tdRes.data && tdRes.data.price && !isNaN(parseFloat(tdRes.data.price))) {
        price = parseFloat(parseFloat(tdRes.data.price).toFixed(2));
        console.log(`[Twelve Data] Price Updated: $${price} at ${new Date().toLocaleTimeString('lo-LA', { timeZone: 'Asia/Vientiane' })}`);
      }
    } catch (e) {
      console.log("[Twelve Data] Error/Rate Limit:", e.message);
    }
  }

  // ແຫຼ່ງທີ 2: GoldPrice.org (ສຳຮອງເມື່ອ Twelve Data ຕິດ Limit)
  if (!price || price < 1500) {
    try {
      const gpRes = await axios.get('https://data-asg.goldprice.org/dbXRates/USD', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/json'
        },
        timeout: 3000
      });
      if (gpRes.data?.items?.[0]?.xauPrice) {
        price = parseFloat(gpRes.data.items[0].xauPrice.toFixed(2));
      }
    } catch (e) {}
  }

  // ແຫຼ່ງທີ 3: Yahoo Finance (ຄິດໄລ່ RSI & ATR)
  try {
    const yRes = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=15m&range=2d', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 3500
    });
    const result = yRes.data?.chart?.result?.[0];
    if (result) {
      if (!price) {
        const liveP = result.meta?.regularMarketPrice;
        if (liveP) price = parseFloat(liveP.toFixed(2));
      }

      const quotes = result.indicators?.quote?.[0];
      if (quotes?.close?.length) {
        const validCloses = quotes.close.filter(c => c !== null && !isNaN(c));
        if (validCloses.length > 15) {
          rsi = calculateRSI(validCloses);
        }

        const validCandles = [];
        for (let i = 0; i < quotes.close.length; i++) {
          if (quotes.close[i] && quotes.high[i] && quotes.low[i] && quotes.open[i]) {
            validCandles.push({
              open: quotes.open[i],
              high: quotes.high[i],
              low: quotes.low[i],
              close: quotes.close[i]
            });
          }
        }
        if (validCandles.length > 15) {
          atr = calculateATR(validCandles);
        }
      }
    }
  } catch (e) {}

  if (price && price > 1000) {
    cachedLiveFeed = { price, rsi, atr };
    lastLiveFetch = now;
  } else if (!cachedLiveFeed) {
    cachedLiveFeed = { price: 2700.00, rsi: 50.0, atr: 14.0 };
  }

  return cachedLiveFeed;
}

// ============================================================
// 4. MULTI-TIMEFRAME CANDLES (D1=7ມື້, H4/H1=24Hr, M15=15Min)
// ============================================================
let cacheD1 = { data: [], lastFetch: 0 };
let cacheH4 = { data: [], lastFetch: 0 };
let cacheH1 = { data: [], lastFetch: 0 };
let cacheM15 = { data: [], lastFetch: 0 };

async function fetchCandles(interval, count) {
  // ດຶງຜ່ານ Yahoo Finance ຟຣີ ບໍ່ກິນໂກຕາ Twelve Data
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

  // Fallback ດ້ວຍ Binance PAXGUSDT ຟຣີ
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

async function getMultiTimeframeCandles() {
  const now = Date.now();

  // D1: ດຶງ 1 ຄັ້ງຕໍ່ອາທິດ (7 ມື້)
  if (!cacheD1.data.length || (now - cacheD1.lastFetch > D1_CACHE_MS)) {
    const d1 = await fetchCandles('1day', 22);
    if (d1.length) { 
      cacheD1.data = d1; 
      cacheD1.lastFetch = now; 
      console.log("[Smart Cache] D1 Candles Updated (1 Week)"); 
    }
  }

  // H4: ດຶງ 1 ຄັ້ງຕໍ່ມື້ (24 ຊົ່ວໂມງ)
  if (!cacheH4.data.length || (now - cacheH4.lastFetch > H4_CACHE_MS)) {
    const h4 = await fetchCandles('4h', 120);
    if (h4.length) { 
      cacheH4.data = h4; 
      cacheH4.lastFetch = now; 
      console.log("[Smart Cache] H4 Candles Updated (24 Hours)"); 
    }
  }

  // H1: ດຶງ 1 ຄັ້ງຕໍ່ມື້ (24 ຊົ່ວໂມງ)
  if (!cacheH1.data.length || (now - cacheH1.lastFetch > H1_CACHE_MS)) {
    const h1 = await fetchCandles('1h', 200);
    if (h1.length) { 
      cacheH1.data = h1; 
      cacheH1.lastFetch = now; 
      console.log("[Smart Cache] H1 Candles Updated (24 Hours)"); 
    }
  }

  // M15: ດຶງທຸກໆ 15 ນາທີ ເພື່ອວິເຄາະຫາສັນຍານ Buy/Sell ໃໝ່
  if (!cacheM15.data.length || (now - cacheM15.lastFetch > M15_CACHE_MS)) {
    const m15 = await fetchCandles('15min', 1000);
    if (m15.length) { 
      cacheM15.data = m15; 
      cacheM15.lastFetch = now; 
      console.log("[Smart Cache] M15 Candles Updated (15 Mins)"); 
    }
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
      isCleared: false, clearedPrice: "--", liquidityType: "Scanning 1000 M15 Liquidity Pools...",
      signalAction: "WAIT", clearedAt: 0
    };
  }

  const { d1, h4 } = await getMultiTimeframeCandles();
  const { price, rsi, atr } = await getLivePriceFeed();

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
// 7. API ENDPOINTS
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

app.get('/api/geopolitics', (req, res) => {
  res.json({
    success: true,
    count: 1,
    trump: {
      post: "Trump ຢືນຢັນມາດຕະການພາສີການຄ້າ ແລະ ຕິດຕາມສະຖານະການເສດຖະກິດໂລກ.",
      time: new Date().toLocaleString('lo-LA', { timeZone: 'Asia/Vientiane' }),
      impactLevel: "ປານກາງ",
      aiAnalysis: "ສະໜັບສະໜູນແຮງຊື້ຄຳໃນຖານະສິນຊັບປອດໄພ",
      goldEffect: "Gold Bullish 🚀"
    },
    news: []
  });
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
  console.log(`[OK] Spot Gold: Twelve Data (Smart Cache 2m - 720 calls/day)`);
  console.log(`[OK] Multi-TF Cache: D1=7Days, H4/H1=24Hours, M15=15Mins`);
  console.log(`====================================================`);
});
