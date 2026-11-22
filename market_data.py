"""Twelve Data XAU/USD completed OHLC bars; no TradingView data scraping."""
import json,os,urllib.request,urllib.parse,time,datetime
API='https://api.twelvedata.com/time_series'
INTERVAL={'M1':'1min','M5':'5min','M15':'15min','H1':'1h','H4':'4h','D1':'1day','W1':'1week'}
SECONDS={'M1':60,'M5':300,'M15':900,'H1':3600,'H4':14400,'D1':86400,'W1':604800}
class ProviderError(Exception):pass

def fetch(tf,api_key=None,symbol=None,limit=500):
    key=api_key or os.environ.get('TWELVEDATA_API_KEY','')
    if not key:raise ProviderError('TWELVEDATA_API_KEY is not configured')
    symbol=symbol or os.environ.get('MARKET_SYMBOL','XAU/USD')
    query=urllib.parse.urlencode({'symbol':symbol,'interval':INTERVAL[tf], 'outputsize':limit,'apikey':key,'format':'JSON','timezone':'UTC'})
    req=urllib.request.Request(API+'?'+query,headers={'User-Agent':'AI-Gold-Precision-V37/1.0'})
    try:
        with urllib.request.urlopen(req,timeout=18) as resp:obj=json.load(resp)
    except Exception as exc:raise ProviderError('Market data network request failed: '+type(exc).__name__) from exc
    if obj.get('status')=='error' or not isinstance(obj.get('values'),list):raise ProviderError(str(obj.get('message','Provider returned no candles'))[:250])
    bars=[]
    for v in obj['values']:
        try:
            dt=datetime.datetime.fromisoformat(v['datetime'].replace('Z','+00:00'))
            if dt.tzinfo is None:dt=dt.replace(tzinfo=datetime.timezone.utc)
            t=int(dt.timestamp())
            bar={'time':t,'open':float(v['open']),'high':float(v['high']),'low':float(v['low']),'close':float(v['close'])}
            bars.append(bar)
        except (ValueError,TypeError,KeyError):continue
    bars.sort(key=lambda b:b['time'])
    now=time.time()
    # No incomplete current candle: timeframe close is approximate for W1 depending on provider week boundary.
    bars=[b for b in bars if b['time']+SECONDS[tf]<=now-3]
    return [b for i,b in enumerate(bars) if i==0 or b['time']!=bars[i-1]['time']]
