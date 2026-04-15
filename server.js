"use strict"
require("dotenv").config()
const express  = require("express")
const cors     = require("cors")
const axios    = require("axios")
const path     = require("path")
const https    = require("https")
const dns      = require("dns")
 
// ── AI LEARNING SYSTEM ─────────────────────────────────────────────────────
const predictionLog    = new Map()
const sportWeights     = {
  football:          { eloWeight: 0.35, formWeight: 0.25, xgWeight: 0.20, homeWeight: 0.12, h2hWeight: 0.08 },
  basketball:        { eloWeight: 0.40, formWeight: 0.20, homeWeight: 0.25, paceWeight: 0.15 },
  american_football: { eloWeight: 0.35, formWeight: 0.20, homeWeight: 0.30, qbWeight: 0.15 },
  tennis:            { eloWeight: 0.45, surfaceWeight: 0.25, formWeight: 0.20, h2hWeight: 0.10 },
  f1:                { driverWeight: 0.55, constructorWeight: 0.30, circuitWeight: 0.15 },
  boxing:            { eloWeight: 0.40, reachWeight: 0.15, recordWeight: 0.25, styleWeight: 0.20 },
  mma:               { eloWeight: 0.38, strikingWeight: 0.22, grapplingWeight: 0.22, reachWeight: 0.10, recordWeight: 0.08 },
}
const weightUpdateLog  = []
let   lastWeightUpdate = 0



const PLAN_PRICES = {
  free: 0, starter: 4.99, basic: 9.99, plus: 19.99,
  pro: 39.99, elite: 79.99, platinum: 149.99
}
 
// ── PER-TEAM ADAPTIVE WEIGHTS ─────────────────────────────────────────────
const teamWeights = new Map()
const DEFAULT_TEAM_WEIGHTS = () => ({
  homeWin:  0.62, awayWin: 0.38,
  homeEuropean: 0.60, awayEuropean: 0.40,
  formFactor: 0.72,
  eloFactor: 0.68,
  xgFactor: 0.55,
  tablePlacement: 0.45,
  oppositionStrength: 0.50,
  pressingIntensity: 0.50,
  setpieceVulnerability: 0.50,
  counterAttackRisk: 0.50,
  injuryImpact: 0.40,
  managerTactical: 0.45,
  // deep Sportmonks factors
  avgPossession: 0.50,
  shotsOnTargetRatio: 0.50,
  cornersWon: 0.50,
  yellowCardRisk: 0.50,
  goalsFromSetPiece: 0.50,
  cleanSheetRate: 0.50,
  goalsConcededLastN: 0.50,
  homeGoalsScoredAvg: 0.00,
  awayGoalsScoredAvg: 0.00,
  homeGoalsConcededAvg: 0.00,
  awayGoalsConcededAvg: 0.00,
  avgRating: 0.00,
  // Descriptor matchups
  vsFinessers: 0.50, vsDirectPlay: 0.50, vsHighPress: 0.50, vsLowBlock: 0.50,
  matchCount: 0, lastUpdated: Date.now()
})
const TEAM_SPECIAL_LABELS = {
  // FINNESSER: Win ugly, outperform xG, clinical despite limited possession/chances
  'Aston Villa':'finnesser','Fulham':'finnesser','Wolverhampton Wanderers':'finnesser',
  'Brighton & Hove Albion':'finnesser','Crystal Palace':'finnesser',
  'Athletic Club':'finnesser','Osasuna':'finnesser','Las Palmas':'finnesser',
  'Atalanta':'finnesser','Udinese':'finnesser','Lens':'finnesser',
  'Brest':'finnesser','Feyenoord':'finnesser',
 
  // HARAMBALL: Park the bus, high fouls, dark arts, ugly wins, physical
  'Atletico Madrid':'haramball','Girona':'haramball','Stoke City':'haramball',
  'Bournemouth':'haramball','Burnley':'haramball','Getafe':'haramball',
  'Cadiz':'haramball','Granada':'haramball','Venezia':'haramball',
  'Bologna':'haramball','Empoli':'haramball',
 
  // BOTTLER: Famously give away leads, inconsistent closers
  'Newcastle United':'bottler','Tottenham Hotspur':'bottler',
  'Everton':'bottler','West Ham United':'bottler',
  'Manchester United':'bottler','Valencia':'bottler',
  'Napoli':'bottler',  // blew 2023 lead
}
 // ── REFEREE BIAS TRACKER ──────────────────────────────────
const refereeDB = new Map() // refereeId → { name, yellowsPerGame, redsPerGame, homeWinRate, penaltiesPerGame, matchCount }

function updateRefereeStats(refId, refName, homeWon, yellows, reds, penalties) {
  if (!refId) return
  const r = refereeDB.get(refId) || { name: refName, homeWins: 0, yellows: 0, reds: 0, penalties: 0, matchCount: 0 }
  r.homeWins += homeWon ? 1 : 0
  r.yellows  += yellows || 0
  r.reds     += reds    || 0
  r.penalties+= penalties || 0
  r.matchCount++
  r.homeWinRate       = parseFloat((r.homeWins / r.matchCount).toFixed(3))
  r.yellowsPerGame    = parseFloat((r.yellows  / r.matchCount).toFixed(2))
  r.redsPerGame       = parseFloat((r.reds     / r.matchCount).toFixed(2))
  r.penaltiesPerGame  = parseFloat((r.penalties/ r.matchCount).toFixed(2))
  refereeDB.set(refId, r)
}

function getRefereeProfile(refId) {
  if (!refId) return null
  const r = refereeDB.get(refId)
  if (!r || r.matchCount < 5) return null
  return {
    ...r,
    isHomeFavoring:  r.homeWinRate > 0.52,
    isCardHappy:     r.yellowsPerGame > 4.5,
    isPenaltyProne:  r.penaltiesPerGame > 0.35,
    biasLabel: r.homeWinRate > 0.55 ? 'STRONG HOME BIAS' : r.homeWinRate < 0.40 ? 'AWAY BIAS' : 'NEUTRAL'
  }
}
function getTeamWeights(teamName) {
  if (!teamWeights.has(teamName)) teamWeights.set(teamName, DEFAULT_TEAM_WEIGHTS())
  return teamWeights.get(teamName)
}

async function updateTeamWeights(homeTeam, awayTeam, homeScore, awayScore, wasHome, matchContext) {
  const lr = 0.015
  for (const [teamName, isHome] of [[homeTeam, true], [awayTeam, false]]) {
    const w = getTeamWeights(teamName)
    const scored   = isHome ? homeScore : awayScore
    const conceded = isHome ? awayScore : homeScore
    const won      = scored > conceded
    const ctx      = matchContext || {}

    if (isHome) {
      w.homeWin = won ? Math.min(0.85, w.homeWin + lr) : Math.max(0.35, w.homeWin - lr)
      w.awayWin = 1 - w.homeWin
    } else {
      w.awayWin = won ? Math.min(0.75, w.awayWin + lr) : Math.max(0.25, w.awayWin - lr)
      w.homeWin = 1 - w.awayWin
    }

    w.formFactor = won ? Math.min(0.90, w.formFactor + lr * 0.5) : Math.max(0.40, w.formFactor - lr * 0.3)

    if (ctx.homeXg && Math.abs(ctx.homeXg - scored) < 0.5) {
      w.xgFactor = Math.min(0.80, w.xgFactor + lr * 0.4)
    } else {
      w.xgFactor = Math.max(0.30, w.xgFactor - lr * 0.2)
    }

    // Update goals stats
    if (isHome) {
      w.homeGoalsScoredAvg   = w.homeGoalsScoredAvg   * 0.9 + scored   * 0.1
      w.homeGoalsConcededAvg = w.homeGoalsConcededAvg * 0.9 + conceded * 0.1
    } else {
      w.awayGoalsScoredAvg   = w.awayGoalsScoredAvg   * 0.9 + scored   * 0.1
      w.awayGoalsConcededAvg = w.awayGoalsConcededAvg * 0.9 + conceded * 0.1
    }

    if (ctx.cleanSheet) w.cleanSheetRate = Math.min(0.90, w.cleanSheetRate + lr)
    else                w.cleanSheetRate = Math.max(0.10, w.cleanSheetRate - lr * 0.5)

    if (ctx.possession)        w.avgPossession       = ctx.possession / 100
    if (ctx.shotsOnTarget)     w.shotsOnTargetRatio  = Math.min(1, ctx.shotsOnTarget / 10)
    if (ctx.corners)           w.cornersWon          = Math.min(1, ctx.corners / 12)
    if (ctx.yellowCards)       w.yellowCardRisk      = Math.min(1, ctx.yellowCards / 5)
    if (ctx.setpieceGoals)     w.goalsFromSetPiece   = Math.min(1, ctx.setpieceGoals / 3)
    if (ctx.avgRating)         w.avgRating           = ctx.avgRating

    w.matchCount++
    w.lastUpdated = Date.now()
    teamWeights.set(teamName, w)
  }

  if (sb) {
    for (const teamName of [homeTeam, awayTeam]) {
      const w = teamWeights.get(teamName)
      sb.from('team_weights').upsert({ team_name: teamName, weights: w, updated_at: new Date().toISOString() }, { onConflict: 'team_name' }).then(()=>{}).catch(()=>{})
    }
  }
}

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

function logPrediction(matchId, sport, homeTeam, awayTeam, predictedWinner, probabilities, factors) {
  predictionLog.set(String(matchId), {
    matchId, sport, homeTeam, awayTeam, predictedWinner,
    probabilities, factors, timestamp: Date.now(), resolved: false
  })
}

async function recordOutcome(matchId, actualWinner, homeScore, awayScore) {
  const pred = predictionLog.get(String(matchId))
  if (!pred || pred.resolved) return
  pred.resolved = true
  pred.actualWinner = actualWinner
  pred.correct = pred.predictedWinner === actualWinner
  const sport = pred.sport || 'football'
  const w = sportWeights[sport]
  if (!w) return
  const lr = 0.02
  if (!pred.correct) {
    const dominant = pred.factors && pred.factors[0] ? pred.factors[0].key : null
    if (dominant && w[dominant] !== undefined) {
      w[dominant] = Math.max(0.05, w[dominant] - lr)
      const others = Object.keys(w).filter(k => k !== dominant)
      const adj = lr / others.length
      for (const k of others) w[k] = Math.min(0.60, w[k] + adj)
    }
  } else {
    const dominant = pred.factors && pred.factors[0] ? pred.factors[0].key : null
    if (dominant && w[dominant] !== undefined) w[dominant] = Math.min(0.60, w[dominant] + lr * 0.5)
  }
  weightUpdateLog.push({ sport, matchId, correct: pred.correct, timestamp: Date.now() })
  if (weightUpdateLog.length % 10 === 0) await persistWeights(sport, w).catch(() => {})
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
    aiClient = new OpenAI({ baseURL: "https://models.github.ai/inference", apiKey: process.env.GITHUB_TOKEN })
    console.log("✅ GitHub AI ready —", process.env.MODEL_NAME || "openai/gpt-4o")
  } else console.log("⚠️  GITHUB_TOKEN missing — AI disabled")
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

// ── COMPRESSION + HELMET ──────────────────────────────────
const compression = require('compression')
const helmet = require('helmet')
app.use(compression())
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }))
app.use(express.static(path.join(__dirname, "public"), { maxAge: '1d', etag: true }))

app.use(cors())
app.use("/webhook/stripe", express.raw({ type: "application/json" }))
app.use(express.json({ limit: "15mb" }))
app.use(express.static(path.join(__dirname, "public")))
app.use(express.static(__dirname, { extensions: ["html"] }))
// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('X-XSS-Protection', '1; mode=block')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  next()
})

// Basic rate limiting for auth-adjacent endpoints
const rateLimitMap = new Map()
function rateLimit(maxPerMin) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || 'unknown'
    const key = `${ip}_${req.path}`
    const now = Date.now()
    const window = rateLimitMap.get(key) || { count: 0, start: now }
    if (now - window.start > 60000) { window.count = 0; window.start = now }
    window.count++
    rateLimitMap.set(key, window)
    if (window.count > maxPerMin) return res.status(429).json({ error: 'Too many requests' })
    next()
  }
}

// Apply rate limits
// Stricter rate limits for auth endpoints — replace existing ones:
app.use('/user/ensure', rateLimit(30));   // 30 per min per IP
app.use('/credits/use', rateLimit(30));
app.use('/analyze',     rateLimit(20));
app.use('/parlay/auto', rateLimit(10));
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

// ── HTTP helpers ─────────────────────────────────────────
async function http(url, params, hdrs, retries) {
  params = params || {}; hdrs = hdrs || {}; retries = retries || 3
  for (let i = 1; i <= retries; i++) {
    try {
      return await axios.get(url, {
        params, timeout: 30000, httpsAgent: smAgent,
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

async function httpExt(url, params, hdrs) {
  return axios.get(url, {
    params: params || {}, timeout: 20000,
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
const managerEloMap = new Map()
 
const MANAGER_DATA = [
  // ── PREMIER LEAGUE ──────────────────────────────────────────────
  { name:'Mikel Arteta',       team:'Arsenal',             elo:1865, formation:'4-3-3',   style:'Gegenpresser',    nationality:'Spain',       league:'Premier League' },
  { name:'Pep Guardiola',      team:'Manchester City',     elo:1980, formation:'4-3-3',   style:'Tiki-Taka',       nationality:'Spain',       league:'Premier League' },
  { name:'Arne Slot',          team:'Liverpool',           elo:1870, formation:'4-3-3',   style:'High Press',      nationality:'Netherlands', league:'Premier League' },
  { name:'Erik ten Hag',       team:'Manchester United',   elo:1755, formation:'4-2-3-1', style:'Pressing',        nationality:'Netherlands', league:'Premier League' },
  { name:'Enzo Maresca',       team:'Chelsea',             elo:1780, formation:'4-2-3-1', style:'Possession',      nationality:'Italy',       league:'Premier League' },
  { name:'Unai Emery',         team:'Aston Villa',         elo:1845, formation:'4-4-2',   style:'Finnesser',       nationality:'Spain',       league:'Premier League' },
  { name:'Thomas Frank',       team:'Brentford',           elo:1790, formation:'3-5-2',   style:'Haramball',       nationality:'Denmark',     league:'Premier League' },
  { name:'Marco Silva',        team:'Fulham',              elo:1780, formation:'4-2-3-1', style:'Possession',      nationality:'Portugal',    league:'Premier League' },
  { name:'Oliver Glasner',     team:'Crystal Palace',      elo:1755, formation:'4-2-3-1', style:'Counter-Attack',  nationality:'Austria',     league:'Premier League' },
  { name:'Eddie Howe',         team:'Newcastle United',    elo:1780, formation:'4-3-3',   style:'Direct Play',     nationality:'England',     league:'Premier League' },
  { name:'Andoni Iraola',      team:'Bournemouth',         elo:1750, formation:'4-4-2',   style:'High Press',      nationality:'Spain',       league:'Premier League' },
  { name:'Nuno Espírito Santo',team:'Nottingham Forest',   elo:1760, formation:'4-4-2',   style:'Low Block',       nationality:'Portugal',    league:'Premier League' },
  // ── LA LIGA ─────────────────────────────────────────────────────
  { name:'Carlo Ancelotti',    team:'Real Madrid',         elo:1960, formation:'4-3-3',   style:'Pragmatist',      nationality:'Italy',       league:'La Liga' },
  { name:'Hansi Flick',        team:'Barcelona',           elo:1870, formation:'4-3-3',   style:'Gegenpresser',    nationality:'Germany',     league:'La Liga' },
  { name:'Diego Simeone',      team:'Atletico Madrid',     elo:1910, formation:'4-4-2',   style:'Haramball',       nationality:'Argentina',   league:'La Liga' },
  { name:'Manuel Pellegrini',  team:'Real Betis',          elo:1760, formation:'4-2-3-1', style:'Possession',      nationality:'Chile',       league:'La Liga' },
  { name:'Imanol Alguacil',    team:'Real Sociedad',       elo:1790, formation:'4-3-3',   style:'Possession',      nationality:'Spain',       league:'La Liga' },
  // ── SERIE A ─────────────────────────────────────────────────────
  { name:'Simone Inzaghi',     team:'Inter Milan',         elo:1880, formation:'3-5-2',   style:'Wing Play',       nationality:'Italy',       league:'Serie A' },
  { name:'Antonio Conte',      team:'Napoli',              elo:1910, formation:'3-5-2',   style:'Pressing',        nationality:'Italy',       league:'Serie A' },
  { name:'Gian Piero Gasperini',team:'Atalanta',           elo:1870, formation:'3-4-1-2', style:'Gegenpresser',    nationality:'Italy',       league:'Serie A' },
  { name:'Paulo Fonseca',      team:'AC Milan',            elo:1760, formation:'4-2-3-1', style:'Direct Play',     nationality:'Portugal',    league:'Serie A' },
  { name:'Claudio Ranieri',    team:'Roma',                elo:1800, formation:'4-4-2',   style:'Pragmatist',      nationality:'Italy',       league:'Serie A' },
  { name:'Thiago Motta',       team:'Juventus',            elo:1780, formation:'4-2-3-1', style:'Possession',      nationality:'Italy',       league:'Serie A' },
  // ── BUNDESLIGA ──────────────────────────────────────────────────
  { name:'Vincent Kompany',    team:'Bayern Munich',       elo:1820, formation:'4-2-3-1', style:'High Press',      nationality:'Belgium',     league:'Bundesliga' },
  { name:'Niko Kovač',         team:'Borussia Dortmund',   elo:1760, formation:'4-2-3-1', style:'Counter-Attack',  nationality:'Croatia',     league:'Bundesliga' },
  { name:'Marco Rose',         team:'RB Leipzig',          elo:1810, formation:'4-3-3',   style:'Gegenpresser',    nationality:'Germany',     league:'Bundesliga' },
  { name:'Xabi Alonso',        team:'Bayer Leverkusen',    elo:1900, formation:'3-4-2-1', style:'Positional Play', nationality:'Spain',       league:'Bundesliga' },
  { name:'Sebastian Hoeneß',   team:'VfB Stuttgart',       elo:1770, formation:'4-2-3-1', style:'Pressing',        nationality:'Germany',     league:'Bundesliga' },
  // ── LIGUE 1 ─────────────────────────────────────────────────────
  { name:'Luis Enrique',       team:'Paris Saint-Germain', elo:1875, formation:'4-3-3',   style:'Pressing',        nationality:'Spain',       league:'Ligue 1' },
  { name:'Roberto De Zerbi',   team:'Marseille',           elo:1840, formation:'4-3-3',   style:'Positional Play', nationality:'Italy',       league:'Ligue 1' },
  { name:'Franck Haise',       team:'Nice',                elo:1760, formation:'4-3-3',   style:'Gegenpresser',    nationality:'France',      league:'Ligue 1' },
  { name:'Paulo Fonseca',      team:'Lyon',                elo:1730, formation:'4-3-3',   style:'Direct Play',     nationality:'Portugal',    league:'Ligue 1' },
  // ── CHAMPIONS LEAGUE REGULARS ────────────────────────────────────
  { name:'Rúben Amorim',       team:'Sporting CP',         elo:1820, formation:'3-4-3',   style:'High Press',      nationality:'Portugal',    league:'Primeira Liga' },
  { name:'Bruno Lage',         team:'Benfica',             elo:1790, formation:'4-4-2',   style:'Pressing',        nationality:'Portugal',    league:'Primeira Liga' },
  { name:'Brian Priske',       team:'Porto',               elo:1760, formation:'4-4-2',   style:'Counter-Attack',  nationality:'Denmark',     league:'Primeira Liga' },
  { name:'Dick Advocaat',      team:'Feyenoord',           elo:1780, formation:'4-3-3',   style:'Direct Play',     nationality:'Netherlands', league:'Eredivisie' },
  { name:'Peter Bosz',         team:'PSV',                 elo:1800, formation:'4-3-3',   style:'Attacking',       nationality:'Netherlands', league:'Eredivisie' },
  // ── INTERNATIONAL ───────────────────────────────────────────────
  { name:'Lionel Scaloni',     team:'Argentina',           elo:1875, formation:'4-3-3',   style:'Pragmatist',      nationality:'Argentina',   league:'International' },
  { name:'Didier Deschamps',   team:'France',              elo:1870, formation:'4-2-3-1', style:'Pragmatist',      nationality:'France',      league:'International' },
  { name:'Luis de la Fuente',  team:'Spain',               elo:1860, formation:'4-3-3',   style:'Possession',      nationality:'Spain',       league:'International' },
  { name:'Julian Nagelsmann',  team:'Germany',             elo:1830, formation:'4-2-3-1', style:'Gegenpresser',    nationality:'Germany',     league:'International' },
  { name:'Roberto Martínez',   team:'Portugal',            elo:1810, formation:'4-3-3',   style:'Attacking',       nationality:'Belgium',     league:'International' },
  { name:'Thomas Tuchel',      team:'England',             elo:1850, formation:'4-2-3-1', style:'Pressing',        nationality:'Germany',     league:'International' },
  // ── LEGENDS / HIGH-PROFILE ───────────────────────────────────────
  { name:'Jose Mourinho',      team:'Fenerbahce',          elo:1930, formation:'4-2-3-1', style:'Park the Bus',    nationality:'Portugal',    league:'Süper Lig' },
  { name:'Zinedine Zidane',    team:'Free Agent',          elo:1910, formation:'4-3-3',   style:'Pragmatist',      nationality:'France',      league:'Free Agent' },
  { name:'Jurgen Klopp',       team:'Retired',             elo:1940, formation:'4-3-3',   style:'Gegenpresser',    nationality:'Germany',     league:'Retired' },
  { name:'Mauricio Pochettino',team:'USMNT',               elo:1840, formation:'4-2-3-1', style:'High Press',      nationality:'Argentina',   league:'International' },
]
 
async function loadManagerElos() {
  // Seed runtime map from MANAGER_DATA
  for (const m of MANAGER_DATA) managerEloMap.set(m.name, { ...m })
  if (!sb) return
  try {
    const { data } = await sb.from('manager_elos').select('*')
    if (data) for (const row of data) {
      const base = managerEloMap.get(row.manager_name) || {}
      managerEloMap.set(row.manager_name, { ...base, elo: row.elo, wins: row.wins, draws: row.draws, losses: row.losses, trophies: row.trophies })
    }
    console.log(`✅ Manager ELOs: ${managerEloMap.size} managers`)
  } catch(e) {}
}
 
async function updateManagerElo(managerName, won, drew, lost, oppManagerElo, dominanceBonus) {
  const mgr = managerEloMap.get(managerName)
  if (!mgr) return
  const K = 24
  const expected = 1 / (1 + Math.pow(10, ((oppManagerElo || 1700) - mgr.elo) / 400))
  const actual   = won ? 1.0 : drew ? 0.5 : 0.0
  const dom      = dominanceBonus || 1.0 // 1 + |xG diff| * 0.2
  const delta    = Math.round(K * dom * (actual - expected))
  mgr.elo = Math.max(1400, Math.min(2200, mgr.elo + delta))
  mgr.wins   = (mgr.wins   || 0) + (won ? 1 : 0)
  mgr.draws  = (mgr.draws  || 0) + (drew ? 1 : 0)
  mgr.losses = (mgr.losses || 0) + (lost ? 1 : 0)
  managerEloMap.set(managerName, mgr)
  if (sb) sb.from('manager_elos').upsert({ manager_name: managerName, team_name: mgr.team, elo: mgr.elo, wins: mgr.wins, draws: mgr.draws, losses: mgr.losses, formation: mgr.formation, style: mgr.style, nationality: mgr.nationality, trophies: mgr.trophies || 0, last_updated: new Date().toISOString() }, { onConflict: 'manager_name' }).then(() => {}).catch(() => {})
}
// ── PERSISTENT PLAYER ELO MAP ─────────────────────────────────────────────
const playerEloMap = new Map() // key: `${name}__${sport}` → elo integer
let playerEloLastSync = 0

async function loadPlayerElos() {
  if (!sb) return
  try {
    const { data } = await sb.from('player_elos').select('*').order('elo', { ascending: false }).limit(10000)
    if (!data) return
    for (const row of data) {
      const k = `${row.player_name}__${row.sport}`
      playerEloMap.set(k, row.elo)
      // Also update playerDB if football
      if (row.sport === 'football' && row.sm_player_id) {
        const dbKey = `${row.player_name}__${row.team_name}`
        const existing = playerDB.get(dbKey)
        if (existing) { existing.elo = row.elo; playerDB.set(dbKey, existing) }
      }
    }
    console.log(`✅ Player ELOs loaded: ${data.length} entries`)
    playerEloLastSync = Date.now()
  } catch(e) { console.log('⚠️  loadPlayerElos:', e.message) }
}

async function savePlayerElo(playerName, teamName, sport, elo, extras) {
  if (!sb) return
  const row = {
    player_name: playerName, team_name: teamName || '', sport,
    elo: Math.round(elo), last_updated: new Date().toISOString(),
    ...extras
  }
  try {
    await sb.from('player_elos').upsert(row, { onConflict: 'player_name,team_name,sport' }).catch(() => {})
  } catch(e) {}
}

// Compute new ELO from a player performance delta
function updatePlayerEloFromPerformance(currentElo, rating, goals, apps, position) {
  if (!apps || apps === 0) return currentElo
  const ratingFactor = rating > 0 ? (parseFloat(rating) - 7.0) * 8 : 0  // 7.0 = league average
  const goalFactor = position && ['ST','LW','RW','CAM'].includes(position) ? (goals / apps) * 15 : (goals / apps) * 8
  const delta = ratingFactor + goalFactor
  const maxChange = 25
  return Math.round(Math.max(1300, Math.min(2200, currentElo + Math.max(-maxChange, Math.min(maxChange, delta)))))
}

// Background job: sync football player ELOs from Sportmonks stats
async function syncFootballPlayerElos() {
  if (!SM_KEY || !sb) return
  console.log('🔄 Syncing football player ELOs from Sportmonks...')
  let synced = 0
  try {
    for (const [teamName, players] of squadDB) {
      for (const p of players) {
        if (!p.sm_player_id || !p.player_name) continue
        const k = `${p.player_name}__football`
        const currentElo = playerEloMap.get(k) || p.elo || 1500
        const newElo = updatePlayerEloFromPerformance(
          currentElo, p.real_rating || 0,
          p.goals_this_season || 0, p.appearances || 0, p.position
        )
        if (Math.abs(newElo - currentElo) >= 1) {
          playerEloMap.set(k, newElo)
          // Update in-memory playerDB
          const dbKey = `${p.player_name}__${teamName}`
          const existing = playerDB.get(dbKey)
          if (existing) { existing.elo = newElo; playerDB.set(dbKey, existing) }
          await savePlayerElo(p.player_name, teamName, 'football', newElo, {
            sm_player_id: p.sm_player_id, position: p.position,
            goals: p.goals_this_season || 0, assists: p.assists_this_season || 0,
            appearances: p.appearances || 0, avg_rating: p.real_rating || null,
          })
          synced++
        }
      }
      await sleep(50)
    }
    console.log(`✅ Player ELO sync done: ${synced} updated`)
  } catch(e) { console.log('⚠️  syncFootballPlayerElos:', e.message) }
}

// Background job: sync NBA player ELOs from BallDontLie
async function syncNBAPlayerElos() {
  if (!sb) return
  try {
    const headers = process.env.BALLDONTLIE_API_KEY ? { Authorization: process.env.BALLDONTLIE_API_KEY } : {}
    const r = await httpExt('https://api.balldontlie.io/v1/season_averages', { season: 2024, per_page: 100 }, headers)
    const players = r.data?.data || []
    for (const p of players) {
      const name = p.player?.first_name + ' ' + p.player?.last_name
      if (!name.trim()) continue
      const k = `${name}__basketball`
      const current = playerEloMap.get(k) || 1700
      // pts + assists * 0.5 + rebounds * 0.3 → performance score
      const perf = (p.pts || 0) + (p.ast || 0) * 0.5 + (p.reb || 0) * 0.3
      const delta = (perf - 18) * 3 // 18 = league avg contribution
      const newElo = Math.round(Math.max(1400, Math.min(2200, current + Math.max(-20, Math.min(20, delta)))))
      playerEloMap.set(k, newElo)
      await savePlayerElo(name, p.player?.team?.full_name || '', 'basketball', newElo, {
        position: p.player?.position || '', appearances: p.games_played || 0,
        goals: Math.round(p.pts || 0), assists: Math.round(p.ast || 0)
      })
    }
    console.log('✅ NBA player ELO sync done')
  } catch(e) { console.log('⚠️  syncNBAPlayerElos:', e.message?.slice(0,60)) }
}
// ── CREDITS ────────────────────────────────────────────────
async function useCredits(userId, action) {
  if (!sb) return { ok: true }
  const cost = ACTION_COSTS[action] || 0
  if (!cost) return { ok: true }
  try {
    const { data: sub } = await sb.from('users')
      .select('plan, credits_total, credits_used, credits_bonus, monthly_credits')
      .eq('id', userId).single()
    if (!sub) return { ok: false, reason: 'not_found' }
    if (sub.plan === 'platinum') return { ok: true, unlimited: true }
    
    const monthly = sub.monthly_credits ?? (PLAN_CREDITS[sub.plan] || 25)
    const newUsed = (sub.credits_used || 0) + cost
    // Recalculate total: monthly - used + bonus
    const newTotal = Math.max(0, monthly - newUsed + (sub.credits_bonus || 0))
    
    await sb.from('users').update({
      credits_used: newUsed,
      credits_total: newTotal,
      updated_at: new Date().toISOString()
    }).eq('id', userId)
    
    return { ok: true, credits_remaining: newTotal }
  } catch(e) { return { ok: false, reason: 'db_error' } }
}
async function checkAccess(userId, action) {
  if (!sb) return { ok: true, plan: 'platinum' }
  try {
    const { data, error } = await sb.from('users')
      .select('plan, plan_status, credits_total, credits_used, credits_bonus, credits_reset_at, monthly_credits')
      .eq('id', userId).single()
    if (error || !data) return { ok: false, reason: 'user_not_found' }
    if (data.plan_status !== 'active') return { ok: false, reason: 'subscription_inactive' }

    const plan = data.plan || 'free'
    const monthlyMax = PLAN_CREDITS[plan] || 25

    // Monthly reset: refresh monthly_credits back to plan max, reset credits_used to 0
    // But KEEP credits_bonus (earned bonus credits persist)
    if (data.credits_reset_at && new Date(data.credits_reset_at) < new Date() && plan !== 'platinum') {
      await sb.from('users').update({
        monthly_credits: monthlyMax,
        credits_used: 0,
        credits_total: monthlyMax + (data.credits_bonus || 0), // recalculate total
        credits_reset_at: new Date(Date.now() + 30*86400000).toISOString(),
        updated_at: new Date().toISOString()
      }).eq('id', userId)
      data.credits_used = 0
      data.monthly_credits = monthlyMax
      data.credits_total = monthlyMax + (data.credits_bonus || 0)
    }

    if (!planCanAccess(plan, action)) {
      return { ok: false, reason: 'plan_locked', user_plan: plan,
        required_plan: FEATURE_MIN_PLAN[action], action }
    }

    const cost = ACTION_COSTS[action] || 0
    // available = monthly_credits - credits_used + bonus_credits
    const monthly = data.monthly_credits ?? monthlyMax
    const available = plan === 'platinum' ? 999999 
      : Math.max(0, monthly - (data.credits_used || 0) + (data.credits_bonus || 0))

    if (plan !== 'platinum' && available < cost) {
      return { ok: false, reason: 'insufficient_credits', credits_available: available, credits_needed: cost }
    }
    return { ok: true, plan, credits_available: available }
  } catch(e) { return { ok: false, reason: 'db_error' } }
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────
function requireAccess(action) {
  return async function(req, res, next) {
    const userId = req.headers['x-user-id'] || req.query.userId || (req.body && req.body.userId)
    if (!userId || !sb) return next()
    const access = await checkAccess(userId, action)
    if (!access.ok) {
      return res.status(402).json({
        ok: false, reason: access.reason, action,
        required_plan: FEATURE_MIN_PLAN[action],
        user_plan: access.user_plan,
        credits_needed: ACTION_COSTS[action],
        credits_available: access.credits_available
      })
    }
    if (access.plan !== 'platinum') {
      await useCredits(userId, action)
    }
    req.userPlan = access.plan
    next()
  }
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
        // Only load players with a real Sportmonks ID — skip old generated rows
        if (!p.sm_player_id) continue
        playerDB.set(`${p.player_name}__${p.team_name}`, p)
        if (!squadDB.has(p.team_name)) squadDB.set(p.team_name, [])
        const sq = squadDB.get(p.team_name)
        if (!sq.find(x => x.player_name === p.player_name)) sq.push(p)
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

// ── PLAYER ELO STARTING VALUES (adaptive system adjusts from here) ─────────
// Order = descending ability. Non-listed players cap at 1989 so these always lead.
const PLAYER_ELO_OVERRIDE = {
  "Harry Kane":2090, "Michael Olise":2082, "Lamine Yamal":2074,
  "Kylian Mbappe":2068, "Kylian Mbappé":2068,
  "Vitinha":2062, "Pedri":2056,
  "Erling Haaland":2050, "Erling Braut Haaland":2050,
  "Declan Rice":2044, "Bruno Fernandes":2038,
  "Gabriel Magalhães":2032, "Gabriel Magalhaes":2032,
  "Nuno Mendes":2026,
  "João Neves":2020, "Joao Neves":2020,
  "Reece James":2014, "Hugo Ekitike":2008,
  "Dominik Szoboszlai":2002, "William Saliba":1996,
  "David Raya":1990, "Gianluigi Donnarumma":1984,
  "Luis Díaz":1978, "Luis Diaz":1978, "Manuel Neuer":1972,
  "Vinicius Junior":1968, "Vinícius Júnior":1968, "Vinicius Jr.":1968,
  "Jude Bellingham":1964, "Florian Wirtz":1960,
  "Bukayo Saka":1956, "Rodri":1952,
  "Martin Ødegaard":1948, "Martin Odegaard":1948,
  "Phil Foden":1944, "Jamal Musiala":1940,
  "Federico Valverde":1936, "Raphinha":1932,
  "Trent Alexander-Arnold":1928, "Mohamed Salah":1924,
  "Son Heung-min":1920, "Leandro Trossard":1916,
  "Kai Havertz":1912, "Gabriel Martinelli":1908,
  "João Cancelo":1904, "Joao Cancelo":1904,
  "Bernardo Silva":1900, "Kevin De Bruyne":1896,
  "Ollie Watkins":1892, "Cole Palmer":1888, "Nico Williams":1884,
  "Antoine Griezmann":1880, "Robert Lewandowski":1876,
  "Álvaro Morata":1872, "Alvaro Morata":1872,
  "Dani Carvajal":1868, "Rúben Dias":1864, "Ruben Dias":1864,
  "Virgil van Dijk":1860, "Alexis Mac Allister":1856,
  "Granit Xhaka":1852, "Joao Felix":1848, "João Félix":1848,
  "Rafael Leão":1844, "Rafael Leao":1844,
  "Xavi Simons":1840, "Warren Zaïre-Emery":1836,
  "Ousmane Dembélé":1832, "Ousmane Dembele":1832,
  "Kang-in Lee":1828, "Fabian Ruiz":1824,
  "Khvicha Kvaratskhelia":1820, "Victor Osimhen":1816,
  "Marcus Thuram":1812, "Nicolo Barella":1808,
  "Hakan Calhanoglu":1804, "Alessandro Bastoni":1800,
}

// Normalise accents for fuzzy matching
function _normAccents(s) {
  return (s||'').toLowerCase()
    .replace(/[àáâãä]/g,'a').replace(/[èéêë]/g,'e')
    .replace(/[ìíîï]/g,'i').replace(/[òóôõö]/g,'o')
    .replace(/[ùúûü]/g,'u').replace(/[ñ]/g,'n')
    .replace(/[ý]/g,'y').replace(/[ç]/g,'c')
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

// ── PLAYER ATTRIBUTES ─────────────────────────────────────
function clamp(v) { return Math.min(99, Math.max(20, v)) }
const POS_ID_MAP = { 24:"GK",25:"CB",26:"CM",27:"ST",28:"LB",29:"RB",30:"CDM",31:"CAM",32:"LW",33:"RW",34:"RM",35:"LM",36:"LWB",37:"RWB" }
function mapPosId(id) { return POS_ID_MAP[id] || "CM" }

// ── PLAYSTYLES ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════
// PATCH 1: PLAYER POSITION OVERRIDES + EXPANDED PLAYSTYLE LIBRARY
// ═══════════════════════════════════════════════════════════════════
// In server.js, REPLACE this block:
//   const FOOTBALL_PLAYSTYLES = { GK: { ... }, CB: { ... }, ... }
// WITH everything below (the new library + override map):
// ═══════════════════════════════════════════════════════════════════

// ── PLAYER POSITION OVERRIDES (force correct positions for top players) ──────
const PLAYER_POSITION_OVERRIDES = {
  // Wingers (NOT strikers)
  "Bukayo Saka":"RW","Mohamed Salah":"RW","Leandro Trossard":"LW",
  "Gabriel Martinelli":"LW","Son Heung-min":"LW","Kylian Mbappe":"LW","Kylian Mbappé":"LW",
  "Vinicius Junior":"LW","Vinícius Júnior":"LW","Vinicius Jr.":"LW",
  "Michael Olise":"RW","Lamine Yamal":"RW","Nico Williams":"LW",
  "Rafael Leão":"LW","Rafael Leao":"LW","Luis Díaz":"LW","Luis Diaz":"LW",
  "Phil Foden":"LW","Ousmane Dembélé":"RW","Ousmane Dembele":"RW",
  "Kang-in Lee":"LW","Khvicha Kvaratskhelia":"LW","Raphinha":"RW",
  "Kingsley Coman":"LW","Leroy Sane":"RW","Serge Gnabry":"RW",
  "Marcus Rashford":"LW","Antony":"RW","Jarrod Bowen":"RW",
  "Harvey Elliott":"RW","Diogo Jota":"LW",
  // Attacking mids
  "Jude Bellingham":"CAM","Jamal Musiala":"CAM","Florian Wirtz":"CAM",
  "Martin Ødegaard":"CAM","Martin Odegaard":"CAM","Cole Palmer":"CAM",
  "Kevin De Bruyne":"CAM","Bernardo Silva":"CM","Vitinha":"CM",
  "Pedri":"CM","Xavi Simons":"CAM","Joao Felix":"CAM","João Félix":"CAM",
  "Warren Zaïre-Emery":"CDM","Fabian Ruiz":"CM","Dominik Szoboszlai":"CM",
  "Alexis Mac Allister":"CM","Granit Xhaka":"CDM","Nicolo Barella":"CM",
  "Hakan Calhanoglu":"CDM","Ilkay Gundogan":"CM","Thiago":"CDM",
  "Bruno Fernandes":"CAM","Kai Havertz":"CAM","Mason Mount":"CAM",
  // Defensive mids
  "Declan Rice":"CDM","Rodri":"CDM","João Neves":"CDM","Joao Neves":"CDM",
  "Aurelien Tchouameni":"CDM","Federico Valverde":"CM","Marcos Llorente":"CM",
  // Centre-backs
  "William Saliba":"CB","Gabriel Magalhães":"CB","Gabriel Magalhaes":"CB",
  "Virgil van Dijk":"CB","Rúben Dias":"CB","Ruben Dias":"CB",
  "Alessandro Bastoni":"CB","Josko Gvardiol":"CB","Kim Min-jae":"CB",
  "Manuel Akanji":"CB","Dayot Upamecano":"CB","Eder Militao":"CB",
  "Antonio Silva":"CB","Gonçalo Inácio":"CB",
  // Fullbacks
  "Trent Alexander-Arnold":"RB","Reece James":"RB","João Cancelo":"RB",
  "Joao Cancelo":"RB","Dani Carvajal":"RB","Nuno Mendes":"LB",
  "Theo Hernandez":"LB","Alphonso Davies":"LB","Ferland Mendy":"LB",
  "Achraf Hakimi":"RB","Kieran Trippier":"RB","Ben White":"RB",
  // Strikers
  "Harry Kane":"ST","Erling Haaland":"ST","Erling Braut Haaland":"ST",
  "Robert Lewandowski":"ST","Victor Osimhen":"ST","Marcus Thuram":"ST",
  "Antoine Griezmann":"ST","Álvaro Morata":"ST","Alvaro Morata":"ST",
  "Hugo Ekitike":"ST","Ollie Watkins":"ST","Darwin Nunez":"ST",
  "Artem Dovbyk":"ST","Ivan Toney":"ST","Jhon Duran":"ST",
  // GKs
  "David Raya":"GK","Gianluigi Donnarumma":"GK","Manuel Neuer":"GK",
  "Alisson Becker":"GK","Thibaut Courtois":"GK","Marc-Andre ter Stegen":"GK",
  "Jordan Pickford":"GK","Nick Pope":"GK","Andre Onana":"GK",
}

// ── EXPANDED FOOTBALL PLAYSTYLE LIBRARY (30+ styles) ─────────────────────────
// Each player can receive up to 3 styles based on position + stats
const FOOTBALL_PLAYSTYLE_LIB = {
  // GOALKEEPERS
  SWEEPER_KEEPER:    { name:'Sweeper Keeper',       pos:['GK'],                     desc:'Commands area, builds from back',          icon:'🧤', statBias:'distribution' },
  SHOT_STOPPER:      { name:'Shot Stopper',          pos:['GK'],                     desc:'Elite reflexes, dominates from the line',  icon:'🛑', statBias:'saves' },
  GK_DISTRIBUTOR:    { name:'Distributor GK',        pos:['GK'],                     desc:'Pinpoint long kicks ignite attacks',        icon:'🎯', statBias:'passing' },
  COMPLETE_KEEPER:   { name:'Complete Keeper',       pos:['GK'],                     desc:'Elite in every aspect of goalkeeping',     icon:'⭐', statBias:'rating' },
  // CENTRE-BACKS
  BALL_PLAYING_CB:   { name:'Ball-Playing CB',       pos:['CB'],                     desc:'Line-breaking passes, steps into midfield',icon:'🎯', statBias:'assists' },
  DESTROYER:         { name:'Destroyer',             pos:['CB','CDM'],               desc:'Ferocious in duels, dominant in the air',  icon:'💥', statBias:'tackles' },
  AERIAL_CB:         { name:'Aerial Threat',       pos:['CB','ST','CM'],                desc:'Dominates set pieces, wins every header',  icon:'👆', statBias:'aerials' },
  LIBERO:            { name:'Libero',                pos:['CB'],                     desc:'Steps out, reads danger, intercepts play', icon:'🧹', statBias:'intercepts' },
  ORGANISER:         { name:'Organiser',             pos:['CB'],                     desc:'Commands the backline, vocal leader',      icon:'📢', statBias:'rating' },
  // FULLBACKS
  ATTACK_FB:         { name:'Attack Fullback',       pos:['LB','RB','LWB','RWB'],    desc:'Overlapping runs, dangerous in final third',icon:'🏃', statBias:'assists' },
  DEFENSIVE_FB:      { name:'Defensive Fullback',    pos:['LB','RB'],                desc:'Disciplined, positionally excellent',      icon:'🔐', statBias:'tackles' },
  INVERTED_FB:       { name:'Inverted Fullback',     pos:['LB','RB'],                desc:'Cuts inside, operates as extra midfielder',icon:'↩️', statBias:'assists' },
  WINGBACK:          { name:'Wingback',              pos:['LWB','RWB','LB','RB'],    desc:'Very advanced, creates wide overloads',    icon:'⚡', statBias:'assists' },
  // DEFENSIVE MID
  PRESS_CONDUCTOR:   { name:'Press Conductor',       pos:['CDM','CM'],               desc:'Sets press triggers, shields backline',    icon:'🔥', statBias:'intercepts' },
  DEFENSIVE_ANCHOR:  { name:'Defensive Anchor',      pos:['CDM'],                    desc:'Sits deep, breaks up play relentlessly',   icon:'⚓', statBias:'tackles' },
  BALL_WINNER:       { name:'Ball Winner',           pos:['CDM','CM'],               desc:'Aggressive duels, wins possession back',   icon:'💪', statBias:'tackles' },
  DEEP_PLAYMAKER:    { name:'Deep Playmaker',        pos:['CDM','CM'],               desc:'Orchestrates tempo from deep positions',   icon:'🎭', statBias:'assists' },
  REGISTA:           { name:'Regista',               pos:['CDM','CM'],               desc:'Progressive passing from deep, vision',    icon:'🔭', statBias:'key_passes' },
  // CENTRAL MID
  BOX_TO_BOX:        { name:'Box-to-Box',            pos:['CM'],                     desc:'Covers ground, contributes in both phases',icon:'⚙️', statBias:'goals' },
  MEZZALA:           { name:'Mezzala',               pos:['CM','LM','RM'],           desc:'Late runs into half-spaces from midfield', icon:'🌀', statBias:'goals' },
  PROGRESSIVE_PASSER:{ name:'Progressive Passer',   pos:['CM','CAM','CDM'],         desc:'Drives ball forward with precision',       icon:'➡️', statBias:'key_passes' },
  TEMPO_SETTER:      { name:'Tempo Setter',          pos:['CM','CDM'],               desc:'Controls rhythm, slows or speeds up play', icon:'🎵', statBias:'rating' },
  // ATTACKING MID
  CLASSIC_10:        { name:'Classic No.10',         pos:['CAM'],                    desc:'Between lines, key creator and playmaker', icon:'🔟', statBias:'assists' },
  SHADOW_STRIKER:    { name:'Shadow Striker',        pos:['CAM'],                    desc:'Ghosts into the box, deadly in pockets',   icon:'👻', statBias:'goals' },
  FALSE_9:           { name:'False 9',               pos:['CAM','ST'],               desc:'Drops deep, creates, pulls defenders out', icon:'🔄', statBias:'assists' },
  HALF_SPACE_INF:    { name:'Half-Space Infiltrator',pos:['CAM','LW','RW'],          desc:'Exploits channels between defence and mid',icon:'🎯', statBias:'goals' },
  // WINGERS
  INVERTED_WINGER:   { name:'Inverted Winger',       pos:['LW','RW','LM','RM'],      desc:'Cuts inside onto stronger foot, shoots',   icon:'↩️', statBias:'goals' },
  TRAD_WINGER:       { name:'Traditional Winger',   pos:['LW','RW','LM','RM'],      desc:'Hugs touchline, delivers dangerous crosses',icon:'↗️', statBias:'assists' },
  DRIBBLER:          { name:'Dribbler',              pos:['LW','RW','CAM','LM','RM'],desc:'Elite 1v1, breaks defensive lines solo',   icon:'⚡', statBias:'dribbles' },
  PRESSING_FWD:      { name:'Pressing Forward',      pos:['LW','RW','ST'],           desc:'Relentless press, disrupts defenders',     icon:'🔥', statBias:'tackles' },
  SPEED_MERCHANT:    { name:'Speed Merchant',        pos:['LW','RW','ST','LM','RM'], desc:'Devastating pace, thrives on through balls',icon:'💨', statBias:'dribbles' },
  // STRIKERS
  COMPLETE_FWD:      { name:'Complete Forward',      pos:['ST'],                     desc:'Scores, assists, holds up — does it all', icon:'⭐', statBias:'goals' },
  POACHER:           { name:'Poacher',               pos:['ST','LW','RW'],           desc:'Pure box presence, instinctive finisher',  icon:'🎯', statBias:'goals' },
  TARGET_STRIKER:    { name:'Target Striker',        pos:['ST'],                     desc:'Holds up play, aerial threat, link play',  icon:'🗼', statBias:'aerials' },
  DEEP_LYING_FWD:    { name:'Deep-Lying Forward',    pos:['ST','CAM'],               desc:'Drops deep, links play, creates chances',  icon:'🔙', statBias:'assists' },
  PRESSING_STRIKER:  { name:'Pressing Striker',      pos:['ST','LW','RW'],           desc:'Hunts ball, creates from relentless press',icon:'🏹', statBias:'tackles' },
}

// ── ASSIGN UP TO 3 PLAYSTYLES PER PLAYER ────────────────────────────────────
function assignPlayerPlaystyles(name, pos, stats) {
  const overridePos = (name && PLAYER_POSITION_OVERRIDES[name]) || pos || 'CM'
  const goals   = (stats && (stats.goals_this_season || stats.goals)) || 0
  const assists = (stats && (stats.assists_this_season || stats.assists)) || 0
  const apps    = (stats && stats.appearances) || 1
  const rating  = parseFloat((stats && stats.real_rating) || 0)
  const elo     = (stats && stats.elo) || 1500
  const gpm = goals / Math.max(1, apps)
  const apm = assists / Math.max(1, apps)

  // Stable seed for deterministic style (same player always same style)
  let seed = 0
  for (let i = 0; i < (name || '').length; i++) seed = (seed * 31 + (name || '').charCodeAt(i)) & 0x7fffffff

  const valid = Object.entries(FOOTBALL_PLAYSTYLE_LIB).filter(([k, v]) => v.pos.includes(overridePos))
  if (!valid.length) return [FOOTBALL_PLAYSTYLE_LIB.BOX_TO_BOX]

  const scored = valid.map(([k, v]) => {
    let sc = (((seed + k.length * 7) % 40) / 100) // 0.0–0.4 seed variance

    if (overridePos === 'GK') {
      if (k === 'SWEEPER_KEEPER') sc += rating > 7.2 ? 0.7 : 0.4
      if (k === 'SHOT_STOPPER')   sc += rating < 7.3 ? 0.5 : 0.2
      if (k === 'GK_DISTRIBUTOR') sc += (seed % 3 === 0) ? 0.5 : 0.1
      if (k === 'COMPLETE_KEEPER')sc += elo > 1800 ? 0.6 : 0.2
    }
    if (['LW','RW','LM','RM'].includes(overridePos)) {
      if (k === 'INVERTED_WINGER') sc += gpm > 0.3 ? 0.8 : 0.5    // goal-scoring winger
      if (k === 'TRAD_WINGER')     sc += apm > 0.25 ? 0.7 : 0.3   // assisting winger
      if (k === 'DRIBBLER')        sc += elo > 1800 ? 0.6 : 0.2
      if (k === 'SPEED_MERCHANT')  sc += (seed % 4 === 0) ? 0.5 : 0.1
      if (k === 'PRESSING_FWD')    sc += (gpm < 0.2 && apps > 10) ? 0.4 : 0.1
      if (k === 'HALF_SPACE_INF')  sc += (gpm > 0.25 && apm > 0.15) ? 0.5 : 0.2
    }
    if (overridePos === 'ST') {
      if (k === 'COMPLETE_FWD')   sc += (gpm > 0.6 && apm > 0.15) ? 0.9 : 0.3
      if (k === 'POACHER')        sc += (gpm > 0.5 && apm < 0.15) ? 0.8 : 0.3
      if (k === 'TARGET_STRIKER') sc += (gpm < 0.4 && apps > 10) ? 0.6 : 0.2
      if (k === 'DEEP_LYING_FWD') sc += apm > 0.3 ? 0.7 : 0.2
      if (k === 'PRESSING_STRIKER')sc += elo < 1700 ? 0.5 : 0.1
    }
    if (['CM','CDM'].includes(overridePos)) {
      if (k === 'BOX_TO_BOX')       sc += rating > 7.0 ? 0.6 : 0.3
      if (k === 'DEEP_PLAYMAKER')   sc += apm > 0.2 ? 0.6 : 0.3
      if (k === 'DEFENSIVE_ANCHOR') sc += (goals < 3 && apps > 10) ? 0.5 : 0.2
      if (k === 'PRESS_CONDUCTOR')  sc += elo > 1750 ? 0.5 : 0.2
      if (k === 'MEZZALA')          sc += (gpm > 0.15 && overridePos === 'CM') ? 0.5 : 0.1
      if (k === 'REGISTA')          sc += (apm > 0.25 && goals < 4) ? 0.5 : 0.1
      if (k === 'PROGRESSIVE_PASSER')sc+= elo > 1800 ? 0.4 : 0.2
    }
    if (overridePos === 'CAM') {
      if (k === 'CLASSIC_10')      sc += (apm > 0.3 && rating > 7) ? 0.8 : 0.3
      if (k === 'SHADOW_STRIKER')  sc += gpm > 0.3 ? 0.7 : 0.3
      if (k === 'FALSE_9')         sc += apm > 0.4 ? 0.5 : 0.1
      if (k === 'HALF_SPACE_INF')  sc += elo > 1800 ? 0.5 : 0.2
    }
    if (overridePos === 'CB') {
      if (k === 'BALL_PLAYING_CB') sc += (apm > 0.07 || elo > 1700) ? 0.7 : 0.3
      if (k === 'DESTROYER')       sc += goals < 2 ? 0.4 : 0.2
      if (k === 'AERIAL_CB')       sc += goals > 3 ? 0.5 : 0.2
      if (k === 'ORGANISER')       sc += elo > 1700 ? 0.5 : 0.2
      if (k === 'LIBERO')          sc += (apm > 0.1 && elo > 1750) ? 0.4 : 0.1
    }
    if (['LB','RB','LWB','RWB'].includes(overridePos)) {
      if (k === 'ATTACK_FB')       sc += (apm > 0.15 || assists > 4) ? 0.8 : 0.4
      if (k === 'DEFENSIVE_FB')    sc += (goals < 1 && assists < 2) ? 0.5 : 0.1
      if (k === 'INVERTED_FB')     sc += elo > 1750 ? 0.5 : 0.2
      if (k === 'WINGBACK')        sc += apm > 0.18 ? 0.6 : 0.3
    }
    seed = (seed * 1664525 + 1013904223) & 0x7fffffff
    return { style: v, score: sc }
  })

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, 3).map(s => s.style).filter(Boolean)
}

// Keep backward compat - single style lookup for older code paths
const FOOTBALL_PLAYSTYLES = {
  GK:  FOOTBALL_PLAYSTYLE_LIB.SWEEPER_KEEPER,
  CB:  FOOTBALL_PLAYSTYLE_LIB.BALL_PLAYING_CB,
  LB:  FOOTBALL_PLAYSTYLE_LIB.ATTACK_FB,
  RB:  FOOTBALL_PLAYSTYLE_LIB.ATTACK_FB,
  CDM: FOOTBALL_PLAYSTYLE_LIB.PRESS_CONDUCTOR,
  CM:  FOOTBALL_PLAYSTYLE_LIB.BOX_TO_BOX,
  CAM: FOOTBALL_PLAYSTYLE_LIB.CLASSIC_10,
  LW:  FOOTBALL_PLAYSTYLE_LIB.INVERTED_WINGER,
  RW:  FOOTBALL_PLAYSTYLE_LIB.INVERTED_WINGER,
  ST:  FOOTBALL_PLAYSTYLE_LIB.COMPLETE_FWD,
  LWB: FOOTBALL_PLAYSTYLE_LIB.WINGBACK,
  RWB: FOOTBALL_PLAYSTYLE_LIB.WINGBACK,
  RM:  FOOTBALL_PLAYSTYLE_LIB.TRAD_WINGER,
  LM:  FOOTBALL_PLAYSTYLE_LIB.TRAD_WINGER,
}

const NBA_PLAYSTYLES = {
  "PG": [{ name:"Floor General",desc:"Elite court vision",icon:"🎯"},{name:"Microwave Scorer",desc:"Instant offense",icon:"🔥"},{name:"Defensive Menace",desc:"Disrupts passing lanes",icon:"🛡"}],
  "SG": [{ name:"Catch & Shoot",desc:"Deadly spot-up shooter",icon:"🎯"},{name:"Shot Creator",desc:"Creates own shot",icon:"⚡"},{name:"Two-Way Guard",desc:"Versatile defender",icon:"⚙️"}],
  "SF": [{ name:"3-and-D",desc:"Corner three specialist",icon:"🔐"},{name:"Slash & Kick",desc:"Attacks closeouts",icon:"💨"},{name:"Versatile Wing",desc:"Multiple positions",icon:"🔄"}],
  "PF": [{ name:"Stretch Four",desc:"Extends floor with shooting",icon:"📐"},{name:"Power Bruiser",desc:"Physical presence",icon:"💪"},{name:"Pick & Pop",desc:"Sets hard screens",icon:"🎯"}],
  "C":  [{ name:"Rim Protector",desc:"Anchors defense",icon:"🏰"},{name:"Modern Center",desc:"Can step out, pass",icon:"✨"},{name:"Lob Threat",desc:"Dominant above the rim",icon:"🚀"}],
}

const NFL_PLAYSTYLES = {
  "QB": [{name:"Pocket Passer",desc:"Elite accuracy",icon:"🎯"},{name:"Dual Threat",desc:"Dangerous with arm and legs",icon:"⚡"},{name:"Gunslinger",desc:"Aggressive deep ball",icon:"🔥"}],
  "RB": [{name:"Every Down Back",desc:"Complete back",icon:"⚙️"},{name:"Scat Back",desc:"Elusive in space",icon:"💨"},{name:"Power Runner",desc:"Runs between tackles",icon:"💪"}],
  "WR": [{name:"Route Runner",desc:"Elite separation",icon:"📐"},{name:"Contested Catch",desc:"Wins jump balls",icon:"🏆"},{name:"Burner",desc:"Deep threat",icon:"🚀"}],
  "TE": [{name:"Move TE",desc:"Mismatch nightmare",icon:"🔄"},{name:"Inline Blocker",desc:"Dominant blocker",icon:"💪"},{name:"Red Zone Target",desc:"Huge target",icon:"🎯"}],
  "DEF":[{name:"Pass Rusher",desc:"Elite edge pressure",icon:"💥"},{name:"Coverage Corner",desc:"Shadows receivers",icon:"🔐"},{name:"Run Stuffer",desc:"Tackles for loss",icon:"🛡"}],
}

const TENNIS_PLAYSTYLES = [
  {name:"Baseline Grinder",desc:"Outlasts from back court",icon:"🔄"},{name:"Aggressive Baseliner",desc:"Heavy groundstrokes",icon:"⚡"},
  {name:"Serve & Volley",desc:"Big serve, rushes net",icon:"🚀"},{name:"All Court Player",desc:"Adapts to any surface",icon:"⚙️"},
  {name:"Counter Puncher",desc:"Turns defence into offence",icon:"🔐"},{name:"Big Server",desc:"Ace machine",icon:"💥"},
  {name:"Clay Specialist",desc:"Heavy topspin game",icon:"🏆"},{name:"Grass Specialist",desc:"Serve and slice",icon:"🌿"},
]

const F1_PLAYSTYLES = [
  {name:"Qualifying Ace",desc:"Fastest one lap",icon:"⚡"},{name:"Race Craftsman",desc:"Tyre management expert",icon:"⚙️"},
  {name:"Overtaker",desc:"Aggressive on the brakes",icon:"💨"},{name:"Wet Weather Master",desc:"Elevated in tricky conditions",icon:"🌧"},
  {name:"Street Circuit King",desc:"Thrives on tight circuits",icon:"🏙"},{name:"Pressure Player",desc:"Delivers in title fights",icon:"🔥"},
  {name:"Young Gun",desc:"Raw speed, developing racecraft",icon:"🚀"},{name:"Veteran",desc:"Calm under pressure",icon:"🧠"},
]

const BOXING_PLAYSTYLES = [
  {name:"Pressure Fighter",desc:"Walks opponents down",icon:"💪"},{name:"Boxer-Puncher",desc:"Technical with power",icon:"🎯"},
  {name:"Out-Boxer",desc:"Jab and footwork",icon:"📐"},{name:"Swarmer",desc:"High-volume puncher",icon:"🔥"},
  {name:"Counter Puncher",desc:"Patient, looks to counter",icon:"🔐"},{name:"Knockout Artist",desc:"One punch power",icon:"💥"},
  {name:"Technical Master",desc:"Elite defensive skills",icon:"🧠"},
]

const MMA_PLAYSTYLES = [
  {name:"Striker",desc:"Stands and trades",icon:"💥"},{name:"Wrestler",desc:"Dominant takedowns",icon:"💪"},
  {name:"BJJ Specialist",desc:"Looks for submissions",icon:"🔐"},{name:"Counter Striker",desc:"Punishes aggression",icon:"🎯"},
  {name:"Clinch Fighter",desc:"Dirty boxing and wrestling",icon:"⚙️"},{name:"Finisher",desc:"Always looking to end it",icon:"🔥"},
  {name:"Complete Fighter",desc:"Elite in all areas",icon:"⭐"},
]

function getPlaystyleForSport(sport, position, name, elo) {
  let seed = 0
  for (let i = 0; i < (name||"").length; i++) seed = seed * 31 + name.charCodeAt(i)
  const pick = arr => arr[Math.abs(seed) % arr.length]
  if (sport === 'football') return FOOTBALL_PLAYSTYLES[position] || FOOTBALL_PLAYSTYLES.CM
  if (sport === 'basketball') { const styles = NBA_PLAYSTYLES[position] || NBA_PLAYSTYLES['SF']; return pick(styles) }
  if (sport === 'american_football') { const styles = NFL_PLAYSTYLES[position] || NFL_PLAYSTYLES['WR']; return pick(styles) }
  if (sport === 'tennis') return pick(TENNIS_PLAYSTYLES)
  if (sport === 'f1') return pick(F1_PLAYSTYLES)
  if (sport === 'boxing') return pick(BOXING_PLAYSTYLES)
  if (sport === 'mma') return pick(MMA_PLAYSTYLES)
  return { name: "Unknown", desc: "Style not identified", icon: "❓" }
}

function buildPlayerElo(name, pos, teamElo, rating, goals, apps) {
  // 1. Exact override match
  if (name && PLAYER_ELO_OVERRIDE[name]) return PLAYER_ELO_OVERRIDE[name]
  // 2. Accent-normalised fuzzy match
  if (name) {
    const nk = _normAccents(name)
    for (const [k, v] of Object.entries(PLAYER_ELO_OVERRIDE)) {
      if (_normAccents(k) === nk) return v
    }
  }
  // 3. Real Sportmonks rating — cap at 1989 so override players always lead
  if (rating && rating > 0) {
    const rf = (parseFloat(rating) - 5) / 5
    return Math.round(Math.max(1300, Math.min(1989, 1200 + rf * 250 + (teamElo - 1500) * 0.4)))
  }
  const goalBonus = apps > 0 ? Math.round((goals / apps) * 30) : 0
  const posBonus = { ST:35, LW:30, RW:30, CAM:25, CM:10, CDM:5, LB:0, RB:0, CB:-5, LWB:5, RWB:5, GK:-10, RM:15, LM:15 }
  let seed = 0
  for (let i = 0; i < (name||'x').length; i++) seed = seed * 31 + (name||'x').charCodeAt(i)
  return Math.round(Math.max(1300, Math.min(1989, teamElo + (posBonus[pos] || 0) + goalBonus + ((Math.abs(seed) % 120) - 60))))
}
function buildPlayerAttrs(name, pos, pElo, tElo, rating) {
  const ef     = (pElo - 1300) / 700
  // Use position override for correct role detection
  const actualPos = (name && PLAYER_POSITION_OVERRIDES[name]) || pos || 'CM'
  const isAtk  = ["ST","LW","RW","CAM"].includes(actualPos)
  const isDef  = ["CB","LB","RB","CDM","GK"].includes(actualPos)
  let seed = 0
  for (let i = 0; i < (name||'').length; i++) seed = seed * 31 + (name||'').charCodeAt(i)
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
 
  // Assign up to 3 playstyles using new system
  const styles   = assignPlayerPlaystyles(name, actualPos, { elo: pElo, real_rating: rating })
  const playstyle = styles[0] || FOOTBALL_PLAYSTYLES[actualPos] || FOOTBALL_PLAYSTYLES.CM
 
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
 
  return { speed: spd, attack: atk, defense: def, bigMatch: bm,
    playstyle, playstyles: styles,
    strengths: strengths.slice(0,3), weaknesses: weaknesses.slice(0,2),
    isKey: pElo > tElo + 55 }
}
 
// ══════════════════════════════════════════════════════════
//  NBA
// ══════════════════════════════════════════════════════════
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
// ── NBA TOP PLAYERS (for ELO rankings tab) ────────────────────────────────
const NBA_TOP_PLAYERS = [
  { name:"Nikola Jokic",       team:"Denver Nuggets",           position:"C",  elo:2080, country:"Serbia" },
  { name:"Shai Gilgeous-Alexander",team:"Oklahoma City Thunder",position:"PG", elo:2072, country:"Canada" },
  { name:"Giannis Antetokounmpo",team:"Milwaukee Bucks",        position:"PF", elo:2064, country:"Greece" },
  { name:"Luka Doncic",        team:"Los Angeles Lakers",        position:"PG", elo:2058, country:"Slovenia" },
  { name:"LeBron James",       team:"Los Angeles Lakers",        position:"SF", elo:2052, country:"USA" },
  { name:"Stephen Curry",      team:"Golden State Warriors",     position:"PG", elo:2046, country:"USA" },
  { name:"Joel Embiid",        team:"Philadelphia 76ers",        position:"C",  elo:2040, country:"France" },
  { name:"Jayson Tatum",       team:"Boston Celtics",            position:"SF", elo:2034, country:"USA" },
  { name:"Kevin Durant",       team:"Phoenix Suns",              position:"PF", elo:2028, country:"USA" },
  { name:"Kawhi Leonard",      team:"LA Clippers",               position:"SF", elo:2022, country:"USA" },
  { name:"Donovan Mitchell",   team:"Cleveland Cavaliers",       position:"SG", elo:2016, country:"USA" },
  { name:"Anthony Edwards",    team:"Minnesota Timberwolves",    position:"SG", elo:2010, country:"USA" },
  { name:"Tyrese Haliburton",  team:"Indiana Pacers",            position:"PG", elo:2004, country:"USA" },
  { name:"Devin Booker",       team:"Phoenix Suns",              position:"SG", elo:1998, country:"USA" },
  { name:"Bam Adebayo",        team:"Miami Heat",                position:"C",  elo:1992, country:"USA" },
  { name:"Damian Lillard",     team:"Milwaukee Bucks",           position:"PG", elo:1986, country:"USA" },
  { name:"Ja Morant",          team:"Memphis Grizzlies",         position:"PG", elo:1980, country:"USA" },
  { name:"Darius Garland",     team:"Cleveland Cavaliers",       position:"PG", elo:1974, country:"USA" },
  { name:"Pascal Siakam",      team:"Indiana Pacers",            position:"PF", elo:1968, country:"Cameroon" },
  { name:"Jimmy Butler",       team:"Miami Heat",                position:"SF", elo:1962, country:"USA" },
  { name:"Jaylen Brown",       team:"Boston Celtics",            position:"SG", elo:1956, country:"USA" },
  { name:"Karl-Anthony Towns", team:"New York Knicks",           position:"C",  elo:1950, country:"USA" },
  { name:"Anthony Davis",      team:"Los Angeles Lakers",        position:"C",  elo:1944, country:"USA" },
  { name:"Jalen Brunson",      team:"New York Knicks",           position:"PG", elo:1938, country:"USA" },
  { name:"Scottie Barnes",     team:"Toronto Raptors",           position:"SF", elo:1932, country:"Canada" },
  { name:"De'Aaron Fox",       team:"Sacramento Kings",          position:"PG", elo:1926, country:"USA" },
  { name:"Zion Williamson",    team:"New Orleans Pelicans",      position:"PF", elo:1920, country:"USA" },
  { name:"Trae Young",         team:"Atlanta Hawks",             position:"PG", elo:1914, country:"USA" },
  { name:"LaMelo Ball",        team:"Charlotte Hornets",         position:"PG", elo:1908, country:"USA" },
  { name:"Cade Cunningham",    team:"Detroit Pistons",           position:"PG", elo:1902, country:"USA" },
]
async function fetchNBAGames() {
  return cached("nba_games", async () => {
    const today = new Date().toISOString().slice(0,10)
    const nextWeek = new Date(Date.now() + 7*86400000).toISOString().slice(0,10)
    if (process.env.SPORTSDATAIO_KEY) {
      try {
        const r = await httpExt(`https://api.sportsdata.io/v3/nba/scores/json/GamesByDate/${today}`,
          {}, { 'Ocp-Apim-Subscription-Key': process.env.SPORTSDATAIO_KEY })
        const games = r.data || []
        if (games.length > 0) {
          let upcoming = []
          try {
            const season = new Date().getFullYear() + (new Date().getMonth() >= 9 ? 1 : 0)
            const r2 = await httpExt(`https://api.sportsdata.io/v3/nba/scores/json/Games/${season}`,
              {}, { 'Ocp-Apim-Subscription-Key': process.env.SPORTSDATAIO_KEY })
            upcoming = (r2.data || []).filter(g => g.Day && g.Day.slice(0,10) > today && g.Day.slice(0,10) <= nextWeek)
          } catch(e2) {}
          return [...games, ...upcoming].map(g => ({
            id: g.GameID, _source: 'sportsdata',
            home_team: { full_name: NBA_TEAM_NAMES[g.HomeTeam]||g.HomeTeam },
            away_team: { full_name: NBA_TEAM_NAMES[g.AwayTeam]||g.AwayTeam },
            visitor_team: { full_name: NBA_TEAM_NAMES[g.AwayTeam]||g.AwayTeam },
            date: g.Day,
            status: g.Status === 'Final' ? 'Final' : g.Status === 'InProgress' ? 'In Progress' : 'scheduled',
            home_team_score: g.HomeTeamScore, visitor_team_score: g.AwayTeamScore,
            period: g.Quarter || 0, season: g.Season,
          }))
        }
      } catch(e) { console.log('⚠️  NBA SportsData.io:', e.message?.slice(0,50)) }
    }
    try {
      const headers = process.env.BALLDONTLIE_API_KEY ? { Authorization: process.env.BALLDONTLIE_API_KEY } : {}
      const r = await httpExt(`https://api.balldontlie.io/v1/games`, { start_date: today, end_date: nextWeek, per_page: 100 }, headers)
      const games = r.data?.data || []
      if (games.length > 0) return games
    } catch(e) {}
    return generateNBASchedule()
  }, TTL.S)
}

function generateNBASchedule() {
  const today = new Date()
  const games = [
    { home:"Boston Celtics",away:"New York Knicks",daysOut:0 },
    { home:"Golden State Warriors",away:"Los Angeles Lakers",daysOut:0 },
    { home:"Oklahoma City Thunder",away:"Denver Nuggets",daysOut:0 },
    { home:"Cleveland Cavaliers",away:"Milwaukee Bucks",daysOut:1 },
    { home:"Minnesota Timberwolves",away:"Phoenix Suns",daysOut:1 },
    { home:"Miami Heat",away:"Philadelphia 76ers",daysOut:2 },
    { home:"Dallas Mavericks",away:"Sacramento Kings",daysOut:2 },
    { home:"Indiana Pacers",away:"Atlanta Hawks",daysOut:3 },
    { home:"Los Angeles Lakers",away:"Golden State Warriors",daysOut:3 },
    { home:"Oklahoma City Thunder",away:"Memphis Grizzlies",daysOut:4 },
    { home:"Boston Celtics",away:"Miami Heat",daysOut:5 },
    { home:"Denver Nuggets",away:"Los Angeles Clippers",daysOut:5 },
  ]
  let id = 900000
  return games.map(g => {
    const d = new Date(today.getTime() + g.daysOut * 86400000)
    return {
      id: id++,
      home_team: { full_name: g.home },
      away_team: { full_name: g.away },
      visitor_team: { full_name: g.away },
      date: d.toISOString().slice(0,10) + 'T19:00:00Z',
      status: 'scheduled', home_team_score: null, visitor_team_score: null,
      period: 0, season: 2025, _source: 'schedule'
    }
  })
}

function buildNBAPrediction(game) {
  if (!game) return null
  try {
    const homeName = game.home_team?.full_name || ''
    const awayName = game.away_team?.full_name || game.visitor_team?.full_name || ''
    if (!homeName || !awayName) return null
    if (game.status === "Final") return null
    const hElo = NBA_ELO_BASE[homeName] || 1700
    const aElo = NBA_ELO_BASE[awayName] || 1700
    const eloDiff = (hElo + 50) - aElo
    const homeProb = Math.max(15, Math.min(85, Math.round(50 + eloDiff / 15)))
    const awayProb = 100 - homeProb
    const homeOdds = parseFloat((100 / Math.max(1, homeProb) * 1.05).toFixed(2))
    const awayOdds = parseFloat((100 / Math.max(1, awayProb) * 1.05).toFixed(2))
    let seed = 0; for (let i = 0; i < homeName.length; i++) seed = seed * 31 + homeName.charCodeAt(i)
    return {
      id: `nba_${game.id || Date.now()}`, sport: 'basketball',
      home: homeName, away: awayName, league: "NBA", flag: "🏀",
      date: game.date,
      isLive: game.status === "In Progress",
      score: game.status === "In Progress" ? `${game.home_team_score||0}-${game.visitor_team_score||0}` : null,
      homeElo: hElo, awayElo: aElo,
      homeProb, drawProb: 0, awayProb,
      homeOdds, drawOdds: null, awayOdds,
      confidence: Math.max(homeProb, awayProb),
      homeLineup: buildNBAPlayerList(homeName, hElo).slice(0, 8),
      awayLineup: buildNBAPlayerList(awayName, aElo).slice(0, 8),
      homeForm: ["W","W","L","W","W"], awayForm: ["L","W","W","L","W"],
      valueBet: Math.abs(eloDiff) > 100, isUpsetWatch: awayProb > 40,
      upsetProb: awayProb, hasRealOdds: false,
      factors: [
        { name:"ELO RATING",homeScore:Math.round(hElo/20),awayScore:Math.round(aElo/20),color:"#00d4ff" },
        { name:"HOME COURT",homeScore:65,awayScore:35,color:"#ff8c42" },
        { name:"RECENT FORM",homeScore:55+Math.abs(seed%20)-10,awayScore:45+Math.abs((seed>>1)%20)-10,color:"#00ff88" },
        { name:"PACE",homeScore:50+Math.abs((seed>>2)%25),awayScore:50-Math.abs((seed>>3)%25),color:"#ffd700" },
      ],
      h2h: [], bttsProb: null, ouProbs: {}, ouOdds: {}, bookmaker: "Model", mismatches: []
    }
  } catch(e) { return null }
}

function buildNBAPlayerList(teamName, teamElo) {
  const positions = ['PG','SG','SF','PF','C','PG','SG','SF','PF','C','PG','SG']
  const names = ['J. Williams','M. Johnson','D. Robinson','K. Davis','A. Thompson','C. Anderson','T. Jackson','R. Wilson','B. Harris','N. Young','S. Collins','P. Brown']
  let seed = 0; for (let i = 0; i < teamName.length; i++) seed = seed * 31 + teamName.charCodeAt(i)
  return positions.map((pos, i) => {
    const nm = names[i % names.length]
    const elo = clamp(teamElo - 100 + (Math.abs(seed + i * 97) % 150))
    return { name: nm, position: pos, elo, isKey: i < 3, playstyle: getPlaystyleForSport('basketball', pos, nm, teamElo),
      points: Math.round(5 + Math.abs((seed+i*13)%15)), assists: Math.round(1+Math.abs((seed+i*7)%6)), rebounds: Math.round(1+Math.abs((seed+i*11)%8)),
      speed: clamp(40+Math.abs((seed+i*17)%35)), attack: clamp(40+Math.abs((seed+i*23)%35)), defense: clamp(35+Math.abs((seed+i*29)%35)), bigMatch: clamp(35+Math.abs((seed+i*31)%35)) }
  })
}

// ══════════════════════════════════════════════════════════
//  NFL
// ══════════════════════════════════════════════════════════
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

async function fetchNFLGames() {
  return cached("nfl_games", async () => {
    if (process.env.SPORTSDATAIO_KEY) {
      try {
        const today = new Date().toISOString().slice(0,10)
        const r = await httpExt(`https://api.sportsdata.io/v3/nfl/scores/json/ScoresByDate/${today}`,
          {}, { 'Ocp-Apim-Subscription-Key': process.env.SPORTSDATAIO_KEY })
        const games = r.data || []
        if (games.length > 0) return games.map(g => ({
          id: String(g.GameKey), _source: 'sportsdata',
          competitions: [{
            competitors: [
              { homeAway:'home', team:{ displayName:NFL_TEAM_NAMES[g.HomeTeam]||g.HomeTeam, abbreviation:g.HomeTeam }, score:g.HomeScore },
              { homeAway:'away', team:{ displayName:NFL_TEAM_NAMES[g.AwayTeam]||g.AwayTeam, abbreviation:g.AwayTeam }, score:g.AwayScore },
            ],
            status: { type:{ name:g.Status==='Final'?'STATUS_FINAL':'STATUS_SCHEDULED', completed:g.Status==='Final' }},
            date: g.Date,
          }],
          date: g.Date,
        }))
      } catch(e) {}
    }
    try {
      const r = await httpExt('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard', { limit: 100 })
      const events = r.data?.events || []
      if (events.length > 0) return events
    } catch(e) {}
    return generateNFLSchedule()
  }, TTL.S)
}

function generateNFLSchedule() {
  const today = new Date()
  const matchups = [
    {home:"Kansas City Chiefs",away:"Philadelphia Eagles",daysOut:7},
    {home:"Baltimore Ravens",away:"Buffalo Bills",daysOut:10},
    {home:"Detroit Lions",away:"San Francisco 49ers",daysOut:14},
    {home:"Dallas Cowboys",away:"New York Giants",daysOut:17},
    {home:"Green Bay Packers",away:"Minnesota Vikings",daysOut:21},
  ]
  let id = 800000
  return matchups.map(m => {
    const d = new Date(today.getTime() + m.daysOut * 86400000)
    return {
      id: String(id++), _source: 'schedule',
      competitions: [{
        competitors: [
          { homeAway:'home', team:{ displayName:m.home } },
          { homeAway:'away', team:{ displayName:m.away } }
        ],
        status: { type:{ name:'STATUS_SCHEDULED', completed:false } },
        date: d.toISOString()
      }],
      date: d.toISOString()
    }
  })
}

function buildNFLPrediction(event) {
  if (!event) return null
  try {
    const comp = event.competitions?.[0] || {}
    const comps = comp.competitors || []
    const homeC = comps.find(c => c.homeAway === 'home') || comps[0]
    const awayC = comps.find(c => c.homeAway === 'away') || comps[1]
    if (!homeC || !awayC) return null
    const homeName = homeC.team?.displayName || "Home"
    const awayName = awayC.team?.displayName || "Away"
    if (comp.status?.type?.completed && event._source !== 'schedule') return null
    const hElo = NFL_ELO_BASE[homeName] || 1750
    const aElo = NFL_ELO_BASE[awayName] || 1750
    const eloDiff = (hElo + 30) - aElo
    const homeProb = Math.max(15, Math.min(85, Math.round(50 + eloDiff / 12)))
    const awayProb = 100 - homeProb
    return {
      id: `nfl_${event.id || Date.now()}`, sport: 'american_football',
      home: homeName, away: awayName, league: "NFL", flag: "🏈",
      date: comp.date || event.date,
      isLive: comp.status?.type?.name === "STATUS_IN_PROGRESS",
      homeElo: hElo, awayElo: aElo,
      homeProb, drawProb: 0, awayProb,
      homeOdds: parseFloat((100/Math.max(1,homeProb)*1.05).toFixed(2)),
      drawOdds: null,
      awayOdds: parseFloat((100/Math.max(1,awayProb)*1.05).toFixed(2)),
      confidence: Math.max(homeProb, awayProb),
      homeLineup: [], awayLineup: [],
      homeForm: ["W","L","W","W","L"], awayForm: ["W","W","L","W","L"],
      valueBet: Math.abs(eloDiff) > 80, isUpsetWatch: awayProb > 38,
      upsetProb: awayProb, hasRealOdds: false,
      factors: [
        { name:"ELO RATING",homeScore:Math.round(hElo/20),awayScore:Math.round(aElo/20),color:"#00d4ff" },
        { name:"HOME FIELD",homeScore:62,awayScore:38,color:"#ff8c42" },
        { name:"QB RATING",homeScore:50+Math.round(eloDiff/20),awayScore:50-Math.round(eloDiff/20),color:"#00ff88" },
      ],
      h2h:[], bttsProb:null, ouProbs:{}, ouOdds:{}, bookmaker:"Model", mismatches:[]
    }
  } catch(e) { return null }
}

// ══════════════════════════════════════════════════════════
//  TENNIS
// ══════════════════════════════════════════════════════════
const TENNIS_PLAYERS = {
  ATP: [
    { name:"Jannik Sinner",rank:1,elo:2050,country:"Italy",surface:["Hard","Clay"] },
    { name:"Carlos Alcaraz",rank:2,elo:2020,country:"Spain",surface:["Clay","Grass","Hard"] },
    { name:"Novak Djokovic",rank:3,elo:2000,country:"Serbia",surface:["Hard","Clay","Grass"] },
    { name:"Alexander Zverev",rank:4,elo:1970,country:"Germany",surface:["Hard","Clay"] },
    { name:"Daniil Medvedev",rank:5,elo:1960,country:"Russia",surface:["Hard"] },
    { name:"Taylor Fritz",rank:6,elo:1930,country:"USA",surface:["Hard"] },
    { name:"Casper Ruud",rank:7,elo:1900,country:"Norway",surface:["Clay"] },
    { name:"Alex de Minaur",rank:8,elo:1890,country:"Australia",surface:["Hard"] },
    { name:"Holger Rune",rank:9,elo:1870,country:"Denmark",surface:["Clay","Hard"] },
    { name:"Andrey Rublev",rank:10,elo:1850,country:"Russia",surface:["Hard","Clay"] },
  ],
  WTA: [
    { name:"Aryna Sabalenka",rank:1,elo:2020,country:"Belarus",surface:["Hard"] },
    { name:"Iga Swiatek",rank:2,elo:2010,country:"Poland",surface:["Clay","Hard"] },
    { name:"Coco Gauff",rank:3,elo:1970,country:"USA",surface:["Hard"] },
    { name:"Elena Rybakina",rank:4,elo:1960,country:"Kazakhstan",surface:["Grass","Hard"] },
    { name:"Qinwen Zheng",rank:5,elo:1930,country:"China",surface:["Hard"] },
    { name:"Jessica Pegula",rank:6,elo:1910,country:"USA",surface:["Hard"] },
    { name:"Madison Keys",rank:7,elo:1890,country:"USA",surface:["Hard"] },
    { name:"Jasmine Paolini",rank:8,elo:1860,country:"Italy",surface:["Clay"] },
  ]
}

const CURRENT_TOURNAMENTS = [
  { name:"Miami Open",surface:"Hard",tour:"ATP",location:"Miami, USA",prize:"$8.9M" },
  { name:"Miami Open",surface:"Hard",tour:"WTA",location:"Miami, USA",prize:"$8.9M" },
  { name:"Monte-Carlo Masters",surface:"Clay",tour:"ATP",location:"Monaco",prize:"$5.4M" },
  { name:"Roland Garros",surface:"Clay",tour:"ATP",location:"Paris, France",prize:"$15.3M" },
  { name:"Wimbledon",surface:"Grass",tour:"ATP",location:"London, UK",prize:"$14.8M" },
]

async function fetchTennisTournaments() {
  return cached("tennis_events", async () => {
    const today = new Date().toISOString().slice(0,10)
    try {
      const r = await httpExt(`https://www.thesportsdb.com/api/v2/json/${process.env.THESPORTSDB_API_KEY||'3'}/eventsday.php`, { d: today, s: 'Tennis' })
      const events = r.data?.events || []
      if (events.length > 0) return events.map(e => ({ ...e, _p1: enrichTennisPlayer(e.strHomeTeam), _p2: enrichTennisPlayer(e.strAwayTeam) }))
    } catch(e) {}
    return generateTennisMatches()
  }, TTL.S)
}

function enrichTennisPlayer(name) {
  if (!name) return null
  const all = [...TENNIS_PLAYERS.ATP, ...TENNIS_PLAYERS.WTA]
  return all.find(p => p.name.toLowerCase() === name.toLowerCase()) || { name, elo: 1700, rank: 100, country: 'Unknown', surface: ['Hard'] }
}

function generateTennisMatches() {
  const matches = []
  for (const tourn of CURRENT_TOURNAMENTS.slice(0,3)) {
    const pool = tourn.tour === 'ATP' ? TENNIS_PLAYERS.ATP : TENNIS_PLAYERS.WTA
    for (let i = 0; i < Math.min(4, pool.length - 1); i += 2) {
      if (i + 1 >= pool.length) break
      const d = new Date(Date.now() + Math.floor(i/2) * 86400000)
      matches.push({
        idEvent: `tennis_${tourn.name.replace(/\s/g,'_')}_${i}`,
        strHomeTeam: pool[i].name, strAwayTeam: pool[i+1].name,
        strStatus: "Not Started", dateEvent: d.toISOString().slice(0,10),
        strTime: `${12+i}:00`, strLeague: `${tourn.tour} ${tourn.name}`,
        _tournament: tourn, _p1: pool[i], _p2: pool[i+1],
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
    if (event.strStatus === "Match Finished") return null
    const p1 = event._p1 || enrichTennisPlayer(p1Name)
    const p2 = event._p2 || enrichTennisPlayer(p2Name)
    const tourn = event._tournament || CURRENT_TOURNAMENTS[0]
    const p1surf = p1.surface?.includes(tourn.surface) ? 50 : 0
    const p2surf = p2.surface?.includes(tourn.surface) ? 50 : 0
    const eloDiff = (p1.elo + p1surf) - (p2.elo + p2surf)
    const homeProb = Math.max(15, Math.min(85, Math.round(50 + eloDiff / 20)))
    const awayProb = 100 - homeProb
    return {
      id: `tennis_${event.idEvent || Date.now()}`, sport: 'tennis',
      home: p1Name, away: p2Name,
      league: event.strLeague || `${tourn.tour} ${tourn.name}`, flag: "🎾",
      tournament: tourn.name, surface: tourn.surface, tour: tourn.tour,
      date: event.dateEvent + "T" + (event.strTime||"12:00") + ":00",
      isLive: false,
      homeElo: p1.elo, awayElo: p2.elo, homeRank: p1.rank, awayRank: p2.rank,
      homeCountry: p1.country, awayCountry: p2.country,
      homeProb, drawProb: 0, awayProb,
      homeOdds: parseFloat((100/Math.max(1,homeProb)*1.05).toFixed(2)),
      drawOdds: null,
      awayOdds: parseFloat((100/Math.max(1,awayProb)*1.05).toFixed(2)),
      confidence: Math.max(homeProb, awayProb),
      homeLineup: [{ name:p1Name, position:"Player", elo:p1.elo, isKey:true, playstyle:getPlaystyleForSport('tennis',null,p1Name,p1.elo), country:p1.country, rank:p1.rank }],
      awayLineup: [{ name:p2Name, position:"Player", elo:p2.elo, isKey:true, playstyle:getPlaystyleForSport('tennis',null,p2Name,p2.elo), country:p2.country, rank:p2.rank }],
      homeForm: ["W","W","L","W","W"], awayForm: ["L","W","W","L","W"],
      valueBet: Math.abs(eloDiff) > 150, isUpsetWatch: awayProb > 35,
      upsetProb: awayProb, hasRealOdds: false,
      factors: [
        { name:"RANKING",homeScore:Math.round(100-p1.rank),awayScore:Math.round(100-p2.rank),color:"#00d4ff" },
        { name:"SURFACE FIT",homeScore:p1surf>0?75:45,awayScore:p2surf>0?75:45,color:"#ffd700" },
        { name:"ELO RATING",homeScore:Math.round(p1.elo/22),awayScore:Math.round(p2.elo/22),color:"#ff8c42" },
      ],
      h2h:[], bttsProb:null, ouProbs:{}, ouOdds:{}, bookmaker:"Model", mismatches:[]
    }
  } catch(e) { return null }
}

// ══════════════════════════════════════════════════════════
//  F1
// ══════════════════════════════════════════════════════════
const F1_DRIVERS_2025 = [
  { name:"Max Verstappen",team:"Red Bull Racing",number:1,country:"Netherlands",championships:4,elo:2100 },
  { name:"Lando Norris",team:"McLaren",number:4,country:"UK",championships:0,elo:2020 },
  { name:"Charles Leclerc",team:"Ferrari",number:16,country:"Monaco",championships:0,elo:1990 },
  { name:"Oscar Piastri",team:"McLaren",number:81,country:"Australia",championships:0,elo:1970 },
  { name:"Carlos Sainz",team:"Williams",number:55,country:"Spain",championships:0,elo:1960 },
  { name:"George Russell",team:"Mercedes",number:63,country:"UK",championships:0,elo:1950 },
  { name:"Lewis Hamilton",team:"Ferrari",number:44,country:"UK",championships:7,elo:1980 },
  { name:"Fernando Alonso",team:"Aston Martin",number:14,country:"Spain",championships:2,elo:1940 },
  { name:"Yuki Tsunoda",team:"Red Bull Racing",number:22,country:"Japan",championships:0,elo:1860 },
  { name:"Pierre Gasly",team:"Alpine",number:10,country:"France",championships:0,elo:1870 },
  { name:"Kimi Antonelli",team:"Mercedes",number:12,country:"Italy",championships:0,elo:1810 },
  { name:"Oliver Bearman",team:"Haas",number:87,country:"UK",championships:0,elo:1780 },
  { name:"Jack Doohan",team:"Alpine",number:7,country:"Australia",championships:0,elo:1770 },
  { name:"Alexander Albon",team:"Williams",number:23,country:"Thailand",championships:0,elo:1850 },
  { name:"Nico Hülkenberg",team:"Sauber",number:27,country:"Germany",championships:0,elo:1840 },
  { name:"Lance Stroll",team:"Aston Martin",number:18,country:"Canada",championships:0,elo:1800 },
  { name:"Esteban Ocon",team:"Haas",number:31,country:"France",championships:0,elo:1840 },
  { name:"Valtteri Bottas",team:"Sauber",number:77,country:"Finland",championships:0,elo:1820 },
  { name:"Isack Hadjar",team:"Racing Bulls",number:6,country:"France",championships:0,elo:1790 },
  { name:"Kevin Magnussen",team:"Haas",number:20,country:"Denmark",championships:0,elo:1800 },
]

const F1_CONSTRUCTOR_ELO = {
  "McLaren":2030,"Red Bull Racing":2020,"Ferrari":2000,"Mercedes":1980,
  "Aston Martin":1860,"Williams":1840,"Racing Bulls":1820,"Alpine":1800,"Haas":1780,"Sauber":1760,
}

const F1_2025_CALENDAR = [
  { circuit_short_name:"Bahrain",country_name:"Bahrain",date_start:"2026-04-13T15:00:00",session_key:"bhr_2026" },
  { circuit_short_name:"Jeddah",country_name:"Saudi Arabia",date_start:"2026-04-20T18:00:00",session_key:"sau_2026" },
  { circuit_short_name:"Miami",country_name:"United States",date_start:"2026-05-04T19:00:00",session_key:"mia_2026" },
  { circuit_short_name:"Imola",country_name:"Italy",date_start:"2026-05-18T13:00:00",session_key:"imo_2026" },
  { circuit_short_name:"Monte Carlo",country_name:"Monaco",date_start:"2026-05-25T13:00:00",session_key:"mon_2026" },
  { circuit_short_name:"Barcelona",country_name:"Spain",date_start:"2026-06-01T13:00:00",session_key:"esp_2026" },
  { circuit_short_name:"Montreal",country_name:"Canada",date_start:"2026-06-15T18:00:00",session_key:"can_2026" },
  { circuit_short_name:"Silverstone",country_name:"United Kingdom",date_start:"2026-07-06T14:00:00",session_key:"gbr_2026" },
  { circuit_short_name:"Spa",country_name:"Belgium",date_start:"2026-07-27T13:00:00",session_key:"bel_2026" },
  { circuit_short_name:"Monza",country_name:"Italy",date_start:"2026-09-07T13:00:00",session_key:"ita_2026" },
]

async function fetchF1NextRace() {
  return cached("f1_data", async () => {
    try {
      const [sessionsR, driversR] = await Promise.all([
        httpExt(`${OPEN_F1_BASE}/sessions?session_type=Race&year=2025`).catch(() => ({ data: [] })),
        httpExt(`${OPEN_F1_BASE}/drivers?session_key=latest`).catch(() => ({ data: [] })),
      ])
      const sessions = sessionsR.data || []
      const now = Date.now()
      const upcoming = sessions.filter(s => new Date(s.date_start).getTime() > now - 86400000)
        .sort((a,b) => new Date(a.date_start) - new Date(b.date_start)).slice(0,5)
      const predictions = buildF1Predictions(upcoming.length > 0 ? upcoming : F1_2025_CALENDAR)
      return { predictions, standings: buildF1Standings() }
    } catch(e) {
      return { predictions: buildF1Predictions(F1_2025_CALENDAR), standings: buildF1Standings() }
    }
  }, TTL.L)
}

function buildF1Predictions(races) {
  const now = Date.now()
  const upcoming = races.filter(r => new Date(r.date_start).getTime() > now - 7*86400000)
    .sort((a,b) => new Date(a.date_start) - new Date(b.date_start)).slice(0,5)
  const driversWithStyle = F1_DRIVERS_2025.map(d => ({
    ...d, playstyle: getPlaystyleForSport('f1',null,d.name,d.elo),
    constructorElo: F1_CONSTRUCTOR_ELO[d.team] || 1800,
    combinedElo: Math.round(d.elo * 0.6 + (F1_CONSTRUCTOR_ELO[d.team] || 1800) * 0.4),
  })).sort((a,b) => b.combinedElo - a.combinedElo)
  return upcoming.map((race, idx) => {
    const circuit = race.circuit_short_name || "Circuit"
    const country = race.country_name || "Unknown"
    const isStreet = ["Monte Carlo","Baku","Singapore","Las Vegas","Jeddah"].includes(circuit)
    return {
      id: `f1_${race.session_key || idx}`, sport: 'f1',
      home: driversWithStyle[0].name, away: driversWithStyle[1].name,
      homeTeam: driversWithStyle[0].team, awayTeam: driversWithStyle[1].team,
      league: "Formula 1 2025", flag: "🏎️",
      raceName: `${country} Grand Prix`, circuit: `${circuit}, ${country}`,
      isStreetCircuit: isStreet, date: race.date_start, isLive: false,
      homeElo: driversWithStyle[0].combinedElo, awayElo: driversWithStyle[1].combinedElo,
      homeProb: 32, drawProb: 0, awayProb: 22,
      homeOdds: 3.1, drawOdds: null, awayOdds: 4.5,
      confidence: 32,
      homeLineup: driversWithStyle.filter((_,i)=>i%2===0).slice(0,5).map(d=>({
        name:d.name, position:"Driver", number:d.number,
        elo:d.combinedElo, isKey:d.elo>1950, playstyle:d.playstyle,
        team:d.team, country:d.country, championships:d.championships,
      })),
      awayLineup: driversWithStyle.filter((_,i)=>i%2===1).slice(0,5).map(d=>({
        name:d.name, position:"Driver", number:d.number,
        elo:d.combinedElo, isKey:d.elo>1950, playstyle:d.playstyle,
        team:d.team, country:d.country, championships:d.championships,
      })),
      allDrivers: driversWithStyle.slice(0,20),
      homeForm:["W","P2","P3","W","P2"], awayForm:["P2","W","P2","P3","P4"],
      valueBet:false, isUpsetWatch:false, upsetProb:15, hasRealOdds:false,
      factors:[
        { name:"DRIVER RATING",homeScore:Math.round(driversWithStyle[0].elo/22),awayScore:Math.round(driversWithStyle[1].elo/22),color:"#00d4ff" },
        { name:"CONSTRUCTOR",homeScore:Math.round(driversWithStyle[0].constructorElo/22),awayScore:Math.round(driversWithStyle[1].constructorElo/22),color:"#ff8c42" },
        { name:"CIRCUIT FIT",homeScore:isStreet?70:55,awayScore:isStreet?60:50,color:"#ffd700" },
      ],
      h2h:[], bttsProb:null, ouProbs:{}, ouOdds:{}, bookmaker:"Model", mismatches:[]
    }
  })
}

function buildF1Standings() {
  let pts = 290
  return F1_DRIVERS_2025.slice(0,20).map((d,i) => {
    const p = pts
    pts = Math.max(0, pts - Math.round(8 + Math.random() * 15))
    return { pos:i+1, driver:d.name, team:d.team, points:p, elo:d.elo }
  })
}

// ══════════════════════════════════════════════════════════
//  BOXING & MMA
// ══════════════════════════════════════════════════════════
const BOXING_FIGHTERS = [
  { name:"Oleksandr Usyk",record:"22-0",rank:1,elo:2050,weightClass:"Heavyweight",country:"Ukraine",titles:["WBA","WBC","IBF","WBO"] },
  { name:"Tyson Fury",record:"34-1-1",rank:2,elo:1960,weightClass:"Heavyweight",country:"UK",titles:[] },
  { name:"Anthony Joshua",record:"26-3",rank:3,elo:1950,weightClass:"Heavyweight",country:"UK",titles:[] },
  { name:"Daniel Dubois",record:"21-1",rank:4,elo:1870,weightClass:"Heavyweight",country:"UK",titles:["IBF"] },
  { name:"Dmitry Bivol",record:"23-0",rank:1,elo:2020,weightClass:"Light Heavyweight",country:"Russia",titles:["WBA"] },
  { name:"Artur Beterbiev",record:"20-0",rank:2,elo:2010,weightClass:"Light Heavyweight",country:"Russia",titles:["WBC","IBF","WBO"] },
  { name:"Saul 'Canelo' Alvarez",record:"60-2-2",rank:1,elo:2060,weightClass:"Super Middleweight",country:"Mexico",titles:["WBA","WBC","IBF","WBO"] },
  { name:"David Benavidez",record:"29-0",rank:2,elo:1990,weightClass:"Super Middleweight",country:"USA",titles:["WBC"] },
  { name:"Naoya Inoue",record:"27-0",rank:1,elo:2040,weightClass:"Super Bantamweight",country:"Japan",titles:["WBA","WBC","IBF","WBO"] },
  { name:"Gervonta Davis",record:"30-0",rank:1,elo:2000,weightClass:"Super Lightweight",country:"USA",titles:["WBA"] },
  { name:"Terence Crawford",record:"40-0",rank:1,elo:2020,weightClass:"Welterweight",country:"USA",titles:["WBO","WBA","WBC","IBF"] },
  { name:"Errol Spence Jr",record:"28-1",rank:2,elo:2010,weightClass:"Welterweight",country:"USA",titles:[] },
]

const MMA_FIGHTERS = [
  { name:"Jon Jones",record:"27-1",rank:1,elo:2100,division:"Heavyweight",country:"USA",titles:["UFC HW Champ"],style:"Complete Fighter" },
  { name:"Tom Aspinall",record:"15-3",rank:2,elo:1970,division:"Heavyweight",country:"UK",titles:["Interim UFC HW Champ"],style:"Striker" },
  { name:"Islam Makhachev",record:"26-1",rank:1,elo:2080,division:"Lightweight",country:"Russia",titles:["UFC LW Champ"],style:"Wrestler" },
  { name:"Dustin Poirier",record:"30-8",rank:2,elo:1940,division:"Lightweight",country:"USA",titles:[],style:"Boxer" },
  { name:"Leon Edwards",record:"22-4",rank:1,elo:2000,division:"Welterweight",country:"UK",titles:["UFC WW Champ"],style:"Complete Fighter" },
  { name:"Alex Pereira",record:"10-2",rank:1,elo:2040,division:"Light Heavyweight",country:"Brazil",titles:["UFC LHW Champ"],style:"Striker" },
  { name:"Dricus du Plessis",record:"22-2",rank:1,elo:2010,division:"Middleweight",country:"South Africa",titles:["UFC MW Champ"],style:"Finisher" },
  { name:"Israel Adesanya",record:"24-3",rank:2,elo:2020,division:"Middleweight",country:"Nigeria",titles:[],style:"Counter Striker" },
  { name:"Ilia Topuria",record:"15-0",rank:1,elo:2010,division:"Featherweight",country:"Georgia",titles:["UFC FW Champ"],style:"Finisher" },
  { name:"Max Holloway",record:"25-7",rank:2,elo:1970,division:"Featherweight",country:"USA",titles:[],style:"Swarmer" },
  { name:"Merab Dvalishvili",record:"17-4",rank:1,elo:2000,division:"Bantamweight",country:"Georgia",titles:["UFC BW Champ"],style:"Wrestler" },
  { name:"Sean O'Malley",record:"18-1",rank:2,elo:1990,division:"Bantamweight",country:"USA",titles:[],style:"Striker" },
  { name:"Alexandre Pantoja",record:"27-5",rank:1,elo:1970,division:"Flyweight",country:"Brazil",titles:["UFC FLW Champ"],style:"BJJ Specialist" },
  { name:"Zhang Weili",record:"24-3",rank:1,elo:2000,division:"Strawweight (W)",country:"China",titles:["UFC SW Champ"],style:"Striker" },
  { name:"Alexa Grasso",record:"16-3-1",rank:1,elo:1970,division:"Flyweight (W)",country:"Mexico",titles:["UFC FLW Champ"],style:"Striker" },
]

async function fetchBoxingEvents() {
  return cached("boxing_events", async () => {
    const today = new Date().toISOString().slice(0,10)
    try {
      for (let d = 0; d <= 14; d++) {
        const dd = new Date(Date.now() + d*86400000).toISOString().slice(0,10)
        const r = await httpExt(`https://www.thesportsdb.com/api/v2/json/${process.env.THESPORTSDB_API_KEY||'3'}/eventsday.php`, { d:dd, s:'Boxing' })
        const events = r.data?.events || []
        if (events.length > 0) return events.map(e => ({ ...e, _f1: enrichBoxingFighter(e.strHomeTeam), _f2: enrichBoxingFighter(e.strAwayTeam) }))
        if (d > 0) await sleep(200)
      }
    } catch(e) {}
    return generateBoxingMatches()
  }, TTL.L)
}

function enrichBoxingFighter(name) {
  if (!name) return null
  return BOXING_FIGHTERS.find(f => f.name.toLowerCase() === (name||'').toLowerCase()) || { name, elo:1700, record:'?', country:'Unknown', weightClass:'Unknown', titles:[] }
}

function generateBoxingMatches() {
  const matches = []
  const wcs = [...new Set(BOXING_FIGHTERS.map(f => f.weightClass))]
  for (const wc of wcs) {
    const fighters = BOXING_FIGHTERS.filter(f => f.weightClass === wc)
    if (fighters.length < 2) continue
    const d = new Date(Date.now() + (1 + Math.floor(Math.random() * 14)) * 86400000)
    matches.push({ idEvent:`boxing_${wc.replace(/\s/g,'_')}_${Date.now()}`,
      strHomeTeam:fighters[0].name, strAwayTeam:fighters[1].name,
      strLeague:`${wc} World Championship`, strStatus:"Not Started",
      dateEvent:d.toISOString().slice(0,10), strTime:"22:00",
      _f1:fighters[0], _f2:fighters[1], _weightClass:wc })
  }
  return matches
}

function buildBoxingPrediction(event) {
  if (!event) return null
  try {
    const f1Name = event.strHomeTeam, f2Name = event.strAwayTeam
    if (!f1Name || !f2Name || event.strStatus === "Match Finished") return null
    const f1 = event._f1 || enrichBoxingFighter(f1Name)
    const f2 = event._f2 || enrichBoxingFighter(f2Name)
    const eloDiff = f1.elo - f2.elo
    const homeProb = Math.max(15, Math.min(85, Math.round(50 + eloDiff / 25)))
    const awayProb = 100 - homeProb
    let seed = 0; for (let i = 0; i < f1Name.length; i++) seed = seed * 31 + f1Name.charCodeAt(i)
    return {
      id: `boxing_${event.idEvent || Date.now()}`, sport:'boxing',
      home:f1Name, away:f2Name,
      league:event.strLeague||`${event._weightClass||'Boxing'} Boxing`, flag:"🥊",
      weightClass:event._weightClass||f1.weightClass,
      date:event.dateEvent+"T"+(event.strTime||"22:00")+":00", isLive:false,
      homeElo:f1.elo, awayElo:f2.elo, homeRecord:f1.record, awayRecord:f2.record,
      homeCountry:f1.country, awayCountry:f2.country, homeTitles:f1.titles, awayTitles:f2.titles,
      homeProb, drawProb:5, awayProb:awayProb-5,
      homeOdds:parseFloat((100/Math.max(1,homeProb)*1.05).toFixed(2)),
      drawOdds:20.0,
      awayOdds:parseFloat((100/Math.max(1,awayProb)*1.05).toFixed(2)),
      confidence:Math.max(homeProb,awayProb),
      homeLineup:[{name:f1Name,position:"Boxer",elo:f1.elo,isKey:true,playstyle:getPlaystyleForSport('boxing',null,f1Name,f1.elo),record:f1.record,country:f1.country,titles:f1.titles}],
      awayLineup:[{name:f2Name,position:"Boxer",elo:f2.elo,isKey:true,playstyle:getPlaystyleForSport('boxing',null,f2Name,f2.elo),record:f2.record,country:f2.country,titles:f2.titles}],
      homeForm:["W","W","W","W","L"], awayForm:["W","L","W","W","W"],
      koProb:Math.round(40+Math.abs(eloDiff)/30+Math.abs(seed%20)),
      valueBet:Math.abs(eloDiff)>100, isUpsetWatch:awayProb>38, upsetProb:awayProb, hasRealOdds:false,
      factors:[
        {name:"ELO RATING",homeScore:Math.round(f1.elo/22),awayScore:Math.round(f2.elo/22),color:"#00d4ff"},
        {name:"RECORD",homeScore:60+Math.abs(seed%20)-10,awayScore:50+Math.abs((seed>>1)%20)-10,color:"#ff8c42"},
        {name:"POWER",homeScore:55+Math.abs((seed>>2)%25),awayScore:45+Math.abs((seed>>3)%25),color:"#ff3b5c"},
        {name:"TITLES",homeScore:Math.min(90,50+(f1.titles?.length||0)*8),awayScore:Math.min(90,50+(f2.titles?.length||0)*8),color:"#ffd700"},
      ],
      h2h:[], bttsProb:null, ouProbs:{}, ouOdds:{}, bookmaker:"Model", mismatches:[]
    }
  } catch(e) { return null }
}

async function fetchMMAEvents() {
  return cached("mma_events", async () => {
    const today = new Date().toISOString().slice(0,10)
    try {
      const r = await httpExt('https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard', { limit:50 })
      const events = r.data?.events || []
      if (events.length > 0) return events.map(e=>({...e,_source:'espn'}))
    } catch(e) {}
    try {
      const r = await httpExt(`https://www.thesportsdb.com/api/v2/json/${process.env.THESPORTSDB_API_KEY||'3'}/eventsday.php`, { d:today, s:'MMA' })
      const events = r.data?.events || []
      if (events.length > 0) return events.map(e=>({...e,_f1:enrichMMAFighter(e.strHomeTeam),_f2:enrichMMAFighter(e.strAwayTeam)}))
    } catch(e) {}
    return generateMMAMatches()
  }, TTL.L)
}

function enrichMMAFighter(name) {
  if (!name) return null
  return MMA_FIGHTERS.find(f => f.name.toLowerCase() === name.toLowerCase()) || { name, elo:1700, record:'?', country:'Unknown', division:'Unknown', titles:[], style:'Striker' }
}

function generateMMAMatches() {
  const divisions = [...new Set(MMA_FIGHTERS.map(f => f.division))]
  return divisions.map(div => {
    const fighters = MMA_FIGHTERS.filter(f => f.division === div)
    if (fighters.length < 2) return null
    const d = new Date(Date.now() + (1+Math.floor(Math.random()*21))*86400000)
    return { idEvent:`mma_${div.replace(/\s\(?\)?/g,'_')}_${Date.now()}`,
      strHomeTeam:fighters[0].name, strAwayTeam:fighters[1].name,
      strLeague:'UFC', strStatus:"Not Started",
      dateEvent:d.toISOString().slice(0,10), strTime:"01:00",
      strVenue:"Las Vegas, NV",
      _f1:fighters[0], _f2:fighters[1], _division:div }
  }).filter(Boolean)
}

function buildMMAPrediction(event) {
  if (!event) return null
  try {
    const f1Name = event.strHomeTeam || event.competitions?.[0]?.competitors?.[0]?.athlete?.displayName
    const f2Name = event.strAwayTeam || event.competitions?.[0]?.competitors?.[1]?.athlete?.displayName
    if (!f1Name || !f2Name || event.strStatus === "Match Finished") return null
    const f1 = event._f1 || enrichMMAFighter(f1Name)
    const f2 = event._f2 || enrichMMAFighter(f2Name)
    const eloDiff = f1.elo - f2.elo
    const homeProb = Math.max(15, Math.min(85, Math.round(50 + eloDiff / 20)))
    const awayProb = 100 - homeProb
    let seed = 0; for (let i = 0; i < f1Name.length; i++) seed = seed * 31 + f1Name.charCodeAt(i)
    return {
      id:`mma_${event.idEvent||Date.now()}`, sport:'mma',
      home:f1Name, away:f2Name,
      league:event.strLeague||"UFC", flag:"🥋",
      division:event._division||f1.division, venue:event.strVenue,
      date:(event.dateEvent||new Date().toISOString().slice(0,10))+"T"+(event.strTime||"01:00")+":00",
      isLive:false,
      homeElo:f1.elo, awayElo:f2.elo, homeRecord:f1.record, awayRecord:f2.record,
      homeCountry:f1.country, awayCountry:f2.country, homeTitles:f1.titles, awayTitles:f2.titles,
      homeStyle:f1.style, awayStyle:f2.style,
      homeProb, drawProb:0, awayProb,
      homeOdds:parseFloat((100/Math.max(1,homeProb)*1.05).toFixed(2)),
      drawOdds:null,
      awayOdds:parseFloat((100/Math.max(1,awayProb)*1.05).toFixed(2)),
      confidence:Math.max(homeProb,awayProb),
      homeLineup:[{name:f1Name,position:"Fighter",elo:f1.elo,isKey:true,playstyle:getPlaystyleForSport('mma',null,f1Name,f1.elo),record:f1.record,country:f1.country,titles:f1.titles,style:f1.style,attack:clamp(50+Math.round(eloDiff/20)+Math.abs(seed%25)),defense:clamp(50+Math.round(eloDiff/25)+Math.abs((seed>>1)%25)),speed:clamp(50+Math.abs((seed>>2)%25)),bigMatch:clamp(50+(f1.titles?.length||0)*5)}],
      awayLineup:[{name:f2Name,position:"Fighter",elo:f2.elo,isKey:true,playstyle:getPlaystyleForSport('mma',null,f2Name,f2.elo),record:f2.record,country:f2.country,titles:f2.titles,style:f2.style,attack:clamp(50-Math.round(eloDiff/20)+Math.abs((seed>>4)%25)),defense:clamp(50-Math.round(eloDiff/25)+Math.abs((seed>>5)%25)),speed:clamp(50+Math.abs((seed>>6)%25)),bigMatch:clamp(50+(f2.titles?.length||0)*5)}],
      homeForm:["W","W","L","W","W"], awayForm:["L","W","W","L","W"],
      finishProb:Math.round(45+Math.abs(eloDiff)/25+Math.abs(seed%20)),
      valueBet:Math.abs(eloDiff)>100, isUpsetWatch:awayProb>38, upsetProb:awayProb, hasRealOdds:false,
      factors:[
        {name:"ELO RATING",homeScore:Math.round(f1.elo/22),awayScore:Math.round(f2.elo/22),color:"#00d4ff"},
        {name:"RECORD",homeScore:55+Math.abs(seed%20)-10,awayScore:50+Math.abs((seed>>1)%20)-10,color:"#ff8c42"},
        {name:"STRIKING",homeScore:50+Math.abs((seed>>2)%25),awayScore:50+Math.abs((seed>>3)%25),color:"#ff3b5c"},
        {name:"GRAPPLING",homeScore:50+Math.round(eloDiff/30),awayScore:50-Math.round(eloDiff/30),color:"#00ff88"},
        {name:"TITLES",homeScore:Math.min(90,50+(f1.titles?.length||0)*10),awayScore:Math.min(90,50+(f2.titles?.length||0)*10),color:"#ffd700"},
      ],
      h2h:[], bttsProb:null, ouProbs:{}, ouOdds:{}, bookmaker:"Model", mismatches:[]
    }
  } catch(e) { return null }
}

// ══════════════════════════════════════════════════════════
//  FOOTBALL — SPORTMONKS
// ══════════════════════════════════════════════════════════
const SM_INCLUDE_TIERS = [
  "participants;league;league.country;scores;state;odds;predictions;statistics",
  "participants;league;league.country;scores;state;odds;predictions",
  "participants;league;league.country;scores;state;odds",
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
      console.log(`  ✅ SM tier-${ti+1}: ${all.length} fixtures`)
      cache.set(cacheKey, { data: all, ts: Date.now() })
      return all
    } catch(e) {
      const status = e.response?.status || e.code || "?"
      if (ti < SM_INCLUDE_TIERS.length - 1) { console.log(`  ⚠️  SM tier-${ti+1} (${status}) → fallback...`); await sleep(500) }
      else { console.log(`  ❌ SM all tiers failed`); if (hit) return hit.data; return [] }
    }
  }
  return []
}

async function smFixtures(days) {
  days = Math.min(days || 14, 14)
  if (!SM_KEY) return []
  const start  = new Date().toISOString().slice(0, 10)
  const endStr = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)
  const url    = `${SM_BASE}/fixtures/between/${start}/${endStr}`
  console.log(`📡 SM fixtures ${start} → ${endStr}`)
  return smFetchWithFallback(url, {}, `sm_fix_${days}`, TTL.S)
}

async function smLive() {
  if (!SM_KEY) return []
  return cached("sm_live", async () => {
    for (const inc of SM_INCLUDE_TIERS) {
      try {
        const r = await http(`${SM_BASE}/livescores`, { api_token: SM_KEY, include: inc })
        const data = r.data?.data || []
        console.log(`✅ SM Live: ${data.length}`); return data
      } catch(e) {
        const status = e.response?.status
        if (status === 403 || status === 401 || status === 422) { await sleep(300); continue }
        return []
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
        const hP = (f.participants || []).find(p => p.meta?.location === "home")
        const aP = (f.participants || []).find(p => p.meta?.location === "away")
        const isHome = hP?.id === teamId
        const cH = (f.scores || []).find(s => s.participant_id === hP?.id && s.description === "CURRENT")
        const cA = (f.scores || []).find(s => s.participant_id === aP?.id && s.description === "CURRENT")
        const hg = cH?.score?.goals || 0, ag = cA?.score?.goals || 0
        const scored = isHome ? hg : ag, conc = isHome ? ag : hg
        return { result: scored > conc ? "W" : scored < conc ? "L" : "D", scored, conceded: conc }
      })
    } catch(e) { return [] }
  }, TTL.M)
}

async function smTeamStatistics(teamId, seasonId) {
  if (!SM_KEY || !teamId) return null
  return cached(`sm_teamstats_${teamId}_${seasonId||'cur'}`, async () => {
    try {
      const endpoints = []
      if (seasonId) endpoints.push(`${SM_BASE}/statistics/seasons/${seasonId}/teams/${teamId}`)
      endpoints.push(`${SM_BASE}/teams/${teamId}`)
      for (const url of endpoints) {
        try {
          const r = await http(url, { api_token: SM_KEY, include: "statistics" })
          const stats = r.data?.data?.statistics || r.data?.data?.stat || null
          if (stats) return stats
        } catch(e2) { continue }
      }
      return null
    } catch(e) { return null }
  }, TTL.L)
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
    } catch(e) { return [] }
  }, TTL.M)
}

async function smSquad(teamId, teamName, seasonId) {
  if (!SM_KEY || !teamId) return []
  const cacheKey = `sm_squad_${teamId}_${seasonId || "cur"}`
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.ts < TTL.L) return hit.data
  try {
    const endpoints = []
    if (seasonId) endpoints.push({ url: `${SM_BASE}/squads/seasons/${seasonId}/teams/${teamId}`, params: { api_token: SM_KEY, include: "player;player.position;player.statistics" } })
    endpoints.push({ url: `${SM_BASE}/squads/teams/${teamId}`, params: { api_token: SM_KEY, include: "player;player.position;player.statistics" } })
    endpoints.push({ url: `${SM_BASE}/squads/teams/${teamId}`, params: { api_token: SM_KEY, include: "player;player.position" } })
    endpoints.push({ url: `${SM_BASE}/teams/${teamId}`, params: { api_token: SM_KEY, include: "players;players.position" } })

    let entries = null
    for (const ep of endpoints) {
      try {
        const r = await http(ep.url, ep.params)
        const raw = r.data?.data
        if (!raw) continue
        if (Array.isArray(raw)) entries = raw
        else if (raw.squad?.data || raw.squad) entries = raw.squad?.data || raw.squad || []
        else if (raw.players?.data || raw.players) entries = raw.players?.data || raw.players || []
        else entries = []
        if (entries.length > 0) break
      } catch(e2) { continue }
    }
    if (!entries?.length) { cache.set(cacheKey, { data: [], ts: Date.now() }); return [] }

    const tElo = getElo(teamName) || 1550
    const built = entries.map(sq => {
      const p = sq.player || (sq.id && sq.name ? sq : null) || sq
      const posId  = p.position_id || sq.position_id
      const pos    = posId ? mapPosId(posId) : "CM"
      const pName  = p.display_name || p.common_name || p.name || "Unknown"
      const stats  = p.statistics?.data?.[0] || p.statistics?.[0] || {}
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
      return { ...row, playstyle: attrs.playstyle, strengths: attrs.strengths, weaknesses: attrs.weaknesses }
    })
    cache.set(cacheKey, { data: built, ts: Date.now() })
    return built
  } catch(e) { return [] }
}

// ── PREDICTION ENGINE ─────────────────────────────────────
// ── WEIGHTED FORM SCORE ───────────────────────────────────
// Exponential decay — recent results count far more
function formScore(f, decayRate) {
  if (!f || !f.length) return 0.5
  decayRate = decayRate || 0.72 // tune: lower = more recency bias
  let score = 0, weightSum = 0
  f.slice(0, 6).forEach((r, i) => {
    const w = Math.pow(decayRate, i)
    const v = r === 'W' ? 1 : r === 'D' ? 0.42 : 0
    score += v * w
    weightSum += w
  })
  return weightSum > 0 ? score / weightSum : 0.5
}

// Form momentum — are they trending up or down?
function formMomentum(f) {
  if (!f || f.length < 3) return 0
  const recent = formScore(f.slice(0, 3))
  const older  = formScore(f.slice(3, 6) || f.slice(0, 3))
  return parseFloat((recent - older).toFixed(3)) // positive = improving
}

function calcXG(tElo, oElo, form, isHome, realXg, teamName) {
  if (realXg && realXg > 0) return realXg
  const w = teamName ? getTeamWeights(teamName) : DEFAULT_TEAM_WEIGHTS()
  const ed = (tElo - oElo) / 400
  const fb = (formScore(form) - 0.5) * 0.1
  const base = isHome ? 1.45 : 1.10
  // Apply per-team learned adjustments
  const homeAwayMult = isHome ? (w.homeGoalsScoredAvg > 0 ? Math.min(1.4, w.homeGoalsScoredAvg / 1.45) : 1.0)
                               : (w.awayGoalsScoredAvg > 0 ? Math.min(1.3, w.awayGoalsScoredAvg / 1.10) : 1.0)
  const xgFactor = w.xgFactor || 0.55
  const possessionBonus = w.avgPossession > 0 ? (w.avgPossession - 0.5) * 0.2 : 0
  const pressBonus = w.pressingIntensity > 0.5 ? (w.pressingIntensity - 0.5) * 0.1 : 0
  const setpieceBonus = w.goalsFromSetPiece > 0.2 ? (w.goalsFromSetPiece - 0.2) * 0.3 : 0
  const homeAdj = isHome ? 0.18 : -0.05
  const xg = Math.max(0.3, (base + ed * 0.9 + fb + homeAdj + possessionBonus + pressBonus + setpieceBonus) * homeAwayMult)
  return parseFloat(xg.toFixed(2))
}

function poisson(lambda) { let L = Math.exp(-lambda), p = 1, k = 0; do { k++; p *= Math.random() } while (p > L); return k - 1 }
// ── DIXON-COLES CORRECTION ────────────────────────────────
// Standard Poisson gets 0-0 and 1-1 wrong. This fixes it.
function dixonColesRho(hxg, axg) { return -0.13 } // fitted constant

function dixonColesCorrection(hg, ag, hxg, axg) {
  const rho = dixonColesRho(hxg, axg)
  if (hg === 0 && ag === 0) return 1 - hxg * axg * rho
  if (hg === 0 && ag === 1) return 1 + hxg * rho
  if (hg === 1 && ag === 0) return 1 + axg * rho
  if (hg === 1 && ag === 1) return 1 - rho
  return 1
}

function pcsdc(hxg, axg, h, a) {
  // Dixon-Coles corrected scoreline probability
  return pcs(hxg, axg, h, a) * dixonColesCorrection(h, a, hxg, axg)
}

// Replace monteCarlo with a DC-aware version
function monteCarlodc(hxg, axg, n) {
  n = n || 8000
  let h = 0, d = 0, a = 0
  for (let i = 0; i < n; i++) {
    const hg = poisson(hxg), ag = poisson(axg)
    // Apply DC correction as acceptance probability
    const correction = dixonColesCorrection(hg, ag, hxg, axg)
    if (Math.random() > correction) continue // reject-resample
    if (hg > ag) h++; else if (hg < ag) a++; else d++
  }
  const total = h + d + a || 1
  return { homeWin: h/total, draw: d/total, awayWin: a/total }
}
function monteCarlo(hxg, axg, n) { n = n || 40000; let h = 0, d = 0, a = 0; for (let i = 0; i < n; i++) { const hg = poisson(hxg), ag = poisson(axg); if (hg > ag) h++; else if (hg < ag) a++; else d++ } return { homeWin: h/n, draw: d/n, awayWin: a/n } }
function fact(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r }
function pcs(hxg, axg, h, a) { return (Math.exp(-hxg) * Math.pow(hxg, h) / fact(h)) * (Math.exp(-axg) * Math.pow(axg, a) / fact(a)) }
function detectValue(prob, odds) { if (!odds || odds < 1.05) return { isValue: false, edge: 0 }; const edge = prob - 100 / odds; return { isValue: edge > 4, edge: parseFloat(edge.toFixed(2)) } }
// ── KELLY CRITERION ───────────────────────────────────────
// Tells you exactly what % of your bankroll to bet
// Full Kelly is aggressive — we use fractional (25%) for safety
function kellyStake(probPct, odds, bankrollFraction) {
  bankrollFraction = bankrollFraction || 0.25 // 25% fractional Kelly
  const p = probPct / 100
  const q = 1 - p
  const b = odds - 1 // net odds
  const kelly = (b * p - q) / b
  if (kelly <= 0) return { kelly: 0, fractional: 0, verdict: 'NO BET' }
  const fractional = kelly * bankrollFraction
  return {
    kelly:      parseFloat((kelly * 100).toFixed(2)),      // full Kelly %
    fractional: parseFloat((fractional * 100).toFixed(2)), // safe Kelly %
    verdict: fractional > 3 ? 'STRONG BET' : fractional > 1.5 ? 'BET' : fractional > 0.5 ? 'SMALL BET' : 'SKIP',
    maxBetPct: parseFloat((fractional * 100).toFixed(1))
  }
}

// Sharp money detector — if our probability differs from implied odds probability by >5%, flag it
function detectSharpValue(ourProbPct, odds, minimumEdge) {
  minimumEdge = minimumEdge || 4
  if (!odds || odds < 1.05) return null
  const impliedProb = (1 / odds) * 100
  const edge = ourProbPct - impliedProb
  if (Math.abs(edge) < minimumEdge) return null
  const kelly = kellyStake(ourProbPct, odds)
  return {
    edge:     parseFloat(edge.toFixed(2)),
    impliedProb: parseFloat(impliedProb.toFixed(1)),
    ourProb:  ourProbPct,
    ...kelly,
    isValue:  edge > minimumEdge,
    isLayValue: edge < -minimumEdge, // worth laying on exchanges
  }
}

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

function extractSMStats(stats) {
  // Parse Sportmonks statistics array into a usable object
  if (!Array.isArray(stats)) return {}
  const out = {}
  for (const s of stats) {
    const type = s.type?.developer_name || s.type_id || s.type
    if (type) out[type] = s.value?.total ?? s.value?.average ?? s.value ?? 0
  }
  return out
}

function applyStatsToTeamWeights(teamName, statsMap) {
  if (!teamName || !statsMap) return
  const w = getTeamWeights(teamName)
  const lr = 0.05 // faster update since stats are ground truth
  if (statsMap['ball-possession'] !== undefined) w.avgPossession = Math.min(1, statsMap['ball-possession'] / 100)
  if (statsMap['shots-on-target'] !== undefined) w.shotsOnTargetRatio = Math.min(1, statsMap['shots-on-target'] / 8)
  if (statsMap['corners'] !== undefined) w.cornersWon = Math.min(1, statsMap['corners'] / 10)
  if (statsMap['yellow-cards'] !== undefined) w.yellowCardRisk = Math.min(1, statsMap['yellow-cards'] / 4)
  if (statsMap['goals-scored'] !== undefined) {
    w.homeGoalsScoredAvg = w.homeGoalsScoredAvg * 0.7 + (statsMap['goals-scored'] || 0) * 0.3
  }
  if (statsMap['goals-conceded'] !== undefined) {
    w.homeGoalsConcededAvg = w.homeGoalsConcededAvg * 0.7 + (statsMap['goals-conceded'] || 0) * 0.3
  }
  if (statsMap['clean-sheets'] !== undefined) w.cleanSheetRate = Math.min(0.9, statsMap['clean-sheets'] / 20)
  if (statsMap['attacking-set-plays-goals'] !== undefined) w.goalsFromSetPiece = Math.min(1, statsMap['attacking-set-plays-goals'] / 5)
  w.lastUpdated = Date.now()
  teamWeights.set(teamName, w)
}

function buildGameApproach(hElo, aElo, hForm, aForm, hxg, axg, league, hW, aW) {
  const hStyle = hElo > 1850 && formScore(hForm) > 0.65 ? "High Press" : hxg > 1.5 ? "Attack-minded" : hxg < 1.0 ? "Defensive" : "Balanced"
  const aStyle = aElo > 1850 && formScore(aForm) > 0.65 ? "High Press" : axg > 1.5 ? "Attack-minded" : axg < 1.0 ? "Defensive" : "Balanced"
  return {
    home: { style: hStyle, formScore: Math.round(formScore(hForm) * 100), xgFor: hxg, cleanSheetRate: Math.round((hW?.cleanSheetRate||0.3)*100), avgPossession: Math.round((hW?.avgPossession||0.5)*100) },
    away: { style: aStyle, formScore: Math.round(formScore(aForm) * 100), xgFor: axg, cleanSheetRate: Math.round((aW?.cleanSheetRate||0.3)*100), avgPossession: Math.round((aW?.avgPossession||0.5)*100) },
  }
}

function buildAllMarkets(hxg, axg, smOdds, smPred, realOdds) {
  const probs = monteCarlodc(hxg, axg, 8000)
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

function buildFactors(hElo, aElo, hForm, aForm, hxg, axg, smPred, hW, aW) {
  const hfs = formScore(hForm) * 100, afs = formScore(aForm) * 100, ed = hElo - aElo
  const smH = smPred?.FULLTIME_RESULT_PROBABILITY?.home, smA = smPred?.FULLTIME_RESULT_PROBABILITY?.away
  const n   = v => Math.min(99, Math.max(1, Math.round(v)))
  // Per-team deep factors from Sportmonks stats
  const hPoss = Math.round((hW?.avgPossession||0.5)*100), aPoss = Math.round((aW?.avgPossession||0.5)*100)
  const hCS   = Math.round((hW?.cleanSheetRate||0.3)*100), aCS = Math.round((aW?.cleanSheetRate||0.3)*100)
  const hSoT  = Math.round((hW?.shotsOnTargetRatio||0.5)*100), aSoT = Math.round((aW?.shotsOnTargetRatio||0.5)*100)
  const hSP   = Math.round((hW?.goalsFromSetPiece||0.3)*100), aSP = Math.round((aW?.goalsFromSetPiece||0.3)*100)
  const hYC   = Math.round((1-(hW?.yellowCardRisk||0.5))*100), aYC = Math.round((1-(aW?.yellowCardRisk||0.5))*100)
  return [
    { name:"ELO RATING",       homeScore:n(hElo/20),    awayScore:n(aElo/20),              color:"#00d4ff" },
    { name:"RECENT FORM",      homeScore:n(hfs),        awayScore:n(afs),                  color:"#00ff88" },
    { name:"xG ATTACK",        homeScore:n(hxg*35),     awayScore:n(axg*35),               color:"#ff3b5c" },
    { name:"DEFENSIVE SHAPE",  homeScore:n(50+ed/40),   awayScore:n(50-ed/40),             color:"#ffd700" },
    { name:"HOME ADVANTAGE",   homeScore:65,            awayScore:35,                       color:"#ff8c42" },
    { name:"SM AI PREDICTION", homeScore:smH?n(parseFloat(smH)):n(50+ed/30), awayScore:smA?n(parseFloat(smA)):n(50-ed/30), color:"#cc88ff" },
    { name:"POSSESSION",       homeScore:n(hPoss),      awayScore:n(aPoss),                color:"#44ddaa" },
    { name:"SHOTS ON TARGET",  homeScore:n(hSoT),       awayScore:n(aSoT),                 color:"#ffaa44" },
    { name:"CLEAN SHEET RATE", homeScore:n(hCS),        awayScore:n(aCS),                  color:"#4488ff" },
    { name:"SET PIECES",       homeScore:n(hSP),        awayScore:n(aSP),                  color:"#ff6688" },
    { name:"DISCIPLINE",       homeScore:n(hYC),        awayScore:n(aYC),                  color:"#88ff88" },
    { name:"MOMENTUM",         homeScore:n(hfs*1.1),    awayScore:n(afs*1.1),              color:"#a855f7" },
  ]
}

function detectMismatches(homeLineup, awayLineup, homeName, awayName) {
  const mismatches = []
  if (!homeLineup?.length || !awayLineup?.length) return mismatches
  const checkMismatch = (atk, def, atkTeam) => {
    const isPositional = (atk.position==="LW"&&def.position==="RB")||(atk.position==="RW"&&def.position==="LB")||(atk.position==="ST"&&def.position==="CB")||(atk.position==="CAM"&&def.position==="CDM")
    if (!isPositional) return
    const atkAdv = (atk.attack||60) - (def.defense||50)
    const spdAdv = (atk.speed||60)  - (def.speed||50)
    if (atkAdv > 20 || spdAdv > 25) {
      const weight = Math.min(0.95, 0.5 + (atkAdv + spdAdv) / 200)
      mismatches.push({ attacker:{name:atk.name,pos:atk.position,elo:atk.elo,attack:atk.attack,speed:atk.speed}, defender:{name:def.name,pos:def.position,elo:def.elo,defense:def.defense,speed:def.speed}, atkAdvantage:Math.round(atkAdv), speedAdvantage:Math.round(spdAdv), favor:atkTeam, weight:parseFloat(weight.toFixed(2)) })
    }
  }
  const homeAtk = homeLineup.filter(p => ["ST","LW","RW","CAM"].includes(p.position))
  const awayAtk = awayLineup.filter(p => ["ST","LW","RW","CAM"].includes(p.position))
  const homeDef = homeLineup.filter(p => ["CB","LB","RB","CDM"].includes(p.position))
  const awayDef = awayLineup.filter(p => ["CB","LB","RB","CDM"].includes(p.position))
  for (const atk of homeAtk) for (const def of awayDef) checkMismatch(atk, def, homeName)
  for (const atk of awayAtk) for (const def of homeDef) checkMismatch(atk, def, awayName)
  return mismatches.sort((a, b) => b.atkAdvantage - a.atkAdvantage).slice(0, 6)
}

// ── LEAGUE NORMALISATION ──────────────────────────────────
function normLeague(raw) {
  if (!raw) return null
  const clean = raw.replace(/\s*\d{4}[/-]\d{2,4}$/,"").replace(/\s*\d{4}$/,"").trim()
  const map = {
    "Premier League":"Premier League","English Premier League":"Premier League","EPL":"Premier League",
    "La Liga":"La Liga","LaLiga":"La Liga","Primera Division":"La Liga","La Liga EA Sports":"La Liga",
    "Serie A":"Serie A","Italian Serie A":"Serie A",
    "Bundesliga":"Bundesliga","German Bundesliga":"Bundesliga","1. Bundesliga":"Bundesliga",
    "Ligue 1":"Ligue 1","French Ligue 1":"Ligue 1",
    "UEFA Champions League":"Champions League","Champions League":"Champions League","UCL":"Champions League",
    "UEFA Europa League":"Europa League","Europa League":"Europa League",
    "UEFA Conference League":"Conference League","UEFA Europa Conference League":"Conference League",
    "EFL Championship":"Championship","Championship":"Championship",
    "Scottish Premiership":"Scottish Premiership","Scottish Premier League":"Scottish Premiership",
    "Primeira Liga":"Primeira Liga","Liga Portugal":"Primeira Liga","Liga Portugal Betclic":"Primeira Liga",
    "Eredivisie":"Eredivisie","Dutch Eredivisie":"Eredivisie",
    "Süper Lig":"Süper Lig","Super Lig":"Süper Lig","Trendyol Süper Lig":"Süper Lig",
    "Belgian First Division A":"Belgian Pro League","Jupiler Pro League":"Belgian Pro League","Belgian Pro League":"Belgian Pro League",
    "Argentine Primera División":"Argentine Primera","Liga Profesional Argentina":"Argentine Primera",
    "Brasileirao Serie A":"Brasileirão","Brasileirão":"Brasileirão",
    "Major League Soccer":"MLS","MLS":"MLS",
    "Saudi Professional League":"Saudi Pro League","Roshn Saudi League":"Saudi Pro League","Saudi Pro League":"Saudi Pro League",
    "FA Cup":"FA Cup","English FA Cup":"FA Cup",
    "EFL Cup":"Carabao Cup","Carabao Cup":"Carabao Cup","League Cup":"Carabao Cup",
    "2. Bundesliga":"Bundesliga 2",
    "Danish Superliga":"Danish Superliga",
    "Greek Super League":"Greek Super League","Super League Greece":"Greek Super League",
    "Czech First League":"Czech Liga","Fortuna Liga":"Czech Liga",
    "Zambia Super League":"Zambian Super League","FAZ Super League":"Zambian Super League",
    "Premier Soccer League":"South African PSL","DStv Premiership":"South African PSL",
    "Meistriliiga":"Estonian Meistriliiga",
    "Copa del Rey":"Copa del Rey","Coppa Italia":"Coppa Italia","DFB Pokal":"DFB Pokal",
  }
  if (map[clean]) return map[clean]
  if (map[raw]) return map[raw]
  const cleanLo = clean.toLowerCase()
  for (const [k, v] of Object.entries(map)) {
    if (k.toLowerCase() === cleanLo) return v
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
  { key:"soccer_epl",name:"Premier League" },
  { key:"soccer_spain_la_liga",name:"La Liga" },
  { key:"soccer_italy_serie_a",name:"Serie A" },
  { key:"soccer_germany_bundesliga",name:"Bundesliga" },
  { key:"soccer_france_ligue_one",name:"Ligue 1" },
  { key:"soccer_uefa_champs_league",name:"Champions League" },
  { key:"soccer_uefa_europa_league",name:"Europa League" },
  { key:"basketball_nba",name:"NBA" },
  { key:"americanfootball_nfl",name:"NFL" },
]

async function fetchOddsAPI() {
  if (!ODDS_KEY) return {}
  return cached("odds_api", async () => {
    const map = {}
    for (const sport of ODDS_SPORTS) {
      try {
        const r = await axios.get(`https://api.the-odds-api.com/v4/sports/${sport.key}/odds`, {
          params: { apiKey: ODDS_KEY, regions: "eu", markets: "h2h", oddsFormat: "decimal" },
          timeout: 20000, headers: { "Accept": "application/json", "User-Agent": "SlipIQ/1.0" }
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
                entry.home = out[g.home_team]; entry.draw = out["Draw"]; entry.away = out[g.away_team]
              }
            }
            if (entry.home) break
          }
          if (entry.home || entry.away) map[key] = entry
        }
        await sleep(300)
      } catch(e) { console.log(`  ⚠️  Odds ${sport.name}: ${e.code||e.response?.status||'err'}`) }
    }
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
async function smTeamFatigue(teamId, matchDate) {
  if (!SM_KEY || !teamId || !matchDate) return { fatigueFactor: 1.0 }
  return cached('fatigue_' + teamId, async () => {
    try {
      const matchMs = new Date(matchDate).getTime()
      const since   = new Date(matchMs - 7 * 86400000).toISOString().slice(0, 10)
      const until   = new Date(matchDate).toISOString().slice(0, 10)
      const r = await http(`${SM_BASE}/fixtures/between/${since}/${until}`, {
        api_token: SM_KEY, include: "participants",
        "filters[participants]": String(teamId), per_page: 10
      })
      const recent = (r.data?.data || []).length
      // 3+ games in 7 days = fatigue penalty
      const factor = recent >= 3 ? 0.94 : recent === 2 ? 0.97 : 1.0
      return { fatigueFactor: factor, recentGames: recent }
    } catch(e) { return { fatigueFactor: 1.0 } }
  }, TTL.M)
}
// ── CORE FOOTBALL PREDICTION BUILDER ─────────────────────
// ── EXPECTED LINEUP FROM SQUAD DATA ──────────────────────────────────────────
function buildExpectedLineupFromSquad(teamName, teamElo) {
  const squad = squadDB.get(teamName) || []
  if (!squad.length) return []

  // 4-3-3 shape: GK, RB, CB, CB, LB, CDM, CM, CM, RW, ST, LW
  const needs = [
    { pos: 'GK',  count: 1, fallbacks: [] },
    { pos: 'RB',  count: 1, fallbacks: ['LB','LWB','RWB'] },
    { pos: 'CB',  count: 2, fallbacks: [] },
    { pos: 'LB',  count: 1, fallbacks: ['RB','LWB','RWB'] },
    { pos: 'CDM', count: 1, fallbacks: ['CM'] },
    { pos: 'CM',  count: 2, fallbacks: ['CDM','CAM','LM','RM'] },
    { pos: 'RW',  count: 1, fallbacks: ['RM','CAM'] },
    { pos: 'ST',  count: 1, fallbacks: ['LW','RW','CAM'] },
    { pos: 'LW',  count: 1, fallbacks: ['LM','CAM'] },
  ]

  const used = new Set()
  const lineup = []

  for (const req of needs) {
    const allPos = [req.pos, ...req.fallbacks]
    const pool = squad
      .filter(p => allPos.includes(p.position) && !used.has(p.player_name) && p.player_name)
      .sort((a, b) => (b.elo || 0) - (a.elo || 0))

    for (let i = 0; i < req.count; i++) {
      const p = pool[i]
      if (!p) break
      used.add(p.player_name)
      const pos = p.position || req.pos
      lineup.push({
        number: lineup.length + 1,
        name: p.player_name,
        position: pos,
        elo: p.elo || 1500,
        isKey: p.is_key || p.isKey || false,
        speed: p.speed || 60,
        attack: p.attack || 60,
        defense: p.defense || 60,
        bigMatch: p.big_match || p.bigMatch || 60,
        playstyle: p.playstyle || FOOTBALL_PLAYSTYLES[pos] || FOOTBALL_PLAYSTYLES.CM,
        goals_this_season: p.goals_this_season || null,
        assists_this_season: p.assists_this_season || null,
        real_rating: p.real_rating || null,
        appearances: p.appearances || null,
        sm_player_id: p.sm_player_id || null,
        _fromSquad: true // flag that this is predicted, not confirmed
      })
    }
  }

  return lineup
}

// ── POSITIONAL ELOs (Attack / Midfield / Defense) ─────────────────────────────
function buildPositionalElos(teamName) {
  const squad = squadDB.get(teamName) || []
  if (!squad.length) return null

  const groups = {
    attack:   ['ST','LW','RW','CAM'],
    midfield: ['CM','CDM','RM','LM'],
    defense:  ['CB','LB','RB','LWB','RWB']
  }

  const result = {}
  for (const [role, positions] of Object.entries(groups)) {
    const players = squad.filter(p => positions.includes(p.position) && (p.elo||0) > 1300)
    if (!players.length) { result[role] = null; continue }

    // Weighted average — top 3 players count more
    const sorted = players.sort((a,b) => (b.elo||0)-(a.elo||0))
    const weights = [0.45, 0.30, 0.15, 0.10]
    let weighted = 0, totalW = 0
    sorted.slice(0, 4).forEach((p, i) => {
      const w = weights[i] || 0.05
      weighted += (p.elo||1500) * w
      totalW += w
    })
    const avg = weighted / totalW
    // Scale 1300–2100 → 0–300
    result[role] = Math.round(Math.max(0, Math.min(300, (avg - 1300) / 800 * 300)))
    result[role+'_top'] = sorted[0]?.player_name || null
    result[role+'_elo'] = Math.round(avg)
    result[role+'_count'] = players.length
  }

  return result
}

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
    const league = normLeague(rawLeague)
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

    // Extract Sportmonks match statistics and apply to team weights
    if (smFix.statistics && Array.isArray(smFix.statistics)) {
      const homeStats = smFix.statistics.filter(s => s.participant_id === homeId)
      const awayStats = smFix.statistics.filter(s => s.participant_id === awayId)
      if (homeStats.length) applyStatsToTeamWeights(home, extractSMStats(homeStats))
      if (awayStats.length) applyStatsToTeamWeights(away, extractSMStats(awayStats))
    }

    let hForm = [], aForm = []
    if (homeId) hForm = await smTeamForm(homeId).then(f => f.map(x => x.result)).catch(() => [])
    if (awayId) aForm = await smTeamForm(awayId).then(f => f.map(x => x.result)).catch(() => [])

    const hElo = getElo(home, league, 0.5)
    const aElo = getElo(away, league, 0.5)
    const hW = getTeamWeights(home)
    const aW = getTeamWeights(away)

    const [hFatigue, aFatigue] = await Promise.all([
      smTeamFatigue(homeId, smFix.starting_at).catch(() => ({ fatigueFactor: 1.0 })),
      smTeamFatigue(awayId, smFix.starting_at).catch(() => ({ fatigueFactor: 1.0 })),
    ])
    const hxg = parseFloat((calcXG(hElo, aElo, hForm, true,  null, home) * hFatigue.fatigueFactor).toFixed(2))
    const axg = parseFloat((calcXG(aElo, hElo, aForm, false, null, away) * aFatigue.fatigueFactor).toFixed(2))

    

    const markets = buildAllMarkets(hxg, axg, smOdds, smPred, realOddsEntry)
    const { homeProb, drawProb, awayProb } = markets

    const homeOdds = smOdds.home || parseFloat((1/Math.max(0.01, homeProb/100)*1.06).toFixed(2))
    const drawOdds = smOdds.draw || parseFloat((1/Math.max(0.01, drawProb/100)*1.06).toFixed(2))
    const awayOdds = smOdds.away || parseFloat((1/Math.max(0.01, awayProb/100)*1.06).toFixed(2))
    const confidence = Math.min(99, Math.max(homeProb, drawProb, awayProb))

    const hVal = detectValue(homeProb, homeOdds)
    const aVal = detectValue(awayProb, awayOdds)
    const h2h = await smH2H(homeId, awayId).catch(() => [])

    const lus = smFix.lineups || []
    const buildLu = (tId, tName, tElo) => lus.filter(l => l.team_id === tId).slice(0, 11).map((l, idx) => {
      const pos   = mapPosId(l.position_id) || "CM"
      const pName = l.player_name || (l.player && (l.player.display_name || l.player.common_name || l.player.name)) || "Unknown"
      const db    = playerDB.get(`${pName}__${tName}`)
      const pElo  = (db && db.elo) || buildPlayerElo(pName, pos, tElo, null, 0, 0)
      const attrs = db || buildPlayerAttrs(pName, pos, pElo, tElo, null)
      return { number: l.jersey_number || idx + 1, name: pName, position: pos, elo: pElo, isKey: attrs?.is_key || false, speed: attrs?.speed || 60, attack: attrs?.attack || 60, defense: attrs?.defense || 60, bigMatch: attrs?.bigMatch || attrs?.big_match || 60, playstyle: attrs?.playstyle || FOOTBALL_PLAYSTYLES[pos] || FOOTBALL_PLAYSTYLES.CM, goals_this_season: attrs?.goals_this_season || null, real_rating: attrs?.real_rating || null }
    })
    let homeLineup = buildLu(homeId, home, hElo)
    let awayLineup = buildLu(awayId, away, aElo)
    
    // Fallback to squad data when no confirmed lineup
    if (!homeLineup.length) homeLineup = buildExpectedLineupFromSquad(home, hElo)
    if (!awayLineup.length) awayLineup = buildExpectedLineupFromSquad(away, aElo)
    const mismatches = detectMismatches(homeLineup, awayLineup, home, away)
    const gameApproach = buildGameApproach(hElo, aElo, hForm, aForm, hxg, axg, league, hW, aW)

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
      homeProb, drawProb, awayProb, gameApproach,
      homeOdds: parseFloat(homeOdds.toFixed(2)),
      drawOdds: parseFloat(drawOdds.toFixed(2)),
      awayOdds: parseFloat(awayOdds.toFixed(2)),
      hasRealOdds, confidence,
      upsetProb:    Math.min(95, Math.round(awayProb * 0.8 + (homeOdds < 1.6 ? 15 : 5))),
      isUpsetWatch: awayProb > 28 && homeOdds > 1.5,
      valueBet:     hVal.isValue || aVal.isValue,
      homeValueEdge: hVal.edge, awayValueEdge: aVal.edge,
      homeElo: hElo, awayElo: aElo,
      homeForm: hForm.slice(0, 5), awayForm: aForm.slice(0, 5),
      homeXg: parseFloat(hxg.toFixed(2)), awayXg: parseFloat(axg.toFixed(2)),
      homeTactics: inferTactics(hElo, hForm), awayTactics: inferTactics(aElo, aForm),
      homeFormation: "4-3-3", awayFormation: "4-3-3",
      homeLineup, awayLineup, mismatches, h2h,
      lineupsConfirmed: lus.length > 0,
      factors: buildFactors(hElo, aElo, hForm, aForm, hxg, axg, smPred, hW, aW),
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
async function warmPredictionsCache() {
  try {
    console.log('🔄 Warming predictions cache...')
    const [smList, oddsMap, liveList] = await Promise.all([
      smFixtures(14).catch(() => []),
      fetchOddsAPI().catch(() => ({})),
      smLive().catch(() => []),
    ])
    const all = new Map()
    for (const f of [...smList, ...liveList]) all.set(f.id, f)
    const fixtures = [...all.values()].filter(f => {
      const leagueId = f.league_id || f.league?.id
      return leagueId && ALLOWED_LEAGUE_IDS.has(leagueId)
    }).slice(0, 300)
    const results = []
    for (let b = 0; b < fixtures.length; b += 15) {
      const bRes = await Promise.all(fixtures.slice(b, b + 15).map(f => buildPrediction(f, oddsMap || {}).catch(() => null)))
      results.push(...bRes.filter(Boolean))
      await sleep(80)
    }
    cache.set('predictions_warm', { data: results, ts: Date.now() })
    console.log(`✅ Cache warmed: ${results.length} predictions`)
    return results
  } catch(e) {
    console.log('⚠️  Cache warm failed:', e.message)
    return []
  }
}


// ══════════════════════════════════════════════════════════
//  AUTO-POPULATE SQUADS
// ══════════════════════════════════════════════════════════
async function autoPopulateSquads() {
  if (!SM_KEY) return
  console.log('🔄 Auto-populating real squad data from Sportmonks...')
  try {
    const fixtures = cache.get('sm_fix_14')?.data || await smFixtures(14).catch(() => [])
    const teamMap = new Map()
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
        for (const inc of ['player;player.position;player.statistics.data','player;player.position','player']) {
          try {
            const r = await http(`${SM_BASE}/squads/teams/${teamId}`, { api_token: SM_KEY, include: inc, per_page: 50 })
            entries = r.data?.data || []
            if (entries.length > 0) break
          } catch(e2) { if ([403,401,422].includes(e2.response?.status)) break; await sleep(500) }
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
          const row = { player_name:pName, team_name:teamName, sm_player_id:p.id, position:pos, elo:pElo, speed:attrs.speed, attack:attrs.attack, defense:attrs.defense, big_match:attrs.bigMatch, is_key:attrs.isKey, playstyle_name:attrs.playstyle.name, goals_this_season:goals, assists_this_season:assists, appearances:apps, real_rating:rating||null, updated_at:new Date().toISOString() }
          playerDB.set(`${pName}__${teamName}`, { ...row, playstyle: attrs.playstyle })
          if (!squadDB.has(teamName)) squadDB.set(teamName, [])
          const sq2 = squadDB.get(teamName)
          const idx = sq2.findIndex(x => x.player_name === pName)
          if (idx >= 0) sq2[idx] = { ...row, playstyle: attrs.playstyle }
          else sq2.push({ ...row, playstyle: attrs.playstyle })
          if (sb) sbSave('player_ratings', row, 'player_name,team_name')
          teamPulled++; pulled++
        }
        if (teamPulled > 0) { console.log(`  ✅ ${teamName}: ${teamPulled} real players`); teams++ }
        cache.set(cacheKey, { data: entries, ts: Date.now() })
        await sleep(350)
      } catch(e) { if (e.response?.status === 429) { await sleep(8000) } }
    }
    console.log(`✅ Squads complete: ${teams} teams, ${pulled} real players`)
  } catch(e) { console.log('⚠️  autoPopulateSquads:', e.message) }
}

// ══════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════

// ── FOOTBALL PREDICTIONS ─────────────────────────────────
// ── FOOTBALL PREDICTIONS — PROGRESSIVE LOADING ──────────
const PRIORITY_LEAGUES = [
  // Tier 1 — load first (top 3)
  { name: "Champions League", smId: 2 },
  { name: "Premier League",   smId: 8 },
  { name: "La Liga",          smId: 564 },
  // Tier 2
  { name: "Serie A",          smId: 384 },
  { name: "Bundesliga",       smId: 82  },
  // Tier 3
  { name: "Ligue 1",          smId: 301 },
  { name: "Europa League",    smId: 5   },
  { name: "Championship",     smId: 9   },
]

const BRACKET_MAP = {
  ucl:         { espn:'uefa.champions',   smId:2,   name:'UEFA Champions League', hasGroups:true  },
  uel:         { espn:'uefa.europa',      smId:5,   name:'UEFA Europa League',    hasGroups:true  },
  uecl:        { espn:'uefa.europa.conf', smId:24,  name:'Conference League',     hasGroups:true  },
  fa_cup:      { espn:'eng.fa',           smId:7,   name:'FA Cup',                hasGroups:false },
  carabao:     { espn:'eng.league_cup',   smId:9,   name:'Carabao Cup',           hasGroups:false },
  dfb_pokal:   { espn:'ger.dfb_pokal',    smId:327, name:'DFB Pokal',             hasGroups:false },
  copa_del_rey:{ espn:'esp.copa_del_rey', smId:507, name:'Copa del Rey',          hasGroups:false },
  coppa_italia:{ espn:'ita.coppa_italia', smId:481, name:'Coppa Italia',          hasGroups:false },
  world_cup:   { espn:'fifa.world',       smId:23,  name:'FIFA World Cup',        hasGroups:true  },
  euros:       { espn:'uefa.euro',        smId:20,  name:'UEFA Euro',             hasGroups:true  },
}
 
// Exact league ID whitelist — only these pass through
const ALLOWED_LEAGUE_IDS = new Set([
  2,   // UEFA Champions League
  8,   // English Premier League  
  564, // La Liga (Spain top flight)
  384, // Serie A (Italy)
  82,  // Bundesliga (Germany)
  301, // Ligue 1 (France)
  5,   // UEFA Europa League
  9,   // EFL Championship
  72,  // Primeira Liga
  1,   // Eredivisie
  203, // Süper Lig
  208, // Belgian Pro League
  462, // Scottish Premiership
  271, // Danish Superliga
  197, // Greek Super League
  321, // Czech Liga
  155, // MLS
  7,   // FA Cup
  24,  // Conference League
])

app.get("/predictions", async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days || "14"), 14)
    const leagueTier = parseInt(req.query.tier || "0") // 0 = all, 1/2/3 = tiers
    // Serve instantly from warm cache
    const warm = cache.get('predictions_warm')
    if (warm && Date.now() - warm.ts < 3600000) {
      if (Date.now() - warm.ts > 1800000) warmPredictionsCache().catch(() => {})
      return res.json(warm.data.sort((a, b) => {
        const rd = (LEAGUE_RANK[a.league] || 99) - (LEAGUE_RANK[b.league] || 99)
        return rd !== 0 ? rd : new Date(a.date) - new Date(b.date)
      }))
    }


    console.log(`\n📊 /predictions (${days}d tier=${leagueTier})`)

    const [smList, oddsMap, liveList] = await Promise.all([
      smFixtures(days).catch(() => []),
      fetchOddsAPI().catch(() => ({})),
      smLive().catch(() => []),
    ])

    const all = new Map()
    for (const f of [...smList, ...liveList]) all.set(f.id, f)

    // STRICT league filtering — only exact top-flight leagues
    const fixtures = [...all.values()].filter(f => {
      const leagueId = f.league_id || f.league?.id
      if (!leagueId) return false
      return ALLOWED_LEAGUE_IDS.has(leagueId)
    }).slice(0, 300)

    console.log(`⚙️  Building ${fixtures.length} predictions...`)

    const results = []
    const BATCH = 15 // smaller batches = less timeout risk
    for (let b = 0; b < fixtures.length; b += BATCH) {
      const bRes = await Promise.all(
        fixtures.slice(b, b + BATCH).map(f => buildPrediction(f, oddsMap).catch(() => null))
      )
      results.push(...bRes.filter(Boolean))
      if (b + BATCH < fixtures.length) await sleep(80)
    }

    console.log(`✅ ${results.length} predictions ready`)
    res.json(results.sort((a, b) => {
      const rd = (LEAGUE_RANK[a.league] || 99) - (LEAGUE_RANK[b.league] || 99)
      return rd !== 0 ? rd : new Date(a.date) - new Date(b.date)
    }))
  } catch(e) {
    console.error("❌ /predictions:", e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── SPORT-SPECIFIC ROUTES ─────────────────────────────────
app.get("/predictions/nba", requireAccess('sport_analysis'), async (req, res) => {
  try {
    const games = await fetchNBAGames()
    const preds = games.map(buildNBAPrediction).filter(Boolean)
    console.log(`✅ NBA: ${preds.length}`)
    res.json(preds)
  } catch(e) { res.json([]) }
})

app.get("/predictions/nfl", requireAccess('sport_analysis'), async (req, res) => {
  try {
    const events = await fetchNFLGames()
    const preds  = events.map(buildNFLPrediction).filter(Boolean)
    console.log(`✅ NFL: ${preds.length}`)
    res.json(preds)
  } catch(e) { res.json([]) }
})

app.get("/predictions/tennis", requireAccess('sport_analysis'), async (req, res) => {
  try {
    const events = await fetchTennisTournaments()
    const preds  = events.map(buildTennisPrediction).filter(Boolean)
    const { surface, tour } = req.query
    res.json(preds.filter(p => (!surface || (p.surface||"").toLowerCase() === surface.toLowerCase()) && (!tour || (p.tour||"").toLowerCase() === tour.toLowerCase())))
  } catch(e) { res.json([]) }
})

app.get("/predictions/f1", requireAccess('sport_analysis'), async (req, res) => {
  try {
    const data = await fetchF1NextRace()
    res.json({ predictions: data.predictions || [], standings: data.standings || [] })
  } catch(e) { res.json({ predictions: [], standings: [] }) }
})

app.get("/predictions/boxing", requireAccess('sport_analysis'), async (req, res) => {
  try {
    const events = await fetchBoxingEvents()
    const preds  = events.map(buildBoxingPrediction).filter(Boolean)
    const { weightClass } = req.query
    res.json(weightClass ? preds.filter(p => (p.weightClass||"").toLowerCase().includes(weightClass.toLowerCase())) : preds)
  } catch(e) { res.json([]) }
})

app.get("/predictions/mma", requireAccess('sport_analysis'), async (req, res) => {
  try {
    const events = await fetchMMAEvents()
    const preds  = events.map(buildMMAPrediction).filter(Boolean)
    res.json(preds)
  } catch(e) { res.json([]) }
})
app.get('/referee/:id', (req, res) => {
  const profile = getRefereeProfile(req.params.id)
  res.json(profile || { message: 'Not enough data yet' })
})

app.get('/referees/all', (req, res) => {
  const all = []
  for (const [id, r] of refereeDB) all.push({ id, ...r })
  res.json(all.sort((a,b) => b.matchCount - a.matchCount).slice(0, 50))
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
  const { article } = req.body
  if (!article) return res.json({ error: "No article" })
  try {
    const prompt = `Football betting analyst. Analyze this news for betting impact.\nTitle: ${article.title||""}\nBody: ${(article.body||article.description||"").slice(0,600)}\nReturn JSON: {"summary":"2 sentences","impactLevel":"HIGH|MEDIUM|LOW|NONE","marketImpact":"odds insight","recommendation":"betting action","keyInsight":"most important insight","impactTeams":["team1"]}`
    res.json(await callAI(prompt, 500))
  } catch(e) { res.json({ error: "Failed" }) }
})

// ── ANALYZE ───────────────────────────────────────────────
app.post("/analyze", requireAccess('match_analysis'), async (req, res) => {
  const { match, type } = req.body
  try {
    let prompt = ""
    if (type === "match") {
      const m = match
      const hKeys = (squadDB.get(m.home)||[]).filter(p=>p.is_key).map(p=>`${p.player_name}(${p.position},ELO${p.elo})`).slice(0,5).join(",") || "SM data loading"
      const aKeys = (squadDB.get(m.away)||[]).filter(p=>p.is_key).map(p=>`${p.player_name}(${p.position},ELO${p.elo})`).slice(0,5).join(",") || "SM data loading"
      const sport = m.sport || 'football'
      const hW = getTeamWeights(m.home)
      const aW = getTeamWeights(m.away)
      prompt = `${sport.toUpperCase()} Match: ${m.home} vs ${m.away} | ${m.league}\nELO: H${m.homeElo} A${m.awayElo}\nProbs: H${m.homeProb}% D${m.drawProb||0}% A${m.awayProb}%\nKey players H: ${hKeys}\nKey players A: ${aKeys}\nHome possession avg: ${Math.round((hW.avgPossession||0.5)*100)}%\nAway possession avg: ${Math.round((aW.avgPossession||0.5)*100)}%\nHome clean sheet rate: ${Math.round((hW.cleanSheetRate||0.3)*100)}%\nAway clean sheet rate: ${Math.round((aW.cleanSheetRate||0.3)*100)}%\nReturn JSON: {"mainAnalysis":"3-4 sentences with specific player names","recommendation":"${sport==='football'?'Home Win|Draw|Away Win':'Home Win|Away Win'}","oneLineSummary":"sharp one-liner","keyFactors":["5 factors"],"mismatchImpact":"key matchup","confidenceRating":${m.confidence}}`
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
    } else if (type === "team") {
      const { team: tn, sport: sp } = match
      const w = getTeamWeights(tn)
      prompt = `Scout report for ${tn} (${sp||'football'}). Match count: ${w.matchCount}. Home win rate: ${Math.round(w.homeWin*100)}%. Away win rate: ${Math.round(w.awayWin*100)}%. Possession: ${Math.round((w.avgPossession||0.5)*100)}%. Clean sheet rate: ${Math.round((w.cleanSheetRate||0.3)*100)}%.\nReturn JSON: {"profile":"2-3 sentences","strengths":["3 tactical strengths"],"weaknesses":["2 weaknesses"]}`
    }
    res.json(await callAI(prompt))
  } catch(e) { res.json({ error: "Analysis failed" }) }
})

// ── TEAMS ─────────────────────────────────────────────────
app.get('/teams', async (req, res) => {
  try {
    const r = await httpExt('https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams', { limit: 100 })
    const teams = (r.data?.sports?.[0]?.leagues?.[0]?.teams || []).map(t => ({
      name: t.team?.displayName || t.team?.name,
      elo: getElo(t.team?.displayName || ''),
      country: 'England', league: 'Premier League',
    }))
    res.json(teams)
  } catch(e) { res.json([]) }
})

app.get('/teams/:sport', async (req, res) => {
  res.json([])
})

// ── SQUAD BY NAME ────────────────────────────────────────
app.get('/squad/byname/:teamName', async (req, res) => {
  const teamName = decodeURIComponent(req.params.teamName)
  const cached = squadDB.get(teamName)
  if (cached && cached.length) return res.json(cached)
  res.json([])
})
app.get('/team/profile/:teamName', async (req, res) => {
  function buildTeamDescriptors(teamName, tElo, w) {
    const descriptors = [], strengths = [], weaknesses = []
    const label = TEAM_SPECIAL_LABELS[teamName]
    if (label === 'finnesser') {
      descriptors.push({ label:'Finnesser', icon:'🎩', color:'var(--purple)' })
      strengths.push('Clinical despite limited possession')
      strengths.push('Consistently outperforms xG')
    } else if (label === 'haramball') {
      descriptors.push({ label:'Haramball', icon:'🔒', color:'var(--orange)' })
      strengths.push('Disciplined low-block structure')
      weaknesses.push('Limited in open creative play')
    } else if (label === 'bottler') {
      descriptors.push({ label:'Bottler', icon:'🍾', color:'var(--red)' })
      weaknesses.push('Historically concede late leads')
      weaknesses.push('Inconsistent in high-pressure moments')
    }
    if (tElo >= 1900) { descriptors.push({ label:'Elite Tier', icon:'⭐', color:'var(--gold)' }); strengths.push('World-class squad depth') }
    else if (tElo >= 1750) { descriptors.push({ label:'Top Tier', icon:'🔥', color:'var(--accent)' }); strengths.push('Consistent performers at the highest level') }
    if ((w.cleanSheetRate||0) > 0.4) strengths.push('Strong defensive record this season')
    if ((w.avgPossession||0.5) > 0.58) strengths.push('Dominant possession-based game')
    if ((w.homeWin||0.62) > 0.72) strengths.push('Formidable home fortress')
    if ((w.awayWin||0.38) < 0.25) weaknesses.push('Struggles significantly away from home')
    while (strengths.length < 2) strengths.push('Well-organized team structure')
    while (weaknesses.length < 1) weaknesses.push('Can be inconsistent against top opposition')
    const style = tElo >= 1900 ? 'Elite' : tElo >= 1750 ? 'Top Flight' : tElo >= 1600 ? 'Mid Table' : 'Lower Table'
    return { descriptors, strengths, weaknesses, style }
  }
  const teamName = decodeURIComponent(req.params.teamName)
  const tElo = getElo(teamName)
  let squad = squadDB.get(teamName) || []

  if (!squad.length && SM_KEY) {
    const fixtureCache = cache.get('sm_fix_14')?.data || []
    for (const f of fixtureCache) {
      const participant = (f.participants || []).find(p => p.name === teamName)
      if (participant?.id) {
        try { squad = await smSquad(participant.id, teamName, f.season_id) } catch(e) {}
        break
      }
    }
  }
  const w = getTeamWeights(teamName)
  const { descriptors, strengths, weaknesses, style } = buildTeamDescriptors(teamName, tElo, w)

  const keyPlayers = squad
    .filter(p => p.is_key || p.isKey)
    .sort((a,b) => (b.elo||0) - (a.elo||0))
    .slice(0, 6)

  const fixtureCache = cache.get('sm_fix_14')?.data || []
  const next5 = fixtureCache
    .filter(f => (f.participants||[]).some(p => p.name === teamName) && new Date(f.starting_at) > new Date())
    .sort((a,b) => new Date(a.starting_at) - new Date(b.starting_at))
    .slice(0, 5)
    .map(f => {
      const hp = (f.participants||[]).find(p => p.meta?.location === 'home')
      const ap = (f.participants||[]).find(p => p.meta?.location === 'away')
      return { home: hp?.name||'?', away: ap?.name||'?', date: f.starting_at, league: normLeague(f.league?.name||'')||f.league?.name||'', flag: leagueFlag(f.league?.country?.name||'') }
    })

  const managerEntry = [...managerEloMap.entries()].find(([,v]) => v.team === teamName)
  const manager = managerEntry ? managerEloMap.get(managerEntry[0]) : null

  const positionalElos = buildPositionalElos(teamName)

  res.json({
    name: teamName, elo: tElo,
    tier: tElo >= 1900 ? 'ELITE' : tElo >= 1750 ? 'TOP' : tElo >= 1600 ? 'MID' : 'LOWER',
    players: squad.length, style, descriptors, strengths, weaknesses, manager,
    positionalElos,
    squad: squad.map(p => ({
      player_name: p.player_name||p.name, position: p.position||'CM',
      elo: p.elo||1500, speed: p.speed, attack: p.attack, defense: p.defense,
      big_match: p.big_match||p.bigMatch, is_key: p.is_key||p.isKey,
      playstyle_name: p.playstyle?.name||p.playstyle_name, playstyle_icon: p.playstyle?.icon||'⚙️',
      goals_this_season: p.goals_this_season, assists_this_season: p.assists_this_season,
      real_rating: p.real_rating, sm_player_id: p.sm_player_id
    })),
    keyPlayers: keyPlayers.map(p => ({
      name: p.player_name||p.name, position: p.position||'CM', elo: p.elo||1500,
      playstyle: p.playstyle?.name||p.playstyle_name, playstyle_icon: p.playstyle?.icon||'⚙️',
      playstyles: p.playstyles || (p.playstyle ? [p.playstyle] : []),
      speed: p.speed, attack: p.attack, defense: p.defense, bigMatch: p.big_match||p.bigMatch,
      goals: p.goals_this_season, assists: p.assists_this_season, rating: p.real_rating,
      appearances: p.appearances
    })),
    next5,
    stats: {
      homeWin: Math.round((w.homeWin||0.62)*100), awayWin: Math.round((w.awayWin||0.38)*100),
      cleanSheetRate: Math.round((w.cleanSheetRate||0.3)*100),
      avgPossession: Math.round((w.avgPossession||0.5)*100), matchCount: w.matchCount||0,
      goalsFromSetPiece: Math.round((w.goalsFromSetPiece||0.2)*100),
    }
  })
})
// ── PARLAY AUTO-BUILD ─────────────────────────────────────
app.post("/parlay/auto", requireAccess('auto_parlay'), async (req, res) => {
  const { predictions=[], targetOdds=4.0, riskLevel=5, minLegs=2, maxLegs=8,
          preferredMarkets=["h2h"], enabledSports=["football"], timeframeDays=7 } = req.body

  if (!predictions.length) return res.json({ parlay: [], notEnoughMatches: "No predictions provided" })

  const now = Date.now()
  const maxMs = timeframeDays * 86400000
  const pool = predictions.filter(m =>
    !m.isLive && !m.isFinished &&
    (!m.date || (new Date(m.date).getTime() >= now - 3600000 && new Date(m.date).getTime() <= now + maxMs))
  )

  if (!pool.length) return res.json({ parlay: [], notEnoughMatches: "No upcoming matches in timeframe" })

  const candidates = []
  const mkts = Array.isArray(preferredMarkets) ? preferredMarkets : ["h2h"]

  for (const m of pool) {
    const sport = m.sport || 'football'
    const addLeg = (pick, label, odds, prob) => {
      if (!odds || odds < 1.04 || !prob || prob < 5) return
      const impliedProb = 100 / odds
      const edge = prob - impliedProb
      const leagueBonus = (m.league && ['Premier League','La Liga','Champions League','Serie A','Bundesliga','NBA','NFL'].includes(m.league)) ? 4 : 0
      const realOddsBonus = m.hasRealOdds ? 8 : 0
      // Score purely by confidence + edge (no risk level penalty)
      const score = (prob * 0.55) + (edge * 3.5) + (m.confidence||0) * 0.15 + leagueBonus + realOddsBonus
      candidates.push({ matchId:m.id, pick, label, odds:parseFloat(parseFloat(odds).toFixed(2)), prob:Math.round(prob), matchName:(m.home||'?')+' vs '+(m.away||'?'), league:m.league, confidence:m.confidence||prob, hasRealOdds:m.hasRealOdds, sport, score, edge:parseFloat(edge.toFixed(2)), date:m.date })
    }

    if (mkts.some(k => ['h2h','1x2','auto'].includes(k))) {
      addLeg('home', (m.home||'?')+' Win', m.homeOdds, m.homeProb)
      if (m.drawOdds && m.drawProb) addLeg('draw', 'Draw', m.drawOdds, m.drawProb)
      addLeg('away', (m.away||'?')+' Win', m.awayOdds, m.awayProb)
    }
    if (mkts.some(k => ['btts','auto'].includes(k)) && m.bttsOdds?.yes && m.bttsProb) {
      addLeg('btts_yes', 'BTTS — Yes', m.bttsOdds.yes, m.bttsProb)
    }
    if (mkts.some(k => ['btts_no'].includes(k)) && m.bttsOdds?.no) {
      addLeg('btts_no', 'BTTS — No', m.bttsOdds.no, 100-(m.bttsProb||50))
    }
    const ouLines = { 'ou_0.5':0.5,'ou_1.5':1.5,'ou_2.5':2.5,'ou_3.5':3.5,'ou_4.5':4.5,'ou_5.5':5.5 }
    for (const [mktKey, pts] of Object.entries(ouLines)) {
      if (!mkts.some(k => [mktKey,'auto'].includes(k))) continue
      const ou = m.ouOdds?.[pts]
      const op = m.ouProbs?.[pts]
      if (ou?.over && op?.overPct) addLeg('over_'+pts, 'Over '+pts, ou.over, op.overPct)
      if (ou?.under && op?.underPct) addLeg('under_'+pts, 'Under '+pts, ou.under, op.underPct)
    }
    // Double chance markets
    if (mkts.some(k => ['dc','auto'].includes(k))) {
      if (m.homeProb && m.drawProb) {
        const dcProb = Math.round((m.homeProb + m.drawProb) * 0.97)
        const dcOdds = parseFloat((1/Math.max(0.01,dcProb/100)*1.05).toFixed(2))
        addLeg('dc_home', (m.home||'?') + ' or Draw', dcOdds, dcProb)
      }
    }
  }

  if (!candidates.length) return res.json({ parlay: [], notEnoughMatches: "No valid legs found for selected markets" })

  // Sort purely by score descending (highest confidence first)
  candidates.sort((a, b) => b.score - a.score)

  const used = new Set()
  const selected = []
  let combinedOdds = 1.0

  // Fill up to maxLegs with highest confidence picks (one pick per match)
  for (const c of candidates) {
    if (selected.length >= maxLegs) break
    if (used.has(c.matchId)) continue
    if (c.prob < 10) continue // absolute minimum sanity check
    selected.push(c)
    used.add(c.matchId)
    combinedOdds *= c.odds
  }

  if (!selected.length || selected.length < minLegs) {
    return res.json({ parlay: [], notEnoughMatches: "Could not build parlay — try lower min legs or add more sports/markets" })
  }

  const avgConf = selected.reduce((s, c) => s + c.prob, 0) / selected.length
  const score = Math.max(10, Math.min(99, Math.round(avgConf - Math.max(0, (selected.length-3)*3))))
  const sportsUsed = [...new Set(selected.map(s=>s.sport))]
  const marketsUsed = [...new Set(selected.map(s=>s.pick.split('_')[0]))]

  res.json({ 
    parlay: selected, 
    combinedOdds: parseFloat(combinedOdds.toFixed(2)), 
    targetOdds, 
    score, 
    legCount: selected.length, 
    markets: marketsUsed,
    sports: sportsUsed,
    avgConfidence: Math.round(avgConf)
  })
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
// Looks up by user_id (Supabase auth uid) — matches your schema
app.get("/user/:userId", async (req, res) => {
  if (!sb) return res.json({ plan:'free', credits_total:25, credits_used:0, credits_available:25 })
  try {
    const { data, error } = await sb.from('users')
      .select('*')
      .eq('id', req.params.userId).single()
    console.log('USER LOOKUP:', req.params.userId.slice(0,8), 
      'plan:', data?.plan, 'total:', data?.credits_total, 
      'used:', data?.credits_used, 'monthly:', data?.monthly_credits,
      'err:', error?.message)
    if (error || !data) return res.status(404).json({ error: "User not found" })
    const plan = data.plan || 'free'
    const unlimited = plan === 'platinum'
    const monthly = data.monthly_credits ?? (PLAN_CREDITS[plan] || 25)
    const available = unlimited ? 999999 
      : Math.max(0, monthly - (data.credits_used || 0) + (data.credits_bonus || 0))
    res.json({ ...data, credits_available: available, unlimited })
  } catch(e) { res.status(500).json({ error: e.message }) }
})
app.post("/credits/use", async (req, res) => {
  if (!sb) return res.status(503).json({ error: "Supabase not configured" })
  const { user_id, action } = req.body
  if (!user_id || !action) return res.status(400).json({ error: "Missing fields" })
  const access = await checkAccess(user_id, action)
  if (!access.ok) return res.status(402).json({ ok: false, ...access })
  const result = await useCredits(user_id, action)
  res.json(result)
})

app.get("/credits/:userId", async (req, res) => {
  if (!sb) return res.json({ plan:'free', credits_total:25, credits_used:0, credits_remaining:25 })
  const uid = req.params.userId
  const { data } = await sb.from('users')
    .select('plan, credits_total, credits_used, credits_reset_at, referral_code')
    .eq('id', uid).single().catch(() => ({ data: null }))
  if (!data) return res.json({ plan:'free', credits_total:25, credits_used:0, credits_remaining:25 })
  const plan = data.plan || 'free'
  const unlimited = plan === 'platinum'
  const remaining = unlimited ? 999999 : Math.max(0, (data.credits_total||25) - (data.credits_used||0))
  res.json({ plan, credits_total:data.credits_total, credits_used:data.credits_used, credits_remaining:remaining, unlimited, reset_at:data.credits_reset_at, referral_code:data.referral_code })
})

app.post('/credits/check', async (req, res) => {
  const userId = req.headers['x-user-id'] || req.body?.userId
  const { action } = req.body
  if (!userId || !action) return res.json({ ok: true })
  const access = await checkAccess(userId, action)
  res.json(access)
})
app.post('/user/ensure', async (req, res) => {
  if (!sb) return res.json({ ok: true })
  const { user_id, email, full_name } = req.body
  if (!user_id || !email) return res.status(400).json({ error: 'Missing fields' })
  try {
    const { data: existing } = await sb.from('users')
      .select('id, plan').eq('id', user_id).maybeSingle()
    if (existing) return res.json({ ok: true, plan: existing.plan, created: false })
    const myRef  = 'SLIP' + user_id.replace(/-/g,'').slice(0,8).toUpperCase()
    const resetAt = new Date(Date.now() + 30*86400000).toISOString()
    const { error } = await sb.from('users').insert({
      id: user_id, email, full_name: full_name || '',
      plan: 'free', plan_status: 'active',
      credits_total: 25, credits_used: 0, credits_reset_at: resetAt,
      referral_code: myRef,
      joined_at: new Date().toISOString(), updated_at: new Date().toISOString()
    })
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, plan: 'free', created: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})
// ── REFERRALS ─────────────────────────────────────────────
app.get("/referral/my/:userId", async (req, res) => {
  if (!sb) return res.json({ code: 'SLIP' + req.params.userId.slice(0,8).toUpperCase() })
  const uid = req.params.userId
  const { data } = await sb.from('users')
    .select('referral_code, plan')
    .eq('id', uid).single().catch(() => ({data:null}))
  if (!data) {
    return res.json({ code: 'SLIP' + uid.replace(/-/g,'').slice(0,8).toUpperCase(), referral_count: 0 })
  }
  if (!data.referral_code) {
    const code = 'SLIP' + uid.replace(/-/g,'').slice(0,8).toUpperCase()
    await sb.from('users').update({ referral_code: code, updated_at: new Date().toISOString() }).eq('id', uid).catch(()=>{})
    data.referral_code = code
  }
  // Count how many users were referred by this code
  const { count } = await sb.from('users').select('id', { count: 'exact' }).eq('referred_by', data.referral_code).catch(() => ({ count: 0 }))
  const made = count || 0
  res.json({
    code: data.referral_code,
    referral_count: made,
    next_reward_at: made < 3 ? 3 : made < 5 ? 5 : made < 8 ? 8 : 'maxed',
    plan: data.plan
  })
})

app.get("/referral/validate/:code", async (req, res) => {
  if (!sb) return res.json({ valid: false })
  const code = req.params.code.toUpperCase().trim()
  const { data } = await sb.from('users')
    .select('id, plan, referral_code')
    .eq('referral_code', code).single().catch(() => ({data:null}))
  if (!data) return res.json({ valid: false, message: 'Code not found' })
  res.json({ valid: true, code, referrer_plan: data.plan, referrer_user_id: data.id })
})

app.post("/referral/apply", async (req, res) => {
  if (!sb) return res.json({ ok: true, discount: 25 })
  const { code, user_email, user_id, plan } = req.body
  const ELIGIBLE = ['pro', 'elite', 'platinum', 'plus']
  if (plan && !ELIGIBLE.includes(plan)) {
    return res.json({ ok: false, reason: 'plan_not_eligible', message: 'Referral codes can only be used on Pro plan and above.' })
  }
  const { data: referrer } = await sb.from('users')
    .select('id, referral_code, plan').eq('referral_code', code.toUpperCase()).single().catch(() => ({data:null}))
  if (!referrer) return res.json({ ok: false, message: 'Code not found' })
  if (user_id && referrer.id === user_id) return res.json({ ok: false, message: 'Cannot use your own code' })
  if (user_id) {
    const { data: me } = await sb.from('users').select('referred_by').eq('id', user_id).single().catch(() => ({data:null}))
    if (me?.referred_by) return res.json({ ok: false, message: 'You have already used a referral code' })
  }
  res.json({ ok: true, discount: 25, referrer_user_id: referrer.id, message: '✓ Code applied! 25% off your first month.' })
})

app.post("/referral/confirm", async (req, res) => {
  if (!sb) return res.json({ ok: true })
  const { code, referred_user_id, referrer_user_id } = req.body
  if (!referrer_user_id) return res.json({ ok: false })

  // Mark referred user as having used this referral code
  if (referred_user_id) {
    await sb.from('users').update({
      referred_by: code, updated_at: new Date().toISOString()
    }).eq('id', referred_user_id).catch(() => {})
  }

  // Count total referrals for the referrer
  const { data: referrerData } = await sb.from('users')
    .select('plan, referral_code').eq('id', referrer_user_id).single().catch(() => ({data:null}))
  const { count: newCount } = await sb.from('users')
    .select('id', { count: 'exact' }).eq('referred_by', referrerData?.referral_code || '').catch(() => ({ count: 0 }))

  // Tiered rewards: 3 refs = pro, 5 refs = elite, 8 refs = platinum
  let rewardPlan = null
  const c = newCount || 0
  if (c >= 8) rewardPlan = 'platinum'
  else if (c >= 5) rewardPlan = 'elite'
  else if (c >= 3) rewardPlan = 'pro'

  if (rewardPlan && rewardPlan !== referrerData?.plan) {
    await sb.from('users').update({
      plan: rewardPlan,
      credits_total: PLAN_CREDITS[rewardPlan] || 265,
      credits_used: 0,
      credits_reset_at: new Date(Date.now() + 30*86400000).toISOString(),
      updated_at: new Date().toISOString()
    }).eq('id', referrer_user_id).catch(() => {})
  }
  res.json({ ok: true, referral_count: c, reward_plan: rewardPlan })
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

app.get('/elo/sport/:sport', (req, res) => {
  const sport = req.params.sport
  const limit = parseInt(req.query.limit||'50')
  const posFilter = req.query.position
  let results = []
  if (sport === 'football') {
    const all = []
    for (const [k, v] of playerDB) {
      const p = typeof v === 'object' ? v : {}
      if (posFilter && p.position !== posFilter) continue
      all.push({ name:p.player_name||k.split('__')[0], team:p.team_name||k.split('__')[1], elo:p.elo||1500, position:p.position, playstyle:p.playstyle?.name||p.playstyle_name, sport:'football' })
    }
    results = all.sort((a,b)=>b.elo-a.elo).slice(0,limit)
  } else if (sport === 'basketball') {
    const typeParam = req.query.type || 'player'
    if (typeParam === 'team') {
      results = Object.entries(NBA_ELO_BASE).map(([t,e])=>({ name:t, elo:e, sport:'basketball', type:'team' })).sort((a,b)=>b.elo-a.elo).slice(0,limit)
    } else {
      results = NBA_TOP_PLAYERS.slice(0, limit).map(p => ({
        ...p, sport:'basketball', type:'player',
        playstyle: getPlaystyleForSport('basketball', p.position, p.name, p.elo)
      }))
    }
  } else if (sport === 'american_football') {
    results = Object.entries(NFL_ELO_BASE).map(([t,e])=>({ name:t, elo:e, sport:'nfl', type:'team' })).sort((a,b)=>b.elo-a.elo).slice(0,limit)
  } else if (sport === 'tennis') {
    const all = [...TENNIS_PLAYERS.ATP, ...TENNIS_PLAYERS.WTA]
    results = all.sort((a,b)=>b.elo-a.elo).slice(0,limit).map(p=>({...p,sport:'tennis',type:'player',playstyle:getPlaystyleForSport('tennis',null,p.name,p.elo)}))
  } else if (sport === 'f1') {
    results = F1_DRIVERS_2025.sort((a,b)=>b.elo-a.elo).slice(0,limit).map(d=>({...d,sport:'f1',type:'driver',playstyle:getPlaystyleForSport('f1',null,d.name,d.elo)}))
  } else if (sport === 'boxing') {
    results = BOXING_FIGHTERS.sort((a,b)=>b.elo-a.elo).slice(0,limit).map(f=>({...f,sport:'boxing',type:'fighter',playstyle:getPlaystyleForSport('boxing',null,f.name,f.elo)}))
  } else if (sport === 'mma') {
    results = MMA_FIGHTERS.sort((a,b)=>b.elo-a.elo).slice(0,limit).map(f=>({...f,sport:'mma',type:'fighter',playstyle:getPlaystyleForSport('mma',null,f.name,f.elo)}))
  }
  res.json({ sport, results, count: results.length })
})

// ── STANDINGS ─────────────────────────────────────────────
app.get('/standings/nba', async (req, res) => {
  const parseESPNConference = (entries, confName) => entries.map(e => {
    const stats = {}
    for (const s of (e.stats || [])) {
      const k = s.abbreviation || s.name || ''
      stats[k] = (s.value !== undefined && s.value !== null) ? s.value : parseFloat(s.displayValue) || 0
    }
    return {
      Name: e.team?.displayName || e.team?.name || '?',
      TeamCity: e.team?.location || '',
      Wins: parseInt(stats['W'] || stats['wins'] || 0),
      Losses: parseInt(stats['L'] || stats['losses'] || 0),
      GamesBehind: parseFloat(stats['GB'] || stats['gamesBehind'] || 0) || 0,
      Streak: stats['STRK'] || stats['streak'] || '—',
      Conference: confName,
      PointsFor: parseFloat(stats['PPG'] || stats['PF'] || 0) || undefined,
      WinPercentage: parseFloat(stats['PCT'] || stats['winPercent'] || 0) || undefined
    }
  }).sort((a, b) => b.Wins - a.Wins)

  try {
    if (process.env.SPORTSDATAIO_KEY) {
      try {
        const season = new Date().getFullYear() + (new Date().getMonth() >= 9 ? 1 : 0)
        const r = await httpExt(`https://api.sportsdata.io/v3/nba/scores/json/Standings/${season}`,
          {}, { 'Ocp-Apim-Subscription-Key': process.env.SPORTSDATAIO_KEY })
        const teams = r.data || []
        if (teams.length) {
          const east = teams.filter(t => t.Conference === 'Eastern').sort((a,b) => (b.Wins||0)-(a.Wins||0))
          const west = teams.filter(t => t.Conference === 'Western').sort((a,b) => (b.Wins||0)-(a.Wins||0))
          return res.json({ source:'sportsdata.io', east, west, season })
        }
      } catch(e2) {}
    }
    const r = await httpExt('https://site.api.espn.com/apis/v2/sports/basketball/nba/standings', { limit:100 })
    const data = r.data
    const children = data.children || data.standings?.children || []
    let east = [], west = []
    for (const child of children) {
      const entries = child.standings?.entries || child.entries || []
      const name = (child.name || child.abbreviation || '').toLowerCase()
      const parsed = parseESPNConference(entries, name.includes('east') ? 'Eastern' : 'Western')
      if (name.includes('east')) east = parsed
      else west = parsed
    }
    // Fallback: use NBA_ELO_BASE if ESPN parse yielded nothing
    if (!east.length && !west.length) {
      const eastTeams = ['Boston Celtics','New York Knicks','Cleveland Cavaliers','Milwaukee Bucks','Orlando Magic','Indiana Pacers','Miami Heat','Philadelphia 76ers','Brooklyn Nets','Atlanta Hawks','Chicago Bulls','Charlotte Hornets','Washington Wizards','Toronto Raptors','Detroit Pistons']
      const westTeams = ['Oklahoma City Thunder','Denver Nuggets','Minnesota Timberwolves','LA Clippers','Dallas Mavericks','Phoenix Suns','Golden State Warriors','Sacramento Kings','New Orleans Pelicans','Los Angeles Lakers','Houston Rockets','Memphis Grizzlies','Utah Jazz','Portland Trail Blazers','San Antonio Spurs']
      const mkEntry = (n, i, conf) => ({ Name:n, Wins:Math.max(0,48-i*3), Losses:Math.min(82,20+i*3), GamesBehind:i*3, Streak:'—', Conference:conf })
      east = eastTeams.map((n,i) => mkEntry(n,i,'Eastern'))
      west = westTeams.map((n,i) => mkEntry(n,i,'Western'))
    }
    res.json({ source:'espn', east, west })
  } catch(e) {
    res.json({ east:[], west:[] })
  }
})

app.get('/standings/nfl', async (req, res) => {
  try {
    if (process.env.SPORTSDATAIO_KEY) {
      const season = new Date().getFullYear()
      const r = await httpExt(`https://api.sportsdata.io/v3/nfl/scores/json/Standings/${season}`,
        {}, { 'Ocp-Apim-Subscription-Key': process.env.SPORTSDATAIO_KEY })
      if (r.data?.length) return res.json({ source:'sportsdata.io', data:r.data, season })
    }
    const r = await httpExt('https://site.api.espn.com/apis/v2/sports/football/nfl/standings', { limit:100 })
    res.json({ source:'espn', data:r.data })
  } catch(e) { res.json({ data:[] }) }
})

app.get('/standings/tennis', async (req, res) => {
  const tour = req.query.tour || 'ATP'
  const pool = tour === 'WTA' ? TENNIS_PLAYERS.WTA : TENNIS_PLAYERS.ATP
  res.json({ source:'internal', tour, players: pool.map(p => ({ ...p, playstyle:getPlaystyleForSport('tennis',null,p.name,p.elo) })) })
})

app.get('/standings/f1', async (req, res) => {
  try {
    const r = await httpExt(`${OPEN_F1_BASE}/drivers?session_key=latest`)
    const drivers = r.data || []
    res.json({ source:'openf1', drivers:drivers.map(d=>({ name:d.full_name||d.broadcast_name, number:d.driver_number, team:d.team_name, country:d.country_code, headshot:d.headshot_url, elo:F1_DRIVERS_2025.find(fd=>fd.name===d.full_name)?.elo||1800, playstyle:getPlaystyleForSport('f1',null,d.full_name||'',1800) })), constructors:Object.entries(F1_CONSTRUCTOR_ELO).map(([t,e])=>({team:t,elo:e})) })
  } catch(e) {
    res.json({ source:'static', drivers:F1_DRIVERS_2025.map(d=>({...d,playstyle:getPlaystyleForSport('f1',null,d.name,d.elo)})), constructors:Object.entries(F1_CONSTRUCTOR_ELO).map(([t,e])=>({team:t,elo:e})) })
  }
})

app.get('/standings/boxing', async (req, res) => {
  const wc = req.query.weightClass
  const fighters = wc ? BOXING_FIGHTERS.filter(f=>f.weightClass===wc) : BOXING_FIGHTERS
  res.json({ source:'internal', fighters:fighters.map(f=>({...f,playstyle:getPlaystyleForSport('boxing',null,f.name,f.elo)})) })
})

app.get('/standings/mma', async (req, res) => {
  const div = req.query.division
  const fighters = div ? MMA_FIGHTERS.filter(f=>f.division===div) : MMA_FIGHTERS
  res.json({ source:'internal', fighters:fighters.map(f=>({...f,playstyle:getPlaystyleForSport('mma',null,f.name,f.elo)})) })
})
app.get('/bracket/:slug', async (req, res) => {
  const lg = BRACKET_MAP[req.params.slug]
  if (!lg) return res.status(404).json({ error: 'Unknown competition slug' })
 
  return cached('bracket_' + req.params.slug, async () => {
    const rounds = {}, groups = []
 
    // ── Try ESPN scoreboard ──────────────────────────────────────
    try {
      const r = await httpExt(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lg.espn}/scoreboard`, { limit: 100 })
      const events = r.data?.events || []
      for (const e of events) {
        const comp    = e.competitions?.[0] || {}
        const home    = comp.competitors?.find(c => c.homeAway === 'home')
        const away    = comp.competitors?.find(c => c.homeAway === 'away')
        const round   = e.week?.displayValue || e.week?.number?.toString() || e.season?.type?.name || 'Round 1'
        if (!rounds[round]) rounds[round] = []
        rounds[round].push({
          id: e.id, home: home?.team?.displayName || '?', away: away?.team?.displayName || '?',
          homeLogo: home?.team?.logo, awayLogo: away?.team?.logo,
          homeScore: home?.score != null ? parseInt(home.score) : null,
          awayScore: away?.score != null ? parseInt(away.score) : null,
          status: e.status?.type?.description || 'Scheduled',
          isLive: e.status?.type?.name === 'STATUS_IN_PROGRESS',
          isFinished: e.status?.type?.completed || false,
          date: e.date, venue: comp.venue?.fullName,
          agg: comp.notes?.[0]?.headline || null,
        })
      }
    } catch(e) { console.log('Bracket ESPN:', e.message?.slice(0, 60)) }
 
    // ── Try Sportmonks for cup rounds ────────────────────────────
    if (SM_KEY && Object.keys(rounds).length === 0) {
      try {
        const today = new Date().toISOString().slice(0,10)
        const past  = new Date(Date.now() - 180*86400000).toISOString().slice(0,10)
        const r = await http(`${SM_BASE}/fixtures/between/${past}/${today}`, {
          api_token: SM_KEY, 'filters[league_id]': String(lg.smId),
          include: 'participants;scores;round', order: 'desc', per_page: 100,
        })
        for (const f of (r.data?.data || [])) {
          const hp  = (f.participants||[]).find(p => p.meta?.location === 'home')
          const ap  = (f.participants||[]).find(p => p.meta?.location === 'away')
          const rnd = f.round?.name || ('Round ' + (f.round_id || '1'))
          if (!rounds[rnd]) rounds[rnd] = []
          const cH = (f.scores||[]).find(s => s.participant_id === hp?.id && s.description === 'CURRENT')
          const cA = (f.scores||[]).find(s => s.participant_id === ap?.id && s.description === 'CURRENT')
          rounds[rnd].push({
            id: f.id, home: hp?.name||'?', away: ap?.name||'?',
            homeLogo: hp?.image_path, awayLogo: ap?.image_path,
            homeScore: cH?.score?.goals ?? null, awayScore: cA?.score?.goals ?? null,
            status: f.state_id === 5 ? 'Final' : 'Scheduled',
            isFinished: f.state_id === 5, date: f.starting_at,
          })
        }
      } catch(e) { console.log('Bracket SM:', e.message?.slice(0, 60)) }
    }
 
    // ── Build group stage from standings if hasGroups ────────────
    if (lg.hasGroups) {
      try {
        const r = await httpExt(`https://site.api.espn.com/apis/v2/sports/soccer/${lg.espn}/standings`, { limit: 100 })
        const children = r.data?.children || r.data?.standings?.children || []
        for (const child of children) {
          const entries = child.standings?.entries || child.entries || []
          if (!entries.length) continue
          const table = entries.map(e => {
            const s = {}; (e.stats||[]).forEach(st => { s[st.abbreviation||st.name] = st.value !== undefined ? Number(st.value) : parseFloat(st.displayValue)||0 })
            return {
              name:   e.team?.displayName || '?',
              logo:   e.team?.logos?.[0]?.href,
              p:  parseInt(s['GP']||s['gamesPlayed']||0),
              w:  parseInt(s['W']||0), d: parseInt(s['T']||s['D']||0), l: parseInt(s['L']||0),
              gf: parseInt(s['GF']||s['goalsFor']||0), ga: parseInt(s['GA']||s['goalsAgainst']||0),
              pts: parseInt(s['PTS']||s['Pts']||0) || (parseInt(s['W']||0)*3 + parseInt(s['T']||s['D']||0)),
            }
          }).sort((a,b) => b.pts - a.pts)
          groups.push({ name: child.name || child.abbreviation || 'Group', table })
        }
      } catch(e) {}
    }
 
    return { name: lg.name, slug: req.params.slug, hasGroups: lg.hasGroups, rounds, groups }
  }, TTL.M).then(d => res.json(d)).catch(e => res.status(500).json({ error: e.message }))
})
 
app.get('/managers/top', async (req, res) => {
  const limit  = parseInt(req.query.limit || '50')
  const league = req.query.league || ''
  const style  = req.query.style  || ''
  let managers = Array.from(managerEloMap.values())
  if (league) managers = managers.filter(m => (m.league||'').toLowerCase() === league.toLowerCase())
  if (style)  managers = managers.filter(m => (m.style||'').toLowerCase().includes(style.toLowerCase()))
  managers.sort((a, b) => b.elo - a.elo)
  res.json(managers.slice(0, limit).map((m, i) => ({
    rank: i + 1, name: m.name, team: m.team, elo: m.elo,
    formation: m.formation, style: m.style, nationality: m.nationality,
    league: m.league, wins: m.wins||0, draws: m.draws||0, losses: m.losses||0,
    trophies: m.trophies||0,
    winRate: (m.wins||0) + (m.draws||0) + (m.losses||0) > 0
      ? Math.round(((m.wins||0) / ((m.wins||0)+(m.draws||0)+(m.losses||0)))*100) : null
  })))
})
 
app.get('/manager/:name', (req, res) => {
  const m = managerEloMap.get(decodeURIComponent(req.params.name))
  if (!m) return res.status(404).json({ error: 'Manager not found' })
  const total = (m.wins||0)+(m.draws||0)+(m.losses||0)
  res.json({ ...m, winRate: total > 0 ? Math.round(((m.wins||0)/total)*100) : null, total })
})
app.get('/standings/football', async (req, res) => {
  try {
    const leagues = [
      { espnSlug:'eng.1',name:'Premier League' },
      { espnSlug:'esp.1',name:'La Liga' },
      { espnSlug:'ger.1',name:'Bundesliga' },
      { espnSlug:'ita.1',name:'Serie A' },
      { espnSlug:'fra.1',name:'Ligue 1' },
    ]
    const results = []
    for (const lg of leagues) {
      try {
        const r = await httpExt(`https://site.api.espn.com/apis/v2/sports/soccer/${lg.espnSlug}/standings`, { limit:30 })
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
          }).sort((a,b) => a.position - b.position || b.points - a.points)
          results.push({ name:lg.name, season:new Date().getFullYear(), table })
        }
      } catch(e2) {}
      await sleep(150)
    }
    res.json(results.length ? results : [])
  } catch(e) { res.status(500).json({ error:e.message }) }
})

// ── OUTCOMES & WEIGHTS ────────────────────────────────────
app.post('/outcomes/record', async (req, res) => {
  const { matchId, actualWinner, homeScore, awayScore, sport } = req.body
  if (!matchId) return res.status(400).json({ error: 'matchId required' })
  await recordOutcome(matchId, actualWinner, homeScore, awayScore)
  res.json({ ok: true, weights: sportWeights[sport] })
})

app.post('/outcomes/record/team', async (req, res) => {
  const { homeTeam, awayTeam, homeScore, awayScore, homeXg, awayXg, league, isEuropean, possession, shotsOnTarget, corners, yellowCards, setpieceGoals, avgRating } = req.body
  if (!homeTeam || !awayTeam) return res.status(400).json({ error: 'Missing teams' })
  await updateTeamWeights(homeTeam, awayTeam, homeScore, awayScore, true, { homeXg, awayXg, league, isEuropean, possession, shotsOnTarget, corners, yellowCards, setpieceGoals, avgRating })
  await recordOutcome(`${homeTeam}_${awayTeam}_${Date.now()}`, homeScore > awayScore ? homeTeam : awayScore > homeScore ? awayTeam : 'Draw', homeScore, awayScore)
  res.json({ ok: true, homeWeights: getTeamWeights(homeTeam), awayWeights: getTeamWeights(awayTeam) })
})

app.get('/weights/team/:teamName', (req, res) => {
  res.json(getTeamWeights(decodeURIComponent(req.params.teamName)))
})

app.get('/weights/all', (req, res) => {
  const result = {}
  for (const [k, v] of teamWeights) result[k] = v
  res.json({ count: teamWeights.size, teams: result })
})

app.get('/ai/weights', (req, res) => {
  res.json({ weights: sportWeights, recentUpdates: weightUpdateLog.slice(-20), totalPredictions: predictionLog.size })
})

// ── ADMIN ─────────────────────────────────────────────────
app.post('/admin/pull-squads', async (req, res) => {
  autoPopulateSquads().catch(() => {})
  res.json({ ok: true, message: 'Squad pull started', playerCount: playerDB.size })
})

app.post("/admin/refresh", (req, res) => { cache.clear(); res.json({ ok: true, message: "Cache cleared" }) })

// ── ROSTER ────────────────────────────────────────────────
app.get('/roster/:sport/:teamId', async (req, res) => {
  res.json([])
})

// ── HEALTH ────────────────────────────────────────────────
app.get("/health", async (req, res) => {
  res.json({
    status: "ok", version: "v14.1",
    github_ai: aiClient ? "✅" : "❌ add GITHUB_TOKEN",
    sportmonks: SM_KEY ? "✅ FULL PAID TIER" : "❌ add SPORTMONKS_API_KEY",
    odds_api: ODDS_KEY ? "✅" : "⚠️ optional",
    news_api: NEWS_KEY ? "✅" : "⚠️ optional",
    supabase: sb ? "✅" : "⚠️ optional",
    dixon_coles:    "✅ active",
kelly_criterion:"✅ active",
fatigue_model:  "✅ active",
referee_db:     refereeDB.size + " referees tracked",
elo_adjusted:   [...trophyBonus.entries()].length + " teams with live ELO drift",
form_decay:     "exponential (λ=0.72)",
prediction_model: "Dixon-Coles + Monte Carlo + per-team adaptive weights",
    clubelo: clubEloMap.size > 0 ? `✅ ${clubEloMap.size} teams` : "⚠️ loading...",
    team_weights: teamWeights.size + " teams tracked",
    sports: ["football","basketball (NBA)","american_football (NFL)","tennis","f1","boxing","mma"],
    port: PORT,
  })
})

app.get("/debug/sm", async (req, res) => {
  if (!SM_KEY) return res.json({ error: "No SM key" })
  const today = new Date().toISOString().slice(0, 10)
  const week  = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
  try {
    const r = await http(`${SM_BASE}/fixtures/between/${today}/${week}`, { api_token: SM_KEY, per_page: 3, include: "participants;league" })
    res.json({ fixtures: { count: r.data?.data?.length || 0, sample: r.data?.data?.slice(0,2).map(f=>({id:f.id,name:f.name,league:f.league?.name})) } })
  } catch(e) { res.json({ error: `${e.response?.status||e.code} ${e.message?.slice(0,50)}` }) }
})

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
    if (event.type === "checkout.session.completed") {
      const session = event.data.object, meta = session.metadata || {}
      const email = session.customer_email || session.customer_details?.email
      const custId = session.customer, subId = session.subscription
      if (meta.plan && sb) {
        const newPlan = meta.plan
        const newCredits = PLAN_CREDITS[newPlan] || 25
        // Find subscription by email
        const { data: existing } = await sb.from('users')
          .select('id').eq('email', email).single().catch(() => ({data:null}))
        if (existing) {
          await sb.from('users').update({
            plan: newPlan, plan_status: 'active',
            stripe_customer_id: custId, stripe_subscription_id: subId,
            credits_total: newCredits, credits_used: 0,
            credits_reset_at: new Date(Date.now() + 30*86400000).toISOString(),
            updated_at: new Date().toISOString()
          }).eq('id', existing.id)
          // Process referral if used
          if (meta.referral_code && meta.referrer_user_id) {
            try {
              await axios.post(`http://localhost:${PORT}/referral/confirm`, {
                code: meta.referral_code, referred_user_id: existing.user_id,
                referrer_user_id: meta.referrer_user_id
              })
            } catch(e2) {}
          }
          console.log(`✅ Plan upgraded: ${email} → ${newPlan}`)
        }
      }
    }

    if (event.type === "customer.subscription.deleted" || event.type === "customer.subscription.updated") {
      const sub = event.data.object
      const custId = sub.customer
      const status = sub.status === 'active' ? 'active' : 'cancelled'
      if (sb) {
        await sb.from('users').update({ plan_status: status, updated_at: new Date().toISOString() }).eq('stripe_customer_id', custId).catch(()=>{})
      }
    }

    res.json({ received: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})
app.get('/admin/stats', async (req, res) => {
  const adminKey = req.headers['x-admin-key'] || req.query.key
  if (process.env.ADMIN_KEY && adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  if (!sb) return res.status(503).json({ error: 'Supabase not configured' })
 
  try {
    // Only fetch users where regard = 'yes'
    const { data: users, error } = await sb
      .from('users')
      .select('*')
      .eq('regard', 'yes')
 
    if (error) return res.status(500).json({ error: error.message })
 
    const now = Date.now()
    const thirtyDaysAgo = new Date(now - 30 * 86400000).toISOString()
    const sevenDaysAgo  = new Date(now - 7 * 86400000).toISOString()
    const oneDayAgo     = new Date(now - 86400000).toISOString()
 
    // Plan breakdown (active subscriptions only)
    const planCounts = {}
    for (const plan of PLAN_HIERARCHY) {
      planCounts[plan] = users.filter(u => u.plan === plan && u.plan_status === 'active').length
    }
 
    // MRR calculation
    let mrr = 0
    const planRevenue = PLAN_HIERARCHY.map(plan => {
      const count = planCounts[plan] || 0
      const rev   = parseFloat((count * (PLAN_PRICES[plan] || 0)).toFixed(2))
      mrr += rev
      return { plan, count, mrr: rev, price: PLAN_PRICES[plan] || 0 }
    })
 
    // Churn — cancelled/expired
    const churned = users.filter(u => u.plan_status !== 'active' && u.plan !== 'free').length
 
    // Credits
    const creditsUsed  = users.reduce((s, u) => s + (u.credits_used  || 0), 0)
    const creditsBonus = users.reduce((s, u) => s + (u.credits_bonus || 0), 0)
    const creditsBurnt = users.filter(u => {
      const avail = (u.monthly_credits || 25) - (u.credits_used || 0) + (u.credits_bonus || 0)
      return avail <= 0
    }).length
 
    // Parlay stats
    const totalParlays = users.reduce((s, u) => s + (u.total_parlays || 0), 0)
    const wonParlays   = users.reduce((s, u) => s + (u.won_parlays   || 0), 0)
    const lostParlays  = users.reduce((s, u) => s + (u.lost_parlays  || 0), 0)
    const biggestWin   = Math.max(...users.map(u => parseFloat(u.biggest_win_odds || 0)))
 
    // Cohort metrics
    const newUsersLast30 = users.filter(u => (u.joined_at || '') > thirtyDaysAgo).length
    const newUsersLast7  = users.filter(u => (u.joined_at || '') > sevenDaysAgo).length
    const activeThisWeek = users.filter(u => (u.last_seen_at || '') > sevenDaysAgo).length
    const activeToday    = users.filter(u => (u.last_seen_at || '') > oneDayAgo).length
 
    // Referral stats
    const usersWithReferral = users.filter(u => u.referred_by).length
    const referralConvRate  = users.length > 0
      ? parseFloat((usersWithReferral / users.length * 100).toFixed(1)) : 0
 
    // Paid users
    const paidUsers = users.filter(u => u.plan !== 'free' && u.plan_status === 'active').length
    const convRate  = users.length > 0
      ? parseFloat((paidUsers / users.length * 100).toFixed(1)) : 0
 
    // Recent signups (last 10)
    const recentSignups = users
      .filter(u => u.joined_at)
      .sort((a, b) => new Date(b.joined_at) - new Date(a.joined_at))
      .slice(0, 10)
      .map(u => ({
        email:        u.email,
        plan:         u.plan,
        plan_status:  u.plan_status,
        joined_at:    u.joined_at,
        last_seen_at: u.last_seen_at,
        credits_used: u.credits_used,
        total_parlays:u.total_parlays,
      }))
 
    // Top users by biggest win odds
    const topWinners = users
      .filter(u => (u.biggest_win_odds || 0) > 0)
      .sort((a, b) => (b.biggest_win_odds || 0) - (a.biggest_win_odds || 0))
      .slice(0, 10)
      .map(u => ({
        email:           u.email,
        plan:            u.plan,
        biggest_win_odds:u.biggest_win_odds,
        total_parlays:   u.total_parlays,
        won_parlays:     u.won_parlays,
        streak_best:     u.streak_best,
      }))
 
    // Most active users by credits used
    const mostActive = users
      .sort((a, b) => (b.credits_used || 0) - (a.credits_used || 0))
      .slice(0, 10)
      .map(u => ({
        email:        u.email,
        plan:         u.plan,
        credits_used: u.credits_used,
        last_seen_at: u.last_seen_at,
        total_parlays:u.total_parlays,
      }))
 
    res.json({
      // Core counts
      totalUsers: users.length,
      paidUsers,
      freeUsers: users.filter(u => u.plan === 'free').length,
      churned,
      // Revenue
      mrr:        parseFloat(mrr.toFixed(2)),
      arr:        parseFloat((mrr * 12).toFixed(2)),
      planRevenue,
      planCounts,
      // Conversion
      conversionRate:     convRate,
      referralConvRate,
      usersWithReferral,
      // Credits
      creditsUsed,
      creditsBonus,
      usersOutOfCredits: creditsBurnt,
      // Parlay performance
      totalParlays,
      wonParlays,
      lostParlays,
      winRate: totalParlays > 0 ? parseFloat((wonParlays / totalParlays * 100).toFixed(1)) : 0,
      biggestWin,
      // Activity
      newUsersLast30,
      newUsersLast7,
      activeThisWeek,
      activeToday,
      // Lists
      recentSignups,
      topWinners,
      mostActive,
      // Meta
      generatedAt: new Date().toISOString(),
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})
 
// ── ADMIN USERS LIST ──────────────────────────────────────
app.get('/admin/users', async (req, res) => {
  const adminKey = req.headers['x-admin-key'] || req.query.key
  if (process.env.ADMIN_KEY && adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  if (!sb) return res.status(503).json({ error: 'No Supabase' })
  try {
    const { data, error } = await sb.from('users')
      .select('id,email,full_name,plan,plan_status,credits_used,credits_total,monthly_credits,total_parlays,won_parlays,biggest_win_odds,streak_best,joined_at,last_seen_at,regard')
      .eq('regard', 'yes')
      .order('joined_at', { ascending: false })
      .limit(500)
    if (error) return res.status(500).json({ error: error.message })
    res.json(data || [])
  } catch(e) { res.status(500).json({ error: e.message }) }
})
 
// ── ADMIN PLAN UPDATE ─────────────────────────────────────
app.post('/admin/user/plan', async (req, res) => {
  const adminKey = req.headers['x-admin-key']
  if (process.env.ADMIN_KEY && adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  if (!sb) return res.status(503).json({ error: 'No Supabase' })
  const { userId, plan } = req.body
  if (!userId || !plan) return res.status(400).json({ error: 'Missing fields' })
  const { error } = await sb.from('users').update({
    plan, plan_status: 'active',
    monthly_credits: PLAN_CREDITS[plan] || 25,
    credits_total:   PLAN_CREDITS[plan] || 25,
    credits_used: 0,
    updated_at: new Date().toISOString()
  }).eq('id', userId)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})
 
// ── STARTUP ───────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n╔═══════════════════════════════════════════════╗`)
  console.log(`║  ⚡  SLIP IQ  v14.1  ALL SPORTS               ║`)
  console.log(`║  Port ${PORT}  |  AI: ${AI_MODEL.split("/").pop().slice(0,18).padEnd(18)}   ║`)
  console.log(`╚═══════════════════════════════════════════════╝\n`)
  console.log(`GitHub AI:    ${aiClient ? "✅ " + AI_MODEL : "❌ Add GITHUB_TOKEN"}`)
  console.log(`Sportmonks:   ${SM_KEY   ? "✅ FULL PAID TIER" : "❌ Add SPORTMONKS_API_KEY"}`)
  console.log(`Odds API:     ${ODDS_KEY ? "✅" : "⚠️  Optional"}`)
  console.log(`News API:     ${NEWS_KEY ? "✅" : "⚠️  Optional"}`)
  console.log(`Supabase:     ${sb       ? "✅" : "⚠️  Optional"}\n`)

  await loadSupabase().catch(() => {})
  loadClubElo().catch(() => {})

  console.log("🔄 Pre-warming caches...")
  smFixtures(14).then(f => console.log(`✅ SM fixtures: ${f.length} loaded`)).catch(e => console.log("⚠️  SM warm:", e.message))
// Pre-warm predictions cache so first user gets fast response
setTimeout(() => warmPredictionsCache(), 5000)
setInterval(() => warmPredictionsCache(), 3600000)
  setTimeout(() => fetchNBAGames().catch(() => {}), 3000)
  setTimeout(() => fetchNFLGames().catch(() => {}), 5000)
  setTimeout(() => fetchTennisTournaments().catch(() => {}), 7000)
  setTimeout(() => fetchF1NextRace().catch(() => {}), 9000)
  setTimeout(() => { fetchOddsAPI().then(o => console.log(`✅ Odds API: ${Object.keys(o).length} matches`)).catch(() => {}) }, 11000)
  setTimeout(() => smPreMatchNews().catch(() => {}), 13000)
  setTimeout(() => autoPopulateSquads().catch(() => {}), 20000)
  setTimeout(() => syncNBAPlayerElos().catch(() => {}), 35000)
  setTimeout(async () => {
    await loadPlayerElos().catch(() => {})
    await syncFootballPlayerElos().catch(() => {})
  }, 45000)
  // Re-sync player ELOs every 6 hours
  setInterval(async () => {
    await syncFootballPlayerElos().catch(() => {})
    await syncNBAPlayerElos().catch(() => {})
  }, 6 * 3600000)

  await loadSportWeights().catch(() => {})
  await loadTeamWeights().catch(() => {})
  await loadManagerElos().catch(() => {})

  // ELO decay timer — mean reversion every 3 days
  setInterval(async () => {
    const now = Date.now()
    if (now - lastWeightUpdate < 3 * 86400000) return
    lastWeightUpdate = now
    for (const [sport, w] of Object.entries(sportWeights)) {
      const keys = Object.keys(w)
      const even = 1 / keys.length
      for (const k of keys) w[k] = w[k] * 0.97 + even * 0.03
      await persistWeights(sport, w).catch(() => {})
    }
    console.log('✅ ELO weights recalibrated')
  }, 6 * 3600000)

  console.log(`\n✅ Ready → http://localhost:${PORT}`)
  console.log(`🔬 Debug: GET /debug/sm | GET /health\n`)
})