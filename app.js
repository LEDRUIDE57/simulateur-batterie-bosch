'use strict';

const DEFAULTS = Object.freeze({
  batteryCapacityWh:800.0,
  distanceFactor:1.02775,
  elevationFactor:1.1356,
  smoothingWindowM:110.0,
  resampleStepM:5.0,
  segmentLengthKm:1.0,
  tourThresholdPct:1.29,
  emtbPlusThresholdPct:3.88,
  tourConsumptionWhPerKm:5.5,
  emtbConsumptionWhPerKm:7.5,
  emtbPlusConsumptionWhPerKm:10.0,
  climbCoefficientWhPerM:0.15,
  rechargeWh:200.0
});
const STORAGE_KEY='simulateur-batterie-gpx-bosch-v2-2-settings';
let settings=loadSettings();
let gpxData=null, gpxName=null, simulation=null;

const $=s=>document.querySelector(s); const $$=s=>[...document.querySelectorAll(s)];
const fr=(n,d=1)=>Number(n).toLocaleString('fr-FR',{minimumFractionDigits:d,maximumFractionDigits:d});
const fr0=n=>fr(n,0); const fr1=n=>fr(n,1); const fr2=n=>fr(n,2);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

function loadSettings(){
  try{return {...DEFAULTS,...JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}')}}catch{return {...DEFAULTS}}
}
function saveSettings(){localStorage.setItem(STORAGE_KEY,JSON.stringify(settings))}
function setStatus(text){$('#appStatus').textContent=text}

function haversineKm(a,b){
  const R=6371.0,rad=x=>x*Math.PI/180;
  const dLat=rad(b.lat-a.lat),dLon=rad(b.lon-a.lon),lat1=rad(a.lat),lat2=rad(b.lat);
  const x=Math.sin(dLat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(Math.max(0,1-x)));
}

function parseGpx(text){
  const doc=new DOMParser().parseFromString(text,'application/xml');
  if(doc.querySelector('parsererror')) throw new Error('Le fichier GPX est invalide ou illisible.');
  const creator=doc.documentElement?.getAttribute('creator')||'';
  const nodes=[...doc.getElementsByTagNameNS('*','trkpt')];
  if(nodes.length<2) throw new Error('Le GPX doit contenir au moins deux points <trkpt>.');
  const points=nodes.map(n=>{
    const lat=Number(n.getAttribute('lat')),lon=Number(n.getAttribute('lon'));
    const eleNode=[...n.children].find(c=>c.localName==='ele');
    const ele=eleNode?Number(eleNode.textContent):null;
    if(!Number.isFinite(lat)||!Number.isFinite(lon)) throw new Error('Un point GPX contient des coordonnées invalides.');
    return {lat,lon,ele:Number.isFinite(ele)?ele:null};
  });
  if(points.filter(p=>p.ele!=null).length<2) throw new Error('Le GPX doit contenir des altitudes exploitables.');
  return {points,creator,source:detectSource(creator)};
}
function detectSource(creator){
  const c=String(creator||'').toLowerCase();
  if(c.includes('komoot')) return 'Komoot';
  if(c.includes('bosch')) return 'Bosch eBike Flow';
  return creator?'Autre GPX':'Source non indiquée';
}

function prepareProfile(points,s){
  if(!(s.resampleStepM>0&&s.smoothingWindowM>0&&s.segmentLengthKm>0&&s.distanceFactor>0&&s.elevationFactor>0))
    throw new Error('Les paramètres de profil doivent être supérieurs à zéro.');

  const elevations=points.map(p=>p.ele);
  // Interpolation simple des rares altitudes manquantes, sans modifier l'ordre spatial du GPX.
  let lastKnown=-1;
  for(let i=0;i<elevations.length;i++){
    if(elevations[i]!=null){
      if(lastKnown<0){for(let j=0;j<i;j++) elevations[j]=elevations[i]}
      else if(i-lastKnown>1){
        const a=elevations[lastKnown],b=elevations[i],span=i-lastKnown;
        for(let j=1;j<span;j++) elevations[lastKnown+j]=a+(b-a)*(j/span);
      }
      lastKnown=i;
    }
  }
  if(lastKnown<elevations.length-1){for(let j=lastKnown+1;j<elevations.length;j++) elevations[j]=elevations[lastKnown]}

  const cumKm=new Array(points.length);cumKm[0]=0;
  for(let i=1;i<points.length;i++) cumKm[i]=cumKm[i-1]+haversineKm(points[i-1],points[i]);
  const totalRawKm=cumKm.at(-1);
  if(!(totalRawKm>0)) throw new Error('La distance du GPX est nulle.');

  // Supprime uniquement les positions de distance exactement répétées pour permettre l'interpolation.
  // L'ordre du tracé n'est jamais trié ni réorganisé.
  const d=[],e=[];
  for(let i=0;i<cumKm.length;i++){
    if(i===0||cumKm[i]-d.at(-1)>1e-12){d.push(cumKm[i]);e.push(elevations[i])}
  }

  const stepKm=s.resampleStepM/1000;
  const grid=[];
  for(let x=0;x<totalRawKm;x+=stepKm) grid.push(x);
  if(!grid.length||grid.at(-1)<totalRawKm-1e-12) grid.push(totalRawKm);

  const gridEle=new Array(grid.length);let p=0;
  for(let i=0;i<grid.length;i++){
    const x=grid[i];
    while(p<d.length-2&&d[p+1]<x) p++;
    const x1=d[p],x2=d[Math.min(p+1,d.length-1)],y1=e[p],y2=e[Math.min(p+1,e.length-1)];
    const t=x2>x1?clamp((x-x1)/(x2-x1),0,1):0;
    gridEle[i]=y1+(y2-y1)*t;
  }

  let n=Math.max(1,Math.round(s.smoothingWindowM/s.resampleStepM));
  if(n%2===0)n++;
  const half=Math.floor(n/2),prefix=new Array(gridEle.length+1).fill(0);
  for(let i=0;i<gridEle.length;i++) prefix[i+1]=prefix[i]+gridEle[i];
  const smooth=new Array(gridEle.length);
  for(let i=0;i<gridEle.length;i++){
    const a=Math.max(0,i-half),b=Math.min(gridEle.length-1,i+half);
    smooth[i]=(prefix[b+1]-prefix[a])/(b-a+1);
  }

  return {grid,smooth,totalRawKm,effectiveSmoothingM:n*s.resampleStepM};
}

function makeSegments(profile,s){
  const {grid,smooth}=profile,segKm=s.segmentLengthKm;
  const raw=[];let curDist=0,curGain=0;
  for(let i=1;i<grid.length;i++){
    const edgeDist=grid[i]-grid[i-1];
    const edgeGain=Math.max(0,smooth[i]-smooth[i-1]);
    let rem=edgeDist;
    while(rem>1e-15){
      const space=segKm-curDist,take=Math.min(rem,space),frac=edgeDist>0?take/edgeDist:0;
      curDist+=take;curGain+=edgeGain*frac;rem-=take;
      if(curDist>=segKm-1e-12){raw.push({rawDistanceKm:curDist,rawGainM:curGain});curDist=0;curGain=0}
    }
  }
  if(curDist>1e-10) raw.push({rawDistanceKm:curDist,rawGainM:curGain});

  let km=0,cumulativeWh=0;
  return raw.map((r,i)=>{
    const gradePct=r.rawDistanceKm>0?r.rawGainM/(r.rawDistanceKm*1000)*100:0;
    const mode=gradePct<s.tourThresholdPct?'TOUR':(gradePct<s.emtbPlusThresholdPct?'eMTB':'eMTB+');
    const distanceKm=r.rawDistanceKm*s.distanceFactor;
    const elevationGainM=r.rawGainM*s.elevationFactor;
    const rate=mode==='TOUR'?s.tourConsumptionWhPerKm:(mode==='eMTB'?s.emtbConsumptionWhPerKm:s.emtbPlusConsumptionWhPerKm);
    const consumptionExactWh=distanceKm*rate+elevationGainM*s.climbCoefficientWhPerM;
    const startKm=km;km+=distanceKm;cumulativeWh+=consumptionExactWh;
    return {
      index:i+1,startKm,endKm:km,distanceKm,elevationGainM,modelGradePct:gradePct,mode,
      consumptionExactWh,cumulativeExactWh:cumulativeWh,
      remainingExactWh:s.batteryCapacityWh-cumulativeWh
    };
  });
}

function buildRechargeScenario(segments,totalConsumptionExact,s){
  const capacity=s.batteryCapacityWh,available=Math.max(0,s.rechargeWh);
  if(!segments.length||available<=0) return {enabled:false,reason:'Énergie de recharge réglée à 0 Wh.'};
  const usable=Math.min(available,capacity),energyToFull=Math.min(totalConsumptionExact,usable);
  let crossingIndex=segments.length-1,rechargeKm=segments.at(-1).endKm,previousCum=0;
  for(let i=0;i<segments.length;i++){
    const seg=segments[i];
    if(seg.cumulativeExactWh+1e-9>=energyToFull){
      crossingIndex=i;
      const inside=Math.max(0,energyToFull-previousCum),fraction=seg.consumptionExactWh>0?clamp(inside/seg.consumptionExactWh,0,1):0;
      rechargeKm=seg.startKm+(seg.endKm-seg.startKm)*fraction;break;
    }
    previousCum=seg.cumulativeExactWh;
  }
  const beforeWh=capacity-energyToFull,finalWh=capacity-(totalConsumptionExact-energyToFull);
  return {
    enabled:true,availableWh:available,energyAddedWh:energyToFull,rechargeKm,crossingIndex,beforeWh,beforePercent:beforeWh/capacity,
    finalWh,finalPercent:finalWh/capacity,consumptionAfterRechargeWh:Math.max(0,totalConsumptionExact-energyToFull),
    usesFullAvailable:Math.abs(energyToFull-usable)<0.05,
    batteryAfterSegment(i){
      const seg=segments[i];
      if(i<crossingIndex)return seg.remainingExactWh;
      if(i===crossingIndex)return capacity-Math.max(0,seg.cumulativeExactWh-energyToFull);
      return seg.remainingExactWh+energyToFull;
    }
  };
}

function simulate(data,s){
  if(!(s.batteryCapacityWh>0&&s.tourThresholdPct>=0&&s.emtbPlusThresholdPct>s.tourThresholdPct)) throw new Error('Vérifie la batterie et les seuils de modes V2.');
  const profile=prepareProfile(data.points,s),segments=makeSegments(profile,s);
  const modes={TOUR:0,eMTB:0,'eMTB+':0};segments.forEach(x=>modes[x.mode]+=x.distanceKm);
  const totalDistanceFlowKm=segments.reduce((a,x)=>a+x.distanceKm,0);
  const totalElevationGainM=segments.reduce((a,x)=>a+x.elevationGainM,0);
  const totalConsumptionExactWh=segments.at(-1)?.cumulativeExactWh||0;
  const result={
    segments,settings:s,source:data.source,creator:data.creator,points:data.points.length,
    totalDistanceRawKm:profile.totalRawKm,totalDistanceFlowKm,totalElevationGainM,
    totalElevationSmoothedKomootM:totalElevationGainM/s.elevationFactor,
    effectiveSmoothingM:profile.effectiveSmoothingM,modes,totalConsumptionExactWh,
    remainingExactWh:s.batteryCapacityWh-totalConsumptionExactWh
  };
  result.remainingPercent=result.remainingExactWh/s.batteryCapacityWh;
  result.recharge=buildRechargeScenario(segments,totalConsumptionExactWh,s);
  return result;
}

function selectScreen(name){
  $$('.tab').forEach(b=>b.classList.toggle('active',b.dataset.screen===name));
  $$('.screen').forEach(s=>s.classList.toggle('active',s.id===`screen-${name}`));
  if(name==='results'&&simulation)requestAnimationFrame(renderCharts);
}
$$('.tab').forEach(b=>b.addEventListener('click',()=>selectScreen(b.dataset.screen)));

function fillSettings(){$$('[data-setting]').forEach(i=>{i.value=settings[i.dataset.setting]})}
function readSettings(){
  const next={...settings};
  $$('[data-setting]').forEach(i=>{const v=Number(String(i.value).replace(',','.'));if(!Number.isFinite(v))throw new Error(`Valeur invalide : ${i.dataset.setting}`);next[i.dataset.setting]=v});
  return next;
}
$('#saveSettingsBtn').addEventListener('click',()=>{
  try{settings=readSettings();saveSettings();$('#settingsSaved').textContent='Paramètres V2.5 enregistrés.';setTimeout(()=>$('#settingsSaved').textContent='',2200);if(gpxData)analyze()}catch(e){alert(e.message)}
});
$('#resetSettingsBtn').addEventListener('click',()=>{
  if(!confirm('Revenir aux valeurs de calibration Bosch V2 validées ?'))return;
  settings={...DEFAULTS};saveSettings();fillSettings();if(gpxData)analyze();
});

$('#gpxInput').addEventListener('change',async e=>{
  const file=e.target.files?.[0];if(!file)return;setStatus('Lecture GPX…');
  try{gpxName=file.name;gpxData=parseGpx(await file.text());analyze();selectScreen('gpx')}catch(err){console.error(err);setStatus('Erreur');alert(err.message)}finally{e.target.value=''}
});
$('#reanalyzeBtn').addEventListener('click',()=>{if(gpxData)analyze()});

function metric(label,value,cls='',sub=''){return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value ${cls}">${value}</div>${sub?`<div class="metric-sub">${sub}</div>`:''}</div>`}
function batteryClass(wh){const pct=settings.batteryCapacityWh>0?wh/settings.batteryCapacityWh:0;return pct<.10?'bad':pct<=.20?'warn':'good'}
function modeClass(mode){return mode==='TOUR'?'tour':mode==='eMTB'?'emtb':'emtbplus'}

function analyze(){
  try{
    simulation=simulate(gpxData,settings);setStatus('Prévision calculée');
    $('#gpxEmpty').classList.add('hidden');$('#gpxLoaded').classList.remove('hidden');$('#resultsEmpty').classList.add('hidden');$('#resultsContent').classList.remove('hidden');
    $('#fileName').textContent=gpxName;$('#resultFileName').textContent=gpxName;$('#sourceLine').textContent=`Source détectée : ${simulation.source}`;
    $('#gpxMetrics').innerHTML=[
      metric('Points GPX',simulation.points.toLocaleString('fr-FR')),
      metric('Distance Komoot',`${fr2(simulation.totalDistanceRawKm)} km`),
      metric('Distance Flow prévue',`${fr2(simulation.totalDistanceFlowKm)} km`,'good',`× ${fr(settings.distanceFactor,5)}`),
      metric('D+ Komoot lissé',`${fr0(simulation.totalElevationSmoothedKomootM)} m`),
      metric('D+ Flow prévu',`${fr0(simulation.totalElevationGainM)} m`,'good',`× ${fr(settings.elevationFactor,4)}`),
      metric('Tronçons',simulation.segments.length.toLocaleString('fr-FR'),'','modèle 1 km')
    ].join('');
    const warning=$('#sourceWarning');
    if(simulation.source!=='Komoot'){
      warning.classList.remove('hidden');warning.innerHTML=`<strong>Attention :</strong> la V2 est calibrée pour un GPX préparé dans Komoot. Source détectée : <strong>${simulation.source}</strong>.`;
    }else warning.classList.add('hidden');
    renderResults();
  }catch(e){console.error(e);setStatus('Erreur');alert(e.message)}
}

function renderResults(){
  const r=simulation,s=settings,re=r.recharge;
  $('#routeMetrics').innerHTML=[
    metric('Distance Flow prévue',`${fr2(r.totalDistanceFlowKm)} km`,'good'),
    metric('D+ Flow prévu',`${fr0(r.totalElevationGainM)} m`,'good'),
    metric('TOUR',`${fr2(r.modes.TOUR)} km`,'tour-text'),
    metric('eMTB',`${fr2(r.modes.eMTB)} km`,'emtb-text'),
    metric('eMTB+',`${fr2(r.modes['eMTB+'])} km`,'emtbplus-text'),
    metric('Batterie',`${fr0(s.batteryCapacityWh)} Wh`)
  ].join('');
  $('#modelSummary').innerHTML=`
    <div><strong>Distance :</strong> GPX Komoot × ${fr(s.distanceFactor,5)}.</div>
    <div><strong>Altitude :</strong> rééchantillonnage ${fr0(s.resampleStepM)} m, lissage demandé ${fr0(s.smoothingWindowM)} m (effectif ~${fr0(r.effectiveSmoothingM)} m), puis D+ × ${fr(s.elevationFactor,4)}.</div>
    <div><strong>Modes :</strong> TOUR &lt; ${fr(s.tourThresholdPct,2)} %, eMTB ${fr(s.tourThresholdPct,2)}–&lt;${fr(s.emtbPlusThresholdPct,2)} %, eMTB+ ≥ ${fr(s.emtbPlusThresholdPct,2)} %.</div>
    <div><strong>Énergie :</strong> ${fr1(s.tourConsumptionWhPerKm)} / ${fr1(s.emtbConsumptionWhPerKm)} / ${fr1(s.emtbPlusConsumptionWhPerKm)} Wh/km + ${fr(s.climbCoefficientWhPerM,2)} Wh/m D+.</div>`;

  $('#noRechargeMetrics').innerHTML=[
    metric('Consommation prévue',`${fr1(r.totalConsumptionExactWh)} Wh`),
    metric('Batterie consommée',`${fr1(r.totalConsumptionExactWh/s.batteryCapacityWh*100)} %`),
    metric('Batterie finale',`${fr1(r.remainingExactWh)} Wh`,batteryClass(r.remainingExactWh)),
    metric('Batterie finale',`${fr0(r.remainingPercent*100)} %`,batteryClass(r.remainingExactWh))
  ].join('');
  $('#noRechargeStatus').textContent=r.remainingExactWh>=0?`Arrivée prévue avec ${fr0(r.remainingPercent*100)} % de batterie.`:`Batterie théoriquement épuisée avant l'arrivée (${fr1(-r.remainingExactWh)} Wh manquants).`;
  $('#noRechargeStatus').className=`scenario-note ${r.remainingExactWh>=0?'ok':'alert'}`;

  if(re.enabled){
    $('#withRechargeMetrics').innerHTML=[
      metric('Km du plein',`${fr1(re.rechargeKm)} km`,'','calculé automatiquement'),
      metric('Avant recharge',`${fr1(re.beforeWh)} Wh · ${fr0(re.beforePercent*100)} %`,batteryClass(re.beforeWh)),
      metric('Recharge déjeuner',`+${fr1(re.energyAddedWh)} Wh`,'',re.usesFullAvailable?`≈ 1 h 30 · objectif : retour à 100 %`:`sur ${fr0(re.availableWh)} Wh disponibles`),
      metric('Après recharge',`${fr0(s.batteryCapacityWh)} Wh · 100 %`,'good'),
      metric('Conso après le plein',`${fr1(re.consumptionAfterRechargeWh)} Wh`),
      metric('Batterie finale',`${fr1(re.finalWh)} Wh · ${fr0(re.finalPercent*100)} %`,batteryClass(re.finalWh))
    ].join('');
    $('#rechargeRule').innerHTML=`Pause déjeuner (~1 h 30) : dès <strong>${fr0(re.availableWh)} Wh consommés</strong>, le plein à 100 % est conseillé vers le <strong>km ${fr1(re.rechargeKm)}</strong>. La recharge prévue est de <strong>+${fr0(re.energyAddedWh)} Wh</strong>.`;
    $('#withRechargeStatus').textContent=re.finalWh>=0?`Après le plein, arrivée prévue avec ${fr0(re.finalPercent*100)} % de batterie.`:`Même avec le plein, la batterie serait théoriquement épuisée avant l'arrivée (${fr1(-re.finalWh)} Wh manquants).`;
    $('#withRechargeStatus').className=`scenario-note ${re.finalWh>=0?'ok':'alert'}`;
  }else{
    $('#withRechargeMetrics').innerHTML=metric('Recharge','Désactivée');$('#rechargeRule').textContent=re.reason||'Recharge indisponible.';$('#withRechargeStatus').textContent='Règle une énergie de recharge supérieure à 0 Wh.';$('#withRechargeStatus').className='scenario-note';
  }

  $('#segmentsBody').innerHTML=r.segments.map((x,i)=>{
    const withWh=re.enabled?re.batteryAfterSegment(i):null;
    return `<tr><td>${x.index}</td><td>${fr1(x.startKm)}</td><td>${fr1(x.endKm)}</td><td>${fr2(x.distanceKm)}</td><td>${fr0(x.elevationGainM)}</td><td>${fr2(x.modelGradePct)} %</td><td class="mode ${modeClass(x.mode)}">${x.mode}</td><td>${fr1(x.consumptionExactWh)}</td><td>${fr1(x.cumulativeExactWh)}</td><td class="remaining ${batteryClass(x.remainingExactWh)}">${fr1(x.remainingExactWh)}</td><td class="remaining ${withWh==null?'':batteryClass(withWh)}">${withWh==null?'—':fr1(withWh)}</td></tr>`;
  }).join('');
  requestAnimationFrame(renderCharts);
}

function niceMax(v,min){const x=Math.max(v,min),p=10**Math.floor(Math.log10(x)),n=x/p,q=n<=1?1:n<=2?2:n<=5?5:10;return q*p}
function renderCharts(){if(!simulation)return;drawChart($('#chartNoRecharge'),false);drawChart($('#chartWithRecharge'),true)}
function drawChart(canvas,withRecharge){
  const r=simulation,s=settings,re=r.recharge;if(withRecharge&&!re.enabled){drawEmptyCanvas(canvas,'Recharge désactivée.');return}
  const segs=r.segments,cssW=Math.max(canvas.parentElement.clientWidth-2,760),cssH=370,dpr=Math.min(window.devicePixelRatio||1,2);
  canvas.style.width=`${cssW}px`;canvas.style.height=`${cssH}px`;canvas.width=Math.floor(cssW*dpr);canvas.height=Math.floor(cssH*dpr);
  const c=canvas.getContext('2d');c.setTransform(dpr,0,0,dpr,0,0);c.clearRect(0,0,cssW,cssH);
  const L=52,R=60,T=32,B=50,W=cssW-L-R,H=cssH-T-B;
  const maxD=niceMax(Math.max(...segs.map(x=>x.elevationGainM),1),10),batteryVals=segs.map((x,i)=>withRecharge?re.batteryAfterSegment(i):x.remainingExactWh);
  const whMax=niceMax(Math.max(s.batteryCapacityWh,...batteryVals,...segs.map(x=>x.consumptionExactWh)),100),totalKm=Math.max(r.totalDistanceFlowKm,.001);
  const xKm=km=>L+clamp(km/totalKm,0,1)*W,yWh=v=>T+H-(v/whMax)*H,yD=v=>T+H-(v/maxD)*H;

  c.font='11px system-ui';c.fillStyle='#65717d';c.strokeStyle='#dfe5e9';c.lineWidth=1;
  for(let j=0;j<=4;j++){const f=j/4,y=T+H-H*f;c.beginPath();c.moveTo(L,y);c.lineTo(L+W,y);c.stroke();c.textAlign='right';c.fillText(fr0(maxD*f),L-7,y+4);c.textAlign='left';c.fillText(fr0(whMax*f),L+W+7,y+4)}
  c.strokeStyle='#65717d';c.beginPath();c.moveTo(L,T);c.lineTo(L,T+H);c.lineTo(L+W,T+H);c.lineTo(L+W,T);c.stroke();c.fillStyle='#65717d';c.textAlign='left';c.fillText('D+ (m)',4,16);c.textAlign='right';c.fillText('Wh',cssW-4,16);

  const thr=s.batteryCapacityWh*.10;if(thr>0){const yy=yWh(Math.min(thr,whMax));c.fillStyle='rgba(204,32,40,.07)';c.fillRect(L,yy,W,T+H-yy);c.strokeStyle='#cc2028';c.setLineDash([5,4]);c.beginPath();c.moveTo(L,yy);c.lineTo(L+W,yy);c.stroke();c.setLineDash([]);c.fillStyle='#cc2028';c.textAlign='left';c.fillText(`10 % · ${fr0(thr)} Wh`,L+5,yy-5)}

  c.fillStyle='#0070c0';segs.forEach(seg=>{const x1=xKm(seg.startKm),x2=xKm(seg.endKm),mid=(x1+x2)/2,bw=Math.max(2,(x2-x1)*.72),yy=yD(seg.elevationGainM);c.fillRect(mid-bw/2,yy,bw,T+H-yy)});
  const modeColors={TOUR:'#119640',eMTB:'#e89400','eMTB+':'#cc2028'};
  segs.forEach(seg=>{const xx=xKm((seg.startKm+seg.endKm)/2),yy=yWh(seg.consumptionExactWh);c.fillStyle=modeColors[seg.mode];c.beginPath();c.arc(xx,yy,2.7,0,Math.PI*2);c.fill()});

  const band={green:'#119640',yellow:'#e0a000',red:'#cc2028'};
  function batteryColor(wh){const pct=s.batteryCapacityWh>0?wh/s.batteryCapacityWh:0;if(pct>.20)return band.green;if(pct>=.10)return band.yellow;return band.red}
  const pts=[{km:0,wh:s.batteryCapacityWh}];
  if(!withRecharge)segs.forEach(seg=>pts.push({km:seg.endKm,wh:seg.remainingExactWh}));
  else for(let i=0;i<segs.length;i++){const seg=segs[i];if(i<re.crossingIndex)pts.push({km:seg.endKm,wh:seg.remainingExactWh});else if(i===re.crossingIndex){pts.push({km:re.rechargeKm,wh:re.beforeWh});pts.push({km:re.rechargeKm,wh:s.batteryCapacityWh});pts.push({km:seg.endKm,wh:re.batteryAfterSegment(i)})}else pts.push({km:seg.endKm,wh:re.batteryAfterSegment(i)})}
  const thresholds=[.20,.10].map(p=>p*s.batteryCapacityWh);
  function drawBatterySegment(a,b){const ts=[0,1],delta=b.wh-a.wh;if(Math.abs(delta)>1e-9)thresholds.forEach(th=>{const t=(th-a.wh)/delta;if(t>0&&t<1)ts.push(t)});ts.sort((x,y)=>x-y);for(let j=0;j<ts.length-1;j++){const t1=ts[j],t2=ts[j+1],tm=(t1+t2)/2,km1=a.km+(b.km-a.km)*t1,km2=a.km+(b.km-a.km)*t2,wh1=a.wh+delta*t1,wh2=a.wh+delta*t2,whm=a.wh+delta*tm;c.strokeStyle=batteryColor(whm);c.lineWidth=3;c.beginPath();c.moveTo(xKm(km1),yWh(wh1));c.lineTo(xKm(km2),yWh(wh2));c.stroke()}}
  for(let i=1;i<pts.length;i++)drawBatterySegment(pts[i-1],pts[i]);
  pts.forEach(p=>{c.fillStyle=batteryColor(p.wh);c.strokeStyle='rgba(23,50,77,.28)';c.lineWidth=.7;c.beginPath();c.arc(xKm(p.km),yWh(p.wh),2.8,0,Math.PI*2);c.fill();c.stroke()});
  if(withRecharge){
    const rx=xKm(re.rechargeKm);c.strokeStyle='#00a0d6';c.setLineDash([5,4]);c.lineWidth=1.5;c.beginPath();c.moveTo(rx,T);c.lineTo(rx,T+H);c.stroke();c.setLineDash([]);c.fillStyle='#006b91';c.textAlign='center';c.font='700 11px system-ui';c.fillText(`Déjeuner / plein · km ${fr1(re.rechargeKm)}`,rx,18);

    // Solde batterie en Wh directement sur la courbe : tous les 10 km, avant/après le plein et à l'arrivée.
    function batteryAtKm(km){
      for(let i=1;i<pts.length;i++){const a=pts[i-1],b=pts[i];if(b.km<=a.km)continue;if(km>=a.km-1e-9&&km<=b.km+1e-9){const t=clamp((km-a.km)/(b.km-a.km),0,1);return a.wh+(b.wh-a.wh)*t}}
      return pts.at(-1).wh;
    }
    function whLabel(km,wh,text,dy=-12){
      const x=xKm(km),baseY=yWh(wh),labelY=clamp(baseY+dy,T+12,T+H-8);c.font='700 10px system-ui';const pad=4,w=c.measureText(text).width+pad*2,h=16;let bx=clamp(x-w/2,L,L+W-w),by=dy<0?labelY-h:labelY;c.fillStyle='rgba(255,255,255,.94)';c.strokeStyle=batteryColor(wh);c.lineWidth=1;c.beginPath();if(c.roundRect)c.roundRect(bx,by,w,h,4);else c.rect(bx,by,w,h);c.fill();c.stroke();c.fillStyle='#17324d';c.textAlign='center';c.fillText(text,bx+w/2,by+11);
    }
    for(let km=10;km<totalKm-3;km+=10){const wh=batteryAtKm(km);whLabel(km,wh,`${fr0(wh)} Wh`,-10)}
    whLabel(re.rechargeKm,re.beforeWh,`${fr0(re.beforeWh)} Wh`,18);
    whLabel(re.rechargeKm,s.batteryCapacityWh,`${fr0(s.batteryCapacityWh)} Wh`,-10);
    const finalWh=pts.at(-1).wh;whLabel(totalKm,finalWh,`${fr0(finalWh)} Wh`,-10);
    c.font='11px system-ui';
  }
  c.fillStyle='#65717d';c.textAlign='center';for(let j=0;j<=8;j++){const km=totalKm*j/8;c.fillText(fr1(km),xKm(km),T+H+18)}c.fillText('Km Flow prévu',L+W/2,cssH-5);
  if(canvas.parentElement)canvas.parentElement.scrollLeft=0;
}
function drawEmptyCanvas(canvas,text){const w=Math.max(canvas.parentElement.clientWidth-2,760),h=370,dpr=Math.min(window.devicePixelRatio||1,2);canvas.style.width=`${w}px`;canvas.style.height=`${h}px`;canvas.width=w*dpr;canvas.height=h*dpr;const c=canvas.getContext('2d');c.setTransform(dpr,0,0,dpr,0,0);c.clearRect(0,0,w,h);c.fillStyle='#65717d';c.textAlign='center';c.font='14px system-ui';c.fillText(text,w/2,h/2)}

window.addEventListener('resize',()=>{if(simulation)requestAnimationFrame(renderCharts)});

$('#csvBtn').addEventListener('click',()=>{
  if(!simulation)return;const re=simulation.recharge;
  const rows=[['N','Km début Flow','Km fin Flow','Distance Flow km','D+ prévu m','Pente + modèle %','Mode','Conso Wh','Conso cumul Wh','Restant sans recharge Wh','Restant avec recharge Wh']];
  simulation.segments.forEach((x,i)=>rows.push([x.index,x.startKm.toFixed(3),x.endKm.toFixed(3),x.distanceKm.toFixed(3),x.elevationGainM.toFixed(1),x.modelGradePct.toFixed(3),x.mode,x.consumptionExactWh.toFixed(2),x.cumulativeExactWh.toFixed(2),x.remainingExactWh.toFixed(2),re.enabled?re.batteryAfterSegment(i).toFixed(2):'']));
  const csv='\ufeff'+rows.map(r=>r.map(v=>`"${String(v).replaceAll('"','""')}"`).join(';')).join('\r\n');
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=(gpxName||'parcours').replace(/\.gpx$/i,'')+'-Bosch-V2.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});

fillSettings();
if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
