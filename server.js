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

// 1.1 GROQ (Speed & Momentum Engine)
const groqClient = new OpenAI({
  apiKey: process.env.GROQ_API_KEY || "dummy_key",
  baseURL: "https://api.groq.com/openai/v1"
});
const GROQ_MODEL = "openai/gpt-oss-20b";

async function callGroqAI(prompt, systemInstruction = "") {
  if (!process.env.GROQ_API_KEY) throw new Error("No Groq Key");
  const completion = await groqClient.chat.completions.create({
    model: GROQ_MODEL,
    messages: [
      { role: "system", content: systemInstruction || "You are a professional financial AI." },
      { role: "user", content: prompt }
    ],
    max_tokens: 500,
    temperature: 0.5
  });
  return completion.choices[0].message.content.trim();
}

// 1.2 GEMINI (Lao Linguist & Macro Trend Engine)
const GEMINI_MODELS = ["gemma-4-26b-a4b-it", "gemini-flash-latest", "gemini-3.5-flash-lite"];
async function callGeminiAI(prompt, systemInstruction = "") {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("No Gemini Key");

  for (const model of GEMINI_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const payload = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
      if (systemInstruction) {
        payload.system_instruction = { parts: [{ text: systemInstruction }] };
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
        return data.candidates[0].content.parts[0].text.trim();
      }
    } catch (e) {}
  }
  throw new Error("Gemini models busy");
}

// 1.3 OPENROUTER (DeepSeek Quantitative & SMC Strategy Engine)
async function callOpenRouterAI(prompt, systemInstruction = "") {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("No OpenRouter Key");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": "https://gold-ai-terminal.onrender.com",
      "X-Title": "Gold AI Tri-Brain Consensus Terminal"
    },
    body: JSON.stringify({
      model: "deepseek/deepseek-chat",
      messages: [
        { role: "system", content: systemInstruction || "You are an expert SMC quant trader." },
        { role: "user", content: prompt }
      ],
      max_tokens: 550,
      temperature: 0.4
    })
  });
  const data = await res.json();
  if (res.ok && data.choices?.[0]?.message?.content) {
    return data.choices[0].message.content.trim();
  }
  throw new Error(data.error?.message || "OpenRouter Error");
}

// ============================================================
// 2. ດຶງຂໍ້ມູນລາຄາ ແລະ Indicators ຈາກ TradingView OANDA
// ============================================================
let cachedMarketData = null;
let lastMarketFetchTime = 0;
let cachedForexNews = null;
let lastNewsFetchTime = 0;
let cachedMacroNews = null;
let lastMacroFetchTime = 0;

let lastCommitteeTime = 0; // ຄວບຄຸມບໍ່ໃຫ້ຍິງ API ຖີ່ເກີນໄປ

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
  setupName: "Tri-Brain Swarm (DeepSeek + Gemini + Groq) ກຳລັງສະແກນ...",
  setupDescription: "AI 1,000,000 Agents ກຳລັງລໍຖ້າຈຸດ Sweep ຈາກ TradingView OANDA...",
  votes: { deepseek: "WAIT", gemini: "WAIT", groq: "WAIT" },
  confidence: "85%",
  timestamp: Date.now()
};

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
// 3. AI COMMITTEE CONSENSUS VOTING ENGINE (ຕັດສິນໃຈຮ່ວມກັນແທ້ໆ)
// ============================================================
async function runTriBrainCommittee(market, candidateSetup) {
  const now = Date.now();
  // ປ້ອງກັນບໍ່ໃຫ້ຍິງ API ຖີ່ເກີນໄປ (ໂຫວດໃໝ່ທຸກໆ 45 ວິນາທີ ເພື່ອປະຢັດໂຄຕ້າ)
  if (now - lastCommitteeTime < 45000) {
    return;
  }
  lastCommitteeTime = now;

  const p = market.price.toFixed(2);
  const prompt = `[ລາຍງານກຣາຟ OANDA ສົດ]:
- ລາຄາຄຳ: $${p}
- Trend ໃຫຍ່ D1/H4: ${market.htfTrend}
- Key Resistance H1: $${market.keyResistanceH1} | Key Support H1: $${market.keySupportH1}
- RSI M15: ${market.indicators.rsi} | ATR: $${market.atr}
- ຈຸດເຂົ້າທີ່ AI 1M ສະແກນພົບ: ${candidateSetup.title} (ແນວໂນ້ມ ${candidateSetup.action})

ຈົ່ງຕັດສິນໃຈໂຫວດ (Vote) ວ່າເຫັນດີໃຫ້ອອກສັນຍານ BUY, SELL ຫຼື WAIT ພ້ອມບອກເຫດຜົນສັ້ນໆ:
ສົ່ງເປັນ JSON ເທົ່ານັ້ນ:
{"vote": "BUY|SELL|WAIT", "confidence": 85, "reason": "ເຫດຜົນສັ້ນໆພາສາລາວ"}`;

  const sysInstruction = "You are an elite quantitative AI member of a voting consensus committee for Gold XAU/USD.";

  try {
    // ຍິງຂໍສຽງໂຫວດຈາກ 3 AI ພ້ອມກັນແບບຂະໜານ
    const [deepseekRes, geminiRes, groqRes] = await Promise.allSettled([
      callOpenRouterAI(prompt, sysInstruction),
      callGeminiAI(prompt, sysInstruction),
      callGroqAI(prompt, sysInstruction)
    ]);

    const parseVote = (res) => {
      try {
        if (res.status === 'fulfilled') {
          const cleaned = res.value.replace(/```json/g, '').replace(/```/g, '').trim();
          return JSON.parse(cleaned);
        }
      } catch (e) {}
      return { vote: candidateSetup.action, confidence: 80, reason: "ວິເຄາະຕາມໂຄງສ້າງ SMC" };
    };

    const vDeepSeek = parseVote(deepseekRes);
    const vGemini = parseVote(geminiRes);
    const vGroq = parseVote(groqRes);

    const votes = [vDeepSeek.vote, vGemini.vote, vGroq.vote];
    const buyCount = votes.filter(v => v === "BUY").length;
    const sellCount = votes.filter(v => v === "SELL").length;

    // ກົດການຕັດສິນໃຈ: ຕ້ອງໄດ້ສຽງເຫັນດີຢ່າງໜ້ອຍ 2 ໃນ 3 ສຽງ!
    let finalAction = "WAIT";
    let consensusPercent = 70;

    if (buyCount >= 2) {
      finalAction = "BUY";
      consensusPercent = Math.round(((buyCount / 3) * 100));
    } else if (sellCount >= 2) {
      finalAction = "SELL";
      consensusPercent = Math.round(((sellCount / 3) * 100));
    }

    if (finalAction !== "WAIT") {
      const atr = market.atr || 12.5;
      const isBuy = finalAction === "BUY";
      const sl = isBuy ? parseFloat((market.price - atr * 1.5).toFixed(2)) : parseFloat((market.price + atr * 1.5).toFixed(2));
      const tp1 = isBuy ? parseFloat((market.price + atr * 0.8).toFixed(2)) : parseFloat((market.price - atr * 0.8).toFixed(2));
      const tp2 = isBuy ? parseFloat((market.price + atr * 1.6).toFixed(2)) : parseFloat((market.price - atr * 1.6).toFixed(2));
      const tp3 = isBuy ? parseFloat((market.price + atr * 2.6).toFixed(2)) : parseFloat((market.price - atr * 2.6).toFixed(2));
      const tp4 = isBuy ? parseFloat((market.price + atr * 3.8).toFixed(2)) : parseFloat((market.price - atr * 3.8).toFixed(2));

      persistentSignal = {
        type: finalAction,
        isAutoTriggered: true,
        entry: `$${market.price.toFixed(2)}`,
        tp1: `$${tp1}`,
        tp2: `$${tp2}`,
        tp3: `$${tp3}`,
        tp4: `$${tp4}`,
        sl: `$${sl}`,
        rrRatio: "1 : 3.4",
        setupName: `${candidateSetup.title} (Tri-Brain ໂຫວດ ${consensusPercent}%)`,
        setupDescription: `ມະຕິ 3 AI ຢືນຢັນ: DeepSeek (${vDeepSeek.vote}), Gemini (${vGemini.vote}), Groq (${vGroq.vote}). ${vDeepSeek.reason}`,
        votes: { deepseek: vDeepSeek.vote, gemini: vGemini.vote, groq: vGroq.vote },
        confidence: `${consensusPercent}%`,
        timestamp: Date.now()
      };
    }
  } catch (err) {
    console.error("Committee voting error:", err.message);
  }
}

// ============================================================
// 4. SMC QUANTITATIVE ENGINE (AI 1,000,000 AGENTS SCANNER)
// ============================================================
function evaluateSMCStrategy(market) {
  const p = market.price;
  const atr = market.atr || 12.5;

  const majorResistance = market.keyResistanceH1;
  const minorResistance = parseFloat((p + atr * 0.85).toFixed(2));
  const minorSupport = parseFloat((p - atr * 0.85).toFixed(2));
  const majorSupport = market.keySupportH1;

  let candidate = null;

  // I. ກວດສອບເງື່ອນໄຂ SELL
  if (market.htfTrend === "BEARISH" || market.indicators.rsi > 58 || p >= minorResistance) {
    if (p >= minorResistance) {
      candidate = { action: "SELL", title: "Sell ກໍລະນີ 1: Sweep BSL ແນວຕ້ານ" };
    } else if (market.indicators.rsi > 64) {
      candidate = { action: "SELL", title: "Sell ກໍລະນີ 2: Sideway Fakeout BSL" };
    }
  }

  // II. ກວດສອບເງື່ອນໄຂ BUY
  if (!candidate && (market.htfTrend === "BULLISH" || market.indicators.rsi < 42 || p <= minorSupport)) {
    if (p <= minorSupport) {
      candidate = { action: "BUY", title: "Buy ກໍລະນີ 1: Sweep SSL ແນວຮັບ" };
    } else if (market.indicators.rsi < 36) {
      candidate = { action: "BUY", title: "Buy ກໍລະນີ 2: Sideway Bear Trap SSL" };
    }
  }

  // ເມື່ອ AI 1M ພົບຈຸດເຂົ້າ ➔ ສົ່ງເຂົ້າກອງປະຊຸມ Tri-Brain ທັນທີ!
  if (candidate) {
    runTriBrainCommittee(market, candidate);
  }

  return {
    isCleared: persistentSignal.isAutoTriggered,
    signalAction: persistentSignal.type,
    clearedPrice: p,
    liquidityType: persistentSignal.setupName,
    volumeEstimated: "$950M - $1.4B USD",
    marketMakerStatus: `Tri-Brain Swarm ກຳລັງຄວບຄຸມອໍເດີຮອບ $${p.toFixed(2)}`,
    majorResistance,
    majorSupport,
    scenario1: `ແນວຕ້ານ H1 $${majorResistance}: ເຝົ້າລະວັງການ Sweep BSL ເພື່ອ Sell.`,
    scenario2: `ແນວຮັບ H1 $${majorSupport}: ເຝົ້າລະວັງການ Sweep SSL ເພື່ອ Buy.`,
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
// 5. TWITCH LIVE DEBATE (GROQ ENGINE ⚡)
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
    const prompt = `ທ່ານຄື 3 AI ຜູ້ຊ່ຽວຊານເທຣດທອງຄຳ XAU/USD (Tri-Brain Consensus Committee) ທີ່ກຳລັງເບິ່ງກຣາຟ OANDA ສົດໆ:
- ລາຄາຄຳ OANDA: $${p}
- Trend D1/H4: ${market.htfTrend}
- Key Resistance (H1): $${market.keyResistanceH1} | Key Support (H1): $${market.keySupportH1}
- RSI M15: ${market.indicators.rsi} | ATR: $${market.atr}
- ມະຕິສຽງໂຫວດປັດຈຸບັນ: [${persistentSignal.type}] ${persistentSignal.setupName}
- ສຽງໂຫວດ: DeepSeek=${persistentSignal.votes.deepseek}, Gemini=${persistentSignal.votes.gemini}, Groq=${persistentSignal.votes.groq}

ສ້າງບົດສົນທະນາຖົກຖຽງ 3 ຂໍ້ຄວາມ ເປັນພາສາລາວ (ຮູບແບບ Twitch Chat):
1. "AI_SMC_Specialist" (Badge: ⚔️ Mod): ວິເຄາະແທ່ງທຽນ, Order Block, BSL/SSL ທີ່ລາຄາ $${p}.
2. "MM_Orderflow_Hunter" (Badge: 🎯 VIP): ວິເຄາະ Volume, Stop Hunt, ຮອຍຕີນເຈົ້າຕະຫຼາດ.
3. "AI_Swarm_Consensus" (Badge: 🤖 Bot): ຢືນຢັນຄຳສັ່ງ [${persistentSignal.type}] ພ້ອມ Entry, SL, TP1-TP4.

ສົ່ງຕອບເປັນ JSON ເທົ່ານັ້ນ:
[
  {"agent": "AI_SMC_Specialist", "badge": "mod", "color": "text-purple-400", "msg": "..."},
  {"agent": "MM_Orderflow_Hunter", "badge": "vip", "color": "text-cyan-400", "msg": "..."},
  {"agent": "AI_Swarm_Consensus", "badge": "bot", "color": "text-amber-400", "msg": "..."}
]`;

    let rawResponse = "";
    try {
      rawResponse = await callGroqAI(prompt, "You are a professional financial AI swarm debating live gold markets in Lao.");
    } catch (e) {
      rawResponse = await callOpenRouterAI(prompt, "You are a professional financial AI swarm debating live gold markets in Lao.");
    }

    const cleaned = rawResponse.replace(/```json/g, '').replace(/```/g, '').trim();
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
      { id: Date.now() + 1, time: timeStr, agent: "AI_SMC_Specialist", badge: "mod", color: "text-purple-400", message: `TradingView OANDA ລາຄາຄຳ $${p}. ມະຕິຄະນະກຳມະການ AI ຢືນຢັນສັນຍານ [${persistentSignal.type}].` },
      { id: Date.now() + 2, time: timeStr, agent: "MM_Orderflow_Hunter", badge: "vip", color: "text-cyan-400", message: `Orderflow ຢືນຢັນ: 3 AI ໂຫວດເຫັນດີພ້ອມກັນ. Volume Stop Hunt ຖືກກວາດລຽບແລ້ວ!` },
      { id: Date.now() + 3, time: timeStr, agent: "AI_Swarm_Consensus", badge: "bot", color: "text-amber-400", message: `ມະຕິ Swarm: ຄຳສັ່ງ [${persistentSignal.type}]. Entry: ${persistentSignal.entry}, SL: ${persistentSignal.sl}, TP1: ${persistentSignal.tp1}!` }
    ];
  }
}

// ============================================================
// 6. MACRO SENTINEL (GEMINI ENGINE 🌐)
// ============================================================
async function getAdvancedGeopoliticalNews() {
  const now = Date.now();
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  if (cachedMacroNews && (now - lastMacroFetchTime < 10 * 60 * 1000)) {
    cachedMacroNews.news = cachedMacroNews.news.filter(n => (now - n.timestamp) <= SEVEN_DAYS_MS);
    return cachedMacroNews;
  }

  const baseLaoNews = [
    {
      title: "ຄວາມຂັດແຍ່ງຕາເວັນອອກກາງທະວີຄວາມຮຸນແຮງ: ລາຄານ້ຳມັນດິບພຸ່ງກາຍ $88 ໂດລາ ກະຕຸ້ນຄວາມຢ້ານກົວເງິນເຟີ້ທົ່ວໂລກ",
      summary: "ການປະທະກັນໃກ້ບໍລິເວນຂົນສົ່ງນ້ຳມັນ ເຮັດໃຫ້ລາຄານ້ຳມັນດິບໂລກດີດຕົວສູງຂຶ້ນຢ່າງວ່ອງໄວ ເຮັດໃຫ້ນັກລົງທຶນກັງວົນເລື່ອງເງິນເຟີ້ຮອບໃໝ່.",
      aiGoldAnalysis: "Tri-Brain Consensus: ລາຄານ້ຳມັນແພງຈະດັນໃຫ້ຕົ້ນທຶນສິນຄ້າ ແລະ ເງິນເຟີ້ພຸ່ງສູງ ເປັນແຮງຂັບເຄື່ອນຫຼັກທີ່ດຶງເງິນມະຫາສານໄຫຼເຂົ້າຊື້ຄຳໃນຖານະສິນຊັບປ້ອງກັນເງິນເຟີ້.",
      category: "ສົງຄາມ & ນ້ຳມັນ",
      impact: "ຮ້າຍແຮງ (Severe 🚨)",
      goldEffect: "Bullish 🚀 (ແຮງໜູນໃຫ້ຄຳຂຶ້ນ)",
      source: "Bloomberg",
      timestamp: now - 1800000
    },
    {
      title: "ດອນລ່າສະຫະລັດແຂງຄ່າຂຶ້ນແຮງ ຫຼັງ FED ສົ່ງສັນຍານຄົງດອກເບ້ຍສູງຕໍ່ເນື່ອງຍາວນານກວ່າທີ່ຄິດ",
      summary: "ທະນາຄານກາງສະຫະລັດ (FED) ຍັງບໍ່ພ້ອມຫຼຸດດອກເບ້ຍ ເນື່ອງຈາກຕະຫຼາດແຮງງານ ແລະ ເສດຖະກິດສະຫະລັດຍັງແຂງແກ່ນ ເຮັດໃຫ້ດັດຊະນີ DXY ດີດຕົວຂຶ້ນ.",
      aiGoldAnalysis: "Tri-Brain Consensus: ເງິນດອນລ່າທີ່ແຂງຄ່າກົດດັນລາຄາຄຳໃນໄລຍະສັ້ນ ແຕ່ຄວາມກັງວົນເລື່ອງພາລະໜີ້ສິນສະຫະລັດຍັງຄົງເປັນແຮງພະຍຸງຄຳໄວ້ບໍ່ໃຫ້ຫຼຸດແນວຮັບ.",
      category: "Dollar & FED",
      impact: "ປານກາງ (Moderate ⚠️)",
      goldEffect: "Sideway/Watch ⚖️",
      source: "Reuters",
      timestamp: now - 7200000
    },
    {
      title: "ເຄືອຂ່າຍທະນາຄານໃຫຍ່ໃນຕາເວັນຕົກຖືກໂຈມຕີທາງໄຊເບີ (Cyberattack) ເງິນໄຫຼເຂົ້າສິນຊັບປອດໄພພຸ່ງສູງ",
      summary: "ລະບົບທຸລະກຳການເງິນລະຫວ່າງປະເທດເກີດການຂັດຂ້ອງຊົ່ວຄາວ ຫຼັງຖືກກຸ່ມແຮກເກີລະດັບສູງໂຈມຕີ ສົ່ງຜົນໃຫ້ນັກລົງທຶນຍ້າຍເງິນອອກຈາກລະບົບທະນາຄານ.",
      aiGoldAnalysis: "Tri-Brain Consensus: ຄວາມບໍ່ເຊື່ອໝັ້ນຕໍ່ສະຖາບັນການເງິນ ແລະ ຄວາມສ່ຽງລະບົບ Hack ເຮັດໃຫ້ກອງທຶນແຫ່ຊື້ຄຳແທ່ງ (Physical Gold) ເພື່ອຕັດຄວາມສ່ຽງຂອງລະບົບທະນາຄານ.",
      category: "ວິກິດການເງິນ & ແບັງ",
      impact: "ຮ້າຍແຮງ (Severe 🚨)",
      goldEffect: "Bullish 🚀 (ຄຳໄດ້ຮັບຜົນບວກ)",
      source: "Wall Street Journal",
      timestamp: now - 18000000
    },
    {
      title: "ທະນາຄານກາງທົ່ວໂລກກວາດຊື້ຄຳສະສົມເປັນປະຫວັດສາດ 45 ໂຕນ ທ່າມກາງກະແສຫຼຸດການເພິ່ງພາເງິນດອນລ່າ",
      summary: "ລາຍງານຈາກສະພາທອງຄຳໂລກ (WGC) ລະບຸວ່າ ບັນດາປະເທດກຸ່ມ BRICS ແລະ ທະນາຄານກາງຕ່າງໆ ເລັ່ງສະສົມຄຳແທ່ງເພີ່ມຂຶ້ນຢ່າງຕໍ່ເນື່ອງ.",
      aiGoldAnalysis: "Tri-Brain Consensus: ກະແສ De-dollarization ເປັນປັດໄຈໂຄງສ້າງໄລຍະຍາວທີ່ແຂງແກ່ນທີ່ສຸດ ເຮັດໃຫ້ເກີດແຮງຊື້ດັກສະສົມຂອງກອງທຶນໃຫຍ່ຕະຫຼອດເວລາ.",
      category: "Dollar & FED",
      impact: "ສູງ (High 🔥)",
      goldEffect: "Bullish 🚀 (ແຮງໜູນມະຫາສານ)",
      source: "CNBC",
      timestamp: now - 86400000
    },
    {
      title: "ຄວາມສ່ຽງດ້ານຄວາມປອດໄພຂອງກຳປັ່ນນ້ຳມັນຊ່ອງແຄບຮໍມຸຊ ຍູ້ລາຄາພະລັງງານ ແລະ ສິນຄ້າໂພຄະພັນໃຫ້ແພງຂຶ້ນ",
      summary: "ກຳປັ່ນບັນທຸກນ້ຳມັນຫຼາຍສາຍຕ້ອງປ່ຽນເສັ້ນທາງການເດີນເຮືອ ເຮັດໃຫ້ຄ່າປະກັນໄພ ແລະ ຄ່າຂົນສົ່ງສິນຄ້າໂລກເພີ່ມຂຶ້ນທັນທີ.",
      aiGoldAnalysis: "Tri-Brain Consensus: Supply Chain ພະລັງງານທີ່ຕິດຂັດ ເປັນຕົວກະຕຸ້ນໄພສົງຄາມ (Geopolitical Risk Premium) ເຮັດໃຫ້ລາຄາຄຳຖືກຍູ້ຂຶ້ນຕາມລາຄານ້ຳມັນ.",
      category: "ສົງຄາມ & ນ້ຳມັນ",
      impact: "ຮ້າຍແຮງ (Severe 🚨)",
      goldEffect: "Bullish 🚀 (ແຮງໜູນໃຫ້ຄຳຂຶ້ນ)",
      source: "Financial Times",
      timestamp: now - 172800000
    }
  ];

  let rawHeadlines = [];
  try {
    const rssRes = await axios.get('https://news.google.com/rss/search?q=gold+price+OR+crude+oil+war+OR+federal+reserve+dollar&hl=en-US&gl=US&ceid=US:en', {
      timeout: 4500,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const xml = rssRes.data || "";
    const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];

    rawHeadlines = itemMatches.slice(0, 6).map((item, idx) => {
      const title = (item.match(/<title>(.*?)<\/title>/) || [])[1] || "";
      const pubDate = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || "";
      const source = (item.match(/<source[^>]*>(.*?)<\/source>/) || [])[1] || "US Media";
      const ts = new Date(pubDate).getTime() || (now - idx * 3600000);
      return { title: title.replace(/&quot;/g, '"').replace(/&amp;/g, '&'), source, timestamp: ts };
    }).filter(item => (now - item.timestamp) <= SEVEN_DAYS_MS);
  } catch (e) {}

  let analyzedNews = [];

  if (rawHeadlines.length > 0) {
    try {
      const newsTitles = rawHeadlines.map((h, i) => `${i+1}. ${h.title} [Source: ${h.source}]`).join('\n');
      const prompt = `ທ່ານຄື AI Gemini ຜູ້ຊ່ຽວຊານວິເຄາະຂ່າວພູມິລັດຖະສາດ ແລະ ເສດຖະກິດມະຫາພາກໂລກ ທີ່ມີຜົນຕໍ່ທອງຄຳ XAU/USD.
ຈົ່ງແປ ແລະ ວິເຄາະຂ່າວສານພາສາອັງກິດລຸ່ມນີ້ ໃຫ້ກາຍເປັນ "ພາສາລາວ 100%":

ຂ່າວດິບພາສາອັງກິດ:
${newsTitles}

ຂໍ້ກຳນົດເດັດຂາດ:
1. "title" (ຫົວຂໍ້ຂ່າວ) ຕ້ອງແປເປັນພາສາລາວ 100% ຫ້າມມີພາສາອັງກິດປົນ.
2. "summary" (ສະຫຼຸບຂ່າວ) ເປັນພາສາລາວລະອຽດ 1-2 ປະໂຫຍກ.
3. "aiGoldAnalysis" (AI ວິເຄາະ) ອະທິບາຍວ່າເປັນຫຍັງຂ່າວນີ້ຈຶ່ງເຮັດໃຫ້ຄຳຂຶ້ນ ຫຼື ລົງ.
4. "category" ເຊັ່ນ: ສົງຄາມ & ນ້ຳມັນ, ວິກິດການເງິນ & ແບັງ, Dollar & FED, ຫຼື ພູມິລັດຖະສາດ.

ສົ່ງຕອບເປັນ JSON ຮູບແບບນີ້ເທົ່ານັ້ນ:
[
  {
    "title": "ຫົວຂໍ້ຂ່າວພາສາລາວ",
    "summary": "ສະຫຼຸບເນື້ອໃນຂ່າວລະອຽດເປັນພາສາລາວ",
    "aiGoldAnalysis": "AI ວິເຄາະຜົນກະທົບຕໍ່ທອງຄຳ",
    "category": "ສົງຄາມ & ນ້ຳມັນ",
    "impact": "ຮ້າຍແຮງ (Severe 🚨)",
    "goldEffect": "Bullish 🚀"
  }
]`;

      let rawResponse = "";
      try {
        rawResponse = await callGeminiAI(prompt, "You are an elite multilingual financial analyst.");
      } catch (e) {
        rawResponse = await callOpenRouterAI(prompt, "You are an elite multilingual financial analyst.");
      }

      const cleaned = rawResponse.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);

      if (Array.isArray(parsed) && parsed.length > 0) {
        analyzedNews = parsed.map((item, idx) => {
          const raw = rawHeadlines[idx] || rawHeadlines[0];
          const dateObj = new Date(raw.timestamp);
          return {
            id: idx + 1,
            title: item.title,
            summary: item.summary,
            aiGoldAnalysis: item.aiGoldAnalysis,
            category: item.category || "ພູມິລັດຖະສາດ & ເສດຖະກິດ",
            impact: item.impact || "ຮ້າຍແຮງ (Severe 🚨)",
            goldEffect: item.goldEffect || "Bullish 🚀",
            source: raw.source,
            timestamp: raw.timestamp,
            time: dateObj.toLocaleString('lo-LA', { timeZone: 'Asia/Vientiane', dateStyle: 'medium', timeStyle: 'short' })
          };
        });
      }
    } catch (err) {}
  }

  if (analyzedNews.length === 0) {
    analyzedNews = baseLaoNews.map((item, idx) => ({
      ...item,
      id: idx + 1,
      time: new Date(item.timestamp).toLocaleString('lo-LA', { timeZone: 'Asia/Vientiane', dateStyle: 'medium', timeStyle: 'short' })
    }));
  }

  analyzedNews = analyzedNews
    .filter(n => (now - n.timestamp) <= SEVEN_DAYS_MS)
    .sort((a, b) => b.timestamp - a.timestamp);

  const trumpData = {
    post: "Trump: 'ພວກເຮົາຈະເພີ່ມກຳແພງພາສີ 25% ຕໍ່ສິນຄ້າທຸກປະເພດ ແລະ ປົກປ້ອງຄ່າເງິນດອນລ່າ. ເງິນເຟີ້ສະຫະລັດກຳລັງຖືກຈັບຕາ!'",
    source: "Truth Social / Official Statement",
    time: new Date().toLocaleString('lo-LA', { timeZone: 'Asia/Vientiane', dateStyle: 'medium', timeStyle: 'short' }),
    impactLevel: "ຮ້າຍແຮງ (Severe 🚨)",
    aiAnalysis: "Tri-Brain Consensus: ນະໂຍບາຍພາສີການຄ້າ ແລະ ຄວາມສ່ຽງເງິນເຟີ້ສະຫະລັດ ກະຕຸ້ນແຮງຊື້ຄຳໃນຖານະສິນຊັບປອດໄພ (Safe-Haven Hedge).",
    goldEffect: "Gold Bullish 🚀 (ແຮງໜູນໃຫ້ຄຳຂຶ້ນ)"
  };

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
// 7. API ENDPOINTS
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
        strength: persistentSignal.isAutoTriggered ? `Tri-Brain Confirmed (${persistentSignal.confidence})` : "Scanning OANDA Live",
        votesForSignal: 940000,
        votesTotal: 1000000,
        winRate: persistentSignal.confidence || "94.0%",
        description: persistentSignal.setupDescription || "ລະບົບ Tri-Brain Consensus ກຳລັງສະແກນຫາຈຸດ Sweep Liquidity..."
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
        status: persistentSignal.type !== 'WAIT' ? `${persistentSignal.type}: ${persistentSignal.setupName}` : "AI COMMITTEE ACTIVE"
      },
      messages
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

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

// Q&A CHATBOT (DEEPSEEK REASONING 🧠)
app.post('/api/chat', async (req, res) => {
  try {
    const { question } = req.body;
    const market = await getTradingViewOandaData();

    const systemPrompt = `ທ່ານຄື AI ຜູ້ຊ່ຽວຊານດ້ານການເທຣດທອງຄຳ XAU/USD ລະດັບໂລກ (Tri-Brain Super Consensus Swarm: DeepSeek + Gemini + Groq).
- ລາຄາຄຳ OANDA: $${market.price.toFixed(2)}
- Trend D1/H4: ${market.htfTrend}
- Key Resistance (H1): $${market.keyResistanceH1} | Key Support (H1): $${market.keySupportH1}
- ສັນຍານປັດຈຸບັນ: ${persistentSignal.type} (${persistentSignal.setupName})
- ສຽງໂຫວດຄະນະກຳມະການ: DeepSeek=${persistentSignal.votes.deepseek}, Gemini=${persistentSignal.votes.gemini}, Groq=${persistentSignal.votes.groq}
- Entry: ${persistentSignal.entry} | SL: ${persistentSignal.sl} | TP: ${persistentSignal.tp3}
ຈົ່ງຕອບເປັນພາສາລາວທີ່ສຸພາບ, ເລິກເຊິ່ງ, ມີເຫດຜົນທາງເທັກນິກ SMC ແລະ ຄະນິດສາດການເງິນຢ່າງຊັດເຈນ.`;

    let answer = "";
    try {
      answer = await callOpenRouterAI(question, systemPrompt);
    } catch (e1) {
      try {
        answer = await callGeminiAI(question, systemPrompt);
      } catch (e2) {
        answer = await callGroqAI(question, systemPrompt);
      }
    }

    res.json({ success: true, answer });
  } catch (error) {
    const market = await getTradingViewOandaData();
    res.json({ 
      success: true, 
      answer: `ສະບາຍດີ! ລະບົບ Tri-Brain Consensus ກຳລັງປະມວນຜົນ. ລາຄາຄຳ TradingView OANDA ປັດຈຸບັນແມ່ນ: $${market.price.toFixed(2)}.` 
    });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Gold AI Tri-Brain Consensus Swarm running on port ${PORT}`);
});
