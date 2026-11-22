"""Research-only port of user-supplied AlgoAlpha Pine v6 adaptive trailing trend core.
Uses completed candles, Pine-style RMA ATR, rolling adverse excursion quantiles.
Visual-only Pine pullback profile/dashboard are not trading signals.
"""
from math import isfinite, floor, ceil

def percentile(values, pct):
    if not values:return None
    a=sorted(values);rank=max(0,min(100,pct))/100*(len(a)-1);lo=floor(rank);hi=ceil(rank)
    return a[lo]+(a[hi]-a[lo])*(rank-lo)

def calculate(bars, atr_length=10, fallback=3., quantile=85., memory=150,
              minimum_samples=25, smoothing=5, min_factor=.75, max_factor=6.):
    n=len(bars)
    out=[{'trend':0,'line':None,'bounce':None,'factor':None,'confidence':0.,'flip':False,'reaction':False} for _ in bars]
    if n<atr_length+2:return out
    ups=[];downs=[];atr=None;tr_seed=[];bounce_seed=[];prev_close=None
    lower=upper=None;prev_lower=prev_upper=None;trend=0;extreme=None
    bull_factor=bear_factor=None;prev_bounce=None;prev_line=None
    for i,b in enumerate(bars):
        o,h,l,c=(float(b[k]) for k in ('open','high','low','close'))
        if not all(isfinite(x) for x in (o,h,l,c)) or h<max(o,c,l) or l>min(o,c,h):raise ValueError('Invalid OHLC')
        tr=h-l if prev_close is None else max(h-l,abs(h-prev_close),abs(l-prev_close))
        tr_seed.append(tr)
        if i==atr_length-1:atr=sum(tr_seed)/atr_length
        elif i>=atr_length:atr=(atr*(atr_length-1)+tr)/atr_length
        bounce_seed.append(tr)
        bounce=sum(bounce_seed[-atr_length:])/atr_length if i>=atr_length-1 else None
        bull_conf=min(len(ups)/max(1,min(minimum_samples,memory)),1.)
        bear_conf=min(len(downs)/max(1,min(minimum_samples,memory)),1.)
        def target(samples,conf):
            q=percentile(samples,quantile)
            bounded=max(min_factor,min(max_factor, fallback if q is None else q))
            return fallback*(1-conf)+bounded*conf
        bt=target(ups,bull_conf);dt=target(downs,bear_conf)
        alpha=2/(smoothing+1)
        bull_factor=bt if bull_factor is None else bull_factor+alpha*(bt-bull_factor)
        bear_factor=dt if bear_factor is None else bear_factor+alpha*(dt-bear_factor)
        previous_trend=trend
        if atr is not None and atr>0:
            mid=(h+l)/2
            raw_lower=mid-bull_factor*atr;raw_upper=mid+bear_factor*atr
            lower=raw_lower if prev_lower is None or raw_lower>prev_lower or (prev_close is not None and prev_close<prev_lower) else prev_lower
            upper=raw_upper if prev_upper is None or raw_upper<prev_upper or (prev_close is not None and prev_close>prev_upper) else prev_upper
            if previous_trend==0:trend=1 if c>=mid else -1
            elif previous_trend==1:trend=-1 if c<lower else 1
            else:trend=1 if c>upper else -1
            line=lower if trend==1 else upper
            if trend!=previous_trend or extreme is None:extreme=h if trend==1 else l
            else:extreme=max(extreme,h) if trend==1 else min(extreme,l)
            excursion=max(extreme-l,0)/atr if trend==1 else max(h-extreme,0)/atr
            bounce_line=max(line,min(line+bounce,mid)) if trend==1 else min(line,max(line-bounce,mid))
            reaction=False
            if previous_trend==trend and prev_bounce is not None and prev_line is not None:
                if trend==1:reaction=c>bounce_line and prev_close<=prev_bounce and prev_close>=prev_line
                else:reaction=c<bounce_line and prev_close>=prev_bounce and prev_close<=prev_line
            out[i]={'trend':trend,'line':line,'bounce':bounce_line,'factor':bull_factor if trend==1 else bear_factor,
                    'confidence':bull_conf if trend==1 else bear_conf,'flip':previous_trend!=0 and trend!=previous_trend,
                    'reaction':reaction}
            # Pine pushes sample after calculating this bar's factor and trend.
            if previous_trend==trend:
                samples=ups if trend==1 else downs
                samples.append(excursion)
                if len(samples)>memory:samples.pop(0)
            prev_lower=lower;prev_upper=upper;prev_line=line;prev_bounce=bounce_line
        prev_close=c
    return out
