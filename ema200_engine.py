"""Independent, closed-candle XAUUSD EMA200 market-regime scanner.
Research-only classifications; thresholds require broker/timeframe validation.
"""
from math import isfinite
TIMEFRAMES=('M1','M5','M15','H1','H4','D1','W1')
HISTORY={'M1':1000,'M5':1000,'M15':1000,'H1':1000,'H4':1000,'D1':1000,'W1':500}
MIN_BARS=300

def ema_series(closes,period=200):
    out=[None]*len(closes)
    if len(closes)<period:return out
    value=sum(closes[:period])/period
    out[period-1]=value
    k=2/(period+1)
    for i in range(period,len(closes)):
        value+=k*(closes[i]-value);out[i]=value
    return out

def ema200(closes):return ema_series(closes)[-1] if closes else None

def _indicators(bars,p=14):
    tr=[];pos=[];neg=[]
    for prev,b in zip(bars,bars[1:]):
        up=b['high']-prev['high'];down=prev['low']-b['low']
        tr.append(max(b['high']-b['low'],abs(b['high']-prev['close']),abs(b['low']-prev['close'])))
        pos.append(up if up>down and up>0 else 0.)
        neg.append(down if down>up and down>0 else 0.)
    if len(tr)<2*p:return None
    smtr=sum(tr[:p]);smp=sum(pos[:p]);smn=sum(neg[:p]);dx=[];di_plus=di_minus=0.
    for i in range(p-1,len(tr)):
        if i>=p:
            smtr+=tr[i]-smtr/p;smp+=pos[i]-smp/p;smn+=neg[i]-smn/p
        di_plus=100*smp/smtr if smtr else 0
        di_minus=100*smn/smtr if smtr else 0
        den=di_plus+di_minus
        dx.append(100*abs(di_plus-di_minus)/den if den else 0)
    if len(dx)<p:return None
    adx=sum(dx[:p])/p
    for x in dx[p:]:adx+=(x-adx)/p
    return smtr/p,adx,di_plus,di_minus

def _structure(bars,lookback=90,wing=2):
    recent=bars[-lookback:]
    highs=[];lows=[]
    for i in range(wing,len(recent)-wing):
        h=recent[i]['high'];l=recent[i]['low']
        if all(h>recent[j]['high'] for j in range(i-wing,i+wing+1) if j!=i):highs.append(h)
        if all(l<recent[j]['low'] for j in range(i-wing,i+wing+1) if j!=i):lows.append(l)
    if len(highs)<2 or len(lows)<2:
        # Persistent one-way trends may contain no confirmed local pivots.
        # Compare non-overlapping 20-bar ranges instead; never use future bars.
        old=recent[-42:-22];new=recent[-22:-2]
        if len(old)==20 and len(new)==20:
            if max(b['high'] for b in new)>max(b['high'] for b in old) and min(b['low'] for b in new)>min(b['low'] for b in old):return 'HH_HL_RANGE'
            if max(b['high'] for b in new)<max(b['high'] for b in old) and min(b['low'] for b in new)<min(b['low'] for b in old):return 'LH_LL_RANGE'
        return 'INSUFFICIENT_SWINGS'
    if highs[-1]>highs[-2] and lows[-1]>lows[-2]:return 'HH_HL'
    if highs[-1]<highs[-2] and lows[-1]<lows[-2]:return 'LH_LL'
    return 'MIXED'

def _valid_bars(bars):
    """Reject malformed, unordered or duplicated completed OHLC records."""
    last_time = None
    for b in bars:
        try:
            t = int(b['time'])
            o,h,l,c = (float(b[k]) for k in ('open','high','low','close'))
        except (KeyError,TypeError,ValueError,OverflowError):
            return False
        if (last_time is not None and t <= last_time) or t <= 0:
            return False
        if not all(isfinite(v) and v > 0 for v in (o,h,l,c)):
            return False
        if h < max(o,c,l) or l > min(o,c,h):
            return False
        last_time = t
    return True

def analyze(bars,name,point=None,current_price=None):
    result={'timeframe':name,'signal':'WAIT','blocked':True,'trend':'UNCERTAIN',
            'near_ema200':False,'approaching_ema200':False,'proximity_status':'UNAVAILABLE',
            'distance_points':None,'ema200':None,'close':None,'current_price':None,
            'reason':'Insufficient completed MT5 candles','block_reasons':[],
            'bars_used':len(bars),'bars_requested':HISTORY.get(name,1000), 'data_valid':False}
    if name not in TIMEFRAMES:
        result['reason']='Unsupported timeframe'
        return result
    if len(bars)<MIN_BARS:return result
    if not _valid_bars(bars):
        result['reason']='Invalid, duplicated or unsorted MT5 OHLC candles'
        return result
    try:
        closes=[float(b['close']) for b in bars]
        if any(not isfinite(c) for c in closes):return result
        es=ema_series(closes);e=es[-1];prior=es[-11]
        indicators=_indicators(bars)
        if e is None or prior is None or indicators is None:return result
        atr,adx,plus,minus=indicators
        if atr<=0:return result
        slope=(e-prior)/atr
        recent=closes[-21:]
        efficiency=abs(recent[-1]-recent[0])/max(sum(abs(b-a) for a,b in zip(recent,recent[1:])),1e-12)
        # Historical price must be compared to the EMA that existed at that bar.
        crossings=0
        for i in range(len(closes)-20,len(closes)):
            a=closes[i-1]-es[i-1];b=closes[i]-es[i]
            if a*b<0:crossings+=1
        structure=_structure(bars)
        close=closes[-1]
        # Flat/ranging evidence is independent from ambiguous directional evidence.
        ranging=[]
        if adx<22:ranging.append('ADX below 22')
        if efficiency<0.30:ranging.append('Efficiency20 below 0.30')
        if crossings>=3:ranging.append('Repeated EMA200 crosses')
        if abs(slope)<0.20:ranging.append('Flat EMA200 slope')
        up=(slope>=0.20 and close>e and plus>minus and structure in ('HH_HL','HH_HL_RANGE'))
        down=(slope<=-0.20 and close<e and minus>plus and structure in ('LH_LL','LH_LL_RANGE'))
        regime='SIDEWAY' if len(ranging)>=2 else 'UPTREND' if not ranging and up else 'DOWNTREND' if not ranging and down else 'UNCERTAIN'
        try:
            valid_point=point is not None and isfinite(float(point)) and 0<float(point)<1e6
            valid_quote=current_price is not None and isfinite(float(current_price)) and float(current_price)>0
        except (ValueError,TypeError):valid_point=valid_quote=False
        price=float(current_price) if valid_quote else close
        distance=abs(price-e)/float(point) if valid_point and valid_quote else None
        near=distance is not None and distance<=100
        # Do not claim 'approaching' without successive live tick observations.
        result.update(data_valid=True,trend=regime,ema200=round(e,5),close=round(close,5),
            current_price=round(price,5) if valid_quote else None,
            candle_time=int(bars[-1]['time']),atr14=round(atr,5),adx14=round(adx,2),
            plus_di14=round(plus,2),minus_di14=round(minus,2),
            ema_slope_atr=round(slope,3),efficiency20=round(efficiency,3),
            ema_crosses20=crossings,price_structure=structure,
            near_ema200=near,proximity_status='NEAR EMA200' if near else 'FAR FROM EMA200' if distance is not None else 'UNAVAILABLE',
            distance_points=round(distance,1) if distance is not None else None,
            broker_point=float(point) if valid_point else None,
            block_reasons=ranging if ranging else ([] if regime in ('UPTREND','DOWNTREND') else ['Trend indicators or swing structure do not agree']),
            reason='; '.join(ranging) if ranging else ('Trend confirmed by EMA slope, DI and swing structure' if regime in ('UPTREND','DOWNTREND') else 'Trend evidence mixed or incomplete'))
    except (ValueError,TypeError,KeyError,OverflowError) as exc:
        result['reason']='Invalid MT5 candle data: '+str(exc)
    return result

def combine(results):
    return {'signal':'INDEPENDENT','timeframes':results,'confidence':'NOT CALIBRATED'}
