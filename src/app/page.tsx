'use client';
import { useEffect, useState } from 'react';
import { Line } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip } from 'chart.js';
import type { FunnelRow } from '@/lib/storage';
import { combinedQuery, receivedQuery } from '@/app/api/superset/queries';
ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip);

const SUPERSET_LOGIN = 'https://insurance-analytic-platform.paytminsurance.co.in/superset/welcome/';

function todayStr() { return new Date().toISOString().slice(0,10); }
function yesterdayStr() { const d=new Date(); d.setDate(d.getDate()-1); return d.toISOString().slice(0,10); }
function pct(a:number,b:number){return b>0?Math.round(a/b*1000)/10:0;}
function fmtPct(v:number){return Math.round(v*1000)/10+'%';}
function weekStart(n=0){const d=new Date();const dow=d.getDay()||7;d.setDate(d.getDate()-dow+1-n*7);return d.toISOString().slice(0,10);}
function sumRows(rows:FunnelRow[]){
  const n=(k:keyof FunnelRow)=>rows.reduce((s,r)=>s+(Number(r[k])||0),0);
  return{
    // fresh
    fs:n('fresh_sent'),fd:n('fresh_dialled'),fc:n('fresh_connected'),fq:n('fresh_qualified'),
    fhi:n('fresh_high'),fmi:n('fresh_medium'),flo:n('fresh_low'),fcb:n('fresh_callback'),
    // retained
    rs:n('ret_sent'),rd:n('ret_dialled'),rc:n('ret_connected'),rq:n('ret_qualified'),
    rhi:n('ret_high'),rmi:n('ret_medium'),rlo:n('ret_low'),rcb:n('ret_callback'),
    // combined bot
    bs:n('bot_sent'),bq:n('bot_qualified'),
    bd:n('bot_dialled'),bc:n('bot_connected'),
    hi:n('high_intent'),mi:n('medium_intent'),li:n('low_intent'),
    // cc
    cs:n('cc_sent'),ca:n('cc_attempted'),cc:n('cc_connected'),cv:n('cc_converted'),
    churn:n('cc_churn'),coc:n('cc_conversion_on_connect')
  };
}

const C={
  blue:'#185FA5',blueM:'#378ADD',blueL:'#E6F1FB',
  green:'#27500A',greenM:'#639922',greenL:'#EAF3DE',
  amber:'#854F0B',amberL:'#FAEEDA',
  purple:'#5B21B6',purpleM:'#7C3AED',purpleL:'#EDE9FE',
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
  const[retRows,setRetRows]=useState<any[]>([]);
  const[retSyncDate,setRetSyncDate]=useState(yesterdayStr());
  const[manualCronDate,setManualCronDate]=useState(yesterdayStr());
  const[startupStatus,setStartupStatus]=useState('');
  const[startupDone,setStartupDone]=useState(false);
  const[manualCronStatus,setManualCronStatus]=useState('');
  const[manualCronLoading,setManualCronLoading]=useState(false);
  const[manualCronEndDate,setManualCronEndDate]=useState(yesterdayStr());
  const[bulkSyncProgress,setBulkSyncProgress]=useState('');
  const[bulkSyncCancelled,setBulkSyncCancelled]=useState(false);
  const[retStatus,setRetStatus]=useState('');
  const[retLoading,setRetLoading]=useState(false);
  const[retMetric,setRetMetric]=useState<'connected'|'qualified'|'enser'>('connected');
  const[retCumulative,setRetCumulative]=useState(false);
  const[retEnserDenom,setRetEnserDenom]=useState<'sent'|'attempted'>('sent');

  const load=()=>{
    fetch('/api/data').then(r=>r.json())
      .then(d=>{if(d.error)setError(d.error);else setRows(d.rows||[]);})
      .catch(e=>setError(e.message)).finally(()=>setLoading(false));
  };
  useEffect(()=>{load();},[]);
  const loadRetention=()=>{
    fetch('/api/retention').then(r=>r.json())
      .then(d=>setRetRows(d.rows||[])).catch(console.error);
  };
  useEffect(()=>{loadRetention();},[]);

  // Startup sync — runs on page load
  // 1. Gmail fetch for yesterday (today's data not available until EOD)
  // 2. Sync cc_sent for all dates missing it in last 14 days
  // 3. If Superset auth needed, show banner asking user to log in
  useEffect(()=>{
    if(startupDone) return;
    setStartupDone(true);

    const runStartup = async () => {
      const yesterday = yesterdayStr();

      // Step 1: Gmail fetch for yesterday — only if data is missing
      try{
        const checkRes = await fetch('/api/data');
        const checkJson = await checkRes.json();
        const yesterdayRow = (checkJson.rows||[]).find((r:any)=>r.date===yesterday);
        // Skip known bad data dates where GreyLabs report was corrupted
        const skipDates = ['2026-07-02'];
        if(!skipDates.includes(yesterday) && (!yesterdayRow || !yesterdayRow.fresh_sent || yesterdayRow.fresh_sent === 0)){
          setStartupStatus(`Fetching yesterday's data (${yesterday})…`);
          await fetch(`/api/cron-trigger?date=${yesterday}`);
        }
      }catch(e){ /* silent */ }

      // Step 2: Reload data to see what's missing cc_sent
      const dataRes = await fetch('/api/data');
      const dataJson = await dataRes.json();
      const allRows: any[] = dataJson.rows || [];

      // Find dates missing cc_sent, last 14 days only, excluding today
      const today = todayStr();
      const missingCC = allRows
        .filter((r:any) => r.date < today && r.date >= '2026-06-23' && (!r.cc_sent || r.cc_sent === 0))
        .map((r:any) => r.date)
        .sort().slice(-14);

      if(missingCC.length === 0){
        setStartupStatus('');
        load(); loadRetention();
        return;
      }

      // Step 3: Check Superset auth before trying cc_sent sync
      try{
        setStartupStatus('Checking Superset connection…');
        const authRes = await fetch('/api/superset/auth');
        const authData = await authRes.json();

        if(!authData.authenticated){
          // Show persistent banner asking user to log in
          setStartupStatus(`⚠ ${missingCC.length} date(s) missing Enser data (${missingCC.slice(-3).join(', ')}${missingCC.length>3?'…':''}). Log in to Superset to sync automatically.`);
          load(); loadRetention();
          return;
        }

        // Step 4: Authenticated — sync cc_sent for each missing date
        for(const d of missingCC){
          setStartupStatus(`Syncing Enser data for ${d}… (${missingCC.indexOf(d)+1}/${missingCC.length})`);
          try{
            await fetch(`/api/cron-trigger?date=${d}`);
          }catch(e){ /* silent */ }
        }
        setStartupStatus('');
      }catch(e){
        setStartupStatus('⚠ Could not reach Superset. Open dashboard on Paytm WiFi to sync Enser data.');
      }

      load(); loadRetention();
    };

    runStartup();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);



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

  const runBulkSync=async()=>{
    setBulkSyncCancelled(false);
    setManualCronLoading(true);setManualCronStatus('Starting bulk sync…');
    try{
      const dates:string[]=[];
      const cur=new Date(manualCronDate+'T00:00:00Z');
      const end=new Date(manualCronEndDate+'T00:00:00Z');
      while(cur<=end){dates.push(cur.toISOString().slice(0,10));cur.setUTCDate(cur.getUTCDate()+1);}
      const results:{date:string,gmail:string,enser:string}[]=[];
      for(let i=0;i<dates.length;i++){
        if(bulkSyncCancelled){setManualCronStatus('⚠ Stopped by user');break;}
        const d=dates[i];
        setBulkSyncProgress(`${i+1}/${dates.length} — ${d}`);
        setManualCronStatus(`Syncing ${d}… (${i+1}/${dates.length})`);
        try{
          const r=await fetch(`/api/cron-trigger?date=${d}`);
          const data=await r.json();
          const gmail=data.gmail?.success?`✓ Gmail`:data.gmail?.message?.includes('not found')?`⚠ No email`:`✗ Gmail failed`;
          const enser=data.enser?.cc_sent!=null?`✓ Enser(${data.enser.cc_sent})`:data.enser?.skipped?`⚠ Enser(auth)`:data.enser?.error?.includes('timeout')||data.enser?.error?.includes('network')?`⚠ Enser(offline)`:`✗ Enser`;
          results.push({date:d,gmail,enser});
        }catch(e2:any){results.push({date:d,gmail:'✗',enser:'✗'});}
      }
      const summary=results.map(r=>`${r.date}: ${r.gmail} | ${r.enser}`).join('\n');
      setManualCronStatus(`✓ Done (${results.length} dates):\n${summary}`);
      fetch('/api/data').then(r=>r.json()).then(d=>setRows(d.rows||[]));
      fetch('/api/retention').then(r=>r.json()).then(d=>setRetRows(d.rows||[]));
    }catch(e:any){setManualCronStatus(`✗ ${e.message}`);}
    finally{setManualCronLoading(false);setBulkSyncProgress('');}
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


  const syncRetention=async()=>{
    setRetLoading(true);setRetStatus('Checking extension…');
    try{
      const extensionCall2=(type:string,payload:any={},timeout=120000)=>new Promise<any>((resolve,reject)=>{
        const id=Math.random().toString(36).slice(2);
        const timer=setTimeout(()=>{window.removeEventListener('message',handler2);reject(new Error('Bridge timeout'));},timeout);
        function handler2(event:MessageEvent){
          if(event.source!==window||event.data?.source!=='superset-bridge'||event.data?.id!==id)return;
          clearTimeout(timer);window.removeEventListener('message',handler2);
          event.data.success?resolve(event.data.data):reject(new Error(event.data.error||'Bridge failed'));
        }
        window.addEventListener('message',handler2);
        window.postMessage({source:'voicebot-dashboard',type,id,...payload},'*');
      });
      let extReady=false;
      try{await extensionCall2('PING',{},1200);extReady=true;}catch{}
      if(!extReady){setRetStatus('✗ Chrome extension not detected');setRetLoading(false);return;}
      const lidRes=await fetch(`/api/lead-ids?date=${retSyncDate}`);
      const lidData=await lidRes.json();
      // Use freshIds+retainedIds (already filtered to Qualified=YES from Gmail) not allIds which includes unqualified bulk-upload leads
      const qualifiedIds:string[]=[...(lidData.freshIds||[]),...(lidData.retainedIds||[])];
      const idsToUse:string[]=qualifiedIds.length>0?qualifiedIds:(lidData.allIds||[]);
      if(!idsToUse.length){setRetStatus(`✗ No lead IDs for ${retSyncDate}. Run Gmail backfill or upload Format A Excel first.`);setRetLoading(false);return;}
      setRetStatus(`Running conversion cohort query for ${idsToUse.length} qualified leads…`);
      // Anchor date window to cohort date (not CURRENT_DATE) so older cohorts work correctly
      const next=new Date(`${retSyncDate}T00:00:00Z`);next.setUTCDate(next.getUTCDate()+7);
      const nextDate=next.toISOString().slice(0,10);
      const lookback=new Date(`${retSyncDate}T00:00:00Z`);lookback.setUTCDate(lookback.getUTCDate()+60);
      const lookbackDate=lookback.toISOString().slice(0,10);
      const lookbackFmt=lookbackDate.replace(/-/g,'');
      const cohortFmt=retSyncDate.replace(/-/g,'');
      const idChunks:string[][]=[];
      for(let i=0;i<idsToUse.length;i+=1000)idChunks.push(idsToUse.slice(i,i+1000));
      const qualifiedLeadSources=idChunks.map((chunk:string[])=>{
        const values=chunk.map((id:string)=>`('${id.replace(/'/g,"''")}')` ).join(', ');
        return `SELECT CAST(id AS VARCHAR) AS lead_id FROM (VALUES ${values}) AS t(id)`;
      }).join('\n    UNION ALL\n    ');
      const sql=`WITH qualified_leads AS (\n    ${qualifiedLeadSources}\n),policy_purchases AS (SELECT CAST(COALESCE(p.created_by,p.owned_by) AS VARCHAR) AS customer_id,DATE(MIN(oi.created_on)) AS purchase_date,p.proposal_id,oi.oms_item_id,MAX(CASE WHEN oi.status IN ('issued','policy_pdf_generated') THEN 1 ELSE 0 END) AS issued_flag FROM (SELECT id,oms_order_id,oms_item_id,price,status,created_on,ROW_NUMBER() OVER (PARTITION BY id ORDER BY modified_on DESC) AS rn FROM glue_catalog.motor_proposal_3.order_item WHERE modified_on>='${retSyncDate} 00:00:00' AND modified_on<'${lookbackDate} 00:00:00' AND date>='${cohortFmt}' AND date<='${lookbackFmt}') oi JOIN (SELECT id,oms_order_id,proposal_id,ROW_NUMBER() OVER (PARTITION BY id ORDER BY modified_on DESC) AS rn FROM glue_catalog.motor_proposal_3.order_detail WHERE modified_on>='${retSyncDate} 00:00:00' AND modified_on<'${lookbackDate} 00:00:00' AND date>='${cohortFmt}' AND date<='${lookbackFmt}') od ON oi.oms_order_id=od.oms_order_id AND oi.rn=1 AND od.rn=1 JOIN (SELECT id,proposal_id,vehicle_type,created_by,owned_by,coverage_type,ROW_NUMBER() OVER (PARTITION BY id ORDER BY modified_on DESC) AS rn FROM glue_catalog.motor_proposal_3.proposal WHERE modified_on>='${retSyncDate} 00:00:00' AND modified_on<'${lookbackDate} 00:00:00' AND date>='${cohortFmt}' AND date<='${lookbackFmt}') p ON p.proposal_id=od.proposal_id AND p.rn=1 WHERE p.coverage_type IN ('comprehensive_1y_1y','own_damage_1y','third_party_1y') AND oi.created_on>='${retSyncDate} 00:00:00' AND oi.created_on<'${lookbackDate} 00:00:00' AND CAST(COALESCE(p.created_by,p.owned_by) AS VARCHAR) IN (SELECT lead_id FROM qualified_leads) GROUP BY CAST(COALESCE(p.created_by,p.owned_by) AS VARCHAR),p.proposal_id,oi.oms_item_id)\nSELECT DATEDIFF(DATE(purchase_date),DATE('${retSyncDate}')) AS day_number,COUNT(DISTINCT customer_id) AS converted FROM policy_purchases WHERE purchase_date>='${retSyncDate}' AND purchase_date<'${nextDate}' AND issued_flag=1 GROUP BY DATEDIFF(DATE(purchase_date),DATE('${retSyncDate}')) ORDER BY day_number`;
      const convRows=await extensionCall2('RUN_QUERY',{sql});
      const enser:Record<string,{converted:number}>={};
      for(const r of (convRows||[])){const d=Number(r.day_number);if(d>=0&&d<=6)enser[`day${d}`]={converted:Number(r.converted)||0};}
      const save=await fetch('/api/retention',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cohort_date:retSyncDate,enser})});
      const saved=await save.json();
      if(!save.ok)throw new Error(saved.error||'Failed to save');
      setRetStatus(`✓ Enser conversion synced for ${retSyncDate}`);
      loadRetention();
    }catch(e:any){setRetStatus('✗ '+e.message);}
    finally{setRetLoading(false);}
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
        setSsStatus('Fetching qualified lead IDs…');
        // Get lead IDs from Redis for this date
        let lidRes=await fetch(`/api/lead-ids?date=${ssDate}`);
        let lidData=await lidRes.json();
        // Use freshIds+retainedIds (qualified only) for accurate cc_sent filtering
        const qualIds:string[]=Array.from(new Set([
          ...(lidData.freshIds||[]),
          ...(lidData.retainedIds||[])
        ].map((id:any)=>String(id).trim()).filter(Boolean)));
        const allIds:string[] = qualIds.length > 0 ? qualIds : Array.from(new Set((lidData.allIds||[]).map((id:any)=>String(id).trim()).filter(Boolean)));
        if(!allIds.length){setSsStatus(`✗ No lead IDs for ${ssDate}. Run GreyLabs backfill or Fetch & Sync first.`);setSsLoading(false);return;}
        // Step 1: Fast query — just count lead IDs in Enser callback data (5-10 sec)
        setSsStatus(`Step 1/2: Getting CC received for ${allIds.length} leads…`);
        const fastSql=receivedQuery(ssDate,allIds);
        const fastRows=await extensionCall('RUN_QUERY',{sql:fastSql});
        const ccSent=Number(fastRows?.[0]?.cc_sent)||0;
        const ccAttempted=Number(fastRows?.[0]?.cc_attempted)||0;
        const ccConnected=Number(fastRows?.[0]?.cc_connected)||0;
        // Save cc_sent immediately so it shows even if attribution times out
        await fetch('/api/enser',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({date:ssDate,cc_sent:ccSent,cc_attempted:ccAttempted,cc_connected:ccConnected,cc_converted:0,cc_churn:0,cc_conversion_on_connect:0})});
        setSsStatus(`✓ Step 1 done: ${ccSent} received · ${ccAttempted} attempted · ${ccConnected} connected. Running attribution…`);
        // Step 2: Full attribution for conversions (slow — may timeout)
        let ccConverted=0;
        try{
          const convSql=combinedQuery(ssDate,nextDate,allIds);
          const queryRows=await extensionCall('RUN_QUERY',{sql:convSql});
          ccConverted=Number(queryRows?.[0]?.cc_converted)||0;
        }catch(e:any){
          setSsStatus(`✓ ${ssDate}: ${ccSent} received · ${ccAttempted} attempted · ${ccConnected} connected · conversions timed out (re-sync to retry)`);
          setSsLoading(false);fetch('/api/data').then(r=>r.json()).then(d=>setRows(d.rows||[]));return;
        }
        const c={cc_sent:ccSent,cc_attempted:ccAttempted,cc_connected:ccConnected,cc_converted:ccConverted,cc_churn:0};
        const save=await fetch('/api/enser',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({date:ssDate,...c,cc_conversion_on_connect:c.cc_connected>0?c.cc_converted/c.cc_connected*100:0})});
        // Sync cc_converted to retention enser day0 so main funnel and retention match
        if(c.cc_converted>0){
          await fetch('/api/retention',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cohort_date:ssDate,enser:{day0:{converted:c.cc_converted}}})});
        }
        const saved=await save.json();if(!save.ok)throw new Error(saved.error||'Could not save Superset data');
        setSsAuthUrl('');setSsStatus(`✓ ${ssDate}: ${c.cc_sent} received · ${c.cc_attempted} attempted · ${c.cc_connected} connected · ${c.cc_converted} converted`);load();return;
      }
      throw new Error('Chrome extension not detected. Install the Voicebot Superset Bridge extension and make sure Superset is open in another tab, then reload this page.');
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

  const TABS=[{id:'funnel',label:'Funnel'},{id:'trends',label:'Trends'},{id:'wow',label:'Week on week'},{id:'log',label:'Log'},{id:'retention',label:'Retention'},{id:'upload',label:'+ Data',small:true}];

  return(
    <>
    {startupStatus&&<div style={{position:'fixed',top:0,left:0,right:0,zIndex:1000,background:startupStatus.startsWith('⚠')?'#fffbe6':'#e8f5e9',borderBottom:'1px solid',borderColor:startupStatus.startsWith('⚠')?'#ffe58f':'#a5d6a7',padding:'8px 16px',fontSize:12,color:startupStatus.startsWith('⚠')?'#7c4a00':'#2e7d32',display:'flex',alignItems:'center',gap:8}}>
      <span>{startupStatus}</span>
      {startupStatus.startsWith('⚠')&&startupStatus.includes('Log in')&&<button onClick={async()=>{
        const r=await fetch('/api/superset/auth');const d=await r.json();
        if(d.authUrl)window.open(d.authUrl,'_blank');
        setStartupStatus('Log in to Superset in the new tab, then refresh this page to auto-sync.');
      }} style={{marginLeft:8,padding:'3px 10px',background:'#fa8c16',border:'none',borderRadius:4,color:'#fff',cursor:'pointer',fontSize:11,fontWeight:600}}>Log in to Superset</button>}
      <button onClick={()=>setStartupStatus('')} style={{marginLeft:'auto',background:'none',border:'none',cursor:'pointer',fontSize:14,color:'inherit'}}>✕</button>
    </div>}
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
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:16,flexWrap:'wrap' as const}}>
            <span style={{fontSize:12,color:C.text2}}>View</span>
            <select style={inp} value={fMode} onChange={e=>setFMode(e.target.value as any)}>
              <option value="day">Single day</option><option value="range">Date range (day on day)</option>
            </select>
            {fMode==='day'&&<input style={inp} type="date" value={fDay} onChange={e=>setFDay(e.target.value)}/>}
            {fMode==='range'&&<><input style={inp} type="date" value={fFrom} onChange={e=>setFFrom(e.target.value)}/><span style={{fontSize:12,color:C.text3}}>to</span><input style={inp} type="date" value={fTo} onChange={e=>setFTo(e.target.value)}/></>}
          </div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:10,marginBottom:16}}>
            {[
              {l:'Fresh qualify %',v:pct(fs.fq,fs.fc)+'%',s:`${fs.fq.toLocaleString()} qualified`},
              {l:'Retained qualify %',v:pct(fs.rq,fs.rc)+'%',s:`${fs.rq.toLocaleString()} qualified`},
              {l:'High Intent conv %',v:pct(fs.cv,fRows.reduce((s,r)=>s+(r.high_intent||0),0))+'%',s:`${fRows.reduce((s,r)=>s+(r.high_intent||0),0).toLocaleString()} high intent`},
              {l:'Medium Intent conv %',v:pct(fs.cv,fRows.reduce((s,r)=>s+(r.medium_intent||0),0))+'%',s:`${fRows.reduce((s,r)=>s+(r.medium_intent||0),0).toLocaleString()} medium intent`},
              {l:'Callback conv %',v:pct(fs.cv,fRows.reduce((s,r)=>s+((r as any).callback_agent||(r.fresh_callback||0)+(r.ret_callback||0)||0),0))+'%',s:`${fRows.reduce((s,r)=>s+((r as any).callback_agent||(r.fresh_callback||0)+(r.ret_callback||0)||0),0).toLocaleString()} callback`},
            ].map(k=>(
              <div key={k.l} style={kpi}>
                <div style={{fontSize:10,color:C.text3,textTransform:'uppercase' as const,letterSpacing:'.05em',marginBottom:5}}>{k.l}</div>
                <div style={{fontSize:22,fontWeight:500,lineHeight:1}}>{k.v}</div>
                <div style={{fontSize:11,color:C.text3,marginTop:3}}>{k.s}</div>
              </div>
            ))}
          </div>
          {!rows.length&&<div style={{...card,textAlign:'center' as const,padding:40,color:C.text3}}>No data yet — add data via the "+ Data" tab</div>}
          {rows.length>0&&fMode==='day'&&<>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:12}}>
              <div style={card}>
                <div style={cardT}><span style={bBot}>Fresh</span> Lead Funnel</div>
                {([{name:'Leads sent',k:'fresh_sent'},{name:'Leads dialled',k:'fresh_dialled'},{name:'Leads connected',k:'fresh_connected'},{name:'Leads qualified',k:'fresh_qualified'}] as {name:string,k:keyof typeof fRows[0]}[]).map((st,i,arr)=>{
                  const val=fRows[0]?Number(fRows[0][st.k])||0:0;
                  const top=fRows[0]?Number(fRows[0].fresh_sent)||1:1;
                  const prev=i>0?Number(fRows[0]?.[arr[i-1].k as keyof typeof fRows[0]])||0:0;
                  return(<div key={st.name} style={{marginBottom:10}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:4}}><span style={{fontSize:12,fontWeight:500}}>{st.name}</span><span style={{fontSize:13,fontWeight:500}}>{val.toLocaleString()}</span></div>
                    <div style={{height:6,background:C.borderL,borderRadius:3,overflow:'hidden'}}><div style={{height:'100%',borderRadius:3,background:C.blueM,width:`${Math.max(4,Math.round(val/top*100))}%`,transition:'width .5s'}}/></div>
                    <div style={{fontSize:11,color:C.text3,marginTop:2,textAlign:'right' as const}}>{i>0&&`Step: ${pct(val,prev)}% · Top: ${pct(val,top)}%`}</div>
                  </div>);
                })}
                <div style={{display:'flex',gap:6,marginTop:10}}>
                  {[{l:'High',k:'fresh_high',c:C.blue},{l:'Med',k:'fresh_medium',c:C.blueM},{l:'Low',k:'fresh_low',c:C.text3},{l:'Callback',k:'fresh_callback',c:'#7C3AED'}].map(x=>(
                    <div key={x.l} style={{flex:1,background:C.bg,borderRadius:6,padding:'6px 4px',textAlign:'center' as const}}>
                      <div style={{fontSize:10,color:C.text3}}>{x.l}</div>
                      <div style={{fontSize:13,fontWeight:500,color:x.c}}>{fRows[0]?Number((fRows[0] as any)[x.k])||0:0}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div style={card}>
                <div style={cardT}><span style={{display:'inline-block',padding:'2px 8px',borderRadius:20,fontSize:10,fontWeight:600,background:'#EDE9FE',color:'#5B21B6'}}>Retained</span> Lead Funnel</div>
                {([{name:'Leads sent',k:'ret_sent'},{name:'Leads dialled',k:'ret_dialled'},{name:'Leads connected',k:'ret_connected'},{name:'Leads qualified',k:'ret_qualified'}] as {name:string,k:keyof typeof fRows[0]}[]).map((st,i,arr)=>{
                  const val=fRows[0]?Number(fRows[0][st.k])||0:0;
                  const top=fRows[0]?Number(fRows[0].ret_sent)||1:1;
                  const prev=i>0?Number(fRows[0]?.[arr[i-1].k as keyof typeof fRows[0]])||0:0;
                  return(<div key={st.name} style={{marginBottom:10}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:4}}><span style={{fontSize:12,fontWeight:500}}>{st.name}</span><span style={{fontSize:13,fontWeight:500}}>{val.toLocaleString()}</span></div>
                    <div style={{height:6,background:C.borderL,borderRadius:3,overflow:'hidden'}}><div style={{height:'100%',borderRadius:3,background:'#7C3AED',width:`${Math.max(4,Math.round(val/top*100))}%`,transition:'width .5s'}}/></div>
                    <div style={{fontSize:11,color:C.text3,marginTop:2,textAlign:'right' as const}}>{i>0&&`Step: ${pct(val,prev)}% · Top: ${pct(val,top)}%`}</div>
                  </div>);
                })}
                <div style={{display:'flex',gap:6,marginTop:10}}>
                  {[{l:'High',k:'ret_high',c:'#5B21B6'},{l:'Med',k:'ret_medium',c:'#7C3AED'},{l:'Low',k:'ret_low',c:C.text3},{l:'Callback',k:'ret_callback',c:'#7C3AED'}].map(x=>(
                    <div key={x.l} style={{flex:1,background:C.bg,borderRadius:6,padding:'6px 4px',textAlign:'center' as const}}>
                      <div style={{fontSize:10,color:C.text3}}>{x.l}</div>
                      <div style={{fontSize:13,fontWeight:500,color:x.c}}>{fRows[0]?Number((fRows[0] as any)[x.k])||0:0}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div style={card}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
                <div style={{fontSize:13,color:C.text2}}>Combined qualified: <strong style={{color:C.text,fontSize:15}}>{((fRows[0]?.fresh_qualified||0)+(fRows[0]?.ret_qualified||0)).toLocaleString()}</strong><span style={{fontSize:11,color:C.text3,marginLeft:8}}>({fRows[0]?.fresh_qualified||0} fresh + {fRows[0]?.ret_qualified||0} retained)</span></div>
                {(fRows[0]?.cc_sent||0)>0&&<div style={{background:C.amberL,color:C.amber,padding:'4px 12px',borderRadius:6,fontSize:12,fontWeight:500}}>Gap: {((fRows[0]?.bot_qualified||0)-(fRows[0]?.cc_sent||0)).toLocaleString()} leads</div>}
              </div>
              <div style={cardT}><span style={bCC}>Call Centre</span> Enser Funnel (bot-qualified leads only)</div>
              {(fRows[0]?.cc_sent||0)===0
                ?<div style={{textAlign:'center' as const,padding:'16px 0',color:C.text3,fontSize:13}}>No Enser data — sync from Superset in "+ Data" tab</div>
                :<>
                  {[{name:'Leads received',val:fRows[0]?.cc_sent||0},{name:'Attempted',val:fRows[0]?.cc_attempted||0},{name:'Connected',val:fRows[0]?.cc_connected||0},{name:'Converted',val:fRows[0]?.cc_converted||0}].map((st,i,arr)=>(
                    <div key={st.name} style={{marginBottom:10}}>
                      <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:4}}><span style={{fontSize:12,fontWeight:500}}>{st.name}</span><span style={{fontSize:13,fontWeight:500}}>{st.val.toLocaleString()}</span></div>
                      <div style={{height:6,background:C.borderL,borderRadius:3,overflow:'hidden'}}><div style={{height:'100%',borderRadius:3,background:C.greenM,width:`${Math.max(4,Math.round(st.val/((fRows[0]?.cc_sent||1))*100))}%`,transition:'width .5s'}}/></div>
                      <div style={{fontSize:11,color:C.text3,marginTop:2,textAlign:'right' as const}}>{i>0&&`Step: ${pct(st.val,arr[i-1].val)}% · Top: ${pct(st.val,fRows[0]?.cc_sent||1)}%`}</div>
                    </div>
                  ))}
                  <div style={{display:'flex',gap:8,marginTop:10}}>
                    <div style={{flex:1,background:C.bg,borderRadius:8,padding:'8px 10px',textAlign:'center' as const}}><div style={{fontSize:10,color:C.text3,textTransform:'uppercase' as const}}>Conv on connect</div><div style={{fontSize:15,fontWeight:500,color:C.green}}>{fmtPct(fRows[0]?.cc_conversion_on_connect||0)}</div></div>
                    <div style={{flex:1,background:C.bg,borderRadius:8,padding:'8px 10px',textAlign:'center' as const}}><div style={{fontSize:10,color:C.text3,textTransform:'uppercase' as const}}>E2E convert</div><div style={{fontSize:15,fontWeight:500,color:C.green}}>{fmtPct(fRows[0]?.e2e_rate||0)}</div></div>
                  </div>
                </>
              }
            </div>
          </>}
          {rows.length>0&&fMode==='range'&&<div style={{...card,overflowX:'auto' as const}}>
            {fRows.length===0
              ?<div style={{textAlign:'center' as const,padding:40,color:C.text3}}>No data for this range</div>
              :<table style={{width:'100%',borderCollapse:'collapse' as const,fontSize:12}}>
                <thead><tr style={{borderBottom:`2px solid ${C.border}`}}>
                  <th style={{textAlign:'left' as const,padding:'8px 10px',fontWeight:600,color:C.text2,minWidth:160,position:'sticky' as const,left:0,background:C.surface}}>Stage</th>
                  {fRows.map(r=><th key={r.date} style={{textAlign:'right' as const,padding:'8px 10px',fontWeight:500,color:C.text2,whiteSpace:'nowrap' as const}}>{r.date.slice(5)}</th>)}
                </tr></thead>
                <tbody>
                  <tr style={{background:'#BFDBFE44'}}><td colSpan={fRows.length+1} style={{padding:'6px 10px',fontWeight:700,fontSize:11,textTransform:'uppercase' as const,letterSpacing:'.06em',color:C.blue,position:'sticky' as const,left:0}}>Fresh Leads</td></tr>
                  {[{l:'Leads sent',k:'fresh_sent'},{l:'Leads dialled',k:'fresh_dialled'},{l:'Leads connected',k:'fresh_connected'},{l:'Leads qualified',k:'fresh_qualified'},{l:'High intent',k:'fresh_high'},{l:'Medium intent',k:'fresh_medium'},{l:'Low intent',k:'fresh_low'},{l:'Callback w/ agent',k:'fresh_callback'}].map((row,ri)=>(
                    <tr key={row.k} style={{borderBottom:`1px solid ${C.borderL}`}}>
                      <td style={{padding:'6px 10px',fontWeight:ri<4?500:400,color:C.text,position:'sticky' as const,left:0,background:C.surface}}>{row.l}</td>
                      {fRows.map(r=><td key={r.date} style={{padding:'6px 10px',textAlign:'right' as const,fontVariantNumeric:'tabular-nums' as const}}>{(Number((r as any)[row.k])||0).toLocaleString()}</td>)}
                    </tr>
                  ))}
                  {[{l:'Connect %',k:'fresh_connect_rate'},{l:'Qualify %',k:'fresh_qualify_rate'}].map(row=>(
                    <tr key={row.k} style={{borderBottom:`1px solid ${C.borderL}`,background:C.bg}}>
                      <td style={{padding:'6px 10px',color:C.text3,fontStyle:'italic',position:'sticky' as const,left:0,background:C.bg}}>{row.l}</td>
                      {fRows.map(r=><td key={r.date} style={{padding:'6px 10px',textAlign:'right' as const,color:C.blue}}>{Math.round(Number((r as any)[row.k])*1000)/10}%</td>)}
                    </tr>
                  ))}
                  <tr style={{background:'#EDE9FE44'}}><td colSpan={fRows.length+1} style={{padding:'6px 10px',fontWeight:700,fontSize:11,textTransform:'uppercase' as const,letterSpacing:'.06em',color:'#5B21B6',position:'sticky' as const,left:0}}>Retained Leads</td></tr>
                  {[{l:'Leads sent',k:'ret_sent'},{l:'Leads dialled',k:'ret_dialled'},{l:'Leads connected',k:'ret_connected'},{l:'Leads qualified',k:'ret_qualified'},{l:'High intent',k:'ret_high'},{l:'Medium intent',k:'ret_medium'},{l:'Low intent',k:'ret_low'},{l:'Callback w/ agent',k:'ret_callback'}].map((row,ri)=>(
                    <tr key={row.k} style={{borderBottom:`1px solid ${C.borderL}`}}>
                      <td style={{padding:'6px 10px',fontWeight:ri<4?500:400,color:C.text,position:'sticky' as const,left:0,background:C.surface}}>{row.l}</td>
                      {fRows.map(r=><td key={r.date} style={{padding:'6px 10px',textAlign:'right' as const,fontVariantNumeric:'tabular-nums' as const}}>{(Number((r as any)[row.k])||0).toLocaleString()}</td>)}
                    </tr>
                  ))}
                  {[{l:'Connect %',k:'ret_connect_rate'},{l:'Qualify %',k:'ret_qualify_rate'}].map(row=>(
                    <tr key={row.k} style={{borderBottom:`1px solid ${C.borderL}`,background:C.bg}}>
                      <td style={{padding:'6px 10px',color:C.text3,fontStyle:'italic',position:'sticky' as const,left:0,background:C.bg}}>{row.l}</td>
                      {fRows.map(r=><td key={r.date} style={{padding:'6px 10px',textAlign:'right' as const,color:'#7C3AED'}}>{Math.round(Number((r as any)[row.k])*1000)/10}%</td>)}
                    </tr>
                  ))}
                  <tr style={{background:C.amberL+'44'}}><td colSpan={fRows.length+1} style={{padding:'6px 10px',fontWeight:700,fontSize:11,textTransform:'uppercase' as const,letterSpacing:'.06em',color:C.amber,position:'sticky' as const,left:0}}>Combined Qualified → CC</td></tr>
                  <tr style={{borderBottom:`1px solid ${C.borderL}`,background:C.amberL+'22'}}>
                    <td style={{padding:'6px 10px',fontWeight:600,color:C.amber,position:'sticky' as const,left:0,background:C.amberL+'22'}}>Total qualified</td>
                    {fRows.map(r=><td key={r.date} style={{padding:'6px 10px',textAlign:'right' as const,color:C.amber,fontWeight:600}}>{(r.bot_qualified||0).toLocaleString()}</td>)}
                  </tr>
                  <tr style={{borderBottom:`2px dashed ${C.amber}`}}></tr>
                  <tr style={{background:C.greenL+'44'}}><td colSpan={fRows.length+1} style={{padding:'6px 10px',fontWeight:700,fontSize:11,textTransform:'uppercase' as const,letterSpacing:'.06em',color:C.green,position:'sticky' as const,left:0}}>Call Centre (bot-qualified leads only)</td></tr>
                  {[{l:'CC received',k:'cc_sent'},{l:'CC attempted',k:'cc_attempted'},{l:'CC connected',k:'cc_connected'},{l:'CC converted',k:'cc_converted'}].map((row,ri)=>(
                    <tr key={row.k} style={{borderBottom:`1px solid ${C.borderL}`}}>
                      <td style={{padding:'6px 10px',fontWeight:ri===0?600:400,color:ri===0?C.green:C.text,position:'sticky' as const,left:0,background:C.surface}}>{row.l}</td>
                      {fRows.map(r=><td key={r.date} style={{padding:'6px 10px',textAlign:'right' as const,fontVariantNumeric:'tabular-nums' as const}}>{r.cc_sent>0?(Number((r as any)[row.k])||0).toLocaleString():'—'}</td>)}
                    </tr>
                  ))}
                  {[{l:'CC convert %',k:'cc_convert_rate'},{l:'Conv on connect %',k:'cc_conversion_on_connect'},{l:'End-to-end %',k:'e2e_rate'}].map(row=>(
                    <tr key={row.k} style={{borderBottom:`1px solid ${C.borderL}`,background:C.bg}}>
                      <td style={{padding:'6px 10px',color:C.text3,fontStyle:'italic',position:'sticky' as const,left:0,background:C.bg}}>{row.l}</td>
                      {fRows.map(r=><td key={r.date} style={{padding:'6px 10px',textAlign:'right' as const,color:C.green}}>{r.cc_sent>0?Math.round(Number((r as any)[row.k])*10000)/100+'%':'—'}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            }
          </div>}
        </>}
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
        {tab==='retention'&&<>
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:16,flexWrap:'wrap' as const}}>
            <span style={{fontSize:12,color:C.text2}}>Metric</span>
            <select style={inp} value={retMetric} onChange={e=>setRetMetric(e.target.value as any)}>
              <option value="connected">Grey Connectivity</option>
              <option value="qualified">Grey Qualification</option>
              <option value="enser">Enser Conversion</option>
            </select>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:8,marginTop:8,marginBottom:4,flexWrap:'wrap' as const}}>
            <button onClick={()=>setRetCumulative(false)} style={{padding:'4px 12px',borderRadius:4,border:`1px solid ${C.border}`,background:!retCumulative?C.blueM:'transparent',color:!retCumulative?'#fff':C.text2,cursor:'pointer',fontSize:12}}>Absolute</button>
            <button onClick={()=>setRetCumulative(true)} style={{padding:'4px 12px',borderRadius:4,border:`1px solid ${C.border}`,background:retCumulative?C.blueM:'transparent',color:retCumulative?'#fff':C.text2,cursor:'pointer',fontSize:12}}>Cumulative</button>
            {retMetric==='enser'&&<><span style={{width:1,height:16,background:C.border,display:'inline-block',margin:'0 4px'}}/>
            <button onClick={()=>setRetEnserDenom('sent')} style={{padding:'4px 12px',borderRadius:4,border:`1px solid ${C.border}`,background:retEnserDenom==='sent'?C.green:'transparent',color:retEnserDenom==='sent'?'#fff':C.text2,cursor:'pointer',fontSize:12}}>% of CC Received</button>
            <button onClick={()=>setRetEnserDenom('attempted')} style={{padding:'4px 12px',borderRadius:4,border:`1px solid ${C.border}`,background:retEnserDenom==='attempted'?C.green:'transparent',color:retEnserDenom==='attempted'?'#fff':C.text2,cursor:'pointer',fontSize:12}}>% of CC Attempted</button></>}
          </div>
          {retRows.length===0
            ?<div style={{...card,textAlign:'center' as const,padding:40,color:C.text3}}>No retention data yet — upload daily Excel files via the "+ Data" tab</div>
            :<div style={{...card,overflowX:'auto' as const,maxHeight:'75vh',overflow:'auto' as const}}>
              <table style={{width:'100%',borderCollapse:'collapse' as const,fontSize:12}}>
                <thead style={{position:'sticky' as const,top:0,zIndex:10}}>
                  <tr style={{borderBottom:`2px solid ${C.border}`,background:C.surface}}>
                    <th style={{textAlign:'left' as const,padding:'8px 12px',fontWeight:600,color:C.text2,position:'sticky' as const,left:0,background:C.surface,minWidth:100,zIndex:20}}>Cohort</th>
                    <th style={{textAlign:'right' as const,padding:'8px 12px',fontWeight:600,color:C.text2,whiteSpace:'nowrap' as const}}>Leads Sent</th>
                    {[0,1,2,3,4,5,6].slice(0,retMetric==='enser'?7:5).map(d=>(
                      <th key={d} style={{textAlign:'right' as const,padding:'8px 12px',fontWeight:600,color:C.text2,whiteSpace:'nowrap' as const,background:C.surface}}>Day {d}</th>
                    ))}
                    <th style={{textAlign:'right' as const,padding:'8px 12px',fontWeight:700,color:C.blue,whiteSpace:'nowrap' as const,background:C.blueL,position:'sticky' as const,right:0,borderLeft:`1px solid ${C.border}`,zIndex:20}}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {retRows.map((row:any)=>{
                    const maxDay=retMetric==='enser'?6:4;
                    let total=0;
                    const cells=[];
                    for(let d=0;d<=maxDay;d++){
                      const absVal=retMetric==='enser'?(row.enser?.[`day${d}`]?.converted||0):(row.grey?.[`day${d}`]?.[retMetric]||0);
                      total+=absVal;
                      const cumVal=total; // cumulative = running sum up to this day
                      const val=retCumulative?cumVal:absVal;
                      const denom = retMetric==='enser' ? (retEnserDenom==='attempted'?(row.cc_attempted||row.cc_sent||0):(row.cc_sent||0)) : (row.leads_sent||0);
                      const p2 = denom>0 ? Math.round(val/denom*1000)/10 : 0;
                      cells.push({val,pct:p2});
                    }
                    const denom2 = retMetric==='enser' ? (retEnserDenom==='attempted'?(row.cc_attempted||row.cc_sent||0):(row.cc_sent||0)) : (row.leads_sent||0);
                    // In cumulative mode, total column shows same as last non-empty day (already the max)
                    // In absolute mode, total is sum of all days
                    const totalPct = denom2>0 ? Math.round(total/denom2*1000)/10 : 0;
                    const col=retMetric==='enser'?C.green:retMetric==='qualified'?C.purpleM:C.blueM;
                    return(
                      <tr key={row.cohort_date} style={{borderBottom:`1px solid ${C.borderL}`}}>
                        <td style={{padding:'7px 12px',fontWeight:500,position:'sticky' as const,left:0,background:C.surface}}>{row.cohort_date?.slice(5)}</td>
                        <td style={{padding:'7px 12px',textAlign:'right' as const,fontVariantNumeric:'tabular-nums' as const,color:C.text2}}>{(retMetric==='enser'?(row.cc_sent||0):(row.leads_sent||0)).toLocaleString()}</td>
                        {cells.map((c2,i)=>(
                          <td key={i} style={{padding:'7px 12px',textAlign:'right' as const,whiteSpace:'nowrap' as const}}>
                            {c2.val>0
                              ?<><span style={{fontWeight:500,color:col}}>{c2.pct}%</span><span style={{fontSize:10,color:C.text3,marginLeft:3}}>({c2.val})</span></>
                              :<span style={{color:C.borderL}}>—</span>
                            }
                          </td>
                        ))}
                        <td style={{padding:'7px 12px',textAlign:'right' as const,background:C.blueL,fontWeight:700,color:col,position:'sticky' as const,right:0,borderLeft:`1px solid ${C.border}`}}>
                          {totalPct>0?<>{totalPct}%<span style={{fontSize:10,color:C.text3,marginLeft:3}}>({total})</span></>:<span style={{color:C.text3}}>—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          }
          <div style={{...card,marginTop:16,maxWidth:500}}>
            <div style={cardT}><span style={bCC}>Enser</span> Conversion Cohort Sync</div>
            <p style={{fontSize:12,color:C.text3,marginBottom:12}}>Sync Enser conversion data for a cohort date via Chrome extension.</p>
            <div style={{display:'flex',gap:10,alignItems:'center',marginBottom:10}}>
              <input style={inp} type="date" value={retSyncDate} onChange={e=>setRetSyncDate(e.target.value)}/>
              <button style={{...btnP,background:C.greenM}} onClick={syncRetention} disabled={retLoading}>
                {retLoading?'Syncing…':'Sync conversions'}
              </button>
            </div>
            {retStatus&&<div style={{fontSize:12,padding:'8px 10px',borderRadius:6,background:retStatus.startsWith('✓')?C.greenL:C.redL,color:retStatus.startsWith('✓')?C.green:C.red}}>{retStatus}</div>}
          </div>
        </>}
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
            {ssAuthUrl&&<a href={SUPERSET_LOGIN} target="_blank" rel="noreferrer" style={{display:'block',textAlign:'center',marginTop:8,fontSize:12,color:C.blue}}>Open Superset →</a>}
            {ssStatus&&<div style={{marginTop:10,fontSize:12,color:ssStatus.startsWith('✓')?C.green:ssAuthUrl?C.amber:C.red,padding:'8px 10px',background:ssStatus.startsWith('✓')?C.greenL:ssAuthUrl?C.amberL:C.redL,borderRadius:6}}>{ssStatus}</div>}
            <hr style={{border:'none',borderTop:`1px dashed ${C.border}`,margin:'14px 0'}}/>
            <p style={{fontSize:11,color:C.text3}}>
              Calls and attributed conversions are fetched together for the selected calendar day.
            </p>
          </div>

          {/* Manual daily fetch — runs full cron (Gmail + grey retention + Enser cc_sent) for any date */}
          <div style={card}>
            <div style={cardT}><span style={bBot}>Bulk Sync</span> Sync a date range</div>
            <div style={{fontSize:12,color:C.text3,marginBottom:8}}>Fetches Gmail + grey retention + Enser cc_sent for every date in range. Runs one date at a time.</div>
            <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap' as const}}>
              <input style={{...inp,width:130}} type="date" value={manualCronDate} onChange={e=>setManualCronDate(e.target.value)}/>
              <span style={{fontSize:12,color:C.text3}}>to</span>
              <input style={{...inp,width:130}} type="date" value={manualCronEndDate} onChange={e=>setManualCronEndDate(e.target.value)}/>
              <button style={{...btnP,background:C.blueM}} onClick={runBulkSync} disabled={manualCronLoading}>
                {manualCronLoading?`Syncing… (${bulkSyncProgress})`:'Bulk Sync'}
              </button>
              {manualCronLoading&&<button style={{...btnP,background:C.red,padding:'6px 10px'}} onClick={()=>setBulkSyncCancelled(true)}>Stop</button>}
            </div>
            {manualCronStatus&&<div style={{fontSize:12,padding:'8px 10px',marginTop:6,borderRadius:6,background:manualCronStatus.startsWith('✓')?C.greenL:manualCronStatus.startsWith('⚠')?'#fffbe6':C.redL,color:manualCronStatus.startsWith('✓')?C.green:manualCronStatus.startsWith('⚠')?'#7c4a00':C.red,whiteSpace:'pre-wrap'}}>{manualCronStatus}</div>}
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

