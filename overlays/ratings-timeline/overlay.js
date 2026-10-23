// Copyright (c) 2026 18-LAB. MIT.
'use strict';
const strip=document.getElementById('strip'),canvas=document.getElementById('chart');
const settings={width:520,x:24,y:24,system:'etterna',anchor:'top-right'};
const state={checksum:'',rate:1,position:0,playing:false,points:[],duration:1,request:0,key:'',local:false,overall:0,hop:1};
const fields=['/beatmap/checksum','/beatmap/time/live','/play/mods/rate','/state/number'];
const values=[];
let stopped=false,stream,commands;
async function read(path){const r=await fetch('/tools/mania-ratings/api/'+path);if(!r.ok){if([404,502,503].includes(r.status))throw Error('Mania ratings tool unavailable · install Mania ratings in vosu');throw Error(`Mania ratings error (${r.status})`);}const j=await r.json();if(j.error)throw Error(j.error);return j;}
function draw(){
 const w=canvas.clientWidth,h=canvas.clientHeight,dpr=devicePixelRatio||1;
 canvas.width=w*dpr;canvas.height=h*dpr;const c=canvas.getContext('2d');c.scale(dpr,dpr);c.clearRect(0,0,w,h);
 c.strokeStyle='#3b3f45';c.beginPath();c.moveTo(0,h-1);c.lineTo(w,h-1);c.stroke();
 const peak=Math.max(1,...state.points.map(p=>p.value)),max=state.local?Math.max(40,Math.ceil(Math.max(peak,state.overall)/10)*10):peak;
 for(const p of state.points){
  // Same bands as the Mania ratings tool: one accent at rising strength, 40+ in the text colour (18-LAB dark tokens).
  const x=p.time/state.duration*w,band=Math.min(4,Math.floor(p.value/10));c.globalAlpha=[.32,.5,.7,.9,1][band]*(state.playing&&p.time>state.position?.35:1);
  c.fillStyle=band===4?'#ebe8e1':'#ff963f';
  c.fillRect(x,h-p.value/max*(h-3),Math.max(1,state.hop/state.duration*w),p.value/max*(h-3));
 }
 c.globalAlpha=1;
 if(state.local&&state.points.length){
  const y=h-state.overall/max*(h-3);c.strokeStyle='#ebe8e1';c.lineWidth=1;c.setLineDash([2,3]);c.beginPath();c.moveTo(0,y);c.lineTo(w,y);c.stroke();c.setLineDash([]);
  c.fillStyle='#b8b5ad';c.font='7px monospace';c.fillText(`${max} MSD`,2,7);
 }
 if(state.playing&&state.points.length){const x=Math.max(0,Math.min(w,state.position/state.duration*w));c.strokeStyle='#ebe8e1';c.lineWidth=2;c.beginPath();c.moveTo(x,0);c.lineTo(x,h);c.stroke();}
 document.getElementById('time').textContent=state.playing?`${Math.max(0,Math.floor(state.position/60))}:${Math.max(0,Math.floor(state.position%60)).toString().padStart(2,'0')}`:'';
}
async function calculate(){
 const key=`${state.checksum}:${state.rate}:${settings.system}`;if(key===state.key)return;state.key=key;
 const request=++state.request;
 state.points=[];draw();document.getElementById('overall').textContent='—';document.getElementById('skill').textContent='';
 if(!state.checksum){document.getElementById('message').textContent='Select an osu!mania beatmap';return;}
 document.getElementById('message').textContent='Analyzing…';
 try{
  // Current route resolves the selected file and seeds its checksum cache.
  const rating=await read(`v1/beatmap/current?rate=${state.rate}`);
  if(request!==state.request)return;if(rating.unsupported)throw Error(rating.unsupported);
  const local=settings.system==='etterna';
  const timeline=await read(`v1/beatmap/${rating.checksum}/timeline?rate=${rating.rate}&system=${settings.system}&window=${local?12:1}&hop=${local?1:.5}`);
  if(request!==state.request)return;
  state.points=timeline.points;state.duration=Math.max(1,timeline.duration);
  state.local=timeline.mode==='local_msd';state.overall=timeline.overall||0;state.hop=timeline.hop;
  const number=['etterna','etterna-native'].includes(settings.system)?rating.msd?.overall:settings.system==='osu'?rating.stars:settings.system==='nps'?Math.max(0,...state.points.map(p=>p.nps)):rating[settings.system];
  document.getElementById('overall').textContent=number==null?'—':Number(number).toFixed(2);
  const top=Object.entries(rating.msd||{}).filter(([name])=>!['overall','stamina'].includes(name)).sort((a,b)=>b[1]-a[1])[0];
  document.getElementById('skill').textContent=top?`${top[0]} ${Number(top[1]).toFixed(1)}`:'';
  document.getElementById('message').textContent=state.local?'LOCAL MSD / 12s · dotted = map · no smoothing':`${settings.system.toUpperCase()} / native strain · no smoothing`;
  document.body.classList.remove('unavailable');draw();
 }catch(error){if(request!==state.request)return;document.body.classList.add('unavailable');document.getElementById('message').textContent=error.message;state.key='';}
}
function connect(){
 if(stopped)return;
 stream=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/websocket/v2/subscribe`);
 stream.onopen=()=>stream.send(JSON.stringify(fields));
 stream.onmessage=event=>{
  try{
   const frame=JSON.parse(event.data);if(frame[0]===2)throw Error(frame[2]);
   if(![0,1].includes(frame[0])||!Array.isArray(frame[2]))return;
   if(frame[0]===0)values.length=0;
   for(const [i,value] of frame[2])values[i]=value;
   for(const i of frame[3]||[])delete values[i];
   state.checksum=typeof values[0]==='string'?values[0]:'';state.position=Number(values[1]||0)/1000;
   const rate=Number(values[2]??1);state.rate=Number.isFinite(rate)?Math.round(rate*20)/20:1;state.playing=Number(values[3])===2;
   document.getElementById('mode').textContent=state.playing?'IN PLAY':'SONG SELECT';document.getElementById('rate').textContent=`${state.rate.toFixed(2)}×`;
   if(state.rate<.5||state.rate>2){state.points=[];state.key='';++state.request;document.getElementById('message').textContent='Mania ratings supports 0.50–2.00×';document.getElementById('overall').textContent='—';draw();return;}
   void calculate();draw();
  }catch(e){document.getElementById('message').textContent=`Telemetry: ${e.message}`;}
 };
 stream.onclose=()=>{if(stopped)return;document.getElementById('message').textContent='vosu disconnected · retrying';setTimeout(connect,2000);};
}
function applySettings(value){
 for(const key of ['width','x','y']){const n=Number(value[key]);if(Number.isFinite(n))settings[key]=n;}
 if(['etterna','etterna-native','quaver','interlude','osu','nps'].includes(value.system))settings.system=value.system;
 if(['top-left','top-right','bottom-left','bottom-right'].includes(value.anchor))settings.anchor=value.anchor;
 strip.style.width=`${Math.max(320,Math.min(900,settings.width))}px`;
 for(const edge of ['top','bottom','left','right'])strip.style[edge]='auto';
 strip.style[settings.anchor.startsWith('top')?'top':'bottom']=`${Math.max(0,settings.y)}px`;
 strip.style[settings.anchor.endsWith('left')?'left':'right']=`${Math.max(0,settings.x)}px`;
 void calculate();draw();
}
function connectSettings(){
 if(stopped)return;
 const path=window.COUNTER_PATH||'ratings-timeline';
 commands=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/websocket/commands?${encodeURIComponent(path)}`);
 commands.onopen=()=>commands.send(`getSettings:${encodeURIComponent(path)}`);
 commands.onmessage=event=>{try{const frame=JSON.parse(event.data);if(['getSettings','updateSettings'].includes(frame.command)&&frame.message&&!frame.message.error)applySettings(frame.message);}catch{}};
 commands.onclose=()=>{if(!stopped)setTimeout(connectSettings,2000);};
}
new ResizeObserver(draw).observe(canvas);
window.addEventListener('pagehide',()=>{stopped=true;stream?.close();commands?.close();});
connect();connectSettings();
