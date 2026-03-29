"use strict"
require("dotenv").config()
const express  = require("express")
const cors     = require("cors")
const axios    = require("axios")
const path     = require("path")
const https    = require("https")
const dns      = require("dns")
// ── AI LEARNING SYSTEM ─────────────────────────────────────────────────────
// Stores prediction outcomes and adjusts weights dynamically
const predictionLog    = new Map()  // matchId → { predicted, actual, sport, factors }
const sportWeights     = {
  football:          { eloWeight: 0.35, formWeight: 0.25, xgWeight: 0.20, homeWeight: 0.12, h2hWeight: 0.08 },
  basketball:        { eloWeight: 0.40, formWeight: 0.20, homeWeight: 0.25, paceWeight: 0.15 },
  american_football: { eloWeight: 0.35, formWeight: 0.20, homeWeight: 0.30, qbWeight: 0.15 },
  tennis:            { eloWeight: 0.45, surfaceWeight: 0.25, formWeight: 0.20, h2hWeight: 0.10 },
  f1:                { driverWeight: 0.55, constructorWeight: 0.30, circuitWeight: 0.15 },
  boxing:            { eloWeight: 0.40, reachWeight: 0.15, recordWeight: 0.25, styleWeight: 0.20 },
  mma:               { eloWeight: 0.38, strikingWeight: 0.22, grapplingWeight: 0.22, reachWeight: 0.10, recordWeight: 0.08 },
}

const weightUpdateLog  = []  // tracks weight changes over time
let   lastWeightUpdate = 0
// Per-team adaptive weightings — these override global sport weights for specific teams
// Keys: teamName → { home: 0-1, away: 0-1, form: 0-1, elo: 0-1, xg: 0-1, ... }
const teamWeights = new Map()

const DEFAULT_TEAM_WEIGHTS = () => ({
  homeWin:  0.62, awayWin: 0.38,          // home/away win rate factor
  homeEuropean: 0.60, awayEuropean: 0.40, // European home/away
  formFactor: 0.72,                        // how much recent form matters
  eloFactor: 0.68,                         // ELO weight in prediction
  xgFactor: 0.55,                          // xG importance
  tablePlacement: 0.45,                    // league position relevance
  oppositionStrength: 0.50,                // how they do vs top/mid/bottom
  pressingIntensity: 0.50,                 // high press susceptibility
  setpieceVulnerability: 0.50,             // set piece conceding/scoring
  counterAttackRisk: 0.50,                 // vulnerable to counter attack
  injuryImpact: 0.40,                      // injury sensitivity
  managerTactical: 0.45,                   // manager tactical factor
  // Descriptor matchups
  vsFinessers: 0.50,    // vs technical/possession teams
  vsDirectPlay: 0.50,   // vs long ball/direct teams
  vsHighPress: 0.50,    // vs pressing teams
  vsLowBlock: 0.50,     // vs defensive teams
  matchCount: 0,        // how many matches used for learning
  lastUpdated: Date.now()
})

function getTeamWeights(teamName) {
  if (!teamWeights.has(teamName)) teamWeights.set(teamName, DEFAULT_TEAM_WEIGHTS())
  return teamWeights.get(teamName)
}

// Update team weights after a match result — call this when outcomes come in
async function updateTeamWeights(homeTeam, awayTeam, homeScore, awayScore, wasHome, matchContext) {
  const lr = 0.015  // conservative learning rate per match
  for (const [teamName, isHome] of [[homeTeam, true], [awayTeam, false]]) {
    const w = getTeamWeights(teamName)
    const scored  = isHome ? homeScore : awayScore
    const conceded= isHome ? awayScore : homeScore
    const won     = scored > conceded
    const context = matchContext || {}

    // Update home/away weighting
    if (isHome) {
      if (won) w.homeWin = Math.min(0.85, w.homeWin + lr)
      else     w.homeWin = Math.max(0.35, w.homeWin - lr)
      w.awayWin = 1 - w.homeWin
    } else {
      if (won) w.awayWin = Math.min(0.75, w.awayWin + lr)
      else     w.awayWin = Math.max(0.25, w.awayWin - lr)
      w.homeWin = 1 - w.awayWin
    }

    // Form factor — if they're winning consistently, form matters more
    if (won) w.formFactor = Math.min(0.90, w.formFactor + lr * 0.5)
    else     w.formFactor = Math.max(0.40, w.formFactor - lr * 0.3)

    // xG factor — if their xG is predicting results well, increase weight
    if (context.homeXg && Math.abs(context.homeXg - scored) < 0.5) {
      w.xgFactor = Math.min(0.80, w.xgFactor + lr * 0.4)
    } else {
      w.xgFactor = Math.max(0.30, w.xgFactor - lr * 0.2)
    }

    w.matchCount++
    w.lastUpdated = Date.now()
    teamWeights.set(teamName, w)
  }

  // Persist to Supabase
  if (sb) {
    for (const teamName of [homeTeam, awayTeam]) {
      const w = teamWeights.get(teamName)
      sb.from('team_weights').upsert({ team_name: teamName, weights: w, updated_at: new Date().toISOString() }, { onConflict: 'team_name' }).then(()=>{}).catch(()=>{})
    }
  }
}

// Load persisted team weights from Supabase on startup
async function loadTeamWeights() {
  if (!sb) return
  try {
    const { data } = await sb.from('team_weights').select('*').limit(5000)
    if (data) {
      for (const row of data) teamWeights.set(row.team_name, { ...DEFAULT_TEAM_WEIGHTS(), ...row.weights })
      console.log(`✅ Team weights loaded: ${data.length} teams`)
    }
  } catch(e) {}
}
// Load persisted weights from Supabase if available
async function loadSportWeights() {
  if (!sb) return
  try {
    const { data } = await sb.from('sport_weights').select('*').order('updated_at', { ascending: false }).limit(7)
    if (data && data.length) {
      for (const row of data) {
        if (sportWeights[row.sport]) sportWeights[row.sport] = { ...sportWeights[row.sport], ...row.weights }
      }
      console.log('✅ Sport weights loaded from DB')
    }
  } catch(e) {}
}

// Record a prediction for later accuracy tracking
function logPrediction(matchId, sport, homeTeam, awayTeam, predictedWinner, probabilities, factors) {
  predictionLog.set(String(matchId), {
    matchId, sport, homeTeam, awayTeam, predictedWinner,
    probabilities, factors, timestamp: Date.now(), resolved: false
  })
}

// When a result comes in, update weights based on accuracy
async function recordOutcome(matchId, actualWinner, homeScore, awayScore) {
  const pred = predictionLog.get(String(matchId))
  if (!pred || pred.resolved) return
  pred.resolved = true
  pred.actualWinner = actualWinner
  pred.correct = pred.predictedWinner === actualWinner
  const sport = pred.sport || 'football'
  const w = sportWeights[sport]
  if (!w) return

  // Adjust weights based on what factors predicted correctly
  const lr = 0.02  // learning rate — small adjustments
  if (!pred.correct) {
    // If we got it wrong, reduce weight of the dominant factor slightly
    const dominant = pred.factors && pred.factors[0] ? pred.factors[0].key : null
    if (dominant && w[dominant] !== undefined) {
      w[dominant] = Math.max(0.05, w[dominant] - lr)
      // redistribute to other weights proportionally
      const others = Object.keys(w).filter(k => k !== dominant)
      const adj = lr / others.length
      for (const k of others) w[k] = Math.min(0.60, w[k] + adj)
    }
  } else {
    // Correct — slightly boost dominant factor confidence
    const dominant = pred.factors && pred.factors[0] ? pred.factors[0].key : null
    if (dominant && w[dominant] !== undefined) {
      w[dominant] = Math.min(0.60, w[dominant] + lr * 0.5)
    }
  }

  weightUpdateLog.push({ sport, matchId, correct: pred.correct, timestamp: Date.now() })
  // Persist to Supabase every 10 updates
  if (weightUpdateLog.length % 10 === 0) {
    await persistWeights(sport, w).catch(() => {})
  }
}

async function persistWeights(sport, weights) {
  if (!sb) return
  try {
    await sb.from('sport_weights').upsert({ sport, weights, updated_at: new Date().toISOString() }, { onConflict: 'sport' })
  } catch(e) {}
}
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
const smAgent = new https.Agent({ keepAlive: true, maxSockets: 10, timeout: 35000 })

app.use(cors())
app.use("/webhook/stripe", express.raw({ type: "application/json" }))
app.use(express.json({ limit: "15mb" }))
app.use(express.static(path.join(__dirname, "public")))
app.use(express.static(__dirname, { extensions: ["html"] }))

// ── ENV ───────────────────────────────────────────────────
const SM_KEY   = process.env.SPORTMONKS_API_KEY
const ODDS_KEY = process.env.ODDS_API_KEY
const NEWS_KEY = process.env.NEWS_API_KEY
const FD_KEY   = process.env.FOOTBALL_DATA_KEY || ""
const STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET
const _raw     = process.env.MODEL_NAME || "openai/gpt-4o"
const AI_MODEL = (_raw === "openai/gpt-5" || _raw === "gpt-5") ? "openai/gpt-4o" : _raw
const SM_BASE  = "https://api.sportmonks.com/v3/football"
const OPEN_F1_BASE = "https://api.openf1.org/v1"

// ── PLAN DEFINITIONS ──────────────────────────────────────
const PLAN_CREDITS = {
  free: 25, starter: 55, basic: 55, plus: 115,
  pro: 265, elite: 900, platinum: Infinity
}
const ACTION_COSTS = {
  match_analysis: 15, news_analysis: 5,  auto_parlay: 10,
  parlay_advice:  20, ai_agent: 10,      team_stats: 15,
  leagues_tab:    15, risk_analysis: 15, sport_analysis: 15,
}
const PLAN_HIERARCHY = ['free','starter','basic','plus','pro','elite','platinum']
const PLAN_RANK = Object.fromEntries(PLAN_HIERARCHY.map((p,i) => [p,i]))
const FEATURE_MIN_PLAN = {
  match_analysis: 'free', news_analysis: 'free', risk_analysis: 'free',
  auto_parlay: 'plus',    parlay_advice: 'plus', team_stats: 'plus',
  leagues_tab: 'plus',    sport_analysis: 'plus', ai_agent: 'platinum',
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
function planCanAccess(userPlan, feature) {
  const minPlan = FEATURE_MIN_PLAN[feature] || 'free'
  return (PLAN_RANK[userPlan] || 0) >= (PLAN_RANK[minPlan] || 0)
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

// ── HTTP helper (SM only — uses smAgent) ─────────────────
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

// ── HTTP helper (no agent — for external APIs) ────────────
async function httpExt(url, params, hdrs) {
  return axios.get(url, {
    params: params || {},
    timeout: 20000,
    headers: { "Accept": "application/json", "User-Agent": "SlipIQ/1.0", ...(hdrs||{}) }
  })
}

// ── IN-MEMORY STORES ──────────────────────────────────────
const teamDB       = new Map()
const playerDB     = new Map()
const squadDB      = new Map()
const managerDB    = new Map()
const clubEloMap   = new Map()
const trophyBonus  = new Map()
const prevEloSnap  = new Map()
const nbaEloMap    = new Map()
const nflEloMap    = new Map()
const tennisEloMap = new Map()
const f1EloMap     = new Map()
const boxingEloMap = new Map()
const mmaEloMap    = new Map()


// ── AUTH MIDDLEWARE ───────────────────────────────────────
function requireAccess(action) {
  return async function(req, res, next) {
    const userId = req.headers['x-user-id'] || req.query.userId || req.body?.userId
    if (!userId || !sb) return next() // no Supabase = dev mode, allow through
    
    const access = await checkAccess(userId, action)
    if (!access.ok) {
      return res.status(402).json({
        ok: false,
        reason: access.reason,
        action,
        required_plan: FEATURE_MIN_PLAN[action],
        user_plan: access.user_plan,
        credits_needed: ACTION_COSTS[action],
        credits_available: access.credits_available
      })
    }
    
    // Deduct credits AFTER confirming access
    if (access.plan !== 'platinum') {
      await useCredits(userId, action, action)
    }
    
    req.userPlan = access.plan
    next()
  }
}
// ── CREDITS ────────────────────────────────────────────────
async function useCredits(userId, action) {
  if (!sb) return { ok: true }
  const cost = ACTION_COSTS[action] || 0
  if (!cost) return { ok: true }
  try {
    // Get current state
    const { data: sub } = await sb.from('subscriptions')
      .select('plan, credits_total, credits_used')
      .eq('user_id', userId).single()
    if (!sub) return { ok: false, reason: 'not_found' }
    if (sub.plan === 'platinum') return { ok: true, unlimited: true }
    const newUsed = (sub.credits_used || 0) + cost
    await sb.from('subscriptions')
      .update({ credits_used: newUsed, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
    return { ok: true, credits_remaining: Math.max(0, sub.credits_total - newUsed) }
  } catch(e) { return { ok: false, reason: 'db_error' } }
}

// REPLACE the entire checkAccess function:
async function checkAccess(userId, action) {
  if (!sb) return { ok: true, plan: 'platinum' }
  try {
    const { data, error } = await sb.from('subscriptions')
      .select('plan, status, credits_total, credits_used, credits_reset_at')
      .eq('user_id', userId).single()
    if (error || !data) return { ok: false, reason: 'user_not_found' }
    if (data.status !== 'active') return { ok: false, reason: 'subscription_inactive' }
    const plan = data.plan || 'free'
    if (!planCanAccess(plan, action)) {
      return { ok: false, reason: 'plan_locked', user_plan: plan,
        required_plan: FEATURE_MIN_PLAN[action], action }
    }
    const cost = ACTION_COSTS[action] || 0
    const available = plan === 'platinum' ? 999999 : Math.max(0, (data.credits_total||25) - (data.credits_used||0))
    if (plan !== 'platinum' && available < cost) {
      return { ok: false, reason: 'insufficient_credits', credits_available: available, credits_needed: cost }
    }
    return { ok: true, plan, credits_available: available }
  } catch(e) { return { ok: false, reason: 'db_error' } }
}

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
}

const ELO_BASE = {
  "Arsenal": 1980, "Liverpool": 1905, "Manchester City": 1855, "Chelsea": 1825, "Manchester United": 1815,
  "Tottenham Hotspur": 1780, "Newcastle United": 1745, "Aston Villa": 1755, "Brighton": 1715,
  "Nottingham Forest": 1655, "West Ham United": 1705, "Fulham": 1635, "Brentford": 1625,
  "Crystal Palace": 1645, "Everton": 1595, "Bournemouth": 1615, "Wolverhampton Wanderers": 1650,
  "Leicester City": 1605, "Ipswich Town": 1545, "Southampton": 1525,
  "Real Madrid": 1910, "Barcelona": 1905, "Atletico Madrid": 1875, "Athletic Club": 1720,
  "Villarreal": 1735, "Real Sociedad": 1745, "Girona": 1705, "Osasuna": 1645,
  "Bayern Munich": 1970, "Borussia Dortmund": 1880, "RB Leipzig": 1840, "Bayer Leverkusen": 1905,
  "Eintracht Frankfurt": 1750, "VfB Stuttgart": 1690,
  "Inter Milan": 1905, "Juventus": 1865, "AC Milan": 1870, "Napoli": 1855, "Roma": 1790, "Lazio": 1775,
  "Atalanta": 1825, "Fiorentina": 1745,
  "Paris Saint-Germain": 1935, "Monaco": 1805, "Marseille": 1775, "Lille": 1765, "Nice": 1725,
  "Benfica": 1825, "Porto": 1835, "Sporting CP": 1815,
  "Ajax": 1805, "PSV": 1825, "Feyenoord": 1795,
  "Celtic": 1685, "Rangers": 1665, "Galatasaray": 1725, "Fenerbahce": 1705,
}

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

const MANAGER_SEEDS = {
  "Pep Guardiola":   { team: "Man City",    base: 1920, style: "Possession" },
  "Carlo Ancelotti": { team: "Real Madrid", base: 1900, style: "Flexible" },
  "Mikel Arteta":    { team: "Arsenal",     base: 1870, style: "Pressing" },
  "Diego Simeone":   { team: "Atletico",    base: 1850, style: "Defensive" },
  "Xabi Alonso":     { team: "Leverkusen",  base: 1900, style: "Pressing" },
  // Find MANAGER_SEEDS and add:
"Igor Tudor":       { team: "Tottenham Hotspur", base: 1760, style: "Aggressive 3-4-3" },
"Liam Rosenior":    { team: "Chelsea",           base: 1790, style: "Attacking" },
"Robert Carrick":   { team: "Manchester United", base: 1770, style: "3-4-3" },
  
}

function getManagerElo(name, team) {
  const s = managerDB.get(name)
  if (s && s.elo > 0) return s.elo
  const seed = MANAGER_SEEDS[name]
  if (seed) return seed.base
  return getElo(team || "") - 30
}

// ── PLAYER ATTRIBUTES ─────────────────────────────────────
function clamp(v) { return Math.min(99, Math.max(20, v)) }
const POS_ID_MAP = { 24:"GK",25:"CB",26:"CM",27:"ST",28:"LB",29:"RB",30:"CDM",31:"CAM",32:"LW",33:"RW",34:"RM",35:"LM",36:"LWB",37:"RWB" }
function mapPosId(id) { return POS_ID_MAP[id] || "CM" }

// ══════════════════════════════════════════════════════════
//  SPORT-SPECIFIC PLAYSTYLES
// ══════════════════════════════════════════════════════════

// FOOTBALL playstyles
const FOOTBALL_PLAYSTYLES = {
  GK:  { name: "Sweeper Keeper",   desc: "Commands area, builds from back",          icon: "🧤" },
  CB:  { name: "Ball-Playing CB",  desc: "Line-breaking passes, steps into midfield",icon: "⚽" },
  LB:  { name: "Attack Fullback",  desc: "Overlapping runs, dangerous in final third",icon: "🏃" },
  RB:  { name: "Attack Fullback",  desc: "Overlapping runs, dangerous in final third",icon: "🏃" },
  CDM: { name: "Press Conductor",  desc: "Sets press triggers, shields the backline", icon: "🔥" },
  CM:  { name: "Box-to-Box",       desc: "Covers ground, contributes both phases",    icon: "⚙️" },
  CAM: { name: "Playmaker",        desc: "Creates between lines, key passes",         icon: "✨" },
  LW:  { name: "Inverted Winger",  desc: "Cuts inside onto stronger foot",            icon: "↩️" },
  RW:  { name: "Inverted Winger",  desc: "Cuts inside onto stronger foot",            icon: "↩️" },
  ST:  { name: "Target Striker",   desc: "Holds up play, aerial threat, clinical",    icon: "🎯" },
  LWB: { name: "Wingback",         desc: "Very advanced, creates wide overloads",     icon: "🏃" },
  RWB: { name: "Wingback",         desc: "Very advanced, creates wide overloads",     icon: "🏃" },
  RM:  { name: "Wide Midfielder",  desc: "Two-way wide contribution",                 icon: "📐" },
  LM:  { name: "Wide Midfielder",  desc: "Two-way wide contribution",                 icon: "📐" },
}

// NBA playstyles — assigned by role
const NBA_PLAYSTYLES = {
  "PG": [
    { name: "Floor General",    desc: "Elite court vision, drives offense, assists machine",     icon: "🎯" },
    { name: "Microwave Scorer", desc: "Instant offense off bench, shoot-first mentality",        icon: "🔥" },
    { name: "Defensive Menace", desc: "Disrupts passing lanes, elite on-ball defender",          icon: "🛡" },
  ],
  "SG": [
    { name: "Catch & Shoot",    desc: "Elite off-ball movement, deadly spot-up shooter",         icon: "🎯" },
    { name: "Shot Creator",     desc: "Creates own shot off dribble, pull-up specialist",        icon: "⚡" },
    { name: "Two-Way Guard",    desc: "Contributes on both ends, versatile defender",            icon: "⚙️" },
  ],
  "SF": [
    { name: "3-and-D",          desc: "Corners three specialist, lockdown on wings",             icon: "🔐" },
    { name: "Slash & Kick",     desc: "Attacks closeouts, creates for teammates",                icon: "💨" },
    { name: "Versatile Wing",   desc: "Can play multiple positions, switchable defender",        icon: "🔄" },
  ],
  "PF": [
    { name: "Stretch Four",     desc: "Extends floor with three-point shooting",                 icon: "📐" },
    { name: "Power Bruiser",    desc: "Physical presence, rebounds, finishes in traffic",        icon: "💪" },
    { name: "Pick & Pop",       desc: "Sets hard screens, pops to mid-range",                   icon: "🎯" },
  ],
  "C": [
    { name: "Rim Protector",    desc: "Anchors defense, elite shot blocker, paint presence",    icon: "🏰" },
    { name: "Modern Center",    desc: "Can step out, pass out of pick-and-roll",                icon: "✨" },
    { name: "Lob Threat",       desc: "Dominant above the rim, elite at rolling hard",          icon: "🚀" },
  ],
}

// NFL playstyles — by position
const NFL_PLAYSTYLES = {
  "QB": [
    { name: "Pocket Passer",    desc: "Elite accuracy standing tall in the pocket",             icon: "🎯" },
    { name: "Dual Threat",      desc: "Dangerous with arm and legs, extends plays",             icon: "⚡" },
    { name: "Gunslinger",       desc: "High risk/reward, aggressive deep ball thrower",         icon: "🔥" },
  ],
  "RB": [
    { name: "Every Down Back",  desc: "Runs, catches, blocks — complete back",                  icon: "⚙️" },
    { name: "Scat Back",        desc: "Elusive in space, receiving specialist",                 icon: "💨" },
    { name: "Power Runner",     desc: "Runs between the tackles, breaks tackles",               icon: "💪" },
  ],
  "WR": [
    { name: "Route Runner",     desc: "Elite separation using precise route technique",          icon: "📐" },
    { name: "Contested Catch",  desc: "Big bodied, wins jump balls, RAC monster",               icon: "🏆" },
    { name: "Burner",           desc: "Game-breaking top speed, deep threat",                   icon: "🚀" },
  ],
  "TE": [
    { name: "Move TE",          desc: "Flexes out wide, mismatch nightmare",                    icon: "🔄" },
    { name: "Inline Blocker",   desc: "Dominant blocker, finishes run plays",                   icon: "💪" },
    { name: "Red Zone Target",  desc: "Huge target in the end zone, reliable hands",            icon: "🎯" },
  ],
  "DEF": [
    { name: "Pass Rusher",      desc: "Elite edge pressure, disrupts quarterback",              icon: "💥" },
    { name: "Coverage Corner",  desc: "Shadows top receivers, press or zone",                   icon: "🔐" },
    { name: "Run Stuffer",      desc: "Fills gaps, tackles for loss specialist",                icon: "🛡" },
  ],
}

// TENNIS playstyles
const TENNIS_PLAYSTYLES = [
  { name: "Baseline Grinder",   desc: "Outlasts opponents from the back court, elite consistency", icon: "🔄" },
  { name: "Aggressive Baseliner",desc: "Takes ball early, dictates with heavy groundstrokes",     icon: "⚡" },
  { name: "Serve & Volley",     desc: "Big serve, rushes net, uncomfortable to play against",     icon: "🚀" },
  { name: "All Court Player",   desc: "Adapts to surface and opponent, complete game",            icon: "⚙️" },
  { name: "Counter Puncher",    desc: "Reads the game, turns defence into offence",              icon: "🔐" },
  { name: "Big Server",         desc: "Winning free points off serve, ace machine",              icon: "💥" },
  { name: "Net Rusher",         desc: "Looks for any opportunity to volley, uncomfortable",      icon: "🎯" },
  { name: "Clay Specialist",    desc: "Thrives on slow surface, heavy topspin game",             icon: "🏆" },
  { name: "Grass Specialist",   desc: "Low bounce lover, serve and slice game",                  icon: "🌿" },
  { name: "Hard Court Specialist",desc:"Consistent on hard courts, thrives in fast conditions",  icon: "🏟" },
]

// F1 driver styles
const F1_PLAYSTYLES = [
  { name: "Qualifying Ace",     desc: "Often fastest one lap, extracts max from car",           icon: "⚡" },
  { name: "Race Craftsman",     desc: "Tyre management, strategy expert, consistent over distance", icon: "⚙️" },
  { name: "Overtaker",          desc: "Aggressive on the brakes, finds gaps others won't take", icon: "💨" },
  { name: "Wet Weather Master", desc: "Elevated performance in tricky conditions",              icon: "🌧" },
  { name: "Street Circuit King",desc: "Thrives on tight street circuits, millimetre accuracy", icon: "🏙" },
  { name: "Pressure Player",    desc: "Delivers in title fights and decisive moments",          icon: "🔥" },
  { name: "Young Gun",          desc: "Raw speed, still developing racecraft and experience",   icon: "🚀" },
  { name: "Veteran",            desc: "Seen it all, calm under pressure, strategic thinker",   icon: "🧠" },
]

// BOXING styles
const BOXING_PLAYSTYLES = [
  { name: "Pressure Fighter",   desc: "Walks opponents down, heavy body punching",             icon: "💪" },
  { name: "Boxer-Puncher",      desc: "Technical boxing with power, dangerous counter",        icon: "🎯" },
  { name: "Out-Boxer",          desc: "Uses jab and footwork, fights at long range",           icon: "📐" },
  { name: "Swarmer",            desc: "High-volume puncher, relentless pressure",              icon: "🔥" },
  { name: "Counter Puncher",    desc: "Patient, looks to counter on the way in",              icon: "🔐" },
  { name: "Knockout Artist",    desc: "One punch power in both hands, ends fights early",     icon: "💥" },
  { name: "Technical Master",   desc: "Elite defensive skills, controls distance and angles", icon: "🧠" },
  { name: "Southpaw",           desc: "Unorthodox stance causes problems for opponents",      icon: "🔄" },
]

// MMA styles
const MMA_PLAYSTYLES = [
  { name: "Striker",            desc: "Stands and trades, brings punching/kicking power",     icon: "💥" },
  { name: "Wrestler",           desc: "Dominant takedowns, controls on the mat",              icon: "💪" },
  { name: "BJJ Specialist",     desc: "Looks for submissions, dangerous on the ground",       icon: "🔐" },
  { name: "Counter Striker",    desc: "Patient, reads openings, punishes aggression",         icon: "🎯" },
  { name: "Clinch Fighter",     desc: "Dirty boxing, dirty wrestling, wears opponents down",  icon: "⚙️" },
  { name: "Finisher",           desc: "Doesn't go to decisions, always looking to end it",   icon: "🔥" },
  { name: "Complete Fighter",   desc: "Elite in all areas, adapts mid-fight",                 icon: "⭐" },
  { name: "Southpaw Striker",   desc: "Unorthodox stance, times opponents with power left",  icon: "🔄" },
]

// Assign playstyle based on sport + position/role
function getPlaystyleForSport(sport, position, name, elo) {
  let seed = 0
  for (let i = 0; i < (name||"").length; i++) seed = seed * 31 + name.charCodeAt(i)
  const pick = arr => arr[Math.abs(seed) % arr.length]
  const pick2 = arr => {
    const a = Math.abs(seed) % arr.length
    const b = (Math.abs(seed >> 4) + 1) % arr.length
    return [arr[a], arr[b !== a ? b : (b+1)%arr.length]]
  }

  if (sport === 'football') {
    return FOOTBALL_PLAYSTYLES[position] || FOOTBALL_PLAYSTYLES.CM
  }
  if (sport === 'basketball') {
    const pos = position || 'SF'
    const styles = NBA_PLAYSTYLES[pos] || NBA_PLAYSTYLES['SF']
    return pick(styles)
  }
  if (sport === 'american_football') {
    const pos = position || 'WR'
    const styles = NFL_PLAYSTYLES[pos] || NFL_PLAYSTYLES['WR']
    return pick(styles)
  }
  if (sport === 'tennis') {
    return pick(TENNIS_PLAYSTYLES)
  }
  if (sport === 'f1') {
    return pick(F1_PLAYSTYLES)
  }
  if (sport === 'boxing') {
    return pick(BOXING_PLAYSTYLES)
  }
  if (sport === 'mma') {
    return pick(MMA_PLAYSTYLES)
  }
  return { name: "Unknown", desc: "Style not identified", icon: "❓" }
}

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
  const ps = FOOTBALL_PLAYSTYLES[pos] || FOOTBALL_PLAYSTYLES.CM
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

// ══════════════════════════════════════════════════════════
//  NBA — BallDontLie API (free, no key needed for basic)
// ══════════════════════════════════════════════════════════
async function fetchNBAGames() {
  return cached("nba_games", async () => {
    const today = new Date().toISOString().slice(0,10)
    const nextWeek = new Date(Date.now() + 7*86400000).toISOString().slice(0,10)

    // Try SportsData.io NBA first (most reliable for real scores)
    if (process.env.SPORTSDATAIO_KEY) {
      try {
        const season = new Date().getFullYear() + (new Date().getMonth() >= 9 ? 1 : 0)
        const r = await httpExt(`https://api.sportsdata.io/v3/nba/scores/json/GamesByDate/${today}`,
          {}, { 'Ocp-Apim-Subscription-Key': process.env.SPORTSDATAIO_KEY })
        const games = r.data || []
        if (games.length > 0) {
          console.log(`✅ NBA SportsData.io: ${games.length} games`)
          // Also fetch upcoming
          let upcoming = []
          try {
            const r2 = await httpExt(`https://api.sportsdata.io/v3/nba/scores/json/Games/${season}`,
              {}, { 'Ocp-Apim-Subscription-Key': process.env.SPORTSDATAIO_KEY })
            upcoming = (r2.data || []).filter(g => g.Day && g.Day.slice(0,10) > today && g.Day.slice(0,10) <= nextWeek)
          } catch(e2) {}
          const allGames = [...games, ...upcoming]
          return allGames.map(g => ({
            id: g.GameID,
            _source: 'sportsdata',
            home_team: { full_name: g.HomeTeam, abbreviation: g.HomeTeam, city: '', name: g.HomeTeam },
            away_team: { full_name: g.AwayTeam, abbreviation: g.AwayTeam, city: '', name: g.AwayTeam },
            visitor_team: { full_name: g.AwayTeam },
            date: g.Day,
            status: g.Status === 'Final' ? 'Final' : g.Status === 'InProgress' ? 'In Progress' : 'scheduled',
            home_team_score: g.HomeTeamScore,
            visitor_team_score: g.AwayTeamScore,
            period: g.Quarter || 0,
            season: g.Season,
            homeTeamFull: NBA_TEAM_NAMES[g.HomeTeam] || g.HomeTeam,
            awayTeamFull: NBA_TEAM_NAMES[g.AwayTeam] || g.AwayTeam,
          }))
        }
      } catch(e) { console.log('⚠️  NBA SportsData.io:', e.message?.slice(0,50)) }
    }

    // Try BallDontLie
    try {
      const headers = process.env.BALLDONTLIE_API_KEY ? { Authorization: process.env.BALLDONTLIE_API_KEY } : {}
      const r = await httpExt(`https://api.balldontlie.io/v1/games`, { start_date: today, end_date: nextWeek, per_page: 100 }, headers)
      const games = r.data?.data || []
      if (games.length > 0) { console.log(`✅ NBA BallDontLie: ${games.length} games`); return games }
    } catch(e) { console.log('⚠️  NBA BallDontLie:', e.message?.slice(0,40)) }

    // TheSportsDB fallback
    try {
      const r = await httpExt(`https://www.thesportsdb.com/api/v2/json/${process.env.THESPORTSDB_API_KEY||'3'}/eventsday.php`, { d: today, s: 'Basketball' })
      const events = (r.data?.events || []).filter(e => (e.strLeague||'').includes('NBA'))
      if (events.length > 0) return events.map(mapTSDBtoGame)
    } catch(e) {}

    // Static schedule fallback
    return generateNBASchedule()
  }, TTL.S)
}

// Map abbreviation to full team name for SportsData.io
const NBA_TEAM_NAMES = {
  'BOS':'Boston Celtics','NYK':'New York Knicks','BKN':'Brooklyn Nets','PHI':'Philadelphia 76ers',
  'TOR':'Toronto Raptors','CHI':'Chicago Bulls','CLE':'Cleveland Cavaliers','DET':'Detroit Pistons',
  'IND':'Indiana Pacers','MIL':'Milwaukee Bucks','ATL':'Atlanta Hawks','CHO':'Charlotte Hornets',
  'MIA':'Miami Heat','ORL':'Orlando Magic','WAS':'Washington Wizards','DEN':'Denver Nuggets',
  'MIN':'Minnesota Timberwolves','OKC':'Oklahoma City Thunder','POR':'Portland Trail Blazers',
  'UTA':'Utah Jazz','GSW':'Golden State Warriors','LAC':'LA Clippers','LAL':'Los Angeles Lakers',
  'PHX':'Phoenix Suns','SAC':'Sacramento Kings','DAL':'Dallas Mavericks','HOU':'Houston Rockets',
  'MEM':'Memphis Grizzlies','NOP':'New Orleans Pelicans','SAS':'San Antonio Spurs',
}

function mapTSDBtoGame(e) {
  return {
    id: e.idEvent, _source: 'tsdb',
    home_team: { full_name: e.strHomeTeam, abbreviation: (e.strHomeTeam||'').slice(0,3).toUpperCase() },
    away_team: { full_name: e.strAwayTeam, abbreviation: (e.strAwayTeam||'').slice(0,3).toUpperCase() },
    visitor_team: { full_name: e.strAwayTeam },
    date: e.dateEvent + 'T' + (e.strTime||'00:00') + ':00',
    status: e.strStatus === 'Match Finished' ? 'Final' : 'scheduled',
    home_team_score: parseInt(e.intHomeScore)||null,
    visitor_team_score: parseInt(e.intAwayScore)||null,
    period: 0, season: 2025,
  }
}
function generateNBASchedule() {
  const today = new Date()
  const games = [
    { home: "Boston Celtics",          away: "New York Knicks",           daysOut: 0 },
    { home: "Golden State Warriors",   away: "Los Angeles Lakers",        daysOut: 0 },
    { home: "Oklahoma City Thunder",   away: "Denver Nuggets",            daysOut: 0 },
    { home: "Cleveland Cavaliers",     away: "Milwaukee Bucks",           daysOut: 0 },
    { home: "Minnesota Timberwolves",  away: "Phoenix Suns",              daysOut: 1 },
    { home: "Miami Heat",              away: "Philadelphia 76ers",        daysOut: 1 },
    { home: "Dallas Mavericks",        away: "Sacramento Kings",          daysOut: 1 },
    { home: "Indiana Pacers",          away: "Atlanta Hawks",             daysOut: 1 },
    { home: "New York Knicks",         away: "Boston Celtics",            daysOut: 2 },
    { home: "Denver Nuggets",          away: "Los Angeles Clippers",      daysOut: 2 },
    { home: "Memphis Grizzlies",       away: "Houston Rockets",           daysOut: 2 },
    { home: "Milwaukee Bucks",         away: "Cleveland Cavaliers",       daysOut: 2 },
    { home: "Los Angeles Lakers",      away: "Golden State Warriors",     daysOut: 3 },
    { home: "Oklahoma City Thunder",   away: "Memphis Grizzlies",         daysOut: 3 },
    { home: "Boston Celtics",          away: "Miami Heat",                daysOut: 3 },
    { home: "Phoenix Suns",            away: "Minnesota Timberwolves",    daysOut: 3 },
    { home: "San Antonio Spurs",       away: "Chicago Bulls",             daysOut: 4 },
    { home: "Toronto Raptors",         away: "Orlando Magic",             daysOut: 4 },
    { home: "Portland Trail Blazers",  away: "Oklahoma City Thunder",     daysOut: 5 },
    { home: "Golden State Warriors",   away: "Denver Nuggets",            daysOut: 5 },
    { home: "Cleveland Cavaliers",     away: "Boston Celtics",            daysOut: 5 },
    { home: "Philadelphia 76ers",      away: "New York Knicks",           daysOut: 6 },
    { home: "Milwaukee Bucks",         away: "Minnesota Timberwolves",    daysOut: 6 },
    { home: "Los Angeles Lakers",      away: "Phoenix Suns",              daysOut: 6 },
    { home: "New Orleans Pelicans",    away: "Utah Jazz",                 daysOut: 4 },
  ]
  let id = 900000
  return games.map(g => {
    const d = new Date(today.getTime() + g.daysOut * 86400000)
    const hour = 19 + (id % 3)
    return {
      id: id++,
      home_team: { full_name: g.home, city: g.home.split(' ').slice(0,-1).join(' '), name: g.home.split(' ').slice(-1)[0] },
      away_team: { full_name: g.away, city: g.away.split(' ').slice(0,-1).join(' '), name: g.away.split(' ').slice(-1)[0] },
      visitor_team: { full_name: g.away },
      date: d.toISOString().slice(0,10) + 'T' + String(hour).padStart(2,'0') + ':00:00Z',
      status: 'scheduled',
      home_team_score: null, visitor_team_score: null,
      period: 0, season: 2025, _source: 'schedule'
    }
  })
}

// Fetch real NBA player stats for a team
async function fetchNBATeamRoster(teamAbbr) {
  return cached(`nba_roster_${teamAbbr}`, async () => {
    if (process.env.SPORTSDATAIO_KEY) {
      try {
        const r = await httpExt(`https://api.sportsdata.io/v3/nba/scores/json/Players/${teamAbbr}`,
          {}, { 'Ocp-Apim-Subscription-Key': process.env.SPORTSDATAIO_KEY })
        const players = r.data || []
        const season = new Date().getFullYear() + (new Date().getMonth() >= 9 ? 1 : 0)
        let stats = {}
        try {
          const r2 = await httpExt(`https://api.sportsdata.io/v3/nba/stats/json/PlayerSeasonStatsByTeam/${season}/${teamAbbr}`,
            {}, { 'Ocp-Apim-Subscription-Key': process.env.SPORTSDATAIO_KEY })
          for (const s of (r2.data||[])) stats[s.PlayerID] = s
        } catch(e) {}
        return players.map(p => {
          const s = stats[p.PlayerID] || {}
          const pos = p.Position || 'F'
          const posMap = { PG:'PG', SG:'SG', SF:'SF', PF:'PF', C:'C', G:'SG', F:'SF' }
          const normPos = posMap[pos] || 'SF'
          const ppg = s.Points ? parseFloat((s.Points/Math.max(1,s.Games)).toFixed(1)) : 0
          const apg = s.Assists ? parseFloat((s.Assists/Math.max(1,s.Games)).toFixed(1)) : 0
          const rpg = s.Rebounds ? parseFloat((s.Rebounds/Math.max(1,s.Games)).toFixed(1)) : 0
          const elo = NBA_ELO_BASE[NBA_TEAM_NAMES[teamAbbr]] || 1700
          const playerElo = clamp(elo - 50 + Math.round((ppg*3 + apg*1.5 + rpg) * 2))
          return {
            name: `${p.FirstName} ${p.LastName}`, position: normPos,
            elo: playerElo, isKey: ppg > 15 || apg > 7,
            playstyle: getPlaystyleForSport('basketball', normPos, p.FirstName + ' ' + p.LastName, playerElo),
            points: ppg, assists: apg, rebounds: rpg,
            games: s.Games || 0, jersey: p.Jersey,
            stats: `${ppg}ppg ${apg}apg ${rpg}rpg`,
            speed: clamp(50 + Math.round(ppg*1.5)), attack: clamp(45 + Math.round(ppg*2)),
            defense: clamp(40 + Math.round(rpg*3)), bigMatch: clamp(45 + Math.round(ppg*1.8)),
          }
        }).filter(p => p.name.trim() !== '')
      } catch(e) { console.log('⚠️  NBA roster', teamAbbr, e.message?.slice(0,40)) }
    }
    // Fall back to hardcoded key players
    const fullName = NBA_TEAM_NAMES[teamAbbr]
    return buildNBAPlayerList(fullName || teamAbbr, NBA_ELO_BASE[fullName] || 1700)
  }, TTL.L)
}

// Fetch real NFL roster
async function fetchNFLTeamRoster(teamAbbr) {
  return cached(`nfl_roster_${teamAbbr}`, async () => {
    if (process.env.SPORTSDATAIO_KEY) {
      try {
        const r = await httpExt(`https://api.sportsdata.io/v3/nfl/scores/json/Players/${teamAbbr}`,
          {}, { 'Ocp-Apim-Subscription-Key': process.env.SPORTSDATAIO_KEY })
        const players = (r.data||[]).filter(p => p.Active && p.Position)
        const posMap = { QB:'QB', RB:'RB', WR:'WR', TE:'TE', DE:'DEF', DT:'DEF', LB:'DEF', CB:'DEF', S:'DEF', OL:'OL', K:'K' }
        return players.slice(0,22).map(p => {
          const pos = posMap[p.Position] || p.Position
          const elo = NFL_ELO_BASE[NFL_TEAM_NAMES[teamAbbr]] || 1750
          const pElo = clamp(elo - 80 + Math.abs((p.PlayerID||0) % 120))
          return {
            name: `${p.FirstName} ${p.LastName}`, position: pos,
            elo: pElo, isKey: ['QB','WR'].includes(pos),
            playstyle: getPlaystyleForSport('american_football', pos, p.FirstName+' '+p.LastName, pElo),
            jersey: p.Number, stats: `#${p.Number} ${p.Position}`,
            speed: clamp(50 + Math.abs((p.PlayerID||0) % 30)),
            attack: clamp(50 + Math.abs((p.PlayerID||0) % 25)),
            defense: clamp(40 + Math.abs((p.PlayerID||0) % 30)),
            bigMatch: clamp(45 + Math.abs((p.PlayerID||0) % 25)),
          }
        })
      } catch(e) {}
    }
    return buildNFLPlayerList(NFL_TEAM_NAMES[teamAbbr] || teamAbbr, NFL_ELO_BASE[NFL_TEAM_NAMES[teamAbbr]] || 1750)
  }, TTL.L)
}

// NBA Standings
app.get('/standings/nba', async (req, res) => {
  try {
    const season = new Date().getFullYear() + (new Date().getMonth() >= 9 ? 1 : 0)
    if (process.env.SPORTSDATAIO_KEY) {
      const r = await httpExt(`https://api.sportsdata.io/v3/nba/scores/json/Standings/${season}`,
        {}, { 'Ocp-Apim-Subscription-Key': process.env.SPORTSDATAIO_KEY })
      const teams = r.data || []
      if (teams.length) {
        const east = teams.filter(t => t.Conference === 'Eastern').sort((a,b) => (b.Wins||0)-(a.Wins||0))
        const west = teams.filter(t => t.Conference === 'Western').sort((a,b) => (b.Wins||0)-(a.Wins||0))
        return res.json({ source: 'sportsdata.io', east, west, season })
      }
    }
    // ESPN fallback
    const r = await httpExt('https://site.api.espn.com/apis/v2/sports/basketball/nba/standings', { limit: 100 })
    res.json({ source: 'espn', data: r.data })
  } catch(e) { res.json({ error: e.message, east: [], west: [] }) }
})

// NFL Standings
app.get('/standings/nfl', async (req, res) => {
  try {
    const season = new Date().getFullYear()
    if (process.env.SPORTSDATAIO_KEY) {
      const r = await httpExt(`https://api.sportsdata.io/v3/nfl/scores/json/Standings/${season}`,
        {}, { 'Ocp-Apim-Subscription-Key': process.env.SPORTSDATAIO_KEY })
      if (r.data?.length) return res.json({ source: 'sportsdata.io', data: r.data, season })
    }
    const r = await httpExt('https://site.api.espn.com/apis/v2/sports/football/nfl/standings', { limit: 100 })
    res.json({ source: 'espn', data: r.data })
  } catch(e) { res.json({ error: e.message }) }
})

// F1 Driver Standings
app.get('/standings/f1', async (req, res) => {
  try {
    const r = await httpExt(`${OPEN_F1_BASE}/drivers?session_key=latest`)
    const drivers = r.data || []
    const withStyles = drivers.map(d => ({
      name: d.full_name || d.broadcast_name,
      number: d.driver_number,
      team: d.team_name,
      country: d.country_code,
      headshot: d.headshot_url,
      elo: F1_DRIVERS_2025.find(fd => fd.name === d.full_name)?.elo || 1800,
      playstyle: getPlaystyleForSport('f1', null, d.full_name||'', 1800),
    }))
    res.json({ source: 'openf1', drivers: withStyles, constructors: Object.entries(F1_CONSTRUCTOR_ELO).map(([t,e])=>({team:t,elo:e})) })
  } catch(e) {
    res.json({ source: 'static', drivers: F1_DRIVERS_2025.map(d => ({
      ...d, playstyle: getPlaystyleForSport('f1', null, d.name, d.elo)
    })), constructors: Object.entries(F1_CONSTRUCTOR_ELO).map(([t,e])=>({team:t,elo:e})) })
  }
})

// Tennis ATP/WTA Rankings
app.get('/standings/tennis', async (req, res) => {
  const tour = req.query.tour || 'ATP'
  const pool = tour === 'WTA' ? TENNIS_PLAYERS.WTA : TENNIS_PLAYERS.ATP
  res.json({ source: 'internal', tour, players: pool.map(p => ({
    ...p, playstyle: getPlaystyleForSport('tennis', null, p.name, p.elo)
  })) })
})

// Boxing rankings by weight class
app.get('/standings/boxing', async (req, res) => {
  const wc = req.query.weightClass
  const fighters = wc ? BOXING_FIGHTERS.filter(f => f.weightClass === wc) : BOXING_FIGHTERS
  res.json({ source: 'internal', fighters: fighters.map(f => ({
    ...f, playstyle: getPlaystyleForSport('boxing', null, f.name, f.elo)
  })) })
})

// MMA rankings by division
app.get('/standings/mma', async (req, res) => {
  const div = req.query.division
  const fighters = div ? MMA_FIGHTERS.filter(f => f.division === div) : MMA_FIGHTERS
  res.json({ source: 'internal', fighters: fighters.map(f => ({
    ...f, playstyle: getPlaystyleForSport('mma', null, f.name, f.elo)
  })) })
})
app.get('/standings/football', async (req, res) => {
  try {
    // Try ESPN for live standings first
    const leagues = [
      { espnSlug: 'eng.1', name: 'Premier League' },
      { espnSlug: 'esp.1', name: 'La Liga' },
      { espnSlug: 'ger.1', name: 'Bundesliga' },
      { espnSlug: 'ita.1', name: 'Serie A' },
      { espnSlug: 'fra.1', name: 'Ligue 1' },
    ]
    const results = []
    for (const lg of leagues) {
      try {
        const r = await httpExt(
          `https://site.api.espn.com/apis/v2/sports/soccer/${lg.espnSlug}/standings`,
          { limit: 30 }
        )
        const entries = r.data?.standings?.entries || r.data?.children?.[0]?.standings?.entries || []
        if (entries.length) {
          const table = entries.map(e => {
            const stats = {}
            for (const s of (e.stats || [])) stats[s.abbreviation || s.name] = s.value || s.displayValue
            return {
              position: e.note?.rank || parseInt(stats.rank) || 0,
              name: e.team?.displayName || e.team?.name || '?',
              played: parseInt(stats.GP || stats.gp || 0),
              won: parseInt(stats.W || stats.w || 0),
              drawn: parseInt(stats.T || stats.t || stats.D || 0),
              lost: parseInt(stats.L || stats.l || 0),
              goalsFor: parseInt(stats.GF || stats.gf || 0),
              goalsAgainst: parseInt(stats.GA || stats.ga || 0),
              goalDifference: parseInt(stats.GD || stats.gd || 0),
              points: parseInt(stats.PTS || stats.pts || stats.Pts || 0),
              form: (stats.FORM || stats.form || '').replace(/[^WDL]/gi, '').slice(-5).split(''),
            }
          }).sort((a, b) => a.position - b.position || b.points - a.points)
          results.push({ name: lg.name, season: new Date().getFullYear(), table })
        }
      } catch(e2) { console.log('⚠️  Standings', lg.name, e2.message?.slice(0,40)) }
      await sleep(150)
    }
    if (results.length) return res.json(results)
    res.json([])
  } catch(e) { res.status(500).json({ error: e.message }) }
})
// ELO Rankings endpoint — all sports
app.get('/elo/sport/:sport', (req, res) => {
  const sport = req.params.sport
  const limit = parseInt(req.query.limit||'50')
  const posFilter = req.query.position
  const styleFilter = req.query.playstyle

  let results = []
  if (sport === 'football') {
    const all = []
    for (const [k, v] of playerDB) {
      const p = typeof v === 'object' ? v : {}
      if (posFilter && p.position !== posFilter) continue
      if (styleFilter && (p.playstyle?.name||p.playstyle_name) !== styleFilter) continue
      all.push({ name: p.player_name||k.split('__')[0], team: p.team_name||k.split('__')[1], elo: p.elo||1500, position: p.position, playstyle: p.playstyle?.name||p.playstyle_name, sport: 'football' })
    }
    results = all.sort((a,b)=>b.elo-a.elo).slice(0,limit)
  } else if (sport === 'basketball') {
    results = Object.entries(NBA_ELO_BASE).map(([t,e])=>({ name:t, elo:e, sport:'basketball', type:'team' })).sort((a,b)=>b.elo-a.elo).slice(0,limit)
  } else if (sport === 'american_football') {
    results = Object.entries(NFL_ELO_BASE).map(([t,e])=>({ name:t, elo:e, sport:'nfl', type:'team' })).sort((a,b)=>b.elo-a.elo).slice(0,limit)
  } else if (sport === 'tennis') {
    const all = [...TENNIS_PLAYERS.ATP, ...TENNIS_PLAYERS.WTA]
    results = (posFilter ? all.filter(p=>(req.query.tour||'ATP')===p.tour) : all).sort((a,b)=>b.elo-a.elo).slice(0,limit).map(p=>({...p,sport:'tennis',type:'player',playstyle:getPlaystyleForSport('tennis',null,p.name,p.elo)}))
  } else if (sport === 'f1') {
    results = F1_DRIVERS_2025.sort((a,b)=>b.elo-a.elo).slice(0,limit).map(d=>({...d,sport:'f1',type:'driver',playstyle:getPlaystyleForSport('f1',null,d.name,d.elo)}))
  } else if (sport === 'boxing') {
    results = BOXING_FIGHTERS.sort((a,b)=>b.elo-a.elo).slice(0,limit).map(f=>({...f,sport:'boxing',type:'fighter',playstyle:getPlaystyleForSport('boxing',null,f.name,f.elo)}))
  } else if (sport === 'mma') {
    results = MMA_FIGHTERS.sort((a,b)=>b.elo-a.elo).slice(0,limit).map(f=>({...f,sport:'mma',type:'fighter',playstyle:getPlaystyleForSport('mma',null,f.name,f.elo)}))
  }
  res.json({ sport, results, count: results.length, filters: { position: posFilter, playstyle: styleFilter } })
})

// Record a match outcome — call this when results come in to train the AI
app.post('/outcomes/record', async (req, res) => {
  const { matchId, actualWinner, homeScore, awayScore, sport } = req.body
  if (!matchId) return res.status(400).json({ error: 'matchId required' })
  await recordOutcome(matchId, actualWinner, homeScore, awayScore)
  res.json({ ok: true, weights: sportWeights[sport] })
})

// Get current AI weights — shows what the system has learned
app.get('/ai/weights', (req, res) => {
  res.json({ weights: sportWeights, recentUpdates: weightUpdateLog.slice(-20), totalPredictions: predictionLog.size })
})

// Get sport-specific real team roster
app.get('/roster/:sport/:teamId', async (req, res) => {
  const { sport, teamId } = req.params
  try {
    if (sport === 'nba') return res.json(await fetchNBATeamRoster(teamId))
    if (sport === 'nfl') return res.json(await fetchNFLTeamRoster(teamId))
    res.json([])
  } catch(e) { res.json([]) }
})
// NBA team ELO seeding
const NBA_ELO_BASE = {
  "Boston Celtics": 1920, "Oklahoma City Thunder": 1910, "Cleveland Cavaliers": 1900,
  "New York Knicks": 1870, "Denver Nuggets": 1860, "Los Angeles Lakers": 1840,
  "Golden State Warriors": 1830, "Phoenix Suns": 1810, "Miami Heat": 1800,
  "Milwaukee Bucks": 1810, "LA Clippers": 1790, "Minnesota Timberwolves": 1800,
  "Philadelphia 76ers": 1780, "Sacramento Kings": 1770, "Dallas Mavericks": 1790,
  "Indiana Pacers": 1760, "Atlanta Hawks": 1740, "New Orleans Pelicans": 1730,
  "Memphis Grizzlies": 1720, "Toronto Raptors": 1710, "Chicago Bulls": 1700,
  "Houston Rockets": 1680, "Utah Jazz": 1660, "Portland Trail Blazers": 1650,
  "San Antonio Spurs": 1640, "Orlando Magic": 1680, "Brooklyn Nets": 1620,
  "Charlotte Hornets": 1600, "Washington Wizards": 1560, "Detroit Pistons": 1580,
}

// NBA notable players by team for playstyle assignment
const NBA_KEY_PLAYERS = {
  "Boston Celtics": [
    { name: "Jayson Tatum", pos: "SF", stats: "~26ppg, 8rpg, elite scorer" },
    { name: "Jaylen Brown", pos: "SG", stats: "~23ppg, 2-way wing" },
    { name: "Jrue Holiday", pos: "PG", stats: "Defensive anchor, steal machine" },
    { name: "Al Horford",   pos: "C",  stats: "Veteran floor spacer, rim protector" },
    { name: "Kristaps Porzingis", pos: "C", stats: "Stretch center, shot blocker" },
    { name: "Derrick White", pos: "SG", stats: "3-and-D, clutch shooter" },
    { name: "Payton Pritchard", pos: "PG", stats: "Deep three-point range" },
  ],
  "Oklahoma City Thunder": [
    { name: "Shai Gilgeous-Alexander", pos: "PG", stats: "~32ppg, elite scorer, MVP candidate" },
    { name: "Chet Holmgren",  pos: "C",  stats: "Unicorn: shots blocks and range" },
    { name: "Jalen Williams", pos: "SG", stats: "Rising star scorer" },
    { name: "Luguentz Dort",  pos: "SF", stats: "Elite perimeter defender" },
    { name: "Isaiah Hartenstein", pos: "C", stats: "Rim runner, good passer" },
  ],
  "Cleveland Cavaliers": [
    { name: "Donovan Mitchell", pos: "SG", stats: "~27ppg, clutch scorer" },
    { name: "Darius Garland",   pos: "PG", stats: "Shot creator, facilitator" },
    { name: "Evan Mobley",      pos: "PF", stats: "Versatile defender, developing scorer" },
    { name: "Jarrett Allen",    pos: "C",  stats: "Efficient roll man, rim protector" },
    { name: "Max Strus",        pos: "SF", stats: "3-point specialist" },
  ],
  "Denver Nuggets": [
    { name: "Nikola Jokic",   pos: "C",  stats: "3x MVP, elite passing center" },
    { name: "Jamal Murray",   pos: "PG", stats: "Clutch performer, off-screen specialist" },
    { name: "Michael Porter Jr", pos: "SF", stats: "Elite scorer, three-point range" },
    { name: "Aaron Gordon",   pos: "PF", stats: "Energy finisher, defensive versatility" },
  ],
  "Los Angeles Lakers": [
    { name: "LeBron James",   pos: "SF", stats: "40 years old, still elite all-around" },
    { name: "Anthony Davis",  pos: "C",  stats: "Dominant two-way big when healthy" },
    { name: "Austin Reaves",  pos: "SG", stats: "Clutch performer, improving scorer" },
    { name: "D'Angelo Russell", pos: "PG", stats: "Three-point shooter, floor spacer" },
  ],
  "Golden State Warriors": [
    { name: "Stephen Curry",  pos: "PG", stats: "GOAT shooter, all-time three-point leader" },
    { name: "Draymond Green", pos: "PF", stats: "Defensive mastermind, passer" },
    { name: "Andrew Wiggins", pos: "SF", stats: "Athletic wing, 3-and-D" },
    { name: "Jonathan Kuminga", pos: "PF", stats: "Young athlete, powerful finisher" },
  ],
  "Milwaukee Bucks": [
    { name: "Giannis Antetokounmpo", pos: "PF", stats: "2x MVP, dominant physical force" },
    { name: "Damian Lillard",  pos: "PG", stats: "Elite scorer, deep shooting range" },
    { name: "Brook Lopez",     pos: "C",  stats: "Corner three threat, rim protector" },
    { name: "Khris Middleton", pos: "SF", stats: "Midrange killer when healthy" },
  ],
  "New York Knicks": [
    { name: "Jalen Brunson",  pos: "PG", stats: "~27ppg, isolation scorer, clutch" },
    { name: "Karl-Anthony Towns", pos: "C", stats: "Stretch center, inside-out" },
    { name: "OG Anunoby",     pos: "SF", stats: "Elite defender, improving scorer" },
    { name: "Josh Hart",      pos: "SG", stats: "High energy, rebounding guard" },
    { name: "Mikal Bridges",  pos: "SF", stats: "Efficient scorer, defensive stopper" },
  ],
  "Minnesota Timberwolves": [
    { name: "Anthony Edwards", pos: "SG", stats: "~25ppg, rising superstar, explosive" },
    { name: "Karl-Anthony Towns", pos: "C", stats: "Stretch big, outside shot" },
    { name: "Rudy Gobert",    pos: "C",  stats: "4x DPOY, rim anchor" },
    { name: "Mike Conley",    pos: "PG", stats: "Veteran floor general" },
  ],
  "Phoenix Suns": [
    { name: "Kevin Durant",   pos: "SF", stats: "Elite scorer, unstoppable mid-range" },
    { name: "Devin Booker",   pos: "SG", stats: "30ppg scorer, clutch performer" },
    { name: "Bradley Beal",   pos: "SG", stats: "Veteran scorer when healthy" },
    { name: "Jusuf Nurkic",   pos: "C",  stats: "Physical big man, rim finisher" },
  ],
  "Miami Heat": [
    { name: "Jimmy Butler",   pos: "SF", stats: "Playoff performer, defensive leader" },
    { name: "Bam Adebayo",    pos: "C",  stats: "Versatile big, passing center" },
    { name: "Tyler Herro",    pos: "SG", stats: "High-volume scorer, pull-up threat" },
  ],
}

function buildNBAPlayerList(teamName, teamElo) {
  const known = NBA_KEY_PLAYERS[teamName] || []
  const players = []
  let seed = 0
  for (let i = 0; i < teamName.length; i++) seed = seed * 31 + teamName.charCodeAt(i)

  // Build from known list
  for (const p of known.slice(0, 8)) {
    const ps = getPlaystyleForSport('basketball', p.pos, p.name, teamElo)
    const elo = clamp(teamElo - 50 + (Math.abs(seed + players.length * 31) % 100))
    players.push({
      name: p.name, position: p.pos, elo, isKey: players.length < 3,
      stats: p.stats, playstyle: ps,
      points: Math.round(8 + (elo - 1600) / 20 + Math.abs(seed % 12)),
      assists: Math.round(1 + Math.abs((seed >> 2) % 8)),
      rebounds: Math.round(2 + Math.abs((seed >> 3) % 9)),
      speed: clamp(50 + Math.abs(seed % 30)),
      attack: clamp(50 + (elo - 1600)/10 + Math.abs((seed>>1)%20)),
      defense: clamp(40 + (elo - 1600)/12 + Math.abs((seed>>4)%20)),
      bigMatch: clamp(45 + (elo - 1600)/10 + Math.abs((seed>>5)%20)),
    })
  }
  // Fill with generic positional players
  const positions = ['PG','SG','SF','PF','C','PG','SG','SF','PF','C','PG','SG']
  while (players.length < 12) {
    const pos = positions[players.length % positions.length]
    const nameIdx = players.length
    const genericNames = ['J. Williams','M. Johnson','D. Robinson','K. Davis','A. Thompson','C. Anderson','T. Jackson','R. Wilson','B. Harris','N. Young','S. Collins','P. Brown']
    const nm = genericNames[nameIdx % genericNames.length]
    const ps = getPlaystyleForSport('basketball', pos, nm, teamElo)
    const elo = clamp(teamElo - 100 + (Math.abs(seed + players.length * 97) % 150))
    players.push({
      name: nm, position: pos, elo, isKey: false,
      stats: `~${Math.round(5 + Math.abs(seed+nameIdx) % 12)}ppg`,
      playstyle: ps,
      points: Math.round(5 + Math.abs((seed + nameIdx * 13) % 15)),
      assists: Math.round(1 + Math.abs((seed + nameIdx * 7) % 6)),
      rebounds: Math.round(1 + Math.abs((seed + nameIdx * 11) % 8)),
      speed: clamp(40 + Math.abs((seed + nameIdx * 17) % 35)),
      attack: clamp(40 + Math.abs((seed + nameIdx * 23) % 35)),
      defense: clamp(35 + Math.abs((seed + nameIdx * 29) % 35)),
      bigMatch: clamp(35 + Math.abs((seed + nameIdx * 31) % 35)),
    })
  }
  return players
}

function buildNBAPrediction(game) {
  if (!game) return null
  try {
    const isSource = game._source === 'tsdb'
    const homeName = isSource ? game.home_team?.full_name : (game.home_team?.full_name || game.home_team?.city + " " + game.home_team?.name)
    const awayName = isSource ? game.away_team?.full_name : (game.away_team?.full_name || game.visitor_team?.full_name || game.away_team?.city + " " + game.away_team?.name)
    if (!homeName || !awayName) return null

    const hElo = NBA_ELO_BASE[homeName] || (1700 + Math.abs(homeName.length * 37) % 150)
    const aElo = NBA_ELO_BASE[awayName] || (1700 + Math.abs(awayName.length * 41) % 150)
    const isLive = game.status === "In Progress" || game.period > 0 && !["Final","scheduled"].includes(game.status)
    const isFinal = game.status === "Final"
    if (isFinal) return null  // Skip finished games

    const eloDiff = (hElo + 50) - aElo  // +50 for home court
    const homeProb = Math.round(50 + eloDiff / 15)
    const awayProb = 100 - homeProb
    const homeOdds = parseFloat((100 / Math.max(1, homeProb) * 1.05).toFixed(2))
    const awayOdds = parseFloat((100 / Math.max(1, awayProb) * 1.05).toFixed(2))
    const confidence = Math.max(homeProb, awayProb)


    // Try to get real roster asynchronously — cache will serve it on next load
const homeAbbr = Object.keys(NBA_TEAM_NAMES).find(k => NBA_TEAM_NAMES[k] === homeName)
const awayAbbr = Object.keys(NBA_TEAM_NAMES).find(k => NBA_TEAM_NAMES[k] === awayName)
if (homeAbbr) fetchNBATeamRoster(homeAbbr).then(r => { if (r.length) squadDB.set(homeName, r) }).catch(()=>{})
if (awayAbbr) fetchNBATeamRoster(awayAbbr).then(r => { if (r.length) squadDB.set(awayName, r) }).catch(()=>{})
// Use real roster if already cached
const realHome = squadDB.get(homeName)
const realAway = squadDB.get(awayName)
const hPlayers = realHome?.length ? realHome : buildNBAPlayerList(homeName, hElo)
const aPlayers = realAway?.length ? realAway : buildNBAPlayerList(awayName, aElo)

    let seed = 0
    for (let i = 0; i < homeName.length; i++) seed = seed * 31 + homeName.charCodeAt(i)

    return {
      id: `nba_${game.id || game.idEvent || Date.now()}`,
      sport: 'basketball',
      home: homeName, away: awayName,
      league: "NBA", flag: "🏀",
      date: isSource ? (game.date + "T" + (game.time||"00:00") + ":00") : game.date,
      isLive, score: isLive ? `${game.home_team_score||0}-${game.visitor_team_score||0}` : null,
      period: game.period || null,
      homeElo: hElo, awayElo: aElo,
      homeProb, drawProb: 0, awayProb,
      homeOdds, drawOdds: null, awayOdds,
      confidence,
      homeLineup: hPlayers.slice(0, 8),
      awayLineup: aPlayers.slice(0, 8),
      homeForm: ["W","W","L","W","W"].slice(0, 5),
      awayForm: ["L","W","W","L","W"].slice(0, 5),
      valueBet: Math.abs(eloDiff) > 100,
      isUpsetWatch: awayProb > 40 && aElo > hElo - 50,
      upsetProb: awayProb,
      hasRealOdds: false,
      homeXg: parseFloat((105 + eloDiff/3 + (Math.abs(seed)%12 - 6)).toFixed(1)), // points projection
      awayXg: parseFloat((105 - eloDiff/3 + (Math.abs(seed>>1)%12 - 6)).toFixed(1)),
      factors: [
        { name:"ELO RATING", homeScore: Math.round(hElo/20), awayScore: Math.round(aElo/20), color:"#00d4ff" },
        { name:"HOME COURT", homeScore: 65, awayScore: 35, color:"#ff8c42" },
        { name:"RECENT FORM", homeScore: 55 + Math.abs(seed%20)-10, awayScore: 45 + Math.abs((seed>>1)%20)-10, color:"#00ff88" },
        { name:"PACE", homeScore: 50 + Math.abs((seed>>2)%25), awayScore: 50 - Math.abs((seed>>3)%25), color:"#ffd700" },
        { name:"DEPTH", homeScore: 50 + eloDiff/30, awayScore: 50 - eloDiff/30, color:"#a855f7" },
      ],
      h2h: [],
      bttsProb: null, over25Prob: null,
      ouProbs: {}, ouOdds: {},
      bookmaker: "Model",
      mismatches: [],
    }
  } catch(e) { return null }
}

// ══════════════════════════════════════════════════════════
//  NFL — ESPN API (public) + TheSportsDB
// ══════════════════════════════════════════════════════════
function generateNFLOffseasonContent() {
  // NFL Draft 2026 + upcoming preseason games (real teams)
  const today = new Date()
  const matchups = [
    { home: "Kansas City Chiefs",     away: "Philadelphia Eagles",   note: "Super Bowl LX Rematch",  daysOut: 7  },
    { home: "Baltimore Ravens",       away: "Buffalo Bills",         note: "AFC Championship Preview", daysOut: 10 },
    { home: "Detroit Lions",          away: "San Francisco 49ers",   note: "NFC Showdown",           daysOut: 14 },
    { home: "Dallas Cowboys",         away: "New York Giants",       note: "NFC East Rivalry",       daysOut: 17 },
    { home: "Green Bay Packers",      away: "Minnesota Vikings",     note: "NFC North",              daysOut: 21 },
    { home: "Los Angeles Rams",       away: "Seattle Seahawks",      note: "NFC West",               daysOut: 24 },
    { home: "Cincinnati Bengals",     away: "Pittsburgh Steelers",   note: "AFC North Rivalry",      daysOut: 28 },
    { home: "Houston Texans",         away: "Indianapolis Colts",    note: "AFC South",              daysOut: 31 },
    { home: "Miami Dolphins",         away: "New England Patriots",  note: "AFC East",               daysOut: 35 },
    { home: "Chicago Bears",          away: "Green Bay Packers",     note: "NFC North Rivalry",      daysOut: 38 },
  ]
  let id = 800000
  return matchups.map(m => {
    const d = new Date(today.getTime() + m.daysOut * 86400000)
    return {
      id: String(id++), _source: 'schedule', _note: m.note,
      competitions: [{
        competitors: [
          { homeAway: 'home', team: { displayName: m.home, abbreviation: m.home.split(' ').pop().slice(0,3).toUpperCase() } },
          { homeAway: 'away', team: { displayName: m.away, abbreviation: m.away.split(' ').pop().slice(0,3).toUpperCase() } }
        ],
        status: { type: { name: 'STATUS_SCHEDULED', completed: false } },
        date: d.toISOString()
      }],
      date: d.toISOString()
    }
  })
}

async function fetchNFLGames() {
  return cached("nfl_games", async () => {
    // SportsData.io NFL
    if (process.env.SPORTSDATAIO_KEY) {
      try {
        const today = new Date().toISOString().slice(0,10)
        const r = await httpExt(`https://api.sportsdata.io/v3/nfl/scores/json/ScoresByDate/${today}`,
          {}, { 'Ocp-Apim-Subscription-Key': process.env.SPORTSDATAIO_KEY })
        const games = r.data || []
        if (games.length > 0) {
          console.log(`✅ NFL SportsData.io: ${games.length} games`)
          return games.map(g => ({
            id: String(g.GameKey), _source: 'sportsdata',
            competitions: [{
              competitors: [
                { homeAway: 'home', team: { displayName: NFL_TEAM_NAMES[g.HomeTeam]||g.HomeTeam, abbreviation: g.HomeTeam }, score: g.HomeScore },
                { homeAway: 'away', team: { displayName: NFL_TEAM_NAMES[g.AwayTeam]||g.AwayTeam, abbreviation: g.AwayTeam }, score: g.AwayScore },
              ],
              status: { type: { name: g.Status==='Final'?'STATUS_FINAL':'STATUS_SCHEDULED', completed: g.Status==='Final' }},
              date: g.Date,
            }],
            date: g.Date,
            channel: g.Channel,
          }))
        }
      } catch(e) { console.log('⚠️  NFL SportsData.io:', e.message?.slice(0,50)) }
    }

    // ESPN public scoreboard
    try {
      const r = await httpExt('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard', { limit: 100 })
      const events = r.data?.events || []
      if (events.length > 0) { console.log(`✅ NFL ESPN: ${events.length} games`); return events }
    } catch(e) { console.log('⚠️  NFL ESPN:', e.message?.slice(0,40)) }

    // Offseason — real matchup schedule
    return generateNFLOffseasonContent()
  }, TTL.S)
}

const NFL_TEAM_NAMES = {
  'NE':'New England Patriots','BUF':'Buffalo Bills','NYJ':'New York Jets','MIA':'Miami Dolphins',
  'BAL':'Baltimore Ravens','PIT':'Pittsburgh Steelers','CLE':'Cleveland Browns','CIN':'Cincinnati Bengals',
  'HOU':'Houston Texans','IND':'Indianapolis Colts','TEN':'Tennessee Titans','JAX':'Jacksonville Jaguars',
  'KC':'Kansas City Chiefs','LV':'Las Vegas Raiders','LAC':'Los Angeles Chargers','DEN':'Denver Broncos',
  'DAL':'Dallas Cowboys','NYG':'New York Giants','PHI':'Philadelphia Eagles','WAS':'Washington Commanders',
  'CHI':'Chicago Bears','GB':'Green Bay Packers','MIN':'Minnesota Vikings','DET':'Detroit Lions',
  'ATL':'Atlanta Falcons','CAR':'Carolina Panthers','NO':'New Orleans Saints','TB':'Tampa Bay Buccaneers',
  'ARI':'Arizona Cardinals','LAR':'Los Angeles Rams','SEA':'Seattle Seahawks','SF':'San Francisco 49ers',
}

const NFL_ELO_BASE = {
  "Kansas City Chiefs": 1920, "San Francisco 49ers": 1900, "Baltimore Ravens": 1880,
  "Detroit Lions": 1870, "Buffalo Bills": 1860, "Philadelphia Eagles": 1850,
  "Dallas Cowboys": 1830, "Miami Dolphins": 1820, "Cincinnati Bengals": 1810,
  "Pittsburgh Steelers": 1800, "Cleveland Browns": 1790, "Jacksonville Jaguars": 1780,
  "Houston Texans": 1800, "Indianapolis Colts": 1760, "Tennessee Titans": 1750,
  "Los Angeles Chargers": 1790, "Las Vegas Raiders": 1730, "Denver Broncos": 1720,
  "Seattle Seahawks": 1780, "Los Angeles Rams": 1810, "Arizona Cardinals": 1710,
  "Green Bay Packers": 1820, "Minnesota Vikings": 1800, "Chicago Bears": 1740,
  "Tampa Bay Buccaneers": 1790, "New Orleans Saints": 1760, "Carolina Panthers": 1680,
  "Atlanta Falcons": 1760, "New York Giants": 1710, "Washington Commanders": 1760,
  "New England Patriots": 1700, "New York Jets": 1720,
}

const NFL_KEY_PLAYERS = {
  "Kansas City Chiefs": [
    { name: "Patrick Mahomes", pos: "QB", stats: "~4,500 passing yds, 38 TDs, MVP-level" },
    { name: "Travis Kelce",    pos: "TE", stats: "Best TE ever, ~90 rec 1000+ yds" },
    { name: "Rashee Rice",     pos: "WR", stats: "Top target, route runner" },
    { name: "Chris Jones",     pos: "DEF", stats: "Elite pass rusher, disruptor" },
  ],
  "Baltimore Ravens": [
    { name: "Lamar Jackson",   pos: "QB", stats: "2x MVP, dual threat, 100+ rush yds/game" },
    { name: "Derrick Henry",   pos: "RB", stats: "Power back, hard to bring down" },
    { name: "Zay Flowers",     pos: "WR", stats: "Quick slot receiver" },
    { name: "Roquan Smith",    pos: "DEF", stats: "Linebacker, tackling machine" },
  ],
  "San Francisco 49ers": [
    { name: "Brock Purdy",    pos: "QB", stats: "System fits perfectly, efficient" },
    { name: "Christian McCaffrey", pos: "RB", stats: "Elite all-purpose back, 2000+ total yards" },
    { name: "Deebo Samuel",   pos: "WR", stats: "Swiss army knife, after-catch monster" },
    { name: "Nick Bosa",      pos: "DEF", stats: "Premier pass rusher, 15+ sacks" },
  ],
  "Buffalo Bills": [
    { name: "Josh Allen",     pos: "QB", stats: "Dual threat, 40+ TDs, physical specimen" },
    { name: "Stefon Diggs",   pos: "WR", stats: "Deep threat, reliable hands" },
    { name: "James Cook",     pos: "RB", stats: "Speedy back, receiving threat" },
    { name: "Von Miller",     pos: "DEF", stats: "Pass rusher veteran" },
  ],
  "Detroit Lions": [
    { name: "Jared Goff",     pos: "QB", stats: "Top 5 passer in 2024, accurate" },
    { name: "Amon-Ra St. Brown", pos: "WR", stats: "Elite route runner, high catch rate" },
    { name: "Jahmyr Gibbs",   pos: "RB", stats: "Explosive back, dual threat" },
    { name: "Aidan Hutchinson", pos: "DEF", stats: "Elite young pass rusher" },
  ],
}

function buildNFLPlayerList(teamName, teamElo) {
  const known = NFL_KEY_PLAYERS[teamName] || []
  const players = []
  let seed = 0
  for (let i = 0; i < teamName.length; i++) seed = seed * 31 + teamName.charCodeAt(i)

  for (const p of known.slice(0, 6)) {
    const ps = getPlaystyleForSport('american_football', p.pos, p.name, teamElo)
    const elo = teamElo - 20 + Math.abs((seed + players.length * 31) % 60)
    players.push({
      name: p.name, position: p.pos, elo, isKey: players.length < 2,
      stats: p.stats, playstyle: ps,
      speed: clamp(50 + Math.abs((seed + players.length) % 30)),
      attack: clamp(55 + (elo - 1700) / 10 + Math.abs((seed >> 1) % 20)),
      defense: clamp(45 + (elo - 1700) / 12 + Math.abs((seed >> 4) % 20)),
      bigMatch: clamp(50 + (elo - 1700) / 10 + Math.abs((seed >> 5) % 20)),
    })
  }
  // Fill generic
  const nflPositions = ['QB','WR','RB','TE','DEF','WR','DEF','WR','RB','DEF','WR','DEF']
  const genericNFLNames = ['J. Williams','M. Brown','D. Jackson','K. Davis','T. Smith','R. Jones','C. Allen','B. Thomas','A. Taylor','N. Graham','P. White','L. Robinson']
  while (players.length < 10) {
    const pos = nflPositions[players.length % nflPositions.length]
    const nm = genericNFLNames[players.length % genericNFLNames.length]
    const ps = getPlaystyleForSport('american_football', pos, nm, teamElo)
    const elo = teamElo - 150 + Math.abs((seed + players.length * 97) % 200)
    players.push({
      name: nm, position: pos, elo, isKey: false, stats: "Starter",
      playstyle: ps,
      speed: clamp(40 + Math.abs((seed + players.length * 17) % 35)),
      attack: clamp(40 + Math.abs((seed + players.length * 23) % 35)),
      defense: clamp(35 + Math.abs((seed + players.length * 29) % 35)),
      bigMatch: clamp(35 + Math.abs((seed + players.length * 31) % 35)),
    })
  }
  return players
}

function buildNFLPrediction(event) {
  if (!event) return null
  try {
    const comp = event.competitions?.[0] || {}
    const comps = comp.competitors || []
    const homeC = comps.find(c => c.homeAway === 'home') || comps[0]
    const awayC = comps.find(c => c.homeAway === 'away') || comps[1]
    if (!homeC || !awayC) return null
    const homeName = homeC.team?.displayName || homeC.team?.name || "Home"
    const awayName = awayC.team?.displayName || awayC.team?.name || "Away"
    const status = comp.status?.type?.name || "STATUS_SCHEDULED"
    const isFinal = comp.status?.type?.completed === true || status === "STATUS_FINAL"
    // During offseason, include scheduled matchups too
    if (isFinal && event._source !== 'schedule') return null

    const hElo = NFL_ELO_BASE[homeName] || (1750 + Math.abs(homeName.length * 37) % 100)
    const aElo = NFL_ELO_BASE[awayName] || (1750 + Math.abs(awayName.length * 41) % 100)
    const eloDiff = (hElo + 30) - aElo
    const homeProb = Math.round(50 + eloDiff / 12)
    const awayProb = 100 - homeProb
    const homeOdds = parseFloat((100 / Math.max(1, homeProb) * 1.05).toFixed(2))
    const awayOdds = parseFloat((100 / Math.max(1, awayProb) * 1.05).toFixed(2))

    let seed = 0
    for (let i = 0; i < homeName.length; i++) seed = seed * 31 + homeName.charCodeAt(i)

    return {
      id: `nfl_${event.id || Date.now()}`,
      sport: 'american_football',
      home: homeName, away: awayName,
      homeAbbr: homeC.team?.abbreviation, awayAbbr: awayC.team?.abbreviation,
      league: "NFL", flag: "🏈",
      date: comp.date || event.date,
      isLive: status === "STATUS_IN_PROGRESS",
      score: status === "STATUS_IN_PROGRESS" ? `${homeC.score||0}-${awayC.score||0}` : null,
      homeElo: hElo, awayElo: aElo,
      homeProb, drawProb: 0, awayProb,
      homeOdds, drawOdds: null, awayOdds,
      confidence: Math.max(homeProb, awayProb),
      homeLineup: buildNFLPlayerList(homeName, hElo).slice(0, 8),
      awayLineup: buildNFLPlayerList(awayName, aElo).slice(0, 8),
      homeForm: ["W","L","W","W","L"],
      awayForm: ["W","W","L","W","L"],
      valueBet: Math.abs(eloDiff) > 80,
      isUpsetWatch: awayProb > 38,
      upsetProb: awayProb,
      hasRealOdds: false,
      homeXg: parseFloat((24 + eloDiff/4 + (Math.abs(seed)%8-4)).toFixed(1)), // pts projection
      awayXg: parseFloat((24 - eloDiff/4 + (Math.abs(seed>>1)%8-4)).toFixed(1)),
      factors: [
        { name:"ELO RATING",    homeScore: Math.round(hElo/20), awayScore: Math.round(aElo/20), color:"#00d4ff" },
        { name:"HOME FIELD",    homeScore: 62, awayScore: 38, color:"#ff8c42" },
        { name:"QB RATING",     homeScore: 50+eloDiff/20, awayScore: 50-eloDiff/20, color:"#00ff88" },
        { name:"DEFENSE",       homeScore: 50+Math.abs(seed%20)-10, awayScore: 50+Math.abs((seed>>1)%20)-10, color:"#ffd700" },
        { name:"RUSHING GAME",  homeScore: 50+Math.abs((seed>>2)%20)-10, awayScore: 50+Math.abs((seed>>3)%20)-10, color:"#a855f7" },
      ],
      h2h: [], bttsProb: null, ouProbs: {}, ouOdds: {},
      bookmaker: "Model", mismatches: [],
    }
  } catch(e) { return null }
}

// ══════════════════════════════════════════════════════════
//  TENNIS — TheSportsDB + ATP/WTA fallback
// ══════════════════════════════════════════════════════════
async function fetchTennisTournaments() {
  return cached("tennis_events", async () => {
    const today = new Date().toISOString().slice(0,10)

    // RapidAPI Tennis Live Data
    if (process.env.RAPIDAPI_KEY) {
      try {
        const r = await httpExt('https://tennis-live-data.p.rapidapi.com/matches-by-date/' + today,
          {}, { 'X-RapidAPI-Key': process.env.RAPIDAPI_KEY, 'X-RapidAPI-Host': 'tennis-live-data.p.rapidapi.com' })
        const matches = r.data?.results || []
        if (matches.length > 0) {
          console.log(`✅ Tennis RapidAPI: ${matches.length} matches`)
          return matches.map(m => ({
            idEvent: `tennis_rapid_${m.id||Date.now()}`,
            strHomeTeam: m.home?.name || m.home_player?.name || '',
            strAwayTeam: m.away?.name || m.away_player?.name || '',
            strStatus: m.status === 'Finished' ? 'Match Finished' : m.status || 'Not Started',
            dateEvent: today,
            strTime: m.time || '12:00',
            strLeague: m.tournament?.name || 'ATP Tour',
            _tournament: { name: m.tournament?.name||'ATP', surface: m.court_type||'Hard', tour: m.category||'ATP', location: m.venue||'' },
            _p1: enrichTennisPlayer(m.home?.name||m.home_player?.name, m.home?.ranking),
            _p2: enrichTennisPlayer(m.away?.name||m.away_player?.name, m.away?.ranking),
            _homeScore: m.home_score, _awayScore: m.away_score,
          }))
        }
      } catch(e) { console.log('⚠️  Tennis RapidAPI:', e.message?.slice(0,50)) }
    }

    // TheSportsDB tennis
    try {
      const r = await httpExt(`https://www.thesportsdb.com/api/v2/json/${process.env.THESPORTSDB_API_KEY||'3'}/eventsday.php`, { d: today, s: 'Tennis' })
      const events = r.data?.events || []
      if (events.length > 0) {
        console.log(`✅ Tennis TSDB: ${events.length} events`)
        return events.map(e => ({ ...e, _p1: enrichTennisPlayer(e.strHomeTeam), _p2: enrichTennisPlayer(e.strAwayTeam) }))
      }
    } catch(e) {}

    // Generated from real player pool
    console.log('ℹ️  Tennis: using generated matches from real player database')
    return generateTennisMatches()
  }, TTL.S)
}

// Enrich a player name with known data
function enrichTennisPlayer(name, ranking) {
  if (!name) return null
  const known = [...TENNIS_PLAYERS.ATP, ...TENNIS_PLAYERS.WTA].find(p => p.name.toLowerCase() === name.toLowerCase() || p.name.toLowerCase().includes(name.toLowerCase().split(' ').pop()))
  if (known) return { ...known, rank: ranking || known.rank }
  return { name, elo: Math.max(1400, 1900 - (ranking||100)*3), rank: ranking||100, country: 'Unknown', surface: ['Hard'] }
}

const TENNIS_PLAYERS = {
  ATP: [
    { name: "Jannik Sinner",     rank: 1,  elo: 2050, country: "Italy",     surface: ["Hard","Clay"] },
    { name: "Carlos Alcaraz",    rank: 2,  elo: 2020, country: "Spain",     surface: ["Clay","Grass","Hard"] },
    { name: "Novak Djokovic",    rank: 3,  elo: 2000, country: "Serbia",    surface: ["Hard","Clay","Grass"] },
    { name: "Alexander Zverev",  rank: 4,  elo: 1970, country: "Germany",   surface: ["Hard","Clay"] },
    { name: "Daniil Medvedev",   rank: 5,  elo: 1960, country: "Russia",    surface: ["Hard"] },
    { name: "Taylor Fritz",      rank: 6,  elo: 1930, country: "USA",       surface: ["Hard"] },
    { name: "Casper Ruud",       rank: 7,  elo: 1900, country: "Norway",    surface: ["Clay"] },
    { name: "Alex de Minaur",    rank: 8,  elo: 1890, country: "Australia", surface: ["Hard"] },
    { name: "Tommy Paul",        rank: 9,  elo: 1870, country: "USA",       surface: ["Hard"] },
    { name: "Stefanos Tsitsipas",rank: 10, elo: 1870, country: "Greece",    surface: ["Clay"] },
    { name: "Grigor Dimitrov",   rank: 11, elo: 1850, country: "Bulgaria",  surface: ["Hard","Grass"] },
    { name: "Hubert Hurkacz",    rank: 12, elo: 1840, country: "Poland",    surface: ["Hard","Grass"] },
    { name: "Frances Tiafoe",    rank: 13, elo: 1820, country: "USA",       surface: ["Hard"] },
    { name: "Sebastian Baez",    rank: 14, elo: 1800, country: "Argentina", surface: ["Clay"] },
    { name: "Ben Shelton",       rank: 15, elo: 1810, country: "USA",       surface: ["Hard"] },
    { name: "Ugo Humbert",       rank: 16, elo: 1780, country: "France",    surface: ["Hard"] },
    { name: "Karen Khachanov",   rank: 17, elo: 1760, country: "Russia",    surface: ["Hard"] },
    { name: "Holger Rune",       rank: 18, elo: 1770, country: "Denmark",   surface: ["Clay","Hard"] },
    { name: "Andrey Rublev",     rank: 19, elo: 1800, country: "Russia",    surface: ["Hard","Clay"] },
    { name: "Lorenzo Musetti",   rank: 20, elo: 1760, country: "Italy",     surface: ["Clay"] },
  ],
  WTA: [
    { name: "Aryna Sabalenka",   rank: 1,  elo: 2020, country: "Belarus",   surface: ["Hard"] },
    { name: "Iga Swiatek",       rank: 2,  elo: 2010, country: "Poland",    surface: ["Clay","Hard"] },
    { name: "Coco Gauff",        rank: 3,  elo: 1970, country: "USA",       surface: ["Hard"] },
    { name: "Elena Rybakina",    rank: 4,  elo: 1960, country: "Kazakhstan",surface: ["Grass","Hard"] },
    { name: "Qinwen Zheng",      rank: 5,  elo: 1930, country: "China",     surface: ["Hard"] },
    { name: "Jessica Pegula",    rank: 6,  elo: 1910, country: "USA",       surface: ["Hard"] },
    { name: "Madison Keys",      rank: 7,  elo: 1890, country: "USA",       surface: ["Hard"] },
    { name: "Mirra Andreeva",    rank: 8,  elo: 1870, country: "Russia",    surface: ["Clay","Hard"] },
    { name: "Jasmine Paolini",   rank: 9,  elo: 1860, country: "Italy",     surface: ["Clay"] },
    { name: "Emma Navarro",      rank: 10, elo: 1840, country: "USA",       surface: ["Hard"] },
    { name: "Daria Kasatkina",   rank: 11, elo: 1820, country: "Russia",    surface: ["Clay"] },
    { name: "Paula Badosa",      rank: 12, elo: 1810, country: "Spain",     surface: ["Clay"] },
    { name: "Barbora Krejcikova",rank: 13, elo: 1800, country: "Czech Republic", surface: ["Clay","Grass"] },
    { name: "Danielle Collins",  rank: 14, elo: 1790, country: "USA",       surface: ["Hard"] },
    { name: "Liudmila Samsonova",rank: 15, elo: 1780, country: "Russia",    surface: ["Hard"] },
  ]
}

const CURRENT_TOURNAMENTS = [
  { name: "Miami Open", surface: "Hard", tour: "ATP", location: "Miami, USA", prize: "$8.9M" },
  { name: "Miami Open", surface: "Hard", tour: "WTA", location: "Miami, USA", prize: "$8.9M" },
  { name: "Monte-Carlo Masters", surface: "Clay", tour: "ATP", location: "Monaco", prize: "$5.4M" },
  { name: "Madrid Open", surface: "Clay", tour: "ATP", location: "Madrid, Spain", prize: "$6.7M" },
  { name: "Madrid Open", surface: "Clay", tour: "WTA", location: "Madrid, Spain", prize: "$6.7M" },
  { name: "Roland Garros", surface: "Clay", tour: "ATP", location: "Paris, France", prize: "$15.3M" },
  { name: "Wimbledon", surface: "Grass", tour: "ATP", location: "London, UK", prize: "$14.8M" },
  { name: "US Open", surface: "Hard", tour: "ATP", location: "New York, USA", prize: "$15M" },
]

function generateTennisMatches() {
  const matches = []
  const tournaments = CURRENT_TOURNAMENTS.slice(0, 4)
  for (const tourn of tournaments) {
    const pool = tourn.tour === 'ATP' ? TENNIS_PLAYERS.ATP : TENNIS_PLAYERS.WTA
    // Generate 4-8 matches per tournament
    const numMatches = 4 + Math.floor(Math.random() * 4)
    const used = new Set()
    for (let i = 0; i < numMatches && used.size < pool.length - 1; i++) {
      let p1Idx, p2Idx
      do { p1Idx = Math.floor(Math.random() * pool.length) } while (used.has(p1Idx))
      do { p2Idx = Math.floor(Math.random() * pool.length) } while (used.has(p2Idx) || p2Idx === p1Idx)
      used.add(p1Idx); used.add(p2Idx)
      const p1 = pool[p1Idx], p2 = pool[p2Idx]
      const daysFromNow = Math.floor(i / 4)
      const d = new Date(Date.now() + daysFromNow * 86400000)
      matches.push({
        idEvent: `tennis_${tourn.name.replace(/\s/g,"_")}_${i}`,
        strHomeTeam: p1.name, strAwayTeam: p2.name,
        strStatus: "Not Started",
        dateEvent: d.toISOString().slice(0,10),
        strTime: `${12 + i * 2}:00`,
        strLeague: `${tourn.tour} ${tourn.name}`,
        strSport: "Tennis",
        _tournament: tourn,
        _p1: p1, _p2: p2,
      })
    }
  }
  return matches
}

function buildTennisPrediction(event) {
  if (!event) return null
  try {
    const p1Name = event.strHomeTeam || event._p1?.name
    const p2Name = event.strAwayTeam || event._p2?.name
    if (!p1Name || !p2Name) return null

    const allPlayers = [...TENNIS_PLAYERS.ATP, ...TENNIS_PLAYERS.WTA]
    const p1Data = event._p1 || allPlayers.find(p => p.name === p1Name) || { elo: 1750, rank: 50, country: "Unknown", surface: ["Hard"] }
    const p2Data = event._p2 || allPlayers.find(p => p.name === p2Name) || { elo: 1700, rank: 80, country: "Unknown", surface: ["Hard"] }
    const tourn = event._tournament || CURRENT_TOURNAMENTS[0]

    // Surface advantage
    const p1SurfAdv = p1Data.surface?.includes(tourn.surface) ? 50 : 0
    const p2SurfAdv = p2Data.surface?.includes(tourn.surface) ? 50 : 0
    const eloDiff = (p1Data.elo + p1SurfAdv) - (p2Data.elo + p2SurfAdv)
    const homeProb = Math.round(50 + eloDiff / 20)
    const awayProb = 100 - homeProb
    const homeOdds = parseFloat((100 / Math.max(1, homeProb) * 1.05).toFixed(2))
    const awayOdds = parseFloat((100 / Math.max(1, awayProb) * 1.05).toFixed(2))

    const p1Style = getPlaystyleForSport('tennis', null, p1Name, p1Data.elo)
    const p2Style = getPlaystyleForSport('tennis', null, p2Name, p2Data.elo)

    const isFinal = event.strStatus === "Match Finished"
    if (isFinal) return null

    return {
      id: `tennis_${event.idEvent || Date.now()}`,
      sport: 'tennis',
      home: p1Name, away: p2Name,
      league: event.strLeague || `${tourn?.tour || 'ATP'} ${tourn?.name || 'Tournament'}`,
      flag: "🎾",
      tournament: tourn?.name || "ATP Tour",
      surface: tourn?.surface || "Hard",
      tour: tourn?.tour || "ATP",
      date: event.dateEvent + "T" + (event.strTime || "12:00") + ":00",
      isLive: event.strStatus === "In Progress",
      homeElo: p1Data.elo, awayElo: p2Data.elo,
      homeRank: p1Data.rank, awayRank: p2Data.rank,
      homeCountry: p1Data.country, awayCountry: p2Data.country,
      homeSurfaces: p1Data.surface || [], awaySurfaces: p2Data.surface || [],
      homeProb, drawProb: 0, awayProb,
      homeOdds, drawOdds: null, awayOdds,
      confidence: Math.max(homeProb, awayProb),
      homeLineup: [{ name: p1Name, position: "Player", elo: p1Data.elo, isKey: true, playstyle: p1Style, country: p1Data.country, rank: p1Data.rank }],
      awayLineup: [{ name: p2Name, position: "Player", elo: p2Data.elo, isKey: true, playstyle: p2Style, country: p2Data.country, rank: p2Data.rank }],
      homeForm: ["W","W","L","W","W"].slice(0,5),
      awayForm: ["L","W","W","L","W"].slice(0,5),
      valueBet: Math.abs(eloDiff) > 150 && (homeProb > 65 || awayProb > 65),
      isUpsetWatch: awayProb > 35 && p2Data.rank < p1Data.rank - 10,
      upsetProb: awayProb,
      hasRealOdds: false,
      homeXg: null, awayXg: null,
      factors: [
        { name:"RANKING",        homeScore: Math.round(100 - p1Data.rank), awayScore: Math.round(100 - p2Data.rank), color:"#00d4ff" },
        { name:"SURFACE FIT",    homeScore: p1SurfAdv > 0 ? 75 : 45, awayScore: p2SurfAdv > 0 ? 75 : 45, color:"#ffd700" },
        { name:"ELO RATING",     homeScore: Math.round(p1Data.elo/22), awayScore: Math.round(p2Data.elo/22), color:"#ff8c42" },
        { name:"RECENT FORM",    homeScore: 55, awayScore: 45, color:"#00ff88" },
        { name:"H2H",            homeScore: 50, awayScore: 50, color:"#a855f7" },
      ],
      h2h: [], bttsProb: null, ouProbs: {}, ouOdds: {},
      bookmaker: "Model", mismatches: [],
    }
  } catch(e) { return null }
}

// ══════════════════════════════════════════════════════════
//  F1 — OpenF1 API (free, no key)
// ══════════════════════════════════════════════════════════
async function fetchF1NextRace() {
  return cached("f1_data", async () => {
    try {
      // OpenF1 — free, no key needed
      const [sessionsR, driversR] = await Promise.all([
        httpExt(`${OPEN_F1_BASE}/sessions?session_type=Race&year=2025`).catch(() => ({ data: [] })),
        httpExt(`${OPEN_F1_BASE}/drivers?session_key=latest`).catch(() => ({ data: [] })),
      ])
      const sessions = sessionsR.data || []
      const drivers  = driversR.data  || []
      console.log(`✅ F1 OpenF1: ${sessions.length} sessions, ${drivers.length} drivers`)

      // Find next upcoming race
      const now = Date.now()
      const upcoming = sessions
        .filter(s => new Date(s.date_start).getTime() > now - 86400000)
        .sort((a, b) => new Date(a.date_start) - new Date(b.date_start))
        .slice(0, 3)

      const predictions = buildF1Predictions(upcoming.length > 0 ? upcoming : F1_2025_CALENDAR, drivers)
      const standings = buildF1Standings()
      return { predictions, standings }
    } catch(e) {
      console.log("⚠️  F1 OpenF1:", e.message?.slice(0,50))
      // Use hardcoded 2025 calendar
      return { predictions: buildF1Predictions(F1_2025_CALENDAR, []), standings: buildF1Standings() }
    }
  }, TTL.L)
}

const F1_2025_CALENDAR = [
  { circuit_short_name: "Bahrain",   country_name: "Bahrain",      date_start: "2026-04-13T15:00:00", location: "Bahrain International Circuit", session_key: "bhr_2026" },
  { circuit_short_name: "Jeddah",    country_name: "Saudi Arabia",  date_start: "2026-04-20T18:00:00", location: "Jeddah Corniche Circuit",       session_key: "sau_2026" },
  { circuit_short_name: "Miami",     country_name: "United States", date_start: "2026-05-04T19:00:00", location: "Miami International Autodrome", session_key: "mia_2026" },
  { circuit_short_name: "Imola",     country_name: "Italy",         date_start: "2026-05-18T13:00:00", location: "Autodromo Enzo e Dino Ferrari", session_key: "imo_2026" },
  { circuit_short_name: "Monte Carlo",country_name: "Monaco",       date_start: "2026-05-25T13:00:00", location: "Circuit de Monaco",            session_key: "mon_2026" },
  { circuit_short_name: "Barcelona", country_name: "Spain",         date_start: "2026-06-01T13:00:00", location: "Circuit de Barcelona-Catalunya",session_key: "esp_2026" },
  { circuit_short_name: "Montreal",  country_name: "Canada",        date_start: "2026-06-15T18:00:00", location: "Circuit Gilles Villeneuve",     session_key: "can_2026" },
  { circuit_short_name: "Silverstone",country_name:"United Kingdom",date_start: "2026-07-06T14:00:00", location: "Silverstone Circuit",          session_key: "gbr_2026" },
  { circuit_short_name: "Spa",       country_name: "Belgium",       date_start: "2026-07-27T13:00:00", location: "Circuit de Spa-Francorchamps", session_key: "bel_2026" },
  { circuit_short_name: "Monza",     country_name: "Italy",         date_start: "2026-09-07T13:00:00", location: "Autodromo Nazionale Monza",    session_key: "ita_2026" },
  { circuit_short_name: "Baku",      country_name: "Azerbaijan",    date_start: "2026-09-21T11:00:00", location: "Baku City Circuit",            session_key: "aze_2026" },
  { circuit_short_name: "Singapore", country_name: "Singapore",     date_start: "2026-10-05T13:00:00", location: "Marina Bay Street Circuit",    session_key: "sgp_2026" },
  { circuit_short_name: "Austin",    country_name: "United States", date_start: "2026-10-19T19:00:00", location: "Circuit of the Americas",      session_key: "usa_2026" },
  { circuit_short_name: "Mexico City",country_name:"Mexico",        date_start: "2026-10-26T19:00:00", location: "Autodromo Hermanos Rodriguez",  session_key: "mex_2026" },
  { circuit_short_name: "São Paulo", country_name: "Brazil",        date_start: "2026-11-09T17:00:00", location: "Autodromo Jose Carlos Pace",   session_key: "bra_2026" },
  { circuit_short_name: "Las Vegas", country_name: "United States", date_start: "2026-11-22T06:00:00", location: "Las Vegas Strip Circuit",      session_key: "lvs_2026" },
  { circuit_short_name: "Lusail",    country_name: "Qatar",         date_start: "2026-11-30T17:00:00", location: "Lusail International Circuit", session_key: "qat_2026" },
  { circuit_short_name: "Yas Marina",country_name:"United Arab Emirates",date_start:"2026-12-07T13:00:00",location:"Yas Marina Circuit",         session_key: "uae_2026" },
  { circuit_short_name: "Bahrain",   country_name: "Bahrain",   date_start: "2025-04-13T15:00:00", location: "Bahrain International Circuit", session_key: "bhr_2025" },
  { circuit_short_name: "Jeddah",    country_name: "Saudi Arabia", date_start: "2025-04-20T18:00:00", location: "Jeddah Corniche Circuit", session_key: "sau_2025" },
  { circuit_short_name: "Miami",     country_name: "United States", date_start: "2025-05-04T19:00:00", location: "Miami International Autodrome", session_key: "mia_2025" },
  { circuit_short_name: "Imola",     country_name: "Italy",     date_start: "2025-05-18T13:00:00", location: "Autodromo Enzo e Dino Ferrari", session_key: "imo_2025" },
  { circuit_short_name: "Monte Carlo", country_name: "Monaco",  date_start: "2025-05-25T13:00:00", location: "Circuit de Monaco", session_key: "mon_2025" },
  { circuit_short_name: "Barcelona",  country_name: "Spain",    date_start: "2025-06-01T13:00:00", location: "Circuit de Barcelona-Catalunya", session_key: "esp_2025" },
  { circuit_short_name: "Montreal",   country_name: "Canada",   date_start: "2025-06-15T18:00:00", location: "Circuit Gilles Villeneuve", session_key: "can_2025" },
  { circuit_short_name: "Silverstone",country_name: "United Kingdom", date_start: "2025-07-06T14:00:00", location: "Silverstone Circuit", session_key: "gbr_2025" },
  { circuit_short_name: "Spa",        country_name: "Belgium",  date_start: "2025-07-27T13:00:00", location: "Circuit de Spa-Francorchamps", session_key: "bel_2025" },
  { circuit_short_name: "Monza",      country_name: "Italy",    date_start: "2025-09-07T13:00:00", location: "Autodromo Nazionale Monza", session_key: "ita_2025" },
  { circuit_short_name: "Baku",       country_name: "Azerbaijan", date_start: "2025-09-21T11:00:00", location: "Baku City Circuit", session_key: "aze_2025" },
  { circuit_short_name: "Singapore",  country_name: "Singapore", date_start: "2025-10-05T13:00:00", location: "Marina Bay Street Circuit", session_key: "sgp_2025" },
  { circuit_short_name: "Austin",     country_name: "United States", date_start: "2025-10-19T19:00:00", location: "Circuit of the Americas", session_key: "usa_2025" },
  { circuit_short_name: "Mexico City",country_name: "Mexico",   date_start: "2025-10-26T19:00:00", location: "Autodromo Hermanos Rodriguez", session_key: "mex_2025" },
  { circuit_short_name: "São Paulo",  country_name: "Brazil",   date_start: "2025-11-09T17:00:00", location: "Autodromo Jose Carlos Pace", session_key: "bra_2025" },
  { circuit_short_name: "Las Vegas",  country_name: "United States", date_start: "2025-11-22T06:00:00", location: "Las Vegas Strip Circuit", session_key: "lvs_2025" },
  { circuit_short_name: "Lusail",     country_name: "Qatar",    date_start: "2025-11-30T17:00:00", location: "Lusail International Circuit", session_key: "qat_2025" },
  { circuit_short_name: "Yas Marina", country_name: "United Arab Emirates", date_start: "2025-12-07T13:00:00", location: "Yas Marina Circuit", session_key: "uae_2025" },
]

const F1_DRIVERS_2025 = [
  { name: "Max Verstappen",   team: "Red Bull Racing",   number: 1,   country: "Netherlands", championships: 4, elo: 2100 },
  { name: "Lando Norris",     team: "McLaren",           number: 4,   country: "UK",          championships: 0, elo: 2020 },
  { name: "Charles Leclerc",  team: "Ferrari",           number: 16,  country: "Monaco",      championships: 0, elo: 1990 },
  { name: "Oscar Piastri",    team: "McLaren",           number: 81,  country: "Australia",   championships: 0, elo: 1970 },
  { name: "Carlos Sainz",     team: "Williams",          number: 55,  country: "Spain",       championships: 0, elo: 1960 },
  { name: "George Russell",   team: "Mercedes",          number: 63,  country: "UK",          championships: 0, elo: 1950 },
  { name: "Lewis Hamilton",   team: "Ferrari",           number: 44,  country: "UK",          championships: 7, elo: 1980 },
  { name: "Fernando Alonso",  team: "Aston Martin",      number: 14,  country: "Spain",       championships: 2, elo: 1940 },
  { name: "Nico Hülkenberg",  team: "Sauber",            number: 27,  country: "Germany",     championships: 0, elo: 1840 },
  { name: "Lance Stroll",     team: "Aston Martin",      number: 18,  country: "Canada",      championships: 0, elo: 1800 },
  { name: "Yuki Tsunoda",     team: "Red Bull Racing",   number: 22,  country: "Japan",       championships: 0, elo: 1860 },
  { name: "Alexander Albon",  team: "Williams",          number: 23,  country: "Thailand",    championships: 0, elo: 1850 },
  { name: "Pierre Gasly",     team: "Alpine",            number: 10,  country: "France",      championships: 0, elo: 1870 },
  { name: "Esteban Ocon",     team: "Haas",              number: 31,  country: "France",      championships: 0, elo: 1840 },
  { name: "Valtteri Bottas",  team: "Sauber",            number: 77,  country: "Finland",     championships: 0, elo: 1820 },
  { name: "Kevin Magnussen",  team: "Haas",              number: 20,  country: "Denmark",     championships: 0, elo: 1800 },
  { name: "Kimi Antonelli",   team: "Mercedes",          number: 12,  country: "Italy",       championships: 0, elo: 1810 },
  { name: "Isack Hadjar",     team: "Racing Bulls",      number: 6,   country: "France",      championships: 0, elo: 1790 },
  { name: "Oliver Bearman",   team: "Haas",              number: 87,  country: "UK",          championships: 0, elo: 1780 },
  { name: "Jack Doohan",      team: "Alpine",            number: 7,   country: "Australia",   championships: 0, elo: 1770 },
]

// F1 CONSTRUCTOR ELO
const F1_CONSTRUCTOR_ELO = {
  "McLaren": 2030, "Red Bull Racing": 2020, "Ferrari": 2000, "Mercedes": 1980,
  "Aston Martin": 1860, "Williams": 1840, "Racing Bulls": 1820, "Alpine": 1800,
  "Haas": 1780, "Sauber": 1760,
}

function buildF1Predictions(races, liveDrivers) {
  const now = Date.now()
  const upcoming = races
    .filter(r => new Date(r.date_start).getTime() > now - 7 * 86400000)
    .sort((a,b) => new Date(a.date_start) - new Date(b.date_start))
    .slice(0, 5)

  return upcoming.map((race, idx) => {
    const raceDate = new Date(race.date_start)
    const circuitName = race.circuit_short_name || race.location || "Circuit"
    const country = race.country_name || "Unknown"
    const isLive = Math.abs(Date.now() - raceDate.getTime()) < 3 * 3600000

    // Assign playstyles to all drivers
    const driversWithStyle = F1_DRIVERS_2025.map(d => ({
      ...d,
      playstyle: getPlaystyleForSport('f1', null, d.name, d.elo),
      constructorElo: F1_CONSTRUCTOR_ELO[d.team] || 1800,
      combinedElo: Math.round(d.elo * 0.6 + (F1_CONSTRUCTOR_ELO[d.team] || 1800) * 0.4),
    })).sort((a,b) => b.combinedElo - a.combinedElo)

    // Determine surface-specific advantage
    const isStreet = ["Monte Carlo","Baku","Singapore","Las Vegas","Jeddah"].includes(circuitName)
    const topDriver = driversWithStyle[0]
    const secondDriver = driversWithStyle[1]
    const thirdDriver = driversWithStyle[2]

    return {
      id: `f1_${race.session_key || idx}`,
      sport: 'f1',
      home: topDriver.name,     // Favourite
      away: secondDriver.name,  // Challenger
      third: thirdDriver.name,
      homeTeam: topDriver.team,
      awayTeam: secondDriver.team,
      league: "Formula 1 2025",
      flag: "🏎️",
      raceName: `${country} Grand Prix`,
      circuit: `${circuitName}, ${country}`,
      isStreetCircuit: isStreet,
      date: race.date_start,
      isLive,
      homeElo: topDriver.combinedElo,
      awayElo: secondDriver.combinedElo,
      homeProb: 32, drawProb: 0, awayProb: 22,
      homeOdds: 3.1, drawOdds: null, awayOdds: 4.5,
      confidence: 32,
      // Top 10 drivers as "lineup"
      homeLineup: driversWithStyle.filter((_,i)=>i%2===0).slice(0,5).map(d=>({
        name: d.name, position: "Driver", number: d.number,
        elo: d.combinedElo, driverElo: d.elo, constructorElo: d.constructorElo,
        isKey: d.elo > 1950, playstyle: d.playstyle,
        team: d.team, country: d.country, championships: d.championships,
      })),
      awayLineup: driversWithStyle.filter((_,i)=>i%2===1).slice(0,5).map(d=>({
        name: d.name, position: "Driver", number: d.number,
        elo: d.combinedElo, driverElo: d.elo, constructorElo: d.constructorElo,
        isKey: d.elo > 1950, playstyle: d.playstyle,
        team: d.team, country: d.country, championships: d.championships,
      })),
      allDrivers: driversWithStyle.slice(0, 20),
      constructorStandings: Object.entries(F1_CONSTRUCTOR_ELO).sort((a,b)=>b[1]-a[1]).map(([t,e])=>({ team:t, elo:e })),
      homeForm: ["W","P2","P3","W","P2"],
      awayForm: ["P2","W","P2","P3","P4"],
      valueBet: false, isUpsetWatch: false, upsetProb: 15,
      hasRealOdds: false,
      factors: [
        { name:"DRIVER RATING",  homeScore: Math.round(topDriver.elo/22),    awayScore: Math.round(secondDriver.elo/22), color:"#00d4ff" },
        { name:"CONSTRUCTOR",    homeScore: Math.round(topDriver.constructorElo/22), awayScore: Math.round(secondDriver.constructorElo/22), color:"#ff8c42" },
        { name:"CIRCUIT FIT",    homeScore: isStreet ? 70 : 55, awayScore: isStreet ? 60 : 50, color:"#ffd700" },
        { name:"CHAMPIONSHIPS",  homeScore: Math.min(99, 50 + topDriver.championships*8), awayScore: Math.min(99, 50 + secondDriver.championships*8), color:"#00ff88" },
        { name:"MOMENTUM",       homeScore: 55, awayScore: 50, color:"#a855f7" },
      ],
      h2h: [], bttsProb: null, ouProbs: {}, ouOdds: {},
      bookmaker: "Model", mismatches: [],
    }
  })
}

function buildF1Standings() {
  let pts = 290
  return F1_DRIVERS_2025.slice(0, 20).map((d, i) => {
    const p = pts
    pts = Math.max(0, pts - Math.round(8 + Math.random() * 15))
    return { pos: i+1, driver: d.name, team: d.team, points: p, elo: d.elo }
  })
}

// ══════════════════════════════════════════════════════════
//  BOXING — TheSportsDB + manual schedule
// ══════════════════════════════════════════════════════════
async function fetchBoxingEvents() {
  return cached("boxing_events", async () => {
    const today = new Date().toISOString().slice(0,10)

    // RapidAPI Boxing
    if (process.env.RAPIDAPI_KEY) {
      try {
        const r = await httpExt('https://boxing-data.p.rapidapi.com/events',
          { date: today }, { 'X-RapidAPI-Key': process.env.RAPIDAPI_KEY, 'X-RapidAPI-Host': 'boxing-data.p.rapidapi.com' })
        const events = r.data?.data || r.data || []
        if (events.length > 0) {
          console.log(`✅ Boxing RapidAPI: ${events.length}`)
          return events.map(e => ({
            idEvent: `box_rapid_${e.id||Date.now()}`,
            strHomeTeam: e.fighter1?.name || e.home || '',
            strAwayTeam: e.fighter2?.name || e.away || '',
            strLeague: e.title || e.organization || 'Boxing',
            strStatus: e.status === 'completed' ? 'Match Finished' : 'Not Started',
            dateEvent: (e.date||today).slice(0,10),
            strTime: '22:00',
            _f1: enrichBoxingFighter(e.fighter1?.name, e.fighter1),
            _f2: enrichBoxingFighter(e.fighter2?.name, e.fighter2),
            _weightClass: e.weightClass || e.weight_class || '',
          }))
        }
      } catch(e) { console.log('⚠️  Boxing RapidAPI:', e.message?.slice(0,50)) }
    }

    // TheSportsDB — scan next 14 days
    for (let d = 0; d <= 14; d++) {
      try {
        const dd = new Date(Date.now() + d*86400000).toISOString().slice(0,10)
        const r = await httpExt(`https://www.thesportsdb.com/api/v2/json/${process.env.THESPORTSDB_API_KEY||'3'}/eventsday.php`, { d: dd, s: 'Boxing' })
        const events = r.data?.events || []
        if (events.length > 0) return events.map(e => ({ ...e, _f1: enrichBoxingFighter(e.strHomeTeam), _f2: enrichBoxingFighter(e.strAwayTeam) }))
        if (d > 0) await sleep(200)
      } catch(e) {}
    }
    return generateBoxingMatches()
  }, TTL.L)
}

function enrichBoxingFighter(name, extra) {
  if (!name) return null
  const known = BOXING_FIGHTERS.find(f => f.name.toLowerCase() === (name||'').toLowerCase() || (name||'').toLowerCase().includes(f.name.toLowerCase().split(' ').pop()))
  if (known) return { ...known, ...(extra||{}) }
  return { name, elo: 1700, record: extra?.record||'?', country: extra?.country||'Unknown', weightClass: extra?.weight_class||'Unknown', titles: [] }
}

const BOXING_FIGHTERS = [
  { name: "Oleksandr Usyk",      record: "22-0",  rank: 1,  elo: 2050, weightClass: "Heavyweight",    country: "Ukraine",        titles: ["WBA","WBC","IBF","WBO"] },
  { name: "Anthony Joshua",      record: "26-3",  rank: 2,  elo: 1950, weightClass: "Heavyweight",    country: "United Kingdom", titles: ["IBF (former)"] },
  { name: "Tyson Fury",          record: "34-1-1",rank: 3,  elo: 1960, weightClass: "Heavyweight",    country: "United Kingdom", titles: [] },
  { name: "Deontay Wilder",      record: "43-3-1",rank: 4,  elo: 1900, weightClass: "Heavyweight",    country: "USA",            titles: [] },
  { name: "Daniel Dubois",       record: "21-1",  rank: 5,  elo: 1870, weightClass: "Heavyweight",    country: "United Kingdom", titles: ["IBF"] },
  { name: "Joe Joyce",           record: "16-1",  rank: 6,  elo: 1820, weightClass: "Heavyweight",    country: "United Kingdom", titles: [] },
  { name: "Dmitry Bivol",        record: "23-0",  rank: 1,  elo: 2020, weightClass: "Light Heavyweight", country: "Russia",      titles: ["WBA"] },
  { name: "Artur Beterbiev",     record: "20-0",  rank: 2,  elo: 2010, weightClass: "Light Heavyweight", country: "Russia",      titles: ["WBC","IBF","WBO"] },
  { name: "Saul 'Canelo' Alvarez",record:"60-2-2",rank: 1,  elo: 2060, weightClass: "Super Middleweight", country: "Mexico",    titles: ["WBA","WBC","IBF","WBO"] },
  { name: "David Benavidez",     record: "29-0",  rank: 2,  elo: 1990, weightClass: "Super Middleweight", country: "USA",       titles: ["WBC"] },
  { name: "Billy Joe Saunders",  record: "30-1",  rank: 3,  elo: 1870, weightClass: "Super Middleweight", country: "UK",        titles: [] },
  { name: "Naoya Inoue",         record: "27-0",  rank: 1,  elo: 2040, weightClass: "Super Bantamweight", country: "Japan",     titles: ["WBA","WBC","IBF","WBO"] },
  { name: "Stephen Fulton",      record: "21-2",  rank: 2,  elo: 1900, weightClass: "Super Bantamweight", country: "USA",       titles: [] },
  { name: "Devin Haney",         record: "31-0",  rank: 1,  elo: 1980, weightClass: "Lightweight",    country: "USA",            titles: ["WBC","WBO","WBA","IBF"] },
  { name: "Ryan Garcia",         record: "24-1",  rank: 2,  elo: 1940, weightClass: "Lightweight",    country: "USA",            titles: [] },
  { name: "Gervonta Davis",      record: "30-0",  rank: 1,  elo: 2000, weightClass: "Super Lightweight", country: "USA",         titles: ["WBA"] },
  { name: "Errol Spence Jr",     record: "28-1",  rank: 1,  elo: 2010, weightClass: "Welterweight",   country: "USA",            titles: [] },
  { name: "Terence Crawford",    record: "40-0",  rank: 2,  elo: 2020, weightClass: "Welterweight",   country: "USA",            titles: ["WBO","WBA","WBC","IBF"] },
  { name: "Jermell Charlo",      record: "35-1-1",rank:3,   elo: 1950, weightClass: "Super Welterweight", country: "USA",       titles: [] },
  { name: "Demetrius Andrade",   record: "32-0",  rank: 2,  elo: 1930, weightClass: "Middleweight",   country: "USA",            titles: [] },
]

function generateBoxingMatches() {
  const matches = []
  // Group by weight class and generate bouts
  const weightClasses = [...new Set(BOXING_FIGHTERS.map(f => f.weightClass))]
  for (const wc of weightClasses) {
    const fighters = BOXING_FIGHTERS.filter(f => f.weightClass === wc)
    if (fighters.length < 2) continue
    const daysOut = Math.floor(Math.random() * 14) + 1
    const date = new Date(Date.now() + daysOut * 86400000)
    matches.push({
      idEvent: `boxing_${wc.replace(/\s/g,"_")}_${Date.now()}`,
      strHomeTeam: fighters[0].name,
      strAwayTeam: fighters[1].name,
      strLeague: `${wc} World Championship`,
      strStatus: "Not Started",
      dateEvent: date.toISOString().slice(0,10),
      strTime: "22:00",
      _f1: fighters[0],
      _f2: fighters[1],
      _weightClass: wc,
    })
  }
  return matches
}

function buildBoxingPrediction(event) {
  if (!event) return null
  try {
    const f1Name = event.strHomeTeam
    const f2Name = event.strAwayTeam
    if (!f1Name || !f2Name) return null
    const isFinal = event.strStatus === "Match Finished"
    if (isFinal) return null

    const f1Data = event._f1 || BOXING_FIGHTERS.find(f => f.name === f1Name) || { elo: 1800, record: "?", country: "Unknown", weightClass: "Unknown", titles: [] }
    const f2Data = event._f2 || BOXING_FIGHTERS.find(f => f.name === f2Name) || { elo: 1750, record: "?", country: "Unknown", weightClass: "Unknown", titles: [] }
    const wc = event._weightClass || f1Data.weightClass || event.strLeague?.split(" ")[0] || "Boxing"

    const eloDiff = f1Data.elo - f2Data.elo
    const homeProb = Math.round(50 + eloDiff / 25)
    const awayProb = 100 - homeProb
    const homeOdds = parseFloat((100 / Math.max(1, homeProb) * 1.05).toFixed(2))
    const awayOdds = parseFloat((100 / Math.max(1, awayProb) * 1.05).toFixed(2))

    const f1Style = getPlaystyleForSport('boxing', null, f1Name, f1Data.elo)
    const f2Style = getPlaystyleForSport('boxing', null, f2Name, f2Data.elo)

    let seed = 0; for (let i = 0; i < f1Name.length; i++) seed = seed * 31 + f1Name.charCodeAt(i)

    return {
      id: `boxing_${event.idEvent || Date.now()}`,
      sport: 'boxing',
      home: f1Name, away: f2Name,
      league: event.strLeague || `${wc} Boxing`,
      flag: "🥊",
      weightClass: wc,
      date: event.dateEvent + "T" + (event.strTime || "22:00") + ":00",
      isLive: event.strStatus === "In Progress",
      homeElo: f1Data.elo, awayElo: f2Data.elo,
      homeRecord: f1Data.record, awayRecord: f2Data.record,
      homeCountry: f1Data.country, awayCountry: f2Data.country,
      homeTitles: f1Data.titles || [], awayTitles: f2Data.titles || [],
      homeProb, drawProb: 5, awayProb: awayProb - 5,
      homeOdds, drawOdds: 20.0, awayOdds,
      confidence: Math.max(homeProb, awayProb),
      homeLineup: [{ name: f1Name, position: "Boxer", elo: f1Data.elo, isKey: true, playstyle: f1Style, record: f1Data.record, country: f1Data.country, titles: f1Data.titles }],
      awayLineup: [{ name: f2Name, position: "Boxer", elo: f2Data.elo, isKey: true, playstyle: f2Style, record: f2Data.record, country: f2Data.country, titles: f2Data.titles }],
      homeForm: ["W","W","W","W","L"].slice(0,5),
      awayForm: ["W","L","W","W","W"].slice(0,5),
      koProb: Math.round(40 + Math.abs(eloDiff)/30 + Math.abs(seed%20)),
      valueBet: Math.abs(eloDiff) > 100,
      isUpsetWatch: awayProb > 38,
      upsetProb: awayProb,
      hasRealOdds: false,
      factors: [
        { name:"ELO RATING",   homeScore: Math.round(f1Data.elo/22), awayScore: Math.round(f2Data.elo/22), color:"#00d4ff" },
        { name:"RECORD",       homeScore: 60+Math.abs(seed%20)-10,   awayScore: 50+Math.abs((seed>>1)%20)-10, color:"#ff8c42" },
        { name:"POWER",        homeScore: 55+Math.abs((seed>>2)%25), awayScore: 45+Math.abs((seed>>3)%25), color:"#ff3b5c" },
        { name:"DEFENSE",      homeScore: 50+eloDiff/30,             awayScore: 50-eloDiff/30, color:"#00ff88" },
        { name:"TITLES",       homeScore: Math.min(90, 50 + (f1Data.titles?.length||0)*8), awayScore: Math.min(90, 50 + (f2Data.titles?.length||0)*8), color:"#ffd700" },
      ],
      h2h: [], bttsProb: null, ouProbs: {}, ouOdds: {},
      bookmaker: "Model", mismatches: [],
    }
  } catch(e) { return null }
}

// ══════════════════════════════════════════════════════════
//  MMA — TheSportsDB + ESPN MMA + manual UFC schedule
// ══════════════════════════════════════════════════════════
async function fetchMMAEvents() {
  return cached("mma_events", async () => {
    const today = new Date().toISOString().slice(0,10)

    // RapidAPI MMA/UFC
    if (process.env.RAPIDAPI_KEY) {
      try {
        const r = await httpExt('https://mma-stats.p.rapidapi.com/events',
          {}, { 'X-RapidAPI-Key': process.env.RAPIDAPI_KEY, 'X-RapidAPI-Host': 'mma-stats.p.rapidapi.com' })
        const events = r.data?.data || r.data?.events || []
        if (events.length > 0) {
          console.log(`✅ MMA RapidAPI: ${events.length} events`)
          return events.map(e => ({
            idEvent: `mma_rapid_${e.id||Date.now()}`,
            strHomeTeam: e.fighter1?.name || e.home || '',
            strAwayTeam: e.fighter2?.name || e.away || '',
            strLeague: e.organization || 'UFC',
            strStatus: e.status === 'completed' ? 'Match Finished' : 'Not Started',
            dateEvent: (e.date||today).slice(0,10),
            strTime: '01:00',
            strVenue: e.venue || e.location || '',
            _f1: enrichMMAFighter(e.fighter1?.name, e.fighter1),
            _f2: enrichMMAFighter(e.fighter2?.name, e.fighter2),
            _division: e.weightClass || e.weight_class || 'Unknown',
          }))
        }
      } catch(e) { console.log('⚠️  MMA RapidAPI:', e.message?.slice(0,50)) }
    }

    // ESPN MMA
    try {
      const r = await httpExt('https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard', { limit: 50 })
      const events = r.data?.events || []
      if (events.length > 0) { console.log(`✅ MMA ESPN: ${events.length}`); return events.map(e=>({...e, _source:'espn'})) }
    } catch(e) {}

    // TheSportsDB
    try {
      const r = await httpExt(`https://www.thesportsdb.com/api/v2/json/${process.env.THESPORTSDB_API_KEY||'3'}/eventsday.php`, { d: today, s: 'MMA' })
      const events = r.data?.events || []
      if (events.length > 0) return events.map(e => ({ ...e, _f1: enrichMMAFighter(e.strHomeTeam), _f2: enrichMMAFighter(e.strAwayTeam) }))
    } catch(e) {}

    return generateMMAMatches()
  }, TTL.L)
}

function enrichMMAFighter(name, extra) {
  if (!name) return null
  const known = MMA_FIGHTERS.find(f => f.name.toLowerCase() === name.toLowerCase() || name.toLowerCase().includes(f.name.toLowerCase().split(' ').pop()))
  if (known) return { ...known, ...(extra||{}) }
  return { name, elo: 1700, record: extra?.record||'?', country: extra?.country||'Unknown', division: extra?.weight_class||'Unknown', titles: [], style: 'Striker' }
}

const MMA_FIGHTERS = [
  { name: "Jon Jones",         record: "27-1",  rank: 1,  elo: 2100, division: "Heavyweight",      country: "USA",       titles: ["UFC HW Champ"], style: "Complete Fighter" },
  { name: "Stipe Miocic",      record: "20-4",  rank: 2,  elo: 1940, division: "Heavyweight",      country: "USA",       titles: [], style: "Boxer" },
  { name: "Tom Aspinall",      record: "15-3",  rank: 3,  elo: 1970, division: "Heavyweight",      country: "UK",        titles: ["Interim UFC HW Champ"], style: "Striker" },
  { name: "Islam Makhachev",   record: "26-1",  rank: 1,  elo: 2080, division: "Lightweight",      country: "Russia",    titles: ["UFC LW Champ"], style: "Wrestler" },
  { name: "Dustin Poirier",    record: "30-8",  rank: 2,  elo: 1940, division: "Lightweight",      country: "USA",       titles: [], style: "Boxer" },
  { name: "Charles Oliveira",  record: "33-10", rank: 3,  elo: 1930, division: "Lightweight",      country: "Brazil",    titles: [], style: "BJJ Specialist" },
  { name: "Conor McGregor",    record: "22-6",  rank: 5,  elo: 1870, division: "Lightweight",      country: "Ireland",   titles: [], style: "Counter Striker" },
  { name: "Leon Edwards",      record: "22-4",  rank: 1,  elo: 2000, division: "Welterweight",     country: "UK",        titles: ["UFC WW Champ"], style: "Complete Fighter" },
  { name: "Belal Muhammad",    record: "23-3",  rank: 2,  elo: 1960, division: "Welterweight",     country: "USA",       titles: [], style: "Wrestler" },
  { name: "Alex Pereira",      record: "10-2",  rank: 1,  elo: 2040, division: "Light Heavyweight",country: "Brazil",    titles: ["UFC LHW Champ"], style: "Striker" },
  { name: "Jamahal Hill",      record: "12-2",  rank: 2,  elo: 1950, division: "Light Heavyweight",country: "USA",       titles: [], style: "Striker" },
  { name: "Israel Adesanya",   record: "24-3",  rank: 1,  elo: 2020, division: "Middleweight",     country: "Nigeria",   titles: [], style: "Counter Striker" },
  { name: "Dricus du Plessis", record: "22-2",  rank: 1,  elo: 2010, division: "Middleweight",     country: "South Africa", titles: ["UFC MW Champ"], style: "Finisher" },
  { name: "Sean Strickland",   record: "28-6",  rank: 2,  elo: 1960, division: "Middleweight",     country: "USA",       titles: [], style: "Striker" },
  { name: "Ilia Topuria",      record: "15-0",  rank: 1,  elo: 2010, division: "Featherweight",    country: "Georgia",   titles: ["UFC FW Champ"], style: "Finisher" },
  { name: "Max Holloway",      record: "25-7",  rank: 2,  elo: 1970, division: "Featherweight",    country: "USA",       titles: [], style: "Swarmer" },
  { name: "Brian Ortega",      record: "16-2",  rank: 3,  elo: 1900, division: "Featherweight",    country: "USA",       titles: [], style: "BJJ Specialist" },
  { name: "Sean O'Malley",     record: "18-1",  rank: 1,  elo: 1990, division: "Bantamweight",     country: "USA",       titles: [], style: "Striker" },
  { name: "Merab Dvalishvili", record: "17-4",  rank: 1,  elo: 2000, division: "Bantamweight",     country: "Georgia",   titles: ["UFC BW Champ"], style: "Wrestler" },
  { name: "Cejudo",            record: "16-3",  rank: 3,  elo: 1890, division: "Bantamweight",     country: "USA",       titles: [], style: "Wrestler" },
  { name: "Alexandre Pantoja",  record: "27-5", rank: 1,  elo: 1970, division: "Flyweight",        country: "Brazil",    titles: ["UFC FLW Champ"], style: "BJJ Specialist" },
  { name: "Brandon Moreno",    record: "21-7-2",rank: 2,  elo: 1920, division: "Flyweight",        country: "Mexico",    titles: [], style: "BJJ Specialist" },
  { name: "Zhang Weili",       record: "24-3",  rank: 1,  elo: 2000, division: "Strawweight (W)",  country: "China",     titles: ["UFC SW Champ"], style: "Striker" },
  { name: "Rose Namajunas",    record: "12-7",  rank: 2,  elo: 1880, division: "Strawweight (W)",  country: "USA",       titles: [], style: "Counter Striker" },
  { name: "Valentina Shevchenko", record: "23-4", rank: 1, elo: 2010, division: "Flyweight (W)",  country: "Kyrgyzstan",titles: [], style: "Complete Fighter" },
  { name: "Alexa Grasso",      record: "16-3-1",rank: 1,  elo: 1970, division: "Flyweight (W)",   country: "Mexico",    titles: ["UFC FLW Champ"], style: "Striker" },
]

function generateMMAMatches() {
  const divisions = [...new Set(MMA_FIGHTERS.map(f => f.division))]
  const matches = []
  for (const div of divisions) {
    const fighters = MMA_FIGHTERS.filter(f => f.division === div)
    if (fighters.length < 2) continue
    const daysOut = Math.floor(Math.random() * 21) + 1
    const date = new Date(Date.now() + daysOut * 86400000)
    const events = [
      { name: "UFC 314", loc: "Miami, FL" },
      { name: "UFC Fight Night", loc: "Las Vegas, NV" },
      { name: "UFC 315", loc: "Montreal, Canada" },
    ]
    const ev = events[Math.floor(Math.random() * events.length)]
    matches.push({
      idEvent: `mma_${div.replace(/\s\(?\)?/g,"_")}_${Date.now() + matches.length}`,
      strHomeTeam: fighters[0].name,
      strAwayTeam: fighters[1].name,
      strLeague: `UFC — ${ev.name}`,
      strVenue: ev.loc,
      strStatus: "Not Started",
      dateEvent: date.toISOString().slice(0,10),
      strTime: "01:00",
      _f1: fighters[0],
      _f2: fighters[1],
      _division: div,
    })
  }
  return matches
}

function buildMMAPrediction(event) {
  if (!event) return null
  try {
    const f1Name = event.strHomeTeam || (event.competitions?.[0]?.competitors?.[0]?.athlete?.displayName)
    const f2Name = event.strAwayTeam || (event.competitions?.[0]?.competitors?.[1]?.athlete?.displayName)
    if (!f1Name || !f2Name) return null
    const isFinal = event.strStatus === "Match Finished" || event.competitions?.[0]?.status?.type?.completed
    if (isFinal) return null

    const f1Data = event._f1 || MMA_FIGHTERS.find(f => f.name === f1Name) || { elo: 1800, record: "?", country: "Unknown", division: "Unknown", titles: [], style: "Striker" }
    const f2Data = event._f2 || MMA_FIGHTERS.find(f => f.name === f2Name) || { elo: 1750, record: "?", country: "Unknown", division: "Unknown", titles: [], style: "Striker" }
    const div = event._division || f1Data.division || "MMA"

    const eloDiff = f1Data.elo - f2Data.elo
    const homeProb = Math.round(50 + eloDiff / 20)
    const awayProb = 100 - homeProb
    const homeOdds = parseFloat((100 / Math.max(1, homeProb) * 1.05).toFixed(2))
    const awayOdds = parseFloat((100 / Math.max(1, awayProb) * 1.05).toFixed(2))

    const f1Style = getPlaystyleForSport('mma', null, f1Name, f1Data.elo)
    const f2Style = getPlaystyleForSport('mma', null, f2Name, f2Data.elo)

    let seed = 0; for (let i = 0; i < f1Name.length; i++) seed = seed * 31 + f1Name.charCodeAt(i)

    return {
      id: `mma_${event.idEvent || Date.now()}`,
      sport: 'mma',
      home: f1Name, away: f2Name,
      league: event.strLeague || "UFC",
      flag: "🥋",
      division: div,
      venue: event.strVenue,
      date: (event.dateEvent || new Date().toISOString().slice(0,10)) + "T" + (event.strTime || "01:00") + ":00",
      isLive: event.strStatus === "In Progress",
      homeElo: f1Data.elo, awayElo: f2Data.elo,
      homeRecord: f1Data.record, awayRecord: f2Data.record,
      homeCountry: f1Data.country, awayCountry: f2Data.country,
      homeTitles: f1Data.titles || [], awayTitles: f2Data.titles || [],
      homeStyle: f1Data.style, awayStyle: f2Data.style,
      homeProb, drawProb: 0, awayProb,
      homeOdds, drawOdds: null, awayOdds,
      confidence: Math.max(homeProb, awayProb),
      homeLineup: [{
        name: f1Name, position: "Fighter", elo: f1Data.elo, isKey: true,
        playstyle: f1Style, record: f1Data.record, country: f1Data.country,
        titles: f1Data.titles, style: f1Data.style,
        attack: clamp(50 + eloDiff/20 + Math.abs(seed%25)),
        defense: clamp(50 + eloDiff/25 + Math.abs((seed>>1)%25)),
        speed: clamp(50 + Math.abs((seed>>2)%25)),
        bigMatch: clamp(50 + (f1Data.titles?.length||0)*5 + Math.abs((seed>>3)%25)),
      }],
      awayLineup: [{
        name: f2Name, position: "Fighter", elo: f2Data.elo, isKey: true,
        playstyle: f2Style, record: f2Data.record, country: f2Data.country,
        titles: f2Data.titles, style: f2Data.style,
        attack: clamp(50 - eloDiff/20 + Math.abs((seed>>4)%25)),
        defense: clamp(50 - eloDiff/25 + Math.abs((seed>>5)%25)),
        speed: clamp(50 + Math.abs((seed>>6)%25)),
        bigMatch: clamp(50 + (f2Data.titles?.length||0)*5 + Math.abs((seed>>7)%25)),
      }],
      homeForm: ["W","W","L","W","W"].slice(0,5),
      awayForm: ["L","W","W","L","W"].slice(0,5),
      finishProb: Math.round(45 + Math.abs(eloDiff)/25 + Math.abs(seed%20)),
      valueBet: Math.abs(eloDiff) > 100,
      isUpsetWatch: awayProb > 38,
      upsetProb: awayProb,
      hasRealOdds: false,
      factors: [
        { name:"ELO RATING",   homeScore: Math.round(f1Data.elo/22), awayScore: Math.round(f2Data.elo/22), color:"#00d4ff" },
        { name:"RECORD",       homeScore: 55+Math.abs(seed%20)-10,   awayScore: 50+Math.abs((seed>>1)%20)-10, color:"#ff8c42" },
        { name:"STRIKING",     homeScore: 50+Math.abs((seed>>2)%25), awayScore: 50+Math.abs((seed>>3)%25), color:"#ff3b5c" },
        { name:"GRAPPLING",    homeScore: 50+eloDiff/30,             awayScore: 50-eloDiff/30, color:"#00ff88" },
        { name:"TITLES",       homeScore: Math.min(90, 50+(f1Data.titles?.length||0)*10), awayScore: Math.min(90, 50+(f2Data.titles?.length||0)*10), color:"#ffd700" },
      ],
      h2h: [], bttsProb: null, ouProbs: {}, ouOdds: {},
      bookmaker: "Model", mismatches: [],
    }
  } catch(e) { return null }
}

// ══════════════════════════════════════════════════════════
//  FOOTBALL — SPORTMONKS (fully paid tier v3)
// ══════════════════════════════════════════════════════════

// SM include tiers — tried in order
const SM_INCLUDE_TIERS = [
  "participants;league;league.country;scores;state;odds;predictions",
  "participants;league;league.country;scores;state",
  "participants;league;league.country;scores",
  "participants;league;league.country",
  "participants;league",
]

async function smFetchWithFallback(url, extraParams, cacheKey, ttl) {
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
      if (ti > 0) console.log(`  ✅ SM tier-${ti+1} fallback: ${all.length} fixtures`)
      else console.log(`  ✅ SM: ${all.length} fixtures`)
      cache.set(cacheKey, { data: all, ts: Date.now() })
      return all
    } catch(e) {
      const status = e.response?.status || e.code || "?"
      if (ti < SM_INCLUDE_TIERS.length - 1) {
        console.log(`  ⚠️  SM tier-${ti+1} (${status}) → trying simpler...`)
        await sleep(500)
      } else {
        console.log(`  ❌ SM all tiers failed (last: ${status})`)
        if (hit) return hit.data
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
  // SM v3 full paid — correct endpoint format
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
        return { result: scored > conc ? "W" : scored < conc ? "L" : "D", scored, conceded: conc }
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

async function smPreMatchNews() {
  if (!SM_KEY) return []
  return cached("sm_news", async () => {
    try {
      const r = await http(`${SM_BASE}/news/pre-match/upcoming`, { api_token: SM_KEY, include: "fixture;league", per_page: 30, order: "desc" })
      return (r.data?.data || []).map(a => ({ title: a.title, body: a.body?.slice(0, 600) || "", fixtureId: a.fixture_id, leagueName: a.league?.name, publishedAt: a.created_at }))
    } catch(e) { console.log("⚠️  SM News:", e.message); return [] }
  }, TTL.M)
}

async function smSquad(teamId, teamName, seasonId) {
  if (!SM_KEY || !teamId) return []
  const cacheKey = `sm_squad_${teamId}_${seasonId || "cur"}`
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.ts < TTL.L) return hit.data
  try {
    const endpoints = []
    if (seasonId) endpoints.push({ url: `${SM_BASE}/squads/seasons/${seasonId}/teams/${teamId}`, params: { api_token: SM_KEY, include: "player;player.position" } })
    endpoints.push({ url: `${SM_BASE}/squads/teams/${teamId}`, params: { api_token: SM_KEY, include: "player;player.position" } })
    endpoints.push({ url: `${SM_BASE}/teams/${teamId}`, params: { api_token: SM_KEY, include: "players;players.position" } })
    endpoints.push({ url: `${SM_BASE}/players/teams/${teamId}`, params: { api_token: SM_KEY, include: "position" } })

    let entries = null
    for (const ep of endpoints) {
      try {
        const r   = await http(ep.url, ep.params)
        const raw = r.data?.data
        if (!raw) continue
        if (Array.isArray(raw)) entries = raw
        else if (raw.squad?.data || raw.squad) entries = raw.squad?.data || raw.squad || []
        else if (raw.players?.data || raw.players) entries = raw.players?.data || raw.players || []
        else entries = []
        if (entries.length > 0) { console.log(`  👥 ${teamName}: ${entries.length} players`); break }
      } catch(e2) { if ([404,403,422].includes(e2.response?.status)) continue; break }
    }
    if (!entries?.length) { cache.set(cacheKey, { data: [], ts: Date.now() }); return [] }

    const tElo = getElo(teamName) || 1550
    const built = entries.map(sq => {
      const p = sq.player || (sq.id && sq.name ? sq : null) || sq
      const posId  = p.position_id || sq.position_id
      const pos    = posId ? mapPosId(posId) : "CM"
      const pName  = p.display_name || p.common_name || p.name || "Unknown"
      const pElo   = buildPlayerElo(pName, pos, tElo, null, 0, 0)
      const attrs  = buildPlayerAttrs(pName, pos, pElo, tElo, null)
      const row = {
        player_name: pName, team_name: teamName, sm_player_id: p.id, position: pos,
        elo: pElo, speed: attrs.speed, attack: attrs.attack, defense: attrs.defense,
        big_match: attrs.bigMatch, is_key: attrs.isKey,
        playstyle_name: attrs.playstyle.name,
        goals_this_season: 0, assists_this_season: 0, appearances: 0,
        updated_at: new Date().toISOString()
      }
      playerDB.set(`${pName}__${teamName}`, { ...row, playstyle: attrs.playstyle })
      if (!squadDB.has(teamName)) squadDB.set(teamName, [])
      const ex = squadDB.get(teamName)
      const idx = ex.findIndex(x => x.player_name === pName)
      if (idx >= 0) ex[idx] = { ...row, playstyle: attrs.playstyle }
      else ex.push({ ...row, playstyle: attrs.playstyle })
      sbSave("player_ratings", row, "player_name,team_name")
      return { ...row, playstyle: attrs.playstyle, strengths: attrs.strengths, weaknesses: attrs.weaknesses }
    })
    cache.set(cacheKey, { data: built, ts: Date.now() })
    return built
  } catch(e) { return [] }
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
function monteCarlo(hxg, axg, n) { n = n || 40000; let h = 0, d = 0, a = 0; for (let i = 0; i < n; i++) { const hg = poisson(hxg), ag = poisson(axg); if (hg > ag) h++; else if (hg < ag) a++; else d++ } return { homeWin: h/n, draw: d/n, awayWin: a/n } }
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

function buildGameApproach(hElo, aElo, hForm, aForm, hxg, axg, league) {
  const LEAGUE_ELO_BANDS_LOCAL = LEAGUE_ELO_BANDS
  const band     = LEAGUE_ELO_BANDS_LOCAL[league]
  const leagueAvg = band ? (band.top + band.bot) / 2 : 1650
  const hStyle = hElo > 1850 && formScore(hForm) > 0.65 ? "High Press" : hElo > 1700 && hxg > 1.5 ? "Attack-minded" : hxg < 1.0 ? "Defensive" : "Balanced"
  const aStyle = aElo > 1850 && formScore(aForm) > 0.65 ? "High Press" : aElo > 1700 && axg > 1.5 ? "Attack-minded" : axg < 1.0 ? "Defensive" : "Balanced"
  return {
    home: { style: hStyle, descriptors: [], formScore: Math.round(formScore(hForm) * 100), xgFor: parseFloat(hxg.toFixed(2)), xgAg: parseFloat((axg * 0.9).toFixed(2)) },
    away: { style: aStyle, descriptors: [], formScore: Math.round(formScore(aForm) * 100), xgFor: parseFloat(axg.toFixed(2)), xgAg: parseFloat((hxg * 0.9).toFixed(2)) },
  }
}

function buildAllMarkets(hxg, axg, smOdds, smPred, realOdds) {
  const probs = monteCarlo(hxg, axg, 30000)
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
  const bttsY    = Math.round((1 - Math.exp(-hxg)) * (1 - Math.exp(-axg)) * 100)
  const bttsOdds = { yes: realOdds?.btts?.yes || smOdds?.btts?.yes || parseFloat((1/Math.max(0.01,bttsY/100)*1.06).toFixed(2)), no: realOdds?.btts?.no || smOdds?.btts?.no || parseFloat((1/Math.max(0.01,(100-bttsY)/100)*1.06).toFixed(2)) }
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
    { name:"ELO RATING",       homeScore:n(hElo/20),    awayScore:n(aElo/20),              color:"#00d4ff" },
    { name:"RECENT FORM",      homeScore:n(hfs),        awayScore:n(afs),                  color:"#00ff88" },
    { name:"xG ATTACK",        homeScore:n(hxg*35),     awayScore:n(axg*35),               color:"#ff3b5c" },
    { name:"DEFENSIVE SHAPE",  homeScore:n(50+ed/40),   awayScore:n(50-ed/40),             color:"#ffd700" },
    { name:"HOME ADVANTAGE",   homeScore:65,            awayScore:35,                       color:"#ff8c42" },
    { name:"SM AI PREDICTION", homeScore:smH?n(parseFloat(smH)):n(50+ed/30), awayScore:smA?n(parseFloat(smA)):n(50-ed/30), color:"#cc88ff" },
    { name:"PRESS INTENSITY",  homeScore:n(45+ed/50+Math.random()*12), awayScore:n(45-ed/50+Math.random()*12), color:"#44ddaa" },
    { name:"SQUAD DEPTH",      homeScore:n(50+ed/60+Math.random()*10), awayScore:n(50-ed/60+Math.random()*10), color:"#ffaa44" },
    { name:"MOMENTUM",         homeScore:n(hfs*1.1),   awayScore:n(afs*1.1),               color:"#ff6688" },
    { name:"TACTICAL FIT",     homeScore:n(50+ed/45+Math.random()*15), awayScore:n(50-ed/45+Math.random()*15), color:"#4488ff" },
  ]
}

function detectMismatches(homeLineup, awayLineup, homeName, awayName) {
  const mismatches = []
  if (!homeLineup?.length || !awayLineup?.length) return mismatches
  const checkMismatch = (atk, def, atkTeam, defTeam) => {
    const isPositional = (atk.position==="LW"&&def.position==="RB")||(atk.position==="RW"&&def.position==="LB")||(atk.position==="ST"&&def.position==="CB")||(atk.position==="CAM"&&def.position==="CDM")
    if (!isPositional) return
    const atkAdv = (atk.attack||60) - (def.defense||50)
    const spdAdv = (atk.speed||60)  - (def.speed||50)
    if (atkAdv > 20 || spdAdv > 25) {
      const weight = Math.min(0.95, 0.5 + (atkAdv + spdAdv) / 200)
      mismatches.push({
        attacker: { name: atk.name, pos: atk.position, elo: atk.elo, attack: atk.attack, speed: atk.speed },
        defender: { name: def.name, pos: def.position, elo: def.elo, defense: def.defense, speed: def.speed },
        atkAdvantage: Math.round(atkAdv), speedAdvantage: Math.round(spdAdv),
        favor: atkTeam, weight: parseFloat(weight.toFixed(2)),
        description: `${atk.name} (${atk.position}, atk:${atk.attack||60}) vs ${def.name} (${def.position}, def:${def.defense||50})`,
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

// ── LEAGUE NORMALISATION ──────────────────────────────────
function normLeague(raw) {
  if (!raw) return null
  const clean = raw.replace(/\s*\d{4}[/-]\d{2,4}$/,"").replace(/\s*\d{4}$/,"").trim()
  const map = {
    "Premier League":"Premier League","English Premier League":"Premier League","EPL":"Premier League",
    "La Liga":"La Liga","LaLiga":"La Liga","Spanish La Liga":"La Liga","Primera Division":"La Liga","La Liga EA Sports":"La Liga",
    "Serie A":"Serie A","Italian Serie A":"Serie A",
    "Bundesliga":"Bundesliga","German Bundesliga":"Bundesliga","1. Bundesliga":"Bundesliga",
    "Ligue 1":"Ligue 1","French Ligue 1":"Ligue 1",
    "UEFA Champions League":"Champions League","Champions League":"Champions League","UCL":"Champions League",
    "UEFA Europa League":"Europa League","Europa League":"Europa League",
    "UEFA Conference League":"Conference League","Conference League":"Conference League","UEFA Europa Conference League":"Conference League",
    "EFL Championship":"Championship","Championship":"Championship",
    "Scottish Premiership":"Scottish Premiership","Scottish Premier League":"Scottish Premiership",
    "Primeira Liga":"Primeira Liga","Liga Portugal":"Primeira Liga","Liga Portugal Betclic":"Primeira Liga",
    "Eredivisie":"Eredivisie","Dutch Eredivisie":"Eredivisie",
    "Süper Lig":"Süper Lig","Super Lig":"Süper Lig","Turkish Super Lig":"Süper Lig","Trendyol Süper Lig":"Süper Lig",
    "Belgian First Division A":"Belgian Pro League","Jupiler Pro League":"Belgian Pro League","Belgian Pro League":"Belgian Pro League",
    "Argentine Primera División":"Argentine Primera","Liga Profesional Argentina":"Argentine Primera","Argentine Primera":"Argentine Primera",
    "Brasileirao Serie A":"Brasileirão","Brazilian Serie A":"Brasileirão","Brasileirão":"Brasileirão",
    "Major League Soccer":"MLS","MLS":"MLS",
    "Saudi Professional League":"Saudi Pro League","Saudi Pro League":"Saudi Pro League","Roshn Saudi League":"Saudi Pro League",
    "FA Cup":"FA Cup","English FA Cup":"FA Cup",
    "EFL Cup":"Carabao Cup","Carabao Cup":"Carabao Cup","League Cup":"Carabao Cup",
    "2. Bundesliga":"Bundesliga 2","Bundesliga 2":"Bundesliga 2",
    "LaLiga2":"La Liga 2","La Liga 2":"La Liga 2","Segunda Division":"La Liga 2",
    "Danish Superliga":"Danish Superliga","Denmark Superliga":"Danish Superliga",
    "Greek Super League":"Greek Super League","Super League Greece":"Greek Super League",
    "Czech First League":"Czech Liga","Fortuna Liga":"Czech Liga","Czech Liga":"Czech Liga",
    "Zambia Super League":"Zambian Super League","FAZ Super League":"Zambian Super League","Zambian Super League":"Zambian Super League",
    "Premier Soccer League":"South African PSL","DStv Premiership":"South African PSL","South African PSL":"South African PSL",
    "Meistriliiga":"Estonian Meistriliiga","Estonian Meistriliiga":"Estonian Meistriliiga",
    "Copa del Rey":"Copa del Rey","Coppa Italia":"Coppa Italia","DFB Pokal":"DFB Pokal","Coupe de France":"Coupe de France",
  }
  if (map[clean]) return map[clean]
  if (map[raw]) return map[raw]
  const cleanLo = clean.toLowerCase()
  for (const [k, v] of Object.entries(map)) {
    if (k.toLowerCase() === cleanLo) return v
  }
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

// ── THE ODDS API ──────────────────────────────────────────
const ODDS_SPORTS = [
  { key: "soccer_epl",                          name: "Premier League" },
  { key: "soccer_spain_la_liga",                name: "La Liga" },
  { key: "soccer_italy_serie_a",                name: "Serie A" },
  { key: "soccer_germany_bundesliga",           name: "Bundesliga" },
  { key: "soccer_france_ligue_one",             name: "Ligue 1" },
  { key: "soccer_uefa_champs_league",           name: "Champions League" },
  { key: "soccer_uefa_europa_league",           name: "Europa League" },
  { key: "soccer_england_efl_cup",              name: "Carabao Cup" },
  { key: "soccer_fa_cup",                       name: "FA Cup" },
  { key: "soccer_efl_champ",                    name: "Championship" },
  { key: "soccer_turkey_super_league",          name: "Süper Lig" },
  { key: "soccer_belgium_first_div",            name: "Belgian Pro League" },
  { key: "soccer_portugal_primeira_liga",       name: "Primeira Liga" },
  { key: "soccer_netherlands_eredivisie",       name: "Eredivisie" },
  { key: "basketball_nba",                      name: "NBA" },
  { key: "americanfootball_nfl",                name: "NFL" },
]
const prevOddsStore = new Map()

async function fetchOddsAPI() {
  if (!ODDS_KEY) return {}
  return cached("odds_api", async () => {
    const map = {}
    for (const sport of ODDS_SPORTS) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          // NO httpsAgent — causes ERR_BAD_REQUEST
          const r = await axios.get(`https://api.the-odds-api.com/v4/sports/${sport.key}/odds`, {
            params: { apiKey: ODDS_KEY, regions: "eu", markets: "h2h", oddsFormat: "decimal" },
            timeout: 20000,
            headers: { "Accept": "application/json", "User-Agent": "SlipIQ/1.0" }
          })
          const rem = r.headers?.["x-requests-remaining"]
          if (rem !== undefined && parseInt(rem) < 3) { console.log("⚠️  Odds quota low"); return map }
          for (const g of (r.data || [])) {
            const key   = `${g.home_team}||${g.away_team}`
            const entry = { home: null, draw: null, away: null, ou: {}, btts: {} }
            for (const book of (g.bookmakers || []).slice(0, 2)) {
              for (const mkt of (book.markets || [])) {
                if (mkt.key === "h2h" && !entry.home) {
                  const out = {}
                  for (const o of mkt.outcomes) out[o.name] = o.price
                  entry.home = out[g.home_team]
                  entry.draw = out["Draw"]
                  entry.away = out[g.away_team]
                }
              }
              if (entry.home) break
            }
            if (entry.home || entry.away) map[key] = entry
          }
          console.log(`  ✅ Odds ${sport.name}: ${r.data?.length || 0}`)
          await sleep(300); break
        } catch(e) {
          const code = e.code || "", status = e.response?.status || 0
          if (status === 401 || status === 422) { console.log(`  ⚠️  Odds ${sport.name}: ${status} (skipping)`); break }
          if (["ECONNRESET","ETIMEDOUT"].includes(code) && attempt < 2) { await sleep(2000) }
          else { console.log(`  ⚠️  Odds ${sport.name}: ${code||status}`); break }
        }
      }
    }
    console.log(`✅ Odds API: ${Object.keys(map).length} matches total`)
    return map
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

// ── CORE FOOTBALL PREDICTION BUILDER ─────────────────────
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
    if (!league) return null

    const kickMs = smFix.starting_at_timestamp ? smFix.starting_at_timestamp * 1000 : new Date(smFix.starting_at || 0).getTime()
    const isLive = kickMs < now && kickMs > now - 7200000
    const BAD_STATES = new Set([5, 6, 7, 10, 13, 14, 15, 17])
    if (BAD_STATES.has(smFix.state_id) && !isLive) return null
    if (!isLive && kickMs < now - 3 * 3600000 && kickMs > 0) return null

    const smOdds = extractSMOdds(smFix.odds || [])
    const realOddsEntry = findOdds(oddsMap, home, away)
    if (realOddsEntry) {
      if (!smOdds.home) smOdds.home = realOddsEntry.home
      if (!smOdds.draw) smOdds.draw = realOddsEntry.draw
      if (!smOdds.away) smOdds.away = realOddsEntry.away
    }
    const hasRealOdds = !!(smOdds.home && smOdds.draw && smOdds.away)
    const smPred = smFix.predictions ? extractSMPreds(smFix.predictions) : {}

    let hForm = [], aForm = []
    if (homeId) hForm = await smTeamForm(homeId).then(f => f.map(x => x.result)).catch(() => [])
    if (awayId) aForm = await smTeamForm(awayId).then(f => f.map(x => x.result)).catch(() => [])

    const hElo = getElo(home, league, 0.5)
    const aElo = getElo(away, league, 0.5)
    // Get per-team adaptive weights
const hW = getTeamWeights(home)
const aW = getTeamWeights(away)

// Apply team-specific home/away multipliers to xG calculation
const hHomeAdj = hW.homeWin / 0.62   // ratio vs baseline
const aAwayAdj = aW.awayWin / 0.38

const hxg  = calcXG(hElo, aElo, hForm, true,  null) * hHomeAdj
const axg  = calcXG(aElo, hElo, aForm, false, null) * aAwayAdj
    const markets = buildAllMarkets(hxg, axg, smOdds, smPred, realOddsEntry)
    const { homeProb, drawProb, awayProb } = markets

    const homeOdds = smOdds.home || parseFloat((1/Math.max(0.01, homeProb/100)*1.06).toFixed(2))
    const drawOdds = smOdds.draw || parseFloat((1/Math.max(0.01, drawProb/100)*1.06).toFixed(2))
    const awayOdds = smOdds.away || parseFloat((1/Math.max(0.01, awayProb/100)*1.06).toFixed(2))
    const confidence = Math.min(99, Math.max(homeProb, drawProb, awayProb))

    const hVal = detectValue(homeProb, homeOdds)
    const aVal = detectValue(awayProb, awayOdds)

    const h2h = await smH2H(homeId, awayId).catch(() => [])

    // Lineups from SM fixture
    const lus = smFix.lineups || []
    const buildLu = (tId, tName, tElo) => lus.filter(l => l.team_id === tId).slice(0, 11).map((l, idx) => {
      const pos   = mapPosId(l.position_id) || "CM"
      const pName = l.player_name || (l.player && (l.player.display_name || l.player.common_name || l.player.name)) || "Unknown"
      const db    = playerDB.get(`${pName}__${tName}`)
      const pElo  = (db && db.elo) || buildPlayerElo(pName, pos, tElo, null, 0, 0)
      const attrs = db || buildPlayerAttrs(pName, pos, pElo, tElo, null)
      return {
        number: l.jersey_number || idx + 1, name: pName, position: pos, elo: pElo,
        isKey: attrs?.is_key || false, speed: attrs?.speed || 60, attack: attrs?.attack || 60,
        defense: attrs?.defense || 60, bigMatch: attrs?.bigMatch || attrs?.big_match || 60,
        playstyle: attrs?.playstyle || FOOTBALL_PLAYSTYLES[pos] || FOOTBALL_PLAYSTYLES.CM,
        goals_this_season: attrs?.goals_this_season || null,
        real_rating: attrs?.real_rating || null,
      }
    })
    const homeLineup = buildLu(homeId, home, hElo)
    const awayLineup = buildLu(awayId, away, aElo)
    const mismatches = detectMismatches(homeLineup, awayLineup, home, away)
    const gameApproach = buildGameApproach(hElo, aElo, hForm, aForm, hxg, axg, league)

    let score = null
    if (smFix.scores?.length) {
      const cH = smFix.scores.find(s => s.participant_id === homeId && s.description === "CURRENT")
      const cA = smFix.scores.find(s => s.participant_id === awayId && s.description === "CURRENT")
      if (cH || cA) score = `${cH?.score?.goals || 0}-${cA?.score?.goals || 0}`
    }

    return {
      id: smFix.id, smId: smFix.id, homeId, awayId,
      sport: 'football',
      leagueId: smFix.league_id, seasonId: smFix.season_id,
      home, away, league, leagueName: league, flag: leagueFlag(country), country,
      date: smFix.starting_at, isLive, isFinished: smFix.state_id === 5, score, minute: null,
      homeProb, drawProb, awayProb,
      gameApproach,
      homeOdds: parseFloat(homeOdds.toFixed(2)),
      drawOdds: parseFloat(drawOdds.toFixed(2)),
      awayOdds: parseFloat(awayOdds.toFixed(2)),
      homeMovement: 0, drawMovement: 0, awayMovement: 0,
      hasRealOdds, confidence,
      upsetProb:    Math.min(95, Math.round(awayProb * 0.8 + (homeOdds < 1.6 ? 15 : 5))),
      isUpsetWatch: awayProb > 28 && homeOdds > 1.5,
      valueBet:     hVal.isValue || aVal.isValue,
      homeValueEdge: hVal.edge, awayValueEdge: aVal.edge,
      homeElo: hElo, awayElo: aElo,
      homeForm: hForm.slice(0, 5), awayForm: aForm.slice(0, 5),
      homeXg: parseFloat(hxg.toFixed(2)), awayXg: parseFloat(axg.toFixed(2)),
      hasRealXG: false,
      homeTactics: inferTactics(hElo, hForm), awayTactics: inferTactics(aElo, aForm),
      homeFormation: "4-3-3", awayFormation: "4-3-3",
      homeLineup, awayLineup, mismatches, h2h,
      factors: buildFactors(hElo, aElo, hForm, aForm, hxg, axg, smPred),
      markets, bttsProb: markets.bttsYesPct, over25Prob: markets.over25Prob,
      ouProbs: markets.ouProbs, ouOdds: markets.ouOdds, bttsOdds: markets.bttsOdds, correctScores: markets.correctScores,
      smPredictions: smPred,
      bookmaker: hasRealOdds ? "Real Odds" : "Model",
      imageHome: homeP.image_path, imageAway: awayP.image_path,
    }
  } catch(err) { console.log(`⚠️  buildPrediction err:`, err.message?.slice(0,60)); return null }
}

// ── LEAGUE SORT ORDER ─────────────────────────────────────
const LEAGUE_RANK = {
  "Champions League":1,"Premier League":2,"La Liga":3,"Serie A":4,"Bundesliga":5,
  "Ligue 1":6,"Europa League":7,"Conference League":8,"FA Cup":9,"Carabao Cup":10,
  "Championship":11,"Primeira Liga":12,"Eredivisie":13,"Süper Lig":14,
  "Belgian Pro League":15,"Scottish Premiership":16,"Argentine Primera":17,
  "Brasileirão":20,"MLS":21,"Saudi Pro League":22,
  "Danish Superliga":23,"Greek Super League":24,"Czech Liga":25,
}

// ── AI ─────────────────────────────────────────────────────
const SYS_PROMPT = `You are an elite sports analytics AI for SlipIQ. You have real player data, ELOs, stats. Reference specific player names. ALWAYS respond ONLY with valid JSON. No markdown.`

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
  } catch(e) { console.log("❌ AI:", e.message?.slice(0, 80)); return { error: "AI failed" } }
}
// ── AUTO-POPULATE SQUADS ──────────────────────────────────────────────────────
async function autoPopulateSquads() {
  if (!SM_KEY) return
  console.log('🔄 Auto-populating real squad data from Sportmonks...')
  try {
    const fixtures = cache.get('sm_fix_14')?.data || await smFixtures(14).catch(() => [])
    const teamMap = new Map()  // id → name
    for (const f of fixtures) {
      for (const p of (f.participants || [])) {
        if (p.id && p.name) teamMap.set(p.id, p.name)
      }
    }
    console.log(`📋 ${teamMap.size} teams found — pulling squads...`)
    let pulled = 0, teams = 0
    for (const [teamId, teamName] of teamMap) {
      const cacheKey = `sm_squad_${teamId}_cur`
      const hit = cache.get(cacheKey)
      if (hit && Date.now() - hit.ts < TTL.XL) continue
      try {
        let entries = []
        for (const inc of ['player;player.position;player.statistics.data', 'player;player.position', 'player']) {
          try {
            const r = await http(`${SM_BASE}/squads/teams/${teamId}`, { api_token: SM_KEY, include: inc, per_page: 50 })
            entries = r.data?.data || []
            if (entries.length > 0) break
          } catch(e2) {
            if ([403, 401, 422].includes(e2.response?.status)) break
            await sleep(500)
          }
        }
        if (!entries.length) continue
        const tElo = getElo(teamName)
        let teamPulled = 0
        for (const sq of entries) {
          const p = sq.player || (sq.id && sq.name ? sq : null)
          if (!p) continue
          const pName = p.display_name || p.common_name || p.name
          if (!pName || pName.length < 2) continue
          const pos = mapPosId(p.position_id || sq.position_id) || 'CM'
          const stats = p.statistics?.data?.[0] || p.statistics?.[0] || {}
          const goals   = parseInt(stats.goals?.scored   || stats.goals    || 0)
          const assists = parseInt(stats.goals?.assists  || stats.assists  || 0)
          const apps    = parseInt(stats.appearances?.total || stats.appearences?.total || 0)
          const rating  = parseFloat(stats.rating) || 0
          const pElo  = buildPlayerElo(pName, pos, tElo, rating > 0 ? rating : null, goals, apps)
          const attrs = buildPlayerAttrs(pName, pos, pElo, tElo, rating > 0 ? rating : null)
          const row = {
            player_name: pName, team_name: teamName, sm_player_id: p.id,
            position: pos, elo: pElo, speed: attrs.speed, attack: attrs.attack,
            defense: attrs.defense, big_match: attrs.bigMatch, is_key: attrs.isKey,
            playstyle_name: attrs.playstyle.name,
            goals_this_season: goals, assists_this_season: assists,
            appearances: apps, real_rating: rating || null,
            updated_at: new Date().toISOString()
          }
          playerDB.set(`${pName}__${teamName}`, { ...row, playstyle: attrs.playstyle })
          if (!squadDB.has(teamName)) squadDB.set(teamName, [])
          const sq2 = squadDB.get(teamName)
          const idx = sq2.findIndex(x => x.player_name === pName)
          if (idx >= 0) sq2[idx] = { ...row, playstyle: attrs.playstyle }
          else sq2.push({ ...row, playstyle: attrs.playstyle })
          if (sb) sbSave('player_ratings', row, 'player_name,team_name')
          teamPulled++; pulled++
        }
        if (teamPulled > 0) {
          console.log(`  ✅ ${teamName}: ${teamPulled} real players`)
          teams++
        }
        cache.set(cacheKey, { data: entries, ts: Date.now() })
        await sleep(350)
      } catch(e) {
        if (e.response?.status === 429) { await sleep(8000) }
      }
    }
    console.log(`✅ Squads complete: ${teams} teams, ${pulled} real players`)
  } catch(e) { console.log('⚠️  autoPopulateSquads:', e.message) }
}

app.post('/admin/pull-squads', async (req, res) => {
  autoPopulateSquads().catch(() => {})
  res.json({ ok: true, message: 'Squad pull started in background', playerCount: playerDB.size })
})
// ══════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════

// ── FOOTBALL PREDICTIONS ─────────────────────────────────
app.get("/predictions", async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days || "14"), 14)
    console.log(`\n📊 /predictions (${days} days)`)
    const [smList, oddsMap, liveList] = await Promise.all([
      smFixtures(days).catch(e => { console.log("⚠️  smFix:", e.message); return [] }),
      fetchOddsAPI().catch(() => ({})),
      smLive().catch(() => []),
    ])
    const all = new Map()
    for (const f of [...smList, ...liveList]) all.set(f.id, f)
    const filtered = [...all.values()].filter(f => {
      const norm = normLeague((f.league && f.league.name) || "")
      return !!norm
    })
    const fixtures = filtered.slice(0, 400)
    console.log(`⚙️  Building ${fixtures.length} football predictions...`)
    const results = []
    const BATCH = 20
    for (let b = 0; b < fixtures.length; b += BATCH) {
      const bRes = await Promise.all(fixtures.slice(b, b + BATCH).map(f => buildPrediction(f, oddsMap).catch(() => null)))
      results.push(...bRes.filter(Boolean))
      if (b + BATCH < fixtures.length) await sleep(50)
    }
    console.log(`✅ ${results.length} football predictions ready`)
    res.json(results.sort((a, b) => {
      const rd = (LEAGUE_RANK[a.league] || 99) - (LEAGUE_RANK[b.league] || 99)
      return rd !== 0 ? rd : new Date(a.date) - new Date(b.date)
    }))
  } catch(e) { console.error("❌ /predictions:", e.message); res.status(500).json({ error: e.message }) }
})
// GET user's own referral code
app.get("/referral/my/:userId", async (req, res) => {
  if (!sb) return res.json({ code: 'SLIP' + req.params.userId.slice(0,8).toUpperCase() })
  const { data } = await sb.from('subscriptions')
    .select('referral_code, referral_count, referral_rewards_claimed, plan')
    .eq('user_id', req.params.userId).single().catch(() => ({data:null}))
  if (!data) return res.json({ code: null })
  const made = data.referral_count || 0
  res.json({
    code: data.referral_code,
    referral_count: made,
    referral_rewards_claimed: data.referral_rewards_claimed || 0,
    next_reward_at: made < 3 ? 3 : made < 5 ? 5 : made < 8 ? 8 : 'maxed',
    plan: data.plan
  })
})

// Validate a referral code
app.get("/referral/validate/:code", async (req, res) => {
  if (!sb) return res.json({ valid: false })
  const code = req.params.code.toUpperCase().trim()
  const { data } = await sb.from('subscriptions')
    .select('user_id, plan, referral_code, referral_count')
    .eq('referral_code', code).single().catch(() => ({data:null}))
  if (!data) return res.json({ valid: false, message: 'Code not found' })
  res.json({ valid: true, code, referrer_plan: data.plan, referrer_user_id: data.user_id })
})

// Apply before Stripe checkout
app.post("/referral/apply", async (req, res) => {
  if (!sb) return res.json({ ok: true, discount: 25 })
  const { code, user_email, user_id, plan } = req.body
  const ELIGIBLE = ['pro', 'elite', 'platinum', 'plus']
  if (plan && !ELIGIBLE.includes(plan)) {
    return res.json({ ok: false, reason: 'plan_not_eligible',
      message: 'Referral codes can only be used on Pro plan and above.' })
  }
  const { data: referrer } = await sb.from('subscriptions')
    .select('user_id, referral_code, plan').eq('referral_code', code.toUpperCase()).single().catch(() => ({data:null}))
  if (!referrer) return res.json({ ok: false, message: 'Code not found' })
  if (user_id && referrer.user_id === user_id) return res.json({ ok: false, message: 'Cannot use your own code' })
  if (user_id) {
    const { data: me } = await sb.from('subscriptions')
      .select('referral_used').eq('user_id', user_id).single().catch(() => ({data:null}))
    if (me?.referral_used) return res.json({ ok: false, message: 'You have already used a referral code' })
  }
  res.json({ ok: true, discount: 25, referrer_user_id: referrer.user_id,
    message: '✓ Code applied! 25% off your first month.' })
})

// Confirm after payment
app.post("/referral/confirm", async (req, res) => {
  if (!sb) return res.json({ ok: true })
  const { code, referred_user_id, referrer_user_id } = req.body
  if (!referrer_user_id) return res.json({ ok: false })
  // Mark referred user
  if (referred_user_id) {
    await sb.from('subscriptions').update({
      referral_code_used: code, referral_used: true, updated_at: new Date().toISOString()
    }).eq('user_id', referred_user_id).catch(() => {})
  }
  // Increment referrer count
  const { data: ref } = await sb.from('subscriptions')
    .select('referral_count, plan').eq('user_id', referrer_user_id).single().catch(() => ({data:null}))
  const newCount = (ref?.referral_count || 0) + 1
  let rewardPlan = null
  if (newCount >= 8 && newCount % 8 === 0) rewardPlan = 'platinum'
  else if (newCount >= 5 && newCount % 5 === 0) rewardPlan = 'elite'
  else if (newCount % 3 === 0) rewardPlan = 'pro'
  const updateData = { referral_count: newCount, updated_at: new Date().toISOString() }
  if (rewardPlan) {
    updateData.plan = rewardPlan
    updateData.credits_total = PLAN_CREDITS[rewardPlan] || 265
    updateData.credits_reset_at = new Date(Date.now() + 30*86400000).toISOString()
  }
  await sb.from('subscriptions').update(updateData).eq('user_id', referrer_user_id).catch(() => {})
  res.json({ ok: true, referral_count: newCount, reward_plan: rewardPlan })
})
// ── SPORT-SPECIFIC ROUTES ─────────────────────────────────
app.get("/predictions/nba", async (req, res) => {
  try {
    const games = await fetchNBAGames()
    const preds = games.map(buildNBAPrediction).filter(Boolean)
    console.log(`✅ NBA response: ${preds.length} predictions`)
    res.json(preds)
  } catch(e) { console.log("❌ /predictions/nba:", e.message); res.json([]) }
})

app.get("/predictions/nfl", async (req, res) => {
  try {
    const events = await fetchNFLGames()
    const preds  = events.map(buildNFLPrediction).filter(Boolean)
    console.log(`✅ NFL response: ${preds.length} predictions`)
    res.json(preds)
  } catch(e) { console.log("❌ /predictions/nfl:", e.message); res.json([]) }
})

app.get("/predictions/tennis", async (req, res) => {
  try {
    const events = await fetchTennisTournaments()
    const preds  = events.map(buildTennisPrediction).filter(Boolean)
    const { surface, tour } = req.query
    const filtered = preds.filter(p =>
      (!surface || (p.surface||"").toLowerCase() === surface.toLowerCase()) &&
      (!tour    || (p.tour||"").toLowerCase() === tour.toLowerCase())
    )
    console.log(`✅ Tennis response: ${filtered.length} predictions`)
    res.json(filtered)
  } catch(e) { console.log("❌ /predictions/tennis:", e.message); res.json([]) }
})

app.get("/predictions/f1", async (req, res) => {
  try {
    const data = await fetchF1NextRace()
    console.log(`✅ F1 response: ${data.predictions?.length||0} predictions`)
    res.json({ predictions: data.predictions || [], standings: data.standings || [] })
  } catch(e) { console.log("❌ /predictions/f1:", e.message); res.json({ predictions: [], standings: [] }) }
})

app.get("/predictions/boxing", async (req, res) => {
  try {
    const events = await fetchBoxingEvents()
    const preds  = events.map(buildBoxingPrediction).filter(Boolean)
    const { weightClass } = req.query
    const filtered = weightClass ? preds.filter(p => (p.weightClass||"").toLowerCase().includes(weightClass.toLowerCase())) : preds
    console.log(`✅ Boxing response: ${filtered.length} predictions`)
    res.json(filtered)
  } catch(e) { console.log("❌ /predictions/boxing:", e.message); res.json([]) }
})

app.get("/predictions/mma", async (req, res) => {
  try {
    const events = await fetchMMAEvents()
    const preds  = events.map(buildMMAPrediction).filter(Boolean)
    console.log(`✅ MMA response: ${preds.length} predictions`)
    res.json(preds)
  } catch(e) { console.log("❌ /predictions/mma:", e.message); res.json([]) }
})

// ── NEWS ──────────────────────────────────────────────────
app.get("/news", async (req, res) => {
  try {
    const { team, league } = req.query
    const smNews = await smPreMatchNews().catch(() => [])
    let newsData = []
    if (NEWS_KEY) {
      const q = team || league ? `football ${[team, league].filter(Boolean).join(" ")} injury transfer` : "football premier league champions league"
      newsData = await cached("newsapi_" + q.slice(0, 30), async () => {
        const r = await axios.get("https://newsapi.org/v2/everything", { params: { q, language: "en", sortBy: "publishedAt", pageSize: 30, apiKey: NEWS_KEY }, timeout: 15000 })
        return (r.data.articles || []).map(a => ({ title: a.title, source: a.source?.name, publishedAt: a.publishedAt, url: a.url, description: a.description, urlToImage: a.urlToImage }))
      }, TTL.M).catch(() => [])
    }
    let filtered = smNews
    if (team)   filtered = filtered.filter(a => (a.body || a.title || "").toLowerCase().includes(team.toLowerCase()))
    if (league) filtered = filtered.filter(a => (a.leagueName || "").toLowerCase().includes(league.toLowerCase()))
    res.json([...filtered.slice(0, 20), ...newsData.slice(0, 15)])
  } catch(e) { res.json([]) }
})

app.post("/news/analyze", requireAccess('news_analysis'), async (req, res) => {
  const userId = req.headers['x-user-id'] || req.query.userId || req.body?.userId
  const { article, predictions } = req.body
  if (!article) return res.json({ error: "No article" })
  try {
    const prompt = `Football betting analyst. Analyze this news for betting impact.\nTitle: ${article.title||""}\nBody: ${(article.body||article.description||"").slice(0,600)}\nReturn JSON: {"summary":"2 sentences","impactLevel":"HIGH|MEDIUM|LOW|NONE","marketImpact":"odds insight","recommendation":"betting action","keyInsight":"most important insight","impactTeams":["team1"]}`
    res.json(await callAI(prompt, 500))
  } catch(e) { res.json({ error: "Failed" }) }
})

// ── ANALYZE ───────────────────────────────────────────────
app.post("/analyze", async (req, res) => {
  const userId = req.headers['x-user-id'] || req.query.userId || req.body?.userId
  const { match, type } = req.body
  try {
    let prompt = ""
    if (type === "match") {
      const m = match
      const hKeys = (squadDB.get(m.home)||[]).filter(p=>p.is_key).map(p=>`${p.player_name}(${p.position},ELO${p.elo})`).slice(0,5).join(",") || "SM data loading"
      const aKeys = (squadDB.get(m.away)||[]).filter(p=>p.is_key).map(p=>`${p.player_name}(${p.position},ELO${p.elo})`).slice(0,5).join(",") || "SM data loading"
      const sport = m.sport || 'football'
      prompt = `${sport.toUpperCase()} Match: ${m.home} vs ${m.away} | ${m.league}\nELO: H${m.homeElo} A${m.awayElo}\nProbs: H${m.homeProb}% D${m.drawProb||0}% A${m.awayProb}%\nKey players H: ${hKeys}\nKey players A: ${aKeys}\nReturn JSON: {"mainAnalysis":"3-4 sentences with specific player names","recommendation":"${sport==='football'?'Home Win|Draw|Away Win':'Home Win|Away Win'}","oneLineSummary":"sharp one-liner","keyFactors":["5 factors"],"mismatchImpact":"key matchup","confidenceRating":${m.confidence}}`
    } else if (type === "upset") {
      const m = match
      prompt = `Upset pick: ${m.home}(ELO${m.homeElo}) vs ${m.away}(ELO${m.awayElo},odds:${m.awayOdds})\nReturn JSON: {"upsetReasons":["4 reasons"],"upsetTrigger":"scenario","worthBacking":true,"upsetConfidence":${m.awayProb}}`
    } else if (type === "parlay") {
      const legs = Array.isArray(match) ? match : [match]
      const co   = legs.reduce((p, l) => p * l.odds, 1).toFixed(2)
      prompt = `${legs.length}-leg parlay:\n${legs.map((l,i)=>`${i+1}. ${l.matchName}: ${l.label}@${l.odds}(${l.prob}%)`).join("\n")}\nCombined: ${co}x\nReturn JSON: {"assessment":"2-3 sentences","hasValue":true,"valueExplanation":"","weakestLeg":"match+reason","keyRisks":["2 risks"]}`
    } else if (type === "player") {
      const { player: pl, team: tn } = match
      prompt = `Scout: ${pl.player_name||pl.name}(${pl.position}) at ${tn}. ELO:${pl.elo}\nReturn JSON: {"profile":"2-3 sentences","strengths":["3"],"weaknesses":["2"],"similarTo":"real comparable player"}`
    }
    res.json(await callAI(prompt))
  } catch(e) { res.json({ error: "Analysis failed" }) }
})
app.get('/teams', async (req, res) => {
  try {
    const r = await httpExt(
      'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams',
      { limit: 100 }
    )
    const teams = (r.data?.sports?.[0]?.leagues?.[0]?.teams || []).map(t => ({
      name: t.team?.displayName || t.team?.name,
      elo: getElo(t.team?.displayName || ''),
      country: 'England',
      league: 'Premier League',
    }))
    res.json(teams)
  } catch(e) { res.json([]) }
})
// ── PARLAY AUTO-BUILD ─────────────────────────────────────
app.post("/parlay/auto", async (req, res) => {
  const { predictions=[], targetOdds=4.0, riskLevel=5, minLegs=2, maxLegs=8, preferredMarkets=["auto"] } = req.body
  if (!predictions.length) return res.json({ parlay: [], combinedOdds: 1, error: "No predictions" })
  const now = Date.now()
  const pool = predictions.filter(m => !m.isLive && !m.isFinished && (!m.date || new Date(m.date).getTime() - now <= 14 * 86400000))
  if (!pool.length) return res.json({ parlay: [], combinedOdds: 1, notEnoughMatches: "No upcoming matches" })
  const candidates = []
  const mkts = Array.isArray(preferredMarkets) ? preferredMarkets : ["auto"]
  for (const m of pool) {
    const addPick = (pick, label, odds, prob) => {
      if (!odds || odds < 1.04 || !prob || prob < 1) return
      const edge  = prob - 100 / odds
      const score = (prob*0.55) + (edge*2.5) + ((10-riskLevel)*0.8) + (m.hasRealOdds?6:0)
      candidates.push({ matchId: m.id, pick, label, odds: parseFloat(odds.toFixed(2)), prob: Math.round(prob), matchName: `${m.home} vs ${m.away}`, league: m.league, confidence: m.confidence, hasRealOdds: m.hasRealOdds, sport: m.sport || 'football', score, edge: parseFloat(edge.toFixed(2)) })
    }
    for (const mkt of mkts) {
      if (["1x2","auto","h2h"].includes(mkt)) {
        addPick("home",`${m.home} Win`,m.homeOdds,m.homeProb)
        if (m.drawOdds) addPick("draw","Draw",m.drawOdds,m.drawProb)
        addPick("away",`${m.away} Win`,m.awayOdds,m.awayProb)
      }
      if (["btts","auto"].includes(mkt) && m.bttsOdds?.yes) addPick("btts_yes","Both Teams Score",m.bttsOdds.yes,m.bttsProb)
      if (["ou_2.5","auto"].includes(mkt) && m.ouOdds?.[2.5]?.over) addPick("over_2.5","Over 2.5 Goals",m.ouOdds[2.5].over,m.ouProbs?.[2.5]?.overPct)
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  const used = new Set(), selected = []
  let co = 1.0
  for (const c of candidates) {
    if (used.has(c.matchId) || c.prob < 30) continue
    if (selected.length >= maxLegs || (co >= targetOdds && selected.length >= minLegs)) break
    selected.push(c); used.add(c.matchId); co *= c.odds
  }
  if (!selected.length) return res.json({ parlay: [], combinedOdds: 1, notEnoughMatches: "No picks meet criteria" })
  const avgConf = selected.reduce((s, c) => s + c.prob, 0) / selected.length
  const score   = Math.max(10, Math.min(99, Math.round(avgConf - Math.max(0,(selected.length-3)*5) + (10-riskLevel)*2)))
  res.json({ parlay: selected, combinedOdds: parseFloat(co.toFixed(2)), score })
})

// ── PARLAYS ───────────────────────────────────────────────
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

// ── USER & CREDITS ────────────────────────────────────────
app.get("/user/:userId", async (req, res) => {
  if (!sb) return res.status(503).json({ error: "Supabase not configured" })
  try {
    const { data, error } = await sb.from("subscriptions").select("*").eq("id", req.params.userId).single()
    if (error || !data) return res.status(404).json({ error: "User not found" })
    const available = data.plan === "platinum" ? 999999 : Math.max(0, (data.credits_total||0) - (data.credits_used||0))
    res.json({ ...data, credits_available: available })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post("/credits/use", async (req, res) => {
  if (!sb) return res.status(503).json({ error: "Supabase not configured" })
  const { user_id, action } = req.body
  if (!user_id || !action) return res.status(400).json({ error: "Missing fields" })
  const cost = ACTION_COSTS[action]
  if (cost === undefined) return res.status(400).json({ error: "Unknown action" })
  const access = await checkAccess(user_id, action)
  if (!access.ok) return res.status(402).json({ ok: false, ...access })
  const result = await useCredits(user_id, action)
  res.json(result)
})

// ── ELO RANKINGS ─────────────────────────────────────────
app.get("/elo/rankings", (req, res) => {
  const limit = parseInt(req.query.limit || "100")
  const teams = [], seen = new Set()
  const addTeam = (name, elo, source) => {
    if (seen.has(name)) return; seen.add(name)
    const prev = prevEloSnap.get(name)
    const change = prev ? elo - prev : 0
    teams.push({ name, elo: Math.round(elo), change: Math.round(change), source })
  }
  for (const [k, v] of clubEloMap) { const n = k.charAt(0).toUpperCase() + k.slice(1); if (v > 1300) addTeam(n, v + (trophyBonus.get(n)||0), "clubelo") }
  for (const [n, v] of Object.entries(ELO_BASE)) addTeam(n, v + (trophyBonus.get(n)||0), "hardcoded")
  for (const [n, d] of teamDB) if (d.elo > 1300) addTeam(n, d.elo + (trophyBonus.get(n)||0), "supabase")
  teams.sort((a, b) => b.elo - a.elo)
  for (const t of teams) prevEloSnap.set(t.name, t.elo)
  res.json(teams.slice(0, limit).map((t, i) => ({ ...t, rank: i + 1 })))
})
app.post('/outcomes/record/team', async (req, res) => {
  const { homeTeam, awayTeam, homeScore, awayScore, homeXg, awayXg, league, isEuropean } = req.body
  if (!homeTeam || !awayTeam) return res.status(400).json({ error: 'Missing teams' })
  await updateTeamWeights(homeTeam, awayTeam, homeScore, awayScore, true, { homeXg, awayXg, league, isEuropean })
  await recordOutcome(`${homeTeam}_${awayTeam}_${Date.now()}`, homeScore > awayScore ? homeTeam : awayScore > homeScore ? awayTeam : 'Draw', homeScore, awayScore)
  res.json({ ok: true, homeWeights: getTeamWeights(homeTeam), awayWeights: getTeamWeights(awayTeam) })
})

app.get('/weights/team/:teamName', (req, res) => {
  res.json(getTeamWeights(req.params.teamName))
})

app.get('/weights/all', (req, res) => {
  const result = {}
  for (const [k, v] of teamWeights) result[k] = v
  res.json({ count: teamWeights.size, teams: result })
})
// ── HEALTH ────────────────────────────────────────────────
app.get("/health", async (req, res) => {
  res.json({
    status: "ok", version: "v14.0",
    github_ai: aiClient ? "✅" : "❌ add GITHUB_TOKEN",
    sportmonks: SM_KEY ? "✅ FULL PAID TIER" : "❌ add SPORTMONKS_API_KEY",
    odds_api: ODDS_KEY ? "✅" : "⚠️ optional",
    news_api: NEWS_KEY ? "✅" : "⚠️ optional",
    supabase: sb ? "✅" : "⚠️ optional",
    clubelo: clubEloMap.size > 0 ? `✅ ${clubEloMap.size} teams` : "⚠️ loading...",
    sports: ["football","basketball (NBA)","american_football (NFL)","tennis","f1","boxing","mma"],
    port: PORT,
  })
})
app.get("/credits/:userId", async (req, res) => {
  if (!sb) return res.json({ plan:'free', credits_total:25, credits_used:0, credits_remaining:25 })
  const { data } = await sb.from('subscriptions')
    .select('plan, credits_total, credits_used, credits_reset_at, referral_code, referral_count')
    .eq('user_id', req.params.userId).single().catch(() => ({ data: null }))
  if (!data) return res.json({ plan:'free', credits_total:25, credits_used:0, credits_remaining:25 })
  const plan = data.plan || 'free'
  const unlimited = plan === 'platinum'
  const remaining = unlimited ? 999999 : Math.max(0, (data.credits_total||25) - (data.credits_used||0))
  res.json({ plan, credits_total: data.credits_total, credits_used: data.credits_used,
    credits_remaining: remaining, unlimited, reset_at: data.credits_reset_at,
    referral_code: data.referral_code, referral_count: data.referral_count })
})
app.get("/debug/sm", async (req, res) => {
  if (!SM_KEY) return res.json({ error: "No SM key" })
  const results = {}
  const today = new Date().toISOString().slice(0, 10)
  const week  = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
  try {
    const r = await http(`${SM_BASE}/fixtures/between/${today}/${week}`, { api_token: SM_KEY, per_page: 3, include: "participants;league" })
    results.fixtures = { count: r.data?.data?.length || 0, sample: r.data?.data?.slice(0,2).map(f => ({ id: f.id, name: f.name, league: f.league?.name })) }
  } catch(e) { results.fixtures_error = `${e.response?.status||e.code} ${e.message?.slice(0,50)}` }
  res.json(results)
})

app.post("/admin/refresh", (req, res) => { cache.clear(); res.json({ ok: true, message: "Cache cleared" }) })

app.get("/config.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript")
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
    // FIND in webhook handler, the checkout.session.completed block:
// REPLACE with:
if (event.type === "checkout.session.completed") {
  const session = event.data.object, meta = session.metadata || {}
  const email = session.customer_email || session.customer_details?.email
  const custId = session.customer, subId = session.subscription
  if (meta.plan && sb) {
    const newPlan = meta.plan
    const newCredits = PLAN_CREDITS[newPlan] || 25
    // Upsert into subscriptions by email
    const { data: existing } = await sb.from('subscriptions')
      .select('id, user_id').eq('email', email).single().catch(() => ({data:null}))
    if (existing) {
      await sb.from('subscriptions').update({
        plan: newPlan, status: 'active',
        stripe_customer_id: custId, stripe_subscription_id: subId,
        credits_total: newCredits, credits_used: 0,
        credits_reset_at: new Date(Date.now() + 30*86400000).toISOString(),
        updated_at: new Date().toISOString()
      }).eq('id', existing.id)
      // Process referral if used
      if (meta.referral_code && meta.referrer_user_id) {
        await fetch(`http://localhost:${PORT}/referral/confirm`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ code: meta.referral_code, referred_user_id: existing.user_id,
            referrer_user_id: meta.referrer_user_id })
        }).catch(() => {})
      }
      console.log(`✅ Plan upgraded: ${email} → ${newPlan}`)
    }
  }
}
    res.json({ received: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── STARTUP ───────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n╔═══════════════════════════════════════════════╗`)
  console.log(`║  ⚡  SLIP IQ  v14.0  ALL SPORTS               ║`)
  console.log(`║  Port ${PORT}  |  AI: ${AI_MODEL.split("/").pop().slice(0,18).padEnd(18)}   ║`)
  console.log(`╚═══════════════════════════════════════════════╝\n`)
  console.log(`GitHub AI:    ${aiClient ? "✅ " + AI_MODEL : "❌ Add GITHUB_TOKEN"}`)
  console.log(`Sportmonks:   ${SM_KEY   ? "✅ FULL PAID TIER" : "❌ Add SPORTMONKS_API_KEY"}`)
  console.log(`Odds API:     ${ODDS_KEY ? "✅" : "⚠️  Optional"}`)
  console.log(`News API:     ${NEWS_KEY ? "✅" : "⚠️  Optional"}`)
  console.log(`Supabase:     ${sb       ? "✅" : "⚠️  Optional"}\n`)
  console.log(`🏅 SPORTS: Football(SM) NBA(BallDontLie) NFL(ESPN) Tennis(TSDB) F1(OpenF1) Boxing(TSDB) MMA(ESPN/TSDB)`)
  console.log(`🎨 PLAYSTYLES: Football(position-based) NBA(PG/SG/SF/PF/C) NFL(QB/RB/WR/TE/DEF) Tennis(10 styles) F1(8 styles) Boxing(8 styles) MMA(8 styles)\n`)
  await loadSupabase().catch(() => {})
  loadClubElo().catch(() => {})
  console.log("🔄 Pre-warming caches...")
  smFixtures(14).then(f => console.log(`✅ SM fixtures: ${f.length} loaded`)).catch(e => console.log("⚠️  SM warm:", e.message))
  // Pre-load sports in background
  setTimeout(() => fetchNBAGames().catch(() => {}), 3000)
  setTimeout(() => fetchNFLGames().catch(() => {}), 5000)
  setTimeout(() => fetchTennisTournaments().catch(() => {}), 7000)
  setTimeout(() => fetchF1NextRace().catch(() => {}), 9000)
  setTimeout(() => { fetchOddsAPI().then(o => console.log(`✅ Odds API: ${Object.keys(o).length} matches`)).catch(() => {}) }, 11000)
  setTimeout(() => smPreMatchNews().catch(() => {}), 13000)
  console.log(`✅ Ready → http://localhost:${PORT}`)
  console.log(`🔬 Debug: GET /debug/sm | GET /health\n`)
  await loadSportWeights().catch(() => {})
  await loadTeamWeights().catch(() => {})

// ELO decay timer — small adjustments every 3 days to reflect current form
setInterval(async () => {
  const now = Date.now()
  if (now - lastWeightUpdate < 3 * 86400000) return
  lastWeightUpdate = now
  // Slight mean reversion on all weights
  for (const [sport, w] of Object.entries(sportWeights)) {
    const keys = Object.keys(w)
    const even = 1 / keys.length
    for (const k of keys) {
      w[k] = w[k] * 0.97 + even * 0.03  // drift toward equal weighting slowly
    }
    await persistWeights(sport, w).catch(() => {})
  }
  console.log('✅ ELO weights recalibrated')
}, 6 * 3600000)  // check every 6 hours
})