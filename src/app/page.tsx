'use client';
import { useEffect, useState } from 'react';
import { Line } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip } from 'chart.js';
import type { FunnelRow } from '@/lib/storage';
import { cdrQuery, conversionQuery } from '@/lib/superset-queries';
ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip);

const SUPERSET_LOGIN = 'https://insurance-analytic-platform.paytminsurance.co.in/sqllab/';

function todayStr() { return new Date().toISOString().slice(0,10); }
function yesterdayStr() { const d=new Date(); d.setDate(d.getDate()-1); return d.toISOString().slice(0,10); }
function pct(a:number,b:number){return b>0?Math.round(a/b*1000)/10:0;}
function fmtPct(v:number){return Math.round(v*1000)/10+'%';}
function weekStart(n=0){const d=new Date();const dow=d.getDay()||7;d.setDate(d.getDate()-dow+1-n*7);return d.toISOString().slice(0,10);}
function sumRows(rows:FunnelRow[]){
  const n=(k:keyof FunnelRow)=>rows.reduce((s,r)=>s+(Number(r[k])||0),0);
  return{bs:n('bot_sent'),bd:n('bot_dialled'),bc:n('bot_connected'),bq:n('bot_qualified'),
    hi:n('high_intent'),mi:n('medium_intent'),li:n('low_intent'),
    cs:n('cc_sent'),ca:n('cc_attempted'),cc:n('cc_connected'),cv:n('cc_converted'),
    churn:n('cc_churn'),coc:n('cc_conversion_on_connect')};
}

const C={
  blue:'#185FA5',blueM:'#378ADD',blueL:'#E6F1FB',
  green:'#27500A',greenM:'#639922',greenL:'#EAF3DE',
  amber:'#854F0B',amberL:'#FAEEDA',
  red:'#A32D2D',redL:'#FCEBEB',
  text:'#1a1a18',text2:'#6b6b67',text3:'#9b9b96',
  border:'#e2e1db',borderL:'#eeede8',bg:'#f5f5f3',surface:'#fff',
};

export default function Dashboard(){
  const[rows,setRows]=useState<FunnelRow[]>([]);
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState('');
  const[tab,setTab]=useState('funnel');
  const[fMode,setFMode]=useState<'day'|'range'>('day');
  const[fDay,setFDay]=useState(todayStr());
  const[fFrom,setFFrom]=useState(weekStart(0));
  const[fTo,setFTo]=useState(todayStr());
  const[tMetric,setTMetric]=useState('bot_sent');
  const[tPeriod,setTPeriod]=useState('14');
  const[wowEnd,setWowEnd]=useState(todayStr());
  const[lFrom,setLFrom]=useState(weekStart(4));
  const[lTo,setLTo]=useState(todayStr());
  // Enser image upload
  const[eDate,setEDate]=useState(todayStr());
  const[eImage,setEImage]=useState<File|null>(null);
  const[ePreview,setEPreview]=useState('');
  const[eParsed,setEParsed]=useState<any>(null);
  const[eSaving,setESaving]=useState(false);
  const[eSaved,setESaved]=useState('');
  // Backfill
  const[bfDate,setBfDate]=useState(todayStr());
  const[bfStatus,setBfStatus]=useState('');
  const[bfLoading,setBfLoading]=useState(false);
  // Superset sync
  const[ssLoading,setSsLoading]=useState(false);
  const[ssStatus,setSsStatus]=useState('');
  const[ssDate,setSsDate]=useState(yesterdayStr());
  const[ssAuthUrl,setSsAuthUrl]=useState('');

  const load=()=>{
    fetch('/api/data').then(r=>r.json())
      .then(d=>{if(d.error)setError(d.error);else setRows(d.rows||[]);})
      .catch(e=>setError(e.message)).finally(()=>setLoading(false));
  };
  useEffect(()=>{load();},[]);

  const uploadEnser = async () => {
    if (!eImage) return;
    setESaving(true); setESaved('');
    try {
      const fd = new FormData();
      fd.append('image', eImage);
      fd.append('date', eDate);
      const res = await fetch('/api/enser', { method: 'POST', body: fd });
      const d = await res.json();
      if (d.success) { setESaved('✓ Saved!'); setEParsed(d.parsed); load(); }
      else setESaved('Error: ' + d.error);
    } finally { setESaving(false); }
  };

  const runBackfill=async()=>{
    setBfLoading(true);setBfStatus('Running...');
    try{
      const res=await fetch(`/api/fetch-data?date=${bfDate}`);
      const d=await res.json();
      setBfStatus(d.success?`✓ Done for ${d.date}`:`✗ ${d.message||d.error}`);
      if(d.success)load();
    }catch(e:any){setBfStatus('Error: '+e.message);}
    finally{setBfLoading(false);}
  };

  const syncSuperset=async()=>{
    setSsLoading(true);
    setSsStatus('Checking the Superset browser bridge…');
    try{
      const extensionCall=(type:string,payload:any={},timeout=300000)=>new Promise<any>((resolve,reject)=>{
        const id=Math.random().toString(36).slice(2);
        const timer=setTimeout(()=>{window.removeEventListener('message',handler);reject(new Error(type==='PING'?'EXTENSION_NOT_FOUND':'Superset bridge timed out'));},timeout);
        function handler(event:MessageEvent){
          if(event.source!==window||event.data?.source!=='superset-bridge'||event.data?.id!==id)return;
          clearTimeout(timer);window.removeEventListener('message',handler);
          event.data.success?resolve(event.data.data):reject(new Error(event.data.error||'Superset bridge failed'));
        }
        window.addEventListener('message',handler);
        window.postMessage({source:'voicebot-dashboard',type,id,...payload},'*');
      });
      let extensionReady=false;
      try{await extensionCall('PING',{},1200);extensionReady=true;}catch{}
      if(extensionReady){
        const next=new Date(`${ssDate}T00:00:00Z`);next.setUTCDate(next.getUTCDate()+1);
        const nextDate=next.toISOString().slice(0,10);
        setSsStatus('Running conversion query in Superset…');
        const conversionRows=await extensionCall('RUN_QUERY',{sql:conversionQuery(ssDate,nextDate)});
        setSsStatus('Running CDR query in Superset…');
        const cdrRows=await extensionCall('RUN_QUERY',{sql:cdrQuery(ssDate,nextDate)});
        const c={cc_sent:Number(cdrRows?.[0]?.cc_sent)||0,cc_attempted:Number(cdrRows?.[0]?.cc_attempted)||0,cc_connected:Number(cdrRows?.[0]?.cc_connected)||0,cc_converted:Number(conversionRows?.[0]?.cc_converted)||0};
        const save=await fetch('/api/enser',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({date:ssDate,...c,cc_churn:0,cc_conversion_on_connect:c.cc_connected>0?c.cc_converted/c.cc_connected*100:0})});
        const saved=await save.json();if(!save.ok)throw new Error(saved.error||'Could not save Superset data');
        setSsAuthUrl('');setSsStatus(`✓ ${ssDate}: ${c.cc_sent} received · ${c.cc_attempted} attempted · ${c.cc_connected} connected · ${c.cc_converted} converted`);load();return;
      }
      if(window.location.hostname!=='127.0.0.1'&&window.location.hostname!=='localhost')throw new Error('Chrome extension not detected. Install the Voicebot Superset Bridge, then reload this page.');
      const response=await fetch('/api/superset/sync',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({date:ssDate}),
      });
      const data=await response.json();
      if(response.status===401&&data.authUrl){
        setSsAuthUrl(data.authUrl);
        setSsStatus('Sign in to Superset in the new tab, then return here and click Continue sync.');
        return;
      }
      if(!response.ok)throw new Error(data.error||'Superset sync failed');
      setSsAuthUrl('');
      const c=data.counts;
      setSsStatus(`✓ ${ssDate}: ${c.cc_sent} received · ${c.cc_attempted} attempted · ${c.cc_connected} connected · ${c.cc_converted} converted`);
      load();
    } catch(e: any) {
      if(String(e.message).includes('SUPERSET_AUTH_REQUIRED')||String(e.message).includes('SUPERSET_TAB_REQUIRED')){
        setSsAuthUrl(SUPERSET_LOGIN);setSsStatus('Open Superset SQL Lab in another tab and sign in. Keep that tab open, then click Continue sync.');return;
      }
      setSsStatus('Error: '+e.message);
    } finally {
      setSsLoading(false);
    }
  };

  const lastDate=rows.length?rows[rows.length-1].date:'—';
  const fRows=fMode==='day'?rows.filter(r=>r.date===fDay):rows.filter(r=>r.date>=fFrom&&r.date<=fTo);
  const fs=sumRows(fRows);
  let tRows=[...rows];
  if(tPeriod!=='all'){const c=new Date();c.setDate(c.getDate()-(+tPeriod));tRows=tRows.filter(r=>r.date>=c.toISOString().slice(0,10));}
  const MLABELS:Record<string,string>={
    bot_sent:'Bot sent',bot_dialled:'Bot dialled',bot_connected:'Bot connected',bot_qualified:'Bot qualified',
    high_intent:'High intent',medium_intent:'Medium intent',
    cc_sent:'CC received',cc_attempted:'CC attempted',cc_connected:'CC connected',cc_converted:'CC converted',
    cc_churn:'CC churn',bot_connect_rate:'Bot connect %',bot_qualify_rate:'Bot qualify %',
    cc_connect_rate:'CC connect %',cc_convert_rate:'CC convert %',e2e_rate:'End-to-end %',
    cc_conversion_on_connect:'CC conv on connect %',
  };
  const isRate=['bot_connect_rate','bot_qualify_rate','cc_connect_rate','cc_convert_rate','e2e_rate','cc_conversion_on_connect'].includes(tMetric);
  const tLabels=tRows.map(r=>r.date.slice(5));
  const tVals=tRows.map(r=>{const v=Number((r as any)[tMetric])||0;return isRate?Math.round(v*10000)/100:v;});
  const wEnd=new Date(wowEnd);const wSt=new Date(wEnd);wSt.setDate(wEnd.getDate()-6);
  const pwEnd=new Date(wSt);pwEnd.setDate(wSt.getDate()-1);const pwSt=new Date(pwEnd);pwSt.setDate(pwEnd.getDate()-6);
  const fmt=(d:Date)=>d.toISOString().slice(0,10);
  const sc=sumRows(rows.filter(r=>r.date>=fmt(wSt)&&r.date<=fmt(wEnd)));
  const sp=sumRows(rows.filter(r=>r.date>=fmt(pwSt)&&r.date<=fmt(pwEnd)));
  const lRows=[...rows].filter(r=>r.date>=lFrom&&r.date<=lTo).reverse();

  function exportCSV(){
    if(!lRows.length)return;
    const keys=Object.keys(lRows[0]);
    const csv=[keys.join(','),...lRows.map(r=>keys.map(k=>(r as any)[k]).join(','))].join('\n');
    const a=document.createElement('a');a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
    a.download=`funnel_${lFrom}_${lTo}.csv`;a.click();
  }

  const sp_=(s:React.CSSProperties):React.CSSProperties=>s;

  const card   =sp_({background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:'16px 18px'});
  const cardT  =sp_({fontSize:11,fontWeight:600,textTransform:'uppercase',letterSpacing:'.06em',color:C.text3,marginBottom:14,display:'flex',alignItems:'center',gap:8});
  const kpi    =sp_({background:C.surface,border:`1px solid ${C.border}`,borderRadius:12,padding:'12px 14px'});
  const inp    =sp_({fontSize:13,padding:'6px 10px',border:`1px solid ${C.border}`,borderRadius:8,background:C.surface,color:C.text,outline:'none'});
  const btn    =sp_({padding:'6px 14px',fontSize:12,border:`1px solid ${C.border}`,borderRadius:8,background:C.surface,cursor:'pointer',color:C.text});
  const btnP   =sp_({padding:'8px 18px',fontSize:13,border:'none',borderRadius:8,background:C.blue,color:'#fff',cursor:'pointer',fontWeight:500});
  const bBot   =sp_({display:'inline-block',padding:'2px 8px',borderRadius:20,fontSize:10,fontWeight:600,background:C.blueL,color:C.blue});
  const bCC    =sp_({display:'inline-block',padding:'2px 8px',borderRadius:20,fontSize:10,fontWeight:600,background:C.greenL,color:C.green});
  const igL    =sp_({fontSize:12,color:C.text2,display:'block',marginBottom:3});
  const igI    =sp_({...inp,width:'100%',marginTop:0});

  if(loading)return(
    <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100vh',color:C.text3,gap:10}}>
      <div style={{width:16,height:16,border:`2px solid ${C.border}`,borderTopColor:C.blueM,borderRadius:'50%',animation:'spin .7s linear infinite'}}/>
      Loading...
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}*{box-sizing:border-box;margin:0;padding:0}`}</style>
    </div>
  );

  const TABS=[{id:'funnel',label:'Funnel'},{id:'trends',label:'Trends'},{id:'wow',label:'Week on week'},{id:'log',label:'Log'},{id:'upload',label:'+ Data',small:true}];

  return(
    <>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;background:${C.bg};color:${C.text}}`}</style>
      {/* Topbar */}
      <div style={{background:C.surface,borderBottom:`1px solid ${C.border}`,padding:'0 24px',display:'flex',alignItems:'center',justifyContent:'space-between',height:52,position:'sticky',top:0,zIndex:100}}>
        <div style={{fontSize:13,fontWeight:600}}>Paytm Insurance <span style={{color:C.blue}}>/ Voicebot Funnel</span></div>
        <div style={{fontSize:11,color:C.text3,background:C.bg,padding:'3px 8px',borderRadius:20}}>Last data: {lastDate}</div>
      </div>
      {/* Nav */}
      <div style={{background:C.surface,borderBottom:`1px solid ${C.border}`,padding:'0 24px',display:'flex',overflowX:'auto'}}>
        {TABS.map(t=>(
          <div key={t.id} onClick={()=>setTab(t.id)} style={{padding:'10px 16px',fontSize:t.small?11:13,color:tab===t.id?C.blue:t.small?C.text3:C.text2,cursor:'pointer',borderBottom:tab===t.id?`2px solid ${C.blue}`:'2px solid transparent',marginBottom:-1,fontWeight:tab===t.id?500:400,whiteSpace:'nowrap'}}>
            {t.label}
          </div>
        ))}
      </div>
      <div style={{padding:'20px 24px',maxWidth:1200,margin:'0 auto'}}>
        {error&&<div style={{background:C.redL,border:`1px solid #F7C1C1`,borderRadius:8,padding:'12px 16px',fontSize:13,color:C.red,marginBottom:16}}>{error}</div>}

        {/* FUNNEL */}
        {tab==='funnel'&&<>
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:16,flexWrap:'wrap'}}>
            <span style={{fontSize:12,color:C.text2}}>View</span>
            <select style={inp} value={fMode} onChange={e=>setFMode(e.target.value as any)}>
              <option value="day">Single day</option><option value="range">Date range</option>
            </select>
            {fMode==='day'&&<input style={inp} type="date" value={fDay} onChange={e=>setFDay(e.target.value)}/>}
            {fMode==='range'&&<><input style={inp} type="date" value={fFrom} onChange={e=>setFFrom(e.target.value)}/><span style={{fontSize:12,color:C.text3}}>to</span><input style={inp} type="date" value={fTo} onChange={e=>setFTo(e.target.value)}/></>}
          </div>
          {/* KPIs */}
          <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:10,marginBottom:16}}>
            {[
              {l:'Bot connect rate',v:pct(fs.bc,fs.bd)+'%',s:`${fs.bc.toLocaleString()} / ${fs.bd.toLocaleString()}`},
              {l:'Bot qualify rate',v:pct(fs.bq,fs.bc)+'%',s:`${fs.bq.toLocaleString()} qualified`},
              {l:'CC convert rate',v:pct(fs.cv,fs.cc)+'%',s:`${fs.cv.toLocaleString()} / ${fs.cc.toLocaleString()}`},
              {l:'Conv on connect',v:fmtPct(fRows.length?fRows.reduce((s,r)=>s+(r.cc_conversion_on_connect||0),0)/fRows.length:0),s:'avg across period'},
              {l:'End-to-end',v:pct(fs.cv,fs.bs)+'%',s:`${fs.cv.toLocaleString()} from ${fs.bs.toLocaleString()}`},
            ].map(k=>(
              <div key={k.l} style={kpi}>
                <div style={{fontSize:10,color:C.text3,textTransform:'uppercase',letterSpacing:'.05em',marginBottom:5}}>{k.l}</div>
                <div style={{fontSize:22,fontWeight:500,lineHeight:1}}>{k.v}</div>
                <div style={{fontSize:11,color:C.text3,marginTop:3}}>{k.s}</div>
              </div>
            ))}
          </div>
          {/* Full funnel */}
          <div style={card}>
            {!rows.length
              ? <div style={{textAlign:'center',padding:40,color:C.text3}}>No data yet — add data via the "+ Data" tab</div>
              : fMode==='range'
                ? <>
                    {/* DATE RANGE — day-on-day table */}
                    <div style={{overflowX:'auto'}}>
                      <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                        <thead>
                          <tr style={{borderBottom:`2px solid ${C.border}`}}>
                            <th style={{textAlign:'left',padding:'8px 10px',fontWeight:600,color:C.text2,minWidth:140,position:'sticky',left:0,background:C.surface}}>Stage</th>
                            {fRows.map(r=>(
                              <th key={r.date} style={{textAlign:'right',padding:'8px 10px',fontWeight:500,color:C.text2,whiteSpace:'nowrap'}}>{r.date.slice(5)}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {/* Bot rows */}
                          {[
                            {l:'Leads sent',      k:'bot_sent',      color:C.blueL,  badge:'bot'},
                            {l:'Leads dialled',   k:'bot_dialled',   color:'',       badge:''},
                            {l:'Leads connected', k:'bot_connected', color:'',       badge:''},
                            {l:'Leads qualified', k:'bot_qualified', color:'',       badge:''},
                            {l:'High intent',     k:'high_intent',   color:'',       badge:''},
                            {l:'Medium intent',   k:'medium_intent', color:'',       badge:''},
                          ].map((row,ri)=>(
                            <tr key={row.k} style={{borderBottom:`1px solid ${C.borderL}`,background:ri===0?C.blueL+'44':''}}>
                              <td style={{padding:'7px 10px',fontWeight:ri===0?600:400,color:ri===0?C.blue:C.text,position:'sticky',left:0,background:ri===0?C.blueL+'44':C.surface}}>
                                {ri===0&&<span style={{...{display:'inline-block',padding:'1px 6px',borderRadius:20,fontSize:9,fontWeight:700,background:C.blueL,color:C.blue,marginRight:6}}}>BOT</span>}
                                {row.l}
                              </td>
                              {fRows.map(r=>{
                                const v=Number((r as any)[row.k])||0;
                                const prev=ri>0?Number((r as any)[(['bot_sent','bot_dialled','bot_connected','bot_qualified','bot_qualified','bot_qualified'][ri-1] as any)])||0:0;
                                return(
                                  <td key={r.date} style={{padding:'7px 10px',textAlign:'right',fontVariantNumeric:'tabular-nums'}}>
                                    {v.toLocaleString()}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                          {/* Connect & qualify rates */}
                          {[
                            {l:'Connect rate',k:'bot_connect_rate',isRate:true},
                            {l:'Qualify rate',k:'bot_qualify_rate',isRate:true},
                          ].map(row=>(
                            <tr key={row.k} style={{borderBottom:`1px solid ${C.borderL}`,background:C.bg}}>
                              <td style={{padding:'7px 10px',color:C.text3,fontStyle:'italic',position:'sticky',left:0,background:C.bg}}>{row.l}</td>
                              {fRows.map(r=>(
                                <td key={r.date} style={{padding:'7px 10px',textAlign:'right',color:C.blue,fontVariantNumeric:'tabular-nums'}}>
                                  {Math.round(Number((r as any)[row.k])*1000)/10}%
                                </td>
                              ))}
                            </tr>
                          ))}
                          {/* Gap row */}
                          <tr style={{borderBottom:`2px solid ${C.amber}`,background:C.amberL+'66'}}>
                            <td style={{padding:'7px 10px',fontWeight:600,color:C.amber,position:'sticky',left:0,background:C.amberL+'66'}}>↓ Gap (Qual → CC)</td>
                            {fRows.map(r=>{
                              const gap=(r.bot_qualified||0)-(r.cc_sent||0);
                              return(
                                <td key={r.date} style={{padding:'7px 10px',textAlign:'right',color:C.amber,fontWeight:500}}>
                                  {r.cc_sent>0?gap.toLocaleString():'—'}
                                </td>
                              );
                            })}
                          </tr>
                          {/* CC rows */}
                          {[
                            {l:'CC received',  k:'cc_sent',      isFirst:true},
                            {l:'CC attempted', k:'cc_attempted', isFirst:false},
                            {l:'CC connected', k:'cc_connected', isFirst:false},
                            {l:'CC converted', k:'cc_converted', isFirst:false},
                          ].map((row,ri)=>(
                            <tr key={row.k} style={{borderBottom:`1px solid ${C.borderL}`,background:ri===0?C.greenL+'44':''}}>
                              <td style={{padding:'7px 10px',fontWeight:ri===0?600:400,color:ri===0?C.green:C.text,position:'sticky',left:0,background:ri===0?C.greenL+'44':C.surface}}>
                                {ri===0&&<span style={{...{display:'inline-block',padding:'1px 6px',borderRadius:20,fontSize:9,fontWeight:700,background:C.greenL,color:C.green,marginRight:6}}}>CC</span>}
                                {row.l}
                              </td>
                              {fRows.map(r=>(
                                <td key={r.date} style={{padding:'7px 10px',textAlign:'right',fontVariantNumeric:'tabular-nums'}}>
                                  {r.cc_sent>0?(Number((r as any)[row.k])||0).toLocaleString():'—'}
                                </td>
                              ))}
                            </tr>
                          ))}
                          {/* CC rates */}
                          {[
                            {l:'CC convert rate',    k:'cc_convert_rate'},
                            {l:'Conv on connect %',  k:'cc_conversion_on_connect'},
                            {l:'Churn',              k:'cc_churn', noRate:true},
                            {l:'End-to-end %',       k:'e2e_rate'},
                          ].map(row=>(
                            <tr key={row.k} style={{borderBottom:`1px solid ${C.borderL}`,background:C.bg}}>
                              <td style={{padding:'7px 10px',color:C.text3,fontStyle:'italic',position:'sticky',left:0,background:C.bg}}>{row.l}</td>
                              {fRows.map(r=>(
                                <td key={r.date} style={{padding:'7px 10px',textAlign:'right',color:C.green,fontVariantNumeric:'tabular-nums'}}>
                                  {r.cc_sent>0
                                    ? (row as any).noRate
                                      ? Number((r as any)[row.k]).toFixed(1)
                                      : Math.round(Number((r as any)[row.k])*10000)/100+'%'
                                    : '—'
                                  }
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                : <>
                    {/* SINGLE DAY — funnel bars */}
                    <div style={cardT}><span style={bBot}>Voicebot</span> Fresh Lead Funnel</div>
                    {[
                      {name:'Leads sent',val:fs.bs},{name:'Leads dialled',val:fs.bd},
                      {name:'Leads connected',val:fs.bc},{name:'Leads qualified',val:fs.bq},
                    ].map((st,i,arr)=>(
                      <div key={st.name} style={{marginBottom:10}}>
                        <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:4}}>
                          <span style={{fontSize:12,fontWeight:500}}>{st.name}</span>
                          <span style={{fontSize:13,fontWeight:500}}>{st.val.toLocaleString()}</span>
                        </div>
                        <div style={{height:6,background:C.borderL,borderRadius:3,overflow:'hidden'}}>
                          <div style={{height:'100%',borderRadius:3,background:C.blueM,width:`${Math.max(4,Math.round(st.val/(fs.bs||1)*100))}%`,transition:'width .5s ease'}}/>
                        </div>
                        <div style={{fontSize:11,color:C.text3,marginTop:2,textAlign:'right'}}>
                          {i>0&&`Step: ${pct(st.val,arr[i-1].val)}% · Top: ${pct(st.val,fs.bs)}%`}
                        </div>
                      </div>
                    ))}
                    <div style={{display:'flex',gap:8,marginTop:10,marginBottom:4}}>
                      {[{l:'High intent',v:fs.hi,c:C.blue},{l:'Medium intent',v:fs.mi,c:C.blueM},{l:'Low intent',v:fs.li,c:C.text3}].map(x=>(
                        <div key={x.l} style={{flex:1,background:C.bg,borderRadius:8,padding:'8px 10px',textAlign:'center'}}>
                          <div style={{fontSize:10,color:C.text3,textTransform:'uppercase',letterSpacing:'.04em'}}>{x.l}</div>
                          <div style={{fontSize:15,fontWeight:500,color:x.c}}>{x.v.toLocaleString()}</div>
                        </div>
                      ))}
                    </div>
                    {fs.cs>0&&(
                      <div style={{background:C.amberL,border:`1px solid #F5D9A8`,borderRadius:8,padding:'10px 14px',margin:'14px 0',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                        <span style={{fontSize:12,color:C.amber,fontWeight:500}}>Gap — Qualified → CC Received</span>
                        <span style={{fontSize:13,color:C.amber,fontWeight:600}}>{(fs.bq-fs.cs).toLocaleString()} leads ({pct(fs.bq-fs.cs,fs.bq)}% of qualified)</span>
                      </div>
                    )}
                    <hr style={{border:'none',borderTop:`1px dashed ${C.border}`,margin:'14px 0'}}/>
                    <div style={cardT}><span style={bCC}>Call Centre</span> Enser Funnel</div>
                    {fs.cs===0
                      ?<div style={{textAlign:'center',padding:'16px 0',color:C.text3,fontSize:13}}>No Enser data — upload via "+ Data" tab</div>
                      :<>
                        {[{name:'Leads received',val:fs.cs},{name:'Attempted',val:fs.ca},{name:'Connected',val:fs.cc},{name:'Converted',val:fs.cv}].map((st,i,arr)=>(
                          <div key={st.name} style={{marginBottom:10}}>
                            <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:4}}>
                              <span style={{fontSize:12,fontWeight:500}}>{st.name}</span>
                              <span style={{fontSize:13,fontWeight:500}}>{st.val.toLocaleString()}</span>
                            </div>
                            <div style={{height:6,background:C.borderL,borderRadius:3,overflow:'hidden'}}>
                              <div style={{height:'100%',borderRadius:3,background:C.greenM,width:`${Math.max(4,Math.round(st.val/(fs.cs||1)*100))}%`,transition:'width .5s ease'}}/>
                            </div>
                            <div style={{fontSize:11,color:C.text3,marginTop:2,textAlign:'right'}}>
                              {i>0&&`Step: ${pct(st.val,arr[i-1].val)}% · Top: ${pct(st.val,fs.cs)}%`}
                            </div>
                          </div>
                        ))}
                        <div style={{display:'flex',gap:8,marginTop:10}}>
                          <div style={{flex:1,background:C.bg,borderRadius:8,padding:'8px 10px',textAlign:'center'}}>
                            <div style={{fontSize:10,color:C.text3,textTransform:'uppercase',letterSpacing:'.04em'}}>Churn</div>
                            <div style={{fontSize:15,fontWeight:500,color:C.red}}>{(fRows.length?fRows.reduce((s,r)=>s+(r.cc_churn||0),0)/fRows.length:0).toFixed(1)}</div>
                          </div>
                          <div style={{flex:2,background:C.bg,borderRadius:8,padding:'8px 10px',textAlign:'center'}}>
                            <div style={{fontSize:10,color:C.text3,textTransform:'uppercase',letterSpacing:'.04em'}}>Conv on connect %</div>
                            <div style={{fontSize:15,fontWeight:500,color:C.green}}>{fmtPct(fRows.length?fRows.reduce((s,r)=>s+(r.cc_conversion_on_connect||0),0)/fRows.length:0)}</div>
                          </div>
                        </div>
                      </>
                    }
                  </>
            }
          </div>
        </>}

        {/* TRENDS */}
        {tab==='trends'&&<>
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:16,flexWrap:'wrap'}}>
            <span style={{fontSize:12,color:C.text2}}>Metric</span>
            <select style={inp} value={tMetric} onChange={e=>setTMetric(e.target.value)}>
              <optgroup label="Voicebot">{['bot_sent','bot_dialled','bot_connected','bot_qualified','high_intent','medium_intent','bot_connect_rate','bot_qualify_rate'].map(k=><option key={k} value={k}>{MLABELS[k]}</option>)}</optgroup>
              <optgroup label="Call Centre">{['cc_sent','cc_attempted','cc_connected','cc_converted','cc_churn','cc_connect_rate','cc_convert_rate','cc_conversion_on_connect'].map(k=><option key={k} value={k}>{MLABELS[k]}</option>)}</optgroup>
              <optgroup label="Combined"><option value="e2e_rate">End-to-end %</option></optgroup>
            </select>
            <span style={{fontSize:12,color:C.text2}}>Period</span>
            <select style={inp} value={tPeriod} onChange={e=>setTPeriod(e.target.value)}>
              <option value="7">Last 7 days</option><option value="14">Last 14 days</option>
              <option value="30">Last 30 days</option><option value="all">All time</option>
            </select>
          </div>
          <div style={card}>
            {tRows.length===0?<div style={{textAlign:'center',padding:40,color:C.text3}}>No data</div>
              :<div style={{position:'relative',height:260}}>
                <Line data={{labels:tLabels,datasets:[{label:MLABELS[tMetric],data:tVals,borderColor:C.blueM,backgroundColor:C.blueM+'18',fill:true,tension:0.35,pointRadius:4,pointBackgroundColor:C.blueM}]}}
                  options={{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:(c)=>isRate?(c.parsed.y??0).toFixed(1)+'%':(c.parsed.y??0).toLocaleString()}}},scales:{x:{ticks:{color:C.text3,font:{size:11}},grid:{color:C.border}},y:{ticks:{color:C.text3,font:{size:11},callback:v=>isRate?v+'%':Number(v).toLocaleString()},grid:{color:C.border},beginAtZero:true}}}}/>
              </div>
            }
          </div>
        </>}

        {/* WOW */}
        {tab==='wow'&&<>
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:16}}>
            <span style={{fontSize:12,color:C.text2}}>Week ending</span>
            <input style={inp} type="date" value={wowEnd} onChange={e=>setWowEnd(e.target.value)}/>
          </div>
          <div style={card}>
            <div style={cardT}>{fmt(wSt)} — {fmt(wEnd)} &nbsp;vs&nbsp; {fmt(pwSt)} — {fmt(pwEnd)}</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8}}>
              {[
                {l:'Bot sent',c:sc.bs,p:sp.bs},{l:'Bot connected',c:sc.bc,p:sp.bc},
                {l:'Bot qualified',c:sc.bq,p:sp.bq},{l:'High intent',c:sc.hi,p:sp.hi},
                {l:'CC received',c:sc.cs,p:sp.cs},{l:'CC connected',c:sc.cc,p:sp.cc},
                {l:'CC converted',c:sc.cv,p:sp.cv},{l:'Connect rate',c:pct(sc.bc,sc.bd),p:pct(sp.bc,sp.bd),isPct:true},
                {l:'Qualify rate',c:pct(sc.bq,sc.bc),p:pct(sp.bq,sp.bc),isPct:true},
                {l:'CC conv rate',c:pct(sc.cv,sc.cc),p:pct(sp.cv,sp.cc),isPct:true},
                {l:'Churn (sum)',c:sc.churn,p:sp.churn},
                {l:'End-to-end %',c:pct(sc.cv,sc.bs),p:pct(sp.cv,sp.bs),isPct:true},
              ].map(m=>{
                const delta=m.p>0?Math.round((m.c-m.p)/m.p*100):null;
                const col=delta===null?C.text3:delta>0?'#3B6D11':C.red;
                const arrow=delta===null?'—':(delta>0?'↑ ':'↓ ')+Math.abs(delta)+'%';
                const f=(v:number)=>(m as any).isPct?v+'%':v.toLocaleString();
                return(
                  <div key={m.l} style={{background:C.bg,borderRadius:8,padding:'10px 12px'}}>
                    <div style={{fontSize:10,color:C.text3,textTransform:'uppercase',letterSpacing:'.04em',marginBottom:4}}>{m.l}</div>
                    <div style={{fontSize:16,fontWeight:500}}>{f(m.c)}</div>
                    <div style={{fontSize:11,color:C.text3,marginTop:2}}>Prev: {f(m.p)}</div>
                    <div style={{fontSize:11,fontWeight:500,marginTop:2,color:col}}>{arrow}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </>}

        {/* LOG */}
        {tab==='log'&&<>
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:16,flexWrap:'wrap'}}>
            <span style={{fontSize:12,color:C.text2}}>From</span>
            <input style={inp} type="date" value={lFrom} onChange={e=>setLFrom(e.target.value)}/>
            <span style={{fontSize:12,color:C.text2}}>To</span>
            <input style={inp} type="date" value={lTo} onChange={e=>setLTo(e.target.value)}/>
            <button style={{...btn,marginLeft:'auto'}} onClick={exportCSV}>Export CSV</button>
          </div>
          <div style={{...card,overflowX:'auto'}}>
            {lRows.length===0?<div style={{textAlign:'center',padding:40,color:C.text3}}>No records</div>
              :<table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                <thead><tr style={{borderBottom:`1px solid ${C.border}`}}>
                  {['Date','Sent','Dialled','Conn','Qual','Hi','Mid','Lo','Gap','CC Rcvd','CC Att','CC Conn','CC Conv','Churn','CoC%','B.Conn%','B.Qual%','E2E%'].map(h=>(
                    <th key={h} style={{textAlign:'left',padding:'7px 8px',fontWeight:500,color:C.text2,whiteSpace:'nowrap'}}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {lRows.map(r=>(
                    <tr key={r.date} style={{borderBottom:`1px solid ${C.borderL}`}}>
                      <td style={{padding:'6px 8px',whiteSpace:'nowrap'}}>{r.date}</td>
                      {[r.bot_sent,r.bot_dialled,r.bot_connected,r.bot_qualified,r.high_intent,r.medium_intent,r.low_intent,r.gap,r.cc_sent,r.cc_attempted,r.cc_connected,r.cc_converted,r.cc_churn].map((v,i)=>(
                        <td key={i} style={{padding:'6px 8px',textAlign:'right',fontVariantNumeric:'tabular-nums'}}>{Number(v).toLocaleString()}</td>
                      ))}
                      {[r.cc_conversion_on_connect,r.bot_connect_rate,r.bot_qualify_rate,r.e2e_rate].map((v,i)=>(
                        <td key={i} style={{padding:'6px 8px',textAlign:'right',color:C.blue}}>{Math.round(Number(v)*10000)/100}%</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            }
          </div>
        </>}

        {/* DATA UPLOAD */}
        {tab==='upload'&&<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,maxWidth:1000}}>
          {/* Enser via Superset */}
          <div style={card}>
            <div style={cardT}><span style={bCC}>Enser</span> Sync from Superset</div>
            <p style={{fontSize:12,color:C.text3,marginBottom:14}}>
              Uses the Voicebot Superset Bridge extension to query through your corporate network and existing Superset login.
            </p>
            <div style={{marginBottom:10}}>
              <label style={igL}>Date to sync</label>
              <input style={igI} type="date" value={ssDate} onChange={e=>setSsDate(e.target.value)}/>
            </div>
            <button style={{...btnP,width:'100%',background:C.greenM}} onClick={syncSuperset} disabled={ssLoading}>
              {ssLoading?'Checking access…':ssAuthUrl?'Continue sync':'Sync from Superset'}
            </button>
            {ssAuthUrl&&<a href={ssAuthUrl} target="_blank" rel="noreferrer" style={{display:'block',textAlign:'center',marginTop:8,fontSize:12,color:C.blue}}>Open Superset sign-in again →</a>}
            {ssStatus&&<div style={{marginTop:10,fontSize:12,color:ssStatus.startsWith('✓')?C.green:ssAuthUrl?C.amber:C.red,padding:'8px 10px',background:ssStatus.startsWith('✓')?C.greenL:ssAuthUrl?C.amberL:C.redL,borderRadius:6}}>{ssStatus}</div>}
            <hr style={{border:'none',borderTop:`1px dashed ${C.border}`,margin:'14px 0'}}/>
            <p style={{fontSize:11,color:C.text3}}>
              The conversion query runs first, followed by CDR for the selected calendar day.
            </p>
          </div>

          {/* GreyLabs backfill */}
          <div style={card}>
            <div style={cardT}><span style={bBot}>GreyLabs</span> Backfill from Gmail</div>
            <p style={{fontSize:12,color:C.text3,marginBottom:14}}>
              Fetch GreyLabs data for a past date from your Gmail inbox.
            </p>
            <div style={{marginBottom:10}}>
              <label style={igL}>Date to fetch</label>
              <input style={igI} type="date" value={bfDate} onChange={e=>setBfDate(e.target.value)}/>
            </div>
            <button style={{...btnP,width:'100%',background:C.blueM}} onClick={runBackfill} disabled={bfLoading}>
              {bfLoading?'Fetching...':'Fetch from Gmail'}
            </button>
            {bfStatus&&<div style={{marginTop:10,fontSize:12,color:bfStatus.startsWith('✓')?C.green:C.red,padding:'8px 10px',background:bfStatus.startsWith('✓')?C.greenL:C.redL,borderRadius:6}}>{bfStatus}</div>}
          </div>

          {/* Enser image upload — fallback */}
          <div style={card}>
            <div style={cardT}><span style={bCC}>Enser</span> Manual upload (fallback)</div>
            <p style={{fontSize:12,color:C.text3,marginBottom:14}}>Upload the WhatsApp screenshot if Superset sync isn't ready yet.</p>
            <div style={{marginBottom:10}}>
              <label style={igL}>Date this report is for</label>
              <input style={igI} type="date" value={eDate} onChange={e=>setEDate(e.target.value)}/>
            </div>
            <div
              style={{border:`2px dashed ${eImage?C.greenM:C.border}`,borderRadius:8,padding:'20px',textAlign:'center',cursor:'pointer',marginBottom:12,background:eImage?C.greenL:'transparent',transition:'all .2s'}}
              onClick={()=>document.getElementById('enser-file')?.click()}
              onDragOver={e=>{e.preventDefault();}}
              onDrop={e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(f){setEImage(f);setEPreview(URL.createObjectURL(f));}}}
            >
              {ePreview
                ? <img src={ePreview} style={{maxWidth:'100%',maxHeight:160,borderRadius:4}} alt="preview"/>
                : <div style={{color:C.text3,fontSize:13}}>Drag & drop or click to upload<br/><span style={{fontSize:11}}>JPG, PNG accepted</span></div>
              }
            </div>
            <input id="enser-file" type="file" accept="image/*" style={{display:'none'}} onChange={e=>{const f=e.target.files?.[0];if(f){setEImage(f);setEPreview(URL.createObjectURL(f));}}}/>
            <button style={{...btnP,width:'100%',background:eImage?C.greenM:'#ccc',cursor:eImage?'pointer':'not-allowed'}} onClick={uploadEnser} disabled={eSaving||!eImage}>
              {eSaving?'Reading image...':'Upload & save'}
            </button>
            {eSaved&&(
              <div style={{marginTop:10,fontSize:12,padding:'8px 10px',borderRadius:6,background:eSaved.startsWith('✓')?C.greenL:C.redL,color:eSaved.startsWith('✓')?C.green:C.red}}>
                {eSaved}
                {eParsed&&<div style={{marginTop:6,fontSize:11}}>
                  Sent: {eParsed.cc_sent} · Att: {eParsed.cc_attempted} · Conn: {eParsed.cc_connected} · Conv: {eParsed.cc_converted}
                </div>}
              </div>
            )}
          </div>
        </div>}
      </div>
    </>
  );
}
