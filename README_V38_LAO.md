# AI Gold Precision Pro V38 — 7TF Chart + EMA200 + AlgoAlpha

## ການປັບປຸງ
- ເພີ່ມກຣາຟ Canvas ໃນເວັບ ສຳລັບ 7 TF: M1 M5 M15 H1 H4 D1 W1.
- ວາດແທ່ງທຽນປິດ, EMA200, AlgoAlpha adaptive trend line ສີຂຽວ/ແດງ ແລະຈຸດປ່ຽນທິດທາງ; ສາມາດ zoom/pan.
- ລະບົບເກັບຂໍ້ມູນ 7TF ໃນ memory ແລະສະແດງ error ຂອງແຕ່ລະ TF.
- `/api/candles?tf=M5` ສົ່ງ OHLC ແລະຄ່າ Indicator ທີ່ຄຳນວນຈາກ Twelve Data.
- ຮັກສາ TradingView Widget ເປັນກຣາຟອ້າງອີງ, ຂ່າວໂລກ, USD calendar, ແລະ Discord EMA200.

## Deploy ໃນ GitHub + Render
1. ແຕກ ZIP ແລ້ວ upload **ໄຟລ໌ທັງໝົດພາຍໃນໂຟນເດີ** ໄປ root ຂອງ GitHub repository.
2. Render runtime: Python 3; Root Directory: ປະໄວ້ວ່າງ.
3. Build Command: `pip install -r requirements-render.txt` (ບໍ່ຈຳເປັນ gunicorn).
4. Start Command: `python server.py`.
5. Environment Variables: `TWELVEDATA_API_KEY`, `DISCORD_WEBHOOK_URL` (ຖ້າໃຊ້), `MARKET_SYMBOL=XAU/USD`, `GOLD_POINT=0.01`, `MARKET_POLL_SECONDS=30`.
6. ກົດ Deploy ແລະກວດ `/api/status`, `/api/signal`, `/api/candles?tf=M5`.

## ຂໍ້ຈຳກັດສຳຄັນ
- ລະບົບດຶງທີລະ TF ທຸກ 30 ວິນາທີ; 7TF ຮອບທຳອິດປະມານ 3 ນາທີ (ຖ້າ API ຕອບປົກກະຕິ). ແຕ່ລະ TF ອັບເດດປະມານທຸກ 3.5 ນາທີ, **ບໍ່ແມ່ນ tick-by-tick real-time**.
- ປັບ `MARKET_POLL_SECONDS` ໃຫ້ເໝາະກັບ API credits/quota; ຖ້າຈຳກັດຕ້ອງເພີ່ມຄ່ານີ້.
- ການຄຳນວນ AlgoAlpha ແມ່ນ Python port ຈາກສູດ Pine ເກົ່າ; ບໍ່ໄດ້ດຶງ Community Indicator ຈາກ TradingView ໂດຍກົງ. ບໍ່ຮັບປະກັນຄ່າກົງ OANDA TradingView 100%.
- ກຣາຟໃຊ້ສະເພາະແທ່ງປິດແລ້ວ, ລາຄາປັດຈຸບັນອາດຊ້າ. API ບາງແຜນອາດບໍ່ຮອງຮັບ 7 TF/500 bars.
- ການທົດສອບໃນເຄື່ອງທົດສອບໃຊ້ຂໍ້ມູນຈຳລອງ, **ບໍ່ໄດ້ທົດສອບກັບ API Key ຈິງ ຫຼື Render ຈິງ**.
- ບໍ່ມີ Auto Trading. ຢ່າອັບໂຫຼດ secrets ເຂົ້າ GitHub.
