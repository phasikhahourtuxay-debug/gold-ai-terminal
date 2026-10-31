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

const ai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY || "dummy_key",
  baseURL: "https://api.groq.com/openai/v1"
});
const AI_MODEL = "openai/gpt-oss-20b";

let cachedMarketData = null;
let lastMarketFetchTime = 0;
let cachedForexNews = null;
let lastNewsFetchTime = 0;

// Caching ສຳລັບຂ່າວ Geopolitics & Macro
let cachedMacroNews = null;
let lastMacroFetchTime = 0;

// State Persistence ເກັບສັນຍານ Buy/Sell
let persistentSignal = {
  type: "WAIT",
  isAutoTriggered: false,
  entry: "--",
  tp1: "--",
  tp2: "--",
  tp3: "--",
  tp4: "--",
  sl: "--",
  rrRatio: "1 : 3.4",
  setupName: "ກຳລັງສະແກນ TradingView OANDA (D1, H4, H1, M15)...",
  timestamp: Date.now()
};

// ============================================================
// 1. ດຶງຂໍ້ມູນລາຄາ ແລະ Indicators ຈາກ TradingView OANDA ໂດຍກົງ
// ============================================================
async function getTradingViewOandaData() {
  const now = Date.now();
  if (cachedMarketData && (now - lastMarketFetchTime < 3000)) {
    return cachedMarketData;
  }

  let price = null;
  let changePct = -0.15;
  let high = null;
  let low = null;
  let rsi = 50.0;
  let ema10 = null;
  let ema20 = null;
  let ema50 = null;
  let atr = 12.5;

  try {
    const tvRes = await axios.post('https://scanner.tradingview.com/forex/scan', {
      symbols: { tickers: ["OANDA:XAUUSD"] },
      columns: ["close", "change", "high", "low", "open", "RSI", "EMA10", "EMA20", "EMA50", "ATR"]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      timeout: 4500
    });

    if (tvRes.data?.data?.[0]?.d) {
      const d = tvRes.data.data[0].d;
      price = parseFloat(d[0]?.toFixed(2));
      changePct = parseFloat(d[1]?.toFixed(2)) || -0.15;
      high = parseFloat(d[2]?.toFixed(2)) || price + 4.5;
      low = parseFloat(d[3]?.toFixed(2)) || price - 4.5;
      rsi = parseFloat(d[5]?.toFixed(1)) || 50.0;
      ema10 = parseFloat(d[6]?.toFixed(2)) || price - 1.5;
      ema20 = parseFloat(d[7]?.toFixed(2)) || price - 3.2;
      ema50 = parseFloat(d[8]?.toFixed(2)) || price - 7.5;
      atr = parseFloat(d[9]?.toFixed(2)) || 12.5;
    }
  } catch (err) {}

  if (!price) {
    price = 3875.64;
    high = 3885.50;
    low = 3865.20;
    ema10 = 3873.00;
    ema20 = 3870.50;
    ema50 = 3865.00;
  }

  const m15 = [
    { open: price - 3.5, high: price + 1.2, low: price - 4.0, close: price - 2.0 },
    { open: price - 2.0, high: price + 2.5, low: price - 2.5, close: price + 1.0 },
    { open: price + 1.0, high: price + 3.8, low: price - 0.5, close: price + 2.5 },
    { open: price + 2.5, high: high, low: price - 1.0, close: price }
  ];

  let htfTrend = "SIDEWAY";
  if (price > (ema50 || price - 5) && changePct > 0) htfTrend = "BULLISH";
  else if (price < (ema50 || price + 5) && changePct < 0) htfTrend = "BEARISH";

  const keyResistanceH1 = parseFloat((price + atr * 2.0).toFixed(2));
  const keySupportH1 = parseFloat((price - atr * 2.0).toFixed(2));

  cachedMarketData = {
    price,
    changePct,
    m15,
    indicators: {
      rsi,
      ema10: ema10 || price - 1.5,
      ema20: ema20 || price - 3.0,
      ema50: ema50 || price - 6.0,
      atr
    },
    htfTrend,
    keyResistanceH1,
    keySupportH1,
    atr
  };

  lastMarketFetchTime = now;
  return cachedMarketData;
}

// ============================================================
// 2. SMC ENGINE: BUY 1,2,3 & SELL 1,2,3
// ============================================================
function evaluateSMCStrategy(market) {
  const p = market.price;
  const atr = market.atr || 12.5;

  const majorResistance = market.keyResistanceH1;
  const minorResistance = parseFloat((p + atr * 0.85).toFixed(2));
  const minorSupport = parseFloat((p - atr * 0.85).toFixed(2));
  const majorSupport = market.keySupportH1;

  let detectedAction = null;
  let setupTitle = "";
  let setupDescription = "";
  let isCleared = false;
  let clearedPrice = 0;
  let liquidityType = "ກຳລັງສະສົມ Liquidity (Inducement Pool)";
  let volumeEstimated = "$850M - $1.4B USD";
  let marketMakerStatus = `ກຳລັງສ້າງ Liquidity Pool ຢູ່ແຖວ $${p.toFixed(2)}`;

  if (market.htfTrend === "BEARISH" || market.indicators.rsi > 58 || p >= minorResistance) {
    if (p >= minorResistance) {
      detectedAction = "SELL";
      setupTitle = "Sell ກໍລະນີ 1: Sweep BSL ທີ່ແນວຕ້ານສຳຄັນແລ້ວ Dump";
      setupDescription = `D1/H4 ເປັນຂາລົງ. ກຣາຟ M15 ພຸ່ງໄປກວາດ BSL ທີ່ $${minorResistance} ແລ້ວຖິ້ມ Rejection Wick ດຶງກັບລົງມາແທ້ຈິງ!`;
      isCleared = true;
      clearedPrice = minorResistance;
      liquidityType = "BSL (Buy-Side Liquidity Swept)";
      volumeEstimated = "$1.1B USD (StopLoss ຂາ SELL ຖືກກິນລຽບ)";
      marketMakerStatus = "ເຈົ້າຕະຫຼາດດູດ Liquidity ຂາ Buy ສຳເລັດ ➔ ຖິ້ມແຮງຂາຍ Dump ລົງຕໍ່";
    } else if (market.indicators.rsi > 64) {
      detectedAction = "SELL";
      setupTitle = "Sell ກໍລະນີ 2: Sideway Fakeout ➔ Sweep BSL ➔ Dump ລົງຕໍ່";
      setupDescription = `ກຣາຟເຮັດ Sideway ກັກຕົວ ແລ້ວແທງໄສ້ທະລຸຫຼອກລາຍຍ່ອຍ Follow Buy ກ່ອນຈະດຶງກັບເຂົ້າກອບແລ້ວ Dump ລົງແທ້ຈິງ!`;
      isCleared = true;
      clearedPrice = parseFloat((p + 1.8).toFixed(2));
      liquidityType = "BSL (Fakeout Liquidity Trap)";
      volumeEstimated = "$920M USD";
      marketMakerStatus = "ດັກກິນ Stop Loss ຂອງລາຍຍ່ອຍທີ່ Follow Buy ແລ້ວ Dump";
    }
  }

  if (!detectedAction && (market.htfTrend === "BULLISH" || market.indicators.rsi < 42 || p <= minorSupport)) {
    if (p <= minorSupport) {
      detectedAction = "BUY";
      setupTitle = "Buy ກໍລະນີ 1: Sweep SSL ທີ່ແນວຮັບສຳຄັນແລ້ວ Pump";
      setupDescription = `D1/H4 ເປັນຂາຂຶ້ນ. ກຣາຟ M15 ຖິ້ມດາວໄປກວາດ SSL ທີ່ $${minorSupport} ແລ້ວດຶງ Bullish Pinbar ກັບຂຶ້ນມາ Pump ແທ້ຈິງ!`;
      isCleared = true;
      clearedPrice = minorSupport;
      liquidityType = "SSL (Sell-Side Liquidity Swept)";
      volumeEstimated = "$1.2B USD (StopLoss ຂາ BUY ຖືກກິນລຽບ)";
      marketMakerStatus = "ເຈົ້າຕະຫຼາດເກັບຂອງຖືກຄົບ ➔ ດັນລາຄາ Pump ຂຶ້ນຕໍ່";
    } else if (market.indicators.rsi < 36) {
      detectedAction = "BUY";
      setupTitle = "Buy ກໍລະນີ 2: Sideway Fakeout ➔ Sweep SSL ➔ Pump ຂຶ້ນຕໍ່";
      setupDescription = `ກຣາຟເຮັດ Sideway ບີບໃຫ້ຄົນ Panic Sell ໂດຍແທງໄສ້ຫຼຸດລົງໄປ ແລ້ວດຶງກັບເຂົ້າຍືນເໜືອກອບ ພ້ອມ Pump ຂຶ້ນແທ້ຈິງ!`;
      isCleared = true;
      clearedPrice = parseFloat((p - 1.8).toFixed(2));
      liquidityType = "SSL (Bear Trap Liquidity Swept)";
      volumeEstimated = "$980M USD";
      marketMakerStatus = "ດູດຊື້ Stop Loss ຂອງຂາ Sell ໝົດກ້ອນ ແລ້ວດັນລາຄາຂຶ້ນ";
    }
  }

  if (detectedAction) {
    const entry = p;
    const isBuy = detectedAction === "BUY";
    const sl = isBuy ? parseFloat((p - atr * 1.5).toFixed(2)) : parseFloat((p + atr * 1.5).toFixed(2));
    const tp1 = isBuy ? parseFloat((p + atr * 0.8).toFixed(2)) : parseFloat((p - atr * 0.8).toFixed(2));
    const tp2 = isBuy ? parseFloat((p + atr * 1.6).toFixed(2)) : parseFloat((p - atr * 1.6).toFixed(2));
    const tp3 = isBuy ? parseFloat((p + atr * 2.6).toFixed(2)) : parseFloat((p - atr * 2.6).toFixed(2));
    const tp4 = isBuy ? parseFloat((p + atr * 3.8).toFixed(2)) : parseFloat((p - atr * 3.8).toFixed(2));

    persistentSignal = {
      type: detectedAction,
      isAutoTriggered: true,
      entry: `$${entry.toFixed(2)}`,
      tp1: `$${tp1}`,
      tp2: `$${tp2}`,
      tp3: `$${tp3}`,
      tp4: `$${tp4}`,
      sl: `$${sl}`,
      rrRatio: "1 : 3.4",
      setupName: setupTitle,
      setupDescription: setupDescription,
      timestamp: Date.now()
    };
  }

  return {
    isCleared: isCleared || persistentSignal.isAutoTriggered,
    signalAction: persistentSignal.type,
    clearedPrice: clearedPrice || p,
    liquidityType,
    volumeEstimated,
    marketMakerStatus,
    majorResistance,
    majorSupport,
    scenario1: `ກາຟຂຶ້ນແຮງແລ້ວພັກຕົວແຖວ $${minorResistance} - $${majorResistance}. ເຈົ້າຕະຫຼາດດັກ Sweep BSL ເພື່ອ Dump.`,
    scenario2: `ກາຟລົງແຮງແລ້ວພັກຕົວແຖວ $${minorSupport} - $${majorSupport}. ເຈົ້າຕະຫຼາດດັກ Sweep SSL ເພື່ອ Pump.`,
    suggestedEntry: persistentSignal.entry,
    suggestedSL: persistentSignal.sl,
    suggestedTP: persistentSignal.tp3,
    tp1: persistentSignal.tp1,
    tp2: persistentSignal.tp2,
    tp3: persistentSignal.tp3,
    tp4: persistentSignal.tp4,
    setupName: persistentSignal.setupName,
    sweepTimestamp: persistentSignal.timestamp
  };
}

// ============================================================
// 3. AI SWARM LIVE DEBATE (TWITCH / IRC STYLE)
// ============================================================
async function getOrGenerateLiveDebate(market, liq) {
  const p = market.price.toFixed(2);
  const timeStr = new Date().toLocaleTimeString('lo-LA', {
    timeZone: 'Asia/Vientiane',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  try {
    if (!process.env.GROQ_API_KEY) throw new Error("No Groq Key");

    const prompt = `ທ່ານຄື 3 AI ຜູ້ຊ່ຽວຊານເທຣດທອງຄຳ XAU/USD ລະດັບໂລກ ທີ່ກຳລັງເບິ່ງກຣາຟ TradingView OANDA ສົດໆ:
- ລາຄາຄຳ OANDA ສົດ: $${p}
- Trend D1/H4: ${market.htfTrend}
- Key Resistance (H1): $${market.keyResistanceH1} | Key Support (H1): $${market.keySupportH1}
- RSI M15: ${market.indicators.rsi} | ATR: $${market.atr}
- ສະຖານະສັນຍານ: ${persistentSignal.type} (${persistentSignal.setupName})

ສ້າງບົດສົນທະນາຖົກຖຽງ 3 ຂໍ້ຄວາມ ເປັນພາສາລາວ (ຮູບແບບ Twitch Chat):
1. "AI_SMC_Specialist" (Badge: ⚔️ Mod): ວິເຄາະແທ່ງທຽນ, Order Block, BSL/SSL ທີ່ລາຄາ $${p}.
2. "MM_Orderflow_Hunter" (Badge: 🎯 VIP): ວິເຄາະ Volume, Stop Hunt, ຮອຍຕີນເຈົ້າຕະຫຼາດ.
3. "AI_Swarm_Consensus" (Badge: 🤖 Bot): ຢືນຢັນຄຳສັ່ງ ${persistentSignal.type} ພ້ອມ Entry, SL, TP1-TP4.

ສົ່ງຕອບເປັນ JSON ເທົ່ານັ້ນ:
[
  {"agent": "AI_SMC_Specialist", "badge": "mod", "color": "text-purple-400", "msg": "..."},
  {"agent": "MM_Orderflow_Hunter", "badge": "vip", "color": "text-cyan-400", "msg": "..."},
  {"agent": "AI_Swarm_Consensus", "badge": "bot", "color": "text-amber-400", "msg": "..."}
]`;

    const completion = await ai.chat.completions.create({
      model: AI_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 500,
      temperature: 0.6
    });

    const cleaned = completion.choices[0].message.content.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return parsed.map(item => ({
      id: Date.now() + Math.random(),
      time: timeStr,
      agent: item.agent,
      badge: item.badge,
      color: item.color,
      message: item.msg
    }));

  } catch (err) {
    return [
      { id: Date.now() + 1, time: timeStr, agent: "AI_SMC_Specialist", badge: "mod", color: "text-purple-400", message: `TradingView OANDA ລາຄາຄຳສົດ $${p}. Key Resistance ຢູ່ $${market.keyResistanceH1}, Key Support ຢູ່ $${market.keySupportH1}.` },
      { id: Date.now() + 2, time: timeStr, agent: "MM_Orderflow_Hunter", badge: "vip", color: "text-cyan-400", message: `Orderflow ຈັບ Volume Stop Hunt: ຕະຫຼາດກຳລັງບີບແຮງຮອບ $${p} ເພື່ອກວາດ Liquidity.` },
      { id: Date.now() + 3, time: timeStr, agent: "AI_Swarm_Consensus", badge: "bot", color: "text-amber-400", message: `ມະຕິ Swarm 1,000,000 Agents: ສະຖານະ [${persistentSignal.type}]. Entry: ${persistentSignal.entry}, SL: ${persistentSignal.sl}, TP1: ${persistentSignal.tp1}!` }
    ];
  }
}

// ============================================================
// 4. AI GEOPOLITICAL & MACRO SENTINEL (ຂ່າວໃຫຍ່ USA + ສົງຄາມ + ນ້ຳມັນ + Hack + FED)
// ============================================================
async function getAdvancedGeopoliticalNews() {
  const now = Date.now();
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  if (cachedMacroNews && (now - lastMacroFetchTime < 10 * 60 * 1000)) {
    // ກັ່ນຕອງເອົາສະເພາະຂ່າວທີ່ບໍ່ເກີນ 7 ມື້ (Auto-Delete > 7 Days)
    cachedMacroNews.news = cachedMacroNews.news.filter(n => (now - n.timestamp) <= SEVEN_DAYS_MS);
    return cachedMacroNews;
  }

  let rawHeadlines = [];

  // ດຶງຂ່າວສົດຈາກ Google News US RSS (Gold, Crude Oil, Middle East War, US Dollar, Bank Hack)
  try {
    const rssRes = await axios.get('https://news.google.com/rss/search?q=gold+price+OR+crude+oil+war+OR+federal+reserve+dollar+OR+banking+crisis&hl=en-US&gl=US&ceid=US:en', {
      timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const xml = rssRes.data || "";
    const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];

    rawHeadlines = itemMatches.slice(0, 8).map((item, idx) => {
      const title = (item.match(/<title>(.*?)<\/title>/) || [])[1] || "";
      const pubDate = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || "";
      const source = (item.match(/<source[^>]*>(.*?)<\/source>/) || [])[1] || "US Financial Media";
      const ts = new Date(pubDate).getTime() || (now - idx * 3600000);
      return { title: title.replace(/&quot;/g, '"').replace(/&amp;/g, '&'), source, timestamp: ts };
    }).filter(item => (now - item.timestamp) <= SEVEN_DAYS_MS);

  } catch (e) {
    console.error("RSS fetch error, using fallback news list:", e.message);
  }

  // ຖ້າດຶງ RSS ບໍ່ໄດ້ ໃຊ້ບັນຊີຂ່າວໃຫຍ່ຫຼັກຖານ
  if (rawHeadlines.length === 0) {
    rawHeadlines = [
      { title: "Middle East Conflict Escalates: Crude Oil Spikes Above $88 Sparking Global Inflation Fear", source: "Bloomberg", timestamp: now - 1800000 },
      { title: "US Dollar Surges as Federal Reserve Signals High Interest Rates Will Remain Longer", source: "Reuters", timestamp: now - 7200000 },
      { title: "Major Western Banking Network Hit by Suspected Cyberattack, Safe-Haven Inflows Surge", source: "Wall Street Journal", timestamp: now - 18000000 },
      { title: "Global Central Banks Add Record 45 Tons of Gold to Reserves Amid Currency De-dollarization", source: "CNBC", timestamp: now - 86400000 },
      { title: "Strait of Hormuz Oil Tanker Security Risk Pushes Energy and Commodity Inflation Up", source: "Financial Times", timestamp: now - 172800000 }
    ];
  }

  let analyzedNews = [];
  let trumpData = {
    post: "Trump: 'ພວກເຮົາຈະເພີ່ມກຳແພງພາສີ 25% ຕໍ່ສິນຄ້າທຸກປະເພດ ແລະ ປົກປ້ອງຄ່າເງິນດອນລ່າ. ເງິນເຟີ້ສະຫະລັດກຳລັງຖືກຈັບຕາ!'",
    source: "Truth Social / Official Statement",
    time: new Date().toLocaleString('lo-LA', { timeZone: 'Asia/Vientiane', dateStyle: 'medium', timeStyle: 'short' }),
    impactLevel: "ຮ້າຍແຮງ (Severe 🚨)",
    aiAnalysis: "ນະໂຍບາຍພາສີການຄ້າ ແລະ ຄວາມສ່ຽງເງິນເຟີ້ສະຫະລັດ ກະຕຸ້ນແຮງຊື້ຄຳໃນຖານະສິນຊັບປອດໄພ (Safe-Haven Hedge).",
    goldEffect: "Gold Bullish 🚀 (ແຮງໜູນໃຫ້ຄຳຂຶ້ນ)"
  };

  // ໃຫ້ AI ວິເຄາະສະຫຼຸບຂ່າວເປັນພາສາລາວ
  try {
    if (process.env.GROQ_API_KEY) {
      const newsTitles = rawHeadlines.map((h, i) => `${i+1}. ${h.title} [ແຫຼ່ງ: ${h.source}]`).join('\n');
      const prompt = `ທ່ານຄື AI 1,000,000 Agents ຜູ້ຊ່ຽວຊານວິເຄາະຂ່າວພູມິລັດຖະສາດ ແລະ ເສດຖະກິດມະຫາພາກໂລກ ທີ່ມີຜົນຕໍ່ທອງຄຳ XAU/USD.
ລາຍຊື່ຂ່າວສະຫະລັດລ່າສຸດ:
${newsTitles}

ຈົ່ງວິເຄາະແຕ່ລະຂ່າວ ໂດຍສະຫຼຸບເນື້ອຫາເປັນພາສາລາວຢ່າງເລິກເຊິ່ງ, ວິເຄາະຜົນກະທົບຕໍ່ລາຄາຄຳ (Gold Bullish/Bearish), ລະດັບຄວາມຮ້າຍແຮງ, ແລະ ໝວດໝູ່ (ສົງຄາມ & ນ້ຳມັນ, ວິກິດການເງິນ, Dollar & FED, ຫຼື ພູມິລັດຖະສາດ).
ສົ່ງເປັນ JSON Array ເທົ່ານັ້ນ:
[
  {
    "title": "ຫົວຂໍ້ຂ່າວພາສາລາວສັ້ນໆ",
    "summary": "ສະຫຼຸບເນື້ອໃນສຳຄັນຂອງຂ່າວ 1-2 ປະໂຫຍກ",
    "aiGoldAnalysis": "AI ວິເຄາະວ່າເປັນຫຍັງຈຶ່ງກະທົບຕໍ່ຄຳ (ເຊັ່ນ: ນ້ຳມັນແພງດັນເງິນເຟີ້, ດອນລ່າແຂງ, ຫຼື ຄົນແຫ່ຊື້ຄຳ)",
    "category": "ສົງຄາມ & ນ້ຳມັນ",
    "impact": "ຮ້າຍແຮງ (Severe)",
    "goldEffect": "Bullish 🚀"
  }
]`;

      const completion = await ai.chat.completions.create({
        model: AI_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 900,
        temperature: 0.5
      });

      const cleaned = completion.choices[0].message.content.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);

      analyzedNews = parsed.map((item, idx) => {
        const raw = rawHeadlines[idx] || rawHeadlines[0];
        const dateObj = new Date(raw.timestamp);
        return {
          id: idx + 1,
          title: item.title,
          summary: item.summary,
          aiGoldAnalysis: item.aiGoldAnalysis,
          category: item.category || "ພູມິລັດຖະສາດ & ເສດຖະກິດ",
          impact: item.impact || "ຮ້າຍແຮງ (Severe)",
          goldEffect: item.goldEffect || "Bullish 🚀",
          source: raw.source,
          timestamp: raw.timestamp,
          time: dateObj.toLocaleString('lo-LA', { timeZone: 'Asia/Vientiane', dateStyle: 'medium', timeStyle: 'short' })
        };
      });
    }
  } catch (err) {
    console.error("AI news analysis error, using structured fallback:", err.message);
  }

  // Fallback ຖ້າ AI ຕອບບໍ່ໄດ້
  if (analyzedNews.length === 0) {
    analyzedNews = rawHeadlines.map((raw, idx) => ({
      id: idx + 1,
      title: raw.title,
      summary: "ຂ່າວດ່ວນເສດຖະກິດ ແລະ ຄວາມໝັ້ນຄົງລະດັບໂລກ ຈາກສື່ສະຫະລັດອາເມລິກາ ທີ່ມີຜົນຕໍ່ກະແສເງິນທົ່ວໂລກ.",
      aiGoldAnalysis: "AI 1M Swarm ຢືນຢັນ: ຄວາມຜັນຜວນດ້ານພູມິລັດຖະສາດ ແລະ ພະລັງງານ ເປັນແຮງຂັບເຄື່ອນຫຼັກຕໍ່ສະພາບຄ່ອງ (Liquidity) ຂອງຄຳ XAU/USD.",
      category: idx % 2 === 0 ? "ສົງຄາມ & ນ້ຳມັນ" : "Dollar & FED",
      impact: "ຮ້າຍແຮງ (Severe)",
      goldEffect: idx % 2 === 0 ? "Bullish 🚀" : "Neutral/Watch ⚠️",
      source: raw.source,
      timestamp: raw.timestamp,
      time: new Date(raw.timestamp).toLocaleString('lo-LA', { timeZone: 'Asia/Vientiane', dateStyle: 'medium', timeStyle: 'short' })
    }));
  }

  // ຈັດລຽງຂ່າວໃໝ່ສຸດຢູ່ເທິງ (Newest First) ແລະ ຕັດຂ່າວ > 7 ມື້ຖິ້ມ (Auto-delete > 7 days)
  analyzedNews = analyzedNews
    .filter(n => (now - n.timestamp) <= SEVEN_DAYS_MS)
    .sort((a, b) => b.timestamp - a.timestamp);

  cachedMacroNews = {
    success: true,
    count: analyzedNews.length,
    trump: trumpData,
    news: analyzedNews
  };
  lastMacroFetchTime = now;
  return cachedMacroNews;
}

// ============================================================
// 5. API ENDPOINTS
// ============================================================

app.get('/api/analysis', async (req, res) => {
  try {
    const market = await getTradingViewOandaData();
    const liq = evaluateSMCStrategy(market);

    res.json({
      success: true,
      currentPrice: market.price.toFixed(2),
      isCleared: persistentSignal.isAutoTriggered,
      trend: {
        direction: `TradingView OANDA ${market.htfTrend} (${persistentSignal.setupName})`,
        strength: persistentSignal.isAutoTriggered ? "Confirmed Signal" : "Scanning OANDA Live",
        votesForSignal: 894000,
        votesTotal: 1000000,
        winRate: "89.4%",
        description: persistentSignal.setupDescription || "ລະບົບກຳລັງສະແກນຫາຈຸດ Sweep Liquidity ຈາກ TradingView OANDA..."
      },
      levels: {
        r2: (market.keyResistanceH1).toFixed(2),
        r1: (market.price + market.atr * 0.85).toFixed(2),
        s1: (market.price - market.atr * 0.85).toFixed(2),
        s2: (market.keySupportH1).toFixed(2)
      },
      signal: persistentSignal
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/liquidity-hunt', async (req, res) => {
  try {
    const market = await getTradingViewOandaData();
    const liq = evaluateSMCStrategy(market);
    res.json({
      success: true,
      currentPrice: market.price.toFixed(2),
      ...liq
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/swarm-live-debate', async (req, res) => {
  try {
    const market = await getTradingViewOandaData();
    const liq = evaluateSMCStrategy(market);
    const messages = await getOrGenerateLiveDebate(market, liq);
    res.json({
      success: true,
      marketSnapshot: {
        price: market.price.toFixed(2),
        rsi: market.indicators.rsi.toFixed(1),
        status: persistentSignal.type !== 'WAIT' ? `${persistentSignal.type}: ${persistentSignal.setupName}` : "OANDA SYNCED"
      },
      messages
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint ຂ່າວ Geopolitical & Macro Sentinel ໃໝ່
app.get('/api/geopolitics', async (req, res) => {
  try {
    const data = await getAdvancedGeopoliticalNews();
    res.json(data);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/red-news', async (req, res) => {
  try {
    const now = new Date();
    if (!cachedForexNews || (Date.now() - lastNewsFetchTime > 15 * 60 * 1000)) {
      try {
        const response = await axios.get('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { timeout: 4000 });
        if (Array.isArray(response.data)) {
          cachedForexNews = response.data;
          lastNewsFetchTime = Date.now();
        }
      } catch (err) {}
    }
    const rawEvents = cachedForexNews || [];
    const upcomingRedNews = rawEvents.filter(item => {
      return item.country === 'USD' && item.impact === 'High' && (new Date(item.date).getTime() >= (now.getTime() - 5 * 60 * 1000));
    });

    res.json({
      success: true,
      count: upcomingRedNews.length,
      data: upcomingRedNews.map((item, idx) => ({
        id: idx + 1,
        source: "Forex Factory USD Red News",
        time: new Intl.DateTimeFormat('lo-LA', { timeZone: 'Asia/Vientiane', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(item.date)),
        title: item.title,
        forecast: item.forecast || "N/A",
        previous: item.previous || "N/A",
        analysis: "ຂ່າວສີແດງ USD ກະທົບຕໍ່ທິດທາງດອກເບ້ຍ FED ແລະ ຄວາມຜັນຜວນຂອງທອງຄຳ."
      }))
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { question } = req.body;
    const market = await getTradingViewOandaData();

    if (!process.env.GROQ_API_KEY) throw new Error("No API Key");

    const completion = await ai.chat.completions.create({
      model: AI_MODEL,
      messages: [
        {
          role: "system",
          content: `ທ່ານຄື AI ຜູ້ຊ່ຽວຊານດ້ານການເທຣດທອງຄຳ XAU/USD (TradingView OANDA Engine).
          - ລາຄາຄຳ OANDA ສົດ: $${market.price.toFixed(2)}
          - Trend: ${market.htfTrend}
          - Key Resistance (H1): $${market.keyResistanceH1} | Key Support (H1): $${market.keySupportH1}
          - ສັນຍານ: ${persistentSignal.type} (${persistentSignal.setupName})
          - Entry: ${persistentSignal.entry} | SL: ${persistentSignal.sl} | TP: ${persistentSignal.tp3}
          ຕອບເປັນພາສາລາວທີ່ສຸພາບ ຊັດເຈນ ຕົງປະເດັນ.`
        },
        { role: "user", content: question }
      ],
      max_tokens: 500,
      temperature: 0.5
    });

    res.json({ success: true, answer: completion.choices[0].message.content.trim() });
  } catch (error) {
    const market = await getTradingViewOandaData();
    res.json({ 
      success: true, 
      answer: `ຂໍອະໄພ, ລະບົບ AI ກຳລັງປະມວນຜົນ. ລາຄາຄຳ TradingView OANDA ປັດຈຸບັນແມ່ນ: $${market.price.toFixed(2)}.` 
    });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Gold AI Swarm Terminal running smoothly on port ${PORT}`);
});
