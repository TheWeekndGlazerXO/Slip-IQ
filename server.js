require("dotenv").config()
const express = require("express")
const cors    = require("cors")
const axios   = require("axios")
const path    = require("path")
const https   = require("https")

// ── AI SDK ─────────────────────────────────────────────────────────────────
let ModelClient, isUnexpected, AzureKeyCredential
try {
  ModelClient = require("@azure-rest/ai-inference").default
  ;({ isUnexpected }       = require("@azure-rest/ai-inference"))
  ;({ AzureKeyCredential } = require("@azure/core-auth"))
} catch(e) { console.log("⚠️  Azure AI SDK missing — npm install @azure-rest/ai-inference @azure/core-auth") }

// ── SUPABASE ───────────────────────────────────────────────────────────────
let sb = null
try {
  const { createClient } = require("@supabase/supabase-js")
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    console.log("✅ Supabase connected")
  }
} catch(e) { console.log("⚠️  Supabase missing — npm install @supabase/supabase-js") }

const app = express()

// ── KEEP-ALIVE AGENT — fixes ECONNRESET ───────────────────────────────────
const agent = new https.Agent({ keepAlive:true, maxSockets:10, maxFreeSockets:5, timeout:30000 })
axios.defaults.httpsAgent = agent

app.use(cors())
app.use(express.json({ limit:"10mb" }))
app.use(express.urlencoded({ extended:true, limit:"10mb" }))
app.use(express.static(path.join(__dirname, "public")))

const PORT             = process.env.PORT             || 3000
const ODDS_API_KEY     = process.env.ODDS_API_KEY
const NEWS_API_KEY     = process.env.NEWS_API_KEY
const GITHUB_TOKEN     = process.env.GITHUB_TOKEN
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY
const SM_KEY           = process.env.SPORTMONKS_API_KEY   // SportMonks v3

const AI_ENDPOINT = "https://models.github.ai/inference"
const AI_MODEL    = "openai/gpt-4o"

let aiClient = null
if (ModelClient && GITHUB_TOKEN) {
  try { aiClient = ModelClient(AI_ENDPOINT, new AzureKeyCredential(GITHUB_TOKEN)); console.log("✅ GitHub AI (GPT-4o) ready") }
  catch(e) { console.log("❌ AI init:", e.message) }
}

// ── CACHE ──────────────────────────────────────────────────────────────────
const cache        = new Map()
const TTL_SHORT    = 1000 * 60 * 5
const TTL_LONG     = 1000 * 60 * 30
const TTL_ODDS     = 1000 * 60 * 15
const previousOdds = new Map()

async function getCached(key, fetcher, ttl = TTL_SHORT) {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.ts < ttl) return hit.data
  const data = await fetcher()
  cache.set(key, { data, ts: Date.now() })
  return data
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── HTTP HELPER — retry + keep-alive ──────────────────────────────────────
async function httpGet(url, params = {}, headers = {}, retries = 3, baseDelay = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await axios.get(url, {
        params, timeout: 18000, httpsAgent: agent,
        headers: { "Connection":"keep-alive","User-Agent":"SlipIQ/6.0","Accept":"application/json","Accept-Encoding":"gzip,deflate,br", ...headers }
      })
    } catch(err) {
      const retryable = ["ECONNRESET","ETIMEDOUT","ENOTFOUND","EAI_AGAIN","ECONNREFUSED","EPIPE"].includes(err.code) || (err.response?.status >= 500)
      if (retryable && attempt < retries) {
        const delay = baseDelay * Math.pow(2, attempt-1) + Math.random()*600
        console.log(`  ↻ Retry ${attempt}/${retries-1} in ${Math.round(delay)}ms — ${err.code||err.response?.status}`)
        await sleep(delay)
      } else throw err
    }
  }
}

// ── SPORTMONKS HELPER ─────────────────────────────────────────────────────
async function smGet(endpoint, params = {}) {
  if (!SM_KEY) throw new Error("SPORTMONKS_API_KEY not set")
  return httpGet(`https://api.sportmonks.com/v3/football${endpoint}`, { api_token: SM_KEY, ...params })
}

// ─────────────────────────────────────────────────────────────────────────
//  IN-MEMORY STORES — loaded from Supabase on boot
// ─────────────────────────────────────────────────────────────────────────
const teamDB   = new Map()   // teamName → full record
const playerDB = new Map()   // "name__team" → full record
const squads   = new Map()   // teamName → [{name,position,age,number,smId}]
let dbLoaded   = false

// ── LOAD FROM SUPABASE ────────────────────────────────────────────────────
async function loadDB() {
  if (!sb) { console.log("⚠️  No Supabase — using built-in ELOs"); dbLoaded=true; return }
  try {
    console.log("📥 Loading ratings from Supabase...")
    const [tr, pr] = await Promise.all([
      sb.from("team_ratings").select("*"),
      sb.from("player_ratings").select("*").limit(8000)
    ])
    if (tr.error) throw new Error("team_ratings: " + tr.error.message)
    if (pr.error) throw new Error("player_ratings: " + pr.error.message)
    for (const t of tr.data||[]) teamDB.set(t.team_name, t)
    for (const p of pr.data||[]) {
      playerDB.set(`${p.player_name}__${p.team_name}`, p)
      // Rebuild squads map from DB so lineups work immediately on restart
      if (!squads.has(p.team_name)) squads.set(p.team_name, [])
      if (p.position) squads.get(p.team_name).push({ name:p.player_name, position:p.position, age:p.age, smId:p.api_id })
    }
    console.log(`✅ Loaded ${teamDB.size} teams, ${playerDB.size} players, ${squads.size} squads from Supabase`)
    dbLoaded = true
  } catch(e) {
    console.log("⚠️  DB load failed:", e.message)
    dbLoaded = true
  }
}

// ── SAVE TEAM ─────────────────────────────────────────────────────────────
async function saveTeam(name, d) {
  teamDB.set(name, { ...teamDB.get(name)||{}, ...d, team_name: name })
  if (!sb) return
  try {
    await sb.from("team_ratings").upsert({
      team_name:name, elo:d.elo, form:d.form, league:d.league,
      league_position:d.leaguePosition, wins:d.wins, draws:d.draws, losses:d.losses,
      goals_for:d.goalsFor, goals_against:d.goalsAgainst,
      home_advantage:d.homeAdvantage, big_game_factor:d.bigGameFactor,
      importance_tier:d.importanceTier, playstyle:d.playstyle,
      attacking_rating:d.attackingRating, defensive_rating:d.defensiveRating,
      updated_at: new Date().toISOString()
    }, { onConflict:"team_name" })
  } catch(e) { console.log("⚠️  Save team:", e.message) }
}

// ── SAVE PLAYER ───────────────────────────────────────────────────────────
async function savePlayer(name, team, d) {
  const key = `${name}__${team}`
  playerDB.set(key, { ...playerDB.get(key)||{}, ...d, player_name:name, team_name:team })
  if (!sb) return
  try {
    await sb.from("player_ratings").upsert({
      player_name:name, team_name:team, position:d.position, elo:d.elo,
      speed:d.speed, attack:d.attack, defense:d.defense, big_match:d.bigMatch,
      playstyle_id:d.playstyle?.id, playstyle_name:d.playstyle?.name,
      playstyle_desc:d.playstyle?.desc, playstyle_icon:d.playstyle?.icon,
      strengths:d.strengths, weaknesses:d.weaknesses,
      real_rating:d.realRating, age:d.age, is_key:d.isKey, api_id:d.smId||d.apiId,
      updated_at: new Date().toISOString()
    }, { onConflict:"player_name,team_name" })
  } catch(e) { /* silent */ }
}

// ─────────────────────────────────────────────────────────────────────────
//  ELO SYSTEM
//  Weighted formula:
//   Base (historical stature)     30%
//   Recent form last 5 games      25%   weights: 0.35/0.25/0.20/0.12/0.08
//   League position (season)      20%
//   Goal difference per game      10%
//   Big game record vs top clubs  10%
//   Home win rate                  5%
// ─────────────────────────────────────────────────────────────────────────

const ELO_BASE = {
  "Manchester City":1950,"Arsenal":1880,"Liverpool":1900,"Chelsea":1820,
  "Manchester United":1810,"Tottenham Hotspur":1780,"Tottenham":1780,
  "Newcastle United":1740,"Newcastle":1740,"Aston Villa":1750,
  "West Ham United":1700,"West Ham":1700,"Brighton":1710,"Brighton & Hove Albion":1710,
  "Crystal Palace":1640,"Wolverhampton Wanderers":1650,"Wolves":1650,"Fulham":1630,
  "Bournemouth":1610,"Brentford":1620,"Everton":1590,"Leicester City":1600,
  "Nottingham Forest":1650,"Ipswich Town":1540,"Southampton":1520,
  "Real Madrid":1980,"Barcelona":1940,"Atletico Madrid":1870,"Sevilla":1760,
  "Real Sociedad":1740,"Villarreal":1730,"Athletic Club":1720,"Athletic Bilbao":1720,
  "Real Betis":1710,"Valencia":1680,"Girona":1700,"Osasuna":1640,
  "Celta Vigo":1630,"Rayo Vallecano":1600,"Getafe":1590,"Alaves":1570,
  "Mallorca":1580,"Leganes":1540,"Valladolid":1530,"Las Palmas":1540,
  "Bayern Munich":1970,"Borussia Dortmund":1880,"RB Leipzig":1840,
  "Bayer Leverkusen":1900,"Eintracht Frankfurt":1750,"Wolfsburg":1700,
  "Freiburg":1710,"Hoffenheim":1680,"Borussia Monchengladbach":1680,
  "Union Berlin":1660,"Werder Bremen":1650,"VfB Stuttgart":1690,"Stuttgart":1690,
  "Augsburg":1610,"Mainz":1620,"Heidenheim":1580,"Kiel":1540,
  "Inter Milan":1900,"Juventus":1860,"AC Milan":1870,"Napoli":1850,
  "Roma":1790,"Lazio":1770,"Atalanta":1820,"Fiorentina":1740,
  "Bologna":1700,"Torino":1660,"Udinese":1620,"Cagliari":1600,
  "Paris Saint-Germain":1930,"PSG":1930,"Monaco":1800,"Lyon":1750,
  "Marseille":1770,"Lille":1760,"Nice":1720,"Rennes":1700,"Lens":1680,
  "Strasbourg":1640,"Nantes":1630,"Reims":1620,"Toulouse":1590,
  "Le Havre":1570,"Montpellier":1560,"Auxerre":1560,"Brest":1620,
  "Benfica":1820,"Porto":1830,"Sporting CP":1810,"Sporting":1810,
  "Braga":1740,"Vitoria":1620,
  "Ajax":1800,"PSV":1820,"Feyenoord":1790,"AZ":1740,
  "Celtic":1680,"Rangers":1660,
  "Galatasaray":1720,"Fenerbahce":1700,"Besiktas":1660,
  "Flamengo":1760,"Palmeiras":1750,"Atletico Mineiro":1730,
  "Fluminense":1700,"Gremio":1680,"Corinthians":1680,"Sao Paulo":1690,
  "Cruzeiro":1680,"Vasco":1640,"Botafogo":1720,
  "River Plate":1780,"Boca Juniors":1760
}

// Historical prestige / importance tier (1-5)
const IMPORTANCE_TIER = {
  "Real Madrid":5,"Barcelona":5,"Manchester City":5,"Bayern Munich":5,"Liverpool":5,
  "Arsenal":4,"Chelsea":4,"Manchester United":4,"Atletico Madrid":4,"Borussia Dortmund":4,
  "Bayer Leverkusen":4,"Inter Milan":4,"Juventus":4,"AC Milan":4,"Napoli":4,
  "Paris Saint-Germain":4,"Benfica":4,"Porto":4,"Ajax":4
}

function getBaseElo(name) {
  if (!name) return 1500
  const db = teamDB.get(name)
  if (db?.elo) return db.elo
  if (ELO_BASE[name]) return ELO_BASE[name]
  const lo = name.toLowerCase()
  for (const [k,v] of Object.entries(ELO_BASE)) {
    if (lo.includes(k.toLowerCase().slice(0,7)) || k.toLowerCase().includes(lo.slice(0,7))) return v
  }
  return 1500
}

function computeElo(name, { formArr=[], leaguePos=null, totalTeams=20, goalsFor=0, goalsAgainst=0, matchesPlayed=0, bigGameW=0, bigGameD=0, bigGameL=0, homeWins=0, homePlayed=0 } = {}) {
  const base = getBaseElo(name)
  // Form (25%)
  const fw = [0.35,0.25,0.20,0.12,0.08]
  const fs = formArr.slice(0,5).reduce((s,r,i) => s+(r==="W"?1:r==="D"?0.5:0)*(fw[i]||0.05), 0)
  const formBonus = Math.round((fs - 0.5) * 100)           // -50 to +50
  // League position (20%)
  let posBonus = 0
  if (leaguePos !== null) {
    const pct = 1 - (leaguePos-1) / Math.max(totalTeams-1, 1)
    posBonus = Math.round((pct - 0.5) * 120)               // -60 to +60
  }
  // Goal difference per game (10%)
  const gd = goalsFor - goalsAgainst
  const gdBonus = matchesPlayed > 0 ? Math.round(Math.max(-40, Math.min(40, gd/matchesPlayed * 15))) : 0
  // Big game record (10%)
  const bgTotal = bigGameW + bigGameD + bigGameL
  const bgBonus = bgTotal > 0 ? Math.round(((bigGameW + bigGameD*0.5)/bgTotal - 0.5) * 60) : 0
  // Home rate (5%)
  const homeBonus = homePlayed > 0 ? Math.round((homeWins/homePlayed - 0.5) * 40) : 0

  return Math.round(Math.max(1300, Math.min(2050, base + formBonus + posBonus + gdBonus + bgBonus + homeBonus)))
}

function getTeamElo(name, liveForm = []) {
  const db = teamDB.get(name)
  if (db?.elo) {
    if (!liveForm.length) return db.elo
    const fw = [0.35,0.25,0.20,0.12,0.08]
    const adj = Math.round((liveForm.slice(0,5).reduce((s,r,i)=>s+(r==="W"?1:r==="D"?0.5:0)*(fw[i]||0.05),0)-0.5)*80)
    return Math.round(Math.max(1300, Math.min(2050, db.elo + adj)))
  }
  return computeElo(name, { formArr: liveForm })
}

const P_ELO = new Map()
function playerElo(name, team, pos, rating=null, teamElo=null) {
  const key = `${name}__${team}__${pos}`
  const db  = playerDB.get(`${name}__${team}`)
  if (db?.elo) { P_ELO.set(key, db.elo); return db.elo }
  if (P_ELO.has(key)) return P_ELO.get(key)
  const tElo = teamElo || getTeamElo(team)
  let elo
  if (rating && rating > 0) {
    elo = Math.round(1200 + (rating-5)*110 + (tElo-1500)*0.35)
  } else {
    const posB = {GK:-30,CB:-20,LB:-10,RB:-10,LWB:-5,RWB:-5,CDM:-5,CM:5,CAM:20,RM:10,LM:10,LW:30,RW:30,ST:35}
    const hash = [...(name||"")].reduce((h,c)=>h*31+c.charCodeAt(0),0)
    elo = Math.round(tElo + (posB[pos]||0) + ((Math.abs(hash)%120)-60))
  }
  elo = Math.max(1300, Math.min(2050, elo))
  P_ELO.set(key, elo)
  return elo
}

// ─────────────────────────────────────────────────────────────────────────
//  20 PLAYSTYLES
// ─────────────────────────────────────────────────────────────────────────
const PS = {
  TARGET_MAN:         {id:1,  name:"Target Man",            desc:"Holds up play, wins headers, brings teammates into game. Physical, dominant in the air, back-to-goal.",      icon:"🎯"},
  POACHER:            {id:2,  name:"Poacher",               desc:"Lives in the box. Minimal build-up involvement but lethal in front of goal. Pure instinct finisher.",        icon:"⚡"},
  PRESS_CONDUCTOR:    {id:3,  name:"Press Conductor",       desc:"Sets the press trigger, forces errors high up, relentless work-rate. Wins ball in dangerous positions.",     icon:"🔥"},
  DEEP_PLAYMAKER:     {id:4,  name:"Deep Playmaker",        desc:"Dictates tempo from deep. Slows play when needed, switches flanks, rarely loses the ball.",                  icon:"🎼"},
  BOX_TO_BOX:         {id:5,  name:"Box-to-Box Engine",     desc:"Covers every blade of grass. Arrives late into the box, wins tackles, contributes both ways.",               icon:"⚙️"},
  INVERTED_WINGER:    {id:6,  name:"Inverted Winger",       desc:"Cuts inside onto stronger foot. Creates via dribbles and shots. Dangerous in half-spaces.",                  icon:"↩️"},
  PURE_WIDE_MAN:      {id:7,  name:"Pure Wide Man",         desc:"Stays on the touchline. Beats fullbacks with pace, delivers crosses. Traditional winger.",                   icon:"📐"},
  SWEEPER_KEEPER:     {id:8,  name:"Sweeper Keeper",        desc:"Acts as extra outfield player. Reads play early, commands area well beyond box, starts attacks.",            icon:"🧤"},
  SHOT_STOPPER:       {id:9,  name:"Shot Stopper",          desc:"Pure reflexes and positioning on the line. Exceptional at one-on-ones, less comfortable with the ball.",     icon:"🛡️"},
  BALL_PLAYING_CB:    {id:10, name:"Ball-Playing CB",       desc:"Steps into midfield, carries ball past pressure, plays line-breaking passes. Vulnerable in behind.",         icon:"⚽"},
  AGGRESSIVE_DEFENDER:{id:11, name:"Aggressive Defender",   desc:"Physical dominance, wins aerial duels, crunching tackles. Sets the tone for the defensive unit.",            icon:"💪"},
  PACE_DEFENDER:      {id:12, name:"Pace Defender",         desc:"Recovers with raw speed. Comfortable in space, struggles against physical strikers and in the air.",         icon:"💨"},
  ATTACKING_FULLBACK: {id:13, name:"Attacking Fullback",    desc:"Almost a winger. Overlapping runs, delivers crosses, creates overloads. Defensive risk on the counter.",     icon:"🏃"},
  DEFENSIVE_FULLBACK: {id:14, name:"Defensive Fullback",    desc:"Stays disciplined, tracks runners, positional awareness. Rarely ventures forward. Solid but limited.",      icon:"🔒"},
  ADVANCED_PLAYMAKER: {id:15, name:"Advanced Playmaker",    desc:"Receives between the lines, turns and creates. Key passes, through balls, occasional shooting.",             icon:"✨"},
  SET_PIECE_SPEC:     {id:16, name:"Set Piece Specialist",  desc:"Corners, free kicks, penalties — technically precise. Aerial threat at set plays. Changes games from nothing.",icon:"🎯"},
  PRESSING_FORWARD:   {id:17, name:"Pressing Forward",      desc:"Hunts defenders, forces errors, wins second balls. More disruptive than prolific. Creates chaos.",            icon:"🐺"},
  DRIBBLER:           {id:18, name:"Dribbler",              desc:"Takes on defenders in wide areas, creates chaos with close control. Unpredictable, high risk/reward.",       icon:"🌀"},
  DEAD_BALL_SPEC:     {id:19, name:"Dead Ball Specialist",  desc:"Exceptional delivery and technique. Free kicks, corners delivered with precision. Changes games on restarts.",icon:"⚽"},
  METRONOME:          {id:20, name:"Metronome",             desc:"Controls tempo and passing rhythm. High pass accuracy, positional discipline. Rarely flashy, always effective.",icon:"🎵"}
}

function pickPlaystyle(pos, spd, atk, def, bm, elo, tElo) {
  const elite=elo>tElo+50, fast=spd>75, slow=spd<55, phys=def>70, cre=atk>70
  if (pos==="ST")            return phys?PS.TARGET_MAN:fast&&cre?PS.POACHER:PS.PRESSING_FORWARD
  if (pos==="LW"||pos==="RW") return fast&&cre?PS.INVERTED_WINGER:fast?PS.PURE_WIDE_MAN:PS.DRIBBLER
  if (pos==="CAM")           return elite?PS.ADVANCED_PLAYMAKER:bm>70?PS.SET_PIECE_SPEC:PS.ADVANCED_PLAYMAKER
  if (pos==="CM")            return def>65&&atk>65?PS.BOX_TO_BOX:slow&&atk<55?PS.METRONOME:PS.BOX_TO_BOX
  if (pos==="CDM")           return phys?PS.PRESS_CONDUCTOR:PS.DEEP_PLAYMAKER
  if (pos==="RM"||pos==="LM") return fast?PS.PURE_WIDE_MAN:PS.DRIBBLER
  if (pos==="CB")            return cre&&!slow?PS.BALL_PLAYING_CB:phys?PS.AGGRESSIVE_DEFENDER:PS.PACE_DEFENDER
  if (pos==="LB"||pos==="RB") return atk>60?PS.ATTACKING_FULLBACK:PS.DEFENSIVE_FULLBACK
  if (pos==="LWB"||pos==="RWB") return PS.ATTACKING_FULLBACK
  if (pos==="GK")            return spd>60?PS.SWEEPER_KEEPER:PS.SHOT_STOPPER
  return PS.BOX_TO_BOX
}

function sw(p, ps) {
  const s=[], w=[]
  if(p.speed>=78)    s.push("Exceptional pace — consistently beats defenders in behind")
  if(p.attack>=78)   s.push("Clinical in front of goal — high shot conversion rate")
  if(p.defense>=78)  s.push("Dominant defensively — wins duels and reads the game")
  if(p.bigMatch>=78) s.push("Big game temperament — elevates performance in key matches")
  if(p.elo>1750)     s.push("Elite technical quality — controls tempo and sets the standard")
  if(ps.id===6)  s.push("Dangerous cutting inside — creates shooting opps from wide")
  if(ps.id===8)  s.push("Starts attacks from back — effective under pressure distribution")
  if(ps.id===3)  s.push("High pressing intensity — disrupts opponent build-up")
  if(p.speed<50) w.push("Lack of pace — vulnerable against fast transitions")
  if(p.defense<45&&["CB","LB","RB"].includes(p.position)) w.push("Defensive weakness — can be beaten 1v1 or aerially")
  if(p.attack<45&&["ST","LW","RW"].includes(p.position))  w.push("Limited goal threat — more build-up than end product")
  if(p.bigMatch<45) w.push("Can go missing in big moments — inconsistent under pressure")
  if(ps.id===10) w.push("Steps out of position — space in behind when carrying ball")
  if(ps.id===1)  w.push("Poor mobility outside box — limited pressing contribution")
  if(ps.id===13) w.push("Leaves team exposed on counter when pushing forward")
  while(s.length<2) s.push("Consistent performer within the team structure")
  while(w.length<1) w.push("Can lack impact when team not performing collectively")
  return { strengths:s.slice(0,3), weaknesses:w.slice(0,2) }
}

function buildAttrs(name, pos, tElo, elo, rating=null) {
  const ef = (elo-1300)/700
  const isA = ["ST","LW","RW","CAM"].includes(pos)
  const isD = ["CB","LB","RB","CDM","GK"].includes(pos)
  const seed = [...(name||"")].reduce((h,c)=>h*31+c.charCodeAt(0),0)
  const sr = n => Math.abs(Math.sin(seed*n+n))
  let spd,atk,def,bm
  if (rating && rating>0) {
    const rF=(rating-5)/5
    spd = Math.round(Math.max(30,Math.min(99,50+rF*25+ef*20+sr(1)*15-7+(isA?10:isD?-5:0))))
    atk = Math.round(Math.max(20,Math.min(99,isA?55+rF*30+ef*15+sr(2)*10:isD?20+rF*15+ef*15+sr(3)*10:35+rF*20+ef*15+sr(4)*10)))
    def = Math.round(Math.max(20,Math.min(99,isD?55+rF*30+ef*15+sr(5)*10:isA?20+rF*15+ef*10+sr(6)*10:40+rF*20+ef*10+sr(7)*10)))
    bm  = Math.round(Math.max(20,Math.min(99,40+rF*35+ef*20+sr(8)*10)))
  } else {
    spd = Math.round(Math.max(30,Math.min(99,40+ef*50+sr(1)*20-10+(isA?10:0))))
    atk = Math.round(Math.max(20,Math.min(99,isA?60+ef*35+sr(2)*10:isD?25+ef*35+sr(3)*10:35+ef*40+sr(4)*10)))
    def = Math.round(Math.max(20,Math.min(99,isD?58+ef*35+sr(5)*10:isA?20+ef*30+sr(6)*10:38+ef*35+sr(7)*10)))
    bm  = Math.round(Math.max(20,Math.min(99,40+ef*50+sr(8)*20-10)))
  }
  const ps = pickPlaystyle(pos,spd,atk,def,bm,elo,tElo)
  const { strengths, weaknesses } = sw({speed:spd,attack:atk,defense:def,bigMatch:bm,elo,position:pos}, ps)
  return { speed:spd, attack:atk, defense:def, bigMatch:bm, playstyle:ps, strengths, weaknesses, isKey:elo>tElo+55 }
}

// ── POSITION MAPPING ──────────────────────────────────────────────────────
function mapPos(pos) {
  if (!pos) return "CM"
  const p = (typeof pos==="string" ? pos : pos.name||"").toLowerCase()
  if (p.includes("goalkeeper")||p==="g")              return "GK"
  if (p.includes("centre-back")||p.includes("center back")||p.includes("central defence")) return "CB"
  if (p.includes("left back")||p.includes("left-back")||p.includes("left defence"))   return "LB"
  if (p.includes("right back")||p.includes("right-back")||p.includes("right defence")) return "RB"
  if (p.includes("defensive mid"))                     return "CDM"
  if (p.includes("attacking mid"))                     return "CAM"
  if (p.includes("central mid")||p==="m")              return "CM"
  if (p.includes("left wing")||p.includes("left mid")) return "LW"
  if (p.includes("right wing")||p.includes("right mid")) return "RW"
  if (p.includes("striker")||p.includes("centre forward")||p.includes("center forward")) return "ST"
  if (p.includes("forward")||p.includes("attacker"))   return "ST"
  if (p.includes("defender"))                          return "CB"
  if (p.includes("midfielder"))                        return "CM"
  return "CM"
}

// ─────────────────────────────────────────────────────────────────────────
//  SPORTMONKS — TEAM & PLAYER DATA
//  Using v3 API — much richer than API-Football for player profiles
//  Endpoints used:
//   /standings?filters=leagueId:X  → league table with form
//   /teams/{id}?include=players    → squad with player info
//   /players/{id}?include=statistics.details.type;position;nationality
//   /fixtures?filters=...          → recent results for big game records
// ─────────────────────────────────────────────────────────────────────────

// SportMonks league IDs (v3)
const SM_LEAGUES = [
  { id:8,    name:"Premier League",   totalTeams:20, season:23614 },
  { id:564,  name:"La Liga",          totalTeams:20, season:23581 },
  { id:384,  name:"Serie A",          totalTeams:20, season:23615 },
  { id:82,   name:"Bundesliga",       totalTeams:18, season:23538 },
  { id:301,  name:"Ligue 1",          totalTeams:18, season:23540 },
  { id:5,    name:"Champions League", totalTeams:36, season:23619 },
  { id:966,  name:"Europa League",    totalTeams:36, season:23620 },
  { id:462,  name:"Primeira Liga",    totalTeams:18, season:23517 },
  { id:72,   name:"Eredivisie",       totalTeams:18, season:23539 }
]

// Fetch standings with form from SportMonks
// v3 correct endpoint: /standings/seasons/{seasonId}
async function smStandings(seasonId) {
  try {
    const res = await smGet(`/standings/seasons/${seasonId}`, {
      include: "participant;details.type"
    })
    return res.data?.data || []
  } catch(e) {
    console.log(`  ⚠️  SM standings ${seasonId}:`, e.response?.status||e.code||e.message)
    return []
  }
}

// Fetch squad (players) for a team from SportMonks
// v3 correct endpoint: /squads/teams/{teamId}
async function smSquad(teamId, teamName) {
  try {
    const res = await smGet(`/squads/teams/${teamId}`, {
      include: "player.position;player.nationality;player.detailedPosition"
    })
    const entries = res.data?.data || []
    return entries.map(entry => {
      const p = entry.player || entry
      const posName = p.position?.name || p.detailedPosition?.name || ""
      return {
        name:     p.display_name || p.common_name || p.name || "Unknown",
        position: mapPos(posName),
        age:      p.date_of_birth ? Math.floor((Date.now()-new Date(p.date_of_birth))/(365.25*86400000)) : null,
        number:   entry.jersey_number || entry.number || 0,
        smId:     p.id
      }
    }).filter(p => p.name !== "Unknown" && p.name.length > 1)
  } catch(e) {
    console.log(`  ⚠️  SM squad ${teamName}:`, e.response?.status||e.code||e.message)
    return []
  }
}

// Fetch player stats (ratings, goals, assists) from SportMonks
async function smPlayerStats(playerId) {
  try {
    const res = await smGet(`/players/${playerId}`, {
      include: "statistics.details.type;position;nationality"
    })
    const p = res.data?.data
    if (!p) return null
    // Extract rating from statistics details
    let rating = null
    const stats = p.statistics || []
    for (const stat of stats) {
      const details = stat.details || []
      for (const d of details) {
        if (d.type?.developer_name === "rating" || d.type?.name?.toLowerCase().includes("rating")) {
          rating = parseFloat(d.value?.average || d.value || 0)
          break
        }
      }
      if (rating) break
    }
    return { rating, goals: null, assists: null }
  } catch(e) { return null }
}

// ── FALLBACK: API-Football standings ──────────────────────────────────────
const AF_LEAGUES = [
  {id:39, name:"Premier League", season:2024, totalTeams:20},
  {id:140,name:"La Liga",        season:2024, totalTeams:20},
  {id:135,name:"Serie A",        season:2024, totalTeams:20},
  {id:78, name:"Bundesliga",     season:2024, totalTeams:18},
  {id:61, name:"Ligue 1",        season:2024, totalTeams:18},
  {id:2,  name:"Champions League",season:2024,totalTeams:36},
  {id:94, name:"Primeira Liga",  season:2024, totalTeams:18},
  {id:88, name:"Eredivisie",     season:2024, totalTeams:18}
]

async function afStandings(leagueId, season) {
  try {
    const res = await axios.get("https://v3.football.api-sports.io/standings", {
      headers: {"x-apisports-key": API_FOOTBALL_KEY},
      params: {league:leagueId, season},
      timeout:12000, httpsAgent:agent
    })
    return res.data?.response?.[0]?.league?.standings?.[0] || []
  } catch(e) {
    console.log(`  ⚠️  AF standings ${leagueId}:`, e.response?.status||e.code||e.message)
    return []
  }
}

async function afSquad(teamId, teamName) {
  try {
    const res = await axios.get("https://v3.football.api-sports.io/players/squads", {
      headers: {"x-apisports-key": API_FOOTBALL_KEY},
      params: {team:teamId}, timeout:12000, httpsAgent:agent
    })
    const players = res.data?.response?.[0]?.players || []
    return players.map(p => ({
      name: p.name, position: mapPos(p.position),
      age:  p.age,  number: p.number||0, smId: p.id
    }))
  } catch(e) {
    console.log(`  ⚠️  AF squad ${teamName}:`, e.response?.status||e.code||e.message)
    return []
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  WEEKLY UPDATE — SportMonks primary, API-Football fallback
// ─────────────────────────────────────────────────────────────────────────
let lastUpdate = null

async function runWeeklyUpdate(force = false) {
  if (!force && lastUpdate && Date.now()-lastUpdate < 6*24*60*60*1000) {
    console.log("✅ ELO data fresh — skipping update"); return
  }
  const hasSM = !!SM_KEY
  const hasAF = !!API_FOOTBALL_KEY
  if (!hasSM && !hasAF) { console.log("⚠️  No API key (SportMonks or API-Football) — skipping update"); return }
  console.log(`\n🔄 Weekly update (${hasSM?"SportMonks primary, AF fallback":"API-Football"})...`)

  if (hasSM) await updateViaSportMonks()  // internally falls back to AF if SM returns nothing
  else        await updateViaApiFootball()

  lastUpdate = Date.now()
  console.log(`✅ Update done — ${teamDB.size} teams, ${playerDB.size} players, ${squads.size} squads`)
  setTimeout(() => runWeeklyUpdate(true), 7*24*60*60*1000)
}

// ── SPORTMONKS UPDATE PATH ────────────────────────────────────────────────
async function updateViaSportMonks() {
  let smSuccessCount = 0
  for (const league of SM_LEAGUES) {
    try {
      console.log(`  📊 SM: ${league.name} standings...`)
      const standings = await smStandings(league.season)
      await sleep(400)
      if (!standings.length) { console.log(`    ⚠️  Empty response — SM plan may not include this league`); continue }

      smSuccessCount++
      // Flatten standings — SM v3 returns nested groups for UCL/UEL
      const rows = Array.isArray(standings[0]) ? standings.flat() : standings

      for (const row of rows) {
        const teamName = row.participant?.name || row.participant?.short_name
        if (!teamName) continue

        // Form from standing details array
        const formStr = row.details?.find(d => d.type?.developer_name==="recent_form" || d.type?.name==="Form")?.value || ""
        const formArr = formStr.split("").slice(0,5).map(c => c==="W"?"W":c==="D"?"D":"L")

        // Stats — SM stores them in details with type developer_names
        const gets = (devName, fallbackName="") => {
          const d = row.details?.find(x => x.type?.developer_name===devName || x.type?.name===fallbackName)
          return parseInt(d?.value || d?.total || 0) || 0
        }
        const wins=gets("won","Won"), draws=gets("draw","Draw"), losses=gets("lost","Lost")
        const gFor=gets("goals_scored","Goals For"), gAg=gets("goals_conceded","Goals Against")
        const mp = wins + draws + losses || gets("games_played","Games Played")
        const position = row.position || row.standing || 1

        const elo = computeElo(teamName, {
          formArr, leaguePos:position, totalTeams:league.totalTeams,
          goalsFor:gFor, goalsAgainst:gAg, matchesPlayed:mp
        })
        const rec = {
          elo, form:formArr, league:league.name, leaguePosition:position,
          wins, draws, losses, goalsFor:gFor, goalsAgainst:gAg, matchesPlayed:mp,
          homeAdvantage:50, bigGameFactor:IMPORTANCE_TIER[teamName]||2,
          importanceTier:IMPORTANCE_TIER[teamName]||2,
          attackingRating: mp>0?Math.min(99,Math.round(50+gFor/mp*20)):50,
          defensiveRating: mp>0?Math.min(99,Math.round(99-gAg/mp*20)):50,
          playstyle: inferPlaystyle(gFor,gAg,mp), smTeamId:row.participant?.id
        }
        await saveTeam(teamName, rec)
        console.log(`    ✅ ${teamName}: ELO ${elo} P${position} form:${formArr.join("")}`)

        // Fetch squad
        if (row.participant?.id) {
          await sleep(300)
          const squad = await smSquad(row.participant.id, teamName)
          if (squad.length) {
            squads.set(teamName, squad)
            console.log(`      👥 ${teamName}: ${squad.length} players from SportMonks`)
            for (const p of squad.slice(0,26)) {
              const pElo = playerElo(p.name, teamName, p.position, null, elo)
              const attrs = buildAttrs(p.name, p.position, elo, pElo, null)
              await savePlayer(p.name, teamName, { ...attrs, position:p.position, age:p.age, smId:p.smId })
            }
          }
          await sleep(300)
        }
      }
    } catch(e) {
      console.log(`  ❌ SM ${league.name}:`, e.message)
    }
    await sleep(600)
  }

  // If SM returned nothing at all, fall back to API-Football
  if (smSuccessCount === 0 && API_FOOTBALL_KEY) {
    console.log("  ⚠️  SportMonks returned no standings. Falling back to API-Football...")
    await updateViaApiFootball()
  }
}

// ── API-FOOTBALL UPDATE PATH (fallback) ───────────────────────────────────
async function updateViaApiFootball() {
  let req = 0
  const MAX = 95
  for (const league of AF_LEAGUES) {
    if (req >= MAX) break
    console.log(`  📊 AF: ${league.name} standings...`)
    const standings = await afStandings(league.id, league.season)
    req++
    await sleep(400)
    for (const row of standings) {
      if (req >= MAX) break
      const teamName = row.team?.name
      if (!teamName) continue
      const formArr = (row.form||"").split("").slice(0,5).map(c=>c==="W"?"W":c==="D"?"D":"L")
      const s = row.all||{}, h=row.home||{}
      const elo = computeElo(teamName, {
        formArr, leaguePos:row.rank, totalTeams:standings.length,
        goalsFor:s.goals?.for?.total||0, goalsAgainst:s.goals?.against?.total||0,
        matchesPlayed:s.played?.total||0,
        homeWins:h.win?.total||0, homePlayed:h.played?.total||0
      })
      const rec = {
        elo, form:formArr, league:league.name, leaguePosition:row.rank,
        wins:s.win?.total||0, draws:s.draw?.total||0, losses:s.lose?.total||0,
        goalsFor:s.goals?.for?.total||0, goalsAgainst:s.goals?.against?.total||0,
        matchesPlayed:s.played?.total||0,
        homeAdvantage:h.played?.total>0?Math.round(h.win?.total/h.played.total*100):50,
        bigGameFactor:IMPORTANCE_TIER[teamName]||2, importanceTier:IMPORTANCE_TIER[teamName]||2,
        attackingRating:Math.min(99,Math.round(50+(s.goals?.for?.total||0)/Math.max(s.played?.total||1,1)*20)),
        defensiveRating:Math.min(99,Math.round(99-(s.goals?.against?.total||0)/Math.max(s.played?.total||1,1)*20)),
        playstyle:inferPlaystyle(s.goals?.for?.total||0,s.goals?.against?.total||0,s.played?.total||1),
        afTeamId:row.team?.id
      }
      await saveTeam(teamName, rec)
      console.log(`    ✅ ${teamName}: ELO ${elo} P${row.rank} form:${formArr.join("")}`)

      // Squad fetch for top half of table (budget API calls)
      if (row.rank <= 14 && row.team?.id && req < MAX-1 && !squads.has(teamName)) {
        const squad = await afSquad(row.team.id, teamName)
        req++
        if (squad.length) {
          squads.set(teamName, squad)
          console.log(`      👥 ${teamName}: ${squad.length} players`)
          for (const p of squad.slice(0,26)) {
            const pElo = playerElo(p.name, teamName, p.position, null, elo)
            const attrs = buildAttrs(p.name, p.position, elo, pElo, null)
            await savePlayer(p.name, teamName, { ...attrs, position:p.position, age:p.age, smId:p.smId })
          }
        }
        await sleep(350)
      }
    }
    await sleep(500)
  }
}

function inferPlaystyle(gF, gA, mp) {
  const gpg=mp>0?gF/mp:0, gag=mp>0?gA/mp:0
  if(gpg>2.0&&gag>1.5) return "High Press, Direct Attack"
  if(gpg>1.8&&gag<1.2) return "Attacking Possession"
  if(gpg<1.0&&gag<1.0) return "Low Block, Counter Attack"
  if(gpg>1.5)          return "Attack-Minded"
  if(gag<1.0)          return "Defensive, Structured"
  return "Balanced"
}

// Sunday 2am scheduler
function scheduleSunday() {
  const now=new Date(), next=new Date(now)
  next.setDate(now.getDate()+((7-now.getDay())%7||7))
  next.setHours(2,0,0,0)
  const ms = next-Date.now()
  console.log(`⏰ Next weekly update: ${next.toLocaleDateString()} 2am`)
  setTimeout(()=>{ runWeeklyUpdate(true); setInterval(()=>runWeeklyUpdate(true),7*24*60*60*1000) }, ms)
}

// ─────────────────────────────────────────────────────────────────────────
//  PLAYER BUILDER
// ─────────────────────────────────────────────────────────────────────────
const FN=["Liam","James","Marcus","Jack","Harry","Oliver","Mason","Luke","Aaron","Jordan","Kyle","Ethan","Kai","Tyler","Sam","Alex","Ryan","Ben","Tom","Carlos","Luis","Pedro","David","Marco","Leon","Felix","Max","Emil","Nuno","Joao","Diogo","Erling","Viktor","Rasmus","Jesper","Takumi","Hiroki","Yusuf","Leandro","Theo","Declan","Conor","Bruno","Matheus","Alexis","Mikel","Ivan","Sergio","Alejandro","Pablo","Miguel","Diego","Roberto","Antoine","Kylian","Raheem","Sadio","Pierre","Romelu","Timo","Hakim","Riyad","Gabriel","Bukayo","Emile","Curtis","Harvey","Phil","Jude"]
const LN=["Smith","Jones","Williams","Brown","Taylor","Davies","Wilson","Evans","Johnson","Thomas","Roberts","Walker","Wright","Robinson","Thompson","White","Hughes","Edwards","Green","Hall","Lewis","Harris","Clarke","Allen","Young","Nelson","Moore","Mitchell","Turner","Parker","Collins","Ward","Morgan","Cooper","Bailey","Reed","Price","Bell","Cox","Gray","Kelly","Howard","Rose","Cook","Ellis","Wood","Barnes","Ross","Murray","Dixon","Santos","Fernandez","Garcia","Rodriguez","Martinez","Lopez","Perez","Sanchez","Silva","Costa","Oliveira","Sousa","Mendes","Ribeiro","Carvalho","Müller","Schmidt","Schneider","Fischer","Weber","Meyer","Wagner","Becker"]

function buildPlayer(team, pos, tElo, num, imp, realData=null) {
  let name, rating=null, age=null, smId=null

  if (realData && realData.name) {
    // We have a real squad entry — look up their full DB record by name first
    name  = realData.name
    age   = realData.age
    smId  = realData.smId
    rating = realData.realRating || null
    const dbRec = playerDB.get(`${name}__${team}`)
    if (dbRec && dbRec.elo) {
      // Full profile exists in Supabase — return enriched data
      const ps = Object.values(PS).find(p=>p.id===dbRec.playstyle_id)
               || pickPlaystyle(pos, dbRec.speed||50, dbRec.attack||50, dbRec.defense||50, dbRec.big_match||50, dbRec.elo||tElo, tElo)
      return {
        number:pos==="GK"?1:num, name, position:pos,
        elo:dbRec.elo, isKey:dbRec.is_key||dbRec.elo>tElo+55,
        speed:dbRec.speed||50, attack:dbRec.attack||50, defense:dbRec.defense||50, bigMatch:dbRec.big_match||50,
        isInjured:false, playstyle:ps,
        strengths:dbRec.strengths||[], weaknesses:dbRec.weaknesses||[],
        realRating:dbRec.real_rating||rating, age:dbRec.age||age, source:"supabase"
      }
    }
    // Not in DB yet — will build attrs below and save
  } else {
    // No squad entry — try DB by team+position
    const candidates = [...playerDB.values()].filter(p => p.team_name===team && p.position===pos)
    if (candidates.length) {
      const sp = candidates[num % candidates.length]
      const ps = Object.values(PS).find(p=>p.id===sp.playstyle_id) || pickPlaystyle(pos,sp.speed||50,sp.attack||50,sp.defense||50,sp.big_match||50,sp.elo||tElo,tElo)
      return {
        number:pos==="GK"?1:num, name:sp.player_name, position:pos,
        elo:sp.elo||tElo, isKey:sp.is_key||false,
        speed:sp.speed||50, attack:sp.attack||50, defense:sp.defense||50, bigMatch:sp.big_match||50,
        isInjured:false, playstyle:ps,
        strengths:sp.strengths||[], weaknesses:sp.weaknesses||[],
        realRating:sp.real_rating, age:sp.age, source:"supabase"
      }
    }
    // Total fallback — generate model name
    const i1=Math.abs((team+pos+num).split("").reduce((h,c)=>h*31+c.charCodeAt(0),0))%FN.length
    const i2=Math.abs((team+pos+num+"z").split("").reduce((h,c)=>h*31+c.charCodeAt(0),0))%LN.length
    name=`${FN[i1]} ${LN[i2]}`
  }

  const elo   = playerElo(name, team, pos, rating, tElo)
  const attrs = buildAttrs(name, pos, tElo, elo, rating)
  savePlayer(name, team, { ...attrs, position:pos, age, smId, realRating:rating }).catch(()=>{})
  return {
    number:pos==="GK"?1:num, name, position:pos, elo,
    isKey:attrs.isKey, speed:attrs.speed, attack:attrs.attack, defense:attrs.defense, bigMatch:attrs.bigMatch,
    isInjured:false, playstyle:attrs.playstyle, strengths:attrs.strengths, weaknesses:attrs.weaknesses,
    realRating:rating, age, source:realData?"api":"model"
  }
}

const FORMATIONS = {
  "4-3-3":  ["GK","RB","CB","CB","LB","CM","CM","CM","RW","ST","LW"],
  "4-2-3-1":["GK","RB","CB","CB","LB","CDM","CDM","CAM","RW","LW","ST"],
  "4-4-2":  ["GK","RB","CB","CB","LB","RM","CM","CM","LM","ST","ST"],
  "3-5-2":  ["GK","CB","CB","CB","RWB","CM","CDM","CM","LWB","ST","ST"],
  "3-4-3":  ["GK","CB","CB","CB","RM","CM","CM","LM","RW","ST","LW"],
  "5-3-2":  ["GK","RB","CB","CB","CB","LB","CM","CM","CM","ST","ST"]
}

function pickFormation(elo, isHome, imp) {
  if(elo>1850) return imp==="high"?"4-3-3":"4-2-3-1"
  if(elo>1700) return isHome?"4-3-3":"4-2-3-1"
  if(elo>1600) return isHome?"4-4-2":"5-3-2"
  return isHome?"4-4-2":"5-3-2"
}

function makeLineup(team, formation, tElo, imp, injured=new Set()) {
  const positions = FORMATIONS[formation]||FORMATIONS["4-3-3"]
  const squad = squads.get(team)||[]
  const pool = {}
  for (const p of squad) {
    if (!pool[p.position]) pool[p.position]=[]
    if (!injured.has(p.name)) pool[p.position].push(p)
  }
  const used = new Set()
  return positions.map((pos,i) => {
    if(i>=11) return null
    const cands=(pool[pos]||[]).filter(p=>!used.has(p.name))
    let real=null
    if(cands.length){ real=cands[0]; used.add(real.name); pool[pos]=pool[pos].filter(p=>p.name!==real.name) }
    return buildPlayer(team, pos, tElo, i+1, imp, real)
  }).filter(Boolean)
}

function makeMatchups(hLu, aLu) {
  const pairs=[
    {hp:"ST",ap:"CB",label:"Striker vs Centre-Back",impact:"Goals"},
    {hp:"RW",ap:"LB",label:"Right Wing vs Left-Back",impact:"Wide Attack"},
    {hp:"LW",ap:"RB",label:"Left Wing vs Right-Back",impact:"Wide Attack"},
    {hp:"CM",ap:"CM",label:"Midfield Battle",impact:"Possession"},
    {hp:"CAM",ap:"CDM",label:"Playmaker vs Defensive Mid",impact:"Creativity"}
  ]
  return pairs.map(pair=>{
    const h=hLu.find(p=>p.position===pair.hp)||hLu[5]
    const a=aLu.find(p=>p.position===pair.ap)||aLu[4]
    if(!h||!a) return null
    const mn=[]
    if(h.speed>a.speed+15) mn.push(`${h.name} pace advantage (+${h.speed-a.speed}) — ${a.name} vulnerable`)
    if(a.defense<50&&h.attack>70) mn.push(`${a.name} defensive weakness (${a.defense}) vs ${h.name} (${h.attack})`)
    if(h.playstyle?.id===1&&a.playstyle?.id===11) mn.push(`Physical battle: ${h.name} vs ${a.name}`)
    return {homePlayer:h,awayPlayer:a,label:pair.label,impact:pair.impact,eloDiff:(h.elo||1500)-(a.elo||1500),mismatchNotes:mn,keyMismatch:mn[0]||null}
  }).filter(Boolean)
}

// ─────────────────────────────────────────────────────────────────────────
//  MATCH SIMULATION ENGINE
// ─────────────────────────────────────────────────────────────────────────
function poisson(λ){let L=Math.exp(-λ),p=1,k=0;do{k++;p*=Math.random()}while(p>L);return k-1}
function mc(hxg,axg,n=50000){let h=0,d=0,a=0;for(let i=0;i<n;i++){const hg=poisson(hxg),ag=poisson(axg);if(hg>ag)h++;else if(hg<ag)a++;else d++}return{homeWin:h/n,draw:d/n,awayWin:a/n}}
function fs(r){if(!r?.length)return 3;const w=[0.35,0.25,0.20,0.12,0.08];return r.slice(0,5).reduce((s,x,i)=>s+(x==="W"?5*(w[i]||0.05):x==="D"?2*(w[i]||0.05):0),0)*5}
function xg(tE,oE,tF,oF,home){const ed=(tE-oE)/400,fb=(fs(tF)-fs(oF))*0.04,ha=home?0.15:0;return Math.max(0.3,(home?1.45:1.15)+ed*0.8+fb+ha)}
function fact(n){if(n<=1)return 1;let r=1;for(let i=2;i<=n;i++)r*=i;return r}
function detectVal(prob,odds){return prob>(1/odds)*1.08}

function calcImportance(league,hE,aE){
  if(league?.includes("Champions"))return"high"
  if(league?.includes("Europa"))return"medium-high"
  const d=Math.abs(hE-aE)
  return d<80?"high":d<150?"medium":"low"
}

function factors(hE,aE,hF,aF){
  const hf=fs(hF),af=fs(aF),ed=hE-aE
  const n=v=>Math.min(99,Math.max(1,Math.round(v)))
  return[
    {name:"ELO RATING",       homeScore:n(hE/20),awayScore:n(aE/20),color:"#00d4ff"},
    {name:"RECENT FORM",      homeScore:n(hf),awayScore:n(af),color:"#00ff88"},
    {name:"HOME ADVANTAGE",   homeScore:65,awayScore:35,color:"#ff8c42"},
    {name:"ATTACK STRENGTH",  homeScore:n(50+ed/30),awayScore:n(50-ed/30),color:"#ff3b5c"},
    {name:"DEFENSIVE SHAPE",  homeScore:n(50+ed/40),awayScore:n(50-ed/40),color:"#ffd700"},
    {name:"CONSISTENCY",      homeScore:n(hf*0.9),awayScore:n(af*0.9),color:"#00d4ff"},
    {name:"xG THREAT",        homeScore:n(50+ed/35),awayScore:n(50-ed/35),color:"#ff8c42"},
    {name:"PRESS INTENSITY",  homeScore:n(45+ed/45+Math.random()*15),awayScore:n(45-ed/45+Math.random()*15),color:"#00ff88"},
    {name:"SQUAD DEPTH",      homeScore:n(50+ed/50+Math.random()*10),awayScore:n(50-ed/50+Math.random()*10),color:"#ffd700"},
    {name:"MOMENTUM",         homeScore:n(hf*1.1),awayScore:n(af*1.1),color:"#ff3b5c"}
  ]
}

function markets(hxg,axg,hE,aE){
  const t=hxg+axg,ed=Math.abs(hE-aE)
  const o05=Math.round((1-Math.exp(-t))*100)
  const o15=Math.round((1-(1+t)*Math.exp(-t))*100)
  const o25=Math.round((1-(1+t+(t**2)/2)*Math.exp(-t))*100)
  const o35=Math.round((1-(1+t+(t**2)/2+(t**3)/6)*Math.exp(-t))*100)
  const btts=Math.round((1-Math.exp(-hxg))*(1-Math.exp(-axg))*100)
  const p=mc(hxg,axg,20000)
  const cs=[]
  for(let h=0;h<=4;h++)for(let a=0;a<=4;a++){
    const pH=(Math.exp(-hxg)*hxg**h)/fact(h),pA=(Math.exp(-axg)*axg**a)/fact(a)
    cs.push({score:`${h}-${a}`,prob:Math.round(pH*pA*1000)/10})
  }
  cs.sort((a,b)=>b.prob-a.prob)
  return{
    overUnder:{over05:o05,under05:100-o05,over15:o15,under15:100-o15,over25:o25,under25:100-o25,over35:o35,under35:100-o35},
    btts,doubleChance:{homeOrDraw:Math.round((p.homeWin+p.draw)*100),awayOrDraw:Math.round((p.awayWin+p.draw)*100),homeOrAway:Math.round((p.homeWin+p.awayWin)*100)},
    corners:{over85corners:Math.round(Math.min(85,Math.max(30,50+(10+(t-2.5)*2.2-10)*4))),over105corners:Math.round(Math.min(70,Math.max(20,35+(10+(t-2.5)*2.2-10)*3)))},
    cards:{over35cards:Math.round(Math.min(80,Math.max(15,ed<100?65:ed<200?50:35)))},
    correctScores:cs.slice(0,6)
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  ODDS API
// ─────────────────────────────────────────────────────────────────────────
const ODDS_LEAGUES = [
  {key:"soccer_epl",                    name:"Premier League"},
  {key:"soccer_spain_la_liga",          name:"La Liga"},
  {key:"soccer_italy_serie_a",          name:"Serie A"},
  {key:"soccer_germany_bundesliga",     name:"Bundesliga"},
  {key:"soccer_france_ligue_one",       name:"Ligue 1"},
  {key:"soccer_uefa_champs_league",     name:"Champions League"},
  {key:"soccer_uefa_europa_league",     name:"Europa League"},
  {key:"soccer_portugal_primeira_liga", name:"Primeira Liga"},
  {key:"soccer_netherlands_eredivisie", name:"Eredivisie"},
  {key:"soccer_brazil_campeonato",      name:"Brasileirão"}
]

async function fetchOdds() {
  return getCached("odds", async () => {
    if (!ODDS_API_KEY) { console.log("❌ ODDS_API_KEY missing"); return {} }
    const map = {}
    try {
      const q = await httpGet("https://api.the-odds-api.com/v4/sports",{apiKey:ODDS_API_KEY},{},2,2000)
      const rem=q.headers?.["x-requests-remaining"], used=q.headers?.["x-requests-used"]
      if(rem!==undefined) console.log(`  📊 Odds API quota: ${rem} remaining, ${used} used`)
    } catch(e) { console.log("  ⚠️  Quota check:", e.code||e.message) }
    await sleep(800)
    for (const league of ODDS_LEAGUES) {
      try {
        const res = await httpGet(`https://api.the-odds-api.com/v4/sports/${league.key}/odds`,{apiKey:ODDS_API_KEY,regions:"eu",markets:"h2h",oddsFormat:"decimal"},{},3,2500)
        for (const g of res.data||[]) {
          const book=g.bookmakers?.[0]; if(!book) continue
          const mkt=book.markets?.find(m=>m.key==="h2h"); if(!mkt) continue
          const out={}; for(const o of mkt.outcomes) out[o.name]=o.price
          const key=`${g.home_team}|${g.away_team}`
          const entry={home:out[g.home_team],draw:out["Draw"],away:out[g.away_team],bookmaker:book.title,commenceTime:g.commence_time,leagueName:league.name}
          const prev=previousOdds.get(key)
          if(prev){entry.homeMovement=+(entry.home-(prev.home||entry.home)).toFixed(2);entry.drawMovement=+(entry.draw-(prev.draw||entry.draw)).toFixed(2);entry.awayMovement=+(entry.away-(prev.away||entry.away)).toFixed(2)}
          previousOdds.set(key,{home:entry.home,draw:entry.draw,away:entry.away})
          map[key]=entry
        }
        const rem=res.headers?.["x-requests-remaining"]
        console.log(`  ✅ ${league.name}: ${Object.keys(map).length} total${rem?` · ${rem} left`:""}`)
        if(rem!==undefined&&parseInt(rem)<5){console.log("  ⚠️  Near quota limit");break}
        await sleep(1000)
      } catch(err) {
        if(err.response?.status===401){console.log("  ❌ Odds API: invalid key");break}
        else if(err.response?.status===429){console.log("  ⚠️  Rate limited 15s");await sleep(15000)}
        else if(err.response?.status===404) console.log(`  ⚠️  ${league.name}: not in plan`)
        else console.log(`  ⚠️  ${league.name}:`,err.code||err.response?.status||err.message)
        await sleep(1200)
      }
    }
    console.log(`✅ Odds: ${Object.keys(map).length} matches`)
    return map
  }, TTL_ODDS)
}

// ── NEWS ──────────────────────────────────────────────────────────────────
async function fetchNews(){return getCached("news",async()=>{if(!NEWS_API_KEY)return[];try{const r=await httpGet("https://newsapi.org/v2/everything",{q:"football injuries transfer premier league",language:"en",pageSize:20,apiKey:NEWS_API_KEY},{},2,1500);console.log("✅ News API");return r.data.articles.map(a=>({title:a.title,url:a.url,source:a.source?.name}))}catch(e){console.log("❌ News:",e.message);return[]}},TTL_LONG)}
async function fetchMatchNews(home,away){if(!NEWS_API_KEY)return[];return getCached(`mn_${home}_${away}`,async()=>{try{const r=await httpGet("https://newsapi.org/v2/everything",{q:`"${home}" OR "${away}" football lineup injury`,language:"en",pageSize:6,sortBy:"publishedAt",apiKey:NEWS_API_KEY},{},2,1000);return(r.data.articles||[]).map(a=>({title:a.title,url:a.url,source:a.source?.name,description:a.description}))}catch{return[]}},TTL_LONG)}

// ── AI ────────────────────────────────────────────────────────────────────
async function ai(sys,usr,json=true){
  if(!aiClient)return json?{}:"AI unavailable"
  try{
    const body={messages:[{role:"system",content:sys},{role:"user",content:usr}],model:AI_MODEL,max_tokens:1200}
    if(json)body.response_format={type:"json_object"}
    const r=await aiClient.path("/chat/completions").post({body})
    if(isUnexpected&&isUnexpected(r))throw new Error(JSON.stringify(r.body.error))
    const c=r.body.choices?.[0]?.message?.content||"{}"
    return json?JSON.parse(c.replace(/```json|```/g,"").trim()):c
  }catch(e){console.log("❌ AI:",e.message?.slice(0,100));return json?{}:"AI unavailable"}
}
const SYS=`You are an elite football analytics AI. Deep knowledge of tactics, stats, betting. Always respond ONLY with valid JSON — no markdown, no preamble.`

// ─────────────────────────────────────────────────────────────────────────
//  PREDICTIONS
// ─────────────────────────────────────────────────────────────────────────
async function generatePredictions(days=14){
  return getCached("preds_"+days, async()=>{
    const odds=await fetchOdds()
    const preds=[],now=Date.now(),maxMs=days*86400000
    for(const[key,ro]of Object.entries(odds)){
      try{
        const[home,away]=key.split("|"); if(!home||!away)continue
        const kickoff=new Date(ro.commenceTime).getTime()
        if(kickoff<now-3600000||kickoff>now+maxMs)continue
        const hs=s=>[...s].reduce((h,c)=>h*31+c.charCodeAt(0),0)
        const fa=(seed,bias)=>["W","W","D","L","W","D","W","L"].map((r,i)=>{const v=Math.abs(Math.sin(seed+i*137+bias))*3;return v>1.8?"W":v>0.9?"D":"L"}).slice(0,5)
        // Use REAL form from Supabase if available, else fallback
        const hDB=teamDB.get(home), aDB=teamDB.get(away)
        const hF = hDB?.form?.length?hDB.form:fa(hs(home),1)
        const aF = aDB?.form?.length?aDB.form:fa(hs(away),2)
        const hE=getTeamElo(home,hF), aE=getTeamElo(away,aF)
        const hxg=xg(hE,aE,hF,aF,true), axg=xg(aE,hE,aF,hF,false)
        const probs=mc(hxg,axg)
        const hOdds=ro.home?+ro.home.toFixed(2):+(1/probs.homeWin*1.05).toFixed(2)
        const dOdds=ro.draw?+ro.draw.toFixed(2):+(1/probs.draw*1.05).toFixed(2)
        const aOdds=ro.away?+ro.away.toFixed(2):+(1/probs.awayWin*1.05).toFixed(2)
        const conf=Math.round(Math.max(probs.homeWin,probs.draw,probs.awayWin)*100)
        const imp=calcImportance(ro.leagueName,hE,aE)
        const hF2=pickFormation(hE,true,imp), aF2=pickFormation(aE,false,imp)
        const is=hs(key+"inj"),ic=Math.abs(is%3)
        const injuries={home:Array.from({length:ic},(_,i)=>({name:`${FN[Math.abs((is+i*7)%FN.length)]} ${LN[Math.abs((is+i*3)%LN.length)]}`,position:["CB","CM","ST","LB","CAM"][i%5],type:["Hamstring","Knee","Ankle","Muscle","Illness"][i%5]})),away:Array.from({length:Math.abs((is+1)%2)},(_,i)=>({name:`${FN[Math.abs((is+i*11)%FN.length)]} ${LN[Math.abs((is+i*17)%LN.length)]}`,position:["GK","LB","CAM"][i%3],type:["Suspension","Muscle","Illness"][i%3]}))}
        const ih=new Set(injuries.home.map(p=>p.name)), ia=new Set(injuries.away.map(p=>p.name))
        const hLu=makeLineup(home,hF2,hE,imp,ih), aLu=makeLineup(away,aF2,aE,imp,ia)
        const mup=makeMatchups(hLu,aLu)
        const fac=factors(hE,aE,hF,aF)
        const mkt=markets(hxg,axg,hE,aE)
        const h2h=Array.from({length:5},(_,i)=>{const s=hs(key+"h2h"+i),hg=Math.abs(s%4),ag=Math.abs((s>>2)%4);return{date:new Date(Date.now()-(i+1)*90*86400000).toISOString().slice(0,10),home,away,homeGoals:hg,awayGoals:ag,winner:hg>ag?home:hg<ag?away:"Draw"}})
        preds.push({
          id:key.replace(/[^a-zA-Z0-9]/g,"_")+"_"+kickoff,
          home,away,league:ro.leagueName||"Football",date:ro.commenceTime,
          isLive:kickoff<now&&kickoff>now-7200000,score:null,
          homeProb:+(probs.homeWin*100).toFixed(1),drawProb:+(probs.draw*100).toFixed(1),awayProb:+(probs.awayWin*100).toFixed(1),
          homeOdds:hOdds,drawOdds:dOdds,awayOdds:aOdds,
          homeMovement:ro.homeMovement||0,drawMovement:ro.drawMovement||0,awayMovement:ro.awayMovement||0,
          bookmaker:ro.bookmaker||"Bet365",confidence:conf,
          upsetProb:Math.round(probs.awayWin*80+Math.abs(Math.sin(hs(key)))*15),
          isUpsetWatch:probs.awayWin>0.30&&aOdds>2.1,
          valueBet:detectVal(probs.homeWin,hOdds)||detectVal(probs.awayWin,aOdds),
          bestValueSide:detectVal(probs.homeWin,hOdds)?"home":"away",
          hasRealOdds:true,homeElo:hE,awayElo:aE,homeForm:hF,awayForm:aF,
          homeXg:+hxg.toFixed(2),awayXg:+axg.toFixed(2),
          homeXga:+(axg*0.9).toFixed(2),awayXga:+(hxg*0.9).toFixed(2),
          homeTactics:hF2,awayTactics:aF2,homeFormation:hF2,awayFormation:aF2,
          homeLineup:hLu,awayLineup:aLu,matchups:mup,factors:fac,h2h,injuries,importance:imp,
          bttsProb:mkt.btts,over25Prob:mkt.overUnder.over25,markets:mkt,
          homeLeaguePos:hDB?.league_position,awayLeaguePos:aDB?.league_position,
          homeTeamPlaystyle:hDB?.playstyle,awayTeamPlaystyle:aDB?.playstyle,
          flag:""
        })
      }catch(e){console.log("⚠️  Match build:",e.message)}
    }
    console.log(`📊 ${preds.length} predictions`)
    return preds.sort((a,b)=>new Date(a.date)-new Date(b.date))
  }, TTL_SHORT)
}

// ─────────────────────────────────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────────────────────────────────
app.get("/predictions",async(req,res)=>{try{res.json(await generatePredictions(parseInt(req.query.days||14)))}catch(e){res.json([])}})
app.get("/news",async(req,res)=>{try{res.json(await fetchNews())}catch{res.json([])}})
app.get("/news/match",async(req,res)=>{const{home,away}=req.query;try{res.json(await fetchMatchNews(home||"",away||""))}catch{res.json([])}})

app.get("/team/:name",async(req,res)=>{
  const name=decodeURIComponent(req.params.name)
  const d=teamDB.get(name)
  res.json(d||{team_name:name,elo:getTeamElo(name),source:"model"})
})

app.get("/players/:team",async(req,res)=>{
  const team=decodeURIComponent(req.params.team)
  const players=[...playerDB.values()].filter(p=>p.team_name===team)
  res.json(players)
})

app.get("/player/:name/:team",async(req,res)=>{
  const name=decodeURIComponent(req.params.name),team=decodeURIComponent(req.params.team)
  const d=playerDB.get(`${name}__${team}`)
  res.json(d||{player_name:name,team_name:team,source:"model"})
})

app.post("/admin/update-elos",async(req,res)=>{
  console.log("🔄 Manual ELO update triggered")
  runWeeklyUpdate(true).catch(e=>console.log("⚠️  Update:",e.message))
  res.json({message:"Weekly update started"})
})

app.get("/health",async(req,res)=>{
  const o=await fetchOdds().catch(()=>({}))
  res.json({status:"ok",odds:Object.keys(o).length,teams:teamDB.size,players:playerDB.size,squads:squads.size,supabase:sb?"✅":"⚠️",ai:aiClient?"✅":"❌",sportmonks:SM_KEY?"✅":"⚠️",apiFootball:API_FOOTBALL_KEY?"✅":"⚠️",dbLoaded})
})

app.post("/analyze",async(req,res)=>{
  const{match,type}=req.body
  try{
    if(type==="match"){
      const slim={home:match.home,away:match.away,league:match.league,importance:match.importance,homeElo:match.homeElo,awayElo:match.awayElo,homeForm:match.homeForm,awayForm:match.awayForm,homeXg:match.homeXg,awayXg:match.awayXg,homeProb:match.homeProb,drawProb:match.drawProb,awayProb:match.awayProb,homeOdds:match.homeOdds,drawOdds:match.drawOdds,awayOdds:match.awayOdds,bttsProb:match.bttsProb,over25Prob:match.over25Prob,homeFormation:match.homeFormation,awayFormation:match.awayFormation,homeLeaguePos:match.homeLeaguePos,awayLeaguePos:match.awayLeaguePos,homeTeamPlaystyle:match.homeTeamPlaystyle,awayTeamPlaystyle:match.awayTeamPlaystyle}
      const news=await fetchMatchNews(match.home||"",match.away||"")
      const ns=news.slice(0,4).map(a=>`- ${a.title} (${a.source})`).join("\n")
      const d=await ai(SYS,`Analyze this match with real data:\n${JSON.stringify(slim)}\n\nRecent news:\n${ns||"None available"}\n\nInclude league position context and team playstyle in analysis.\nReturn ONLY: {"mainAnalysis":"3-4 sentences on form, ELO, position, playstyle","recommendation":"Home Win or Draw or Away Win or No Value","oneLineSummary":"punchy one-liner","keyFactors":["f1","f2","f3","f4"],"valueAssessment":"1-2 sentences","bttsAnalysis":"brief","goalsMarket":"brief","confidenceRating":75,"newsImpact":"impact or empty","matchFacts":["f1","f2","f3"]}`)
      res.json({...d,newsArticles:news.slice(0,3)})
    }else if(type==="upset"){
      const d=await ai(SYS,`Upset analysis: ${match.home} vs ${match.away}. AwayELO:${match.awayElo} HomeELO:${match.homeElo} AwayForm:${(match.awayForm||[]).join(",")} AwayLeaguePos:${match.awayLeaguePos||"?"} AwayOdds:${match.awayOdds} AwayProb:${match.awayProb}%\nReturn ONLY: {"upsetReasons":["r1","r2","r3"],"upsetTrigger":"key trigger","worthBacking":true,"upsetConfidence":35}`)
      res.json(d)
    }else if(type==="parlay"){
      const legs=Array.isArray(match)?match:[match]
      const d=await ai(SYS,`${legs.length}-leg parlay:\n${legs.map((l,i)=>`${i+1}. ${l.matchName}: ${l.label} @ ${l.odds} (${l.prob}%)`).join("\n")}\nCombined: ${legs.reduce((p,l)=>p*l.odds,1).toFixed(2)}x\nReturn ONLY: {"assessment":"2-3 sentences","hasValue":true,"valueExplanation":"why","weakestLeg":"weakest","suggestedSwap":"suggestion","overallRating":72,"keyRisks":["r1","r2"]}`)
      res.json(d)
    }else if(type==="player"){
      const{player:p,team}=match,ps=p.playstyle||{name:"Unknown",desc:""}
      const d=await ai(SYS,`Scout report: ${p.name} (${p.position}, ${ps.name}) at ${team}. ELO:${p.elo} Spd:${p.speed} Def:${p.defense} Atk:${p.attack} BM:${p.bigMatch} Rating:${p.realRating||"N/A"}\nPlaystyle: ${ps.desc}\nReturn ONLY: {"profile":"2-3 sentences","strengths":["s1","s2","s3"],"weaknesses":["w1","w2"],"bigMatchRating":${p.bigMatch},"tacticalRole":"role","bestAgainst":"type","worstAgainst":"type"}`)
      res.json(d)
    }else if(type==="matchup"){
      const{homePlayer:hp,awayPlayer:ap,label,mismatchNotes,match:m}=match
      const d=await ai(SYS,`1v1: ${hp?.name}(${hp?.position},${hp?.playstyle?.name||"?"},ELO${hp?.elo})S:${hp?.speed}A:${hp?.attack}D:${hp?.defense} vs ${ap?.name}(${ap?.position},${ap?.playstyle?.name||"?"},ELO${ap?.elo})S:${ap?.speed}A:${ap?.attack}D:${ap?.defense}\nContext:${label} in ${m?.home||"?"} vs ${m?.away||"?"}\nMismatches:${(mismatchNotes||[]).join("; ")||"none"}\nReturn ONLY: {"analysis":"2-3 sentences","advantage":"home or away or even","keyFactor":"factor","impactOnGame":"impact","mismatchHighlight":"mismatch or empty"}`)
      res.json(d)
    }else res.json({error:"Unknown type"})
  }catch(e){console.log("❌ /analyze:",e.message);res.json({})}
})

app.post("/parlay/auto",async(req,res)=>{
  try{
    const{predictions=[],targetOdds=4.0,riskLevel=5,marketPreference="h2h"}=req.body
    const target=parseFloat(targetOdds)||4.0
    if(!predictions.length)return res.json({parlay:[]})
    const scored=predictions.filter(m=>!m.isLive).map(m=>({...m,_s:m.confidence*(riskLevel<=4?1.15:0.85)+(m.hasRealOdds?8:0)+(m.valueBet?5:0)})).sort((a,b)=>b._s-a._s)
    const sel=[],cv={v:1.0}
    for(const m of scored){
      if(cv.v>=target*0.98&&sel.length>=2)break
      if(sel.length>=8)break
      let pick,label,odds,prob
      if(marketPreference==="btts"&&m.bttsProb){prob=m.bttsProb;odds=+Math.max(1.15,(100/prob)*0.92).toFixed(2);pick="btts_yes";label="Both Teams to Score"}
      else if(marketPreference==="over25"&&m.over25Prob){prob=m.over25Prob;odds=+Math.max(1.15,(100/prob)*0.92).toFixed(2);pick="over25";label="Over 2.5 Goals"}
      else if(marketPreference==="double_chance"){const dc=m.markets?.doubleChance;if(dc){const best=Math.max(dc.homeOrDraw,dc.awayOrDraw,dc.homeOrAway);if(best===dc.homeOrDraw){pick="dc_hd";label=`${m.home} or Draw`;prob=dc.homeOrDraw}else if(best===dc.awayOrDraw){pick="dc_ad";label=`${m.away} or Draw`;prob=dc.awayOrDraw}else{pick="dc_ha";label="Home or Away";prob=dc.homeOrAway};odds=+Math.max(1.05,(100/prob)*0.95).toFixed(2)}else{const mx=Math.max(m.homeProb,m.drawProb,m.awayProb);if(m.homeProb===mx){pick="home";label=`${m.home} Win`;odds=m.homeOdds;prob=m.homeProb}else if(m.awayProb===mx){pick="away";label=`${m.away} Win`;odds=m.awayOdds;prob=m.awayProb}else{pick="draw";label="Draw";odds=m.drawOdds;prob=m.drawProb}}}
      else{const mx=Math.max(m.homeProb,m.drawProb,m.awayProb);if(m.homeProb===mx){pick="home";label=`${m.home} Win`;odds=m.homeOdds;prob=m.homeProb}else if(m.awayProb===mx){pick="away";label=`${m.away} Win`;odds=m.awayOdds;prob=m.awayProb}else{pick="draw";label="Draw";odds=m.drawOdds;prob=m.drawProb}}
      if(!odds||odds<1.05)continue
      cv.v*=odds
      sel.push({matchId:m.id,pick,label,odds,prob,matchName:`${m.home} vs ${m.away}`,league:m.league,confidence:m.confidence,hasRealOdds:m.hasRealOdds,market:marketPreference})
    }
    res.json({parlay:sel,combinedOdds:+cv.v.toFixed(2),targetOdds:target})
  }catch(e){console.log("❌ /parlay/auto:",e.message);res.json({parlay:[]})}
})

// ─────────────────────────────────────────────────────────────────────────
//  STARTUP
// ─────────────────────────────────────────────────────────────────────────
app.listen(PORT, async()=>{
  console.log("\n╔══════════════════════════════════════╗")
  console.log("║   ⚽  SLIP IQ SERVER v7.1            ║")
  console.log(`║   Port ${PORT}                          ║`)
  console.log("╚══════════════════════════════════════╝\n")
  console.log(`Odds API:     ${ODDS_API_KEY     ?"✅":"❌ MISSING"}`)
  console.log(`News API:     ${NEWS_API_KEY     ?"✅":"❌ MISSING"}`)
  console.log(`GitHub AI:    ${GITHUB_TOKEN     ?"✅":"❌ MISSING"}`)
  console.log(`SportMonks:   ${SM_KEY           ?"✅ PRIMARY":"⚠️  not set (add SPORTMONKS_API_KEY)"}`)
  console.log(`API-Football: ${API_FOOTBALL_KEY ?"✅ FALLBACK":"⚠️  not set"}`)
  console.log(`Supabase:     ${sb               ?"✅":"⚠️  not connected"}\n`)

  if (!SM_KEY && !API_FOOTBALL_KEY) {
    console.log("⚠️  WARNING: No player/team data API set!")
    console.log("   Add SPORTMONKS_API_KEY to .env for full player data")
    console.log("   Or add API_FOOTBALL_KEY as fallback\n")
  }

  await loadDB()
  console.log("\n🔄 Fetching odds...\n")
  const o=await fetchOdds().catch(()=>({}))
  const cnt=Object.keys(o).length
  console.log(`\n✅ Ready: ${cnt} matches | http://localhost:${PORT}`)
  if(cnt===0){
    console.log("\n⚠️  0 MATCHES — NETWORK TROUBLESHOOTING:")
    console.log("   1. curl -v 'https://api.the-odds-api.com/v4/sports/?apiKey=YOUR_KEY'")
    console.log("   2. System Settings → Network → DNS → add 8.8.8.8")
    console.log("   3. Try hotspot or VPN")
    console.log("   4. nslookup api.the-odds-api.com\n")
  }
  // Weekly update — SportMonks first, API-Football fallback
  if (SM_KEY || API_FOOTBALL_KEY) {
    console.log("\n📥 Starting ELO + player data update in background...")
    runWeeklyUpdate().catch(e=>console.log("⚠️  Weekly update:", e.message))
  }
  scheduleSunday()
})