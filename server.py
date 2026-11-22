"""V37: Market data API calculations, TradingView chart, no MT5 or alerts."""
import json,os,time,hmac,threading,urllib.request,urllib.error,math
from pathlib import Path
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from urllib.parse import urlparse
import news_service
import market_data
from ema200_engine import ema_series,analyze
from adaptive_trend import calculate as adaptive_calculate
ROOT=Path(__file__).resolve().parent
TOKEN=''
DISCORD=os.environ.get('DISCORD_WEBHOOK_URL','')
TFS=('M1','M5','M15','H1','H4','D1','W1')
TV_TFS={'1':'M1','5':'M5','15':'M15','60':'H1','240':'H4','1D':'D1','D':'D1','1W':'W1','W':'W1'}
lock=threading.RLock();feeds={};episodes={};errors=[]
FRESH=600;REMINDER=180;WINDOW=1200
POINT=float(os.environ.get("GOLD_POINT","0.01"))
POLL_SECONDS=max(90,int(os.environ.get("MARKET_POLL_SECONDS","300")))
provider_state={"last_attempt":None,"last_success":None,"error":None,"last_tf":None}

def notify(message):
    if not DISCORD:return False
    if not DISCORD.startswith(('https://discord.com/api/webhooks/','https://discordapp.com/api/webhooks/')):raise ValueError('Bad Discord URL')
    data=json.dumps({'content':message,'allowed_mentions':{'parse':[]}},ensure_ascii=False).encode()
    req=urllib.request.Request(DISCORD,data=data,headers={'Content-Type':'application/json','User-Agent':'AI-Gold-V36'},method='POST')
    with urllib.request.urlopen(req,timeout=10) as r:return r.status in (200,204)

def update_market(tf,bars,now=None):
    now=time.time() if now is None else now
    if len(bars)<300:raise market_data.ProviderError('At least 300 completed candles required; check plan and history')
    closes=[b['close'] for b in bars]
    e=ema_series(closes)[-1]
    if e is None:raise market_data.ProviderError('EMA200 warmup unavailable')
    adaptive=adaptive_calculate(bars)[-1]
    regime=analyze(bars,tf,point=POINT,current_price=closes[-1])
    last=bars[-1]
    near=abs(last['close']-e)/POINT<=100
    with lock:
        prev=feeds.get(tf)
        if prev and last['time']<prev['time']:return
        feeds[tf]={'timeframe':tf,'symbol':os.environ.get('MARKET_SYMBOL','XAU/USD'),
                   'time':last['time'],'received':now,'trend':adaptive['trend'],
                   'confirmed':True,'near_ema200':near,
                   'distance_points':round(abs(last['close']-e)/POINT,2),
                   'open':last['open'],'high':last['high'],'low':last['low'],
                   'close':last['close'],'ema200':e,'ma20':sum(closes[-20:])/20,
                   'adaptive_line':adaptive['line'],'point':POINT,
                   'regime':regime.get('trend','UNCERTAIN'),'regime_reason':regime.get('reason',''),
                   'candles_used':len(bars),'source':'Twelve Data API'}
        if not near:episodes.pop(tf,None)
        elif tf not in episodes:episodes[tf]={'start':now,'sent':0,'next':now,'symbol':feeds[tf]['symbol']}

def market_worker():
    # One timeframe per request, rotating. Avoid exceeding provider request quotas.
    i=0
    while True:
        tf=TFS[i%len(TFS)];i+=1
        with lock:provider_state['last_attempt']=time.time();provider_state['last_tf']=tf
        try:
            bars=market_data.fetch(tf)
            update_market(tf,bars)
            with lock:provider_state['last_success']=time.time();provider_state['error']=None
        except Exception as exc:
            with lock:provider_state['error']=str(exc)[:240]
        time.sleep(POLL_SECONDS)

def tick(now=None,send=None):
    now=time.time() if now is None else now
    send=notify if send is None else send
    jobs=[]
    with lock:
        for tf,ep in list(episodes.items()):
            r=feeds.get(tf)
            if not r or not r['near_ema200'] or now-r['received']>FRESH or ep['symbol']!=r['symbol']:
                episodes.pop(tf,None);continue
            max_count=3 if tf=='M5' else 7
            if ep['sent']>=max_count or now-ep['start']>=WINDOW:continue
            if now>=ep['next']:
                direction='🟢 ຂາຂຶ້ນ' if r['trend']==1 else '🔴 ຂາລົງ' if r['trend']==-1 else '⚪ ບໍ່ຊັດເຈນ'
                msg=(f'🔔 XAUUSD ໃກ້ EMA200 | {tf} | {r["symbol"]}\n'
                     f'AlgoAlpha: {direction} | {"ແທ່ງປິດ" if r["confirmed"] else "ຄ່າຊົ່ວຄາວ ແທ່ງຍັງບໍ່ປິດ"}\n'
                     f'Close: {r["close"]:.3f} | EMA200: {r["ema200"]:.3f}\n'
                     f'Distance: {r["distance_points"]:.1f}/100 ticks | ຄັ້ງທີ {ep["sent"]+1}/{max_count}\n'
                     'ຂໍ້ມູນຈາກ TradingView; ບໍ່ແມ່ນຄຳແນະນຳເທຣດ')
                jobs.append((tf,msg))
    for tf,msg in jobs:
        try:
            if not send(msg):continue
            with lock:
                ep=episodes.get(tf)
                if ep:ep['sent']+=1;ep['next']=now+REMINDER
        except Exception as exc:
            with lock:errors.append(str(type(exc).__name__));del errors[:-10]

def worker():
    while True:
        tick();time.sleep(15)

class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(ROOT),**kwargs)
    def reply(self,obj,status=200):
        b=json.dumps(obj,ensure_ascii=False,allow_nan=False).encode()
        self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)
    def do_GET(self):
        path=urlparse(self.path).path
        if path=='/api/news':return self.reply(news_service.snapshot('news'))
        if path=='/api/calendar':return self.reply(news_service.snapshot('calendar'))
        if path=='/api/status':
            with lock:
                fresh=[x for x in feeds.values() if time.time()-x['received']<FRESH]
                return self.reply({'connected':bool(fresh),'source':'Twelve Data Market API','provider_error':provider_state['error'],'last_success':provider_state['last_success'],'timeframes_online':len(fresh),'updated':max((x['received'] for x in fresh),default=None)})
        if path=='/api/signal':
            with lock:return self.reply({'timeframes':[dict(feeds[tf],stale=time.time()-feeds[tf]['received']>FRESH) for tf in TFS if tf in feeds]})
        if path=='/api/discord-status':return self.reply({'enabled':bool(DISCORD),'alert_type':'EMA200_ONLY','m5_max_alerts':3,'other_window_minutes':20,'recent_errors':errors})
        if path.startswith('/api/'):return self.reply({'error':'Unknown API'},404)
        return super().do_GET()
    def do_POST(self):
        path=urlparse(self.path).path
        if path=='/api/news-refresh':
            news_service.refresh();return self.reply({'ok':True,'updated':news_service.snapshot('news')['updated']})
        # No public Discord test endpoint: prevents unauthorized users sending messages.
        return self.reply({'error':'Not available'},404)
    def log_message(self,*args):pass

if __name__=='__main__':
    if POINT<=0:raise SystemExit('GOLD_POINT must be positive')
    threading.Thread(target=worker,daemon=True).start()
    threading.Thread(target=market_worker,daemon=True).start()
    threading.Thread(target=news_service.worker,daemon=True).start()
    port=int(os.environ.get('PORT','8765'))
    print('V37 Market Data API server on port',port)
    ThreadingHTTPServer(('0.0.0.0',port),Handler).serve_forever()
