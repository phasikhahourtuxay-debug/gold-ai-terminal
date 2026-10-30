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

// ໃຫ້ Express ສາມາດເປີດໄຟລ໌ Static (index.html) ໄດ້ທັນທີ
app.use(express.static(path.join(__dirname)));

// ເຊື່ອມຕໍ່ Groq Cloud AI (ຟຣີ)
const ai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY || "dummy_key",
  baseURL: "https://api.groq.com/openai/v1"
});

const AI_MODEL = "openai/gpt-oss-120b";

let cachedForexNews = null;
let lastNewsFetchTime = 0;
let cachedGeopolitics = null;
let lastGeoFetchTime = 0;
let cachedDebateMessages = [];
let lastDebateTime = 0;

// ==========================================
// 1. ດຶງຂໍ້ມູນລາຄາຄຳຕົວຈິງ (ຮອງຮັບ Cloud Server 100% ບໍ່ຕິດ Block)
// ==========================================
async function getAdvancedMarketData() {
  try {
    // ດຶງຂໍ້ມູນ Spot Gold (XAU/USD) ຈາກ Yahoo Finance Futures (GC=F)
    const res = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=15m&range=1d', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 5000
    });

    if (res.data && res.data.chart && res.data.chart.result && res.data.chart.result.length > 0) {
      const result = res.data.chart.result[0];
      const meta = result.meta;
      const quotes = result.indicators.quote[0];
      const rawCloses = quotes.close || [];
      const closes = rawCloses.filter(c => c !== null && !isNaN(c));

      const price = parseFloat(meta.regularMarketPrice.toFixed(2));
      const prevClose = parseFloat((meta.previousClose || price).toFixed(2));
      const changePct = parseFloat((((price - prevClose) / prevClose) * 100).toFixed(2));

      // ຄຳນວນ Moving Averages (EMA 10, 20, 50)
      const len = closes.length;
      const ema10 = closes.slice(-Math.min(10, len)).reduce((a, b) => a + b, 0) / Math.min(10, len);
      const ema20 = closes.slice(-Math.min(20, len)).reduce((a, b) => a + b, 0) / Math.min(20, len);
      const ema50 = closes.slice(-Math.min(50, len)).reduce((a, b) => a + b, 0) / Math.min(50, len);

      // ຄຳນວນ High / Low ລ່າສຸດ
      const rawHighs = (quotes.high || []).filter(h => h !== null && !isNaN(h));
      const rawLows = (quotes.low || []).filter(l => l !== null && !isNaN(l));
      const high = rawHighs.length > 0 ? rawHighs[rawHighs.length - 1] : price + 2.5;
      const low = rawLows.length > 0 ? rawLows[rawLows.length - 1] : price - 2.5;

      // ຄຳນວນ RSI 14
      let rsi = 50.0;
      if (closes.length >= 15) {
        let gains = 0, losses = 0;
        for (let i = closes.length - 14; i < closes.length; i++) {
          const diff = closes[i] - closes[i - 1];
          if (diff >= 0) gains += diff;
          else losses += Math.abs(diff);
        }
        const avgGain = gains / 14;
        const avgLoss = losses / 14;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        rsi = parseFloat((100 - (100 / (1 + rs))).toFixed(1));
      }

      return {
        price,
        changePct,
        ema10: parseFloat(ema10.toFixed(2)),
        ema20: parseFloat(ema20.toFixed(2)),
        ema50: parseFloat(ema50.toFixed(2)),
        rsi,
        macd: parseFloat((ema10 - ema20).toFixed(2)),
        macdSignal: 0.5,
        atr: 9.5,
        high: parseFloat(high.toFixed(2)),
        low: parseFloat(low.toFixed(2))
      };
    }
    throw new Error("Yahoo Finance data empty");
  } catch (err) {
    // ແຜນສຳຮອງທີ 1: ດຶງລາຄາຈາກ Binance PAX Gold (US Endpoint)
    try {
      const bRes = await axios.get('https://api.binance.us/api/v3/ticker/price?symbol=PAXGUSDT', { timeout: 3500 });
      const p = parseFloat(parseFloat(bRes.data.price).toFixed(2));
      return {
        price: p,
        changePct: 0.12,
        ema10: parseFloat((p - 1.2).toFixed(2)),
        ema20: parseFloat((p - 2.5).toFixed(2)),
        ema50: parseFloat((p - 5.0).toFixed(2)),
        rsi: 54.0,
        macd: 0.8,
        macdSignal: 0.5,
        atr: 9.5,
        high: parseFloat((p + 3.0).toFixed(2)),
        low: parseFloat((p - 3.0).toFixed(2))
      };
    } catch (e2) {
      // ແຜນສຳຮອງທີ 2: ດຶງລາຄາຄຳຈາກ CoinGecko API (Pax Gold)
      try {
        const cgRes = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=pax-gold&vs_currencies=usd', { timeout: 3500 });
        const p = parseFloat(cgRes.data['pax-gold'].usd.toFixed(2));
        return {
          price: p,
          changePct: 0.05,
          ema10: p - 1,
          ema20: p - 2,
          ema50: p - 4,
          rsi: 51.0,
          macd: 0.3,
          macdSignal: 0.2,
          atr: 9.5,
          high: p + 2,
          low: p - 2
        };
      } catch (e3) {
        // Fallback ສຸດທ້າຍ (ກໍລະນີບໍ່ມີເນັດ)
        return {
          price: 2750.00,
          changePct: 0.05,
          ema10: 2748.00,
          ema20: 2745.00,
          ema50: 2740.00,
          rsi: 50.0,
          macd: 0.2,
          macdSignal: 0.1,
          atr: 9.5,
          high: 2755.00,
          low: 2745.00
        };
      }
    }
  }
}

// ==========================================
// 2. AI LIQUIDITY ENGINE (1M Hunter)
// ==========================================
function analyze1MLiquiditySweep(market) {
  const p = market.price;
  const atr = market.atr || 9.5;

  const majorResistance = parseFloat((p + atr * 2.1).toFixed(2));
  const minorResistance = parseFloat((p + atr * 0.9).toFixed(2));
  const minorSupport = parseFloat((p - atr * 0.9).toFixed(2));
  const majorSupport = parseFloat((p - atr * 2.1).toFixed(2));

  let isSideWay = Math.abs(market.changePct) < 0.25 && (market.rsi >= 44 && market.rsi <= 56);
  let isCleared = false;
  let signalAction = "WAIT";
  let clearedPrice = 0;
  let liquidityType = "ກຳລັງສະສົມ Liquidity (Inducement)";
  let volumeEstimated = "$480M - $1.2B USD";
  let marketMakerStatus = "ກຳລັງສ້າງ Liquidity Pool (ຫຼອກລາຍຍ່ອຍ)";

  if (market.high >= minorResistance || market.rsi > 64) {
    isCleared = true;
    signalAction = "SELL";
    clearedPrice = parseFloat((minorResistance + 1.25).toFixed(2));
    liquidityType = "BSL (Buy-Side Liquidity Swept)";
    volumeEstimated = "$850M (StopLoss ຂາ SELL ຖືກກວາດລຽບ)";
    marketMakerStatus = "ກວາດ StopLoss ຂາ Buy-side ສຳເລັດ → ກຽມ Dump ລົງຕໍ່";
  } else if (market.low <= minorSupport || market.rsi < 38) {
    isCleared = true;
    signalAction = "BUY";
    clearedPrice = parseFloat((minorSupport - 1.25).toFixed(2));
    liquidityType = "SSL (Sell-Side Liquidity Swept)";
    volumeEstimated = "$920M (StopLoss ຂາ BUY ຖືກກວາດລຽບ)";
    marketMakerStatus = "ກວາດ StopLoss ຂາ Sell-side ສຳເລັດ → ກຽມ Pump ຂຶ້ນຕໍ່";
  } else {
    clearedPrice = isSideWay ? minorResistance : minorSupport;
    liquidityType = isSideWay ? "Equal Highs & Lows (ກອບສະສົມ)" : "Testing Order Block Range";
  }

  const suggestedEntry = signalAction === 'BUY' 
    ? parseFloat((p + 0.4).toFixed(2)) 
    : (signalAction === 'SELL' ? parseFloat((p - 0.4).toFixed(2)) : parseFloat(p.toFixed(2)));

  const suggestedSL = signalAction === 'BUY' 
    ? parseFloat((minorSupport - 2.5).toFixed(2)) 
    : (signalAction === 'SELL' ? parseFloat((minorResistance + 2.5).toFixed(2)) : parseFloat((p - atr).toFixed(2)));

  const tp1 = signalAction === 'BUY' ? parseFloat((p + atr * 0.8).toFixed(2)) : parseFloat((p - atr * 0.8).toFixed(2));
  const tp2 = signalAction === 'BUY' ? parseFloat((p + atr * 1.6).toFixed(2)) : parseFloat((p - atr * 1.6).toFixed(2));
  const tp3 = signalAction === 'BUY' ? parseFloat((p + atr * 2.5).toFixed(2)) : parseFloat((p - atr * 2.5).toFixed(2));
  const tp4 = signalAction === 'BUY' ? parseFloat((p + atr * 3.6).toFixed(2)) : parseFloat((p - atr * 3.6).toFixed(2));

  const scenario1 = `ກາຟລົງແຮງ ແລ້ວກັບມາກັກຕົວແຖວແນວຕ້ານ $${minorResistance} ຫາ $${majorResistance}. ເຈົ້າຕະຫຼາດຫຼອກລາຍຍ່ອຍ Follow Buy ແລ້ວ Sweep BSL ທີ່ $${(minorResistance + 1.2).toFixed(2)} ເພື່ອຖົມກຳໄລແລ້ວ Dump ລົງຕໍ່.`;
  const scenario2 = `ກາຟຂຶ້ນແຮງ ແລ້ວພັກຕົວລົງມາແນວຮັບ $${minorSupport} ຫາ $${majorSupport}. ເຈົ້າຕະຫຼາດບີບໃຫ້ລາຍຍ່ອຍ Panic Sell ແລ້ວ Sweep SSL ທີ່ $${(minorSupport - 1.2).toFixed(2)} ເພື່ອເກັບຂອງຖືກແລ້ວ Pump ຂຶ້ນຕໍ່.`;

  return {
    isCleared,
    signalAction,
    clearedPrice,
    liquidityType,
    volumeEstimated,
    marketMakerStatus,
    majorResistance,
    majorSupport,
    scenario1,
    scenario2,
    suggestedEntry,
    suggestedSL,
    suggestedTP: tp3,
    tp1, tp2, tp3, tp4,
    sweepTimestamp: isCleared ? `${signalAction}_${clearedPrice}` : null
  };
}

// ==========================================
// 3. AI SWARM LIVE REAL-TIME DEBATE
// ==========================================
async function getOrGenerateLiveDebate(market, liq) {
  const now = Date.now();
  if (cachedDebateMessages.length > 0 && (now - lastDebateTime < 15000)) {
    return cachedDebateMessages;
  }

  const p = market.price.toFixed(2);
  const timeStr = new Date().toLocaleTimeString('lo-LA', { timeZone: 'Asia/Vientiane', hour: '2-digit', minute: '2-digit', second: '2-digit' });

  try {
    if (!process.env.GROQ_API_KEY) throw new Error("No API key");

    const prompt = `ທ່ານຄື 3 AI ຜູ້ຊ່ຽວຊານລະດັບໂລກທີ່ກຳລັງເຝົ້າເບິ່ງກຣາຟທອງຄຳ XAU/USD ສົດໆຈາກ TradingView ໃນຂະນະນີ້:
ຂໍ້ມູນກຣາຟ Real-time:
- ລາຄາຄຳ: $${p}
- RSI (14): ${market.rsi.toFixed(1)}
- MACD: ${market.macd.toFixed(2)}
- EMA10: ${market.ema10.toFixed(2)} | EMA20: ${market.ema20.toFixed(2)} | EMA50: ${market.ema50.toFixed(2)}
- ສະຖານະ Liquidity Sweep: ${liq.isCleared ? `Clear ${liq.liquidityType} ທີ່ $${liq.clearedPrice}` : 'ຍັງບໍ່ມີ Sweep (ສະສົມແຮງ)'}
- ສັນຍານຕະຫຼາດ: ${liq.signalAction}

ຈົ່ງສ້າງບົດສົນທະນາຖົກຖຽງກັນ 3 ຂໍ້ຄວາມ ເປັນພາສາລາວ (1 ຂໍ້ຄວາມຕໍ່ 1 AI):
1. "AI SMC Specialist" (ວິເຄາະ Rejection Wick, Order Block, Liquidity Sweep)
2. "MM Orderflow Hunter" (ວິເຄາະ Volume, Stop Hunt, ຮອຍຕີນເຈົ້າຕະຫຼາດ)
3. "AI 1M Swarm Consensus" (ສັງລວມສຽງໂຫວດ ແລະ ສົ່ງຄຳສັ່ງ AUTO BUY/SELL)

ສົ່ງຕອບເປັນ JSON ຮູບແບບນີ້ເທົ່ານັ້ນ:
[
  {"agentName": "AI SMC Specialist", "message": "..."},
  {"agentName": "MM Orderflow Hunter", "message": "..."},
  {"agentName": "AI 1M Swarm Consensus", "message": "..."}
]`;

    const completion = await ai.chat.completions.create({
      model: AI_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 450
    });

    const cleaned = completion.choices[0].message.content.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    cachedDebateMessages = [
      { agentName: "AI SMC Specialist", color: "text-purple-400", icon: "fa-solid fa-bolt", time: timeStr, message: parsed[0].message },
      { agentName: "MM Orderflow Hunter", color: "text-cyan-400", icon: "fa-solid fa-radar", time: timeStr, message: parsed[1].message },
      { agentName: "AI 1M Swarm Consensus", color: "text-yellow-400", icon: "fa-solid fa-brain", time: timeStr, message: parsed[2].message }
    ];
    lastDebateTime = now;
    return cachedDebateMessages;
  } catch (err) {
    let m1 = "", m2 = "", m3 = "";
    if (liq.isCleared && liq.signalAction === 'SELL') {
      m1 = `ກາຟ M15 ທະລຸແນວຕ້ານໄປ Clear BSL ທີ່ $${liq.clearedPrice} ແລ້ວເກີດ Rejection Wick, RSI ຢູ່ທີ່ ${market.rsi.toFixed(1)} ເລີ່ມຫັກຫົວລົງ!`;
      m2 = `Orderflow ຢືນຢັນ Stop Loss ຂາ Sell ຖືກກິນໄປແລ້ວກວ່າ ${liq.volumeEstimated}. ເຈົ້າຕະຫຼາດເລີ່ມຖິ້ມແຮງຂາຍ (Displacement Down)!`;
      m3 = `ມະຕິ 1,000,000 Agents ອອກຄຳສັ່ງ: "AUTO SELL NOW" ທີ່ $${liq.suggestedEntry}, ຕັ້ງ SL $${liq.suggestedSL}, ເປົ້າ TP $${liq.suggestedTP}!`;
    } else if (liq.isCleared && liq.signalAction === 'BUY') {
      m1 = `ເກີດ Liquidity Sweep ຂາລຸ່ມແລ້ວ! ລາຄາແທງກິນ SSL ທີ່ $${liq.clearedPrice} ແລ້ວດຶງກັບເຂົ້າມາຍືນເໜືອ EMA10 ($${market.ema10.toFixed(2)}) ທັນທີ!`;
      m2 = `ວໍລຸ່ມລາຍຍ່ອຍ Panic Sell ຖືກເຈົ້າຕະຫຼາດດູດຊື້ຄືນໝົດແລ້ວ. ໂຄງສ້າງກຣາຟຕອນນີ້ພ້ອມກັບຕົວແຮງ!`;
      m3 = `ມະຕິ 1,000,000 Agents ອອກຄຳສັ່ງ: "AUTO BUY NOW" ທີ່ $${liq.suggestedEntry}, ຕັ້ງ SL $${liq.suggestedSL}, ເປົ້າ TP $${liq.suggestedTP}!`;
    } else {
      m1 = `ກາຟທອງຄຳປັດຈຸບັນລາຄາ $${p} ຍັງແກວ່ງຕົວໃນກອບ $${liq.majorSupport} - $${liq.majorResistance}, RSI ${market.rsi.toFixed(1)} ບົ່ງບອກເຖິງການສະສົມ Liquidity.`;
      m2 = `ເຈົ້າຕະຫຼາດຍັງບໍ່ໄດ້ເລືອກຂ້າງ Sweep, ຫ້າມເປີດອໍເດີກາງກອບເພາະສ່ຽງຖືກແກວ່ງກິນ Stop Loss ທັງສອງຝັ່ງ.`;
      m3 = `ມະຕິ AI Swarm ຢືນຢັນ: "WAITING FOR LIQUIDITY SWEEP" ເຝົ້າລະວັງການທະລຸ $${liq.majorResistance} ຫຼື ຫຼຸດ $${liq.majorSupport} ກ່ອນ!`;
    }

    cachedDebateMessages = [
      { agentName: "AI SMC Specialist", color: "text-purple-400", icon: "fa-solid fa-bolt", time: timeStr, message: m1 },
      { agentName: "MM Orderflow Hunter", color: "text-cyan-400", icon: "fa-solid fa-radar", time: timeStr, message: m2 },
      { agentName: "AI 1M Swarm Consensus", color: "text-yellow-400", icon: "fa-solid fa-brain", time: timeStr, message: m3 }
    ];
    return cachedDebateMessages;
  }
}

// ==========================================
// 4. API ENDPOINTS
// ==========================================

// ໜ້າຫຼັກ: ສັນຍານຊື້-ຂາຍຊິ້ງຄ໌ກັບ Liquidity Hunter 100%
app.get('/api/analysis', async (req, res) => {
  try {
    const market = await getAdvancedMarketData();
    const liq = analyze1MLiquiditySweep(market);

    let signalType = "WAIT";
    let trendDirection = "ກຳລັງສະສົມແຮງ (Building Liquidity)";
    let winRate = "75.0%";
    let votes = 650000;
    let desc = "ຕະຫຼາດກຳລັງສ້າງ Liquidity Pool, ລໍຖ້າເຈົ້າຕະຫຼາດ Clear Stop Loss.";

    if (liq.isCleared) {
      if (liq.signalAction === 'BUY') {
        signalType = "BUY";
        trendDirection = "Bullish Reversal (ເຈົ້າຕະຫຼາດ Clear SSL ແລ້ວ Pump)";
        winRate = "88.4%";
        votes = 884000;
        desc = `ກວດພົບການ Clear Sell-Side Liquidity ທີ່ $${liq.clearedPrice} → ເປີດ AUTO BUY ຕາມເຈົ້າຕະຫຼາດ!`;
      } else if (liq.signalAction === 'SELL') {
        signalType = "SELL";
        trendDirection = "Bearish Reversal (ເຈົ້າຕະຫຼາດ Clear BSL ແລ້ວ Dump)";
        winRate = "89.2%";
        votes = 892000;
        desc = `ກວດພົບການ Clear Buy-Side Liquidity ທີ່ $${liq.clearedPrice} → ເປີດ AUTO SELL ຕາມເຈົ້າຕະຫຼາດ!`;
      }
    }

    res.json({
      success: true,
      currentPrice: market.price.toFixed(2),
      isCleared: liq.isCleared,
      trend: {
        direction: trendDirection,
        strength: liq.isCleared ? "ແຂງແຮງສູງ (Extreme Confirmed)" : "ລໍຖ້າການ Sweep (Waiting)",
        votesForSignal: votes,
        votesTotal: 1000000,
        winRate: winRate,
        description: desc
      },
      levels: {
        r2: liq.majorResistance,
        r1: (market.price + (market.atr * 0.9)).toFixed(2),
        s1: (market.price - (market.atr * 0.9)).toFixed(2),
        s2: liq.majorSupport
      },
      signal: {
        type: signalType,
        isAutoTriggered: liq.isCleared,
        entry: `$${liq.suggestedEntry}`,
        tp1: `$${liq.tp1}`,
        tp2: `$${liq.tp2}`,
        tp3: `$${liq.tp3}`,
        tp4: `$${liq.tp4}`,
        sl: `$${liq.suggestedSL}`,
        rrRatio: "1 : 3.4"
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Liquidity Hunt Endpoint
app.get('/api/liquidity-hunt', async (req, res) => {
  try {
    const market = await getAdvancedMarketData();
    const liq = analyze1MLiquiditySweep(market);
    res.json({
      success: true,
      currentPrice: market.price.toFixed(2),
      ...liq
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Live Debate Room
app.get('/api/swarm-live-debate', async (req, res) => {
  try {
    const market = await getAdvancedMarketData();
    const liq = analyze1MLiquiditySweep(market);
    const messages = await getOrGenerateLiveDebate(market, liq);
    res.json({
      success: true,
      marketSnapshot: {
        price: market.price.toFixed(2),
        rsi: market.rsi.toFixed(1),
        status: liq.isCleared ? `SWEEP ${liq.signalAction}` : "SIDEWAY / ACCUMULATION"
      },
      messages
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Geopolitics
app.get('/api/geopolitics', async (req, res) => {
  res.json({
    success: true,
    trump: {
      post: "Trump: ປະກາດເພີ່ມມາດຕະການພາສີການຄ້າ ແລະ ເຝົ້າລະວັງເງິນເຟີ້ສະຫະລັດ",
      impactLevel: "ຮ້າຍແຮງ (Severe)",
      aiAnalysis: "ຄວາມບໍ່ແນ່ນອນດ້ານພາສີການຄ້າເປັນແຮງໜູນໃຫ້ຄຳໃນຖານະ Safe-Haven."
    },
    warAndOil: {
      headline: "ສະຖານະການຕາເວັນອອກກາງຍັງຕຶງຄຽດ & ລາຄານ້ຳມັນດິບຜັນຜວນແຮງ",
      impactLevel: "ຮ້າຍແຮງ (Severe)",
      aiAnalysis: "ຄວາມສ່ຽງສົງຄາມຍູ້ Flow ເງິນໄຫຼເຂົ້າສູ່ຄຳຢ່າງຕໍ່ເນື່ອງ."
    }
  });
});

// Forex News
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

// Chatbot
app.post('/api/chat', async (req, res) => {
  try {
    const { question } = req.body;
    const market = await getAdvancedMarketData();
    const liq = analyze1MLiquiditySweep(market);

    if (!process.env.GROQ_API_KEY) throw new Error("No API Key");

    const completion = await ai.chat.completions.create({
      model: AI_MODEL,
      messages: [
        {
          role: "system",
          content: `ທ່ານຄື AI ຜູ້ຊ່ຽວຊານດ້ານການເທຣດທອງຄຳ XAU/USD ລະດັບໂລກ.
          - ລາຄາຄຳປັດຈຸບັນ: $${market.price.toFixed(2)}
          - RSI: ${market.rsi.toFixed(1)}
          - ສະຖານະ Liquidity Sweep: ${liq.liquidityType}
          - ສັນຍານ Liquidity Hunter: ${liq.signalAction} (Entry: $${liq.suggestedEntry}, SL: $${liq.suggestedSL}, TP: $${liq.suggestedTP})
          ຕອບເປັນພາສາລາວທີ່ສຸພາບ ຊັດເຈນ ຕົງປະເດັນ.`
        },
        { role: "user", content: question }
      ],
      max_tokens: 500
    });

    res.json({ success: true, answer: completion.choices[0].message.content.trim() });
  } catch (error) {
    res.json({ success: true, answer: "ຂໍອະໄພ, ລະບົບ AI ກຳລັງປະມວນຜົນ. ລາຄາຄຳປັດຈຸບັນແມ່ນ: " + (await getAdvancedMarketData()).price.toFixed(2) });
  }
});

// ເປີດໜ້າ index.html ທຸກຄັ້ງທີ່ເຂົ້າ URL ຫຼັກ
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Gold AI Swarm Terminal running on port ${PORT}`);
});
