# AI Gold Precision Pro V37 — GitHub + Render (ບໍ່ໃຊ້ MT5 / TradingView Alert)

## ລະບົບ
- TradingView Advanced Chart Widget ສະແດງກຣາຟ OANDA:XAUUSD ພາຍໃນເວັບ.
- Twelve Data API ດຶງ OHLC ສຳລັບ M1/M5/M15/H1/H4/D1/W1. Render ຄຳນວນ EMA200 ດ້ວຍ `ema200_engine.py` ແລະ AlgoAlpha adaptive core ດ້ວຍ `adaptive_trend.py` (ສູດເກົ່າ).
- ບໍ່ແມ່ນການດຶງຄ່າ Community Indicator ຈາກ TradingView ໂດຍກົງ. ໃນ TradingView ເຕັມໜ້າສາມາດໃສ່ Indicator ຂອງເຈົ້າເອງ.
- Discord ແຈ້ງສະເພາະເມື່ອໃກ້ EMA200. ຂ່າວໂລກແລະ USD calendar ບໍ່ສົ່ງ Discord.

## ຕິດຕັ້ງ
1. ສະໝັກ API Key ຈາກ https://twelvedata.com/ ແລະກວດວ່າແຜນຂອງເຈົ້າຮອງຮັບ XAU/USD, 1min, 5min, 15min, 1h, 4h, 1day, 1week ແລະ 500 bars/ຄຳຮ້ອງ. ບາງ interval/asset ອາດຕ້ອງແຜນຈ່າຍ.
2. Upload ໄຟລ໌ທັງໝົດໃສ່ GitHub (ບໍ່ Upload API Key).
3. Render → New → Blueprint → ເລືອກ repo ແລະ `render.yaml`.
4. Render Environment: ຕັ້ງ `TWELVEDATA_API_KEY` ເປັນ secret; ຕັ້ງ `DISCORD_WEBHOOK_URL` ຖ້າຕ້ອງການ.
5. ກວດ `/api/status` ແລະ `/api/signal`; ກວດ provider_error ຖ້າບໍ່ມີຂໍ້ມູນ.

## ຂໍ້ຈຳກັດສຳຄັນ
- ໂປຣແກຣມດຶງ **1 timeframe ທຸກ 300 ວິນາທີ**, ດັ່ງນັ້ນຄົບ 7TF ປະມານ 35 ນາທີ; ບໍ່ແມ່ນ real-time. ການແຈ້ງເຕືອນໃກ້ EMA200 ອາດພາດເຫດການສັ້ນໆ. ປັບ MARKET_POLL_SECONDS ຕາມ API quota ໄດ້.
- ບາງແຜນ API ບໍ່ຮອງຮັບທຸກ timeframe; ຈະສະແດງຂໍ້ຜິດພາດ ບໍ່ປັ້ນຄ່າ.
- ບໍ່ໄດ້ທົດສອບກັບ Twelve Data API ຈິງ ຫຼື Render ຈິງ. ລາຄາອາດຕ່າງຈາກ TradingView OANDA:XAUUSD.
- ການຄຳນວນອີງຕາມແທ່ງປິດແລ້ວ. ການດຶງແທ່ງ W1 ອາດມີຂໍ້ແຕກຕ່າງດ້ານເວລາປິດ.
- ເວັບສາທາລະນະບໍ່ມີ Login; ຢ່າໃສ່ secrets ໃນ repo. Render free service ອາດ sleep/restart, ຂໍ້ມູນຢູ່ memory ຈະຫາຍ.
- ບໍ່ມີ Auto Trading.
