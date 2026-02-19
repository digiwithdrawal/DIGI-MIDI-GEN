/* DIGI MIDI-GEN
   - TRACK view (default): hybrid (pitched notes + drum clips), only tracks with notes
   - RING view: spectrum ring using WebAudio analyser
   - HIDE: hides HUD overlays only; canvas + tracklist + download + play/pause always visible
   - Tap canvas while hidden = show HUD
*/

(() => {
  "use strict";

  // ---------- DOM ----------
  const $ = (sel) => document.querySelector(sel);

  const seedValueEl = $("#seedValue");
  const copySeedBtn = $("#copySeed");
  const modeLabelEl = $("#modeLabel");

  const hudEl = $("#hud");
  const artistTogglesEl = $("#artistToggles");
  const generateBtn = $("#generateBtn");
  const playBtn = $("#playBtn");
  const stopBtn = $("#stopBtn");
  const settingsBtn = $("#settingsBtn");
  const hideBtn = $("#hideBtn");
  const settingsPanel = $("#settingsPanel");

  const downloadBtn = $("#downloadBtn");
  const playBtnFooter = $("#playBtnFooter");
  const stopBtnFooter = $("#stopBtnFooter");

  const trackListEl = $("#trackList");
  const bpmNowEl = $("#bpmNow");
  const keyNowEl = $("#keyNow");
  const artistsNowEl = $("#artistsNow");

  const bpmMinus = $("#bpmMinus");
  const bpmPlus = $("#bpmPlus");
  const bpmDisplay = $("#bpmDisplay");
  const bpmFixedInput = $("#bpmFixed");
  const bpmMinInput = $("#bpmMin");
  const bpmMaxInput = $("#bpmMax");

  const keyButtonsEl = $("#keyButtons");

  const vizCanvas = $("#viz");
  const vizCtx = vizCanvas.getContext("2d", { alpha: true });

  // ---------- SETTINGS MODEL ----------
  const state = {
    seed: 0,
    selectedArtists: [],
    songSketch: false,
    bpmMode: "artist",
    bpm: 170,
    bpmFixed: 170,
    bpmRange: [155, 180],
    bpmManual: 170,

    keyMode: "auto",
    root: 0,
    scaleMode: "auto",
    scale: "natural",

    clipMode: "auto",
    sidechainMode: "auto",
    crushMode: "auto",

    // NEW
    viewMode: "track", // track | ring

    resolved: null,
    midiBytes: null,
    hiddenHUD: false,
  };

  const ARTISTS = [
    "2HOLLIS",
    "FAKEMINK",
    "ESDEEKID",
    "FENG",
    "BLADEE",
    "FIMIGUERRERO",
    "KEN CARSON",
  ];

  // These are your “dial” profiles (used for generation + audio auto rules)
  const PROFILES = {
    "2HOLLIS": { bpm:[150,175], density:0.35, aggro:0.30, space:0.65, repetition:0.78, harmony:{drone:0.50,power:0.32,two:0.16,three:0.02}, hatsRoll:0.12, fills:0.18, slides:0.18, halftime:0.20, bells:0.25, texture:0.55 },
    "FAKEMINK": { bpm:[155,180], density:0.55, aggro:0.45, space:0.45, repetition:0.65, harmony:{drone:0.32,power:0.28,two:0.34,three:0.06}, hatsRoll:0.22, fills:0.28, slides:0.28, halftime:0.22, bells:0.65, texture:0.45 },
    "ESDEEKID": { bpm:[165,190], density:0.78, aggro:0.82, space:0.22, repetition:0.55, harmony:{drone:0.18,power:0.32,two:0.44,three:0.06}, hatsRoll:0.52, fills:0.45, slides:0.55, halftime:0.18, bells:0.35, texture:0.35 },
    "FENG": { bpm:[145,170], density:0.48, aggro:0.58, space:0.55, repetition:0.70, harmony:{drone:0.44,power:0.32,two:0.22,three:0.02}, hatsRoll:0.22, fills:0.26, slides:0.30, halftime:0.50, bells:0.20, texture:0.62 },
    "BLADEE": { bpm:[140,170], density:0.50, aggro:0.40, space:0.60, repetition:0.68, harmony:{drone:0.26,power:0.24,two:0.42,three:0.08}, hatsRoll:0.20, fills:0.22, slides:0.20, halftime:0.20, bells:0.70, texture:0.48 },
    "FIMIGUERRERO": { bpm:[160,190], density:0.76, aggro:0.74, space:0.28, repetition:0.56, harmony:{drone:0.20,power:0.30,two:0.44,three:0.06}, hatsRoll:0.46, fills:0.46, slides:0.44, halftime:0.25, bells:0.30, texture:0.42 },
    "KEN CARSON": { bpm:[150,180], density:0.72, aggro:0.70, space:0.28, repetition:0.58, harmony:{drone:0.14,power:0.46,two:0.36,three:0.04}, hatsRoll:0.40, fills:0.40, slides:0.42, halftime:0.16, bells:0.22, texture:0.30 },
  };

  // ---------- UTIL ----------
  function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }
  function lerp(a, b, t){ return a + (b - a) * t; }

  function mulberry32(seed){
    let t = seed >>> 0;
    return function(){
      t += 0x6D2B79F5;
      let x = t;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }
  function randomSeed(){
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] >>> 0;
  }
  function pickWeighted(rng, items){
    const total = items.reduce((s,it)=>s+it.w,0);
    let r = rng()*total;
    for(const it of items){
      r -= it.w;
      if(r <= 0) return it.k;
    }
    return items[items.length-1].k;
  }
  function chance(rng, p){ return rng() < p; }

  function noteName(root){
    const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
    return names[(root%12+12)%12];
  }

  // ---------- UI BUILD ----------
  function buildArtistChips(){
    artistTogglesEl.innerHTML = "";
    for(const name of ARTISTS){
      const btn = document.createElement("button");
      btn.className = "chip";
      btn.textContent = name;
      btn.setAttribute("data-artist", name);
      btn.addEventListener("click", () => toggleArtist(name));
      artistTogglesEl.appendChild(btn);
    }
    syncArtistUI();
  }

  function toggleArtist(name){
    const idx = state.selectedArtists.indexOf(name);
    if(idx >= 0) state.selectedArtists.splice(idx,1);
    else state.selectedArtists.push(name);

    if(state.selectedArtists.length === 0) state.selectedArtists = ["FAKEMINK"];
    syncArtistUI();
    updateModeLabel();

    if(state.bpmMode === "artist"){
      const [mn,mx] = getArtistBpmRange();
      bpmMinInput.value = mn;
      bpmMaxInput.value = mx;
    }
  }

  function syncArtistUI(){
    [...artistTogglesEl.querySelectorAll(".chip")].forEach(ch => {
      const a = ch.getAttribute("data-artist");
      ch.classList.toggle("on", state.selectedArtists.includes(a));
    });
    artistsNowEl.textContent = `ARTISTS: ${state.selectedArtists.join(" + ")}`;
  }

  function updateModeLabel(){
    modeLabelEl.textContent = (state.selectedArtists.length === 1) ? "MODE: SOLO" : "MODE: MIX";
  }

  function buildKeyButtons(){
    const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
    keyButtonsEl.innerHTML = "";
    names.forEach((nm, i) => {
      const b = document.createElement("button");
      b.className = "keyBtn";
      b.textContent = nm;
      b.addEventListener("click", () => {
        state.root = i;
        syncKeyButtons();
      });
      keyButtonsEl.appendChild(b);
    });
    syncKeyButtons();
  }
  function syncKeyButtons(){
    [...keyButtonsEl.querySelectorAll(".keyBtn")].forEach((b, i) => {
      b.classList.toggle("on", i === state.root);
    });
  }

  function syncSegUI(){
    [...document.querySelectorAll(".segBtn")].forEach(btn => {
      const s = btn.dataset.setting;
      const v = btn.dataset.value;
      btn.classList.toggle("on", String(state[s]) === v);
    });

    bpmFixedInput.value = String(state.bpmFixed);
    bpmMinInput.value = String(state.bpmRange[0]);
    bpmMaxInput.value = String(state.bpmRange[1]);
    bpmDisplay.textContent = String(state.bpmMode === "manual" ? state.bpmManual : state.bpm);
  }

  function toggleSettings(){
    settingsPanel.classList.toggle("hidden");
  }

  function setHiddenHUD(hidden){
    state.hiddenHUD = hidden;
    hudEl.classList.toggle("hidden", hidden);
    hideBtn.textContent = hidden ? "SHOW" : "HIDE";
  }

  // Tap canvas while hidden => show HUD (per your request: keep only canvas+play/pause+download visible)
  vizCanvas.addEventListener("click", () => {
    if(state.hiddenHUD) setHiddenHUD(false);
  });

  // ---------- ARTIST BLEND ----------
  function blendProfiles(selected){
    const main = selected[0];
    const base = structuredClone(PROFILES[main]);
    if(selected.length === 1) return { main, profile: base, mode: "SOLO" };

    const weights = selected.map((_, i) => (i === 0 ? 0.52 : 0.48 / (selected.length - 1)));
    const out = structuredClone(base);

    function blendNum(key){
      let v = 0;
      selected.forEach((name, i) => v += PROFILES[name][key] * weights[i]);
      out[key] = v;
    }
    ["density","aggro","space","repetition","hatsRoll","fills","slides","halftime","bells","texture"].forEach(blendNum);

    const bpmMin = selected.reduce((s,name,i)=>s+PROFILES[name].bpm[0]*weights[i],0);
    const bpmMax = selected.reduce((s,name,i)=>s+PROFILES[name].bpm[1]*weights[i],0);
    out.bpm = [Math.round(bpmMin), Math.round(bpmMax)];

    const keys = ["drone","power","two","three"];
    const hw = {};
    keys.forEach(k=>{
      hw[k]= selected.reduce((s,name,i)=>s+PROFILES[name].harmony[k]*weights[i],0);
    });
    const sum = keys.reduce((s,k)=>s+hw[k],0) || 1;
    keys.forEach(k=> hw[k] /= sum);
    out.harmony = hw;

    return { main, profile: out, mode: "MIX" };
  }

  function getArtistBpmRange(){
    const main = state.selectedArtists[0];
    return PROFILES[main]?.bpm ?? [155,180];
  }

  // ---------- MUSIC THEORY ----------
  function scaleIntervals(mode){
    if(mode === "harmonic") return [0,2,3,5,7,8,11];
    if(mode === "phrygian") return [0,1,3,5,7,8,10];
    return [0,2,3,5,7,8,10];
  }

  function degreeToMidi(rootMidi, intervals, deg, octaveShift=0){
    const semis = intervals[(deg-1) % 7];
    return rootMidi + semis + octaveShift*12;
  }

  // ---------- PATTERN GENERATION ----------
  const PPQ = 480;
  const BEAT = PPQ;
  const SIXTEENTH = PPQ / 4;
  const BAR = PPQ * 4;
  const LOOP_BARS = 8;
  const LOOP_TICKS = LOOP_BARS * BAR;

  const TRACKS = [
    { id:"PAD",   name:"PAD/CHORD", ch:0, prog: 89 },
    { id:"LEAD",  name:"LEAD",      ch:1, prog: 81 },
    { id:"BELL",  name:"BELL/COUNTER", ch:2, prog: 10 },
    { id:"BASS",  name:"808/BASS",  ch:3, prog: 38 },
    { id:"KICK",  name:"KICK",      ch:9, drum:true },
    { id:"SNARE", name:"SNARE/CLAP",ch:9, drum:true },
    { id:"HATS",  name:"HATS",      ch:9, drum:true },
    { id:"TEXT",  name:"TEXTURE",   ch:4, prog: 92 },
  ];

  const DR = { kick:36, snare:38, clap:39, hatC:42, hatO:46, perc:75 };

  function resolveScale(rng){
    if(state.scaleMode !== "auto") return state.scaleMode;
    return pickWeighted(rng, [
      {k:"natural", w:0.70},
      {k:"harmonic", w:0.20},
      {k:"phrygian", w:0.10},
    ]);
  }

  function resolveRoot(rng){
    if(state.keyMode === "pick") return state.root;
    const keys = [0,1,2,3,4,5,6,7,8,9,10,11];
    const weights = keys.map(k => (k===9?2.0:(k===4?1.6:(k===5?1.4:1.0))));
    const total = weights.reduce((a,b)=>a+b,0);
    let r = rng()*total;
    for(let i=0;i<keys.length;i++){ r -= weights[i]; if(r<=0) return keys[i]; }
    return 0;
  }

  function resolveBpm(rng, blend){
    if(state.bpmMode === "fixed"){
      return clamp(parseInt(bpmFixedInput.value||"170",10), 60, 220);
    }
    if(state.bpmMode === "manual"){
      return clamp(state.bpmManual|0, 60, 220);
    }
    if(state.bpmMode === "range"){
      const mn = clamp(parseInt(bpmMinInput.value||"155",10), 60, 220);
      const mx = clamp(parseInt(bpmMaxInput.value||"180",10), 60, 220);
      const a = Math.min(mn,mx), b = Math.max(mn,mx);
      return Math.round(lerp(a, b, rng()));
    }
    const [mn,mx] = blend.profile.bpm;
    return Math.round(lerp(mn, mx, rng()));
  }

  function randVel(rng, a, b){ return clamp(Math.round(lerp(a,b,rng())), 1, 127); }

  function addNote(arr, t, d, n, v){
    arr.push({t: Math.max(0, Math.floor(t)), d: Math.max(1, Math.floor(d)), n: n|0, v: v|0, type:"note"});
  }
  function addChord(arr, t, d, notes, v){ for(const n of notes) addNote(arr, t, d, n, v); }
  function addDrum(arr, t, d, n, v){
    arr.push({t: Math.max(0, Math.floor(t)), d: Math.max(1, Math.floor(d)), n: n|0, v: v|0, type:"drum"});
  }

  function enforceClashControl(lead, bass, rng){
    const bassSet = new Set(bass.map(e => Math.floor(e.t / SIXTEENTH)));
    let downbeatCount = 0;
    for(const e of lead){
      const s = Math.floor(e.t / SIXTEENTH);
      if(bassSet.has(s) && (e.t % BEAT === 0)) downbeatCount++;
    }
    if(downbeatCount >= 6){
      for(let i=lead.length-1; i>=0; i--){
        const e = lead[i];
        if((e.t % BEAT === 0) && chance(rng,0.35)) lead.splice(i,1);
      }
    }
  }

  function buildArrangement(songSketch, loopTicks){
    if(!songSketch) return [{ name:"LOOP", start:0, len:loopTicks, mutes:{} }];
    const intro = loopTicks/2;
    const full = loopTicks;
    const breakLen = loopTicks/2;
    return [
      { name:"INTRO",  start:0,           len:intro,    mutes:{KICK:true, BASS:true} },
      { name:"DROP",   start:intro,       len:full,     mutes:{} },
      { name:"BREAK",  start:intro+full,  len:breakLen, mutes:{KICK:true, BASS:true, HATS:true} },
      { name:"RETURN", start:intro+full+breakLen, len:full, mutes:{} },
    ];
  }

  function applyArrangement(tracks, arrangement, rng, prof){
    const out = {};
    const loopLen = LOOP_TICKS;

    for(const [k, evs] of Object.entries(tracks)){
      out[k] = [];
      for(const sec of arrangement){
        const sectionEvents = [];
        const copies = Math.ceil(sec.len / loopLen);

        for(let c=0; c<copies; c++){
          const offset = sec.start + c*loopLen;
          const maxT = sec.start + sec.len;
          for(const e of evs){
            const t = e.t + offset;
            if(t >= sec.start && t < maxT) sectionEvents.push({...e, t});
          }
        }

        const muted = sec.mutes[k] === true;
        if(!muted){
          const pullChance = clamp(0.20 + prof.space*0.20, 0.20, 0.40);
          if(chance(rng, pullChance)){
            const windowStart = sec.start + Math.floor((rng()*sec.len)/(BAR)) * BAR;
            const w0 = windowStart + (chance(rng,0.5) ? 0 : BAR/2);
            const w1 = w0 + BAR/2;
            out[k].push(...sectionEvents.filter(e => !(e.t >= w0 && e.t < w1 && chance(rng,0.65))));
          } else {
            out[k].push(...sectionEvents);
          }
        }
      }
      out[k].sort((a,b)=>a.t-b.t);
    }
    return out;
  }

  function buildSong(seed){
    const rng = mulberry32(seed);
    const blend = blendProfiles(state.selectedArtists);
    const prof = blend.profile;

    const scale = resolveScale(rng);
    const root = resolveRoot(rng);
    const bpm = resolveBpm(rng, blend);

    state.scale = scale;
    state.root = root;
    state.bpm = bpm;
    bpmDisplay.textContent = String(state.bpmMode === "manual" ? state.bpmManual : bpm);

    const intervals = scaleIntervals(scale);
    const rootMidi = 60 + root;
    const rootBass = 36 + root;

    const isHalftime = chance(rng, prof.halftime);

    const harmonyType = pickWeighted(rng, [
      {k:"drone", w:prof.harmony.drone},
      {k:"power", w:prof.harmony.power},
      {k:"two",   w:prof.harmony.two},
      {k:"three", w:prof.harmony.three},
    ]);

    let prog = [];
    if(harmonyType === "drone"){
      prog = Array(LOOP_BARS).fill({deg:1, kind:"drone"});
    } else if(harmonyType === "power"){
      prog = Array.from({length:LOOP_BARS}, (_,i)=> {
        const deg = (i === LOOP_BARS-1 && chance(rng,0.22)) ? 7 : 1;
        return {deg, kind:"power"};
      });
    } else if(harmonyType === "two"){
      const second = chance(rng,0.55) ? 6 : 7;
      prog = Array.from({length:LOOP_BARS}, (_,i)=> (i < LOOP_BARS/2 ? {deg:1, kind:"tri"} : {deg:second, kind:"tri"}));
    } else {
      const map = [1,1,6,6,7,7,1,1];
      prog = map.map(d=>({deg:d, kind:"tri"}));
    }

    // PAD
    const padEvents = [];
    for(let bar=0; bar<LOOP_BARS; bar++){
      const t0 = bar * BAR;
      const d = prog[bar].deg;

      const omitThird = chance(rng, 0.70);
      const useTriad = !omitThird && chance(rng, 0.80);

      let n1 = degreeToMidi(rootMidi, intervals, d, -1);
      let n5 = degreeToMidi(rootMidi, intervals, d, -1) + 7;
      let n3 = degreeToMidi(rootMidi, intervals, ((d+2-1)%7)+1, -1);

      if(d !== 1 && chance(rng,0.55)) n3 += 1;

      const notes = [n1, n5];
      if(useTriad) notes.push(n3);

      const len = chance(rng,0.65) ? BAR : BAR/2;
      addChord(padEvents, t0, len, notes, randVel(rng, 48, 72));
      if(chance(rng, 0.30) && len === BAR){
        addChord(padEvents, t0 + BAR/2, BAR/2, notes, randVel(rng, 30, 52));
      }
    }

    // LEAD motif
    const leadEvents = [];
    const motifBars = pickWeighted(rng, [{k:1,w:0.55},{k:2,w:0.35},{k:4,w:0.10}]);
    const motifTicks = motifBars * BAR;

    const pool = [1,3,5,7,2,4,6];
    const weights = [2.2, 1.8, 2.0, 1.6, 0.9, 0.9, 0.6];
    const motif = [];
    const noteCount = Math.round(lerp(3, 6, prof.density));
    let prevDeg = 1;

    for(let i=0;i<noteCount;i++){
      const deg = pickWeighted(rng, pool.map((d,ix)=>({k:d,w:weights[ix]})));
      const useStep = chance(rng, 0.60);
      let chosen = deg;
      if(useStep){
        const dir = chance(rng,0.5) ? -1 : 1;
        chosen = clamp(((prevDeg + dir -1)%7)+1,1,7);
      }
      prevDeg = chosen;

      const grid = chance(rng, 0.30 + prof.aggro*0.20) ? SIXTEENTH : (SIXTEENTH*2);
      let step = Math.floor((rng() * motifTicks) / grid) * grid;

      if(chance(rng, 0.22 + prof.space*0.25)) continue;

      const octaveShift = chance(rng, 0.55) ? 1 : 0;
      const note = degreeToMidi(rootMidi, intervals, chosen, octaveShift);
      const len = chance(rng,0.70) ? grid : grid*2;
      motif.push({t: step, n: note, d: len});
    }

    motif.sort((a,b)=>a.t-b.t);

    const loops = Math.floor(LOOP_TICKS / motifTicks);
    for(let li=0; li<loops; li++){
      const baseT = li * motifTicks;
      const mutateP = (li < 2) ? 0 : (1 - prof.repetition) * 0.9;

      for(const ev of motif){
        let n = ev.n;
        let t = baseT + ev.t;
        let d = ev.d;

        if(chance(rng, mutateP)){
          const m = rng();
          if(m < 0.30) n += chance(rng,0.5) ? 2 : -2;
          else if(m < 0.50) n += chance(rng,0.5) ? 1 : -1;
          else if(m < 0.65) continue;
          else if(m < 0.75){
            const g = n + (chance(rng,0.5)?1:-1);
            addNote(leadEvents, t - SIXTEENTH/2, SIXTEENTH/2, g, randVel(rng, 55, 85));
          }
        }
        addNote(leadEvents, t, d, n, randVel(rng, 70, 112));
      }
    }

    // BELL
    const bellEvents = [];
    const bellOn = chance(rng, 0.35 + prof.bells*0.55);
    if(bellOn){
      const bellCount = Math.max(2, Math.round(lerp(2,4, prof.density)));
      const bellNotes = [];
      for(let i=0;i<bellCount;i++){
        const deg = pickWeighted(rng, [
          {k:1,w:2.0},{k:3,w:1.3},{k:5,w:1.8},{k:7,w:1.2},{k:2,w:0.7},{k:4,w:0.7}
        ]);
        const note = degreeToMidi(rootMidi, intervals, deg, 2);
        const step = Math.floor((rng() * LOOP_TICKS) / (SIXTEENTH*2)) * (SIXTEENTH*2);
        const off = step + SIXTEENTH;
        bellNotes.push({t: clamp(off,0,LOOP_TICKS-SIXTEENTH), n: note, d: SIXTEENTH});
      }
      bellNotes.sort((a,b)=>a.t-b.t);
      for(const e of bellNotes){
        if(chance(rng, 0.30 + prof.space*0.25)) continue;
        addNote(bellEvents, e.t, e.d, e.n, randVel(rng, 55, 92));
      }
    }

    // BASS / 808
    const bassEvents = [];
    const slideP = clamp(prof.slides, 0.10, 0.65);
    const barRoots = prog.map(p => degreeToMidi(rootBass, intervals, p.deg, 0));

    for(let bar=0; bar<LOOP_BARS; bar++){
      const baseT = bar * BAR;
      const rootN = barRoots[bar];
      const hits = Math.round(lerp(1, 3, prof.density));
      for(let i=0;i<hits;i++){
        if(chance(rng, 0.20 + prof.space*0.30)) continue;
        const grid = SIXTEENTH*2;
        let step = Math.floor((rng()*BAR)/grid)*grid;
        if(isHalftime && Math.abs(step - BEAT*2) < SIXTEENTH) step += grid;
        const len = chance(rng,0.55) ? grid*2 : grid*3;

        if(chance(rng, slideP) && i === hits-1){
          const delta = chance(rng,0.5) ? 5 : 7;
          const from = rootN + (chance(rng,0.5) ? -delta : delta);
          addNote(bassEvents, baseT + step, grid, from, randVel(rng, 70, 110));
          addNote(bassEvents, baseT + step + grid, len, rootN, randVel(rng, 85, 120));
        } else {
          addNote(bassEvents, baseT + step, len, rootN, randVel(rng, 78, 120));
        }
      }
    }

    // DRUMS
    const kickEvents = [];
    const snareEvents = [];
    const hatEvents = [];

    const snareBeat = isHalftime ? 3 : 2;
    for(let bar=0; bar<LOOP_BARS; bar++){
      const baseT = bar*BAR;
      const tSn = baseT + (snareBeat-1)*BEAT;
      addDrum(snareEvents, tSn, SIXTEENTH, DR.snare, randVel(rng, 92, 122));
      if(chance(rng,0.70)) addDrum(snareEvents, tSn, SIXTEENTH, DR.clap, randVel(rng, 72, 102));
    }

    const kickTemplate = pickWeighted(rng, [{k:"A",w:0.42},{k:"B",w:0.38},{k:"C",w:0.20}]);
    for(let bar=0; bar<LOOP_BARS; bar++){
      const baseT = bar*BAR;
      const hitsTarget = Math.round(lerp(2, 6, prof.density));
      const positions = new Set();

      const addPos = (tick) => {
        const q = clamp(Math.floor(tick / SIXTEENTH) * SIXTEENTH, 0, BAR-SIXTEENTH);
        positions.add(q);
      };

      if(kickTemplate === "A"){
        addPos(0);
        if(chance(rng,0.55)) addPos(BEAT + SIXTEENTH*2);
        addPos(BEAT*2);
        if(chance(rng,0.35)) addPos(BEAT*3 + SIXTEENTH);
      } else if(kickTemplate === "B"){
        addPos(0);
        addPos(BEAT + SIXTEENTH);
        if(chance(rng,0.45)) addPos(BEAT*2 + SIXTEENTH*2);
        if(chance(rng,0.55)) addPos(BEAT*3 - SIXTEENTH);
      } else {
        addPos(0);
        addPos(SIXTEENTH*6);
        addPos(BEAT*2);
        addPos(BEAT*2 + SIXTEENTH*2);
        if(chance(rng,0.50)) addPos(BEAT*3 + SIXTEENTH*2);
      }

      while(positions.size < hitsTarget){
        if(chance(rng, 0.25 + prof.space*0.25)) break;
        addPos(rng()*BAR);
      }

      const snT = (snareBeat-1)*BEAT;
      if(chance(rng,0.80)) positions.delete(snT);

      [...positions].sort((a,b)=>a-b).forEach(p=>{
        addDrum(kickEvents, baseT+p, SIXTEENTH, DR.kick, randVel(rng, 98, 124));
      });
    }

    const baseGrid = chance(rng, 0.70) ? (SIXTEENTH*2) : SIXTEENTH;
    for(let t=0; t<LOOP_TICKS; t+=baseGrid){
      if(chance(rng, 0.10 + prof.space*0.25)) continue;
      addDrum(hatEvents, t, baseGrid/2, DR.hatC, randVel(rng, 60, 96));
    }

    for(let bar=0; bar<LOOP_BARS; bar++){
      const baseT = bar*BAR;
      const rollChance = clamp(0.15 + prof.aggro*0.35, 0.15, 0.60);
      if(chance(rng, rollChance)){
        const start = baseT + Math.floor(rng() * (BAR - BEAT));
        const len = chance(rng,0.60) ? (SIXTEENTH*4) : (SIXTEENTH*8);
        const rate = pickWeighted(rng, [
          {k:SIXTEENTH, w:0.55},
          {k:(SIXTEENTH*2)/3, w:0.25},
          {k:SIXTEENTH/2, w:0.20},
        ]);
        for(let tt=start; tt<start+len; tt+=rate){
          addDrum(hatEvents, tt, rate/2, DR.hatC, randVel(rng, 55, 92));
        }
      }
      if(chance(rng,0.15)){
        addDrum(hatEvents, baseT + BAR - SIXTEENTH*2, SIXTEENTH, DR.hatO, randVel(rng, 60, 95));
      }
    }

    for(let bar=0; bar<LOOP_BARS; bar++){
      if(chance(rng, prof.fills)){
        const baseT = bar*BAR;
        if(chance(rng,0.55)){
          addDrum(snareEvents, baseT + BAR - SIXTEENTH, SIXTEENTH/2, DR.snare, randVel(rng, 80, 115));
          addDrum(snareEvents, baseT + BAR - SIXTEENTH/2, SIXTEENTH/2, DR.snare, randVel(rng, 92, 124));
        } else {
          for(let k=0;k<6;k++){
            addDrum(hatEvents, baseT + BAR - SIXTEENTH*2 + k*(SIXTEENTH/3), SIXTEENTH/6, DR.hatC, randVel(rng, 60, 98));
          }
        }
      }
    }

    // TEXTURE
    const textEvents = [];
    if(chance(rng, 0.30 + prof.texture*0.60)){
      const hits = Math.round(lerp(4, 10, prof.texture));
      for(let i=0;i<hits;i++){
        if(chance(rng, 0.25 + prof.space*0.25)) continue;
        const t = Math.floor((rng()*LOOP_TICKS)/(BEAT)) * BEAT;
        const deg = pickWeighted(rng, [{k:1,w:2.0},{k:5,w:1.5},{k:7,w:1.0},{k:3,w:1.0}]);
        const n = degreeToMidi(rootMidi, intervals, deg, chance(rng,0.5)?-1:0);
        addNote(textEvents, t, BEAT, n, randVel(rng, 20, 55));
      }
    }

    enforceClashControl(leadEvents, bassEvents, rng);

    const arrangement = buildArrangement(state.songSketch, LOOP_TICKS);
    const arranged = applyArrangement({
      PAD: padEvents,
      LEAD: leadEvents,
      BELL: bellEvents,
      BASS: bassEvents,
      KICK: kickEvents,
      SNARE: snareEvents,
      HATS: hatEvents,
      TEXT: textEvents,
    }, arrangement, rng, prof);

    return {
      seed, bpm, root, scale, isHalftime,
      mainArtist: blend.main,
      mode: blend.mode,
      artists: [...state.selectedArtists],
      profile: prof,
      arrangement,
      tracks: arranged,
    };
  }

  // ---------- MIDI WRITER ----------
  function u32be(n){ return [(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255]; }
  function u16be(n){ return [(n>>>8)&255,n&255]; }
  function strBytes(s){ const out=[]; for(let i=0;i<s.length;i++) out.push(s.charCodeAt(i)&255); return out; }
  function vlq(n){
    let v = n >>> 0;
    let bytes = [v & 0x7F];
    v >>>= 7;
    while(v){ bytes.unshift((v & 0x7F) | 0x80); v >>>= 7; }
    return bytes;
  }
  function chunk(type, data){ return [...strBytes(type), ...u32be(data.length), ...data]; }

  function buildMidi(song){
    const tracks = [];

    const tempoTrack = [];
    tempoTrack.push(...vlq(0), 0xFF, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08);
    const mpqn = Math.round(60000000 / song.bpm);
    tempoTrack.push(...vlq(0), 0xFF, 0x51, 0x03, (mpqn>>>16)&255, (mpqn>>>8)&255, mpqn&255);
    const name = `DIGI MIDI-GEN • ${song.artists.join(" + ")} • ${song.mode}`;
    tempoTrack.push(...vlq(0), 0xFF, 0x03, name.length, ...strBytes(name));
    tempoTrack.push(...vlq(0), 0xFF, 0x2F, 0x00);
    tracks.push(chunk("MTrk", tempoTrack));

    for(const tr of TRACKS){
      const evs = song.tracks[tr.id] || [];
      const trk = [];
      trk.push(...vlq(0), 0xFF, 0x03, tr.name.length, ...strBytes(tr.name));
      if(!tr.drum){
        trk.push(...vlq(0), 0xC0 | (tr.ch & 0x0F), (tr.prog ?? 0) & 0x7F);
      }

      const events = [];
      for(const e of evs){
        const ch = tr.ch & 0x0F;
        events.push({t:e.t, bytes:[0x90|ch, e.n & 0x7F, e.v & 0x7F]});
        events.push({t:e.t + e.d, bytes:[0x80|ch, e.n & 0x7F, 0]});
      }
      events.sort((a,b)=>a.t-b.t);

      let lastT = 0;
      for(const ev of events){
        const dt = Math.max(0, ev.t - lastT);
        trk.push(...vlq(dt), ...ev.bytes);
        lastT = ev.t;
      }

      trk.push(...vlq(0), 0xFF, 0x2F, 0x00);
      tracks.push(chunk("MTrk", trk));
    }

    const header = chunk("MThd", [...u16be(1), ...u16be(tracks.length), ...u16be(PPQ)]);
    return new Uint8Array([...header, ...tracks.flat()]);
  }

  // ---------- AUDIO ENGINE ----------
  let audio = {
    ctx:null,
    playing:false,
    nodes:[],
    stopAt:0,
    startTime:0,
    durationSec:0,
    analyser:null,
    raf:0
  };

  function ensureAudio(){
    if(!audio.ctx) audio.ctx = new (window.AudioContext || window.webkitAudioContext)();
    return audio.ctx;
  }

  function stopAudio(){
    if(!audio.playing) return;
    audio.playing = false;
    setPlayUI(false);

    try{
      for(const n of audio.nodes){
        try{ n.stop && n.stop(); } catch {}
        try{ n.disconnect && n.disconnect(); } catch {}
      }
    } finally {
      audio.nodes = [];
      audio.analyser = null;
    }
  }

  function makeClipper(ctx, amount=0.6){
    const ws = ctx.createWaveShaper();
    const k = clamp(amount, 0, 1);
    const n = 1024;
    const curve = new Float32Array(n);
    for(let i=0;i<n;i++){
      const x = (i/(n-1))*2 - 1;
      curve[i] = Math.tanh(x * (1 + k*6)) * (0.92 + k*0.06);
    }
    ws.curve = curve;
    ws.oversample = "4x";
    return ws;
  }

  function makeBitCrusher(ctx, bits=6, reduction=0.22){
    const sp = ctx.createScriptProcessor(1024, 1, 1);
    const step = Math.pow(0.5, clamp(bits,1,16));
    let phaser = 0;
    let last = 0;
    const rate = clamp(reduction, 0.02, 1.0);
    sp.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const output = e.outputBuffer.getChannelData(0);
      for(let i=0;i<input.length;i++){
        phaser += rate;
        if(phaser >= 1.0){
          phaser -= 1.0;
          last = step * Math.floor(input[i] / step + 0.5);
        }
        output[i] = last;
      }
    };
    return sp;
  }

  function makeTinyReverb(ctx, seconds=1.1, decay=2.2){
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const impulse = ctx.createBuffer(2, len, rate);
    for(let ch=0; ch<2; ch++){
      const data = impulse.getChannelData(ch);
      for(let i=0;i<len;i++){
        const t = i / len;
        data[i] = (Math.random()*2-1) * Math.pow(1 - t, decay);
      }
    }
    const conv = ctx.createConvolver();
    conv.buffer = impulse;
    return conv;
  }

  function resolveAudioFlags(song){
    const prof = song.profile;
    const has = (name) => song.artists.includes(name);

    const autoClip = (prof.aggro > 0.62 || prof.density > 0.68 || has("KEN CARSON") || has("FIMIGUERRERO"));
    const autoSide = (prof.density > 0.50 || prof.aggro > 0.50);
    const autoCrush = has("ESDEEKID");

    const clipOn = state.clipMode === "on" ? true : state.clipMode === "off" ? false : autoClip;
    const sideOn = state.sidechainMode === "on" ? true : state.sidechainMode === "off" ? false : autoSide;
    const crushOn = state.crushMode === "on" ? true : state.crushMode === "off" ? false : autoCrush;

    const clipAmt = clamp(lerp(0.35, 0.85, prof.aggro), 0.25, 0.90);
    const duckAmt = clamp(lerp(0.10, 0.60, (prof.aggro+prof.density)/2), 0.08, 0.70);
    const crushWet = crushOn ? clamp(lerp(0.12, 0.45, prof.aggro), 0.10, 0.55) : 0;

    return { clipOn, sideOn, crushOn, clipAmt, duckAmt, crushWet };
  }

  function oscFor(kind, main){
    if(kind === "pad"){
      if(main === "2HOLLIS" || main === "FENG") return ["triangle","sine"];
      if(main === "BLADEE" || main === "FAKEMINK") return ["sine","sine"];
      return ["triangle","triangle"];
    }
    if(kind === "lead"){
      if(main === "KEN CARSON") return ["sawtooth","sawtooth"];
      if(main === "ESDEEKID" || main === "FIMIGUERRERO") return ["square","sawtooth"];
      return ["square","square"];
    }
    if(kind === "bass") return ["sine","sawtooth"];
    if(kind === "bell") return ["sine","sine"];
    return ["square","triangle"];
  }

  function playAudio(song){
    stopAudio();
    const ctx = ensureAudio();
    if(ctx.state === "suspended") ctx.resume();

    audio.playing = true;
    setPlayUI(true);

    const start = ctx.currentTime + 0.05;
    const secondsPerBeat = 60 / song.bpm;
    const secondsPerTick = secondsPerBeat / PPQ;

    const totalTicks = song.arrangement.reduce((mx,s)=>Math.max(mx, s.start+s.len), 0);
    const durationSec = totalTicks * secondsPerTick;

    audio.startTime = start;
    audio.durationSec = durationSec;

    const flags = resolveAudioFlags(song);

    // buses
    const master = ctx.createGain(); master.gain.value = 0.92;
    const musicBus = ctx.createGain(); musicBus.gain.value = 1.0;
    const drumBus  = ctx.createGain(); drumBus.gain.value = 0.95;
    const bassBus  = ctx.createGain(); bassBus.gain.value = 0.95;

    // music FX
    const rev = makeTinyReverb(ctx, 1.1, 2.2);
    const revWet = ctx.createGain();
    const revDry = ctx.createGain();
    revWet.gain.value = 0.22 + song.profile.bells*0.10;
    revDry.gain.value = 0.92;

    const widenDelayL = ctx.createDelay(0.03);
    const widenDelayR = ctx.createDelay(0.03);
    widenDelayL.delayTime.value = 0.012;
    widenDelayR.delayTime.value = 0.017;
    const widenGain = ctx.createGain();
    widenGain.gain.value = 0.18;

    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 18;
    hp.Q.value = 0.7;

    const crushNode = makeBitCrusher(ctx, 6, 0.22);
    const crushWet = ctx.createGain();
    const crushDry = ctx.createGain();
    crushWet.gain.value = flags.crushWet;
    crushDry.gain.value = 1 - flags.crushWet;

    const clipper = makeClipper(ctx, flags.clipAmt);

    // analyser for ring mode
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.78;
    audio.analyser = analyser;

    // routing
    musicBus.connect(rev);
    musicBus.connect(revDry);
    rev.connect(revWet);

    const musicSum = ctx.createGain();
    revDry.connect(musicSum);
    revWet.connect(musicSum);

    musicSum.connect(splitter);
    splitter.connect(widenDelayL, 0);
    splitter.connect(widenDelayR, 1);
    widenDelayL.connect(merger, 0, 0);
    widenDelayR.connect(merger, 0, 1);
    merger.connect(widenGain);

    const musicToMaster = ctx.createGain();
    musicToMaster.gain.value = 1.0;
    musicSum.connect(musicToMaster);

    // sidechain duck (music only)
    const duckGain = ctx.createGain();
    duckGain.gain.value = 1.0;

    musicToMaster.connect(duckGain);
    widenGain.connect(duckGain);
    duckGain.connect(master);

    drumBus.connect(master);
    bassBus.connect(master);

    // master chain -> analyser -> destination
    const preOut = ctx.createGain();
    master.connect(preOut);

    preOut.connect(crushDry);
    preOut.connect(crushNode);
    crushNode.connect(crushWet);

    const postCrush = ctx.createGain();
    crushDry.connect(postCrush);
    crushWet.connect(postCrush);

    const post = ctx.createGain();
    if(flags.clipOn){
      postCrush.connect(clipper);
      clipper.connect(post);
    } else {
      postCrush.connect(post);
    }

    post.connect(hp);
    hp.connect(analyser);
    analyser.connect(ctx.destination);

    audio.nodes.push(
      master, musicBus, drumBus, bassBus,
      rev, revWet, revDry, musicSum,
      splitter, merger, widenDelayL, widenDelayR, widenGain, musicToMaster, duckGain,
      preOut, crushDry, crushNode, crushWet, postCrush, clipper, post, hp, analyser
    );

    // sidechain schedule from kicks
    if(flags.sideOn){
      const kickEvents = song.tracks.KICK || [];
      const duckDepth = flags.duckAmt;
      const attack = 0.008;
      const release = lerp(0.08, 0.22, song.profile.space);

      duckGain.gain.setValueAtTime(1.0, start);

      for(const e of kickEvents){
        const t = start + (e.t * secondsPerTick);
        const min = clamp(1.0 - duckDepth, 0.25, 0.95);
        duckGain.gain.cancelScheduledValues(t);
        duckGain.gain.setValueAtTime(duckGain.gain.value, t);
        duckGain.gain.linearRampToValueAtTime(min, t + attack);
        duckGain.gain.linearRampToValueAtTime(1.0, t + attack + release);
      }
    }

    // synth buses per kind
    function makeVoiceBus(kind){
      const g = ctx.createGain();
      g.gain.value = 1.0;

      const f = ctx.createBiquadFilter();
      f.type = (kind === "bass") ? "lowpass" : (kind === "pad" ? "lowpass" : "bandpass");
      f.frequency.value =
        kind === "bass" ? lerp(260, 540, song.profile.density) :
        kind === "pad" ? lerp(900, 1600, 1 - song.profile.space) :
        lerp(1200, 2600, song.profile.aggro);
      f.Q.value = kind === "lead" ? 1.2 : 0.8;

      const sat = makeClipper(ctx, clamp(lerp(0.15, 0.65, song.profile.aggro), 0.10, 0.75));

      g.connect(f);
      f.connect(sat);

      if(kind === "bass") sat.connect(bassBus);
      else if(kind === "drum") sat.connect(drumBus);
      else sat.connect(musicBus);

      audio.nodes.push(g,f,sat);
      return g;
    }

    const busPad  = makeVoiceBus("pad");
    const busLead = makeVoiceBus("lead");
    const busBell = makeVoiceBus("bell");
    const busBass = makeVoiceBus("bass");
    const busText = makeVoiceBus("text");

    function synthNote(t, dur, midi, vel, kind){
      const freq = 440 * Math.pow(2, (midi - 69) / 12);
      const ampBase =
        kind === "pad" ? 0.16 :
        kind === "bell" ? 0.18 :
        kind === "bass" ? 0.22 :
        0.14;
      const amp = (vel/127) * ampBase;

      const out = (kind === "pad") ? busPad :
                  (kind === "bell") ? busBell :
                  (kind === "bass") ? busBass :
                  (kind === "text") ? busText :
                  busLead;

      const g = ctx.createGain();
      g.gain.value = 0.0001;
      g.connect(out);

      const attack = (kind === "pad") ? 0.02 : 0.006;
      const release = (kind === "pad") ? 0.18 : 0.08;

      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, amp), t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(attack+0.01, dur - release));
      g.gain.setValueAtTime(0.0001, t + dur);

      const [t1,t2] = oscFor(kind, song.mainArtist);
      const o1 = ctx.createOscillator();
      const o2 = ctx.createOscillator();
      o1.type = t1;
      o2.type = t2;

      const det = (song.mainArtist === "KEN CARSON") ? 9 : (song.mainArtist === "FAKEMINK" || song.mainArtist === "BLADEE") ? 6 : 4;
      o1.frequency.value = freq;
      o2.frequency.value = freq * (1 - det/1200);

      if(kind === "bass"){
        o1.frequency.setValueAtTime(freq * 2.1, t);
        o1.frequency.exponentialRampToValueAtTime(freq, t + 0.05);
        o2.frequency.setValueAtTime(freq * 2.1, t);
        o2.frequency.exponentialRampToValueAtTime(freq * (1 - det/1800), t + 0.05);
      }
      if(kind === "bell"){
        o2.frequency.value = freq * 2.01;
      }

      o1.connect(g);
      o2.connect(g);

      o1.start(t);
      o2.start(t);
      o1.stop(t + dur + 0.03);
      o2.stop(t + dur + 0.03);

      audio.nodes.push(o1,o2,g);
    }

    function drumHit(t, kind, vel){
      const v = (vel/127);
      const g = ctx.createGain();
      g.connect(drumBus);
      g.gain.value = 0.0001;

      const dur = (kind === "kick") ? 0.14 : (kind === "snare" || kind === "clap") ? 0.12 : 0.06;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.30*v + 0.0002, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      if(kind === "kick"){
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.setValueAtTime(140, t);
        o.frequency.exponentialRampToValueAtTime(45, t + 0.09);
        o.connect(g);
        o.start(t);
        o.stop(t + dur);
        audio.nodes.push(o,g);
      } else {
        const noise = ctx.createBufferSource();
        const len = ctx.sampleRate * dur;
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        const mul = (kind === "clap") ? 0.75 : 1.0;
        for(let i=0;i<data.length;i++){
          data[i] = (Math.random()*2-1) * mul * (0.8 + 0.2*Math.random());
        }
        noise.buffer = buf;

        const f = ctx.createBiquadFilter();
        f.type = "highpass";
        f.frequency.value =
          (kind === "snare") ? 1100 :
          (kind === "clap") ? 1700 :
          (kind === "hatO") ? 6800 : 8200;
        if(kind === "snare") f.Q.value = 0.9;

        noise.connect(f);
        f.connect(g);
        noise.start(t);
        noise.stop(t + dur);
        audio.nodes.push(noise,f,g);
      }
    }

    const seconds = (ticks) => ticks * secondsPerTick;
    const tAt = (ticks) => start + seconds(ticks);

    const mapType = { PAD:"pad", LEAD:"lead", BELL:"bell", BASS:"bass", TEXT:"text" };

    for(const tr of TRACKS){
      const evs = song.tracks[tr.id] || [];
      for(const e of evs){
        const t = tAt(e.t);
        const dur = Math.max(0.03, seconds(e.d));
        if(tr.drum){
          if(e.n === DR.kick) drumHit(t, "kick", e.v);
          else if(e.n === DR.snare) drumHit(t, "snare", e.v);
          else if(e.n === DR.clap) drumHit(t, "clap", e.v);
          else if(e.n === DR.hatC) drumHit(t, "hatC", e.v);
          else if(e.n === DR.hatO) drumHit(t, "hatO", e.v);
          else drumHit(t, "hatC", e.v);
        } else {
          synthNote(t, dur, e.n, e.v, mapType[tr.id] || "lead");
        }
      }
    }

    // auto-stop
    audio.stopAt = start + durationSec + 0.15;
    window.setTimeout(() => { if(audio.playing) stopAudio(); }, Math.max(0, (audio.stopAt - ctx.currentTime) * 1000));
  }

  // ---------- DOWNLOAD ----------
  function downloadMidi(bytes, filename){
    const blob = new Blob([bytes], {type:"audio/midi"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 1500);
  }

  function fileName(song){
    const preset = song.mode === "SOLO" ? song.mainArtist.replace(/\s+/g,"") : "MIX";
    const key = `${noteName(song.root)}_${song.scale.toUpperCase()}`;
    const bpm = `${song.bpm}BPM`;
    return `DIGI_MIDIGEN_${preset}_${bpm}_${key}_SEED${song.seed}.mid`;
  }

  // ---------- TRACKLIST ----------
  function renderTrackList(song){
    trackListEl.innerHTML = "";
    const totalTicks = song.arrangement.reduce((mx,s)=>Math.max(mx, s.start+s.len), 0);
    const bars = Math.round(totalTicks / BAR);

    const header = document.createElement("div");
    header.className = "trackItem";
    header.innerHTML = `
      <div class="trackName">SESSION</div>
      <div class="trackMeta">${bars} BARS • ${song.bpm} BPM • ${noteName(song.root)} ${song.scale.toUpperCase()} • ${song.mode}</div>
    `;
    trackListEl.appendChild(header);

    for(const tr of TRACKS){
      const evs = song.tracks[tr.id] || [];
      if(!evs.length) continue;
      const item = document.createElement("div");
      item.className = "trackItem";
      item.innerHTML = `
        <div class="trackName">${tr.name}</div>
        <div class="trackMeta">${evs.length} EVENTS</div>
      `;
      trackListEl.appendChild(item);
    }
  }

  // ---------- VISUALS ----------
  function fitCanvasToCSS(){
    // match canvas backing store to displayed size for crisp lines
    const rect = vizCanvas.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.max(320, Math.floor(rect.width * dpr));
    const h = Math.max(220, Math.floor((rect.width * 0.43) * dpr)); // consistent aspect
    if(vizCanvas.width !== w || vizCanvas.height !== h){
      vizCanvas.width = w;
      vizCanvas.height = h;
    }
  }

  function getPlayheadT(){
    if(!audio.playing || !audio.ctx) return 0;
    const now = audio.ctx.currentTime;
    const t = (now - audio.startTime);
    return clamp(t / Math.max(0.001, audio.durationSec), 0, 1);
  }

  function drawTrackView(song){
    const ctx = vizCtx;
    const w = vizCanvas.width;
    const h = vizCanvas.height;

    // background
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(0,0,w,h);

    // grid
    const padL = Math.floor(w * 0.06);
    const padR = Math.floor(w * 0.03);
    const padT = Math.floor(h * 0.10);
    const padB = Math.floor(h * 0.10);
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;

    ctx.strokeStyle = "rgba(140,255,190,0.08)";
    ctx.lineWidth = Math.max(1, Math.floor(w/900));
    ctx.beginPath();

    // vertical bars (8 bars)
    for(let b=0;b<=8;b++){
      const x = padL + (b/8)*innerW;
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT+innerH);
    }
    // 16th grid (light)
    ctx.stroke();
    ctx.strokeStyle = "rgba(140,255,190,0.04)";
    ctx.beginPath();
    for(let s=0;s<=32;s++){
      const x = padL + (s/32)*innerW;
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT+innerH);
    }
    ctx.stroke();

    // lane list (only tracks with events)
    const lanes = TRACKS
      .map(tr => ({ tr, evs: song.tracks[tr.id] || [] }))
      .filter(x => x.evs.length > 0);

    const laneGap = Math.max(6, Math.floor(h * 0.012));
    const laneH = Math.max(18, Math.floor((innerH - laneGap*(lanes.length-1)) / Math.max(1, lanes.length)));

    // label style
    ctx.font = `${Math.max(10, Math.floor(h*0.04))}px ui-monospace, Menlo, Monaco, Consolas, "Courier New", monospace`;
    ctx.textBaseline = "middle";

    // helper mapping
    const totalTicks = song.arrangement.reduce((mx,s)=>Math.max(mx, s.start+s.len), 0);
    const xOf = (tick) => padL + (tick / totalTicks) * innerW;

    // color system (all green, varying alpha)
    const laneStroke = "rgba(140,255,190,0.14)";
    const noteFill   = "rgba(140,255,190,0.22)";
    const noteFill2  = "rgba(140,255,190,0.14)";
    const drumFill   = "rgba(140,255,190,0.18)";

    for(let i=0;i<lanes.length;i++){
      const y = padT + i*(laneH + laneGap);

      // lane outline
      ctx.strokeStyle = laneStroke;
      ctx.lineWidth = 1;
      ctx.strokeRect(padL, y, innerW, laneH);

      // lane label (left)
      ctx.fillStyle = "rgba(210,255,230,0.72)";
      const label = lanes[i].tr.id;
      ctx.fillText(label, Math.max(10, padL - Math.floor(w*0.055)), y + laneH/2);

      const tr = lanes[i].tr;
      const evs = lanes[i].evs;

      if(tr.drum){
        // HYBRID: drums = “clips” per 1/8 bar bucket (coarse readable)
        // bucket = 240 ticks (8th note)
        const bucket = PPQ/2; // 8th
        const buckets = new Map();
        for(const e of evs){
          const b = Math.floor(e.t / bucket);
          buckets.set(b, (buckets.get(b) || 0) + 1);
        }
        for(const [b,count] of buckets.entries()){
          const t0 = b * bucket;
          const t1 = t0 + bucket;
          const x0 = xOf(t0);
          const x1 = xOf(t1);
          const intensity = clamp(count / 3, 0.25, 1.0);
          ctx.fillStyle = `rgba(140,255,190,${0.08 + intensity*0.18})`;
          ctx.fillRect(x0+1, y+2, Math.max(1, (x1-x0)-2), laneH-4);
        }
      } else {
        // HYBRID: pitched = note rectangles (mini piano roll per lane)
        // normalize pitch into the lane height
        let minN = 999, maxN = -999;
        for(const e of evs){ minN = Math.min(minN, e.n); maxN = Math.max(maxN, e.n); }
        if(minN === maxN){ minN -= 6; maxN += 6; }
        const pitchSpan = Math.max(1, maxN - minN);

        for(const e of evs){
          const x0 = xOf(e.t);
          const x1 = xOf(e.t + e.d);
          const py = (e.n - minN) / pitchSpan; // 0..1
          const nh = Math.max(3, Math.floor(laneH * 0.16));
          const yy = y + (laneH - nh) - py * (laneH - nh);

          const vel = e.v / 127;
          ctx.fillStyle = vel > 0.72 ? noteFill : noteFill2;
          ctx.fillRect(x0+1, yy, Math.max(1, (x1-x0)-2), nh);
        }
      }
    }

    // playhead
    const ph = getPlayheadT();
    const phX = padL + ph * innerW;
    ctx.strokeStyle = "rgba(190,255,220,0.55)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(phX, padT);
    ctx.lineTo(phX, padT+innerH);
    ctx.stroke();

    // header tag (mode)
    ctx.font = `${Math.max(10, Math.floor(h*0.035))}px ui-monospace, Menlo, Monaco, Consolas, "Courier New", monospace`;
    ctx.fillStyle = "rgba(210,255,230,0.65)";
    const tag = `${song.mode} • ${song.mainArtist} • ${song.bpm} BPM • ${noteName(song.root)} ${song.scale.toUpperCase()} • VIEW: TRACK`;
    ctx.fillText(tag, padL, Math.max(12, Math.floor(h*0.06)));
  }

  function drawRingView(song){
    const ctx = vizCtx;
    const w = vizCanvas.width;
    const h = vizCanvas.height;
    ctx.clearRect(0,0,w,h);

    // background
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.fillRect(0,0,w,h);

    const cx = w/2;
    const cy = h/2;
    const radius = Math.min(w,h) * 0.22;

    // faint grid circle
    ctx.strokeStyle = "rgba(140,255,190,0.12)";
    ctx.lineWidth = 1;
    for(let r=1;r<=3;r++){
      ctx.beginPath();
      ctx.arc(cx, cy, radius * (0.55 + r*0.18), 0, Math.PI*2);
      ctx.stroke();
    }

    // spectrum
    const analyser = audio.analyser;
    const bins = analyser ? analyser.frequencyBinCount : 512;
    const data = new Uint8Array(bins);
    if(analyser) analyser.getByteFrequencyData(data);

    const steps = 160; // keep it light
    const stepSize = Math.floor(bins / steps) || 1;

    for(let i=0;i<steps;i++){
      const idx = i * stepSize;
      const v = analyser ? data[idx] / 255 : 0.12;
      const ang = (i/steps) * Math.PI * 2;

      const inner = radius;
      const outer = radius + v * (Math.min(w,h) * 0.16);

      const x0 = cx + Math.cos(ang) * inner;
      const y0 = cy + Math.sin(ang) * inner;
      const x1 = cx + Math.cos(ang) * outer;
      const y1 = cy + Math.sin(ang) * outer;

      ctx.strokeStyle = `rgba(140,255,190,${0.10 + v*0.55})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x0,y0);
      ctx.lineTo(x1,y1);
      ctx.stroke();
    }

    // center orb
    ctx.fillStyle = "rgba(10,60,30,0.20)";
    ctx.beginPath();
    ctx.arc(cx, cy, radius*0.62, 0, Math.PI*2);
    ctx.fill();

    // playhead-ish spinner
    const ph = getPlayheadT();
    const ang = ph * Math.PI * 2;
    ctx.strokeStyle = "rgba(190,255,220,0.55)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, radius*0.78, ang, ang + 0.85);
    ctx.stroke();

    // label
    ctx.font = `${Math.max(10, Math.floor(h*0.04))}px ui-monospace, Menlo, Monaco, Consolas, "Courier New", monospace`;
    ctx.fillStyle = "rgba(210,255,230,0.70)";
    const tag = `${song.mode} • ${song.mainArtist} • ${song.bpm} BPM • ${noteName(song.root)} ${song.scale.toUpperCase()} • VIEW: RING`;
    ctx.fillText(tag, Math.floor(w*0.06), Math.floor(h*0.10));
  }

  function renderViz(){
    fitCanvasToCSS();
    const song = state.resolved;
    if(!song){
      vizCtx.clearRect(0,0,vizCanvas.width,vizCanvas.height);
      return;
    }

    if(state.viewMode === "ring") drawRingView(song);
    else drawTrackView(song);

    audio.raf = requestAnimationFrame(renderViz);
  }

  // ---------- PLAY UI ----------
  function setPlayUI(isPlaying){
    const label = isPlaying ? "PAUSE" : "PLAY";
    playBtn.textContent = label;
    playBtnFooter.textContent = label;
  }

  function togglePlay(){
    if(!state.resolved) generate();
    if(audio.playing){
      stopAudio();
    } else {
      playAudio(state.resolved);
    }
  }

  // ---------- MAIN FLOW ----------
  function generate(){
    state.seed = randomSeed();
    seedValueEl.textContent = String(state.seed);

    const blend = blendProfiles(state.selectedArtists);
    if(state.bpmMode === "artist"){
      bpmMinInput.value = String(blend.profile.bpm[0]);
      bpmMaxInput.value = String(blend.profile.bpm[1]);
    }

    const song = buildSong(state.seed);
    state.resolved = song;

    bpmNowEl.textContent = `BPM: ${song.bpm}`;
    keyNowEl.textContent = `KEY: ${noteName(song.root)} ${song.scale.toUpperCase()}`;
    artistsNowEl.textContent = `ARTISTS: ${song.artists.join(" + ")}`;

    updateModeLabel();

    state.midiBytes = buildMidi(song);
    renderTrackList(song);
  }

  // ---------- EVENTS ----------
  copySeedBtn.addEventListener("click", async () => {
    const txt = seedValueEl.textContent || "";
    try{
      await navigator.clipboard.writeText(txt);
      copySeedBtn.textContent = "COPIED";
      setTimeout(()=>copySeedBtn.textContent="COPY", 900);
    }catch{
      const ta = document.createElement("textarea");
      ta.value = txt;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      copySeedBtn.textContent = "COPIED";
      setTimeout(()=>copySeedBtn.textContent="COPY", 900);
    }
  });

  generateBtn.addEventListener("click", () => {
    if(audio.playing) stopAudio();
    generate();
  });

  playBtn.addEventListener("click", togglePlay);
  playBtnFooter.addEventListener("click", togglePlay);

  stopBtn.addEventListener("click", () => stopAudio());
  stopBtnFooter.addEventListener("click", () => stopAudio());

  settingsBtn.addEventListener("click", () => toggleSettings());

  hideBtn.addEventListener("click", () => setHiddenHUD(!state.hiddenHUD));

  downloadBtn.addEventListener("click", () => {
    if(!state.resolved || !state.midiBytes) generate();
    downloadMidi(state.midiBytes, fileName(state.resolved));
  });

  bpmMinus.addEventListener("click", () => {
    state.bpmManual = clamp((state.bpmManual|0) - 1, 60, 220);
    bpmDisplay.textContent = String(state.bpmManual);
  });
  bpmPlus.addEventListener("click", () => {
    state.bpmManual = clamp((state.bpmManual|0) + 1, 60, 220);
    bpmDisplay.textContent = String(state.bpmManual);
  });

  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".segBtn");
    if(!btn) return;
    const s = btn.dataset.setting;
    const v = btn.dataset.value;

    if(s === "songSketch") state.songSketch = (v === "on");
    else if(s === "bpmMode"){
      state.bpmMode = v;
      if(v === "artist"){
        const [mn,mx] = getArtistBpmRange();
        bpmMinInput.value = mn;
        bpmMaxInput.value = mx;
      }
    }
    else if(s === "keyMode") state.keyMode = v;
    else if(s === "scaleMode") state.scaleMode = v;
    else if(s === "clipMode") state.clipMode = v;
    else if(s === "sidechainMode") state.sidechainMode = v;
    else if(s === "crushMode") state.crushMode = v;
    else if(s === "viewMode") state.viewMode = v;

    syncSegUI();
  });

  bpmFixedInput.addEventListener("change", () => {
    state.bpmFixed = clamp(parseInt(bpmFixedInput.value||"170",10), 60, 220);
  });
  bpmMinInput.addEventListener("change", () => {
    const mn = clamp(parseInt(bpmMinInput.value||"155",10), 60, 220);
    const mx = clamp(parseInt(bpmMaxInput.value||"180",10), 60, 220);
    state.bpmRange = [Math.min(mn,mx), Math.max(mn,mx)];
  });
  bpmMaxInput.addEventListener("change", () => {
    const mn = clamp(parseInt(bpmMinInput.value||"155",10), 60, 220);
    const mx = clamp(parseInt(bpmMaxInput.value||"180",10), 60, 220);
    state.bpmRange = [Math.min(mn,mx), Math.max(mn,mx)];
  });

  // ---------- INIT ----------
  function init(){
    state.selectedArtists = ["FAKEMINK"];
    state.songSketch = false;
    state.bpmMode = "artist";
    state.keyMode = "auto";
    state.scaleMode = "auto";
    state.root = 9;
    state.bpmManual = 170;

    state.clipMode = "auto";
    state.sidechainMode = "auto";
    state.crushMode = "auto";

    state.viewMode = "track"; // your default

    buildArtistChips();
    buildKeyButtons();
    updateModeLabel();
    syncSegUI();

    generate();
    renderViz();

    window.addEventListener("resize", () => fitCanvasToCSS(), { passive:true });
  }

  init();
})();
