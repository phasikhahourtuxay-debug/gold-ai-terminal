(()=>{'use strict';
const el=id=>document.getElementById(id);
const dt=t=>t?new Date(t*1000).toLocaleString('lo-LA',{dateStyle:'medium',timeStyle:'short'}):'—';
const text=(parent,tag,value,cls)=>{const e=document.createElement(tag);e.textContent=value||'—';if(cls)e.className=cls;parent.append(e);return e;};
async function show(kind){
 const news=kind==='news',list=el(news?'newsItems':'calendarItems'),status=el(news?'newsStatus':'calendarStatus');
 list.hidden=false;status.textContent='ກຳລັງດຶງຂໍ້ມູນ...';
 try{
  const r=await fetch(news?'/api/news':'/api/calendar',{cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);
  const data=await r.json();list.replaceChildren();
  const items=data.items||[];
  for(const x of items){const card=document.createElement('article');card.className='news-item';
   if(news){text(card,'strong',x.title_lo||x.title_en);if(!x.title_lo)text(card,'small','ລະບົບແປບໍ່ສຳເລັດ · ສະແດງຫົວຂໍ້ຕົ້ນສະບັບ','muted');text(card,'div',`${x.source} · ${dt(x.published)} · ${(x.topics||[]).join(' / ')}`,'news-meta');}
   else {text(card,'strong',x.title_lo||x.title_en);if(!x.title_lo)text(card,'small','ລະບົບແປບໍ່ສຳເລັດ · ສະແດງຫົວຂໍ້ຕົ້ນສະບັບ','muted');text(card,'div',`USD 🔴 HIGH · ${x.date||'—'} · ${x.time_source||'ເວລາບໍ່ລະບຸ'} (ຕາມແຫຼ່ງຂ່າວ)`,'news-meta');text(card,'div',`Forecast: ${x.forecast||'—'} | Previous: ${x.previous||'—'} | Actual: ${x.actual||'—'}`,'news-meta');text(card,'div','ໂອກາດຂຶ້ນ/ລົງ (%): ຍັງບໍ່ມີຂໍ້ມູນສຳລັບຄຳນວນ','news-meta');}
   if(x.url&&x.url.startsWith('https://')){const a=document.createElement('a');a.href=x.url;a.target='_blank';a.rel='noopener noreferrer';a.textContent='ອ່ານຂ່າວຕົ້ນສະບັບ ↗';card.append(a);}list.append(card);
  }
  if(!items.length)text(list,'p','ຍັງບໍ່ມີຂ່າວທີ່ກົງເງື່ອນໄຂ ຫຼືແຫຼ່ງຂ່າວບໍ່ຕອບກັບ.','muted');
  const errs=Object.entries(data.errors||{}).filter(([k])=>news?k!=='Forex Factory':k==='Forex Factory');
  status.textContent=`${items.length} ລາຍການ · ອັບເດດ ${dt(data.updated)}${errs.length?' · ບາງແຫຼ່ງຂ່າວຂັດຂ້ອງ: '+errs.map(([k])=>k).join(', '):''}${items.some(x=>!x.title_lo)?' · ບາງຫົວຂໍ້ຍັງແປບໍ່ໄດ້ (ກວດ Internet / ລອງໂຫຼດໃໝ່)':''}`;
 }catch(e){status.textContent='ດຶງຂໍ້ມູນບໍ່ສຳເລັດ: '+e.message;}
}
if(el('newsButton'))el('newsButton').addEventListener('click',()=>show('news'));
if(el('calendarButton'))el('calendarButton').addEventListener('click',()=>show('calendar'));
setInterval(()=>{if(el('newsItems')&&!el('newsItems').hidden)show('news');if(el('calendarItems')&&!el('calendarItems').hidden)show('calendar');},180000);
if(el('newsItems'))show('news');if(el('calendarItems'))show('calendar');
})();
