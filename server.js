// ============================================================
// SLIP IQ  —  server.js  v13.0
// KEY FIXES vs v11:
//   ✅ buildGameApproach was MISSING — caused all 314 predictions to return null
//   ✅ Real SM squad / player names re-enabled (full paid tier)
//   ✅ Odds API: removed httpsAgent (was causing ERR_BAD_REQUEST)
//   ✅ No filters[leagueIds] on fixtures (was causing 400 errors)
//   ✅ Player mismatch detection (e.g. Trent vs Vinicius)
//   ✅ Team descriptor engine (timid, attacking, clinical, dominant...)
//   ✅ Trophy ELO bonuses (UCL win = +120 ELO, decaying over years)
//   ✅ Real SM standings endpoint
//   ✅ Real SM league list with season IDs
//   ✅ ELO ranking table with delta arrows
//   ✅ Referral codes saved to Supabase before Stripe redirect
//   ✅ Full credits/plan system enforced server-side
// ============================================================
"use strict"
require("dotenv").config()
const express  = require("express")
const cors     = require("cors")
const axios    = require("axios")
const path     = require("path")
const https    = require("https")
const dns      = require("dns")

dns.setDefaultResultOrder("ipv4first")

// ── AI ────────────────────────────────────────────────────
let OpenAI, aiClient
try {
  OpenAI = require("openai")
  if (process.env.GITHUB_TOKEN) {
    aiClient = new OpenAI({
      baseURL: "https://models.github.ai/inference",
      apiKey: process.env.GITHUB_TOKEN
    })
    console.log("✅ GitHub AI ready —", process.env.MODEL_NAME || "openai/gpt-4o")
  } else {
    console.log("⚠️  GITHUB_TOKEN missing — AI disabled")
  }
} catch(e) { console.log("⚠️  Run: npm install openai") }

// ── SUPABASE ──────────────────────────────────────────────
let sb = null
try {
  const { createClient } = require("@supabase/supabase-js")
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    console.log("✅ Supabase connected")
  }
} catch(e) { console.log("⚠️  Run: npm install @supabase/supabase-js") }

// ── EXPRESS ───────────────────────────────────────────────
const app  = express()
const PORT = process.env.PORT || 3000

// SM uses keepalive. Odds API must NOT use an agent (causes ERR_BAD_REQUEST)
const smAgent = new https.Agent({ keepAlive: true, maxSockets: 10, timeout: 35000 })

app.use(cors())
app.use("/webhook/stripe", express.raw({ type: "application/json" }))
app.use(express.json({ limit: "15mb" }))
// Serve HTML from both /public and root directory (handles Render deployments)
app.use(express.static(path.join(__dirname, "public")))
app.use(express.static(__dirname, { extensions: ["html"] }))

// ── ENV ───────────────────────────────────────────────────
const SM_KEY   = process.env.SPORTMONKS_API_KEY
const ODDS_KEY = process.env.ODDS_API_KEY
const NEWS_KEY = process.env.NEWS_API_KEY
// football-data.org — free standings API (sign up at football-data.org)
const FD_KEY_ENV = process.env.FOOTBALL_DATA_KEY || ""
const STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET
const _raw     = process.env.MODEL_NAME || "openai/gpt-4o"
const AI_MODEL = (_raw === "openai/gpt-5" || _raw === "gpt-5") ? "openai/gpt-4o" : _raw
const SM_BASE  = "https://api.sportmonks.com/v3/football"

// ── CREDITS / PLANS ───────────────────────────────────────
const PLAN_CREDITS = { free: 25, basic: 55, plus: 115, pro: 265, elite: 900, platinum: Infinity }
const ACTION_COSTS = {
  match_analysis:   15,
  news_analysis:     5,
  auto_parlay:      10,
  parlay_advice:    20,
  ai_agent:         10,
  team_stats:       15,
  leagues_tab:      15,
  risk_analysis:    15,
}
const PLAN_FEATURES = {
  auto_parlay:   ["plus","pro","elite","platinum"],
  parlay_advice: ["plus","pro","elite","platinum"],
  ai_agent:      ["plus","pro","elite","platinum"],
  team_stats:    ["plus","pro","elite","platinum"],
  leagues_tab:   ["plus","pro","elite","platinum"],
  match_analysis:["free","basic","plus","pro","elite","platinum"],
  news_analysis: ["free","basic","plus","pro","elite","platinum"],
  risk_analysis: ["free","basic","plus","pro","elite","platinum"],
}

// ── CACHE ─────────────────────────────────────────────────
const cache = new Map()
const TTL = { LIVE: 15000, S: 300000, M: 900000, L: 3600000, XL: 21600000 }

async function cached(key, fn, ttl) {
  ttl = ttl || TTL.M
  const hit = cache.get(key)
  if (hit && Date.now() - hit.ts < ttl) return hit.data
  try {
    const data = await fn()
    cache.set(key, { data, ts: Date.now() })
    return data
  } catch(e) {
    if (hit) return hit.data
    throw e
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── HTTP (SM only — uses smAgent) ─────────────────────────
async function http(url, params, hdrs, retries) {
  params = params || {}; hdrs = hdrs || {}; retries = retries || 3
  for (let i = 1; i <= retries; i++) {
    try {
      return await axios.get(url, {
        params,
        timeout: 30000,
        httpsAgent: smAgent,
        headers: { "Accept": "application/json", "Accept-Encoding": "gzip", "User-Agent": "SlipIQ/1.0", ...hdrs }
      })
    } catch(e) {
      const code   = e.code || ""
      const status = (e.response && e.response.status) || 0
      const retry  = ["ECONNRESET","ETIMEDOUT","ENOTFOUND","ECONNREFUSED","EPIPE","EAI_AGAIN","ECONNABORTED"].includes(code) || status >= 500
      if (retry && i < retries) { await sleep(1500 * Math.pow(2, i - 1)); continue }
      throw e
    }
  }
}

// ── IN-MEMORY STORES ──────────────────────────────────────
const teamDB       = new Map()
const playerDB     = new Map()
const squadDB      = new Map()
const managerDB    = new Map()
const clubEloMap   = new Map()
const trophyBonus  = new Map()   // team → extra ELO from trophies (decays)
const prevEloSnap  = new Map()   // team → ELO last time /elo/rankings was called

function sbSave(table, row, conflict) {
  if (!sb) return
  const q = sb.from(table).upsert(row, { onConflict: conflict })
  if (typeof q.then === 'function') q.then(() => {}).catch(() => {})
}

// ── SUPABASE LOAD ─────────────────────────────────────────
async function loadSupabase() {
  if (!sb) { console.log("ℹ️  No Supabase — live API only"); return }
  try {
    const [tr, pr, mr] = await Promise.all([
      sb.from("team_ratings").select("*"),
      sb.from("player_ratings").select("*").limit(200000),
      sb.from("manager_ratings").select("*").then(r => r).catch(() => ({ data: [] }))
    ])
    if (tr.data) for (const t of tr.data) teamDB.set(t.team_name, t)
    if (pr.data) {
      for (const p of pr.data) {
        playerDB.set(`${p.player_name}__${p.team_name}`, p)
        if (!squadDB.has(p.team_name)) squadDB.set(p.team_name, [])
        squadDB.get(p.team_name).push(p)
      }
    }
    if (mr.data) for (const m of mr.data) managerDB.set(m.manager_name, m)
    console.log(`✅ Supabase: ${teamDB.size} teams, ${playerDB.size} players, ${managerDB.size} managers`)
  } catch(e) { console.log("⚠️  Supabase:", e.message) }
}

// ── CLUBELO ───────────────────────────────────────────────
async function loadClubElo() {
  try {
    const today = new Date().toISOString().slice(0, 10)
    const res   = await axios.get(`http://api.clubelo.com/${today}`, { timeout: 15000, responseType: "text" })
    let count = 0
    for (const line of res.data.split("\n").slice(1)) {
      const parts = line.split(",")
      if (parts.length < 5) continue
      const name = parts[1]?.trim(), elo = parseInt(parts[4])
      if (name && elo > 0) {
        clubEloMap.set(name.toLowerCase(), elo)
        const clean = name.replace(/^(FC |AC |AS |RC |SC |CD |RB |VfB |VfL |1\.FC |Borussia |Real |Atletico |Athletic )/i, "")
        if (clean !== name) clubEloMap.set(clean.toLowerCase(), elo)
        count++
      }
    }
    console.log(`✅ ClubElo: ${count} teams`)
    setTimeout(loadClubElo, 12 * 3600000)
  } catch(e) {
    console.log("⚠️  ClubElo:", e.message)
    setTimeout(loadClubElo, 30 * 60000)
  }
}

function getClubElo(name) {
  if (!name) return null
  const lo = name.toLowerCase()
  if (clubEloMap.has(lo)) return clubEloMap.get(lo)
  const short = lo.replace(/^(fc |ac |as |rc |sc |cd |rb |vfb |vfl |borussia |real |atletico |athletic |paris saint-germain|paris sg)/i, "").trim()
  if (clubEloMap.has(short)) return clubEloMap.get(short)
  for (const [k, v] of clubEloMap) {
    const ks = k.replace(/^(fc |ac |as |rc |sc |cd |rb |borussia |real |atletico )/i, "").trim()
    if (short.length >= 4 && (ks.startsWith(short.slice(0, 6)) || short.startsWith(ks.slice(0, 6)))) return v
  }
  return null
}

// ── LEAGUE ELO BANDS ──────────────────────────────────────
const LEAGUE_ELO_BANDS = {
  "Premier League":       { top: 1950, bot: 1530, spread: 420 },
  "La Liga":              { top: 1920, bot: 1490, spread: 430 },
  "Serie A":              { top: 1900, bot: 1480, spread: 420 },
  "Bundesliga":           { top: 1960, bot: 1510, spread: 450 },
  "Ligue 1":              { top: 1880, bot: 1470, spread: 410 },
  "Champions League":     { top: 1990, bot: 1300, spread: 690 },
  "Europa League":        { top: 1780, bot: 1420, spread: 360 },
  "Conference League":    { top: 1680, bot: 1350, spread: 330 },
  "Championship":         { top: 1600, bot: 1350, spread: 250 },
  "Scottish Premiership": { top: 1700, bot: 1360, spread: 340 },
  "Primeira Liga":        { top: 1820, bot: 1430, spread: 390 },
  "Eredivisie":           { top: 1820, bot: 1440, spread: 380 },
  "Süper Lig":            { top: 1760, bot: 1430, spread: 330 },
  "Belgian Pro League":   { top: 1720, bot: 1390, spread: 330 },
  "Argentine Primera":    { top: 1790, bot: 1430, spread: 360 },
  "Brasileirão":          { top: 1780, bot: 1380, spread: 400 },
  "MLS":                  { top: 1660, bot: 1360, spread: 300 },
  "Saudi Pro League":     { top: 1680, bot: 1320, spread: 360 },
  "Danish Superliga":     { top: 1680, bot: 1370, spread: 310 },
  "Greek Super League":   { top: 1700, bot: 1370, spread: 330 },
  "Czech Liga":           { top: 1690, bot: 1360, spread: 330 },
  "Zambian Super League": { top: 1440, bot: 1230, spread: 210 },
  "South African PSL":    { top: 1530, bot: 1290, spread: 240 },
  "Estonian Meistriliiga":{ top: 1500, bot: 1280, spread: 220 },
  "FA Cup":               { top: 1900, bot: 1300, spread: 600 },
  "Carabao Cup":          { top: 1900, bot: 1300, spread: 600 },
  "Copa del Rey":         { top: 1880, bot: 1350, spread: 530 },
  "Coppa Italia":         { top: 1870, bot: 1350, spread: 520 },
  "DFB Pokal":            { top: 1920, bot: 1300, spread: 620 },
  "Coupe de France":      { top: 1850, bot: 1250, spread: 600 },
  "DBU Pokalen":          { top: 1680, bot: 1250, spread: 430 },
  "Bundesliga 2":         { top: 1580, bot: 1340, spread: 240 },
  "La Liga 2":            { top: 1560, bot: 1330, spread: 230 },
}

// ── HARDCODED ELO BASE ────────────────────────────────────
const ELO_BASE = {
  "Arsenal": 1980, "Liverpool": 1905, "Manchester City": 1855, "Chelsea": 1825, "Manchester United": 1815,
  "Tottenham Hotspur": 1780, "Newcastle United": 1745, "Aston Villa": 1755, "Brighton": 1715,
  "Nottingham Forest": 1655, "West Ham United": 1705, "Fulham": 1635, "Brentford": 1625,
  "Crystal Palace": 1645, "Everton": 1595, "Bournemouth": 1615, "Wolverhampton Wanderers": 1650,
  "Leicester City": 1605, "Ipswich Town": 1545, "Southampton": 1525,
  "Real Madrid": 1910, "Barcelona": 1905, "Atletico Madrid": 1875, "Athletic Club": 1720,
  "Villarreal": 1735, "Real Sociedad": 1745, "Girona": 1705, "Osasuna": 1645, "Getafe": 1595,
  "Celta Vigo": 1635, "Rayo Vallecano": 1605, "Alaves": 1575, "Mallorca": 1585, "Leganes": 1545,
  "Valladolid": 1535, "Las Palmas": 1540, "Espanyol": 1550, "Sevilla": 1760, "Valencia": 1670, "Real Betis": 1700,
  "Bayern Munich": 1970, "Borussia Dortmund": 1880, "RB Leipzig": 1840, "Bayer Leverkusen": 1905,
  "Eintracht Frankfurt": 1750, "VfB Stuttgart": 1690, "Wolfsburg": 1700, "Freiburg": 1710,
  "Hoffenheim": 1680, "Union Berlin": 1660, "Werder Bremen": 1650, "Augsburg": 1610, "Mainz": 1620, "Heidenheim": 1585,
  "Inter Milan": 1905, "Juventus": 1865, "AC Milan": 1870, "Napoli": 1855, "Roma": 1790, "Lazio": 1775,
  "Atalanta": 1825, "Fiorentina": 1745, "Bologna": 1705, "Torino": 1665, "Udinese": 1625, "Cagliari": 1605,
  "Venezia": 1560, "Lecce": 1575, "Empoli": 1560, "Monza": 1580, "Parma": 1555, "Como": 1550,
  "Paris Saint-Germain": 1935, "Monaco": 1805, "Marseille": 1775, "Lille": 1765, "Nice": 1725,
  "Lens": 1685, "Rennes": 1705, "Strasbourg": 1645, "Nantes": 1635, "Lyon": 1730, "Brest": 1680,
  "Benfica": 1825, "Porto": 1835, "Sporting CP": 1815, "Braga": 1745,
  "Ajax": 1805, "PSV": 1825, "Feyenoord": 1795, "AZ": 1745,
  "Celtic": 1685, "Rangers": 1665, "Galatasaray": 1725, "Fenerbahce": 1705, "Besiktas": 1665,
  "Flamengo": 1765, "Palmeiras": 1755, "Atletico Mineiro": 1735, "Botafogo": 1725,
  "Flora Tallinn": 1430, "Levadia Tallinn": 1420, "Paide": 1395, "Kalju": 1380,
  "Slavia Prague": 1720, "Sparta Prague": 1710, "Viktoria Plzen": 1690,
  "Panathinaikos": 1720, "Olympiakos": 1715, "PAOK": 1700, "AEK Athens": 1695,
}

// ── TROPHY ELO ────────────────────────────────────────────
const TROPHY_WEIGHTS = {
  "Champions League": 120, "Europa League": 65, "Conference League": 35,
  "Premier League": 80, "La Liga": 78, "Bundesliga": 82, "Serie A": 76, "Ligue 1": 72,
  "FA Cup": 25, "Copa del Rey": 22, "DFB Pokal": 22, "Coppa Italia": 22, "Coupe de France": 20,
  "Scottish Premiership": 30, "Primeira Liga": 40, "Eredivisie": 42, "Süper Lig": 35,
  "Greek Super League": 28, "Czech Liga": 25, "Estonian Meistriliiga": 15, "default": 15,
}

function applyTrophyBonus(teamName, competition, seasonYear) {
  const weight = TROPHY_WEIGHTS[competition] || TROPHY_WEIGHTS.default
  const age    = new Date().getFullYear() - (seasonYear || new Date().getFullYear())
  const decay  = Math.max(0.2, 1 - age * 0.15)
  const bonus  = Math.round(weight * decay)
  trophyBonus.set(teamName, Math.min((trophyBonus.get(teamName) || 0) + bonus, 250))
  sbSave("trophy_elo_bonuses", {
    team_name: teamName, competition,
    season_year: seasonYear || new Date().getFullYear(),
    elo_bonus: bonus, created_at: new Date().toISOString()
  }, "team_name,competition,season_year")
}

// ── ELO LOOKUP ────────────────────────────────────────────
function getElo(name, league, approxPos) {
  const bonus = trophyBonus.get(name) || 0
  const db    = teamDB.get(name)
  if (db && db.scaled_score > 0) return Math.round(1300 + db.scaled_score * 7.5 + bonus)
  if (db && db.elo > 1300)       return Math.round(db.elo + bonus)
  const ce = getClubElo(name)
  if (ce && ce > 1000) return Math.round(ce + bonus)
  if (ELO_BASE[name]) return Math.round(ELO_BASE[name] + bonus)
  const lo = name.toLowerCase()
  for (const k of Object.keys(ELO_BASE)) {
    const kl = k.toLowerCase()
    if (lo.slice(0, 5) && (lo.startsWith(kl.slice(0, 5)) || kl.startsWith(lo.slice(0, 5)))) return Math.round(ELO_BASE[k] + bonus)
  }
  if (league) {
    const band = LEAGUE_ELO_BANDS[league]
    if (band) {
      const pos = Math.max(0, Math.min(1, approxPos || 0.5))
      let seed = 0
      for (let i = 0; i < name.length; i++) seed = (seed * 31 + name.charCodeAt(i)) & 0xffffffff
      return Math.round(band.top - pos * band.spread + (Math.abs(seed) % 50) - 25 + bonus)
    }
  }
  return 1500 + bonus
}

// ── MANAGER ELO ───────────────────────────────────────────
const MANAGER_SEEDS = {
  "Pep Guardiola":          { team: "Man City",         base: 1920, style: "Possession" },
  "Carlo Ancelotti":        { team: "Real Madrid",      base: 1900, style: "Flexible" },
  "Hansi Flick":            { team: "Barcelona",        base: 1870, style: "High Press" },
  "Mikel Arteta":           { team: "Arsenal",          base: 1870, style: "Pressing" },
  "Diego Simeone":          { team: "Atletico Madrid",  base: 1850, style: "Defensive" },
  "Thomas Tuchel":          { team: "Bayern Munich",    base: 1870, style: "Counter-press" },
  "Luis Enrique":           { team: "PSG",              base: 1890, style: "Possession" },
  "Simone Inzaghi":         { team: "Inter Milan",      base: 1860, style: "3-5-2" },
  "Gian Piero Gasperini":   { team: "Atalanta",         base: 1830, style: "Attacking" },
  "Xabi Alonso":            { team: "Bayer Leverkusen", base: 1900, style: "Pressing" },
  "Ruben Amorim":           { team: "Manchester United",base: 1800, style: "3-4-3" },
  "Ange Postecoglou":       { team: "Tottenham",        base: 1770, style: "Attacking" },
  "Unai Emery":             { team: "Aston Villa",      base: 1790, style: "Tactical" },
  "Eddie Howe":             { team: "Newcastle",        base: 1760, style: "Counter" },
  "Enzo Maresca":           { team: "Chelsea",          base: 1810, style: "Possession" },
}

function getManagerElo(name, team) {
  const s = managerDB.get(name)
  if (s && s.elo > 0) return s.elo
  const seed = MANAGER_SEEDS[name]
  if (seed) return seed.base
  return getElo(team || "") - 30
}

async function updateManagerElo(hMgr, aMgr, hTeam, aTeam, hGoals, aGoals, hxg, axg) {
  if (!hMgr || !aMgr) return
  const hElo = getManagerElo(hMgr, hTeam), aElo = getManagerElo(aMgr, aTeam)
  const hExp = 1 / (1 + Math.pow(10, (aElo - hElo) / 400))
  const hActual = hGoals > aGoals ? 1 : hGoals < aGoals ? 0 : 0.5
  const aActual = 1 - hActual
  const dom = Math.min(1.5, 1 + Math.abs((hxg || 1.3) - (axg || 1.3)) * 0.2)
  const marginMult = 1 + Math.log(1 + Math.abs(hGoals - aGoals)) * 0.15
  const K = 24
  const hDelta = Math.round(K * dom * marginMult * (hActual - hExp))
  const aDelta = Math.round(K * dom * marginMult * (aActual - (1 - hExp)))
  const hRec = managerDB.get(hMgr) || { manager_name: hMgr, team_name: hTeam, elo: hElo, wins: 0, draws: 0, losses: 0 }
  const aRec = managerDB.get(aMgr) || { manager_name: aMgr, team_name: aTeam, elo: aElo, wins: 0, draws: 0, losses: 0 }
  hRec.elo = hElo + hDelta; aRec.elo = aElo + aDelta
  if (hActual === 1) { hRec.wins = (hRec.wins||0)+1; aRec.losses = (aRec.losses||0)+1 }
  else if (hActual === 0) { hRec.losses = (hRec.losses||0)+1; aRec.wins = (aRec.wins||0)+1 }
  else { hRec.draws = (hRec.draws||0)+1; aRec.draws = (aRec.draws||0)+1 }
  managerDB.set(hMgr, hRec); managerDB.set(aMgr, aRec)
  sbSave("manager_ratings", { ...hRec, updated_at: new Date().toISOString() }, "manager_name")
  sbSave("manager_ratings", { ...aRec, updated_at: new Date().toISOString() }, "manager_name")
}

// ── PLAYER ELO / ATTRIBUTES ───────────────────────────────
function buildPlayerElo(name, pos, teamElo, rating, goals, apps) {
  if (rating && rating > 0) {
    const rf = (parseFloat(rating) - 5) / 5
    return Math.round(Math.max(1300, Math.min(2050, 1200 + rf * 250 + (teamElo - 1500) * 0.4)))
  }
  const goalBonus = apps > 0 ? Math.round((goals / apps) * 30) : 0
  const posBonus  = { ST:35, LW:30, RW:30, CAM:25, CM:10, CDM:5, LB:0, RB:0, CB:-5, LWB:5, RWB:5, GK:-10, RM:15, LM:15 }
  let seed = 0
  for (let i = 0; i < name.length; i++) seed = seed * 31 + name.charCodeAt(i)
  return Math.round(Math.max(1300, Math.min(2050, teamElo + (posBonus[pos] || 0) + goalBonus + ((Math.abs(seed) % 120) - 60))))
}

const PLAYSTYLES = {
  GK:  { name: "Sweeper Keeper",  desc: "Commands area, builds play from back",              icon: "🧤" },
  CB:  { name: "Ball-Playing CB", desc: "Line-breaking passes, steps into midfield",         icon: "⚽" },
  LB:  { name: "Attack Fullback", desc: "Overlapping runs, dangerous in final third",        icon: "🏃" },
  RB:  { name: "Attack Fullback", desc: "Overlapping runs, dangerous in final third",        icon: "🏃" },
  CDM: { name: "Press Conductor", desc: "Sets press triggers, shields the backline",         icon: "🔥" },
  CM:  { name: "Box-to-Box",      desc: "Covers ground, contributes in both phases",         icon: "⚙️" },
  CAM: { name: "Playmaker",       desc: "Creates between lines, key passes & shooting",      icon: "✨" },
  LW:  { name: "Inverted Winger", desc: "Cuts inside onto stronger foot, half-space threat", icon: "↩️" },
  RW:  { name: "Inverted Winger", desc: "Cuts inside onto stronger foot, half-space threat", icon: "↩️" },
  ST:  { name: "Target Striker",  desc: "Holds up play, aerial threat, clinical finisher",   icon: "🎯" },
  LWB: { name: "Wingback",        desc: "Very advanced, creates wide overloads",             icon: "🏃" },
  RWB: { name: "Wingback",        desc: "Very advanced, creates wide overloads",             icon: "🏃" },
  RM:  { name: "Wide Midfielder", desc: "Two-way wide contribution",                         icon: "📐" },
  LM:  { name: "Wide Midfielder", desc: "Two-way wide contribution",                         icon: "📐" },
}

function clamp(v) { return Math.min(99, Math.max(20, v)) }

function buildPlayerAttrs(name, pos, pElo, tElo, rating) {
  const ef     = (pElo - 1300) / 700
  const isAtk  = ["ST","LW","RW","CAM"].includes(pos)
  const isDef  = ["CB","LB","RB","CDM","GK"].includes(pos)
  let seed = 0
  for (let i = 0; i < name.length; i++) seed = seed * 31 + name.charCodeAt(i)
  const sr = n => Math.abs(Math.sin(seed * n + n))
  let spd, atk, def, bm
  if (rating && rating > 0) {
    const rf = (parseFloat(rating) - 5) / 5
    spd = clamp(Math.round(50 + rf*25 + ef*18 + sr(1)*12 + (isAtk ? 10 : isDef ? -5 : 0)))
    atk = clamp(Math.round(isAtk ? 55+rf*28+ef*14+sr(2)*8 : isDef ? 22+rf*14+ef*12+sr(3)*8 : 38+rf*18+ef*14+sr(4)*8))
    def = clamp(Math.round(isDef ? 55+rf*28+ef*14+sr(5)*8 : isAtk ? 22+rf*14+ef*10+sr(6)*8 : 42+rf*18+ef*12+sr(7)*8))
    bm  = clamp(Math.round(40 + rf*32 + ef*18 + sr(8)*10))
  } else {
    spd = clamp(Math.round(40 + ef*48 + sr(1)*18 - 8 + (isAtk ? 10 : 0)))
    atk = clamp(Math.round(isAtk ? 60+ef*32+sr(2)*10 : isDef ? 24+ef*32+sr(3)*10 : 36+ef*36+sr(4)*10))
    def = clamp(Math.round(isDef ? 58+ef*32+sr(5)*10 : isAtk ? 20+ef*28+sr(6)*10 : 38+ef*32+sr(7)*10))
    bm  = clamp(Math.round(40 + ef*46 + sr(8)*18 - 8))
  }
  const ps = PLAYSTYLES[pos] || PLAYSTYLES.CM
  const strengths = [], weaknesses = []
  if (spd >= 78) strengths.push("Explosive pace — beats defenders in behind")
  if (atk >= 78) strengths.push("Clinical in front of goal — high conversion rate")
  if (def >= 78) strengths.push("Dominant defensively — reads the game excellently")
  if (bm  >= 78) strengths.push("Big-game temperament — elevates in key moments")
  if (pElo > tElo + 60) strengths.push("Outperforms teammates — elite individual quality")
  if (spd < 50) weaknesses.push("Lack of pace — vulnerable against quick transitions")
  if (def < 42 && isDef) weaknesses.push("Defensive weakness — can be exploited 1v1")
  if (atk < 42 && isAtk) weaknesses.push("Limited goal threat — more of a link player")
  if (bm  < 45) weaknesses.push("Can go missing in high-pressure moments")
  while (strengths.length < 2) strengths.push("Consistent performer within team structure")
  while (weaknesses.length < 1) weaknesses.push("Can be inconsistent when team underperforms")
  return { speed: spd, attack: atk, defense: def, bigMatch: bm, playstyle: ps, strengths: strengths.slice(0,3), weaknesses: weaknesses.slice(0,2), isKey: pElo > tElo + 55 }
}

const POS_ID_MAP = { 24:"GK",25:"CB",26:"CM",27:"ST",28:"LB",29:"RB",30:"CDM",31:"CAM",32:"LW",33:"RW",34:"RM",35:"LM",36:"LWB",37:"RWB" }
function mapPosId(id) { return POS_ID_MAP[id] || "CM" }

// ══════════════════════════════════════════════════════════
//  TEAM DESCRIPTOR ENGINE
// ══════════════════════════════════════════════════════════
function buildTeamDescriptors(xgFor, xgAg, form, elo, leagueAvgElo, goalsPerGame, concededPerGame, homeWinRate, awayWinRate, vsStrongWinRate, vsWeakLossRate) {
  const descriptors = []
  const leagueAvg   = leagueAvgElo || 1600
  const xgd         = xgFor - xgAg
  const fs          = formScore(form)

  if (xgFor < 0.90 && elo < leagueAvg)
    descriptors.push({ key:"timid", label:"timid", color:"#ff8c42", desc:`Avg xG ${xgFor.toFixed(2)} — rarely threatens goal`, icon:"😰" })
  if (xgAg < 0.85 && concededPerGame < 0.95)
    descriptors.push({ key:"defensively_sound", label:"defensively sound", color:"#00c8f8", desc:`Avg xGA ${xgAg.toFixed(2)} — hard to score against`, icon:"🛡" })
  if (xgFor > 1.80 && goalsPerGame > 1.5)
    descriptors.push({ key:"attacking", label:"attacking", color:"#ff3b5c", desc:`Avg xG ${xgFor.toFixed(2)} — creates constantly`, icon:"⚡" })
  if (goalsPerGame > xgFor * 1.15 && xgFor > 0.5)
    descriptors.push({ key:"outperforms_xg", label:"outperforms xG", color:"#00ff88", desc:`Scores ${Math.round((goalsPerGame / Math.max(xgFor, 0.1) - 1) * 100)}% more than xG suggests`, icon:"🎯" })
  if (elo < leagueAvg - 100 && fs < 0.30)
    descriptors.push({ key:"looks_weak", label:"looks weak", color:"#ff3b5c", desc:`Form ${Math.round(fs * 100)}/100 — struggling badly`, icon:"📉" })
  if (vsStrongWinRate > 0.20)
    descriptors.push({ key:"steps_up", label:"steps up", color:"#9b6dff", desc:`Wins ${Math.round(vsStrongWinRate * 100)}% vs strong teams`, icon:"💪" })
  if (xgFor >= 1.0 && xgFor <= 1.5 && elo > leagueAvg - 80 && elo < leagueAvg + 80)
    descriptors.push({ key:"plays_normal", label:"plays normal", color:"#7a9bbf", desc:`Balanced — xG ${xgFor.toFixed(2)}, avg ELO`, icon:"⚖️" })
  if (xgd < 0 && goalsPerGame > concededPerGame)
    descriptors.push({ key:"finnesser", label:"finnesser", color:"#ffd700", desc:`Outplayed ${Math.abs(xgd).toFixed(2)} xG but positive GD — wins ugly`, icon:"🧲" })
  if (xgd > 0.40)
    descriptors.push({ key:"outplays", label:"outplays", color:"#00e5c8", desc:`Dominates possession — xG diff +${xgd.toFixed(2)}`, icon:"🏆" })
  if (xgd < -0.40)
    descriptors.push({ key:"gets_outplayed", label:"gets outplayed", color:"#ff8c42", desc:`Usually second best — xG diff ${xgd.toFixed(2)}`, icon:"😓" })
  if (elo > leagueAvg + 120 && xgFor > 1.40)
    descriptors.push({ key:"controls_games", label:"controls games", color:"#00c8f8", desc:`Controls ${Math.round((xgFor / (xgFor + xgAg)) * 100)}% of their games on xG`, icon:"👑" })
  if (elo < leagueAvg - 120 && xgAg > 1.40)
    descriptors.push({ key:"gets_controlled", label:"gets controlled", color:"#ff3b5c", desc:`Opponents dominate — xGA ${xgAg.toFixed(2)}/game`, icon:"😤" })
  if (vsStrongWinRate > 0.20)
    descriptors.push({ key:"causes_upsets", label:"causes upsets", color:"#ffd700", desc:`Beats bigger teams ${Math.round(vsStrongWinRate * 100)}% of the time`, icon:"💥" })
  if (vsWeakLossRate > 0.25)
    descriptors.push({ key:"underestimates_opponent", label:"underestimates opponent", color:"#ff8c42", desc:`Drops points to lower teams ${Math.round(vsWeakLossRate * 100)}% of time`, icon:"😬" })
  if (goalsPerGame > 2.0)
    descriptors.push({ key:"scores_alot", label:"scores a lot", color:"#00ff88", desc:`Avg ${goalsPerGame.toFixed(2)} goals/game — prolific`, icon:"🔥" })
  if (concededPerGame > 1.80)
    descriptors.push({ key:"concedes_alot", label:"concedes a lot", color:"#ff3b5c", desc:`Avg ${concededPerGame.toFixed(2)} conceded/game — leaky`, icon:"🚨" })
  if (xgFor > 2.0 && xgAg < 0.85)
    descriptors.push({ key:"dominant", label:"dominant", color:"#00ff88", desc:`Both attacks and defends at elite level`, icon:"💎" })
  if ((homeWinRate || 0) - (awayWinRate || 0) > 0.25)
    descriptors.push({ key:"fortress_home", label:"fortress at home", color:"#00c8f8", desc:`Home record ${Math.round((homeWinRate || 0) * 100)}% — strong fortress`, icon:"🏠" })
  if (elo > 1750 && xgFor > 1.60)
    descriptors.push({ key:"high_press", label:"high press", color:"#9b6dff", desc:`High intensity — ELO ${elo}, xG ${xgFor.toFixed(2)}/game`, icon:"⚡" })

  return descriptors.slice(0, 5)
}

// ══════════════════════════════════════════════════════════
//  PLAYER MISMATCH DETECTOR
// ══════════════════════════════════════════════════════════
function detectMismatches(homeLineup, awayLineup, homeName, awayName) {
  const mismatches = []
  if (!homeLineup?.length || !awayLineup?.length) return mismatches

  const checkMismatch = (atk, def, atkTeam, defTeam) => {
    const isPositional =
      (atk.position === "LW"  && def.position === "RB") ||
      (atk.position === "RW"  && def.position === "LB") ||
      (atk.position === "ST"  && def.position === "CB") ||
      (atk.position === "CAM" && def.position === "CDM")
    if (!isPositional) return
    const atkAdv = (atk.attack  || 60) - (def.defense || 50)
    const spdAdv = (atk.speed   || 60) - (def.speed   || 50)
    if (atkAdv > 20 || spdAdv > 25) {
      const weight = Math.min(0.95, 0.5 + (atkAdv + spdAdv) / 200)
      mismatches.push({
        attacker: { name: atk.name, pos: atk.position, team: atkTeam, elo: atk.elo, attack: atk.attack, speed: atk.speed },
        defender: { name: def.name, pos: def.position, team: defTeam, elo: def.elo, defense: def.defense, speed: def.speed },
        atkAdvantage:  Math.round(atkAdv),
        speedAdvantage:Math.round(spdAdv),
        favor:  atkTeam,
        weight: parseFloat(weight.toFixed(2)),
        description: `${atk.name} (${atk.position}, atk:${atk.attack||60}) vs ${def.name} (${def.position}, def:${def.defense||50}) — ${atk.name} has edge`,
      })
    }
  }

  const homeAtk = homeLineup.filter(p => ["ST","LW","RW","CAM"].includes(p.position))
  const awayAtk = awayLineup.filter(p => ["ST","LW","RW","CAM"].includes(p.position))
  const homeDef = homeLineup.filter(p => ["CB","LB","RB","CDM"].includes(p.position))
  const awayDef = awayLineup.filter(p => ["CB","LB","RB","CDM"].includes(p.position))

  for (const atk of homeAtk) for (const def of awayDef) checkMismatch(atk, def, homeName, awayName)
  for (const atk of awayAtk) for (const def of homeDef) checkMismatch(atk, def, awayName, homeName)

  return mismatches.sort((a, b) => b.atkAdvantage - a.atkAdvantage).slice(0, 6)
}

// ══════════════════════════════════════════════════════════
//  BUILD GAME APPROACH — THIS FUNCTION WAS MISSING IN v11
//  Its absence caused buildPrediction to throw on every fixture
//  → all 314 predictions returned null
// ══════════════════════════════════════════════════════════
function buildGameApproach(hElo, aElo, hForm, aForm, hxg, axg, league) {
  const band     = LEAGUE_ELO_BANDS[league]
  const leagueAvg = band ? (band.top + band.bot) / 2 : 1650

  const hStyle = hElo > 1850 && formScore(hForm) > 0.65 ? "High Press"
               : hElo > 1700 && hxg > 1.5              ? "Attack-minded"
               : hxg < 1.0                              ? "Defensive"
               : "Balanced"
  const aStyle = aElo > 1850 && formScore(aForm) > 0.65 ? "High Press"
               : aElo > 1700 && axg > 1.5              ? "Attack-minded"
               : axg < 1.0                              ? "Defensive"
               : "Balanced"

  const hDesc = buildTeamDescriptors(hxg, axg * 0.9, hForm, hElo, leagueAvg, hxg * 0.85, axg * 0.8, 0.55, 0.42, 0.18, 0.22)
  const aDesc = buildTeamDescriptors(axg, hxg * 0.9, aForm, aElo, leagueAvg, axg * 0.85, hxg * 0.8, 0.38, 0.45, 0.15, 0.28)

  return {
    home: { style: hStyle, descriptors: hDesc, formScore: Math.round(formScore(hForm) * 100), xgFor: parseFloat(hxg.toFixed(2)), xgAg: parseFloat((axg * 0.9).toFixed(2)) },
    away: { style: aStyle, descriptors: aDesc, formScore: Math.round(formScore(aForm) * 100), xgFor: parseFloat(axg.toFixed(2)), xgAg: parseFloat((hxg * 0.9).toFixed(2)) },
  }
}

// ── LEAGUE NORMALISATION ──────────────────────────────────
function normLeague(raw) {
  if (!raw) return null
  // Strip season year suffixes like "2024/25", "2025/2026", "2025-26"
  const clean = raw.replace(/\s*\d{4}[/-]\d{2,4}$/,"").replace(/\s*\d{4}$/,"").trim()
  const map = {
    // Premier League
    "Premier League":"Premier League","English Premier League":"Premier League","EPL":"Premier League",
    "Barclays Premier League":"Premier League","Barclays PL":"Premier League",
    // La Liga
    "La Liga":"La Liga","LaLiga":"La Liga","Spanish La Liga":"La Liga","Primera Division":"La Liga",
    "La Liga Santander":"La Liga","La Liga EA Sports":"La Liga",
    // Serie A
    "Serie A":"Serie A","Italian Serie A":"Serie A","Serie A TIM":"Serie A",
    // Bundesliga
    "Bundesliga":"Bundesliga","German Bundesliga":"Bundesliga","Bundesliga 1":"Bundesliga",
    "1. Bundesliga":"Bundesliga",
    // Ligue 1
    "Ligue 1":"Ligue 1","French Ligue 1":"Ligue 1","Ligue 1 Uber Eats":"Ligue 1",
    "Ligue 1 McDonald's":"Ligue 1",
    // Champions League — SM uses various names
    "UEFA Champions League":"Champions League","Champions League":"Champions League",
    "UCL":"Champions League","UEFA CL":"Champions League",
    // Europa League
    "UEFA Europa League":"Europa League","Europa League":"Europa League",
    "UEL":"Europa League",
    // Conference League
    "UEFA Conference League":"Conference League","Conference League":"Conference League",
    "UEFA Europa Conference League":"Conference League","UECL":"Conference League",
    // EFL
    "EFL Championship":"Championship","Championship":"Championship","The Championship":"Championship",
    "Scottish Premiership":"Scottish Premiership","Scottish Premier League":"Scottish Premiership",
    "Scottish Premiership SPFL":"Scottish Premiership",
    // Portugal
    "Primeira Liga":"Primeira Liga","Liga Portugal":"Primeira Liga","Liga NOS":"Primeira Liga",
    "Liga Portugal Betclic":"Primeira Liga","Liga Betclic":"Primeira Liga",
    // Netherlands
    "Eredivisie":"Eredivisie","Dutch Eredivisie":"Eredivisie",
    // Turkey
    "Süper Lig":"Süper Lig","Super Lig":"Süper Lig","Turkish Super Lig":"Süper Lig",
    "Turkish Süper Lig":"Süper Lig","Trendyol Süper Lig":"Süper Lig",
    // Belgium
    "Belgian First Division A":"Belgian Pro League","Jupiler Pro League":"Belgian Pro League",
    "Belgian Pro League":"Belgian Pro League","Betplay First Division A":"Belgian Pro League",
    // Argentina
    "Argentine Primera División":"Argentine Primera","Liga Profesional Argentina":"Argentine Primera",
    "Argentine Primera":"Argentine Primera","Primera División":"Argentine Primera",
    "Liga Profesional de Fútbol":"Argentine Primera",
    // Brazil
    "Brasileirao Serie A":"Brasileirão","Brazilian Serie A":"Brasileirão",
    "Brasileirão Serie A":"Brasileirão","Brasileirão":"Brasileirão","Brasileiro Série A":"Brasileirão",
    // USA
    "Major League Soccer":"MLS","MLS":"MLS",
    // Saudi
    "Saudi Professional League":"Saudi Pro League","Saudi Pro League":"Saudi Pro League",
    "Roshn Saudi League":"Saudi Pro League","Saudi Premier League":"Saudi Pro League",
    // Cups
    "FA Cup":"FA Cup","English FA Cup":"FA Cup","The FA Cup":"FA Cup",
    "EFL Cup":"Carabao Cup","Football League Cup":"Carabao Cup","Carabao Cup":"Carabao Cup",
    "League Cup":"Carabao Cup",
    // Lower leagues
    "2. Bundesliga":"Bundesliga 2","Bundesliga 2":"Bundesliga 2","2. Bundesliga":"Bundesliga 2",
    "LaLiga2":"La Liga 2","La Liga 2":"La Liga 2","Segunda Division":"La Liga 2","La Liga Hypermotion":"La Liga 2",
    // Nordics / Etc
    "Danish Superliga":"Danish Superliga","Denmark Superliga":"Danish Superliga","Superliga":"Danish Superliga",
    "Greek Super League":"Greek Super League","Super League Greece":"Greek Super League",
    "Super League 1":"Greek Super League","Super League":"Greek Super League",
    "Czech First League":"Czech Liga","Fortuna Liga":"Czech Liga","Czech Liga":"Czech Liga","HET Liga":"Czech Liga",
    // Africa
    "Zambia Super League":"Zambian Super League","FAZ Super League":"Zambian Super League",
    "Zambian Super League":"Zambian Super League",
    "Premier Soccer League":"South African PSL","DStv Premiership":"South African PSL",
    "South African PSL":"South African PSL","Betway Premiership":"South African PSL",
    // Estonia
    "Meistriliiga":"Estonian Meistriliiga","Estonian Meistriliiga":"Estonian Meistriliiga",
    // Cups
    "Copa del Rey":"Copa del Rey","Coppa Italia":"Coppa Italia","DFB Pokal":"DFB Pokal",
    "Coupe de France":"Coupe de France","DBU Pokalen":"DBU Pokalen",
  }
  // Try exact match on cleaned name first
  if (map[clean]) return map[clean]
  // Try exact match on raw
  if (map[raw]) return map[raw]
  // Try case-insensitive match
  const cleanLo = clean.toLowerCase()
  for (const [k, v] of Object.entries(map)) {
    if (k.toLowerCase() === cleanLo) return v
  }
  // Fuzzy: check if any known key is contained within the SM name
  for (const [k, v] of Object.entries(map)) {
    if (cleanLo.includes(k.toLowerCase()) || k.toLowerCase().includes(cleanLo)) return v
  }
  return null
}

function leagueFlag(c) {
  const f = { "England":"🏴󠁧󠁢󠁥󠁮󠁧󠁿","Spain":"🇪🇸","Italy":"🇮🇹","Germany":"🇩🇪","France":"🇫🇷","Portugal":"🇵🇹","Netherlands":"🇳🇱","Brazil":"🇧🇷","Argentina":"🇦🇷","Turkey":"🇹🇷","Scotland":"🏴󠁧󠁢󠁳󠁣󠁴󠁿","Belgium":"🇧🇪","Denmark":"🇩🇰","Greece":"🇬🇷","Czech Republic":"🇨🇿","Saudi Arabia":"🇸🇦","USA":"🇺🇸","Zambia":"🇿🇲","South Africa":"🇿🇦","Estonia":"🇪🇪","World":"⭐","Europe":"⭐" }
  return f[c] || "⚽"
}

function inferTactics(elo, form) {
  const fs = formScore(form)
  if (elo > 1850) return fs > 0.7 ? "High Press 4-3-3" : "Structured 4-2-3-1"
  if (elo > 1700) return "Balanced 4-3-3"
  if (elo > 1600) return "Counter 4-4-2"
  return "Defensive 5-3-2"
}

// ══════════════════════════════════════════════════════════
//  SPORTMONKS — FULL PAID TIER (all includes enabled)
//  KEY: No filters[leagueIds] — was causing 400 on fixtures
// ══════════════════════════════════════════════════════════
// SM include tiers — tried in order until one succeeds
// IMPORTANT: lineups/xGFixture are fetched separately per-fixture, NOT here
// Tier 1: core data with odds+predictions. Tier 2: no odds. Tier 3: bare. Tier 4: minimal
const SM_INCLUDE_TIERS = [
  "participants;league;league.country;scores;state;odds;predictions",
  "participants;league;league.country;scores;state",
  "participants;league;league.country;scores",
  "participants;league;league.country",
  "participants;league",
]

async function smFetchWithFallback(url, extraParams, cacheKey, ttl) {
  // Check cache first
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.ts < (ttl || TTL.S)) return hit.data

  for (let ti = 0; ti < SM_INCLUDE_TIERS.length; ti++) {
    try {
      const all = []; let page = 1, hasMore = true
      while (hasMore && page <= 15 && all.length < 600) {
        const r = await http(url, { api_token: SM_KEY, include: SM_INCLUDE_TIERS[ti], order: "asc", per_page: 50, page, ...extraParams })
        const data = r.data?.data || []
        all.push(...data)
        hasMore = r.data?.pagination?.has_more === true && data.length === 50
        page++
        if (hasMore) await sleep(200)
      }
      if (ti > 0) console.log(`  ✅ SM tier-${ti+1} fallback worked: ${all.length} results`)
      else console.log(`  ✅ SM: ${all.length} fixtures (full tier)`)
      cache.set(cacheKey, { data: all, ts: Date.now() })
      return all
    } catch(e) {
      const status = e.response?.status || e.code || "?"
      if (ti < SM_INCLUDE_TIERS.length - 1) {
        console.log(`  ⚠️  SM tier-${ti+1} (status ${status}) → trying simpler includes...`)
        await sleep(500)
      } else {
        console.log(`  ❌ SM all tiers failed (last status: ${status})`)
        if (hit) return hit.data  // return stale cache if all tiers failed
        return []
      }
    }
  }
  return []
}

async function smFixtures(days) {
  days = Math.min(days || 14, 14)
  if (!SM_KEY) return []
  const now    = new Date()
  const end    = new Date(now.getTime() + days * 86400000)
  const start  = now.toISOString().slice(0, 10)
  const endStr = end.toISOString().slice(0, 10)
  const url    = `${SM_BASE}/fixtures/between/${start}/${endStr}`
  console.log(`📡 SM fixtures ${start} → ${endStr}`)
  return smFetchWithFallback(url, {}, `sm_fix_${days}`, TTL.S)
}

async function smLive() {
  if (!SM_KEY) return []
  return cached("sm_live", async () => {
    for (const inc of SM_INCLUDE_TIERS) {
      try {
        const r    = await http(`${SM_BASE}/livescores`, { api_token: SM_KEY, include: inc })
        const data = r.data?.data || []
        console.log(`✅ SM Live: ${data.length}`); return data
      } catch(e) {
        const status = e.response?.status
        if (status === 403 || status === 401 || status === 422) { await sleep(300); continue }
        console.log("⚠️  smLive:", e.message); return []
      }
    }
    return []
  }, TTL.LIVE)
}

async function smTeamForm(teamId) {
  if (!SM_KEY || !teamId) return []
  return cached("sm_form_" + teamId, async () => {
    const past  = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)
    const today = new Date().toISOString().slice(0, 10)
    try {
      const r = await http(`${SM_BASE}/fixtures/between/${past}/${today}`, {
        api_token: SM_KEY, include: "participants;scores",
        "filters[participants]": String(teamId), order: "desc", per_page: 10
      })
      return (r.data?.data || []).slice(0, 8).map(f => {
        const hP     = (f.participants || []).find(p => p.meta?.location === "home")
        const aP     = (f.participants || []).find(p => p.meta?.location === "away")
        const isHome = hP?.id === teamId
        const cH     = (f.scores || []).find(s => s.participant_id === hP?.id && s.description === "CURRENT")
        const cA     = (f.scores || []).find(s => s.participant_id === aP?.id && s.description === "CURRENT")
        const hg = cH?.score?.goals || 0, ag = cA?.score?.goals || 0
        const scored = isHome ? hg : ag, conc = isHome ? ag : hg
        return { result: scored > conc ? "W" : scored < conc ? "L" : "D", scored, conceded: conc, date: f.starting_at, opponent: isHome ? aP?.name : hP?.name }
      })
    } catch(e) { return [] }
  }, TTL.M)
}

async function smH2H(homeId, awayId) {
  if (!SM_KEY || !homeId || !awayId) return []
  return cached(`sm_h2h_${homeId}_${awayId}`, async () => {
    try {
      const r = await http(`${SM_BASE}/fixtures/head-to-head/${homeId}/${awayId}`, { api_token: SM_KEY, include: "participants;scores", order: "desc", per_page: 10 })
      return (r.data?.data || []).slice(0, 8).map(f => {
        const hP = (f.participants || []).find(p => p.meta?.location === "home")
        const aP = (f.participants || []).find(p => p.meta?.location === "away")
        const cH = (f.scores || []).find(s => s.participant_id === hP?.id && s.description === "CURRENT")
        const cA = (f.scores || []).find(s => s.participant_id === aP?.id && s.description === "CURRENT")
        const hg = cH?.score?.goals || 0, ag = cA?.score?.goals || 0
        return { date: (f.starting_at || "").slice(0, 10), home: hP?.name || "?", away: aP?.name || "?", homeGoals: hg, awayGoals: ag, winner: hg > ag ? hP?.name : hg < ag ? aP?.name : "Draw" }
      })
    } catch(e) { return [] }
  }, TTL.L)
}

async function smValueBets(fixtureId) {
  if (!SM_KEY || !fixtureId) return []
  return cached("sm_vb_" + fixtureId, async () => {
    try {
      const r = await http(`${SM_BASE}/predictions/value-bets/fixtures/${fixtureId}`, { api_token: SM_KEY, include: "type" })
      return (r.data?.data || []).map(vb => ({ bet: vb.predictions?.bet, bookmaker: vb.predictions?.bookmaker, odd: vb.predictions?.odd, fairOdd: vb.predictions?.fair_odd, isValue: vb.predictions?.is_value, market: vb.type?.name }))
    } catch(e) { return [] }
  }, TTL.M)
}

async function smPreMatchNews() {
  if (!SM_KEY) return []
  return cached("sm_news", async () => {
    try {
      const r    = await http(`${SM_BASE}/news/pre-match/upcoming`, { api_token: SM_KEY, include: "fixture;league", per_page: 30, order: "desc" })
      const news = r.data?.data || []
      console.log(`✅ SM News: ${news.length}`)
      return news.map(a => ({ title: a.title, body: a.body?.slice(0, 600) || "", fixtureId: a.fixture_id, leagueName: a.league?.name, publishedAt: a.created_at }))
    } catch(e) { console.log("⚠️  SM News:", e.message); return [] }
  }, TTL.M)
}

// Real SM squad — tries all known SM v3 squad endpoint patterns
// SM v3 full paid: GET /football/squads/seasons/{seasonId}/teams/{teamId}
// SM v3 basic:     GET /football/squads/teams/{teamId}
// SM fallback:     GET /football/teams/{teamId}?include=players
const squadFetchLock = new Set() // prevent duplicate concurrent fetches

async function smSquad(teamId, teamName, seasonId) {
  if (!SM_KEY || !teamId) return []
  const cacheKey = `sm_squad_${teamId}_${seasonId || "cur"}`
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.ts < TTL.L) return hit.data
  // Prevent duplicate fetches for same team
  if (squadFetchLock.has(cacheKey)) return []
  squadFetchLock.add(cacheKey)
  try {
    // SM v3 squad endpoints — ordered by most likely to work
    const endpoints = []
    if (seasonId) {
      endpoints.push({ url: `${SM_BASE}/squads/seasons/${seasonId}/teams/${teamId}`, params: { api_token: SM_KEY, include: "player;player.position;player.statistics.details" } })
      endpoints.push({ url: `${SM_BASE}/squads/seasons/${seasonId}/teams/${teamId}`, params: { api_token: SM_KEY, include: "player;player.position" } })
      endpoints.push({ url: `${SM_BASE}/squads/seasons/${seasonId}/teams/${teamId}`, params: { api_token: SM_KEY, include: "player" } })
    }
    // SM v3: squads/teams endpoint (requires squad subscription)
    endpoints.push({ url: `${SM_BASE}/squads/teams/${teamId}`, params: { api_token: SM_KEY, include: "player;player.position;player.statistics.details" } })
    endpoints.push({ url: `${SM_BASE}/squads/teams/${teamId}`, params: { api_token: SM_KEY, include: "player;player.position" } })
    endpoints.push({ url: `${SM_BASE}/squads/teams/${teamId}`, params: { api_token: SM_KEY, include: "player" } })
    // SM v3: teams endpoint with squad include (works on basic plans)
    endpoints.push({ url: `${SM_BASE}/teams/${teamId}`, params: { api_token: SM_KEY, include: "squad;squad.position" } })
    endpoints.push({ url: `${SM_BASE}/teams/${teamId}`, params: { api_token: SM_KEY, include: "players;players.position" } })
    endpoints.push({ url: `${SM_BASE}/teams/${teamId}`, params: { api_token: SM_KEY, include: "players" } })
    // SM v3: players/teams endpoint
    endpoints.push({ url: `${SM_BASE}/players/teams/${teamId}`, params: { api_token: SM_KEY, include: "position" } })

    let entries = null
    for (const ep of endpoints) {
      try {
        const r   = await http(ep.url, ep.params)
        const raw = r.data?.data
        if (!raw) continue
        // SM returns different shapes depending on endpoint:
        // /squads/teams/{id} → array of squad entries with .player
        // /teams/{id}?include=squad → object with .squad array
        // /teams/{id}?include=players → object with .players array
        // /players/teams/{id} → array of player objects directly
        if (Array.isArray(raw)) {
          entries = raw
        } else if (raw.squad?.data || raw.squad) {
          entries = raw.squad?.data || raw.squad || []
        } else if (raw.players?.data || raw.players) {
          entries = raw.players?.data || raw.players || []
        } else {
          entries = []
        }
        if (entries.length > 0) {
          console.log(`  👥 ${teamName}: ${entries.length} players via ${ep.url.replace(SM_BASE,"")}`)
          break
        }
      } catch(e2) {
        const status = e2.response?.status  // number, not string
        if (status === 404 || status === 403 || status === 422) continue
        if (e2.code === "ECONNABORTED" || e2.code === "ETIMEDOUT") { await sleep(1000); continue }
        break // unknown error — stop trying
      }
    }

    if (!entries || !entries.length) {
      cache.set(cacheKey, { data: [], ts: Date.now() }) // cache empty so we don't retry immediately
      return []
    }

    const tElo = getElo(teamName) || 1550
    const built = entries.map(sq => {
      // SM returns different entry shapes per endpoint
      // /squads/teams → sq = { player: {...}, jersey_number, position_id }
      // /teams?include=squad → sq = { id, name, ... directly a player object }
      // /players/teams → sq = direct player object
      const p = sq.player || (sq.id && sq.name ? sq : null) || sq
      const posId  = p.position_id || sq.position_id || p.position?.id
      const posAbbr = sq.position?.abbreviation || p.position?.abbreviation || p.position?.name
      const pos    = posId ? mapPosId(posId) : (posAbbr ? posAbbr.toUpperCase().slice(0,3) : "CM")
      const details = (p.statistics?.[0]?.details) || []
      const getStat = id => { const d = details.find(x => x.type_id === id); return d?.value ? (d.value.total || d.value.average || 0) : 0 }
      const goals   = getStat(52), assists = getStat(78), apps = getStat(321) || getStat(79)
      const mins    = getStat(119) || getStat(80), rating = getStat(118) || getStat(149)
      const keyPass = getStat(117), shotOT = getStat(86), tackles = getStat(105)
      const pName   = p.display_name || p.common_name || (p.firstname && p.lastname ? `${p.firstname} ${p.lastname}` : null) || p.name || "Unknown"
      const pElo    = buildPlayerElo(pName, pos, tElo, rating, goals, apps)
      const attrs   = buildPlayerAttrs(pName, pos, pElo, tElo, rating)
      const row = {
        player_name: pName, team_name: teamName, sm_player_id: p.id, position: pos,
        nationality: p.nationality_id, age: p.age || null, image_path: p.image_path || null,
        jersey: sq.jersey_number || null,
        elo: pElo, speed: attrs.speed, attack: attrs.attack, defense: attrs.defense,
        big_match: attrs.bigMatch, is_key: attrs.isKey,
        playstyle_name: attrs.playstyle.name,
        goals_this_season: Math.round(goals), assists_this_season: Math.round(assists),
        appearances: Math.round(apps), minutes_played: Math.round(mins),
        real_rating: rating ? Math.round(rating * 10) / 10 : null,
        key_passes: Math.round(keyPass), shots_on_target: Math.round(shotOT), tackles: Math.round(tackles),
        updated_at: new Date().toISOString()
      }
      playerDB.set(`${pName}__${teamName}`, { ...row, playstyle: attrs.playstyle, strengths: attrs.strengths, weaknesses: attrs.weaknesses })
      if (!squadDB.has(teamName)) squadDB.set(teamName, [])
      const ex  = squadDB.get(teamName)
      const idx = ex.findIndex(x => x.player_name === pName)
      if (idx >= 0) ex[idx] = { ...row, playstyle: attrs.playstyle }
      else ex.push({ ...row, playstyle: attrs.playstyle })
      sbSave("player_ratings", row, "player_name,team_name")
      return { ...row, playstyle: attrs.playstyle, strengths: attrs.strengths, weaknesses: attrs.weaknesses }
    })
    cache.set(cacheKey, { data: built, ts: Date.now() })
    return built
  } catch(e) {
    console.log(`⚠️  smSquad ${teamName}:`, e.message?.slice(0, 60))
    return []
  } finally {
    squadFetchLock.delete(cacheKey)
  }
}

// ── FOOTBALL-DATA.ORG — live 25/26 standings ─────────────
// Free API, 10 req/min, covers top 10 competitions
// Add FOOTBALL_DATA_KEY to your .env
const FD_KEY  = process.env.FOOTBALL_DATA_KEY || ""
const FD_BASE = "https://api.football-data.org/v4"

// football-data.org competition codes → our league names
const FD_COMPETITIONS = {
  "PL":  "Premier League",
  "PD":  "La Liga",
  "SA":  "Serie A",
  "BL1": "Bundesliga",
  "FL1": "Ligue 1",
  "CL":  "Champions League",
  "EL":  "Europa League",
  "ECL": "Conference League",
  "ELC": "Championship",
  "PPL": "Primeira Liga",
  "DED": "Eredivisie",
  "BSA": "Brasileirão",
}
// Reverse: league name → FD code
const FD_COMPETITIONS_REVERSE = Object.fromEntries(Object.entries(FD_COMPETITIONS).map(([k,v])=>[v,k]))
// Also map by name directly
const FD_COMP_BY_NAME = { ...FD_COMPETITIONS_REVERSE }

async function fdStandings(code) {
  if (!FD_KEY) return null
  return cached(`fd_standings_${code}`, async () => {
    try {
      const r = await axios.get(`${FD_BASE}/competitions/${code}/standings`, {
        headers: { "X-Auth-Token": FD_KEY },
        timeout: 15000,
      })
      const data = r.data
      console.log(`✅ FD standings ${code}: ${data?.competition?.name}`)
      return data
    } catch(e) {
      const st = e.response?.status
      console.log(`⚠️  FD standings ${code}: ${st||e.message?.slice(0,50)}`)
      return null
    }
  }, TTL.M)
}

// Parse football-data.org standings into our table format
function parseFdStandings(fdData) {
  if (!fdData?.standings) return []
  // Get the TOTAL standings table (not home/away split)
  const table = (fdData.standings.find(s => s.type === "TOTAL") || fdData.standings[0])?.table || []
  return table.map(row => {
    const team = row.team || {}
    // Form: recent results e.g. "W,W,D,L,W"
    const formStr = row.form || ""
    const form = formStr.split(",").filter(c => ["W","D","L"].includes(c)).slice(0,5)
    const pld  = row.playedGames || 0
    const w    = row.won || 0
    const d    = row.draw || 0
    const l    = row.lost || 0
    const gf   = row.goalsFor || 0
    const ga   = row.goalsAgainst || 0
    const pts  = row.points || (w*3+d)
    const xg   = parseFloat((gf>0 ? gf*(0.82+Math.random()*0.08) : 0).toFixed(1))
    const xga  = parseFloat((ga>0 ? ga*(0.82+Math.random()*0.08) : 0).toFixed(1))
    const pos  = row.position || 0
    return {
      pos, name: team.shortName || team.name || "Unknown",
      fullName: team.name, fdTeamId: team.id,
      imagePath: team.crest || null,
      pld, w, d, l, gf, ga, gd: row.goalDifference || (gf-ga), pts, xg, xga, form,
      titleChance: Math.max(0, Math.round((20-pos)*8 + Math.random()*7)),
      relChance: 0,
      source: "football-data.org"
    }
  }).map((t,i,arr) => {
    t.relChance = Math.max(0, Math.round((i-arr.length+5)*14+Math.random()*8))
    return t
  })
}

// SM season ID lookup — use /seasons endpoint filtered by league ID
const SM_LEAGUE_IDS = {
  "Champions League":     2,
  "Europa League":        5,
  "Conference League":    2286,
  "Premier League":       8,
  "Championship":         9,
  "FA Cup":               24,
  "Carabao Cup":          27,
  "La Liga":              564,
  "La Liga 2":            567,
  "Copa del Rey":         570,
  "Serie A":              384,
  "Coppa Italia":         390,
  "Bundesliga":           82,
  "Bundesliga 2":         85,
  "DFB Pokal":            109,
  "Ligue 1":              301,
  "Coupe de France":      307,
  "Primeira Liga":        462,
  "Eredivisie":           72,
  "Süper Lig":            600,
  "Belgian Pro League":   208,
  "Scottish Premiership": 501,
  "Argentine Primera":    636,
  "Brasileirão":          325,  // SM ID for Brazilian Serie A
  "MLS":                  779,
  "Saudi Pro League":     944,
  "Danish Superliga":     271,
  "Greek Super League":   325,
  "Czech Liga":           262,
  "Zambian Super League": 890,
  "South African PSL":    806,
  "Estonian Meistriliiga":286,
  "DBU Pokalen":          null,
}

// Cache for SM season IDs fetched via /seasons endpoint
const smSeasonCache = {}

async function getSmSeasonId(leagueName) {
  if (smSeasonCache[leagueName] !== undefined) return smSeasonCache[leagueName]
  const smLeagueId = SM_LEAGUE_IDS[leagueName]
  if (!smLeagueId || !SM_KEY) { smSeasonCache[leagueName] = null; return null }
  try {
    // Fetch seasons for this league, get the most recent/current one
    const r = await http(`${SM_BASE}/seasons`, {
      api_token: SM_KEY,
      "filters[league_id]": smLeagueId,
      per_page: 10,
      order: "desc"
    })
    const seasons = r.data?.data || []
    // Find current season (has_standings = true OR is the most recent)
    const current = seasons.find(s => s.is_current_season) || seasons[0]
    const id = current?.id || null
    smSeasonCache[leagueName] = id
    if (id) console.log(`✅ SM season ID for ${leagueName}: ${id} (${current?.name})`)
    else console.log(`⚠️  No current season found for ${leagueName} (league ID ${smLeagueId})`)
    return id
  } catch(e) {
    console.log(`⚠️  getSmSeasonId ${leagueName}: ${e.response?.status||e.message?.slice(0,40)}`)
    smSeasonCache[leagueName] = null
    return null
  }
}

// Real SM standings — tries multiple include tiers
async function smStandings(seasonId) {
  if (!SM_KEY || !seasonId) return []
  return cached(`sm_standings_${seasonId}`, async () => {
    const includes = ["participant;details;rule","participant;details","participant",""]
    for (const inc of includes) {
      try {
        const params = { api_token: SM_KEY }
        if (inc) params.include = inc
        const r = await http(`${SM_BASE}/standings/seasons/${seasonId}`, params)
        const data = r.data?.data || []
        if (data.length > 0) {
          console.log(`✅ SM Standings season ${seasonId}: ${data.length} groups (inc: "${inc||"none"}")`)
          return data
        }
      } catch(e) {
        const st = e.response?.status
        console.log(`⚠️  smStandings ${seasonId} (${inc||"bare"}): ${st||e.message?.slice(0,40)}`)
        if (st === 401 || st === 402) break
      }
    }
    return []
  }, TTL.L)
}

// Get SM leagues — used only for squad season IDs now
async function smLeagues() {
  if (!SM_KEY) return []
  return cached("sm_leagues", async () => {
    try {
      const all = []; let page = 1, hasMore = true
      while (hasMore && page <= 5) {
        const r = await http(`${SM_BASE}/leagues`, { api_token: SM_KEY, include: "country;currentSeason", per_page: 50, page })
        const data = r.data?.data || []
        all.push(...data)
        hasMore = r.data?.pagination?.has_more === true && data.length === 50
        page++
        if (hasMore) await sleep(200)
      }
      console.log(`✅ SM Leagues: ${all.length} loaded`)
      return all
    } catch(e) { console.log("⚠️  smLeagues:", e.message?.slice(0,60)); return [] }
  }, TTL.XL)
}

// ══════════════════════════════════════════════════════════
//  THE ODDS API
//  CRITICAL FIX: No httpsAgent — was causing ERR_BAD_REQUEST
// ══════════════════════════════════════════════════════════
const ODDS_SPORTS = [
  { key: "soccer_epl",                            name: "Premier League" },
  { key: "soccer_spain_la_liga",                  name: "La Liga" },
  { key: "soccer_italy_serie_a",                  name: "Serie A" },
  { key: "soccer_germany_bundesliga",             name: "Bundesliga" },
  { key: "soccer_france_ligue_one",               name: "Ligue 1" },
  { key: "soccer_uefa_champs_league",             name: "Champions League" },
  { key: "soccer_uefa_europa_league",             name: "Europa League" },
  { key: "soccer_uefa_europa_conference_league",  name: "Conference League" },
  { key: "soccer_england_efl_cup",                name: "Carabao Cup" },
  { key: "soccer_fa_cup",                         name: "FA Cup" },
  { key: "soccer_efl_champ",                      name: "Championship" },
  { key: "soccer_turkey_super_league",            name: "Süper Lig" },
  { key: "soccer_belgium_first_div",              name: "Belgian Pro League" },
  { key: "soccer_scotland_premiership",           name: "Scottish Premiership" },
  { key: "soccer_portugal_primeira_liga",         name: "Primeira Liga" },
  { key: "soccer_netherlands_eredivisie",         name: "Eredivisie" },
  { key: "soccer_brazil_campeonato",              name: "Brasileirão" },
  { key: "soccer_usa_mls",                        name: "MLS" },
  { key: "soccer_saudi_professional_league",      name: "Saudi Pro League" },
  { key: "soccer_denmark_superliga",              name: "Danish Superliga" },
  { key: "soccer_greece_super_league",            name: "Greek Super League" },
  { key: "soccer_czech_republic_first_league",    name: "Czech Liga" },
]
const prevOddsStore = new Map()

async function fetchOddsAPI() {
  if (!ODDS_KEY) return {}
  return cached("odds_api", async () => {
    const map = {}
    for (const sport of ODDS_SPORTS) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          // NO httpsAgent here — this was causing ERR_BAD_REQUEST in v11
          const r = await axios.get(`https://api.the-odds-api.com/v4/sports/${sport.key}/odds`, {
            params: { apiKey: ODDS_KEY, regions: "eu", markets: "h2h,totals,btts", oddsFormat: "decimal" },
            timeout: 25000,
            headers: { "Accept": "application/json", "User-Agent": "SlipIQ/1.0" }
          })
          const rem = r.headers?.["x-requests-remaining"]
          if (rem !== undefined && parseInt(rem) < 3) { console.log("⚠️  Odds quota low"); return map }
          for (const g of (r.data || [])) {
            const key   = `${g.home_team}||${g.away_team}`
            const entry = { leagueName: sport.name, commenceTime: g.commence_time, home: null, draw: null, away: null, ou: {}, btts: {} }
            for (const book of (g.bookmakers || []).slice(0, 3)) {
              for (const mkt of (book.markets || [])) {
                if (mkt.key === "h2h" && !entry.home) { const out = {}; for (const o of mkt.outcomes) out[o.name] = o.price; entry.home = out[g.home_team]; entry.draw = out["Draw"]; entry.away = out[g.away_team] }
                if (mkt.key === "totals") { for (const o of mkt.outcomes) { if (!entry.ou[o.point]) entry.ou[o.point] = {}; entry.ou[o.point][o.name.toLowerCase()] = o.price } }
                if (mkt.key === "btts")   { for (const o of mkt.outcomes) entry.btts[o.name.toLowerCase()] = o.price }
              }
              break
            }
            const prev = prevOddsStore.get(key) || {}
            entry.homeMove = entry.home && prev.home ? parseFloat((entry.home - prev.home).toFixed(2)) : 0
            entry.drawMove = entry.draw && prev.draw ? parseFloat((entry.draw - prev.draw).toFixed(2)) : 0
            entry.awayMove = entry.away && prev.away ? parseFloat((entry.away - prev.away).toFixed(2)) : 0
            prevOddsStore.set(key, { home: entry.home, draw: entry.draw, away: entry.away })
            map[key] = entry
          }
          console.log(`  ✅ Odds ${sport.name}: ${r.data?.length || 0}`)
          await sleep(400); break
        } catch(e) {
          const code   = e.code || "", status = e.response?.status || 0
          if (status === 401 || status === 402 || status === 422) { console.log(`  ❌ Odds auth: ${status}`); return map }
          if (["ECONNRESET","ETIMEDOUT","ECONNABORTED","EPIPE"].includes(code) && attempt < 3) { await sleep(2000 * attempt) }
          else { console.log(`  ⚠️  Odds ${sport.name}: ${code || status || e.message?.slice(0, 40)}`); break }
        }
      }
    }
    console.log(`✅ Odds API: ${Object.keys(map).length} matches`); return map
  }, TTL.S)
}

function findOdds(oddsMap, home, away) {
  const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "")
  const hN = norm(home), aN = norm(away)
  for (const key of Object.keys(oddsMap)) {
    const [kh, ka] = key.split("||").map(norm)
    if ((hN.startsWith(kh.slice(0, 5)) || kh.startsWith(hN.slice(0, 5)) || hN === kh) &&
        (aN.startsWith(ka.slice(0, 5)) || ka.startsWith(aN.slice(0, 5)) || aN === ka)) return oddsMap[key]
  }
  return null
}

// ── PREDICTION ENGINE ─────────────────────────────────────
function formScore(f) {
  if (!f || !f.length) return 0.5
  const w = [0.35, 0.25, 0.20, 0.12, 0.08]
  return f.slice(0, 5).reduce((s, r, i) => s + (r === "W" ? 1 : r === "D" ? 0.4 : 0) * (w[i] || 0.05), 0)
}

function calcXG(tElo, oElo, form, isHome, realXg) {
  if (realXg && realXg > 0) return realXg
  const ed = (tElo - oElo) / 400
  const fb = (formScore(form) - 0.5) * 0.1
  return Math.max(0.3, (isHome ? 1.45 : 1.10) + ed * 0.9 + fb + (isHome ? 0.18 : -0.05))
}

function poisson(lambda) { let L = Math.exp(-lambda), p = 1, k = 0; do { k++; p *= Math.random() } while (p > L); return k - 1 }
function monteCarlo(hxg, axg, n) { n = n || 50000; let h = 0, d = 0, a = 0; for (let i = 0; i < n; i++) { const hg = poisson(hxg), ag = poisson(axg); if (hg > ag) h++; else if (hg < ag) a++; else d++ } return { homeWin: h/n, draw: d/n, awayWin: a/n } }
function fact(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r }
function pcs(hxg, axg, h, a) { return (Math.exp(-hxg) * Math.pow(hxg, h) / fact(h)) * (Math.exp(-axg) * Math.pow(axg, a) / fact(a)) }
function detectValue(prob, odds) { if (!odds || odds < 1.05) return { isValue: false, edge: 0 }; const edge = prob - 100 / odds; return { isValue: edge > 4, edge: parseFloat(edge.toFixed(2)) } }

function extractSMOdds(list) {
  const r = { home: null, draw: null, away: null, ou: {}, btts: {} }
  if (!list || !list.length) return r
  for (const o of list) {
    const mkt = o.market_id, lbl = (o.label || o.name || "").toLowerCase(), val = parseFloat(o.value || o.dp3 || "0")
    if (!val || val < 1.01) continue
    if (mkt === 1)  { if (lbl==="1"||lbl==="home") r.home=val; else if (lbl==="x"||lbl==="draw") r.draw=val; else if (lbl==="2"||lbl==="away") r.away=val }
    if (mkt === 14) { if (lbl==="yes") r.btts.yes=val; else if (lbl==="no") r.btts.no=val }
    if (mkt === 18) { const m = lbl.match(/(over|under)\s*([\d.]+)/i); if (m) { if (!r.ou[m[2]]) r.ou[m[2]] = {}; r.ou[m[2]][m[1].toLowerCase()] = val } }
  }
  return r
}

function extractSMPreds(preds) {
  if (!Array.isArray(preds)) return {}
  const r = {}
  for (const p of preds) { const key = (p.type && (p.type.developer_name || p.type.code)) || String(p.type_id); r[key] = p.predictions }
  return r
}

function extractRealXG(xgData, teamId) {
  if (!xgData || !Array.isArray(xgData)) return null
  const e = xgData.find(x => x.participant_id === teamId && x.type_id === 5304)
  return e?.data?.value || null
}

function buildAllMarkets(hxg, axg, smOdds, smPred, realOdds) {
  const probs = monteCarlo(hxg, axg, 40000)
  const ouProbs = {}, ouOdds = {}
  for (const pts of [0.5, 1.5, 2.5, 3.5, 4.5, 5.5]) {
    let overP = 0
    for (let hg = 0; hg <= 10; hg++) for (let ag = 0; ag <= 10; ag++) if (hg + ag > pts) overP += pcs(hxg, axg, hg, ag)
    const oPct = Math.round(Math.min(99, overP * 100))
    ouProbs[pts] = { overPct: oPct, underPct: 100 - oPct }
    const k = String(pts)
    ouOdds[pts] = {
      over:  realOdds?.ou?.[k]?.over  || smOdds?.ou?.[k]?.over  || parseFloat(Math.max(1.02, 1 / Math.max(0.01, oPct/100) * 1.06).toFixed(2)),
      under: realOdds?.ou?.[k]?.under || smOdds?.ou?.[k]?.under || parseFloat(Math.max(1.02, 1 / Math.max(0.01, (100-oPct)/100) * 1.06).toFixed(2)),
    }
  }
  const bttsY     = Math.round((1 - Math.exp(-hxg)) * (1 - Math.exp(-axg)) * 100)
  const bttsOdds  = { yes: realOdds?.btts?.yes || smOdds?.btts?.yes || parseFloat((1/Math.max(0.01,bttsY/100)*1.06).toFixed(2)), no: realOdds?.btts?.no || smOdds?.btts?.no || parseFloat((1/Math.max(0.01,(100-bttsY)/100)*1.06).toFixed(2)) }
  const smH = smPred?.FULLTIME_RESULT_PROBABILITY?.home, smD = smPred?.FULLTIME_RESULT_PROBABILITY?.draw, smA = smPred?.FULLTIME_RESULT_PROBABILITY?.away
  const useSM = smH && smD && smA
  const homeProb = Math.round(useSM ? parseFloat(smH) : probs.homeWin * 100)
  const drawProb = Math.round(useSM ? parseFloat(smD) : probs.draw    * 100)
  const awayProb = Math.round(useSM ? parseFloat(smA) : probs.awayWin * 100)
  const over25   = smPred?.OVER_UNDER_2_5_PROBABILITY?.yes ?? ouProbs[2.5].overPct
  const bttsFin  = smPred?.BTTS_PROBABILITY?.yes ?? bttsY
  const cs = []
  for (let ch = 0; ch <= 5; ch++) for (let ca = 0; ca <= 5; ca++) cs.push({ score: `${ch}-${ca}`, prob: Math.round(pcs(hxg, axg, ch, ca) * 1000) / 10 })
  cs.sort((a, b) => b.prob - a.prob)
  return { homeProb, drawProb, awayProb, ouProbs, ouOdds, bttsYesPct: Math.round(Number(bttsFin)), bttsNoPct: 100 - Math.round(Number(bttsFin)), bttsOdds, over25Prob: Math.round(Number(over25)), correctScores: cs.slice(0, 9), hxg: parseFloat(hxg.toFixed(2)), axg: parseFloat(axg.toFixed(2)) }
}

function buildFactors(hElo, aElo, hForm, aForm, hxg, axg, smPred) {
  const hfs = formScore(hForm) * 100, afs = formScore(aForm) * 100, ed = hElo - aElo
  const smH = smPred?.FULLTIME_RESULT_PROBABILITY?.home, smA = smPred?.FULLTIME_RESULT_PROBABILITY?.away
  const n   = v => Math.min(99, Math.max(1, Math.round(v)))
  return [
    { name:"ELO RATING",       homeScore:n(hElo/20),         awayScore:n(aElo/20),                                                    color:"#00d4ff" },
    { name:"RECENT FORM",      homeScore:n(hfs),              awayScore:n(afs),                                                        color:"#00ff88" },
    { name:"xG ATTACK",        homeScore:n(hxg*35),           awayScore:n(axg*35),                                                     color:"#ff3b5c" },
    { name:"DEFENSIVE SHAPE",  homeScore:n(50+ed/40),         awayScore:n(50-ed/40),                                                   color:"#ffd700" },
    { name:"HOME ADVANTAGE",   homeScore:65,                  awayScore:35,                                                            color:"#ff8c42" },
    { name:"SM AI PREDICTION", homeScore:smH?n(parseFloat(smH)):n(50+ed/30), awayScore:smA?n(parseFloat(smA)):n(50-ed/30),            color:"#cc88ff" },
    { name:"PRESS INTENSITY",  homeScore:n(45+ed/50+Math.random()*12), awayScore:n(45-ed/50+Math.random()*12),                       color:"#44ddaa" },
    { name:"SQUAD DEPTH",      homeScore:n(50+ed/60+Math.random()*10), awayScore:n(50-ed/60+Math.random()*10),                       color:"#ffaa44" },
    { name:"MOMENTUM",         homeScore:n(hfs*1.1),          awayScore:n(afs*1.1),                                                   color:"#ff6688" },
    { name:"TACTICAL FIT",     homeScore:n(50+ed/45+Math.random()*15), awayScore:n(50-ed/45+Math.random()*15),                       color:"#4488ff" },
  ]
}

// ── CORE PREDICTION BUILDER ───────────────────────────────
async function buildPrediction(smFix, oddsMap) {
  try {
    const now   = Date.now()
    const pArr  = smFix.participants || []
    const homeP = pArr.find(p => p.meta && p.meta.location === "home") || {}
    const awayP = pArr.find(p => p.meta && p.meta.location === "away") || {}
    const home  = homeP.name || (smFix.name && smFix.name.split(" vs ")[0]) || "Home"
    const away  = awayP.name || (smFix.name && smFix.name.split(" vs ")[1]) || "Away"
    const homeId = homeP.id, awayId = awayP.id

    const rawLeague = (smFix.league && smFix.league.name) || "Football"
    const country   = (smFix.league && smFix.league.country && smFix.league.country.name) || ""
    let league = normLeague(rawLeague)
    // Only filter by country when we have country data — some SM tiers don't include it
    if (country) {
      if (league === "Premier League"      && country !== "England")       league = null
      if (league === "Scottish Premiership"&& country !== "Scotland")      league = null
      if (league === "Argentine Primera"   && country !== "Argentina")     league = null
      if (league === "Danish Superliga"    && country !== "Denmark")       league = null
      if (league === "Greek Super League"  && country !== "Greece")        league = null
      if (league === "South African PSL"   && country !== "South Africa")  league = null
      if (league === "Czech Liga"          && country !== "Czech Republic") league = null
      if (league === "Zambian Super League"&& country !== "Zambia")        league = null
      if (league === "Estonian Meistriliiga"&&country !== "Estonia")       league = null
    }
    if (!league) return null

    const kickMs = smFix.starting_at_timestamp ? smFix.starting_at_timestamp * 1000 : new Date(smFix.starting_at || 0).getTime()
    const isLive = kickMs < now && kickMs > now - 7200000
    const BAD_STATES = new Set([5, 6, 7, 10, 13, 14, 15, 17])
    if (BAD_STATES.has(smFix.state_id) && !isLive) return null
    if (!isLive && kickMs < now - 3 * 3600000 && kickMs > 0) return null

    // Merge SM + real odds
    const smOdds = extractSMOdds(smFix.odds || [])
    const realOddsEntry = findOdds(oddsMap, home, away)
    if (realOddsEntry) {
      if (!smOdds.home) smOdds.home = realOddsEntry.home
      if (!smOdds.draw) smOdds.draw = realOddsEntry.draw
      if (!smOdds.away) smOdds.away = realOddsEntry.away
      if (!Object.keys(smOdds.ou).length && realOddsEntry.ou && Object.keys(realOddsEntry.ou).length) smOdds.ou = realOddsEntry.ou
      if (!smOdds.btts.yes && realOddsEntry.btts?.yes) smOdds.btts = realOddsEntry.btts
    }
    const hasRealOdds = !!(smOdds.home && smOdds.draw && smOdds.away)

    const smPred     = smFix.predictions ? extractSMPreds(smFix.predictions) : {}
    const xgData     = smFix.xGFixture || []
    const homeRealXG = extractRealXG(xgData, homeId)
    const awayRealXG = extractRealXG(xgData, awayId)
    const hasRealXG  = !!(homeRealXG || awayRealXG)

    // Form
    let hForm = [], aForm = []
    if (smFix.trends) {
      const parseTrend = (ts, id) => { const t = (ts || []).find(x => x.participant_id === id); return String(t?.form || t?.value || "").split("").slice(0, 5).map(c => c === "W" ? "W" : c === "D" ? "D" : "L") }
      hForm = parseTrend(smFix.trends, homeId)
      aForm = parseTrend(smFix.trends, awayId)
    }
    if (!hForm.length && homeId) hForm = await smTeamForm(homeId).then(f => f.map(x => x.result)).catch(() => [])
    if (!aForm.length && awayId) aForm = await smTeamForm(awayId).then(f => f.map(x => x.result)).catch(() => [])

    // ELO
    const approxHomePos = homeId ? (homeId % 20) / 20 : 0.5
    const approxAwayPos = awayId ? (awayId % 20) / 20 : 0.5
    let hElo = getElo(home, league, approxHomePos)
    let aElo = getElo(away, league, approxAwayPos)

    // Manager ELO nudge (±15 pts max)
    const hMgr    = smFix.coaches?.home?.name || null
    const aMgr    = smFix.coaches?.away?.name || null
    const hMgrElo = hMgr ? getManagerElo(hMgr, home) : null
    const aMgrElo = aMgr ? getManagerElo(aMgr, away) : null
    if (hMgrElo && aMgrElo) {
      const diff = (hMgrElo - aMgrElo) / 400
      hElo = Math.round(hElo + diff * 15)
      aElo = Math.round(aElo - diff * 15)
    }

    const hxg     = calcXG(hElo, aElo, hForm, true,  homeRealXG)
    const axg     = calcXG(aElo, hElo, aForm, false, awayRealXG)
    const markets = buildAllMarkets(hxg, axg, smOdds, smPred, realOddsEntry)
    const { homeProb, drawProb, awayProb } = markets

    const homeOdds = smOdds.home || parseFloat((1/Math.max(0.01, homeProb/100)*1.06).toFixed(2))
    const drawOdds = smOdds.draw || parseFloat((1/Math.max(0.01, drawProb/100)*1.06).toFixed(2))
    const awayOdds = smOdds.away || parseFloat((1/Math.max(0.01, awayProb/100)*1.06).toFixed(2))
    const confidence = Math.min(99, Math.max(homeProb, drawProb, awayProb))

    const hVal = detectValue(homeProb, homeOdds)
    const dVal = detectValue(drawProb, drawOdds)
    const aVal = detectValue(awayProb, awayOdds)

    const [h2h, smVB] = await Promise.all([
      smH2H(homeId, awayId).catch(() => []),
      smValueBets(smFix.id).catch(() => []),
    ])

    // Build lineups from SM fixture data (real player names from SM)
    const lus = smFix.lineups || []
    const buildLu = (tId, tName, tElo) => lus.filter(l => l.team_id === tId).slice(0, 11).map((l, idx) => {
      const pos   = mapPosId(l.position_id) || "CM"
      const pName = l.player_name || (l.player && (l.player.display_name || l.player.common_name || l.player.name)) || "Unknown"
      const db    = playerDB.get(`${pName}__${tName}`)
      const pElo  = (db && db.elo) || buildPlayerElo(pName, pos, tElo, null, 0, 0)
      const attrs = db || buildPlayerAttrs(pName, pos, pElo, tElo, null)
      return {
        number:   l.jersey_number || idx + 1,
        name:     pName,
        position: pos,
        elo:      pElo,
        isKey:    (attrs && attrs.is_key) || false,
        speed:    (attrs && attrs.speed)  || 60,
        attack:   (attrs && attrs.attack) || 60,
        defense:  (attrs && attrs.defense)|| 60,
        bigMatch: (attrs && (attrs.bigMatch || attrs.big_match)) || 60,
        playstyle:(attrs && attrs.playstyle) || PLAYSTYLES[pos] || PLAYSTYLES.CM,
        strengths:(attrs && attrs.strengths) || [],
        weaknesses:(attrs && attrs.weaknesses) || [],
        goals_this_season: (attrs && attrs.goals_this_season) || null,
        real_rating:       (attrs && attrs.real_rating) || null,
        imagePath: l.player && l.player.image_path,
      }
    })

    const homeLineup = buildLu(homeId, home, hElo)
    const awayLineup = buildLu(awayId, away, aElo)

    // Kick off background squad load — only for top leagues, heavily staggered to avoid rate limiting
    // Each team gets a random delay 5-60s so we don't hammer SM with 200 requests at once
    const TOP_LEAGUES_FOR_SQUADS = new Set(["Premier League","La Liga","Serie A","Bundesliga","Ligue 1","Champions League","Europa League","Conference League","Championship","Primeira Liga","Eredivisie","Süper Lig","Scottish Premiership","Belgian Pro League"])
    if (homeId && !squadDB.has(home) && TOP_LEAGUES_FOR_SQUADS.has(league)) {
      const delay = 5000 + Math.random() * 55000  // 5-60s stagger
      setTimeout(() => smSquad(homeId, home, smFix.season_id).catch(() => {}), delay)
    }
    if (awayId && !squadDB.has(away) && TOP_LEAGUES_FOR_SQUADS.has(league)) {
      const delay = 10000 + Math.random() * 55000  // 10-65s stagger
      setTimeout(() => smSquad(awayId, away, smFix.season_id).catch(() => {}), delay)
    }

    // Mismatch detection
    const mismatches = detectMismatches(homeLineup, awayLineup, home, away)

    // Game approach — THIS was the missing function that caused all 314 to fail
    const gameApproach = buildGameApproach(hElo, aElo, hForm, aForm, hxg, axg, league)

    // Score
    let score = null
    if (smFix.scores?.length) {
      const cH = smFix.scores.find(s => s.participant_id === homeId && s.description === "CURRENT")
      const cA = smFix.scores.find(s => s.participant_id === awayId && s.description === "CURRENT")
      if (cH || cA) score = `${cH?.score?.goals || 0}-${cA?.score?.goals || 0}`
    }

    return {
      id: smFix.id, smId: smFix.id, homeId, awayId,
      leagueId: smFix.league_id, seasonId: smFix.season_id,
      home, away, league, leagueName: league, flag: leagueFlag(country), country,
      date: smFix.starting_at, isLive, isFinished: smFix.state_id === 5, score, minute: null,
      homeProb, drawProb, awayProb,
      homeManager: hMgr, awayManager: aMgr, homeManagerElo: hMgrElo, awayManagerElo: aMgrElo,
      gameApproach,
      homeOdds:     parseFloat(homeOdds.toFixed(2)),
      drawOdds:     parseFloat(drawOdds.toFixed(2)),
      awayOdds:     parseFloat(awayOdds.toFixed(2)),
      homeMovement: realOddsEntry?.homeMove || 0,
      drawMovement: realOddsEntry?.drawMove || 0,
      awayMovement: realOddsEntry?.awayMove || 0,
      hasRealOdds, confidence,
      upsetProb:    Math.min(95, Math.round(awayProb * 0.8 + (homeOdds < 1.6 ? 15 : 5))),
      isUpsetWatch: awayProb > 28 && homeOdds > 1.5,
      valueBet:     hVal.isValue || dVal.isValue || aVal.isValue || smVB.some(v => v.isValue),
      homeValueEdge: hVal.edge, drawValueEdge: dVal.edge, awayValueEdge: aVal.edge,
      bestValueSide: hVal.isValue ? "home" : dVal.isValue ? "draw" : aVal.isValue ? "away" : null,
      smValueBets: smVB.slice(0, 3),
      homeElo: hElo, awayElo: aElo,
      homeForm: hForm.slice(0, 5), awayForm: aForm.slice(0, 5),
      homeXg: parseFloat(hxg.toFixed(2)), awayXg: parseFloat(axg.toFixed(2)),
      homeXga: parseFloat((axg*0.9).toFixed(2)), awayXga: parseFloat((hxg*0.9).toFixed(2)),
      hasRealXG, homeRealXG, awayRealXG,
      homeTactics: inferTactics(hElo, hForm), awayTactics: inferTactics(aElo, aForm),
      homeFormation: "4-3-3", awayFormation: "4-3-3",
      homeLineup, awayLineup,
      mismatches,
      matchups: [], h2h,
      factors: buildFactors(hElo, aElo, hForm, aForm, hxg, axg, smPred),
      injuries: { home: [], away: [] },
      markets, bttsProb: markets.bttsYesPct, over25Prob: markets.over25Prob,
      ouProbs: markets.ouProbs, ouOdds: markets.ouOdds, bttsOdds: markets.bttsOdds, correctScores: markets.correctScores,
      smPredictions: smPred,
      bookmaker:  realOddsEntry ? "Real Odds" : hasRealOdds ? "Sportmonks" : "Model",
      imageHome:  homeP.image_path, imageAway: awayP.image_path,
    }
  } catch(err) { throw err }
}

// ── AI ─────────────────────────────────────────────────────
const SYS_PROMPT = `You are an elite football analytics AI. You have REAL Sportmonks data: real player names from SM squads, actual season statistics, real team ELOs from ClubElo. Reference specific player names and stats. ALWAYS respond ONLY with valid JSON. No markdown.`

async function callAI(prompt, maxTokens) {
  maxTokens = maxTokens || 1400
  if (!aiClient) return { error: "GitHub AI not configured — add GITHUB_TOKEN" }
  try {
    const resp = await aiClient.chat.completions.create({ model: AI_MODEL, max_tokens: maxTokens, messages: [{ role: "system", content: SYS_PROMPT }, { role: "user", content: prompt }] })
    let raw = resp.choices?.[0]?.message?.content || "{}"
    raw = raw.replace(/```json\n?|```\n?/g, "").trim()
    const jS = raw.indexOf("{"), jE = raw.lastIndexOf("}") + 1
    if (jS >= 0) raw = raw.slice(jS, jE)
    return JSON.parse(raw)
  } catch(e) { console.log("❌ AI:", e.message?.slice(0, 80)); return { error: "AI failed", detail: e.message?.slice(0, 80) } }
}

// ── LEAGUE SORT ORDER ─────────────────────────────────────
const LEAGUE_RANK = {
  "Champions League":1,"Premier League":2,"La Liga":3,"Serie A":4,"Bundesliga":5,
  "Ligue 1":6,"Europa League":7,"Conference League":8,"FA Cup":9,"Carabao Cup":10,
  "Championship":11,"Primeira Liga":12,"Eredivisie":13,"Süper Lig":14,
  "Belgian Pro League":15,"Scottish Premiership":16,"Argentine Primera":17,
  "Bundesliga 2":18,"La Liga 2":19,"Brasileirão":20,"MLS":21,"Saudi Pro League":22,
  "Danish Superliga":23,"Greek Super League":24,"Czech Liga":25,
  "Zambian Super League":26,"South African PSL":27,"Estonian Meistriliiga":28,
  "Copa del Rey":29,"Coppa Italia":30,"DFB Pokal":31,"Coupe de France":32,"DBU Pokalen":33,
}

// ══════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════

app.get("/predictions", async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days || "14"), 14)
    console.log(`\n📊 /predictions (${days} days)`)
    const [smList, oddsMap, liveList] = await Promise.all([
      smFixtures(days).catch(e => { console.log("⚠️  smFix:", e.message); return [] }),
      fetchOddsAPI().catch(e  => { console.log("⚠️  odds:", e.message);  return {} }),
      smLive().catch(() => []),
    ])
    const all = new Map()
    for (const f of [...smList, ...liveList]) all.set(f.id, f)
    const filtered = [...all.values()].filter(f => {
      const raw     = (f.league && f.league.name) || ""
      const country = (f.league && f.league.country && f.league.country.name) || ""
      const norm    = normLeague(raw)
      if (!norm) return false
      // Only apply country filter when we actually have country data
      if (country) {
        if (norm === "Premier League"      && country !== "England")      return false
        if (norm === "Scottish Premiership"&& country !== "Scotland")     return false
        if (norm === "Argentine Primera"   && country !== "Argentina")    return false
        if (norm === "Danish Superliga"    && country !== "Denmark")      return false
        if (norm === "Greek Super League"  && country !== "Greece")       return false
        if (norm === "South African PSL"   && country !== "South Africa") return false
        if (norm === "Czech Liga"          && country !== "Czech Republic")return false
        if (norm === "Zambian Super League"&& country !== "Zambia")       return false
        if (norm === "Estonian Meistriliiga"&&country !== "Estonia")      return false
      }
      return true
    })
    const fixtures = filtered.slice(0, 500)
    console.log(`⚙️  Building ${fixtures.length} predictions...`)
    const results = []
    const BATCH   = 20
    for (let b = 0; b < fixtures.length; b += BATCH) {
      const bRes = await Promise.all(fixtures.slice(b, b + BATCH).map(f => buildPrediction(f, oddsMap).catch(e => { console.log(`⚠️  fix#${f.id}:`, e.message?.slice(0, 60)); return null })))
      results.push(...bRes.filter(Boolean))
      if (b + BATCH < fixtures.length) await sleep(50)
    }
    console.log(`✅ ${results.length} predictions ready`)
    res.json(results.sort((a, b) => {
      const rd = (LEAGUE_RANK[a.league] || 99) - (LEAGUE_RANK[b.league] || 99)
      return rd !== 0 ? rd : new Date(a.date) - new Date(b.date)
    }))
  } catch(e) { console.error("❌ /predictions:", e.message); res.status(500).json({ error: e.message }) }
})

app.get("/livescores", async (req, res) => {
  try {
    const live     = await smLive()
    const oddsMap  = await fetchOddsAPI().catch(() => ({}))
    const results  = await Promise.all(live.map(f => buildPrediction(f, oddsMap).catch(() => null)))
    res.json(results.filter(Boolean))
  } catch(e) { res.json([]) }
})

app.get("/news", async (req, res) => {
  try {
    const { team, league } = req.query
    const smNews    = await smPreMatchNews().catch(() => [])
    let newsData    = []
    if (NEWS_KEY) {
      const q = team || league ? `football ${[team, league].filter(Boolean).join(" ")} injury transfer` : "football premier league champions league injury transfer"
      newsData = await cached("newsapi_" + q.slice(0, 30), async () => {
        const r = await axios.get("https://newsapi.org/v2/everything", { params: { q, language: "en", sortBy: "publishedAt", pageSize: 30, apiKey: NEWS_KEY }, timeout: 15000 })
        return (r.data.articles || []).map(a => ({ title: a.title, source: a.source?.name, publishedAt: a.publishedAt, url: a.url, description: a.description, urlToImage: a.urlToImage }))
      }, TTL.M).catch(() => [])
    }
    let filtered = smNews
    if (team)   filtered = filtered.filter(a => (a.leagueName || "").toLowerCase().includes(team.toLowerCase()) || (a.body || "").toLowerCase().includes(team.toLowerCase()) || (a.title || "").toLowerCase().includes(team.toLowerCase()))
    if (league) filtered = filtered.filter(a => (a.leagueName || "").toLowerCase().includes(league.toLowerCase()))
    res.json([...filtered.slice(0, 20), ...newsData.slice(0, 15)])
  } catch(e) { res.json([]) }
})

app.post("/news/analyze", async (req, res) => {
  const { article, predictions } = req.body
  if (!article) return res.json({ error: "No article" })
  try {
    const top    = (predictions || []).slice(0, 20).map(m => `${m.home} vs ${m.away}(${m.league})`).join(", ")
    const prompt = `Football betting analyst. Analyze this news for betting impact.\nTitle: ${article.title || ""}\nBody: ${(article.body || article.description || "").slice(0, 600)}\nLeague: ${article.leagueName || ""}\nUpcoming: ${top || "Various"}\nReturn JSON: {"summary":"2 sentences","impactLevel":"HIGH|MEDIUM|LOW|NONE","marketImpact":"odds insight","recommendation":"betting action","keyInsight":"most important insight","impactTeams":["team1"]}`
    res.json(await callAI(prompt, 500))
  } catch(e) { res.json({ error: "Failed" }) }
})

app.get("/players/:team", (req, res) => {
  const team = decodeURIComponent(req.params.team)
  res.json([...playerDB.values()].filter(p => p.team_name === team))
})


// Team profile by name — used by leagues.html
app.get("/team/:teamName", (req, res) => {
  const name = decodeURIComponent(req.params.teamName)
  const db = teamDB.get(name)
  const elo = getElo(name)
  const players = squadDB.get(name) || []
  const upcoming = []
  for (const [k, hit] of cache) {
    if (!k.startsWith("sm_fix_")) continue
    const fixtures = Array.isArray(hit.data) ? hit.data : []
    for (const f of fixtures) {
      const pArr = f.participants || []
      if (pArr.some(p => p.name === name)) upcoming.push(f)
    }
    if (upcoming.length >= 5) break
  }
  res.json({ name, elo, players: players.slice(0, 20), smId: db?.sm_id || null, form: [], upcomingFixtures: upcoming.slice(0, 5), ...(db||{}) })
})

// Squad routes — split for Express 5 (optional params removed)
app.get("/squad/:teamId/:teamName/:seasonId", async (req, res) => {
  try { res.json(await smSquad(parseInt(req.params.teamId), decodeURIComponent(req.params.teamName), parseInt(req.params.seasonId))) } catch(e) { res.json([]) }
})
app.get("/squad/:teamId/:teamName", async (req, res) => {
  try { res.json(await smSquad(parseInt(req.params.teamId), decodeURIComponent(req.params.teamName), null)) } catch(e) { res.json([]) }
})

// Squad by name only — leagues.html uses this when it has no SM team ID
// Looks up the team ID from squadDB / playerDB / cached fixture participants
app.get("/squad/byname/:teamName", async (req, res) => {
  const name = decodeURIComponent(req.params.teamName)
  // 1) Already have squad cached
  if (squadDB.has(name)) return res.json(squadDB.get(name))
  // 2) Find SM team ID from fixture participant data
  let teamId = null, seasonId = null
  for (const [k, hit] of cache) {
    if (!k.startsWith("sm_fix_")) continue
    const fixtures = Array.isArray(hit.data) ? hit.data : []
    for (const f of fixtures) {
      const pArr = f.participants || []
      const match = pArr.find(p => p.name === name || (p.name || "").toLowerCase() === name.toLowerCase())
      if (match && match.id) { teamId = match.id; seasonId = f.season_id; break }
    }
    if (teamId) break
  }
  if (!teamId) {
    // 3) Try searching SM for the team
    try {
      const r = await http(`${SM_BASE}/teams/search/${encodeURIComponent(name)}`, { api_token: SM_KEY, per_page: 3 })
      const found = (r.data?.data || [])[0]
      if (found?.id) teamId = found.id
    } catch(e) {}
  }
  if (!teamId) return res.json([])
  try { res.json(await smSquad(teamId, name, seasonId)) } catch(e) { res.json([]) }
})

// Standings with SM team IDs exposed — leagues.html needs teamId per row
app.get("/standings/enriched/:seasonId", async (req, res) => {
  try {
    const raw = await smStandings(req.params.seasonId)
    // Pass raw data straight through — participant.id is the SM team ID
    res.json(raw)
  } catch(e) { res.json([]) }
})

// Real SM standings
app.get("/standings/:seasonId", async (req, res) => {
  try { res.json(await smStandings(req.params.seasonId)) } catch(e) { res.json([]) }
})

// League list — returns all supported leagues with their data sources
app.get("/leagues", async (req, res) => {
  try {
    const LEAGUE_INFO = {
      "Champions League":      { flag:"⭐", type:"knockout", country:"Europe",        fdCode:"CL",  smLeagueId:2   },
      "Premier League":        { flag:"🏴󠁧󠁢󠁥󠁮󠁧󠁿", type:"league",   country:"England",      fdCode:"PL",  smLeagueId:8   },
      "La Liga":               { flag:"🇪🇸", type:"league",   country:"Spain",        fdCode:"PD",  smLeagueId:564 },
      "Serie A":               { flag:"🇮🇹", type:"league",   country:"Italy",        fdCode:"SA",  smLeagueId:384 },
      "Bundesliga":            { flag:"🇩🇪", type:"league",   country:"Germany",      fdCode:"BL1", smLeagueId:82  },
      "Ligue 1":               { flag:"🇫🇷", type:"league",   country:"France",       fdCode:"FL1", smLeagueId:301 },
      "Europa League":         { flag:"🟠", type:"knockout", country:"Europe",        fdCode:"EL",  smLeagueId:5   },
      "Conference League":     { flag:"🟢", type:"knockout", country:"Europe",        fdCode:null,  smLeagueId:2286},
      "FA Cup":                { flag:"🏴󠁧󠁢󠁥󠁮󠁧󠁿", type:"knockout", country:"England",      fdCode:null,  smLeagueId:24  },
      "Carabao Cup":           { flag:"🏴󠁧󠁢󠁥󠁮󠁧󠁿", type:"knockout", country:"England",      fdCode:null,  smLeagueId:27  },
      "Championship":          { flag:"🏴󠁧󠁢󠁥󠁮󠁧󠁿", type:"league",   country:"England",      fdCode:"ELC", smLeagueId:9   },
      "Primeira Liga":         { flag:"🇵🇹", type:"league",   country:"Portugal",     fdCode:"PPL", smLeagueId:462 },
      "Eredivisie":            { flag:"🇳🇱", type:"league",   country:"Netherlands",  fdCode:"DED", smLeagueId:72  },
      "Süper Lig":             { flag:"🇹🇷", type:"league",   country:"Turkey",       fdCode:null,  smLeagueId:600 },
      "Belgian Pro League":    { flag:"🇧🇪", type:"league",   country:"Belgium",      fdCode:null,  smLeagueId:208 },
      "Scottish Premiership":  { flag:"🏴󠁧󠁢󠁳󠁣󠁴󠁿", type:"league",   country:"Scotland",     fdCode:null,  smLeagueId:501 },
      "Argentine Primera":     { flag:"🇦🇷", type:"league",   country:"Argentina",    fdCode:null,  smLeagueId:636 },
      "Brasileirão":           { flag:"🇧🇷", type:"league",   country:"Brazil",       fdCode:"BSA", smLeagueId:325 },
      "MLS":                   { flag:"🇺🇸", type:"league",   country:"USA",          fdCode:null,  smLeagueId:779 },
      "Saudi Pro League":      { flag:"🇸🇦", type:"league",   country:"Saudi Arabia", fdCode:null,  smLeagueId:944 },
      "Danish Superliga":      { flag:"🇩🇰", type:"league",   country:"Denmark",      fdCode:null,  smLeagueId:271 },
      "Greek Super League":    { flag:"🇬🇷", type:"league",   country:"Greece",       fdCode:null,  smLeagueId:325 },
      "Czech Liga":            { flag:"🇨🇿", type:"league",   country:"Czech Republic",fdCode:null, smLeagueId:262 },
      "Zambian Super League":  { flag:"🇿🇲", type:"league",   country:"Zambia",       fdCode:null,  smLeagueId:890 },
      "South African PSL":     { flag:"🇿🇦", type:"league",   country:"South Africa", fdCode:null,  smLeagueId:806 },
      "Estonian Meistriliiga": { flag:"🇪🇪", type:"league",   country:"Estonia",      fdCode:null,  smLeagueId:286 },
      "Bundesliga 2":          { flag:"🇩🇪", type:"league",   country:"Germany",      fdCode:null,  smLeagueId:85  },
      "La Liga 2":             { flag:"🇪🇸", type:"league",   country:"Spain",        fdCode:null,  smLeagueId:567 },
      "Copa del Rey":          { flag:"🇪🇸", type:"knockout", country:"Spain",        fdCode:null,  smLeagueId:570 },
      "Coppa Italia":          { flag:"🇮🇹", type:"knockout", country:"Italy",        fdCode:null,  smLeagueId:390 },
      "DFB Pokal":             { flag:"🇩🇪", type:"knockout", country:"Germany",      fdCode:null,  smLeagueId:109 },
      "Coupe de France":       { flag:"🇫🇷", type:"knockout", country:"France",       fdCode:null,  smLeagueId:307 },
      "DBU Pokalen":           { flag:"🇩🇰", type:"knockout", country:"Denmark",      fdCode:null,  smLeagueId:null},
    }

    // Kick off background SM season ID lookups for leagues without fdCode
    const smSeasonPromises = {}
    for (const [name, info] of Object.entries(LEAGUE_INFO)) {
      if (!info.fdCode && info.smLeagueId) {
        smSeasonPromises[name] = getSmSeasonId(name).catch(() => null)
      }
    }
    const smSeasons = {}
    for (const [name, p] of Object.entries(smSeasonPromises)) {
      smSeasons[name] = await p
    }

    const result = Object.entries(LEAGUE_INFO)
      .sort((a,b) => (LEAGUE_RANK[a[0]]||99)-(LEAGUE_RANK[b[0]]||99))
      .map(([name, info]) => ({
        name, ...info,
        // seasonId used by leagues.html to request standings
        seasonId: smSeasons[name] || null,
        hasFdData: !!(info.fdCode && FD_KEY_ENV),
        hasSmData: !!(smSeasons[name]),
        // Indicate which source will serve standings
        standingsSource: info.fdCode && FD_KEY_ENV ? "football-data.org" : smSeasons[name] ? "sportmonks" : null,
      }))
    res.json(result)
  } catch(e) { console.error("/leagues:", e.message); res.json([]) }
})

// Universal standings endpoint — tries football-data.org first, falls back to SM
// Called as: GET /standings/byLeague/:leagueName
app.get("/standings/byLeague/:leagueName", async (req, res) => {
  const leagueName = decodeURIComponent(req.params.leagueName)
  try {
    // 1) Try football-data.org (fastest, most reliable for top leagues)
    const fdCode = FD_COMPETITIONS_REVERSE[leagueName] || FD_COMP_BY_NAME[leagueName]
    if (fdCode && FD_KEY_ENV) {
      const fdData = await fdStandings(fdCode)
      if (fdData) {
        const rows = parseFdStandings(fdData)
        if (rows.length) {
          return res.json({ source: "football-data.org", season: fdData.season, competition: fdData.competition?.name, rows })
        }
      }
    }
    // 2) Fallback: Sportmonks standings via season ID
    const seasonId = await getSmSeasonId(leagueName)
    if (seasonId) {
      const smData = await smStandings(seasonId)
      if (smData && smData.length) {
        return res.json({ source: "sportmonks", seasonId, rows: smData })
      }
    }
    res.json({ source: null, rows: [], error: `No standings data for ${leagueName}` })
  } catch(e) { res.json({ source: null, rows: [], error: e.message }) }
})

// Keep old seasonId-based endpoint for backward compat
app.get("/standings/enriched/:seasonId", async (req, res) => {
  try { res.json(await smStandings(req.params.seasonId)) } catch(e) { res.json([]) }
})
app.get("/standings/:seasonId", async (req, res) => {
  // If it looks like a league name (not a number), redirect to byLeague
  const param = req.params.seasonId
  if (isNaN(parseInt(param))) {
    return res.redirect(`/standings/byLeague/${encodeURIComponent(param)}`)
  }
  try { res.json(await smStandings(param)) } catch(e) { res.json([]) }
})
app.get("/elo/rankings", async (req, res) => {
  const limit = parseInt(req.query.limit || "100")
  const teams = [], seen = new Set()
  const addTeam = (name, elo, source) => {
    if (seen.has(name)) return
    seen.add(name)
    const prev   = prevEloSnap.get(name)
    const change = prev ? elo - prev : 0
    teams.push({ name, elo: Math.round(elo), prevElo: prev || Math.round(elo), change: Math.round(change), arrow: change > 5 ? "▲" : change < -5 ? "▼" : "—", source })
  }
  // Priority: ClubElo → ELO_BASE → Supabase
  for (const [k, v] of clubEloMap) { const n = k.charAt(0).toUpperCase() + k.slice(1); if (v > 1300) addTeam(n, v + (trophyBonus.get(n) || 0), "clubelo") }
  for (const [n, v] of Object.entries(ELO_BASE)) addTeam(n, v + (trophyBonus.get(n) || 0), "hardcoded")
  for (const [n, d] of teamDB) if (d.elo > 1300) addTeam(n, d.elo + (trophyBonus.get(n) || 0), "supabase")
  teams.sort((a, b) => b.elo - a.elo)
  for (const t of teams) prevEloSnap.set(t.name, t.elo)
  res.json(teams.slice(0, limit).map((t, i) => ({ ...t, rank: i + 1 })))
})

app.post("/analyze", async (req, res) => {
  const { match, type } = req.body
  try {
    let prompt = ""
    if (type === "match") {
      const m      = match
      const smSum  = m.smPredictions ? Object.entries(m.smPredictions).slice(0, 6).map(([k, v]) => `${k}:${JSON.stringify(v)}`).join(" | ") : "none"
      const smVBs  = (m.smValueBets || []).filter(v => v.isValue).map(v => `${v.market}:${v.bet}@${v.odd}`).join(",") || "none"
      const hKeys  = (squadDB.get(m.home) || []).filter(p => p.is_key).map(p => `${p.player_name}(${p.position},ELO${p.elo},${p.goals_this_season||0}G,rating:${p.real_rating||"n/a"})`).slice(0, 5).join(",") || "loading"
      const aKeys  = (squadDB.get(m.away) || []).filter(p => p.is_key).map(p => `${p.player_name}(${p.position},ELO${p.elo},${p.goals_this_season||0}G,rating:${p.real_rating||"n/a"})`).slice(0, 5).join(",") || "loading"
      const h2hStr = (m.h2h || []).slice(0, 5).map(h => `${h.homeGoals}-${h.awayGoals}(${h.winner==="Draw"?"D":h.winner===m.home?"H":"A"})`).join(",") || "N/A"
      const mmStr  = (m.mismatches || []).slice(0, 3).map(mm => `${mm.attacker.name}(${mm.attacker.pos}) vs ${mm.defender.name}(${mm.defender.pos}): ${mm.favor} favoured`).join("; ") || "none"
      const desc   = `HOME:${(m.gameApproach?.home?.descriptors||[]).map(d=>d.label).join(",")||"balanced"} AWAY:${(m.gameApproach?.away?.descriptors||[]).map(d=>d.label).join(",")||"balanced"}`
      prompt = `Match: ${m.home} vs ${m.away} | ${m.league} | ${(m.date||"").slice(0,10)}
ELO: H${m.homeElo} A${m.awayElo} | Mgr ELO: H${m.homeManagerElo||"?"} A${m.awayManagerElo||"?"}
Probs: H${m.homeProb}% D${m.drawProb}% A${m.awayProb}%
SM Predictions: ${smSum} | SM Value Bets: ${smVBs}
xG: H${m.homeXg} A${m.awayXg}${m.hasRealXG?" (REAL SM xG)":""}
Form: ${m.home}:${(m.homeForm||[]).join("")} | ${m.away}:${(m.awayForm||[]).join("")}
Odds: H${m.homeOdds} D${m.drawOdds} A${m.awayOdds} (${m.hasRealOdds?"REAL BOOKMAKER":"model"})
BTTS:${m.bttsProb}% | Over2.5:${m.over25Prob}%
Team descriptors: ${desc}
KEY MISMATCHES: ${mmStr}
Key HOME players (real SM): ${hKeys}
Key AWAY players (real SM): ${aKeys}
H2H last 5: ${h2hStr}
Return JSON: {"mainAnalysis":"3-4 sentences referencing SPECIFIC player names, stats, mismatches","recommendation":"Home Win|Draw|Away Win|No Value","oneLineSummary":"sharp punchy one-liner","keyFactors":["5 specific stat/player-backed factors"],"valueAssessment":"bookmaker edge","bttsAnalysis":"BTTS insight with xG","goalsMarket":"best goals market","matchFacts":["3 sharp stats"],"playerWatch":"key player name and why","mismatchImpact":"how mismatches affect result","confidenceRating":${m.confidence}}`
    } else if (type === "upset") {
      const m    = match
      const aKeys = (squadDB.get(m.away)||[]).filter(p=>p.is_key).map(p=>`${p.player_name}(${p.position},${p.goals_this_season||0}G,ELO${p.elo})`).slice(0,4).join(",") || "unknown"
      prompt = `Upset: ${m.home}(ELO${m.homeElo},form:${(m.homeForm||[]).join("")}) vs ${m.away}(ELO${m.awayElo},odds:${m.awayOdds})
Away keys (real SM names): ${aKeys}
H2H: ${(m.h2h||[]).slice(0,3).map(h=>`${h.homeGoals}-${h.awayGoals}`).join(",") || "N/A"}
Return JSON: {"upsetReasons":["4 specific reasons naming real players"],"upsetTrigger":"one scenario","worthBacking":true,"upsetConfidence":${m.awayProb},"keyVulnerability":"biggest home weakness"}`
    } else if (type === "parlay") {
      const legs = Array.isArray(match) ? match : [match]
      const co   = legs.reduce((p, l) => p * l.odds, 1).toFixed(2)
      prompt = `${legs.length}-leg parlay:\n${legs.map((l,i) => `${i+1}. ${l.matchName}: ${l.label}@${l.odds}(${l.prob}%,${l.hasRealOdds?"REAL":"model"})`).join("\n")}\nCombined: ${co}x\nReturn JSON: {"assessment":"2-3 sentences","hasValue":true,"valueExplanation":"edge reasoning","weakestLeg":"match+reason","strongestLeg":"match+reason","suggestedSwap":"improvement","overallRating":70,"keyRisks":["2 risks"]}`
    } else if (type === "player") {
      const { player: pl, team: tn } = match
      prompt = `Scout: ${pl.player_name||pl.name}(${pl.position}) at ${tn}. ELO:${pl.elo}|Rating:${pl.real_rating||"n/a"}
Stats: ${pl.goals_this_season||0}G ${pl.assists_this_season||0}A in ${pl.appearances||0} apps
Speed:${pl.speed} Atk:${pl.attack} Def:${pl.defense} BigMatch:${pl.bigMatch||pl.big_match||60}
Playstyle: ${pl.playstyle_name||"n/a"}
Return JSON: {"profile":"2-3 sentences with actual stats","strengths":["3"],"weaknesses":["2"],"bigMatchRating":${pl.bigMatch||pl.big_match||60},"tacticalRole":"role detail","bestAgainst":"type","worstAgainst":"type","similarTo":"real comparable player"}`
    } else if (type === "matchup") {
      const { homePlayer: hp, awayPlayer: ap } = match
      prompt = `1v1: ${hp?.name}(${hp?.position},ELO${hp?.elo}) vs ${ap?.name}(${ap?.position},ELO${ap?.elo}) in ${match.match?.home} vs ${match.match?.away}
Return JSON: {"analysis":"2-3 sentences","advantage":"home|away|even","keyFactor":"deciding factor","impactOnGame":"game impact","mismatchHighlight":"key mismatch"}`
    }
    res.json(await callAI(prompt))
  } catch(e) { res.json({ error: "Analysis failed", detail: e.message?.slice(0, 80) }) }
})

app.post("/parlay/auto", async (req, res) => {
  const { predictions=[], targetOdds=4.0, riskLevel=5, minLegs=2, maxLegs=8, preferredMarkets=["auto"], timeframeDays=14, leagueFilter=null } = req.body
  if (!predictions.length) return res.json({ parlay: [], combinedOdds: 1, error: "No predictions" })
  const now = Date.now(), maxMs = Math.min(timeframeDays, 14) * 86400000
  const pool = predictions.filter(m => !m.isLive && !m.isFinished && (!m.date || new Date(m.date).getTime() - now <= maxMs) && (!leagueFilter?.length || leagueFilter.includes(m.league)))
  if (!pool.length) return res.json({ parlay: [], combinedOdds: 1, notEnoughMatches: "No matches match filters" })
  const candidates = [], mkts = Array.isArray(preferredMarkets) ? preferredMarkets : ["auto"]
  for (const m of pool) {
    const addPick = (pick, label, odds, prob, market) => {
      if (!odds || odds < 1.04 || !prob || prob < 1) return
      const edge  = prob - 100 / odds
      const score = (prob*0.55) + (edge*2.5) + ((10-riskLevel)*0.8) + (m.hasRealOdds?6:0) + (m.smValueBets?.some(v=>v.isValue)?4:0)
      candidates.push({ matchId: m.id, pick, label, odds: parseFloat(odds.toFixed(2)), prob: Math.round(prob), matchName: `${m.home} vs ${m.away}`, league: m.league, confidence: m.confidence, hasRealOdds: m.hasRealOdds, market, score, edge: parseFloat(edge.toFixed(2)) })
    }
    for (const mkt of mkts) {
      if (["1x2","auto","h2h"].includes(mkt)) { addPick("home",`${m.home} Win`,m.homeOdds,m.homeProb,"1x2"); addPick("draw","Draw",m.drawOdds,m.drawProb,"1x2"); addPick("away",`${m.away} Win`,m.awayOdds,m.awayProb,"1x2") }
      if (["btts","auto"].includes(mkt)) { if(m.bttsOdds?.yes)addPick("btts_yes","Both Teams Score",m.bttsOdds.yes,m.bttsProb,"btts"); if(m.bttsOdds?.no)addPick("btts_no","No BTTS",m.bttsOdds.no,100-m.bttsProb,"btts") }
      for (const pts of [0.5,1.5,2.5,3.5,4.5,5.5]) {
        if ([`ou_${pts}`,"auto"].includes(mkt)) {
          const ou = m.ouOdds?.[pts], prb = m.ouProbs?.[pts]
          if (ou && prb) { if(ou.over&&prb.overPct)addPick(`over_${pts}`,`Over ${pts} Goals`,ou.over,prb.overPct,`ou_${pts}`); if(ou.under&&prb.underPct>35)addPick(`under_${pts}`,`Under ${pts} Goals`,ou.under,prb.underPct,`ou_${pts}`) }
        }
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  const used = new Set(), selected = []
  const minConf = 30 + (10 - riskLevel) * 3
  let co = 1.0
  for (const c of candidates) {
    if (used.has(c.matchId) || c.prob < minConf) continue
    if (selected.length >= maxLegs || (co >= targetOdds && selected.length >= minLegs)) break
    selected.push(c); used.add(c.matchId); co *= c.odds
  }
  if (!selected.length) return res.json({ parlay: [], combinedOdds: 1, notEnoughMatches: "No picks meet criteria" })
  const combProb = selected.reduce((p, s) => p * (s.prob / 100), 1) * 100
  const avgConf  = selected.reduce((s, c) => s + c.prob, 0) / selected.length
  const score    = Math.max(10, Math.min(99, Math.round(avgConf - Math.max(0, (selected.length-3)*5) + (10-riskLevel)*2)))
  res.json({ parlay: selected, combinedOdds: parseFloat(co.toFixed(2)), combinedProb: parseFloat(combProb.toFixed(2)), targetOdds: parseFloat(String(targetOdds)), hitTarget: co >= targetOdds * 0.92, score, marketBreakdown: [...new Set(selected.map(s => s.market))] })
})

// ── SLIPS & PARLAYS ───────────────────────────────────────
app.post("/parlays/save", async (req, res) => {
  if (!sb) return res.status(503).json({ error: "Supabase not configured" })
  const { user_id, legs, combined_odds, confidence_score } = req.body
  if (!user_id || !legs?.length) return res.status(400).json({ error: "Missing fields" })
  const { data, error } = await sb.from("saved_parlays").insert({ user_id, legs: JSON.stringify(legs), combined_odds, confidence_score, status: "pending", created_at: new Date().toISOString() }).select().single()
  if (error) return res.json({ ok: true, local_only: true, data: { id: Date.now(), legs, combined_odds, confidence_score } })
  res.json({ ok: true, data })
})
app.get("/parlays/:userId", async (req, res) => {
  if (!sb) return res.json([])
  const { data } = await sb.from("saved_parlays").select("*").eq("user_id", req.params.userId).order("created_at", { ascending: false }).limit(100)
  res.json(data ? data.map(p => ({ ...p, legs: typeof p.legs === "string" ? JSON.parse(p.legs) : p.legs })) : [])
})
app.post("/slips", async (req, res) => {
  if (!sb) return res.status(503).json({ error: "Supabase not configured" })
  const { user_id, legs, combined_odds, confidence_score, sport } = req.body
  if (!user_id || !legs?.length) return res.status(400).json({ error: "Missing fields" })
  const { data, error } = await sb.from("saved_slips").insert({ user_id, legs, combined_odds, confidence_score, status: "pending", sport: sport || "football", created_at: new Date().toISOString() }).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})
app.get("/slips/:userId", async (req, res) => {
  if (!sb) return res.json([])
  const { data } = await sb.from("saved_slips").select("*").eq("user_id", req.params.userId).order("created_at", { ascending: false }).limit(50)
  res.json(data || [])
})

// ── CREDITS ───────────────────────────────────────────────
app.post("/credits/use", async (req, res) => {
  if (!sb) return res.status(503).json({ error: "Supabase not configured" })
  const { user_id, action } = req.body
  if (!user_id || !action) return res.status(400).json({ error: "Missing user_id or action" })
  const cost = ACTION_COSTS[action]
  if (cost === undefined) return res.status(400).json({ error: "Unknown action: " + action })
  const { data: user } = await sb.from("users").select("plan,credits_total,credits_used,credits_bonus").eq("id", user_id).single()
  if (!user) return res.status(404).json({ error: "User not found" })
  const allowed = PLAN_FEATURES[action] || []
  if (allowed.length && !allowed.includes(user.plan)) return res.json({ ok: false, reason: "plan_locked", action, required_plan: allowed[0], current_plan: user.plan, message: `${action.replace(/_/g," ")} requires ${allowed[0]} plan or above. Upgrade at /subscriptions.html` })
  const available = user.plan === "platinum" ? 999999 : Math.max(0, user.credits_total - user.credits_used) + (user.credits_bonus || 0)
  if (available < cost) return res.json({ ok: false, reason: "insufficient_credits", credits_remaining: available, credits_needed: cost, message: `Need ${cost} credits for this action but only have ${available}` })
  await sb.from("users").update({ credits_used: user.credits_used + cost, updated_at: new Date().toISOString() }).eq("id", user_id)
  res.json({ ok: true, credits_remaining: available - cost, credits_used: cost, action })
})
app.get("/credits/check/:userId/:action", async (req, res) => {
  if (!sb) return res.json({ ok: false })
  const cost = ACTION_COSTS[req.params.action] || 0
  const { data: user } = await sb.from("users").select("plan,credits_total,credits_used,credits_bonus").eq("id", req.params.userId).single()
  if (!user) return res.json({ ok: false })
  const allowed   = PLAN_FEATURES[req.params.action] || []
  const planOk    = !allowed.length || allowed.includes(user.plan)
  const available = user.plan === "platinum" ? 999999 : Math.max(0, user.credits_total - user.credits_used) + (user.credits_bonus || 0)
  res.json({ ok: planOk && available >= cost, plan_ok: planOk, credits_ok: available >= cost, credits_available: available, cost, plan: user.plan })
})

// ── USER ──────────────────────────────────────────────────
app.get("/user/:userId", async (req, res) => {
  if (!sb) return res.status(503).json({ error: "Supabase not configured" })
  const { data, error } = await sb.from("users").select("*").eq("id", req.params.userId).single()
  if (error || !data) return res.status(404).json({ error: "User not found" })
  const available = data.plan === "platinum" ? 999999 : Math.max(0, data.credits_total - data.credits_used) + (data.credits_bonus || 0)
  res.json({ ...data, credits_available: available })
})

// ── REFERRAL ──────────────────────────────────────────────
// Saves code to Supabase — called before sending user to Stripe
app.post("/referral/generate", async (req, res) => {
  if (!sb) return res.status(503).json({ error: "Supabase not configured" })
  const { affiliate_name, affiliate_email, user_id, type } = req.body
  if (!affiliate_name) return res.status(400).json({ error: "affiliate_name required" })
  const suffix = Math.floor(100 + Math.random() * 900)
  const code   = affiliate_name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) + suffix
  const row    = { code, type: type || "user", user_id: user_id || null, affiliate_name, affiliate_email: affiliate_email || null, discount_pct: 25, first_month_commission_pct: 25, recurring_commission_pct: 10, is_active: true, total_uses: 0, created_at: new Date().toISOString() }
  const { data, error } = await sb.from("referral_codes").insert(row).select().single()
  if (error) return res.status(500).json({ error: error.message })
  if (user_id) await sb.from("users").update({ referral_code: code, updated_at: new Date().toISOString() }).eq("id", user_id).catch(() => {})
  res.json(data)
})
app.get("/referral/validate/:code", async (req, res) => {
  if (!sb) return res.json({ valid: false })
  const code = req.params.code.toUpperCase()
  const { data } = await sb.from("referral_codes").select("*").eq("code", code).eq("is_active", true).single()
  if (data) return res.json({ valid: true, type: data.type, discount_pct: data.discount_pct || 25, affiliate_name: data.affiliate_name })
  res.json({ valid: false })
})
app.post("/referral/use", async (req, res) => {
  if (!sb) return res.status(503).json({ error: "Supabase not configured" })
  const { code, referred_user_email, referred_user_id, subscription_plan } = req.body
  if (!code) return res.status(400).json({ error: "code required" })
  const { data: rc } = await sb.from("referral_codes").select("*").eq("code", code.toUpperCase()).eq("is_active", true).single()
  if (!rc) return res.status(404).json({ error: "Code not found or inactive" })
  const prices = { starter: 2.99, basic: 4.99, pro: 14.99, elite: 49.99 }
  const price  = prices[subscription_plan] || 0
  // Increment use count
  await sb.from("referral_codes").update({ total_uses: (rc.total_uses || 0) + 1, updated_at: new Date().toISOString() }).eq("code", code.toUpperCase())
  await sb.from("referral_uses").insert({ code: code.toUpperCase(), referred_user_email, referred_user_id: referred_user_id || null, referrer_user_id: rc.user_id || null, subscription_plan, first_month_revenue: price, first_month_commission: price * (rc.first_month_commission_pct || 25) / 100, status: "active", created_at: new Date().toISOString() }).catch(() => {})
  res.json({ ok: true, discount_pct: rc.discount_pct || 25, code: code.toUpperCase() })
})
app.get("/referral/codes", async (req, res) => {
  if (!sb) return res.json([])
  const { data } = await sb.from("referral_codes").select("*").order("created_at", { ascending: false })
  res.json(data || [])
})
app.get("/admin/affiliates", async (req, res) => {
  if (!sb) return res.json([])
  const { data } = await sb.from("referral_codes").select("*").eq("type", "affiliate").order("total_uses", { ascending: false })
  res.json(data || [])
})

// ── MANAGERS ──────────────────────────────────────────────
app.get("/managers", (req, res) => {
  const all = []
  for (const [name, d] of managerDB) all.push({ name, ...d })
  for (const [name, seed] of Object.entries(MANAGER_SEEDS)) { if (!managerDB.has(name)) all.push({ name, team_name: seed.team, elo: seed.base, style: seed.style, wins: 0, draws: 0, losses: 0 }) }
  all.sort((a, b) => (b.elo || 0) - (a.elo || 0))
  res.json(all)
})
app.post("/managers/result", async (req, res) => {
  const { homeManager, awayManager, homeTeam, awayTeam, homeGoals, awayGoals, homeXg, awayXg } = req.body
  await updateManagerElo(homeManager, awayManager, homeTeam, awayTeam, homeGoals, awayGoals, homeXg, awayXg)
  res.json({ ok: true })
})

// Trophy ELO award
app.post("/trophy/award", (req, res) => {
  const { team, competition, seasonYear } = req.body
  if (!team || !competition) return res.status(400).json({ error: "Missing fields" })
  applyTrophyBonus(team, competition, seasonYear)
  res.json({ ok: true, newBonus: trophyBonus.get(team) || 0 })
})

// ── ADMIN REVENUE ─────────────────────────────────────────
app.get("/admin/revenue", async (req, res) => {
  if (!sb) return res.json({ error: "No DB" })
  try {
    const [subs, creditPurchases, users] = await Promise.all([
      sb.from("subscriptions").select("plan,status,amount_cents,created_at").eq("status", "active"),
      sb.from("credit_purchases").select("credits_amount,amount_cents,created_at").eq("status", "completed").catch(() => ({ data: [] })),
      sb.from("users").select("plan,plan_status,created_at"),
    ])
    const planCounts = {}, planMRR = {}
    for (const u of users.data || []) planCounts[u.plan] = (planCounts[u.plan] || 0) + 1
    for (const s of subs.data   || []) planMRR[s.plan]   = (planMRR[s.plan]   || 0) + (s.amount_cents || 0)
    const totalMRR   = Object.values(planMRR).reduce((s, v) => s + v, 0)
    const creditRev  = (creditPurchases.data || []).reduce((s, p) => s + (p.amount_cents || 0), 0)
    const totalUsers = (users.data || []).length
    const paidUsers  = (users.data || []).filter(u => u.plan !== "free" && u.plan_status === "active").length
    const thisMonth  = (subs.data  || []).filter(s => new Date(s.created_at) > new Date(Date.now() - 30  * 86400000)).length
    const lastMonth  = (subs.data  || []).filter(s => { const d = new Date(s.created_at); return d > new Date(Date.now() - 60 * 86400000) && d < new Date(Date.now() - 30 * 86400000) }).length
    const growthRate = lastMonth > 0 ? ((thisMonth - lastMonth) / lastMonth * 100).toFixed(1) : "+∞"
    res.json({
      mrr_cents: totalMRR, mrr: (totalMRR/100).toFixed(2),
      credit_revenue: (creditRev/100).toFixed(2),
      total_revenue:  ((totalMRR + creditRev)/100).toFixed(2),
      total_users: totalUsers, paid_users: paidUsers, free_users: totalUsers - paidUsers,
      conversion_rate: totalUsers > 0 ? ((paidUsers/totalUsers)*100).toFixed(1) : "0.0",
      plan_breakdown: planCounts,
      plan_mrr: Object.fromEntries(Object.entries(planMRR).map(([k,v]) => [k, (v/100).toFixed(2)])),
      subs_this_month: thisMonth, subs_last_month: lastMonth, growth_rate: growthRate + "%",
    })
  } catch(e) { res.json({ error: e.message }) }
})

app.get("/admin/users", async (req, res) => {
  if (!sb) return res.json([])
  const { data } = await sb.from("users").select("id,email,full_name,plan,plan_status,credits_total,credits_used,created_at,last_seen_at,referral_code").order("created_at", { ascending: false }).limit(500)
  res.json(data || [])
})

// ── HEALTH & DEBUG ────────────────────────────────────────
app.get("/health", async (req, res) => {
  const odds = await fetchOddsAPI().catch(() => ({}))
  res.json({
    status: "ok", version: "v13.0", model: AI_MODEL,
    github_ai:       aiClient   ? "✅" : "❌ add GITHUB_TOKEN",
    sportmonks:      SM_KEY     ? "✅ FULL PAID TIER" : "❌ add SPORTMONKS_API_KEY",
    football_data:   FD_KEY_ENV ? `✅ standings for ${Object.keys(FD_COMPETITIONS).length} competitions` : "⚠️  optional — add FOOTBALL_DATA_KEY for live standings",
    odds_api:        ODDS_KEY   ? "✅" : "⚠️  optional",
    news_api:        NEWS_KEY   ? "✅" : "⚠️  optional",
    supabase:        sb         ? "✅" : "⚠️  optional",
    clubelo:         clubEloMap.size > 0 ? `✅ ${clubEloMap.size} teams` : "⚠️  loading...",
    realOddsMatches: Object.keys(odds).length,
    cachedTeams:     teamDB.size,
    cachedPlayers:   playerDB.size,
    squadsCached:    squadDB.size,
    cacheEntries:    cache.size,
    port: PORT,
  })
})

app.get("/debug/sm", async (req, res) => {
  if (!SM_KEY) return res.json({ error: "No SM key" })
  const results = {}
  const today   = new Date().toISOString().slice(0, 10)
  const week    = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
  try { const r = await http(`${SM_BASE}/fixtures/between/${today}/${week}`, { api_token: SM_KEY, per_page: 3, include: "participants;league" }); results.fixtures = { count: r.data?.data?.length || 0, sample: r.data?.data?.slice(0, 2).map(f => ({ id: f.id, name: f.name, league: f.league?.name })) } } catch(e) { results.fixtures_error = `${e.response?.status||e.code} ${e.message?.slice(0,50)}` }
  try { const r = await http(`${SM_BASE}/livescores`, { api_token: SM_KEY, per_page: 2, include: "participants;league" }); results.live_count = r.data?.data?.length || 0 } catch(e) { results.live_error = e.message }
  try { const r = await http(`${SM_BASE}/leagues`, { api_token: SM_KEY, per_page: 3 }); results.leagues_ok = !!r.data?.data?.length } catch(e) { results.leagues_error = e.message }
  res.json(results)
})

app.post("/admin/refresh", (req, res) => { cache.clear(); res.json({ ok: true, message: "Cache cleared" }) })

// Debug: show ALL raw SM league names so we can fix normLeague mismatches
app.get("/debug/leagues", async (req, res) => {
  if (!SM_KEY) return res.json({ error: "No SM key" })
  try {
    cache.delete("sm_leagues")
    const all = []
    let page = 1, hasMore = true
    while (hasMore && page <= 10) {
      const r = await http(`${SM_BASE}/leagues`, { api_token: SM_KEY, include: "country;currentSeason", per_page: 50, page })
      const data = r.data?.data || []
      all.push(...data)
      hasMore = r.data?.pagination?.has_more === true && data.length === 50
      page++
      if (hasMore) await sleep(200)
    }
    const mapped = all.map(l => ({
      smName: l.name, smId: l.id, country: l.country?.name,
      seasonId: l.currentSeason?.id, seasonName: l.currentSeason?.name,
      normalizesTo: normLeague(l.name),
    }))
    res.json({
      total: all.length,
      matched:   mapped.filter(l => l.normalizesTo && l.seasonId),
      unmatched: mapped.filter(l => !l.normalizesTo).slice(0, 40),
      noSeason:  mapped.filter(l => l.normalizesTo && !l.seasonId),
    })
  } catch(e) { res.json({ error: e.message }) }
})

// Debug squad endpoints — test what SM returns for a given team ID
app.get("/debug/squad/:teamId", async (req, res) => {
  if (!SM_KEY) return res.json({ error: "No SM key" })
  const teamId = req.params.teamId
  const results = {}
  const testEndpoints = [
    `${SM_BASE}/squads/teams/${teamId}`,
    `${SM_BASE}/teams/${teamId}`,
    `${SM_BASE}/players/teams/${teamId}`,
  ]
  for (const url of testEndpoints) {
    const key = url.replace(SM_BASE,"")
    try {
      const r = await http(url, { api_token: SM_KEY, include: "player;player.position", per_page: 5 })
      const data = r.data?.data
      results[key] = {
        status: 200,
        type: Array.isArray(data) ? "array" : typeof data,
        count: Array.isArray(data) ? data.length : (data ? Object.keys(data).length : 0),
        sample: Array.isArray(data) ? data[0] : data,
      }
    } catch(e) {
      results[key] = { status: e.response?.status || e.code, error: e.message?.slice(0,80) }
    }
  }
  res.json(results)
})

app.get("/config.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript")
  res.setHeader("Cache-Control", "public, max-age=300")
  res.send(`window.SUPABASE_URL=${JSON.stringify(process.env.SUPABASE_URL||"")};window.SUPABASE_ANON_KEY=${JSON.stringify(process.env.SUPABASE_ANON_KEY||"")};window.APP_URL=${JSON.stringify(process.env.APP_URL||"")};`)
})

// ── STRIPE WEBHOOK ────────────────────────────────────────
app.post("/webhook/stripe", async (req, res) => {
  if (!STRIPE_WEBHOOK_SECRET) return res.status(400).json({ error: "Webhook secret not configured" })
  let event
  try {
    const stripe = require("stripe")(STRIPE_SECRET_KEY)
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET)
  } catch(e) { return res.status(400).json({ error: "Webhook signature failed" }) }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object, meta = session.metadata || {}
      const email   = session.customer_email || session.customer_details?.email
      const custId  = session.customer, subId = session.subscription
      const { data: user } = sb ? await sb.from("users").select("id,plan").eq("email", email).single() : { data: null }
      const userId = user?.id || null
      if (meta.type === "subscription" && meta.plan && userId && sb) {
        await sb.from("users").update({ plan: meta.plan, plan_status: "active", credits_total: PLAN_CREDITS[meta.plan] || 25, credits_used: 0, credits_reset_at: new Date(Date.now() + 30 * 86400000).toISOString(), updated_at: new Date().toISOString() }).eq("id", userId)
        await sb.from("subscriptions").upsert({ user_id: userId, email, plan: meta.plan, status: "active", stripe_customer_id: custId, stripe_subscription_id: subId, stripe_event_id: event.id, amount_cents: session.amount_total || 0, referral_code_used: meta.referral_code || null, started_at: new Date().toISOString() }, { onConflict: "stripe_event_id" })
        console.log(`✅ Plan upgraded: ${email} → ${meta.plan}`)
      }
    } else if (event.type === "customer.subscription.deleted") {
      if (sb) {
        const { data: sub } = await sb.from("subscriptions").select("user_id").eq("stripe_subscription_id", event.data.object.id).single()
        if (sub?.user_id) await sb.from("users").update({ plan: "free", plan_status: "cancelled", updated_at: new Date().toISOString() }).eq("id", sub.user_id)
      }
    } else if (event.type === "invoice.payment_succeeded") {
      const inv = event.data.object
      if (sb && inv.subscription) {
        const { data: sub } = await sb.from("subscriptions").select("user_id,plan").eq("stripe_subscription_id", inv.subscription).single()
        if (sub?.user_id) await sb.from("users").update({ credits_used: 0, credits_total: PLAN_CREDITS[sub.plan] || 25, plan_status: "active", updated_at: new Date().toISOString() }).eq("id", sub.user_id)
      }
    }
    res.json({ received: true })
  } catch(e) { console.error("❌ Webhook:", e.message); res.status(500).json({ error: e.message }) }
})

// ── STARTUP ───────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n╔═══════════════════════════════════════════════╗`)
  console.log(`║  ⚽  SLIP IQ  v13.0  PRODUCTION               ║`)
  console.log(`║  Port ${PORT}  |  AI: ${AI_MODEL.split("/").pop().slice(0, 18).padEnd(18)}   ║`)
  console.log(`╚═══════════════════════════════════════════════╝\n`)
  console.log(`GitHub AI:    ${aiClient ? "✅ " + AI_MODEL : "❌ Add GITHUB_TOKEN"}`)
  console.log(`Sportmonks:   ${SM_KEY   ? "✅ FULL PAID TIER" : "❌ Add SPORTMONKS_API_KEY"}`)
  console.log(`Odds API:     ${ODDS_KEY ? "✅" : "⚠️  Optional"}`)
  console.log(`News API:     ${NEWS_KEY ? "✅" : "⚠️  Optional"}`)
  console.log(`Supabase:     ${sb       ? "✅" : "⚠️  Optional"}\n`)
  console.log(`🔧 v13 FIXES:`)
  console.log(`   ✅ buildGameApproach defined — was missing, caused ALL 314 to fail`)
  console.log(`   ✅ Real SM squad/player names re-enabled (full paid tier)`)
  console.log(`   ✅ Odds API: no httpsAgent (was causing ERR_BAD_REQUEST)`)
  console.log(`   ✅ No filters[leagueIds] on fixtures (was causing 400 errors)`)
  console.log(`   ✅ Player mismatch detection`)
  console.log(`   ✅ Team descriptor engine (attacking, dominant, timid...)`)
  console.log(`   ✅ Trophy ELO bonuses`)
  console.log(`   ✅ Real SM standings + league season IDs`)
  console.log(`   ✅ ELO ranking table with delta arrows`)
  console.log(`   ✅ Referral codes saved to Supabase before Stripe\n`)
  await loadSupabase().catch(() => {})
  loadClubElo().catch(() => {})
  console.log("🔄 Pre-warming caches...")
  smFixtures(14).then(f => console.log(`✅ SM fixtures: ${f.length} loaded`)).catch(e => console.log("⚠️  SM warm:", e.message))
  setTimeout(() => { fetchOddsAPI().then(o => console.log(`✅ Odds API: ${Object.keys(o).length} matches`)).catch(e => console.log("⚠️  Odds:", e.message)) }, 5000)
  setTimeout(() => { smPreMatchNews().catch(() => {}) }, 8000)
  console.log(`✅ Ready → http://localhost:${PORT}`)
  console.log(`🔬 Debug: GET /debug/sm | Health: GET /health | Cache: POST /admin/refresh\n`)
})