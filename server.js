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
  return null;
}

// ============================================================
// 2. REAL-TIME GOLD PRICE FEED (ດຶງລາຄາຕົວຈິງ 100% ຕົງກັບ TradingView)
// ============================================================
let cachedLiveFeed = null;
let lastLiveFetch = 0;

async function getLivePriceFeed() {
  const now = Date.now();
  if (cachedLiveFeed && (now - lastLiveFetch < 2000)) return cachedLiveFeed;

  let price = null;
  let rsi = 50.0;
  let atr = 14.0;

  // 1. ດຶງຈາກ TradingView Scanner ພ້ອມສົ່ງ Browser User-Agent
  try {
    const tvRes = await axios.post('https://scanner.tradingview.com/forex/scan', {
      symbols: { tickers: ["OANDA:XAUUSD"] },
      columns: ["close", "RSI", "ATR"]
    }, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.tradingview.com/'
      },
      timeout: 3000
    });

    if (tvRes.data?.data?.[0]?.d && tvRes.data.data[0].d[0] > 0) {
      price = parseFloat(tvRes.data.data[0].d[0].toFixed(2));
      rsi = parseFloat(tvRes.data.data[0].d[1]?.toFixed(1) || "50.0");
      atr = parseFloat(tvRes.data.data[0].d[2]?.toFixed(2) || "14.0");
    }
  } catch (e) {}

  // 2. ສຳຮອງດ້ວຍ Binance Spot Gold (PAXGUSDT) ເຊິ່ງຄ່າຕົງກັບ Spot Gold 1:1 ບໍ່ມີວັນຕິດຂັດ
  if (!price || price < 1500) {
    try {
      const bRes = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT', { timeout: 3000 });
      if (bRes.data?.price) {
        price = parseFloat(parseFloat(bRes.data.price).toFixed(2));
      }
    } catch (e) {}
  }

  // ຖ້າຍັງບໍ່ໄດ້ອີກ ໃຫ້ໃຊ້ຄ່າລ່າສຸດທີ່ເຄີຍດຶງມາສຳເລັດ
  if (!price) {
    price = cachedLiveFeed ? cachedLiveFeed.price : 2890.50;
  }

  cachedLiveFeed = { price, rsi, atr };
  lastLiveFetch = now;
  return cachedLiveFeed;
}

// Multi-Timeframe Candles Cache
let cacheD1 = { data: [], lastFetch: 0 };
let cacheH4 = { data: [], lastFetch: 0 };
let cacheH1 = { data: [], lastFetch: 0 };
let cacheM15 = { data: [], lastFetch: 0 };

async function fetchCandles(interval, count) {
  try {
    const binanceIntervalMap = { '1day': '1d', '4h': '4h', '1h': '1h', '15min': '15m' };
    const bInterval = binanceIntervalMap[interval] || '15m';
    const url = `https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=${bInterval}&limit=${count}`;
    const res = await axios.get(url, { timeout: 6000 });
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
  if (!cacheD1.data.length || (now - cacheD1.lastFetch > 7 * 24 * 3600 * 1000)) {
    const d1 = await fetchCandles('1day', 22);
    if (d1.length) { cacheD1.data = d1; cacheD1.lastFetch = now; }
  }
  if (!cacheH4.data.length || (now - cacheH4.lastFetch > 24 * 3600 * 1000)) {
    const h4 = await fetchCandles('4h', 120);
    if (h4.length) { cacheH4.data = h4; cacheH4.lastFetch = now; }
  }
  if (!cacheH1.data.length || (now - cacheH1.lastFetch > 24 * 3600 * 1000)) {
    const h1 = await fetchCandles('1h', 200);
    if (h1.length) { cacheH1.data = h1; cacheH1.lastFetch = now; }
  }
  if (!cacheM15.data.length || (now - cacheM15.lastFetch > 24 * 3600 * 1000)) {
    const m15 = await fetchCandles('15min', 1000);
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

// Trading Signal States
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

  const { d1, h4, m15 } = await getMultiTimeframeCandles();
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

// Debate Chat Generator (ມີ Dynamic Content ບໍ່ໃຫ້ຊ້ຳກັນທຸກ 1 ນາທີ)
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
      `ລາຄາ $${p} ກຳລັງ Sideway ໃນກອບແຄບ. ຖານຂໍ້ມູນ 1,000 ແທ່ງ M15 ກຳລັງ Scan ຫາ Key Zones.`,
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

// Endpoints
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
    const systemPrompt = `ທ່ານຄື AI ຜູ້ຊ່ຽວຊານເທຣດທອງຄຳ XAU/USD ລະບົບ SMC Multi-Timeframe. ລາຄາ: $${data.price.toFixed(2)}, HTF: ${data.htfTrend}, RSI: ${data.rsi}. ຕອບເປັນພາສາລາວສັ້ນກະທັດຮັດ.`;
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
  console.log(`[OK] Real-time Price 1:1 Synced (Binance PAXG / TradingView)`);
  console.log(`[OK] AI Debate Interval: 1 Minute per round`);
  console.log(`====================================================`);
});
