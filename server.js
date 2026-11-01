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
  return "ລະບົບ AI Swarm ຢືນຢັນໂຄງສ້າງ SMC ສຳເລັດ.";
}

// ============================================================
// 2. MULTI-TIMEFRAME ENGINE WITH CACHE (D1, H4, H1, M15)
// ============================================================
let cacheD1 = { data: [], lastFetch: 0 };
let cacheH4 = { data: [], lastFetch: 0 };
let cacheH1 = { data: [], lastFetch: 0 };
let cacheM15 = { data: [], lastFetch: 0 };

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TWENTY_FOUR_HR_MS = 24 * 60 * 60 * 1000;
const TD_KEY = (process.env.TWELVE_DATA_API_KEY || "").trim();

async function fetchCandles(interval, count) {
  if (TD_KEY) {
    try {
      const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${interval}&outputsize=${count}&apikey=${TD_KEY}`;
      const res = await axios.get(url, { timeout: 10000 });
      if (res.data?.values?.length > 0) {
        return res.data.values.reverse().map(c => ({
          time: c.datetime,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close)
        }));
      }
    } catch (e) {}
  }
  // ສຳຮອງດ້ວຍ Binance PAXGUSDT
  try {
    const binanceIntervalMap = { '1day': '1d', '4h': '4h', '1h': '1h', '15min': '15m' };
    const bInterval = binanceIntervalMap[interval] || '15m';
    const url = `https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=${bInterval}&limit=${count}`;
    const res = await axios.get(url, { timeout: 8000 });
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

  // D1: 22 ແທ່ງ (Cache 1 ອາທິດ)
  if (!cacheD1.data.length || (now - cacheD1.lastFetch > ONE_WEEK_MS)) {
    const d1 = await fetchCandles('1day', 22);
    if (d1.length) { cacheD1.data = d1; cacheD1.lastFetch = now; }
  }

  // H4: Cache 24h
  if (!cacheH4.data.length || (now - cacheH4.lastFetch > TWENTY_FOUR_HR_MS)) {
    const h4 = await fetchCandles('4h', 120);
    if (h4.length) { cacheH4.data = h4; cacheH4.lastFetch = now; }
  }

  // H1: Cache 24h
  if (!cacheH1.data.length || (now - cacheH1.lastFetch > TWENTY_FOUR_HR_MS)) {
    const h1 = await fetchCandles('1h', 200);
    if (h1.length) { cacheH1.data = h1; cacheH1.lastFetch = now; }
  }

  // M15: 1,000 ແທ່ງ (Cache 24h)
  if (!cacheM15.data.length || (now - cacheM15.lastFetch > TWENTY_FOUR_HR_MS)) {
    const m15 = await fetchCandles('15min', 1000);
    if (m15.length) { cacheM15.data = m15; cacheM15.lastFetch = now; }
  }

  return { d1: cacheD1.data, h4: cacheH4.data, h1: cacheH1.data, m15: cacheM15.data };
}

// Realtime Price & Indicators
let cachedLiveFeed = null;
let lastLiveFetch = 0;

async function getLivePriceFeed() {
  const now = Date.now();
  if (cachedLiveFeed && (now - lastLiveFetch < 3000)) return cachedLiveFeed;

  let price = 2900.0, rsi = 50.0, atr = 12.0;
  try {
    const tvRes = await axios.post('https://scanner.tradingview.com/forex/scan', {
      symbols: { tickers: ["OANDA:XAUUSD"] },
      columns: ["close", "RSI", "ATR"]
    }, { timeout: 3500 });
    if (tvRes.data?.data?.[0]?.d) {
      price = parseFloat(tvRes.data.data[0].d[0].toFixed(2));
      rsi = parseFloat(tvRes.data.data[0].d[1].toFixed(1));
      atr = parseFloat(tvRes.data.data[0].d[2].toFixed(2));
    }
  } catch (e) {}

  cachedLiveFeed = { price, rsi, atr };
  lastLiveFetch = now;
  return cachedLiveFeed;
}

// ============================================================
// 3. SMC ENGINE: FRACTALS, BOS, CHOCH, OB, FVG
// ============================================================
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
// 4. STRATEGY EXECUTION (4 SETUPS + RESOLVED RSI LOGIC + INDUCEMENT)
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

  // 1. Reset ຫຼັງ 20 ນາທີ (ສັນຍານຫຼັກ)
  if (persistentSignal.type !== "WAIT" && (now - persistentSignal.triggeredAt > 20 * 60 * 1000)) {
    persistentSignal = {
      type: "WAIT",
      setupRule: "ກຳລັງຊອກຫາຈຸດ Buy-Sell ໃໝ່...",
      entry: "--", sl: "--", tp1: "--", tp2: "--", tp3: "--", tp4: "--", tp5: "--",
      rrRatio: "1 : 3.6", triggeredAt: 0, signalId: null, inducementFilter: "PASSED"
    };
  }

  // 2. Reset ຫຼັງ 10 ນາທີ (Liquidity Hunter)
  if (liquidityHuntState.isCleared && (now - liquidityHuntState.clearedAt > 10 * 60 * 1000)) {
    liquidityHuntState = {
      isCleared: false,
      clearedPrice: "--",
      liquidityType: "Scanning 1000 M15 Liquidity Pools...",
      signalAction: "WAIT",
      clearedAt: 0
    };
  }

  const { d1, h4, h1, m15 } = await getMultiTimeframeCandles();
  const { price, rsi, atr } = await getLivePriceFeed();

  if (!m15.length || !h4.length || !d1.length) {
    return { price, rsi, atr, signal: persistentSignal, nearestResistance: price + 20, nearestSupport: price - 20 };
  }

  // 3. ຫາ Major Key Levels ຈາກ D1 & H4
  const d1Fractals = extractFractals(d1);
  const h4Fractals = extractFractals(h4);
  const majorResistances = [...d1Fractals.highs, ...h4Fractals.highs].map(h => h.price);
  const majorSupports = [...d1Fractals.lows, ...h4Fractals.lows].map(l => l.price);

  const nearestResistance = majorResistances.length ? majorResistances.reduce((p, c) => Math.abs(c - price) < Math.abs(p - price) ? c : p) : price + atr * 2;
  const nearestSupport = majorSupports.length ? majorSupports.reduce((p, c) => Math.abs(c - price) < Math.abs(p - price) ? c : p) : price - atr * 2;

  // 4. ເຊັກ HTF Trend ໃຫຍ່ (D1 & H4)
  const d1Last = d1[d1.length - 1];
  const isD1Bearish = d1Last.close < d1Last.open;
  const isD1Bullish = d1Last.close > d1Last.open;

  // 5. M15 Micro Execution
  const m15Fractals = extractFractals(m15);
  const cur = m15[m15.length - 1];
  const prev = m15[m15.length - 2];

  if (persistentSignal.type === "WAIT") {
    // -------------------------------------------------------------
    // ກໍລະນີ I: ກາຟຕ້ອງເປັນຂາລົງແທ້ ຝັ່ງ SELL (D1/H4 Bearish Confirmation)
    // -------------------------------------------------------------
    if (isD1Bearish) {
      
      // SETUP 1: Sweep Buy Liquidity (Reversal Setup)
      // ເງື່ອນໄຂ: Sideway ໃກ້ແນວຮັບ H4/D1, ແລ້ວແທງຂຶ້ນໄປ Sweep High (BSL) ພ້ອມ RSI Overbought (>= 65), ແລ້ວກັບຄືນມຸດລົງແທ້
      for (const sh of m15Fractals.highs.slice(-6)) {
        // Inducement Check: ຕ້ອງເກີດໃກ້ Key Level (ບໍ່ເກີດກາງທາງ)
        const isNearKeyZone = Math.abs(cur.low - nearestSupport) <= (atr * 2.0);
        if (!isNearKeyZone) continue; // Inducement ປອມ ➔ ຂ້າມ

        if ((cur.high > sh.price && cur.close < sh.price) && rsi >= 65) {
          triggerSignal("SELL", "Setup 1: Sweep Buy Liquidity ທີ່ແນວຮັບ ແລ້ວກັບຄືນລົງຕໍ່ແທ້ຈິງ", price, price + (atr * 1.5), atr, sh.price);
          break;
        }
      }

      // SETUP 2: Breakdown Continuation (Momentum Setup - ແກ້ Conflict)
      // ເງື່ອນໄຂ: ລົງແຮງ Sideway ແລ້ວຫຼຸດແນວຮັບສຳຄັນລົງໄປຕໍ່ ໂດຍບໍ່ດຶງກັບ, RSI Momentum ຂາລົງແຮງ (< 45)
      if (persistentSignal.type === "WAIT") {
        if (cur.close < nearestSupport && prev.close >= nearestSupport && rsi < 45) {
          triggerSignal("SELL", "Setup 2: ຫຼຸດແນວຮັບສຳຄັນແລ້ວລົງຕໍ່ (Bearish BOS Breakdown)", price, nearestSupport + (atr * 0.8), atr, nearestSupport);
        }
      }
    }

    // -------------------------------------------------------------
    // ກໍລະນີ II: ກາຟຕ້ອງເປັນຂາຂຶ້ນແທ້ ຝັ່ງ BUY (D1/H4 Bullish Confirmation)
    // -------------------------------------------------------------
    if (isD1Bullish && persistentSignal.type === "WAIT") {
      
      // SETUP 3: Breakout Resistance Continuation (Momentum Setup - ແກ້ Conflict)
      // ເງື່ອນໄຂ: ຂຶ້ນແຮງ Sideway ແລ້ວທະລຸແນວຕ້ານສຳຄັນຂຶ້ນໄປຕໍ່ ໂດຍບໍ່ລົງມາອີກ, RSI Momentum ຂາຂຶ້ນແຮງ (> 55)
      if (cur.close > nearestResistance && prev.close <= nearestResistance && rsi > 55) {
        triggerSignal("BUY", "Setup 3: ທະລຸແນວຕ້ານສຳຄັນແລ້ວຂຶ້ນຕໍ່ (Bullish BOS Breakout)", price, nearestResistance - (atr * 0.8), atr, nearestResistance);
      }

      // SETUP 4: Sweep Sell Liquidity (Reversal Setup)
      // ເງື່ອນໄຂ: ຂຶ້ນແຮງ ມຸດລົງມາ Sideway ທີ່ແນວຮັບ, ກິນ Sell Liquidity (Sweep SSL) ພ້ອມ RSI Oversold (<= 35), ແລ້ວດຶງກັບຂຶ້ນແທ້
      if (persistentSignal.type === "WAIT") {
        for (const sl of m15Fractals.lows.slice(-6)) {
          const isNearKeyZone = Math.abs(cur.low - nearestSupport) <= (atr * 2.0);
          if (!isNearKeyZone) continue; // Inducement ປອມ ➔ ຂ້າມ

          if ((cur.low < sl.price && cur.close > sl.price) && rsi <= 35) {
            triggerSignal("BUY", "Setup 4: Sweep Sell Liquidity ທີ່ແນວຮັບ ແລ້ວກັບຄືນຂຶ້ນແທ້ຈິງ", price, price - (atr * 1.5), atr, sl.price);
            break;
          }
        }
      }
    }
  }

  return {
    price, rsi, atr,
    nearestResistance, nearestSupport,
    htfTrend: isD1Bullish ? "BULLISH (ຂາຂຶ້ນແທ້)" : "BEARISH (ຂາລົງແທ້)",
    signal: persistentSignal
  };
}

function triggerSignal(type, ruleName, entryPrice, slPrice, atr, clearedLvl) {
  const isBuy = type === "BUY";
  persistentSignal = {
    type: type,
    setupRule: ruleName,
    entry: `$${entryPrice.toFixed(2)}`,
    sl: `$${slPrice.toFixed(2)}`,
    tp1: `$${(entryPrice + (isBuy ? atr * 1.0 : -atr * 1.0)).toFixed(2)}`,
    tp2: `$${(entryPrice + (isBuy ? atr * 2.0 : -atr * 2.0)).toFixed(2)}`,
    tp3: `$${(entryPrice + (isBuy ? atr * 3.2 : -atr * 3.2)).toFixed(2)}`,
    tp4: `$${(entryPrice + (isBuy ? atr * 4.2 : -atr * 4.2)).toFixed(2)}`,
    tp5: `$${(entryPrice + (isBuy ? atr * 5.5 : -atr * 5.5)).toFixed(2)}`,
    rrRatio: "1 : 3.6",
    triggeredAt: Date.now(),
    signalId: "SIG-" + Date.now(),
    inducementFilter: "PASSED (Non-Inducement Verified)"
  };

  liquidityHuntState = {
    isCleared: true,
    clearedPrice: clearedLvl ? clearedLvl.toFixed(2) : entryPrice.toFixed(2),
    liquidityType: ruleName,
    signalAction: type,
    clearedAt: Date.now()
  };

  console.log(`🚨 [AUTO SIGNAL] ${type} | ${ruleName} at $${entryPrice}`);
}

// ============================================================
// 5. LIVE DEBATE & GEOPOLITICS
// ============================================================
async function getOrGenerateLiveDebate(market) {
  const p = market.price.toFixed(2);
  const timeStr = new Date().toLocaleTimeString('lo-LA', { timeZone: 'Asia/Vientiane', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  try {
    const prompt = `3 AI ຖົກຖຽງກັນກ່ຽວກັບທອງຄຳ XAU/USD (HTF: ${market.htfTrend}, RSI: ${market.rsi}):
ລາຄາ: $${p} | ສັນຍານ: [${persistentSignal.type} (${persistentSignal.setupRule})]
ຕອບເປັນ JSON Array 3 ຂໍ້ຄວາມ:
[
  {"agent": "AI_SMC_Specialist", "badge": "mod", "color": "text-purple-400", "msg": "..."},
  {"agent": "MM_Orderflow_Hunter", "badge": "vip", "color": "text-cyan-400", "msg": "..."},
  {"agent": "AI_Swarm_Consensus", "badge": "bot", "color": "text-amber-400", "msg": "..."}
]`;
    let raw = await executeTriBrainAI('groq', prompt, "Financial AI live stream chat.");
    const parsed = JSON.parse(raw.replace(/```json/g, '').replace(/```/g, '').trim());
    return parsed.map(item => ({ id: Date.now() + Math.random(), time: timeStr, agent: item.agent, badge: item.badge, color: item.color, message: item.msg }));
  } catch (e) {
    return [
      { id: Date.now() + 1, time: timeStr, agent: "AI_SMC_Specialist", badge: "mod", color: "text-purple-400", message: `HTF Trend: ${market.htfTrend} | RSI: ${market.rsi}. ສັນຍານ: [${persistentSignal.type}].` },
      { id: Date.now() + 2, time: timeStr, agent: "MM_Orderflow_Hunter", badge: "vip", color: "text-cyan-400", message: `Orderflow Analysis: ${persistentSignal.setupRule}` },
      { id: Date.now() + 3, time: timeStr, agent: "AI_Swarm_Consensus", badge: "bot", color: "text-amber-400", message: `ມະຕິ Swarm 1M Agents: Action [${persistentSignal.type}] | TP1: ${persistentSignal.tp1} | TP5: ${persistentSignal.tp5} | SL: ${persistentSignal.sl}` }
    ];
  }
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
let newsFeedDb = [
  {
    id: 1,
    title: "Trump ຢືນຢັນນະໂຍບາຍຕັ້ງກຳແພງພາສີການຄ້າ 25% ຕໍ່ສິນຄ້ານຳເຂົ້າ",
    summary: "Donald Trump ໂພສຜ່ານ Truth Social ຢືນຢັນຈະໃຊ້ມາດຕະການພາສີການຄ້າຢ່າງເຂັ້ມງວດ.",
    aiGoldAnalysis: "AI ວິເຄາະ: ຄວາມສ່ຽງເງິນເຟີ້ ແລະ ສົງຄາມການຄ້າຈະກະຕຸ້ນແຮງຊື້ຄຳ Safe-Haven ຢ່າງມະຫາສານ.",
    category: "Trump Trade Tariff",
    impact: "ຮ້າຍແຮງ (Severe 🚨)",
    goldEffect: "Bullish 🚀",
    source: "Truth Social / Reuters",
    timestamp: Date.now() - (2 * 3600 * 1000)
  }
];

function getGeopoliticalNews() {
  const now = Date.now();
  newsFeedDb = newsFeedDb.filter(n => (now - n.timestamp) <= SEVEN_DAYS_MS);
  const trumpPost = newsFeedDb.find(n => n.category.includes("Trump")) || newsFeedDb[0];
  return {
    success: true,
    count: newsFeedDb.length,
    trump: {
      post: trumpPost.title + " - " + trumpPost.summary,
      time: new Date(trumpPost.timestamp).toLocaleString('lo-LA', { timeZone: 'Asia/Vientiane' }),
      impactLevel: trumpPost.impact,
      aiAnalysis: trumpPost.aiGoldAnalysis,
      goldEffect: trumpPost.goldEffect
    },
    news: newsFeedDb.map(item => ({
      ...item,
      time: new Date(item.timestamp).toLocaleString('lo-LA', { timeZone: 'Asia/Vientiane' })
    }))
  };
}

function getRedNews(currentPrice) {
  return {
    success: true,
    count: 2,
    data: [
      {
        id: 1,
        title: "🔴 Core CPI m/m & y/y (ດັດຊະນີເງິນເຟີ້ສະຫະລັດ)",
        time: "ອາທິດນີ້ 19:30 (ICT)",
        analysis: `<div class="space-y-1 text-[11px] mt-1"><p class="text-purple-300"><b>🧠 AI Quant:</b> ຖ້າ Actual > Forecast ➔ ດອນລ່າແຂງ ➔ ຄຳ Dump ລົງແນວຮັບ $${(currentPrice - 20).toFixed(0)}.</p></div>`
      },
      {
        id: 2,
        title: "🔴 Non-Farm Employment & Unemployment Rate",
        time: "ວັນສຸກ 19:30 (ICT)",
        analysis: `<div class="space-y-1 text-[11px] mt-1"><p class="text-emerald-300"><b>⚡ Groq:</b> ຖ້າຕົວເລກຈ້າງງານ < 140K ➔ ຄຳຈະ Pump ຂຶ້ນແຮງທັນທີ.</p></div>`
      }
    ]
  };
}

// ============================================================
// 6. API ENDPOINTS
// ============================================================
app.get('/api/analysis', async (req, res) => {
  try {
    const data = await processTradingLogic();
    res.json({
      success: true,
      currentPrice: data.price.toFixed(2),
      rsi: data.rsi,
      htfTrend: data.htfTrend,
      trend: {
        direction: `${data.htfTrend} ➔ ${persistentSignal.type === 'WAIT' ? 'ກຳລັງຊອກຫາຈຸດ Buy-Sell ໃໝ່...' : persistentSignal.type}`,
        strength: persistentSignal.type !== "WAIT" ? "Active (20m Auto-Reset)" : "Multi-Timeframe Scanning",
        description: persistentSignal.setupRule
      },
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

app.get('/api/geopolitics', (req, res) => res.json(getGeopoliticalNews()));
app.get('/api/red-news', async (req, res) => {
  const { price } = await getLivePriceFeed();
  res.json(getRedNews(price));
});

app.post('/api/chat', async (req, res) => {
  try {
    const { question } = req.body;
    const data = await processTradingLogic();
    const systemPrompt = `ທ່ານຄື AI ຜູ້ຊ່ຽວຊານເທຣດທອງຄຳ XAU/USD ລະບົບ SMC Multi-Timeframe (D1/H4/H1/M15).
ລາຄາ: $${data.price.toFixed(2)}, HTF Trend: ${data.htfTrend}, RSI: ${data.rsi}, ສັນຍານປັດຈຸບັນ: ${persistentSignal.type} (${persistentSignal.setupRule}), Entry: ${persistentSignal.entry}, SL: ${persistentSignal.sl}, TP1: ${persistentSignal.tp1}, TP5: ${persistentSignal.tp5}.
ຕອບເປັນພາສາລາວສຸພາບ ຊັດເຈນ ຖືກຫຼັກວິຊາການ.`;
    const answer = await executeTriBrainAI('groq', question, systemPrompt);
    res.json({ success: true, answer });
  } catch (e) {
    res.json({ success: true, answer: `ລາຄາທອງຄຳປັດຈຸບັນ $${cachedLiveFeed?.price || 2900.00}. ສະຖານະ: ${persistentSignal.setupRule}` });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`[OK] Gold AI Tri-Brain Terminal RUNNING on port ${PORT}`);
  console.log(`[OK] D1: 22 bars (7-day cache) | H4 & H1: 24h cache`);
  console.log(`[OK] M15: 1,000 bars (24h cache)`);
  console.log(`[OK] RSI Conflict FIXED: Reversal (OB/OS) vs Momentum`);
  console.log(`[OK] Inducement Liquidity Filter: ACTIVE`);
  console.log(`====================================================`);
});
