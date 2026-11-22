"""Public RSS/Forex Factory calendar watcher. No Discord integration or trading."""
import os, re, json, time, threading, urllib.request, urllib.error, urllib.parse, xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path
from html import unescape

ROOT=Path(__file__).resolve().parent
CACHE=ROOT/'news_cache.json'
LOCK=threading.RLock()
MAX_AGE=7*86400
REFRESH=max(60,int(os.getenv('NEWS_REFRESH_SECONDS','180')))
SOURCES={
 'Federal Reserve': 'https://www.federalreserve.gov/feeds/press_all.xml',
 'US Treasury': 'https://home.treasury.gov/news/press-releases/rss',
 'EIA Energy': 'https://www.eia.gov/rss/todayinenergy.xml',
 'CISA Cybersecurity': 'https://www.cisa.gov/cybersecurity-advisories/all.xml',
}
# Official publisher sources may change their RSS paths. Each source reports its own errors.
FF_URL=os.getenv('FOREX_FACTORY_CALENDAR_URL','https://nfs.faireconomy.media/ff_calendar_thisweek.xml')
TOPICS={
 'USD / ເສດຖະກິດ': ['dollar','usd','federal reserve','interest rate','inflation','employment','jobs','payroll','fomc','treasury','cpi','pce','gdp','fed'],
 'ນ້ຳມັນ / ພະລັງງານ': ['oil','crude','petroleum','opec','energy','brent','wti','gasoline','strait of hormuz'],
 'ສົງຄາມ / Hormuz': ['hormuz','iran','israel','war','military','missile','ukraine','russia','conflict','red sea','shipping'],
 'Cyber / ທະນາຄານ': ['cyber','hack','ransomware','bank','breach','malware','financial institution','phishing'],
 'Trump / ນະໂຍບາຍ': ['trump','president','tariff','white house','executive order'],
}
state={'news':[],'calendar':[],'updated':None,'errors':{},'last_try':0}
TRANSLATION_CACHE=ROOT/'translation_cache.json'
try: translation_memory=json.loads(TRANSLATION_CACHE.read_text(encoding='utf-8'))
except (OSError, ValueError): translation_memory={}
translation_status={'provider':'Google Translate (keyless fallback)','last_error':None,'translated':0}


def _get(url,timeout=12):
    req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0 (compatible; AI-Gold-Research/1.0)','Accept':'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'})
    with urllib.request.urlopen(req,timeout=timeout) as r:
        if int(r.headers.get('Content-Length','0') or 0)>2_000_000:raise ValueError('Feed too large')
        data=r.read(2_000_001)
        if len(data)>2_000_000:raise ValueError('Feed too large')
        return data

def _txt(node,name):
    x=node.find(name)
    if x is None:
        x=next((e for e in node if e.tag.rsplit('}',1)[-1]==name),None)
    return unescape(''.join(x.itertext()).strip()) if x is not None else ''

def _timestamp(value):
    if not value:return None
    try:
        d=parsedate_to_datetime(value)
        if d.tzinfo is None:d=d.replace(tzinfo=timezone.utc)
        return int(d.timestamp())
    except (ValueError,TypeError):pass
    try:
        d=datetime.fromisoformat(value.replace('Z','+00:00'))
        if d.tzinfo is None:d=d.replace(tzinfo=timezone.utc)
        return int(d.timestamp())
    except ValueError:return None

def _google_cloud_translate(title):
    key=os.getenv('GOOGLE_CLOUD_TRANSLATE_API_KEY','').strip()
    if not key:return None
    payload=json.dumps({'q':title,'source':'en','target':'lo','format':'text'}).encode('utf-8')
    req=urllib.request.Request('https://translation.googleapis.com/language/translate/v2?key='+urllib.parse.quote(key,safe=''),data=payload,headers={'Content-Type':'application/json'},method='POST')
    try:
        with urllib.request.urlopen(req,timeout=9) as r:
            result=json.load(r)['data']['translations'][0]['translatedText']
            return unescape(result).strip() or None
    except Exception:return None

def _keyless_google_translate(title):
    """Best-effort public web translation; unofficial, may be blocked or changed."""
    params=urllib.parse.urlencode({'client':'gtx','sl':'en','tl':'lo','dt':'t','q':title})
    url='https://translate.googleapis.com/translate_a/single?'+params
    req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0','Accept':'application/json'})
    with urllib.request.urlopen(req,timeout=6) as response:
        if response.status!=200:raise RuntimeError('HTTP '+str(response.status))
        payload=json.load(response)
    parts=payload[0] if isinstance(payload,list) and payload else []
    result=''.join(str(p[0]) for p in parts if isinstance(p,list) and p and p[0])
    return result.strip() or None


def _translate(title):
    # Try configured services first, then a no-key best-effort web endpoint.
    if title in translation_memory:return translation_memory[title]
    cloud=_google_cloud_translate(title)
    if cloud:result=cloud
    else:
        result=None
        endpoint=os.getenv('LIBRETRANSLATE_URL','').strip()
        if endpoint and (endpoint.startswith('https://') or endpoint.startswith('http://127.0.0.1:')):
            payload={'q':title,'source':'en','target':'lo','format':'text'}
            key=os.getenv('LIBRETRANSLATE_API_KEY','')
            if key:payload['api_key']=key
            try:
                req=urllib.request.Request(endpoint.rstrip('/')+'/translate',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'},method='POST')
                with urllib.request.urlopen(req,timeout=7) as r:result=json.load(r).get('translatedText')
            except Exception:pass
        if not result:
            try:result=_keyless_google_translate(title)
            except Exception as ex:translation_status['last_error']=str(ex)[:120]
    if result:
        result=unescape(result).strip()
        # Do not mistake an English echo for a successful Lao translation.
        if not any('\u0e80'<=ch<='\u0eff' for ch in result):return None
        translation_memory[title]=result[:350]
        translation_status['translated']+=1
        return translation_memory[title]
    return None


def _translate_pending():
    # Translate cached news as well as fresh articles; keep request count bounded.
    with LOCK:
        pending=([x for x in state['news'] if not x.get('title_lo')][:25]+
                 [x for x in state['calendar'] if not x.get('title_lo')][:15])
    failures=0
    for x in pending:
        translated=_translate(x['title_en'])
        if translated:
            with LOCK:x['title_lo']=translated
            failures=0
        else:
            failures+=1
            if failures>=3:break  # service blocked: avoid 40 slow requests
    try:
        TRANSLATION_CACHE.write_text(json.dumps(translation_memory,ensure_ascii=False),encoding='utf-8')
    except OSError:pass

def parse_rss(data,source,now=None):
    now=int(now or time.time()); root=ET.fromstring(data)
    entries=root.findall('.//item') or [e for e in root.iter() if e.tag.rsplit('}',1)[-1]=='entry']
    out=[]
    for item in entries:
        title=_txt(item,'title').strip();link=_txt(item,'link').strip()
        if not link:
            link=next((x.attrib.get('href','') for x in item if x.tag.rsplit('}',1)[-1]=='link'), '')
        date=_timestamp(_txt(item,'pubDate') or _txt(item,'published') or _txt(item,'updated') or _txt(item,'date'))
        if not (title and link.startswith('https://') and date and now-MAX_AGE<=date<=now+3600):continue
        text=(title+' '+_txt(item,'description')+' '+_txt(item,'summary')).lower()
        tags=[k for k,words in TOPICS.items() if any(w in text for w in words)]
        if not tags:continue
        out.append({'title_en':title[:300],'title_lo':None,'source':source,'url':link,'published':date,'topics':tags})
    return out

def parse_factory(data,now=None):
    now=int(now or time.time());root=ET.fromstring(data);out=[]
    for e in root.iter():
        if e.tag.rsplit('}',1)[-1]!='event':continue
        country=_txt(e,'country').upper();impact=_txt(e,'impact').lower()
        if country not in ('USD','US','UNITED STATES') or impact not in ('high','red'):continue
        title=_txt(e,'title');date=_txt(e,'date');clock=_txt(e,'time')
        # ForexFactory weekly XML uses month-day-year and timezone in its feed; treat dates as
        # calendar dates, NOT an invented exact UTC release time.
        ts=None
        for fmt in ('%m-%d-%Y','%Y-%m-%d','%b %d, %Y'):
            try:ts=int(datetime.strptime(date,fmt).replace(tzinfo=timezone.utc).timestamp());break
            except ValueError:pass
        if ts is None or ts<now-86400 or ts>now+14*86400:continue
        out.append({'title_en':title,'date':date,'time_source':clock,'date_utc_approx':ts,'impact':'HIGH','currency':'USD','forecast':_txt(e,'forecast'),'previous':_txt(e,'previous'),'actual':_txt(e,'actual'),'source':'Forex Factory','url':'https://www.forexfactory.com/calendar','movement_24h_pct':None,'probability_up_pct':None,'probability_down_pct':None})
    return out

def refresh(force=False):
    now=int(time.time())
    with LOCK:
        if not force and now-state['last_try']<REFRESH:return
        state['last_try']=now
    errors={};found=[];calendar=None
    for name,url in SOURCES.items():
        try:found.extend(parse_rss(_get(url),name,now))
        except Exception as ex:errors[name]=str(ex)[:160]
    try:calendar=parse_factory(_get(FF_URL),now)
    except Exception as ex:errors['Forex Factory']=str(ex)[:160]
    with LOCK:
        prior={x['url']:x for x in state['news'] if x['published']>=now-MAX_AGE}
        for x in found:
            old=prior.get(x['url'])
            if old and old.get('title_lo'):x['title_lo']=old['title_lo']
            prior[x['url']]=x
        state['news']=sorted(prior.values(),key=lambda x:x['published'],reverse=True)[:250]
        if calendar is not None:
            old_titles={x['title_en']:x.get('title_lo') for x in state['calendar']}
            for event in calendar:event['title_lo']=old_titles.get(event['title_en'])
            state['calendar']=calendar
        state['calendar']=[x for x in state['calendar'] if x['date_utc_approx']>=now-86400]
        state['errors']=errors;state['updated']=now
    _translate_pending()
    try:
        with LOCK:CACHE.write_text(json.dumps({'news':state['news'],'calendar':state['calendar']},ensure_ascii=False),encoding='utf-8')
    except OSError:pass

def load_cache():
    try:
        data=json.loads(CACHE.read_text(encoding='utf-8'));now=time.time()
        with LOCK:
            state['news']=[x for x in data.get('news',[]) if x.get('published',0)>=now-MAX_AGE]
            state['calendar']=[x for x in data.get('calendar',[]) if x.get('date_utc_approx',0)>=now-86400]
    except (OSError,ValueError,TypeError,KeyError):pass

def snapshot(kind):
    with LOCK:return {'items':list(state['news'] if kind=='news' else state['calendar']),'updated':state['updated'],'errors':dict(state['errors']),'refresh_seconds':REFRESH,'translation_enabled':True,'translation_status':dict(translation_status),'note':'RSS polling is not guaranteed real-time. Probabilities are unavailable without validated historical event studies. No Discord messages are sent.'}

def worker():
    load_cache()
    while True:
        try:refresh()
        except Exception:pass
        time.sleep(REFRESH)
