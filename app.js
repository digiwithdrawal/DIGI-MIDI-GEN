/* DIGI MIDI-GEN v2
   AI Planner (artist priors + mood) -> BeatPlan
   Constraint Generator (must obey plan) -> MIDI + WebAudio preview
   Per-artist learning: 👍 👎 + DOWNLOAD + "regen too fast" adjust weights (localStorage)
   UI rules:
   - Hide/Show ALWAYS visible (footer)
   - Hide hides HUD + tracklist, keeps visualizer + transport + download + hide/show visible
*/

(() => {
  "use strict";

  // ---------- DOM ----------
  const $ = (s) => document.querySelector(s);
  const seedValueEl = $("#seedValue");
  const copySeedBtn = $("#copySeed");
  const aiLabelEl = $("#aiLabel");

  const hudEl = $("#hud");
  const artistTogglesEl = $("#artistToggles");
  const moodRowEl = $("#moodRow");
  const generateBtn = $("#generateBtn");
  const settingsBtn = $("#settingsBtn");
  const settingsPanel = $("#settingsPanel");

  const vizHintEl = $("#vizHint");
  const vizCanvas = $("#viz");
  const vizCtx = vizCanvas.getContext("2d", { alpha: true });

  const downloadBtn = $("#downloadBtn");
  const playBtn = $("#playBtn");
  const stopBtn = $("#stopBtn");
  const hideBtn = $("#hideBtn");
  const likeBtn = $("#likeBtn");
  const dislikeBtn = $("#dislikeBtn");

  const bpmNowEl = $("#bpmNow");
  const keyNowEl = $("#keyNow");
  const artistsNowEl = $("#artistsNow");
  const moodNowEl = $("#moodNow");

  const trackPanelEl = $("#trackPanel");
  const trackListEl = $("#trackList");
  const planLabelEl = $("#planLabel");

  const bpmFixedInput = $("#bpmFixed");
  const bpmManualInput = $("#bpmManual");

  const keyButtonsEl = $("#keyButtons");

  // ---------- STATE ----------
  const state = {
    seed: 0,
    hidden: false,

    selectedArtists: [],
    mood: "DROP",

    viewMode: "track", // track|ring
    keyMode: "auto",   // auto|pick
    scaleMode: "auto", // auto|natural|harmonic|phrygian
    bpmMode: "artist", // artist|fixed|manual

    root: 0,
    scale: "natural",
    bpm: 170,

    plan: null,
    song: null,
    midiBytes: null,

    // learning signals
    lastGenerateAt: 0,
    lastPlanKey: "",
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

  // Mood list (pick 1)
  const MOODS = [
    { id:"DROP", label:"DROP" },
    { id:"TEASE_DROP", label:"TEASE→DROP" },
    { id:"HIT_STOP", label:"HIT-STOP" },
    { id:"FLOATY", label:"FLOATY" },
    { id:"PUNCHY_LOOP", label:"PUNCHY LOOP" },
    { id:"RUSHED", label:"RUSHED" },
    { id:"DARK", label:"DARK" },
  ];

  // ---------- RNG / UTIL ----------
  function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }
  function lerp(a,b,t){ return a + (b-a)*t; }

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

  function noteName(root){
    const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
    return names[(root%12+12)%12];
  }

  // ---------- LEARNING STORE ----------
  const LS_KEY = "digi_midigen_ai_v2";

  function loadBrain(){
    try{
      const raw = localStorage.getItem(LS_KEY);
      if(!raw) return {};
      const obj = JSON.parse(raw);
      return (obj && typeof obj === "object") ? obj : {};
    }catch{
      return {};
    }
  }
  function saveBrain(brain){
    try{ localStorage.setItem(LS_KEY, JSON.stringify(brain)); } catch {}
  }

  function ensureArtistBrain(brain, artist){
    if(!brain[artist]){
      brain[artist] = {
        // weights for archetypes (AI picks based on these)
        archetypeBias: {
          DROP: 1.0,
          TEASE_DROP: 1.0,
          HIT_STOP: 1.0,
          FLOATY: 1.0,
          PUNCHY_LOOP: 1.0,
          RUSHED: 1.0,
          DARK: 1.0
        },
        // numeric taste nudges
        pref: {
          density: 0.0,    // -0.3..+0.3
          stopiness: 0.0,  // -0.3..+0.3
          variation: 0.0,  // -0.3..+0.3
        },
        score: 0
      };
    }
    return brain[artist];
  }

  function applyFeedback(delta){
    // delta: +1 like, -1 dislike, +0.5 download, -0.25 regen-too-fast
    if(!state.plan) return;
    const main = state.plan.mainArtist;
    const brain = loadBrain();
    const a = ensureArtistBrain(brain, main);

    // bias archetype used
    const moodId = state.plan.mood;
    const b = a.archetypeBias;
    b[moodId] = clamp((b[moodId] || 1.0) + delta*0.12, 0.4, 2.2);

    // nudge taste metrics based on what that plan did
    a.pref.density = clamp(a.pref.density + delta * (state.plan.meta.densityHint-0.5) * 0.06, -0.3, 0.3);
    a.pref.stopiness = clamp(a.pref.stopiness + delta * (state.plan.meta.stopHint-0.5) * 0.06, -0.3, 0.3);
    a.pref.variation = clamp(a.pref.variation + delta * (state.plan.meta.variationHint-0.5) * 0.06, -0.3, 0.3);

    a.score = clamp((a.score||0) + delta, -50, 200);

    saveBrain(brain);
  }

  // ---------- ARTIST PRIORS (THE "ALREADY KNOWS" PART) ----------
  // This is the baked-in discipline: repetition windows, mutation budgets, stop policy, density curves, and layer behavior.
  // (We keep it abstracted to avoid “copying songs”, but it creates recognizable structure.)
  const ARTIST_PRIORS = {
    "KEN CARSON": {
      tempo:[160,185],
      repWindow:[4,4], mutation:[1,3],
      stopBars:[4,8], stopProb:0.55,
      hatRoll:"high", fills:"high",
      kickSync:"med", hatDensity:"high",
      melodyMove:"low", padChance:0.10, bellChance:0.18,
      energy:"spike"
    },
    "ESDEEKID": {
      tempo:[168,195],
      repWindow:[2,4], mutation:[2,5],
      stopBars:[4,8], stopProb:0.45,
      hatRoll:"very_high", fills:"very_high",
      kickSync:"high", hatDensity:"very_high",
      melodyMove:"med", padChance:0.06, bellChance:0.10,
      energy:"pressure"
    },
    "FIMIGUERRERO": {
      tempo:[165,195],
      repWindow:[2,4], mutation:[2,5],
      stopBars:[4,8], stopProb:0.60,
      hatRoll:"high", fills:"high",
      kickSync:"high", hatDensity:"high",
      melodyMove:"low", padChance:0.08, bellChance:0.12,
      energy:"spike"
    },
    "2HOLLIS": {
      tempo:[150,176],
      repWindow:[4,8], mutation:[0,2],
      stopBars:[8], stopProb:0.18,
      hatRoll:"low", fills:"low",
      kickSync:"low", hatDensity:"med",
      melodyMove:"low", padChance:0.42, bellChance:0.25,
      energy:"hypno"
    },
    "BLADEE": {
      tempo:[140,170],
      repWindow:[8,8], mutation:[0,2],
      stopBars:[8], stopProb:0.12,
      hatRoll:"low", fills:"low",
      kickSync:"low", hatDensity:"low",
      melodyMove:"med", padChance:0.55, bellChance:0.45,
      energy:"float"
    },
    "FENG": {
      tempo:[145,172],
      repWindow:[4,8], mutation:[0,2],
      stopBars:[8], stopProb:0.22,
      hatRoll:"low", fills:"low",
      kickSync:"low", hatDensity:"low",
      melodyMove:"low", padChance:0.50, bellChance:0.18,
      energy:"dark_space"
    },
    "FAKEMINK": {
      tempo:[155,182],
      repWindow:[4,4], mutation:[1,4],
      stopBars:[4,8], stopProb:0.30,
      hatRoll:"med", fills:"med",
      kickSync:"med", hatDensity:"med",
      melodyMove:"med", padChance:0.18, bellChance:0.30,
      energy:"punch"
    }
  };

  // MIX blending: main artist dominates structure; others nudge density/stop/variation.
  function blendPriors(artists){
    const main = artists[0];
    const pri = structuredClone(ARTIST_PRIORS[main] || ARTIST_PRIORS["FAKEMINK"]);
    if(artists.length === 1) return { main, pri, mix:false };

    const rest = artists.slice(1);
    const wMain = 0.62;
    const wRest = (1 - wMain) / rest.length;

    function blendRange(key){
      let a0 = pri[key][0]*wMain;
      let a1 = pri[key][1]*wMain;
      for(const name of rest){
        const p = ARTIST_PRIORS[name] || pri;
        a0 += p[key][0]*wRest;
        a1 += p[key][1]*wRest;
      }
      pri[key] = [Math.round(a0), Math.round(a1)];
    }
    blendRange("tempo");
    blendRange("repWindow");
    blendRange("mutation");

    // stopProb, chances, etc.
    let stopProb = pri.stopProb*wMain;
    let padChance = pri.padChance*wMain;
    let bellChance = pri.bellChance*wMain;
    for(const name of rest){
      const p = ARTIST_PRIORS[name] || pri;
      stopProb += p.stopProb*wRest;
      padChance += p.padChance*wRest;
      bellChance += p.bellChance*wRest;
    }
    pri.stopProb = clamp(stopProb, 0.05, 0.80);
    pri.padChance = clamp(padChance, 0.02, 0.70);
    pri.bellChance = clamp(bellChance, 0.02, 0.70);

    // keep main categorical identity for rhythm grammar
    return { main, pri, mix:true };
  }

  // ---------- MUSIC GRID ----------
  const PPQ = 480;
  const BEAT = PPQ;
  const SIXTEENTH = PPQ / 4;
  const BAR = PPQ * 4;
  const BARS = 8;
  const LOOP_TICKS = BARS * BAR;

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
  const DR = { kick:36, snare:38, clap:39, hatC:42, hatO:46 };

  function scaleIntervals(mode){
    if(mode === "harmonic") return [0,2,3,5,7,8,11];
    if(mode === "phrygian") return [0,1,3,5,7,8,10];
    return [0,2,3,5,7,8,10];
  }
  function degreeToMidi(rootMidi, intervals, deg, oct=0){
    const semis = intervals[(deg-1)%7];
    return rootMidi + semis + oct*12;
  }

  function chance(rng,p){ return rng() < p; }
  function randInt(rng,a,b){ return Math.floor(lerp(a,b+1,rng())); }
  function randVel(rng,a,b){ return clamp(Math.round(lerp(a,b,rng())), 1, 127); }

  // ---------- AI PLANNER ----------
  // Output BeatPlan that is artist-coded + mood modified + learning nudged.
  function planBeat(seed){
    const rng = mulberry32(seed);
    const artists = [...state.selectedArtists];
    const mood = state.mood;

    const { main, pri, mix } = blendPriors(artists);

    // learning nudges
    const brain = loadBrain();
    const aBrain = ensureArtistBrain(brain, main);
    const bias = aBrain.archetypeBias || {};
    const pref = aBrain.pref || { density:0, stopiness:0, variation:0 };

    // mood selection (user pick) still matters, but learning can slightly bias within that mood:
    // (We keep it simple: mood locks the archetype name; learning affects how intense it is.)
    const archetype = mood;

    // base intensity from artist energy + mood
    const moodMods = moodToMods(archetype);

    // repetition + mutation discipline (THE BIG FIX)
    const repWindow = clamp(randInt(rng, pri.repWindow[0], pri.repWindow[1]) + (pref.variation < -0.1 ? 2 : 0), 2, 8);
    const mutationBudget = clamp(randInt(rng, pri.mutation[0], pri.mutation[1]) + (pref.variation > 0.12 ? 1 : 0) + (moodMods.variationBoost||0), 0, 6);

    // tempo
    let bpm = Math.round(lerp(pri.tempo[0], pri.tempo[1], rng()));
    if(state.bpmMode === "fixed"){
      bpm = clamp(parseInt(bpmFixedInput.value||"170",10), 60, 220);
    } else if(state.bpmMode === "manual"){
      bpm = clamp(parseInt(bpmManualInput.value||"170",10), 60, 220);
    }

    // key/scale
    let scale = resolveScale(rng, main, mood);
    if(state.scaleMode !== "auto") scale = state.scaleMode;

    let root = resolveRoot(rng, main, mood);
    if(state.keyMode === "pick") root = state.root;

    // stop policy
    let stopProb = pri.stopProb + (pref.stopiness*0.15) + (moodMods.stopBoost||0);
    stopProb = clamp(stopProb, 0.05, 0.85);

    const stopBars = pri.stopBars || [8];
    const stopPick = pickWeighted(rng, stopBars.map(b=>({k:b, w:(b===4?1.2:1.0)})));

    const stop = chance(rng, stopProb) ? { bar: stopPick, beats: (archetype==="HIT_STOP" ? 1.0 : 0.5) } : null;

    // energy curve per bar (0..1) — mood changes it, but artist keeps its “shape”
    const densityCurve = buildDensityCurve(rng, main, pri.energy, archetype, moodMods, pref.density);

    // layer schedule per bar (the discipline)
    const layersByBar = buildLayerSchedule(rng, main, archetype, densityCurve, pri, moodMods);

    // meta hints for learning feedback
    const meta = {
      densityHint: clamp(densityCurve.reduce((a,b)=>a+b,0)/densityCurve.length, 0, 1),
      stopHint: stop ? 0.85 : 0.25,
      variationHint: clamp(mutationBudget/6, 0, 1),
    };

    const plan = {
      version: "v2",
      seed,
      mainArtist: main,
      artists,
      mix,
      mood: archetype,

      bpm,
      root,
      scale,

      repWindow,
      mutationBudget,
      stop,

      densityCurve,      // length 8
      layersByBar,       // length 8 objects

      // rhythm grammar knobs (artist-coded)
      grammar: {
        kickSync: pri.kickSync,
        hatRoll: pri.hatRoll,
        fills: pri.fills,
        hatDensity: pri.hatDensity,
        melodyMove: pri.melodyMove,
        padChance: pri.padChance + (moodMods.padBoost||0),
        bellChance: pri.bellChance + (moodMods.bellBoost||0)
      },

      // preview fx knobs (artist-coded)
      fx: buildFxProfile(main, archetype, pri),

      meta
    };

    return plan;
  }

  function moodToMods(mood){
    switch(mood){
      case "DROP": return { variationBoost:0, stopBoost:0.0 };
      case "TEASE_DROP": return { introTease:true, variationBoost:0, stopBoost:0.0 };
      case "HIT_STOP": return { variationBoost:1, stopBoost:0.15 };
      case "FLOATY": return { padBoost:0.18, bellBoost:0.18, stopBoost:-0.08, densityDown:0.12 };
      case "PUNCHY_LOOP": return { variationBoost:-1, stopBoost:-0.05 };
      case "RUSHED": return { variationBoost:1, stopBoost:0.10, densityUp:0.12 };
      case "DARK": return { padBoost:0.14, bellBoost:-0.06, stopBoost:0.05, densityDown:0.08, darkBias:true };
      default: return {};
    }
  }

  function resolveScale(rng, artist, mood){
    // artist-coded biases
    const dark = (artist==="FENG" || mood==="DARK");
    const float = (artist==="BLADEE" || mood==="FLOATY");
    return pickWeighted(rng, [
      {k:"natural", w: float ? 0.78 : 0.62},
      {k:"harmonic", w: dark ? 0.28 : 0.18},
      {k:"phrygian", w: dark ? 0.18 : 0.20},
    ]);
  }

  function resolveRoot(rng, artist, mood){
    // light bias toward A/E/F for darker / trance-y
    const keys = [0,1,2,3,4,5,6,7,8,9,10,11];
    const w = keys.map(k => 1.0);
    if(artist==="FENG" || mood==="DARK"){
      w[9]+=0.9; // A
      w[4]+=0.6; // E
      w[5]+=0.5; // F
    }
    if(artist==="KEN CARSON" || artist==="ESDEEKID" || artist==="FIMIGUERRERO"){
      w[1]+=0.4; w[6]+=0.35; w[8]+=0.25; // sharper keys
    }
    const total = w.reduce((a,b)=>a+b,0);
    let r = rng()*total;
    for(let i=0;i<keys.length;i++){ r -= w[i]; if(r<=0) return keys[i]; }
    return 0;
  }

  function buildDensityCurve(rng, main, energyType, mood, mods, learnDensity){
    // base start/end depending on artist "energy identity"
    let baseLow = 0.25, baseHigh = 0.85;

    if(energyType==="float"){ baseLow=0.18; baseHigh=0.62; }
    if(energyType==="hypno"){ baseLow=0.28; baseHigh=0.66; }
    if(energyType==="dark_space"){ baseLow=0.16; baseHigh=0.58; }
    if(energyType==="punch"){ baseLow=0.30; baseHigh=0.78; }
    if(energyType==="pressure"){ baseLow=0.55; baseHigh=0.92; }
    if(energyType==="spike"){ baseLow=0.35; baseHigh=0.95; }

    // mood nudges
    baseLow -= (mods.densityDown||0);
    baseHigh -= (mods.densityDown||0);
    baseLow += (mods.densityUp||0);
    baseHigh += (mods.densityUp||0);

    // learning density nudge
    baseLow = clamp(baseLow + learnDensity*0.12, 0.08, 0.75);
    baseHigh = clamp(baseHigh + learnDensity*0.12, 0.20, 0.98);

    const curve = new Array(8).fill(0);

    if(mood==="PUNCHY_LOOP" || energyType==="hypno"){
      // flat-ish for hypnotic/punchy loop
      const mid = clamp(lerp(baseLow, baseHigh, 0.65), 0.12, 0.95);
      for(let i=0;i<8;i++){
        curve[i] = clamp(mid + (rng()*0.06 - 0.03), 0.08, 0.98);
      }
      // tiny accent at bar 8
      curve[7] = clamp(curve[7] + 0.06, 0.08, 0.98);
      return curve;
    }

    if(mood==="TEASE_DROP"){
      // tease then full
      curve[0] = clamp(baseLow, 0.08, 0.95);
      curve[1] = clamp(baseLow + 0.05, 0.08, 0.95);
      for(let i=2;i<8;i++){
        const t = (i-2)/5;
        curve[i] = clamp(lerp(baseLow+0.18, baseHigh, t) + (rng()*0.05-0.02), 0.08, 0.98);
      }
      curve[7] = clamp(curve[7]+0.06, 0.08, 0.98);
      return curve;
    }

    if(mood==="FLOATY" || energyType==="float"){
      // float -> lift -> float
      curve[0] = clamp(baseLow, 0.08, 0.95);
      curve[1] = clamp(baseLow + 0.06, 0.08, 0.95);
      curve[2] = clamp(baseLow + 0.10, 0.08, 0.95);
      curve[3] = clamp(baseLow + 0.14, 0.08, 0.95);
      curve[4] = clamp(baseHigh - 0.06, 0.08, 0.98);
      curve[5] = clamp(baseHigh - 0.08, 0.08, 0.98);
      curve[6] = clamp(baseHigh - 0.12, 0.08, 0.98);
      curve[7] = clamp(baseHigh - 0.04, 0.08, 0.98);
      return curve.map(v=>clamp(v + (rng()*0.04-0.02), 0.08, 0.98));
    }

    // default ramp/spike/pressure
    for(let i=0;i<8;i++){
      const t = i/7;
      let v = lerp(baseLow, baseHigh, t);
      if(energyType==="spike"){
        if(i>=2) v = clamp(v + 0.10, 0.08, 0.98);
        if(i===3 || i===7) v = clamp(v + 0.06, 0.08, 0.98);
      }
      if(energyType==="pressure"){
        v = clamp(lerp(0.65, baseHigh, t) + 0.06, 0.08, 0.98);
      }
      curve[i] = clamp(v + (rng()*0.05 - 0.02), 0.08, 0.98);
    }
    return curve;
  }

  function buildLayerSchedule(rng, main, archetype, densityCurve, pri, mods){
    // return array length 8 of layer toggles (0/1-ish)
    // Key discipline: early tease for some moods/artists, consistent repetition for others.
    const bars = [];
    for(let i=0;i<8;i++){
      const d = densityCurve[i];
      const introZone = (i < 2);
      const midZone = (i >=2 && i<6);
      const endZone = (i >=6);

      // base: drums scale with density
      let kick = d > 0.45 ? 1 : 0;
      let snare = d > 0.35 ? 1 : 0;
      let hats = d > 0.25 ? 1 : 0;
      let bass = d > 0.40 ? 1 : 0;

      // melody layers
      let lead = d > 0.22 ? 1 : 0;
      let pad = chance(rng, clamp(pri.padChance + (mods.padBoost||0), 0, 0.8)) ? 1 : 0;
      let bell = chance(rng, clamp(pri.bellChance + (mods.bellBoost||0), 0, 0.8)) ? 1 : 0;
      let text = d > 0.55 ? 1 : chance(rng, 0.20) ? 1 : 0;

      // archetype-specific discipline
      if(archetype==="TEASE_DROP" || mods.introTease){
        if(introZone){
          kick = 0; bass = 0;
          snare = (main==="ESDEEKID" || main==="FIMIGUERRERO") ? 0 : snare*0; // keep it clean
          hats = (main==="KEN CARSON" || main==="ESDEEKID") ? 1 : hats;
          lead = 1;
          pad = pad ? 1 : (main==="BLADEE" || main==="2HOLLIS" || main==="FENG" ? 1 : 0);
        }
      }

      if(archetype==="FLOATY"){
        kick = (d > 0.60) ? 1 : 0;
        bass = (d > 0.62) ? 1 : 0;
        hats = (d > 0.35) ? 1 : 0;
        snare = (d > 0.40) ? 1 : 0;
        lead = 1;
        pad = 1;
        bell = bell ? 1 : (chance(rng,0.55)?1:0);
        text = 1;
      }

      if(archetype==="PUNCHY_LOOP"){
        // consistent loop
        kick = d > 0.35 ? 1 : 0;
        snare = d > 0.30 ? 1 : 0;
        hats = 1;
        bass = d > 0.40 ? 1 : 0;
        lead = 1;
        pad = (main==="2HOLLIS" || main==="BLADEE") ? 1 : pad;
        bell = bell ? 1 : 0;
        text = 0;
      }

      if(archetype==="RUSHED"){
        hats = 1;
        snare = 1;
        kick = 1;
        bass = d > 0.35 ? 1 : 0;
        lead = 1;
        text = 1;
      }

      if(archetype==="DARK"){
        pad = 1;
        bell = 0;
        text = 1;
        kick = (d > 0.55) ? 1 : 0;
        hats = (d > 0.40) ? 1 : 0;
        lead = 1;
      }

      // artist-specific discipline overrides (this is where “I can see the artist” happens)
      if(main==="BLADEE"){
        // smooth, fewer hard drums early, more pad
        if(introZone){ kick = 0; bass = 0; hats = hats ? 1 : 0; }
        pad = 1;
        bell = bell ? 1 : (chance(rng,0.55)?1:0);
        text = text ? 1 : (chance(rng,0.35)?1:0);
      }

      if(main==="2HOLLIS"){
        // hypnotic: minimal drum volatility, pad more likely
        pad = pad ? 1 : (chance(rng,0.45)?1:0);
        bell = bell ? 1 : (chance(rng,0.25)?1:0);
        // keep kick less constant
        kick = (d > 0.55) ? 1 : 0;
        hats = (d > 0.30) ? 1 : 0;
      }

      if(main==="KEN CARSON"){
        // hard drop identity: if density is high, keep drums full
        if(i>=2){ kick=1; snare=1; hats=1; bass=1; }
      }

      if(main==="ESDEEKID" || main==="FIMIGUERRERO"){
        // constant pressure: hats almost always on after bar 1
        if(i>=1) hats = 1;
        if(i>=2){ snare=1; }
      }

      if(main==="FENG"){
        // sparse, moody
        if(introZone){ kick=0; bass=0; }
        hats = (d > 0.55) ? 1 : 0;
        snare = (d > 0.60) ? 1 : 0;
        pad = 1;
      }

      if(main==="FAKEMINK"){
        // punchy loop, rhythmic emphasis
        hats = 1;
        if(endZone) text = 1;
      }

      bars.push({
        kick: !!kick, snare: !!snare, hats: !!hats, bass: !!bass,
        lead: !!lead, pad: !!pad, bell: !!bell, text: !!text
      });
    }
    return bars;
  }

  function buildFxProfile(main, mood, pri){
    // preview FX profile per artist (not “exact sounds”, but makes the beat read clearer)
    const base = {
      clip: 0.45,
      duck: 0.25,
      crush: 0.0,
      verb: 0.18,
      width: 0.18,
      monoBass: true
    };

    if(main==="KEN CARSON" || main==="FIMIGUERRERO" || main==="ESDEEKID"){
      base.clip = 0.72;
      base.duck = 0.42;
      base.verb = 0.10;
      base.width = 0.10;
    }
    if(main==="BLADEE"){
      base.clip = 0.35;
      base.duck = 0.18;
      base.verb = 0.30;
      base.width = 0.24;
    }
    if(main==="2HOLLIS"){
      base.clip = 0.40;
      base.duck = 0.20;
      base.verb = 0.26;
      base.width = 0.22;
    }
    if(main==="FENG"){
      base.clip = 0.38;
      base.duck = 0.18;
      base.verb = 0.28;
      base.width = 0.18;
    }
    if(main==="FAKEMINK"){
      base.clip = 0.55;
      base.duck = 0.28;
      base.verb = 0.16;
      base.width = 0.14;
    }

    if(mood==="FLOATY"){ base.verb += 0.10; base.width += 0.06; base.duck -= 0.06; }
    if(mood==="DARK"){ base.crush += 0.08; base.verb += 0.04; }
    if(mood==="RUSHED"){ base.duck += 0.06; base.clip += 0.06; }
    if(mood==="PUNCHY_LOOP"){ base.duck += 0.04; base.verb -= 0.04; }

    base.clip = clamp(base.clip, 0.25, 0.90);
    base.duck = clamp(base.duck, 0.08, 0.70);
    base.crush = clamp(base.crush, 0.0, 0.30);
    base.verb = clamp(base.verb, 0.06, 0.40);
    base.width = clamp(base.width, 0.0, 0.30);

    return base;
  }

  // ---------- CONSTRAINT GENERATOR ----------
  function addNote(arr, t, d, n, v){ arr.push({t: t|0, d: Math.max(1,d|0), n: n|0, v: v|0, type:"note"}); }
  function addDrum(arr, t, d, n, v){ arr.push({t: t|0, d: Math.max(1,d|0), n: n|0, v: v|0, type:"drum"}); }

  function buildSongFromPlan(plan){
    const rng = mulberry32(plan.seed ^ 0xA5A5A5A5);

    const intervals = scaleIntervals(plan.scale);
    const rootMidi = 60 + plan.root;
    const rootBass = 36 + plan.root;

    // Track event containers
    const tracks = { PAD:[], LEAD:[], BELL:[], BASS:[], KICK:[], SNARE:[], HATS:[], TEXT:[] };

    // 1) Build a "pattern cell" for 1 bar for drums + bass + lead, then repeat for repWindow with limited mutation.
    // This is the discipline that stops “jumble techno”.
    const rep = plan.repWindow;
    const mutBudget = plan.mutationBudget;
    let mutsUsed = 0;

    // Snare anchor: always on beat 2 and 4 (standard), with halftime feel for some
    const halftime = (plan.mainArtist==="FENG" && chance(rng,0.45)) || (plan.mood==="DARK" && chance(rng,0.22));
    const snareBeats = halftime ? [3] : [2,4];

    // choose a lead motif (simple) that repeats
    const motif = makeMotif(rng, plan, intervals, rootMidi);

    for(let bar=0; bar<8; bar++){
      const layer = plan.layersByBar[bar];
      const density = plan.densityCurve[bar];
      const t0 = bar * BAR;

      // stop policy (hard mute moment)
      const stopHere = plan.stop && (plan.stop.bar === (bar+1));
      const stopTicks = stopHere ? Math.round(plan.stop.beats * BEAT) : 0;

      // drums per bar (obey layer schedule)
      if(layer.snare){
        for(const b of snareBeats){
          const tt = t0 + (b-1)*BEAT;
          if(stopHere && tt >= t0 && tt < t0+stopTicks) continue;
          addDrum(tracks.SNARE, tt, SIXTEENTH, DR.snare, randVel(rng, 96, 124));
          if(chance(rng,0.65)) addDrum(tracks.SNARE, tt, SIXTEENTH, DR.clap, randVel(rng, 72, 106));
        }
      }

      if(layer.kick){
        const pat = drumKickPatternForArtist(rng, plan, density, bar, rep);
        for(const k of pat){
          const tt = t0 + k;
          if(stopHere && tt < t0+stopTicks) continue;
          addDrum(tracks.KICK, tt, SIXTEENTH, DR.kick, randVel(rng, 102, 125));
        }
      }

      if(layer.hats){
        const hatGrid = hatGridForArtist(plan);
        for(let tt=t0; tt<t0+BAR; tt+=hatGrid){
          if(stopHere && tt < t0+stopTicks) continue;
          if(chance(rng, 0.08 + (1-density)*0.12)) continue; // space
          addDrum(tracks.HATS, tt, hatGrid/2, DR.hatC, randVel(rng, 58, 96));
        }
        // rolls
        const rollP = hatRollProb(plan, density);
        if(chance(rng, rollP)){
          const rollStart = t0 + (chance(rng,0.55) ? BAR - BEAT : BEAT*2);
          const rate = chance(rng,0.6) ? (SIXTEENTH/2) : (SIXTEENTH/3);
          const rollLen = chance(rng,0.6) ? SIXTEENTH*6 : SIXTEENTH*8;
          for(let tt=rollStart; tt<rollStart+rollLen; tt+=rate){
            if(stopHere && tt < t0+stopTicks) continue;
            addDrum(tracks.HATS, tt, rate/2, DR.hatC, randVel(rng, 60, 102));
          }
        }
      }

      // bass obeys kick accents and density; repetition discipline
      if(layer.bass){
        const bassRootDeg = pickWeighted(rng, [
          {k:1, w:2.0},{k:5, w:1.6},{k:6, w:1.2},{k:7, w:0.9}
        ]);
        const bassN = degreeToMidi(rootBass, intervals, bassRootDeg, 0);

        const accents = (tracks.KICK.filter(e=>Math.floor(e.t/BAR)===bar).map(e=>e.t - t0));
        const bassHits = bassPatternFromAccents(rng, plan, accents, density);

        for(const hit of bassHits){
          const tt = t0 + hit.t;
          if(stopHere && tt < t0+stopTicks) continue;
          addNote(tracks.BASS, tt, hit.d, bassN + hit.pitchOff, randVel(rng, 82, 122));
        }
      }

      // pads / bells are “scene glue”
      if(layer.pad){
        const chordDeg = pickWeighted(rng, [{k:1,w:2.0},{k:6,w:1.2},{k:7,w:1.0},{k:4,w:0.8}]);
        const n1 = degreeToMidi(rootMidi, intervals, chordDeg, -1);
        const n5 = n1 + 7;
        const n3 = degreeToMidi(rootMidi, intervals, ((chordDeg+2-1)%7)+1, -1);
        const omitThird = chance(rng, (plan.mainArtist==="2HOLLIS"||plan.mainArtist==="FENG") ? 0.72 : 0.55);
        const notes = omitThird ? [n1,n5] : [n1,n3,n5];
        const len = chance(rng,0.65) ? BAR : BAR/2;
        for(const n of notes) addNote(tracks.PAD, t0, len, n, randVel(rng, 40, 70));
      }

      if(layer.bell && chance(rng, 0.55 + density*0.25)){
        const deg = pickWeighted(rng, [{k:1,w:2.0},{k:3,w:1.2},{k:5,w:1.8},{k:7,w:1.0}]);
        const n = degreeToMidi(rootMidi, intervals, deg, 2);
        const tt = t0 + (chance(rng,0.5) ? BEAT*1.5 : BEAT*2.5);
        if(!(stopHere && tt < t0+stopTicks)){
          addNote(tracks.BELL, tt, SIXTEENTH*2, n, randVel(rng, 56, 92));
        }
      }

      // lead motif: repeats with controlled mutation (mutation budget)
      if(layer.lead){
        const barIndexWithinRep = bar % rep;
        const allowMut = (barIndexWithinRep === rep-1) && (mutsUsed < mutBudget) && chance(rng, 0.55 + density*0.25);

        if(allowMut){ mutsUsed++; }

        const leadEvents = renderMotif(rng, plan, motif, intervals, rootMidi, t0, density, allowMut);
        for(const e of leadEvents){
          if(stopHere && e.t < t0+stopTicks) continue;
          tracks.LEAD.push(e);
        }
      }

      // texture: only if dense or floaty
      if(layer.text && chance(rng, 0.35 + density*0.45)){
        const deg = pickWeighted(rng, [{k:1,w:2.0},{k:5,w:1.6},{k:7,w:1.1},{k:3,w:1.0}]);
        const n = degreeToMidi(rootMidi, intervals, deg, chance(rng,0.5)?-1:0);
        const tt = t0 + (chance(rng,0.5)?0:BEAT*2);
        if(!(stopHere && tt < t0+stopTicks)){
          addNote(tracks.TEXT, tt, BEAT, n, randVel(rng, 18, 52));
        }
      }
    }

    // sort events
    for(const k of Object.keys(tracks)){
      tracks[k].sort((a,b)=>a.t-b.t);
    }

    return {
      seed: plan.seed,
      bpm: plan.bpm,
      root: plan.root,
      scale: plan.scale,
      artists: plan.artists,
      mainArtist: plan.mainArtist,
      mood: plan.mood,
      plan,
      tracks
    };
  }

  function hatGridForArtist(plan){
    // hat density “feel”
    const h = plan.grammar.hatDensity;
    if(h==="very_high") return SIXTEENTH;
    if(h==="high") return SIXTEENTH*2;
    if(h==="med") return SIXTEENTH*2;
    return SIXTEENTH*4;
  }
  function hatRollProb(plan, density){
    const hr = plan.grammar.hatRoll;
    let p = 0.12;
    if(hr==="low") p = 0.10;
    if(hr==="med") p = 0.22;
    if(hr==="high") p = 0.42;
    if(hr==="very_high") p = 0.55;
    // density increases roll probability
    return clamp(p + density*0.12, 0.08, 0.75);
  }

  function drumKickPatternForArtist(rng, plan, density, bar, rep){
    // returns tick offsets inside BAR
    const main = plan.mainArtist;

    // anchor behavior: gives “identity”
    const base = [];

    // always anchor beat 1 for Ken/Fimi/Esdeekid (hard identity)
    if(main==="KEN CARSON" || main==="ESDEEKID" || main==="FIMIGUERRERO"){
      base.push(0);
    } else if(main==="FAKEMINK"){
      if(chance(rng,0.75)) base.push(0);
    } else {
      if(chance(rng,0.55 + density*0.20)) base.push(0);
    }

    // add artist-specific syncopation
    const add = (t)=>{ if(t>=0 && t < BAR) base.push(t|0); };

    if(main==="KEN CARSON"){
      if(chance(rng,0.70)) add(BEAT + SIXTEENTH);
      add(BEAT*2);
      if(chance(rng,0.55)) add(BEAT*3 - SIXTEENTH);
    } else if(main==="ESDEEKID" || main==="FIMIGUERRERO"){
      add(BEAT + SIXTEENTH*2);
      add(BEAT*2);
      if(chance(rng,0.72)) add(BEAT*2 + SIXTEENTH*2);
      if(chance(rng,0.65)) add(BEAT*3 + SIXTEENTH);
    } else if(main==="BLADEE"){
      // sparse
      if(chance(rng,0.35)) add(BEAT*2);
      if(chance(rng,0.25)) add(BEAT*3);
    } else if(main==="2HOLLIS"){
      // hypnotic, minimal
      add(BEAT*2);
      if(chance(rng,0.30)) add(BEAT*3 + SIXTEENTH*2);
    } else if(main==="FENG"){
      if(chance(rng,0.35)) add(BEAT*2);
    } else if(main==="FAKEMINK"){
      add(BEAT + SIXTEENTH);
      if(chance(rng,0.55)) add(BEAT*3 - SIXTEENTH);
    }

    // density adds a couple extra hits but capped
    const cap = (main==="BLADEE" || main==="FENG") ? 3 : (main==="2HOLLIS" ? 4 : 6);
    const want = Math.round(lerp(2, cap, density));
    while(base.length < want && chance(rng,0.75)){
      const t = Math.floor((rng()*BAR)/(SIXTEENTH*2))*(SIXTEENTH*2);
      add(t);
      if(base.length >= cap) break;
    }

    // de-dupe + sort
    const uniq = [...new Set(base)].sort((a,b)=>a-b);

    // enforce repetition discipline: small deterministic shift on last bar in rep group
    const within = bar % rep;
    if(within === rep-1 && plan.mutationBudget > 0 && chance(rng,0.35)){
      if(uniq.length > 2){
        uniq[uniq.length-1] = clamp(uniq[uniq.length-1] + (chance(rng,0.5)?SIXTEENTH:-SIXTEENTH), 0, BAR-SIXTEENTH);
      }
    }
    return uniq;
  }

  function bassPatternFromAccents(rng, plan, accents, density){
    // bass follows kick accents with controlled slides
    const hits = [];
    const main = plan.mainArtist;
    const slideP = (main==="ESDEEKID"||main==="FIMIGUERRERO") ? 0.55 : (main==="KEN CARSON" ? 0.35 : 0.22);

    // pick a few accents
    const chosen = accents.filter(()=>chance(rng, 0.55 + density*0.20));
    const base = chosen.length ? chosen : [0, BEAT*2];

    for(const t of base){
      const len = chance(rng,0.55) ? SIXTEENTH*4 : SIXTEENTH*6;
      let pitchOff = 0;
      if(chance(rng, slideP) && density > 0.55){
        pitchOff = chance(rng,0.5) ? -5 : 7;
        hits.push({t, d: SIXTEENTH*2, pitchOff,});
        hits.push({t:t+SIXTEENTH*2, d: len, pitchOff:0});
      } else {
        hits.push({t, d: len, pitchOff:0});
      }
    }
    // cap
    return hits.slice(0, (main==="BLADEE"||main==="FENG") ? 2 : 4);
  }

  function makeMotif(rng, plan, intervals, rootMidi){
    // simple motif tokens (degree, grid, length)
    // Discipline: low movement for Ken/2hollis; more for Bladee/Fakemink.
    const move = plan.grammar.melodyMove;
    const count = (move==="low") ? randInt(rng, 2, 4) : randInt(rng, 3, 6);
    const grid = (plan.mainArtist==="ESDEEKID"||plan.mainArtist==="FIMIGUERRERO") ? SIXTEENTH*2 : SIXTEENTH*4;

    const degPool = (plan.mood==="DARK")
      ? [1,7,6,5,4,3,2]
      : [1,3,5,7,2,4,6];

    const motif = [];
    let t = 0;
    for(let i=0;i<count;i++){
      const deg = degPool[randInt(rng,0,degPool.length-1)];
      const len = chance(rng,0.70) ? grid : grid*2;
      motif.push({deg, t, d: len});
      t += grid;
      if(t >= BAR) break;
    }
    return motif;
  }

  function renderMotif(rng, plan, motif, intervals, rootMidi, barStart, density, allowMut){
    const out = [];
    const oct = (plan.mainArtist==="BLADEE") ? 1 : 0;
    const velA = (plan.mainArtist==="KEN CARSON"||plan.mainArtist==="ESDEEKID"||plan.mainArtist==="FIMIGUERRERO") ? [70,112] : [55,95];

    for(const m of motif){
      if(chance(rng, 0.18 + (1-density)*0.18)) continue; // space
      let deg = m.deg;
      if(allowMut && chance(rng,0.55)){
        // small mutation only
        deg = clamp(deg + (chance(rng,0.5)?1:-1), 1, 7);
      }
      const n = degreeToMidi(rootMidi, intervals, deg, oct + (chance(rng,0.25)?1:0));
      addNote(out, barStart + m.t, m.d, n, randVel(rng, velA[0], velA[1]));
    }
    // end fill-ish note for aggressive artists
    if((plan.mainArtist==="ESDEEKID"||plan.mainArtist==="FIMIGUERRERO") && density>0.7 && chance(rng,0.35)){
      const deg = pickWeighted(rng, [{k:1,w:1.8},{k:7,w:1.1},{k:5,w:1.4}]);
      const n = degreeToMidi(rootMidi, intervals, deg, 1);
      addNote(out, barStart + BAR - SIXTEENTH*2, SIXTEENTH*2, n, randVel(rng, 68, 112));
    }
    return out;
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
    const trks = [];

    // tempo track
    const t0 = [];
    t0.push(...vlq(0), 0xFF, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08);
    const mpqn = Math.round(60000000 / song.bpm);
    t0.push(...vlq(0), 0xFF, 0x51, 0x03, (mpqn>>>16)&255, (mpqn>>>8)&255, mpqn&255);

    const name = `DIGI MIDI-GEN v2 • ${song.mainArtist} • ${song.mood} • ${song.bpm} BPM`;
    t0.push(...vlq(0), 0xFF, 0x03, name.length, ...strBytes(name));
    t0.push(...vlq(0), 0xFF, 0x2F, 0x00);
    trks.push(chunk("MTrk", t0));

    for(const tr of TRACKS){
      const evs = song.tracks[tr.id] || [];
      const data = [];
      data.push(...vlq(0), 0xFF, 0x03, tr.name.length, ...strBytes(tr.name));
      if(!tr.drum){
        data.push(...vlq(0), 0xC0 | (tr.ch & 0x0F), (tr.prog ?? 0) & 0x7F);
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
        data.push(...vlq(dt), ...ev.bytes);
        lastT = ev.t;
      }
      data.push(...vlq(0), 0xFF, 0x2F, 0x00);
      trks.push(chunk("MTrk", data));
    }

    const header = chunk("MThd", [...u16be(1), ...u16be(trks.length), ...u16be(PPQ)]);
    return new Uint8Array([...header, ...trks.flat()]);
  }

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
    const preset = song.plan.mix ? "MIX" : song.mainArtist.replace(/\s+/g,"");
    const key = `${noteName(song.root)}_${song.scale.toUpperCase()}`;
    return `DIGI_MIDIGEN_v2_${preset}_${song.mood}_${song.bpm}BPM_${key}_SEED${song.seed}.mid`;
  }

  // ---------- AUDIO ----------
  let audio = {
    ctx:null,
    playing:false,
    nodes:[],
    analyser:null,
    startTime:0,
    durationSec:0,
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

  function playAudio(song){
    stopAudio();
    const ctx = ensureAudio();
    if(ctx.state === "suspended") ctx.resume();

    audio.playing = true;
    setPlayUI(true);

    const start = ctx.currentTime + 0.05;
    const secondsPerBeat = 60 / song.bpm;
    const secondsPerTick = secondsPerBeat / PPQ;
    const durationSec = (LOOP_TICKS * secondsPerTick);

    audio.startTime = start;
    audio.durationSec = durationSec;

    // buses
    const master = ctx.createGain(); master.gain.value = 0.92;
    const musicBus = ctx.createGain(); musicBus.gain.value = 1.0;
    const drumBus  = ctx.createGain(); drumBus.gain.value = 0.95;
    const bassBus  = ctx.createGain(); bassBus.gain.value = 0.95;

    // fx profile
    const fx = song.plan.fx;

    // reverb
    const rev = makeTinyReverb(ctx, 1.1, 2.2);
    const revWet = ctx.createGain(); revWet.gain.value = fx.verb;
    const revDry = ctx.createGain(); revDry.gain.value = 1.0;
    musicBus.connect(rev);
    musicBus.connect(revDry);
    rev.connect(revWet);

    // width
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    const dl = ctx.createDelay(0.03); dl.delayTime.value = 0.012;
    const dr = ctx.createDelay(0.03); dr.delayTime.value = 0.017;
    const widenGain = ctx.createGain(); widenGain.gain.value = fx.width;

    const musicSum = ctx.createGain();
    revDry.connect(musicSum);
    revWet.connect(musicSum);

    musicSum.connect(splitter);
    splitter.connect(dl, 0);
    splitter.connect(dr, 1);
    dl.connect(merger, 0, 0);
    dr.connect(merger, 0, 1);
    merger.connect(widenGain);

    const duck = ctx.createGain(); duck.gain.value = 1.0;
    musicSum.connect(duck);
    widenGain.connect(duck);

    duck.connect(master);
    drumBus.connect(master);
    bassBus.connect(master);

    // ducking from kick
    const kickEvents = song.tracks.KICK || [];
    const duckDepth = fx.duck;
    const attack = 0.008;
    const release = lerp(0.08, 0.20, 1 - fx.width);

    duck.gain.setValueAtTime(1.0, start);
    for(const e of kickEvents){
      const t = start + (e.t * secondsPerTick);
      const min = clamp(1.0 - duckDepth, 0.25, 0.95);
      duck.gain.cancelScheduledValues(t);
      duck.gain.setValueAtTime(duck.gain.value, t);
      duck.gain.linearRampToValueAtTime(min, t + attack);
      duck.gain.linearRampToValueAtTime(1.0, t + attack + release);
    }

    // master chain
    const clipper = makeClipper(ctx, fx.clip);
    const crush = makeBitCrusher(ctx, 6, 0.22);
    const crushWet = ctx.createGain(); crushWet.gain.value = fx.crush;
    const crushDry = ctx.createGain(); crushDry.gain.value = 1 - fx.crush;

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass"; hp.frequency.value = 18;

    // analyser
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.78;
    audio.analyser = analyser;

    // routing chain
    const pre = ctx.createGain();
    master.connect(pre);

    pre.connect(crushDry);
    pre.connect(crush);
    crush.connect(crushWet);

    const postCrush = ctx.createGain();
    crushDry.connect(postCrush);
    crushWet.connect(postCrush);

    postCrush.connect(clipper);
    clipper.connect(hp);
    hp.connect(analyser);
    analyser.connect(ctx.destination);

    audio.nodes.push(
      master,musicBus,drumBus,bassBus,
      rev,revWet,revDry,musicSum,splitter,merger,dl,dr,widenGain,duck,
      pre,crush,crushWet,crushDry,postCrush,clipper,hp,analyser
    );

    // synth voices
    function makeVoiceBus(kind){
      const g = ctx.createGain(); g.gain.value = 1.0;
      const f = ctx.createBiquadFilter();
      f.type = (kind==="bass") ? "lowpass" : (kind==="pad" ? "lowpass" : "bandpass");
      f.frequency.value =
        kind==="bass" ? 420 :
        kind==="pad" ? 1400 :
        2200;
      f.Q.value = (kind==="lead") ? 1.2 : 0.8;

      const sat = makeClipper(ctx, clamp(fx.clip * (kind==="pad" ? 0.35 : 0.55), 0.15, 0.85));
      g.connect(f);
      f.connect(sat);

      if(kind==="bass") sat.connect(bassBus);
      else if(kind==="drum") sat.connect(drumBus);
      else sat.connect(musicBus);

      audio.nodes.push(g,f,sat);
      return g;
    }

    const busPad  = makeVoiceBus("pad");
    const busLead = makeVoiceBus("lead");
    const busBell = makeVoiceBus("bell");
    const busBass = makeVoiceBus("bass");
    const busText = makeVoiceBus("text");

    function oscTypes(kind, main){
      if(kind==="pad"){
        if(main==="2HOLLIS" || main==="FENG") return ["triangle","sine"];
        if(main==="BLADEE") return ["sine","sine"];
        return ["triangle","triangle"];
      }
      if(kind==="lead"){
        if(main==="KEN CARSON") return ["sawtooth","sawtooth"];
        if(main==="ESDEEKID" || main==="FIMIGUERRERO") return ["square","sawtooth"];
        return ["square","square"];
      }
      if(kind==="bass") return ["sine","sawtooth"];
      return ["sine","sine"];
    }

    function synthNote(t, dur, midi, vel, kind){
      const freq = 440 * Math.pow(2, (midi - 69) / 12);
      const ampBase = (kind==="pad")?0.16:(kind==="bell")?0.18:(kind==="bass")?0.22:(kind==="text")?0.10:0.14;
      const amp = (vel/127) * ampBase;

      const out = (kind==="pad")?busPad:(kind==="bell")?busBell:(kind==="bass")?busBass:(kind==="text")?busText:busLead;

      const g = ctx.createGain();
      g.gain.value = 0.0001;
      g.connect(out);

      const attack = (kind==="pad") ? 0.02 : 0.006;
      const release = (kind==="pad") ? 0.18 : 0.08;

      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, amp), t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(attack+0.01, dur - release));
      g.gain.setValueAtTime(0.0001, t + dur);

      const [t1,t2] = oscTypes(kind, song.mainArtist);
      const det = (song.mainArtist==="KEN CARSON") ? 9 : (song.mainArtist==="BLADEE") ? 6 : 4;

      const o1 = ctx.createOscillator();
      const o2 = ctx.createOscillator();
      o1.type = t1;
      o2.type = t2;
      o1.frequency.value = freq;
      o2.frequency.value = freq * (1 - det/1200);

      if(kind==="bass"){
        // simple punch envelope
        o1.frequency.setValueAtTime(freq * 2.1, t);
        o1.frequency.exponentialRampToValueAtTime(freq, t + 0.05);
        o2.frequency.setValueAtTime(freq * 2.1, t);
        o2.frequency.exponentialRampToValueAtTime(freq * (1 - det/1800), t + 0.05);
      }
      if(kind==="bell"){ o2.frequency.value = freq * 2.01; }

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

      const dur = (kind==="kick") ? 0.14 : 0.11;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.30*v + 0.0002, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      if(kind==="kick"){
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
        const mul = (kind==="clap") ? 0.75 : 1.0;
        for(let i=0;i<data.length;i++){
          data[i] = (Math.random()*2-1) * mul;
        }
        noise.buffer = buf;

        const f = ctx.createBiquadFilter();
        f.type = "highpass";
        f.frequency.value = (kind==="snare") ? 1100 : 1700;

        noise.connect(f);
        f.connect(g);
        noise.start(t);
        noise.stop(t + dur);
        audio.nodes.push(noise,f,g);
      }
    }

    const seconds = (ticks) => ticks * secondsPerTick;
    const tAt = (ticks) => start + seconds(ticks);

    // render all events
    const mapType = { PAD:"pad", LEAD:"lead", BELL:"bell", BASS:"bass", TEXT:"text" };

    for(const tr of TRACKS){
      const evs = song.tracks[tr.id] || [];
      for(const e of evs){
        const t = tAt(e.t);
        const dur = Math.max(0.03, seconds(e.d));
        if(tr.drum){
          if(e.n===DR.kick) drumHit(t,"kick", e.v);
          else if(e.n===DR.snare) drumHit(t,"snare", e.v);
          else if(e.n===DR.clap) drumHit(t,"clap", e.v);
          else drumHit(t,"snare", e.v);
        } else {
          synthNote(t, dur, e.n, e.v, mapType[tr.id] || "lead");
        }
      }
    }

    // auto-stop
    window.setTimeout(() => { if(audio.playing) stopAudio(); }, Math.max(0, (start + durationSec + 0.15 - ctx.currentTime) * 1000));
  }

  // ---------- VISUALS ----------
  function fitCanvas(){
    const rect = vizCanvas.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.max(320, Math.floor(rect.width * dpr));
    const h = Math.max(220, Math.floor((rect.width * 0.43) * dpr));
    if(vizCanvas.width !== w || vizCanvas.height !== h){
      vizCanvas.width = w;
      vizCanvas.height = h;
    }
  }

  function playheadT(){
    if(!audio.playing || !audio.ctx) return 0;
    const t = audio.ctx.currentTime - audio.startTime;
    return clamp(t / Math.max(0.001, audio.durationSec), 0, 1);
  }

  function renderViz(){
    fitCanvas();
    vizCtx.clearRect(0,0,vizCanvas.width,vizCanvas.height);

    if(!state.song){
      requestAnimationFrame(renderViz);
      return;
    }

    if(state.viewMode === "ring"){
      vizHintEl.textContent = "RING VIEW (SPECTRUM)";
      drawRing(state.song);
    } else {
      vizHintEl.textContent = "TRACK VIEW (LANES)";
      drawTracks(state.song);
    }
    audio.raf = requestAnimationFrame(renderViz);
  }

  function drawTracks(song){
    const ctx = vizCtx;
    const w = vizCanvas.width;
    const h = vizCanvas.height;

    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(0,0,w,h);

    const padL = Math.floor(w * 0.06);
    const padR = Math.floor(w * 0.03);
    const padT = Math.floor(h * 0.10);
    const padB = Math.floor(h * 0.10);
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;

    // grid bars
    ctx.strokeStyle = "rgba(140,255,190,0.08)";
    ctx.lineWidth = Math.max(1, Math.floor(w/900));
    ctx.beginPath();
    for(let b=0;b<=8;b++){
      const x = padL + (b/8)*innerW;
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT+innerH);
    }
    ctx.stroke();

    // 16ths
    ctx.strokeStyle = "rgba(140,255,190,0.04)";
    ctx.beginPath();
    for(let s=0;s<=32;s++){
      const x = padL + (s/32)*innerW;
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT+innerH);
    }
    ctx.stroke();

    const lanes = TRACKS
      .map(tr => ({ tr, evs: song.tracks[tr.id] || [] }))
      .filter(x => x.evs.length > 0);

    const laneGap = Math.max(6, Math.floor(h * 0.012));
    const laneH = Math.max(18, Math.floor((innerH - laneGap*(lanes.length-1)) / Math.max(1, lanes.length)));

    ctx.font = `${Math.max(10, Math.floor(h*0.04))}px ui-monospace, Menlo, Monaco, Consolas, "Courier New", monospace`;
    ctx.textBaseline = "middle";

    const xOf = (tick) => padL + (tick / LOOP_TICKS) * innerW;

    for(let i=0;i<lanes.length;i++){
      const y = padT + i*(laneH + laneGap);
      ctx.strokeStyle = "rgba(140,255,190,0.14)";
      ctx.lineWidth = 1;
      ctx.strokeRect(padL, y, innerW, laneH);

      ctx.fillStyle = "rgba(210,255,230,0.72)";
      ctx.fillText(lanes[i].tr.id, Math.max(10, padL - Math.floor(w*0.055)), y + laneH/2);

      const tr = lanes[i].tr;
      const evs = lanes[i].evs;

      if(tr.drum){
        // clip buckets
        const bucket = PPQ/2;
        const buckets = new Map();
        for(const e of evs){
          const b = Math.floor(e.t / bucket);
          buckets.set(b, (buckets.get(b) || 0) + 1);
        }
        for(const [b,count] of buckets.entries()){
          const t0 = b * bucket;
          const t1 = t0 + bucket;
          const x0 = xOf(t0), x1 = xOf(t1);
          const intensity = clamp(count / 3, 0.25, 1.0);
          ctx.fillStyle = `rgba(140,255,190,${0.08 + intensity*0.18})`;
          ctx.fillRect(x0+1, y+2, Math.max(1,(x1-x0)-2), laneH-4);
        }
      } else {
        // note blocks
        let minN=999, maxN=-999;
        for(const e of evs){ minN=Math.min(minN,e.n); maxN=Math.max(maxN,e.n); }
        if(minN===maxN){ minN-=6; maxN+=6; }
        const span = Math.max(1, maxN-minN);

        for(const e of evs){
          const x0=xOf(e.t), x1=xOf(e.t+e.d);
          const py=(e.n-minN)/span;
          const nh=Math.max(3, Math.floor(laneH*0.16));
          const yy=y+(laneH-nh)-py*(laneH-nh);
          const vel=e.v/127;
          ctx.fillStyle = vel>0.72 ? "rgba(140,255,190,0.22)" : "rgba(140,255,190,0.14)";
          ctx.fillRect(x0+1, yy, Math.max(1,(x1-x0)-2), nh);
        }
      }
    }

    // playhead
    const ph = playheadT();
    const px = padL + ph*innerW;
    ctx.strokeStyle = "rgba(190,255,220,0.55)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, padT);
    ctx.lineTo(px, padT+innerH);
    ctx.stroke();

    // header tag
    ctx.font = `${Math.max(10, Math.floor(h*0.035))}px ui-monospace, Menlo, Monaco, Consolas, "Courier New", monospace`;
    ctx.fillStyle = "rgba(210,255,230,0.65)";
    const tag = `${song.mainArtist}${song.plan.mix?" (MIX)":""} • ${song.mood} • REP:${song.plan.repWindow} MUT:${song.plan.mutationBudget}`;
    ctx.fillText(tag, padL, Math.max(12, Math.floor(h*0.06)));
  }

  function drawRing(song){
    const ctx = vizCtx;
    const w = vizCanvas.width;
    const h = vizCanvas.height;

    ctx.fillStyle = "rgba(0,0,0,0.24)";
    ctx.fillRect(0,0,w,h);

    const cx=w/2, cy=h/2;
    const radius = Math.min(w,h)*0.22;

    ctx.strokeStyle = "rgba(140,255,190,0.12)";
    ctx.lineWidth = 1;
    for(let r=1;r<=3;r++){
      ctx.beginPath();
      ctx.arc(cx,cy, radius*(0.55+r*0.18), 0, Math.PI*2);
      ctx.stroke();
    }

    const analyser = audio.analyser;
    const bins = analyser ? analyser.frequencyBinCount : 512;
    const data = new Uint8Array(bins);
    if(analyser) analyser.getByteFrequencyData(data);

    const steps = 160;
    const stepSize = Math.floor(bins/steps) || 1;

    for(let i=0;i<steps;i++){
      const idx=i*stepSize;
      const v = analyser ? data[idx]/255 : 0.12;
      const ang=(i/steps)*Math.PI*2;

      const inner=radius;
      const outer=radius + v*(Math.min(w,h)*0.16);

      const x0=cx+Math.cos(ang)*inner;
      const y0=cy+Math.sin(ang)*inner;
      const x1=cx+Math.cos(ang)*outer;
      const y1=cy+Math.sin(ang)*outer;

      ctx.strokeStyle = `rgba(140,255,190,${0.10 + v*0.55})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x0,y0);
      ctx.lineTo(x1,y1);
      ctx.stroke();
    }

    const ph=playheadT();
    const ang=ph*Math.PI*2;
    ctx.strokeStyle="rgba(190,255,220,0.55)";
    ctx.lineWidth=3;
    ctx.beginPath();
    ctx.arc(cx,cy,radius*0.78, ang, ang+0.85);
    ctx.stroke();

    ctx.font = `${Math.max(10, Math.floor(h*0.04))}px ui-monospace, Menlo, Monaco, Consolas, "Courier New", monospace`;
    ctx.fillStyle="rgba(210,255,230,0.70)";
    ctx.fillText(`${song.mainArtist} • ${song.mood} • ${song.bpm} BPM`, Math.floor(w*0.06), Math.floor(h*0.10));
  }

  // ---------- UI BUILD ----------
  function buildArtistChips(){
    artistTogglesEl.innerHTML = "";
    for(const name of ARTISTS){
      const b = document.createElement("button");
      b.className = "chip";
      b.textContent = name;
      b.dataset.artist = name;
      b.addEventListener("click", () => toggleArtist(name));
      artistTogglesEl.appendChild(b);
    }
    syncArtistUI();
  }

  function toggleArtist(name){
    const idx = state.selectedArtists.indexOf(name);
    if(idx>=0) state.selectedArtists.splice(idx,1);
    else state.selectedArtists.push(name);
    if(state.selectedArtists.length===0) state.selectedArtists = ["FAKEMINK"];
    syncArtistUI();
    updateLabels();
  }

  function syncArtistUI(){
    [...artistTogglesEl.querySelectorAll(".chip")].forEach(ch=>{
      const a = ch.dataset.artist;
      ch.classList.toggle("on", state.selectedArtists.includes(a));
    });
    artistsNowEl.textContent = `ARTISTS: ${state.selectedArtists.join(" + ")}`;
  }

  function buildMoodButtons(){
    moodRowEl.innerHTML = "";
    for(const m of MOODS){
      const b = document.createElement("button");
      b.className = "segBtn";
      b.dataset.mood = m.id;
      b.textContent = m.label;
      b.addEventListener("click", ()=>{
        state.mood = m.id;
        syncMoodUI();
        updateLabels();
      });
      moodRowEl.appendChild(b);
    }
    syncMoodUI();
  }

  function syncMoodUI(){
    [...moodRowEl.querySelectorAll(".segBtn")].forEach(b=>{
      b.classList.toggle("on", b.dataset.mood === state.mood);
    });
    moodNowEl.textContent = `MOOD: ${state.mood.replace("_"," ")}`;
  }

  function buildKeyButtons(){
    const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
    keyButtonsEl.innerHTML = "";
    names.forEach((nm,i)=>{
      const b = document.createElement("button");
      b.className="keyBtn";
      b.textContent=nm;
      b.addEventListener("click", ()=>{ state.root=i; syncKeyButtons(); updateLabels(); });
      keyButtonsEl.appendChild(b);
    });
    syncKeyButtons();
  }

  function syncKeyButtons(){
    [...keyButtonsEl.querySelectorAll(".keyBtn")].forEach((b,i)=>{
      b.classList.toggle("on", i===state.root);
    });
  }

  function syncSegUI(){
    [...document.querySelectorAll(".segBtn[data-setting]")].forEach(btn=>{
      const s=btn.dataset.setting, v=btn.dataset.value;
      btn.classList.toggle("on", String(state[s])===v);
    });
  }

  function updateLabels(){
    aiLabelEl.textContent = `AI: ${state.selectedArtists[0]} • ${state.mood.replace("_"," ")}`;
  }

  function setHidden(hidden){
    state.hidden = hidden;
    hudEl.classList.toggle("hidden", hidden);
    trackPanelEl.classList.toggle("hidden", hidden); // tracklist hidden per your request
    hideBtn.textContent = hidden ? "SHOW" : "HIDE";
  }

  function setPlayUI(playing){
    playBtn.textContent = playing ? "PAUSE" : "PLAY";
  }

  function toggleSettings(){
    settingsPanel.classList.toggle("hidden");
  }

  // ---------- GENERATE FLOW ----------
  function generate(){
    // if user spams generate, treat as "not satisfied" for current plan
    const now = Date.now();
    if(state.lastGenerateAt && (now - state.lastGenerateAt) < 1400){
      applyFeedback(-0.25); // regen-too-fast penalty
    }
    state.lastGenerateAt = now;

    stopAudio();

    state.seed = randomSeed();
    seedValueEl.textContent = String(state.seed);

    // AI plan
    const plan = planBeat(state.seed);
    state.plan = plan;

    // build song from constraints
    const song = buildSongFromPlan(plan);
    state.song = song;
    state.midiBytes = buildMidi(song);

    // UI meta
    state.bpm = plan.bpm;
    state.root = plan.root;
    state.scale = plan.scale;

    bpmNowEl.textContent = `BPM: ${song.bpm}`;
    keyNowEl.textContent = `KEY: ${noteName(song.root)} ${song.scale.toUpperCase()}`;
    artistsNowEl.textContent = `ARTISTS: ${song.artists.join(" + ")}`;
    moodNowEl.textContent = `MOOD: ${song.mood.replace("_"," ")}`;

    const planTag = `${song.mainArtist}${song.plan.mix?" (MIX)":""} • ${song.mood} • REP:${song.plan.repWindow} MUT:${song.plan.mutationBudget}${song.plan.stop?` • STOP@${song.plan.stop.bar}`:""}`;
    planLabelEl.textContent = `PLAN: ${planTag}`;

    renderTrackList(song);
    updateLabels();
  }

  function renderTrackList(song){
    trackListEl.innerHTML = "";

    const header = document.createElement("div");
    header.className="trackItem";
    header.innerHTML = `<div class="trackName">SESSION</div>
      <div class="trackMeta">${BARS} BARS • ${song.bpm} BPM • ${noteName(song.root)} ${song.scale.toUpperCase()} • ${song.mood}</div>`;
    trackListEl.appendChild(header);

    for(const tr of TRACKS){
      const evs = song.tracks[tr.id] || [];
      if(!evs.length) continue;
      const item = document.createElement("div");
      item.className="trackItem";
      item.innerHTML = `<div class="trackName">${tr.name}</div><div class="trackMeta">${evs.length} EVENTS</div>`;
      trackListEl.appendChild(item);
    }
  }

  // ---------- PLAY / DOWNLOAD ----------
  function togglePlay(){
    if(!state.song) generate();
    if(audio.playing) stopAudio();
    else playAudio(state.song);
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

  generateBtn.addEventListener("click", generate);

  playBtn.addEventListener("click", togglePlay);
  stopBtn.addEventListener("click", stopAudio);

  hideBtn.addEventListener("click", ()=> setHidden(!state.hidden));

  settingsBtn.addEventListener("click", toggleSettings);

  downloadBtn.addEventListener("click", ()=>{
    if(!state.song || !state.midiBytes) generate();
    // download is a "positive" signal
    applyFeedback(+0.5);
    downloadMidi(state.midiBytes, fileName(state.song));
  });

  likeBtn.addEventListener("click", ()=> applyFeedback(+1));
  dislikeBtn.addEventListener("click", ()=> applyFeedback(-1));

  document.addEventListener("click", (e)=>{
    const btn = e.target.closest(".segBtn[data-setting]");
    if(!btn) return;
    const s = btn.dataset.setting;
    const v = btn.dataset.value;
    state[s] = v;
    syncSegUI();
  });

  // ---------- INIT ----------
  function init(){
    state.selectedArtists = ["FAKEMINK"];
    state.mood = "DROP";
    state.viewMode = "track";
    state.keyMode = "auto";
    state.scaleMode = "auto";
    state.bpmMode = "artist";
    state.root = 9;

    buildArtistChips();
    buildMoodButtons();
    buildKeyButtons();
    syncSegUI();
    updateLabels();

    generate();
    renderViz();
    window.addEventListener("resize", ()=>fitCanvas(), {passive:true});
  }

  init();
})();
