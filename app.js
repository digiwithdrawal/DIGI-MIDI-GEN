/* DIGI MIDI-GEN v2.1
   Fixes:
   - Bass sustains (808 holds to next hit / bar end)
   - Kick/Bass rhythm uses artist groove pattern banks (not random scatter)
   - Settings: LENGTH (4/8/16) + SKETCH (loop/teaseDrop/aaba/buildDrop)
   - Like/Dislike visibly confirms + actually updates learning
   - Button clicks flash (visual confirmation)
   - Hide hides HUD + tracklist; visualizer stays; Hide/Show always visible
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
  const lenNowEl = $("#lenNow");
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

    // settings
    bars: 8,           // 4/8/16
    sketch: "loop",    // loop/teaseDrop/aaba/buildDrop
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

    lastGenerateAt: 0,
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

  function chance(rng,p){ return rng() < p; }
  function randInt(rng,a,b){ return Math.floor(lerp(a,b+1,rng())); }

  function noteName(root){
    const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
    return names[(root%12+12)%12];
  }

  function flash(el){
    el.classList.remove("flash");
    // reflow
    void el.offsetWidth;
    el.classList.add("flash");
  }

  // ---------- LEARNING STORE ----------
  const LS_KEY = "digi_midigen_ai_v21";

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
        archetypeBias: {
          DROP: 1.0, TEASE_DROP: 1.0, HIT_STOP: 1.0, FLOATY: 1.0,
          PUNCHY_LOOP: 1.0, RUSHED: 1.0, DARK: 1.0
        },
        pref: { density:0.0, stopiness:0.0, variation:0.0 },
        score: 0
      };
    }
    return brain[artist];
  }

  function applyFeedback(delta){
    if(!state.plan) return;
    const main = state.plan.mainArtist;
    const brain = loadBrain();
    const a = ensureArtistBrain(brain, main);

    const moodId = state.plan.mood;
    a.archetypeBias[moodId] = clamp((a.archetypeBias[moodId] || 1.0) + delta*0.12, 0.4, 2.2);

    a.pref.density = clamp(a.pref.density + delta * (state.plan.meta.densityHint-0.5) * 0.06, -0.3, 0.3);
    a.pref.stopiness = clamp(a.pref.stopiness + delta * (state.plan.meta.stopHint-0.5) * 0.06, -0.3, 0.3);
    a.pref.variation = clamp(a.pref.variation + delta * (state.plan.meta.variationHint-0.5) * 0.06, -0.3, 0.3);

    a.score = clamp((a.score||0) + delta, -50, 200);
    saveBrain(brain);
  }

  function feedbackUI(btn, text){
    const prev = btn.textContent;
    btn.textContent = text;
    flash(btn);
    setTimeout(()=> btn.textContent = prev, 650);
  }

  // ---------- MUSIC GRID ----------
  const PPQ = 480;
  const BEAT = PPQ;
  const SIXTEENTH = PPQ / 4;
  const BAR = PPQ * 4;

  function loopTicks(){ return state.bars * BAR; }

  // ---------- TRACKS ----------
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

  // ---------- GROOVE BANKS (THIS IS THE BIG FIX) ----------
  // 16-step patterns per bar. "x" = kick hit.
  // These are intentionally “artist-coded” behaviors: repetition + recognizable swing placements.
  const KICK_BANK = {
    "KEN CARSON": [
      "x---x--x----x---",
      "x---x---x---x---",
      "x---x--x-x--x---"
    ],
    "ESDEEKID": [
      "x-x-xx--x-x-xx--",
      "x--xxx--x--xxx--",
      "x-x-xx-xx-x-xx--"
    ],
    "FIMIGUERRERO": [
      "x--xx---x--xx---",
      "x---x-xx----x-x-",
      "x--xx--x-x--x---"
    ],
    "FAKEMINK": [
      "x---x--x---x----",
      "x--x----x--x--x-",
      "x---x-x----x-x--"
    ],
    "2HOLLIS": [
      "x-------x-------",
      "x---x-----------",
      "x-------x---x---"
    ],
    "BLADEE": [
      "x-------x-------",
      "x---------------",
      "x-----------x---"
    ],
    "FENG": [
      "x---------------",
      "x-------x-------",
      "x-----------x---"
    ]
  };

  // Hats grid feel per artist (lower = more sparse)
  const HAT_GRID = {
    "KEN CARSON": SIXTEENTH*2,
    "ESDEEKID": SIXTEENTH,
    "FIMIGUERRERO": SIXTEENTH*2,
    "FAKEMINK": SIXTEENTH*2,
    "2HOLLIS": SIXTEENTH*4,
    "BLADEE": SIXTEENTH*4,
    "FENG": SIXTEENTH*4,
  };

  // ---------- ARTIST PRIORS (structure discipline) ----------
  const ARTIST_PRIORS = {
    "KEN CARSON": { tempo:[160,185], stopBars:[4,8], stopProb:0.55, padChance:0.10, bellChance:0.18 },
    "ESDEEKID": { tempo:[168,195], stopBars:[4,8], stopProb:0.45, padChance:0.06, bellChance:0.10 },
    "FIMIGUERRERO": { tempo:[165,195], stopBars:[4,8], stopProb:0.60, padChance:0.08, bellChance:0.12 },
    "2HOLLIS": { tempo:[150,176], stopBars:[8], stopProb:0.18, padChance:0.42, bellChance:0.25 },
    "BLADEE": { tempo:[140,170], stopBars:[8], stopProb:0.12, padChance:0.55, bellChance:0.45 },
    "FENG": { tempo:[145,172], stopBars:[8], stopProb:0.22, padChance:0.50, bellChance:0.18 },
    "FAKEMINK": { tempo:[155,182], stopBars:[4,8], stopProb:0.30, padChance:0.18, bellChance:0.30 }
  };

  function blendPriors(artists){
    const main = artists[0];
    const pri = structuredClone(ARTIST_PRIORS[main] || ARTIST_PRIORS["FAKEMINK"]);
    return { main, pri, mix: artists.length>1 };
  }

  // ---------- SKETCH SECTION MAP ----------
  // returns an array of sections: {name, startBar, bars, intensity}
  function buildSketchSections(rng, sketch, bars){
    if(bars <= 4){
      return [{name:"A", startBar:0, bars, intensity:0.85}];
    }

    if(bars === 8){
      if(sketch === "teaseDrop"){
        return [
          {name:"INTRO", startBar:0, bars:2, intensity:0.35},
          {name:"DROP", startBar:2, bars:6, intensity:0.90},
        ];
      }
      if(sketch === "aaba"){
        return [
          {name:"A", startBar:0, bars:2, intensity:0.70},
          {name:"A", startBar:2, bars:2, intensity:0.75},
          {name:"B", startBar:4, bars:2, intensity:0.85},
          {name:"A", startBar:6, bars:2, intensity:0.78},
        ];
      }
      if(sketch === "buildDrop"){
        return [
          {name:"BUILD", startBar:0, bars:4, intensity:0.45},
          {name:"DROP", startBar:4, bars:4, intensity:0.92},
        ];
      }
      // loop
      return [{name:"LOOP", startBar:0, bars:8, intensity:0.82}];
    }

    // 16 bars
    if(sketch === "teaseDrop"){
      return [
        {name:"INTRO", startBar:0, bars:2, intensity:0.28},
        {name:"DROP1", startBar:2, bars:6, intensity:0.88},
        {name:"BREAK", startBar:8, bars:2, intensity:0.35},
        {name:"DROP2", startBar:10, bars:6, intensity:0.94},
      ];
    }
    if(sketch === "aaba"){
      return [
        {name:"A", startBar:0, bars:4, intensity:0.72},
        {name:"A", startBar:4, bars:4, intensity:0.76},
        {name:"B", startBar:8, bars:4, intensity:0.88},
        {name:"A", startBar:12, bars:4, intensity:0.78},
      ];
    }
    if(sketch === "buildDrop"){
      return [
        {name:"BUILD", startBar:0, bars:6, intensity:0.40},
        {name:"DROP", startBar:6, bars:6, intensity:0.92},
        {name:"OUT", startBar:12, bars:4, intensity:0.72},
      ];
    }
    // loop
    return [
      {name:"LOOP", startBar:0, bars:8, intensity:0.82},
      {name:"LOOP2", startBar:8, bars:8, intensity:0.85},
    ];
  }

  // ---------- AI PLANNER ----------
  function moodToMods(mood){
    switch(mood){
      case "FLOATY": return { densityDown:0.12, stopBoost:-0.08, padBoost:0.20, bellBoost:0.18 };
      case "DARK": return { densityDown:0.08, stopBoost:0.05, padBoost:0.14, bellBoost:-0.08 };
      case "RUSHED": return { densityUp:0.12, stopBoost:0.10 };
      case "HIT_STOP": return { stopBoost:0.15 };
      case "PUNCHY_LOOP": return { stopBoost:-0.05 };
      case "TEASE_DROP": return { };
      default: return { };
    }
  }

  function resolveScale(rng, artist, mood){
    const dark = (artist==="FENG" || mood==="DARK");
    const float = (artist==="BLADEE" || mood==="FLOATY");
    // keep it simple and stable
    if(state.scaleMode !== "auto") return state.scaleMode;
    if(dark && chance(rng,0.55)) return "harmonic";
    if(float && chance(rng,0.45)) return "natural";
    return chance(rng,0.25) ? "phrygian" : "natural";
  }

  function resolveRoot(rng, artist, mood){
    if(state.keyMode === "pick") return state.root;
    // bias
    const w = new Array(12).fill(1.0);
    if(artist==="FENG" || mood==="DARK"){ w[9]+=0.9; w[4]+=0.6; w[5]+=0.5; }
    if(artist==="KEN CARSON" || artist==="ESDEEKID" || artist==="FIMIGUERRERO"){ w[1]+=0.4; w[6]+=0.35; w[8]+=0.25; }
    const total = w.reduce((a,b)=>a+b,0);
    let r = rng()*total;
    for(let i=0;i<12;i++){ r-=w[i]; if(r<=0) return i; }
    return 0;
  }

  function planBeat(seed){
    const rng = mulberry32(seed);
    const artists = [...state.selectedArtists];
    const { main, pri, mix } = blendPriors(artists);
    const mood = state.mood;
    const mods = moodToMods(mood);

    // learning nudges
    const brain = loadBrain();
    const aBrain = ensureArtistBrain(brain, main);
    const pref = aBrain.pref || { density:0, stopiness:0, variation:0 };

    // bpm
    let bpm = Math.round(lerp(pri.tempo[0], pri.tempo[1], rng()));
    if(state.bpmMode === "fixed") bpm = clamp(parseInt(bpmFixedInput.value||"170",10), 60, 220);
    if(state.bpmMode === "manual") bpm = clamp(parseInt(bpmManualInput.value||"170",10), 60, 220);

    const scale = resolveScale(rng, main, mood);
    const root = resolveRoot(rng, main, mood);

    // sketch sections
    const sections = buildSketchSections(rng, state.sketch, state.bars);

    // stop policy
    let stopProb = clamp(pri.stopProb + (pref.stopiness*0.15) + (mods.stopBoost||0), 0.05, 0.85);
    const stopBars = pri.stopBars || [Math.min(8,state.bars)];
    const stopBarPick = stopBars[Math.floor(rng()*stopBars.length)];
    const stop = chance(rng, stopProb) ? { bar: Math.min(stopBarPick, state.bars), beats: (mood==="HIT_STOP" ? 1.0 : 0.5) } : null;

    // density curve per bar from sketch (this is the “song cognition”)
    const densityCurve = new Array(state.bars).fill(0.7);
    for(const s of sections){
      for(let i=0;i<s.bars;i++){
        const b = s.startBar + i;
        if(b>=state.bars) continue;
        const localT = s.bars<=1 ? 0 : (i/(s.bars-1));
        let d = s.intensity;
        // micro ramp inside section
        d = clamp(d + (localT*0.04) - (mods.densityDown||0) + (mods.densityUp||0) + (pref.density*0.10), 0.10, 0.98);
        densityCurve[b] = d;
      }
    }

    // layer schedule: discipline based on density + section type
    const layersByBar = densityCurve.map((d, barIdx)=>{
      const sec = sections.find(s => barIdx>=s.startBar && barIdx < s.startBar+s.bars) || sections[0];
      const introish = (sec.name==="INTRO" || sec.name==="BUILD");
      const breakish = (sec.name==="BREAK");

      let kick = d > 0.50 && !introish && !breakish;
      let snare = d > 0.35 && !breakish;
      let hats = d > 0.25 && !breakish;
      let bass = d > 0.45 && !introish && !breakish;

      let lead = d > 0.22;
      let pad = chance(rng, clamp(pri.padChance + (mods.padBoost||0), 0, 0.85)) || introish || breakish;
      let bell = chance(rng, clamp(pri.bellChance + (mods.bellBoost||0), 0, 0.85)) && !breakish;
      let text = d > 0.60 || (breakish && chance(rng,0.55));

      // artist discipline overrides
      if(main==="KEN CARSON" || main==="ESDEEKID" || main==="FIMIGUERRERO"){
        if(sec.name.startsWith("DROP") || sec.name==="DROP"){
          kick = true; snare = true; hats = true;
        }
      }
      if(main==="BLADEE"){
        if(introish){ kick = false; bass=false; hats = d>0.32; }
        pad = true; lead = true;
      }
      if(main==="2HOLLIS"){
        kick = d>0.58 && !introish;
        pad = true;
      }
      if(main==="FENG"){
        if(introish){ kick=false; bass=false; }
        hats = d>0.58;
        pad = true;
      }

      return {kick, snare, hats, bass, lead, pad, bell, text, section: sec.name};
    });

    const meta = {
      densityHint: clamp(densityCurve.reduce((a,b)=>a+b,0)/densityCurve.length, 0, 1),
      stopHint: stop ? 0.85 : 0.25,
      variationHint: 0.55 // not used heavily now
    };

    return {
      version:"v2.1",
      seed, mainArtist: main, artists, mix, mood,
      bars: state.bars,
      sketch: state.sketch,
      bpm, root, scale,
      stop,
      sections,
      densityCurve,
      layersByBar,
      meta
    };
  }

  // ---------- CONSTRAINT GENERATOR ----------
  function addNote(arr, t, d, n, v){ arr.push({t: t|0, d: Math.max(1,d|0), n: n|0, v: v|0, type:"note"}); }
  function addDrum(arr, t, d, n, v){ arr.push({t: t|0, d: Math.max(1,d|0), n: n|0, v: v|0, type:"drum"}); }

  function pickKickPattern(rng, artist){
    const bank = KICK_BANK[artist] || KICK_BANK["FAKEMINK"];
    return bank[Math.floor(rng()*bank.length)];
  }

  function stepsToTicks(pattern){
    // 16 steps -> tick offsets
    const out = [];
    for(let i=0;i<16;i++){
      if(pattern[i]==="x") out.push(i*SIXTEENTH);
    }
    return out;
  }

  function buildSongFromPlan(plan){
    const rng = mulberry32(plan.seed ^ 0xBADC0DE);
    const intervals = scaleIntervals(plan.scale);
    const rootMidi = 60 + plan.root;
    const rootBass = 36 + plan.root;

    const bars = plan.bars;
    const loop = bars * BAR;

    const tracks = { PAD:[], LEAD:[], BELL:[], BASS:[], KICK:[], SNARE:[], HATS:[], TEXT:[] };

    // snare anchor (2 & 4), with rare halftime for Feng/Dark
    const halftime = (plan.mainArtist==="FENG" && chance(rng,0.42)) || (plan.mood==="DARK" && chance(rng,0.18));
    const snareBeats = halftime ? [3] : [2,4];

    // choose a kick pattern per section (keeps cohesion)
    const sectionKick = new Map();
    for(const s of plan.sections){
      sectionKick.set(s.name, pickKickPattern(rng, plan.mainArtist));
    }

    // lead motif: stable per A section; B differs in AABA
    const motifA = makeMotif(rng, plan, intervals);
    const motifB = makeMotif(rng, plan, intervals);

    // Precompute kick offsets per bar from section pattern + mild density add-ons
    const kickOffsetsByBar = new Array(bars).fill(null).map((_,bar)=>{
      const layer = plan.layersByBar[bar];
      if(!layer.kick) return [];
      const secName = layer.section || "A";
      const pat = sectionKick.get(secName) || pickKickPattern(rng, plan.mainArtist);
      const base = stepsToTicks(pat);

      // Density add-ons, but still on 16th grid (no random mess)
      const d = plan.densityCurve[bar];
      const extra = [];
      const extraProb =
        (plan.mainArtist==="ESDEEKID"||plan.mainArtist==="FIMIGUERRERO") ? (0.22 + d*0.10)
        : (plan.mainArtist==="KEN CARSON") ? (0.14 + d*0.08)
        : 0.08;

      if(chance(rng, extraProb)){
        const cand = [SIXTEENTH*6, SIXTEENTH*10, SIXTEENTH*14];
        extra.push(cand[Math.floor(rng()*cand.length)]);
      }
      const uniq = [...new Set([...base, ...extra])].sort((a,b)=>a-b);
      return uniq;
    });

    // Build events bar by bar
    for(let bar=0; bar<bars; bar++){
      const layer = plan.layersByBar[bar];
      const density = plan.densityCurve[bar];
      const t0 = bar * BAR;

      // stop policy
      const stopHere = plan.stop && (plan.stop.bar === (bar+1));
      const stopTicks = stopHere ? Math.round(plan.stop.beats * BEAT) : 0;

      // SNARE
      if(layer.snare){
        for(const b of snareBeats){
          const tt = t0 + (b-1)*BEAT;
          if(stopHere && tt < t0+stopTicks) continue;
          addDrum(tracks.SNARE, tt, SIXTEENTH, DR.snare, 110);
          if(chance(rng,0.62)) addDrum(tracks.SNARE, tt, SIXTEENTH, DR.clap, 86);
        }
      }

      // KICK
      const kickOffsets = kickOffsetsByBar[bar] || [];
      for(const off of kickOffsets){
        const tt = t0 + off;
        if(stopHere && tt < t0+stopTicks) continue;
        addDrum(tracks.KICK, tt, SIXTEENTH, DR.kick, 120);
      }

      // HATS
      if(layer.hats){
        const grid = HAT_GRID[plan.mainArtist] || (SIXTEENTH*2);
        for(let tt=t0; tt<t0+BAR; tt+=grid){
          if(stopHere && tt < t0+stopTicks) continue;
          // space probability driven by density
          if(chance(rng, 0.10 + (1-density)*0.18)) continue;
          addDrum(tracks.HATS, tt, grid/2, DR.hatC, clamp(Math.round(70 + density*22), 55, 100));
        }
        // rolls (only for certain artists / moods)
        const rollP =
          (plan.mainArtist==="ESDEEKID"||plan.mainArtist==="FIMIGUERRERO") ? 0.55
          : (plan.mainArtist==="KEN CARSON") ? 0.42
          : 0.18;
        const moodRoll = (plan.mood==="RUSHED") ? 0.18 : 0.0;
        if(chance(rng, clamp(rollP + moodRoll + density*0.12, 0.08, 0.75))){
          const start = t0 + BAR - BEAT;
          const rate = SIXTEENTH/2;
          const len = SIXTEENTH*8;
          for(let tt=start; tt<start+len; tt+=rate){
            if(stopHere && tt < t0+stopTicks) continue;
            addDrum(tracks.HATS, tt, rate/2, DR.hatC, clamp(Math.round(74 + density*26), 60, 110));
          }
        }
      }

      // BASS (808 SUSTAIN FIX)
      if(layer.bass){
        // bass hits follow kick anchors (cohesive), sustain to next hit or bar end
        const hits = pickBassHitTimes(rng, plan, bar, kickOffsets);
        for(let i=0;i<hits.length;i++){
          const hitT = hits[i];
          const nextT = (i < hits.length-1) ? hits[i+1] : BAR;
          const dur = clamp(nextT - hitT, SIXTEENTH*6, BAR - hitT); // minimum sustain

          const deg = pickBassDegree(rng, plan);
          const baseNote = degreeToMidi(rootBass, intervals, deg, 0);

          // occasional slide approach (2 notes): short approach + long hold
          const slideProb =
            (plan.mainArtist==="ESDEEKID"||plan.mainArtist==="FIMIGUERRERO") ? 0.55 :
            (plan.mainArtist==="KEN CARSON") ? 0.38 :
            0.18;

          const tt = t0 + hitT;
          if(stopHere && tt < t0+stopTicks) continue;

          if(chance(rng, slideProb) && density>0.60 && dur >= SIXTEENTH*10){
            const approach = chance(rng,0.5) ? -5 : 7;
            addNote(tracks.BASS, tt, SIXTEENTH*4, baseNote + approach, 108);
            addNote(tracks.BASS, tt + SIXTEENTH*4, dur - SIXTEENTH*4, baseNote, 118);
          } else {
            addNote(tracks.BASS, tt, dur, baseNote, 118);
          }
        }
      }

      // PAD
      if(layer.pad){
        const chordDeg = weightedPick(rng, [{k:1,w:2.0},{k:6,w:1.2},{k:7,w:1.0},{k:4,w:0.8}]);
        const n1 = degreeToMidi(rootMidi, intervals, chordDeg, -1);
        const n5 = n1 + 7;
        const n3 = degreeToMidi(rootMidi, intervals, ((chordDeg+2-1)%7)+1, -1);
        const omitThird = (plan.mainArtist==="2HOLLIS"||plan.mainArtist==="FENG") ? true : chance(rng,0.55);
        const notes = omitThird ? [n1,n5] : [n1,n3,n5];
        const len = BAR;
        for(const n of notes) addNote(tracks.PAD, t0, len, n, clamp(Math.round(50 + density*10), 35, 70));
      }

      // BELL
      if(layer.bell && chance(rng, 0.52 + density*0.20)){
        const deg = weightedPick(rng, [{k:1,w:2.0},{k:3,w:1.2},{k:5,w:1.8},{k:7,w:1.0}]);
        const n = degreeToMidi(rootMidi, intervals, deg, 2);
        const tt = t0 + (chance(rng,0.5) ? BEAT*1.5 : BEAT*2.5);
        if(!(stopHere && tt < t0+stopTicks)){
          addNote(tracks.BELL, tt, SIXTEENTH*3, n, clamp(Math.round(70 + density*12), 55, 95));
        }
      }

      // LEAD (stable motif; AABA makes B section different)
      if(layer.lead){
        const secName = layer.section || "A";
        const motif = (secName==="B") ? motifB : motifA;
        const events = renderMotif(rng, plan, motif, intervals, rootMidi, t0, density);
        for(const e of events){
          if(stopHere && e.t < t0+stopTicks) continue;
          tracks.LEAD.push(e);
        }
      }

      // TEXTURE
      if(layer.text && chance(rng, 0.30 + density*0.40)){
        const deg = weightedPick(rng, [{k:1,w:2.0},{k:5,w:1.6},{k:7,w:1.1},{k:3,w:1.0}]);
        const n = degreeToMidi(rootMidi, intervals, deg, chance(rng,0.5)?-1:0);
        const tt = t0 + (chance(rng,0.5)?0:BEAT*2);
        if(!(stopHere && tt < t0+stopTicks)){
          addNote(tracks.TEXT, tt, BEAT, n, clamp(Math.round(30 + density*10), 18, 55));
        }
      }
    }

    // sort
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
      bars: plan.bars,
      sketch: plan.sketch,
      plan,
      tracks
    };
  }

  function weightedPick(rng, items){
    const total = items.reduce((s,it)=>s+it.w,0);
    let r = rng()*total;
    for(const it of items){
      r -= it.w;
      if(r<=0) return it.k;
    }
    return items[items.length-1].k;
  }

  function pickBassDegree(rng, plan){
    if(plan.mood==="DARK") return weightedPick(rng, [{k:1,w:2.0},{k:7,w:1.3},{k:6,w:1.1},{k:5,w:1.2}]);
    return weightedPick(rng, [{k:1,w:2.0},{k:5,w:1.6},{k:6,w:1.2},{k:7,w:0.9}]);
  }

  function pickBassHitTimes(rng, plan, bar, kickOffsets){
    // base hits anchored to kick; keep it musical
    const base = [];
    // always prefer beat 1 if kick exists
    if(kickOffsets.includes(0)) base.push(0);

    // pick another kick accent around beat 3 or end
    const candidates = kickOffsets.filter(x => x >= BEAT*2 - SIXTEENTH && x <= BEAT*3 + SIXTEENTH);
    if(candidates.length) base.push(candidates[Math.floor(rng()*candidates.length)]);

    // in aggressive artists, add a 3rd hit sometimes
    const aggressive = (plan.mainArtist==="ESDEEKID"||plan.mainArtist==="FIMIGUERRERO"||plan.mainArtist==="KEN CARSON");
    if(aggressive && chance(rng, 0.35 + plan.densityCurve[bar]*0.15)){
      const late = kickOffsets.filter(x => x >= BEAT*3 - SIXTEENTH);
      if(late.length) base.push(late[Math.floor(rng()*late.length)]);
    }

    // fallback if empty
    if(!base.length) base.push(0, BEAT*2);

    // unique & sorted & within bar
    return [...new Set(base)].filter(t=>t>=0 && t<BAR).sort((a,b)=>a-b);
  }

  function makeMotif(rng, plan, intervals){
    const count = (plan.mainArtist==="BLADEE"||plan.mainArtist==="FAKEMINK") ? randInt(rng,3,6) : randInt(rng,2,4);
    const grid = (plan.mainArtist==="ESDEEKID"||plan.mainArtist==="FIMIGUERRERO") ? SIXTEENTH*2 : SIXTEENTH*4;

    const degPool = (plan.mood==="DARK") ? [1,7,6,5,4,3,2] : [1,3,5,7,2,4,6];
    const motif = [];
    let t=0;
    for(let i=0;i<count;i++){
      const deg = degPool[randInt(rng,0,degPool.length-1)];
      const len = chance(rng,0.70) ? grid : grid*2;
      motif.push({deg,t,d:len});
      t += grid;
      if(t>=BAR) break;
    }
    return motif;
  }

  function renderMotif(rng, plan, motif, intervals, rootMidi, barStart, density){
    const out = [];
    const oct = (plan.mainArtist==="BLADEE") ? 1 : 0;
    const baseVel = (plan.mainArtist==="KEN CARSON"||plan.mainArtist==="ESDEEKID"||plan.mainArtist==="FIMIGUERRERO") ? 92 : 78;

    for(const m of motif){
      if(chance(rng, 0.16 + (1-density)*0.20)) continue;
      const n = degreeToMidi(rootMidi, intervals, m.deg, oct + (chance(rng,0.22)?1:0));
      out.push({t: barStart + m.t, d: m.d, n, v: clamp(Math.round(baseVel + density*12), 55, 118), type:"note"});
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
    const LOOP = loopTicks();

    // tempo track
    const t0 = [];
    t0.push(...vlq(0), 0xFF, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08);
    const mpqn = Math.round(60000000 / song.bpm);
    t0.push(...vlq(0), 0xFF, 0x51, 0x03, (mpqn>>>16)&255, (mpqn>>>8)&255, mpqn&255);

    const name = `DIGI MIDI-GEN v2.1 • ${song.mainArtist} • ${song.mood} • ${song.bpm} BPM • ${song.bars} bars`;
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
    return `DIGI_MIDIGEN_v21_${preset}_${song.mood}_${song.bpm}BPM_${song.bars}B_${key}_SEED${song.seed}.mid`;
  }

  // ---------- AUDIO (kept simple; MIDI feel fixed by groove now) ----------
  let audio = { ctx:null, playing:false, nodes:[], analyser:null, startTime:0, durationSec:0, raf:0 };

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

  function playAudio(song){
    // preview is basic; the groove is now carried by correct MIDI timing + note lengths
    stopAudio();
    const ctx = ensureAudio();
    if(ctx.state === "suspended") ctx.resume();

    audio.playing = true;
    setPlayUI(true);

    const start = ctx.currentTime + 0.05;
    const secondsPerBeat = 60 / song.bpm;
    const secondsPerTick = secondsPerBeat / PPQ;
    const durationSec = (loopTicks() * secondsPerTick);

    audio.startTime = start;
    audio.durationSec = durationSec;

    const master = ctx.createGain(); master.gain.value = 0.92;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.78;
    audio.analyser = analyser;

    master.connect(analyser);
    analyser.connect(ctx.destination);

    audio.nodes.push(master, analyser);

    function drumHit(t, kind, vel){
      const v = (vel/127);
      const g = ctx.createGain();
      g.connect(master);
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
        for(let i=0;i<data.length;i++) data[i] = (Math.random()*2-1);
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

    function synthNote(t, dur, midi, vel, kind){
      const freq = 440 * Math.pow(2, (midi - 69) / 12);
      const ampBase = (kind==="pad")?0.16:(kind==="bass")?0.25:0.14;
      const amp = (vel/127) * ampBase;

      const g = ctx.createGain();
      g.connect(master);
      g.gain.value = 0.0001;

      const o = ctx.createOscillator();
      o.type = (kind==="bass") ? "sine" : (kind==="pad" ? "triangle" : "square");
      o.frequency.value = freq;

      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, amp), t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.02, dur - 0.08));
      g.gain.setValueAtTime(0.0001, t + dur);

      o.connect(g);
      o.start(t);
      o.stop(t + dur + 0.03);

      audio.nodes.push(o,g);
    }

    const seconds = (ticks) => ticks * secondsPerTick;
    const tAt = (ticks) => start + seconds(ticks);

    const kindMap = { PAD:"pad", BASS:"bass", LEAD:"lead", BELL:"lead", TEXT:"pad" };

    for(const tr of TRACKS){
      const evs = song.tracks[tr.id] || [];
      for(const e of evs){
        const t = tAt(e.t);
        const dur = Math.max(0.03, seconds(e.d));
        if(tr.drum){
          if(e.n===DR.kick) drumHit(t,"kick", e.v);
          else if(e.n===DR.snare) drumHit(t,"snare", e.v);
          else drumHit(t,"snare", e.v);
        } else {
          synthNote(t, dur, e.n, e.v, kindMap[tr.id] || "lead");
        }
      }
    }

    window.setTimeout(()=>{ if(audio.playing) stopAudio(); }, Math.max(0, (start + durationSec + 0.2 - ctx.currentTime) * 1000));
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
      drawRing();
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
    const LOOP = loopTicks();

    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(0,0,w,h);

    const padL = Math.floor(w * 0.06);
    const padR = Math.floor(w * 0.03);
    const padT = Math.floor(h * 0.10);
    const padB = Math.floor(h * 0.10);
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;

    // bar grid
    ctx.strokeStyle = "rgba(140,255,190,0.08)";
    ctx.lineWidth = Math.max(1, Math.floor(w/900));
    ctx.beginPath();
    for(let b=0;b<=song.bars;b++){
      const x = padL + (b/song.bars)*innerW;
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT+innerH);
    }
    ctx.stroke();

    // 16ths grid (per 4 bars max to reduce clutter)
    ctx.strokeStyle = "rgba(140,255,190,0.04)";
    ctx.beginPath();
    const steps = song.bars * 16;
    for(let s=0;s<=steps;s++){
      if(song.bars===16 && s%2===1) continue;
      const x = padL + (s/steps)*innerW;
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

    const xOf = (tick) => padL + (tick / LOOP) * innerW;

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

    ctx.font = `${Math.max(10, Math.floor(h*0.035))}px ui-monospace, Menlo, Monaco, Consolas, "Courier New", monospace`;
    ctx.fillStyle = "rgba(210,255,230,0.65)";
    ctx.fillText(`${song.mainArtist}${song.plan.mix?" (MIX)":""} • ${song.mood} • ${song.bpm} BPM • ${song.bars}B • ${song.sketch.toUpperCase()}`, padL, Math.max(12, Math.floor(h*0.06)));
  }

  function drawRing(){
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
  }

  // ---------- UI BUILD ----------
  function buildArtistChips(){
    artistTogglesEl.innerHTML = "";
    for(const name of ARTISTS){
      const b = document.createElement("button");
      b.className = "chip";
      b.textContent = name;
      b.dataset.artist = name;
      b.addEventListener("click", () => { flash(b); toggleArtist(name); });
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
        flash(b);
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
      b.addEventListener("click", ()=>{
        flash(b);
        state.root=i;
        syncKeyButtons();
        updateLabels();
      });
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
    aiLabelEl.textContent = `AI: ${state.selectedArtists[0]} • ${state.mood.replace("_"," ")} • ${state.bars}B • ${state.sketch.toUpperCase()}`;
  }

  function setHidden(hidden){
    state.hidden = hidden;
    hudEl.classList.toggle("hidden", hidden);
    trackPanelEl.classList.toggle("hidden", hidden);
    hideBtn.textContent = hidden ? "SHOW" : "HIDE";
    flash(hideBtn);
  }

  function setPlayUI(playing){
    playBtn.textContent = playing ? "PAUSE" : "PLAY";
  }

  function toggleSettings(){
    settingsPanel.classList.toggle("hidden");
    flash(settingsBtn);
  }

  // ---------- GENERATE FLOW ----------
  function generate(){
    const now = Date.now();
    if(state.lastGenerateAt && (now - state.lastGenerateAt) < 1400){
      applyFeedback(-0.25);
    }
    state.lastGenerateAt = now;

    stopAudio();

    state.seed = randomSeed();
    seedValueEl.textContent = String(state.seed);

    const plan = planBeat(state.seed);
    state.plan = plan;

    const song = buildSongFromPlan(plan);
    state.song = song;
    state.midiBytes = buildMidi(song);

    state.bpm = plan.bpm;
    state.root = plan.root;
    state.scale = plan.scale;

    bpmNowEl.textContent = `BPM: ${song.bpm}`;
    keyNowEl.textContent = `KEY: ${noteName(song.root)} ${song.scale.toUpperCase()}`;
    lenNowEl.textContent = `LEN: ${song.bars}B`;
    artistsNowEl.textContent = `ARTISTS: ${song.artists.join(" + ")}`;
    moodNowEl.textContent = `MOOD: ${song.mood.replace("_"," ")}`;

    const planTag = `${song.mainArtist}${song.plan.mix?" (MIX)":""} • ${song.mood} • ${song.bars}B • ${song.sketch.toUpperCase()}${song.plan.stop?` • STOP@${song.plan.stop.bar}`:""}`;
    planLabelEl.textContent = `PLAN: ${planTag}`;

    renderTrackList(song);
    updateLabels();
    flash(generateBtn);
  }

  function renderTrackList(song){
    trackListEl.innerHTML = "";

    const header = document.createElement("div");
    header.className="trackItem";
    header.innerHTML = `<div class="trackName">SESSION</div>
      <div class="trackMeta">${song.bars} BARS • ${song.bpm} BPM • ${noteName(song.root)} ${song.scale.toUpperCase()} • ${song.mood} • ${song.sketch.toUpperCase()}</div>`;
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
    flash(playBtn);
  }

  // ---------- EVENTS ----------
  copySeedBtn.addEventListener("click", async () => {
    const txt = seedValueEl.textContent || "";
    flash(copySeedBtn);
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
  stopBtn.addEventListener("click", ()=>{ stopAudio(); flash(stopBtn); });

  hideBtn.addEventListener("click", ()=> setHidden(!state.hidden));
  settingsBtn.addEventListener("click", toggleSettings);

  downloadBtn.addEventListener("click", ()=>{
    if(!state.song || !state.midiBytes) generate();
    applyFeedback(+0.5);
    flash(downloadBtn);
    downloadMidi(state.midiBytes, fileName(state.song));
  });

  likeBtn.addEventListener("click", ()=>{
    applyFeedback(+1);
    feedbackUI(likeBtn, "LIKED");
  });

  dislikeBtn.addEventListener("click", ()=>{
    applyFeedback(-1);
    feedbackUI(dislikeBtn, "DISLIKED");
  });

  document.addEventListener("click", (e)=>{
    const btn = e.target.closest(".segBtn[data-setting]");
    if(!btn) return;
    const s = btn.dataset.setting;
    const v = btn.dataset.value;

    flash(btn);

    if(s === "bars") state.bars = parseInt(v,10);
    else state[s] = v;

    syncSegUI();
    updateLabels();
    // auto-regenerate so the user immediately hears the new structure
    generate();
  });

  // ---------- INIT ----------
  function init(){
    state.selectedArtists = ["FAKEMINK"];
    state.mood = "DROP";
    state.bars = 8;
    state.sketch = "loop";
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
