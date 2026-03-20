// ============================================================
// SLIP IQ  —  server.js  v11.0  PRODUCTION
// CONFIRMED WORKING (from /debug/sm diagnostic):
//   ✅ Fixtures: /fixtures/between/{start}/{end}  (NO /date/)
//   ✅ Live scores: /livescores (no filter params)
//   ✅ Pre-match news, Predictions, Premium odds
//   ❌ Sidelined: 404 on this plan — DISABLED
//   ❌ Form URL /between/date/{p}/{t}/{id}: 404 — DISABLED
//   ❌ Team rankings: 403 — DISABLED
//   ❌ Squads/teams: 404 — DISABLED (background load removed)
// GitHub Models AI · Sportmonks v3 · The Odds API · Supabase
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

// ── GITHUB AI ─────────────────────────────────────────────
let OpenAI, aiClient
try {
  OpenAI = require("openai")
  if (process.env.GITHUB_TOKEN) {
    aiClient = new OpenAI({ baseURL: "https://models.github.ai/inference", apiKey: process.env.GITHUB_TOKEN })
    console.log("✅ GitHub AI ready — model:", process.env.MODEL_NAME || "openai/gpt-4o")
  } else { console.log("⚠️  GITHUB_TOKEN missing — AI disabled") }
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

const smAgent = new https.Agent({ keepAlive: true, maxSockets: 10, timeout: 35000, rejectUnauthorized: true })
const oddsAgent = new https.Agent({ keepAlive: false, timeout: 30000, rejectUnauthorized: true })

app.use(cors())
app.use(express.json({ limit: "15mb" }))
app.use(express.static(path.join(__dirname, "public")))

// ── ENV ───────────────────────────────────────────────────
const SM_KEY   = process.env.SPORTMONKS_API_KEY
const ODDS_KEY = process.env.ODDS_API_KEY
const NEWS_KEY = process.env.NEWS_API_KEY
// gpt-5 is not available on GitHub Models — use gpt-4o
const _rawModel = process.env.MODEL_NAME || "openai/gpt-4o"
const AI_MODEL = (_rawModel === "openai/gpt-5" || _rawModel === "gpt-5") ? "openai/gpt-4o" : _rawModel
const SM_BASE  = "https://api.sportmonks.com/v3/football"

// ── CACHE ─────────────────────────────────────────────────
const cache = new Map()
const TTL = { LIVE:15000, S:300000, M:900000, L:1800000, XL:21600000 }

async function cached(key, fetcher, ttl) {
  ttl = ttl || TTL.M
  const hit = cache.get(key)
  if (hit && Date.now() - hit.ts < ttl) return hit.data
  try {
    const data = await fetcher()
    cache.set(key, { data, ts: Date.now() })
    return data
  } catch(e) {
    if (hit) { console.log("  ↻ stale cache:", key); return hit.data }
    throw e
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── HTTP WITH RETRY ───────────────────────────────────────
async function http(url, params, hdrs, retries, agent) {
  params  = params  || {}
  hdrs    = hdrs    || {}
  retries = retries || 3
  const opts = {
    params, timeout: 30000,
    headers: { "Accept": "application/json", "Accept-Encoding": "gzip, deflate", "User-Agent": "SlipIQ/1.0", ...hdrs }
  }
  if (agent !== false) opts.httpsAgent = agent || smAgent

  for (let i = 1; i <= retries; i++) {
    try { return await axios.get(url, opts) }
    catch(e) {
      const code   = e.code || ""
      const status = e.response && e.response.status
      const body   = e.response && e.response.data ? JSON.stringify(e.response.data).slice(0, 300) : ""
      if (body) e._smBody = body
      const retry = ["ECONNRESET","ETIMEDOUT","ENOTFOUND","ECONNREFUSED","EPIPE","EAI_AGAIN","ECONNABORTED"].includes(code) || (status && status >= 500)
      if (retry && i < retries) { await sleep(1500 * Math.pow(2, i-1)); continue }
      throw e
    }
  }
}

function smErr(label, e) {
  const status = e.response && e.response.status
  const body   = e._smBody || (e.response && JSON.stringify(e.response.data || "").slice(0,200)) || e.message
  console.log(`  ❌ SM ${label}: ${status||e.code||e.message} ${body}`)
}

// ── IN-MEMORY STORES ──────────────────────────────────────
const teamDB   = new Map()
const playerDB = new Map()
const squadDB  = new Map()

// ── SUPABASE HELPERS ──────────────────────────────────────
function sbSaveTeam(row) { if (!sb) return; sb.from("team_ratings").upsert(row, { onConflict:"team_name" }).catch(() => {}) }
function sbSavePlayer(row) { if (!sb) return; sb.from("player_ratings").upsert(row, { onConflict:"player_name,team_name" }).catch(() => {}) }

async function loadSupabase() {
  if (!sb) { console.log("ℹ️  No Supabase — live API only"); return }
  try {
    const [tr, pr] = await Promise.all([
      sb.from("team_ratings").select("*"),
      sb.from("player_ratings").select("*").limit(100000)
    ])
    if (tr.data) for (const t of tr.data) teamDB.set(t.team_name, t)
    if (pr.data) {
      for (const p of pr.data) {
        playerDB.set(`${p.player_name}__${p.team_name}`, p)
        if (!squadDB.has(p.team_name)) squadDB.set(p.team_name, [])
        squadDB.get(p.team_name).push(p)
      }
    }
    console.log(`✅ Supabase: ${teamDB.size} teams, ${playerDB.size} players`)
  } catch(e) { console.log("⚠️  Supabase load:", e.message) }
}

// ══════════════════════════════════════════════════════════
//  SPORTMONKS v3 — FETCHERS
//  Based on confirmed working endpoints for this plan
// ══════════════════════════════════════════════════════════

// ── FIXTURES — CONFIRMED WORKING URL ─────────────────────
// /fixtures/between/{start}/{end}  ← works on this plan
// /fixtures/between/date/{start}/{end}  ← 422 on this plan
async function smFixtures(days) {
  days = days || 14
  if (!SM_KEY) { console.log("❌ No SPORTMONKS_API_KEY"); return [] }

  return cached("sm_fix_" + days, async () => {
    const now      = new Date()
    const end      = new Date(now.getTime() + days * 86400000)
    const startStr = now.toISOString().slice(0, 10)
    const endStr   = end.toISOString().slice(0, 10)
    const url      = `${SM_BASE}/fixtures/between/${startStr}/${endStr}`

    console.log(`📡 SM: fetching fixtures ${startStr} → ${endStr}`)

    // Full includes — NO filter params (they cause 400 on this plan)
    const fullIncludes = [
      "participants", "league", "league.country", "scores", "state",
      "odds", "predictions", "lineups.player", "lineups.details.type", "xGFixture"
    ].join(";")

    try {
      const r = await http(url, {
        api_token: SM_KEY,
        include:   fullIncludes,
        order: "asc", per_page: 50, page: 1
      })
      const data = (r.data && r.data.data) || []
      console.log(`  ✅ SM page 1: ${data.length} fixtures`)
      const results = [...data]

      // Paginate
      const pagination = r.data && r.data.pagination
      if (pagination && pagination.has_more) {
        let page = 2
        while (page <= 40 && results.length < 2000) {
          try {
            await sleep(200)
            const rp = await http(url, {
              api_token: SM_KEY, include: fullIncludes,
              order: "asc", per_page: 50, page
            })
            const pd = (rp.data && rp.data.data) || []
            results.push(...pd)
            console.log(`  ✅ SM page ${page}: +${pd.length} (total ${results.length})`)
            const p2 = rp.data && rp.data.pagination
            if (!p2 || !p2.has_more || pd.length < 50) break
            page++
          } catch(e) { break }
        }
      }
      console.log(`✅ SM: ${results.length} fixtures loaded`)
      return results
    } catch(e) {
      smErr("fixtures full", e)
      // Fallback: minimal includes
      try {
        const r2 = await http(url, {
          api_token: SM_KEY,
          include:   "participants;league;league.country;scores;state;odds;predictions",
          order: "asc", per_page: 50
        })
        const data2 = (r2.data && r2.data.data) || []
        console.log(`✅ SM: ${data2.length} fixtures (minimal includes)`)
        return data2
      } catch(e2) {
        smErr("fixtures minimal", e2)
        return []
      }
    }
  }, TTL.S)
}

// ── LIVE SCORES ───────────────────────────────────────────
// NOTE: no filter params — they cause 400 on this plan
async function smLive() {
  if (!SM_KEY) return []
  return cached("sm_live", async () => {
    try {
      // No filter params on livescores — they cause 400 on this plan
      const r = await http(`${SM_BASE}/livescores`, {
        api_token: SM_KEY,
        include:   "participants;league;league.country;scores;state;odds;predictions;xGFixture;lineups.player;lineups.details.type"
      })
      const data = (r.data && r.data.data) || []
      console.log(`✅ SM Live: ${data.length} matches`)
      return data
    } catch(e) { smErr("live", e); return [] }
  }, TTL.LIVE)
}

// ── H2H ───────────────────────────────────────────────────
async function smH2H(homeId, awayId) {
  if (!SM_KEY || !homeId || !awayId) return []
  return cached(`sm_h2h_${homeId}_${awayId}`, async () => {
    try {
      const r = await http(`${SM_BASE}/fixtures/head-to-head/${homeId}/${awayId}`, {
        api_token: SM_KEY, include: "participants;scores", order: "desc", per_page: 10
      })
      return ((r.data && r.data.data) || []).slice(0, 8).map(f => {
        const hP = (f.participants || []).find(p => p.meta && p.meta.location === "home")
        const aP = (f.participants || []).find(p => p.meta && p.meta.location === "away")
        const cH = (f.scores || []).find(s => s.participant_id === (hP && hP.id) && s.description === "CURRENT")
        const cA = (f.scores || []).find(s => s.participant_id === (aP && aP.id) && s.description === "CURRENT")
        const hg = cH && cH.score ? (cH.score.goals || 0) : 0
        const ag = cA && cA.score ? (cA.score.goals || 0) : 0
        const hn = hP ? hP.name : "?", an = aP ? aP.name : "?"
        return { date: f.starting_at ? f.starting_at.slice(0,10) : "", home: hn, away: an, homeGoals: hg, awayGoals: ag, winner: hg > ag ? hn : hg < ag ? an : "Draw" }
      })
    } catch(e) { return [] }
  }, TTL.L)
}

// ── VALUE BETS ────────────────────────────────────────────
async function smValueBets(fixtureId) {
  if (!SM_KEY || !fixtureId) return []
  return cached("sm_vb_" + fixtureId, async () => {
    try {
      const r = await http(`${SM_BASE}/predictions/value-bets/fixtures/${fixtureId}`, { api_token: SM_KEY, include: "type" })
      return ((r.data && r.data.data) || []).map(vb => ({
        bet: vb.predictions && vb.predictions.bet, bookmaker: vb.predictions && vb.predictions.bookmaker,
        odd: vb.predictions && vb.predictions.odd, fairOdd: vb.predictions && vb.predictions.fair_odd,
        isValue: vb.predictions && vb.predictions.is_value, market: vb.type && vb.type.name
      }))
    } catch(e) { return [] }
  }, TTL.M)
}

// ── PRE-MATCH NEWS ────────────────────────────────────────
async function smPreMatchNews() {
  if (!SM_KEY) return []
  return cached("sm_news", async () => {
    try {
      const r = await http(`${SM_BASE}/news/pre-match/upcoming`, { api_token: SM_KEY, include: "fixture;league", per_page: 30, order: "desc" })
      const news = (r.data && r.data.data) || []
      console.log(`✅ SM Pre-match News: ${news.length} articles`)
      return news.map(a => ({ title: a.title, body: a.body ? a.body.slice(0, 500) : "", fixtureId: a.fixture_id, leagueName: a.league && a.league.name, publishedAt: a.created_at }))
    } catch(e) { smErr("pre-match news", e); return [] }
  }, TTL.M)
}

// ── TEAM FORM — use fixtures endpoint filtered to team ─────
// NOTE: /between/date/{p}/{t}/{teamId} is 404 on this plan
// Use plain fixtures with participant filter instead
async function smTeamForm(teamId) {
  if (!SM_KEY || !teamId) return []
  return cached("sm_form_" + teamId, async () => {
    try {
      // Use past date range — plain between URL works
      const past  = new Date(Date.now() - 90 * 86400000).toISOString().slice(0,10)
      const today = new Date().toISOString().slice(0,10)
      const r = await http(`${SM_BASE}/fixtures/between/${past}/${today}`, {
        api_token: SM_KEY,
        include: "participants;scores",
        "filters[participants]": String(teamId),
        order: "desc", per_page: 10
      })
      const rows = ((r.data && r.data.data) || []).slice(0, 8)
      return rows.map(f => {
        const hP = (f.participants || []).find(p => p.meta && p.meta.location === "home")
        const aP = (f.participants || []).find(p => p.meta && p.meta.location === "away")
        const isHome = hP && hP.id === teamId
        const cH = (f.scores || []).find(s => s.participant_id === (hP && hP.id) && s.description === "CURRENT")
        const cA = (f.scores || []).find(s => s.participant_id === (aP && aP.id) && s.description === "CURRENT")
        const hg = cH && cH.score ? (cH.score.goals || 0) : 0
        const ag = cA && cA.score ? (cA.score.goals || 0) : 0
        const scored = isHome ? hg : ag, conc = isHome ? ag : hg
        return { result: scored > conc ? "W" : scored < conc ? "L" : "D", scored, conceded: conc, date: f.starting_at, opponent: isHome ? (aP && aP.name) : (hP && hP.name) }
      })
    } catch(e) { return [] }
  }, TTL.M)
}

// ══════════════════════════════════════════════════════════
//  THE ODDS API
//  Using oddsAgent (keepAlive: false) — prevents ECONNRESET
// ══════════════════════════════════════════════════════════
const ODDS_SPORTS = [
  { key:"soccer_epl",                    name:"Premier League" },
  { key:"soccer_spain_la_liga",          name:"La Liga" },
  { key:"soccer_italy_serie_a",          name:"Serie A" },
  { key:"soccer_germany_bundesliga",     name:"Bundesliga" },
  { key:"soccer_france_ligue_one",       name:"Ligue 1" },
  { key:"soccer_uefa_champs_league",     name:"Champions League" },
  { key:"soccer_uefa_europa_league",     name:"Europa League" },
  { key:"soccer_portugal_primeira_liga", name:"Primeira Liga" },
  { key:"soccer_netherlands_eredivisie", name:"Eredivisie" },
  { key:"soccer_brazil_campeonato",      name:"Brasileirão" }
]
const prevOddsStore = new Map()

async function fetchOddsAPI() {
  if (!ODDS_KEY) { console.log("ℹ️  No ODDS_API_KEY — real odds disabled"); return {} }
  return cached("odds_api", async () => {
    const map = {}
    let quotaLow = false

    for (const sport of ODDS_SPORTS) {
      if (quotaLow) break
      let attempt = 0, success = false
      while (attempt < 3 && !success) {
        attempt++
        try {
          const r = await axios.get(`https://api.the-odds-api.com/v4/sports/${sport.key}/odds`, {
            params: { apiKey: ODDS_KEY, regions: "eu", markets: "h2h,totals,btts", oddsFormat: "decimal" },
            timeout: 30000, httpsAgent: oddsAgent,
            headers: { "Accept": "application/json", "User-Agent": "SlipIQ/1.0", "Connection": "close" }
          })
          const rem = r.headers && r.headers["x-requests-remaining"]
          if (rem !== undefined && parseInt(rem) < 3) { quotaLow = true; break }
          const games = r.data || []
          for (const g of games) {
            const key = `${g.home_team}||${g.away_team}`
            const entry = { leagueName: sport.name, commenceTime: g.commence_time, home: null, draw: null, away: null, ou: {}, btts: {} }
            for (const book of (g.bookmakers || []).slice(0, 3)) {
              for (const mkt of (book.markets || [])) {
                if (mkt.key === "h2h" && !entry.home) {
                  const out = {}; for (const o of mkt.outcomes) out[o.name] = o.price
                  entry.home = out[g.home_team]; entry.draw = out["Draw"]; entry.away = out[g.away_team]
                }
                if (mkt.key === "totals") { for (const o of mkt.outcomes) { if (!entry.ou[o.point]) entry.ou[o.point] = {}; entry.ou[o.point][o.name.toLowerCase()] = o.price } }
                if (mkt.key === "btts") { for (const o of mkt.outcomes) entry.btts[o.name.toLowerCase()] = o.price }
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
          console.log(`  ✅ Odds ${sport.name}: ${games.length} games`)
          success = true; await sleep(700)
        } catch(e) {
          const code = e.code || "", status = e.response && e.response.status
          if (status === 401 || status === 402 || status === 422) { console.log(`  ❌ Odds API auth/quota: ${status}`); return map }
          if (attempt < 3 && ["ECONNRESET","ETIMEDOUT","ECONNABORTED","EPIPE"].includes(code)) { await sleep(2000 * attempt) }
          else { console.log(`  ⚠️  Odds ${sport.name}: ${code || status || e.message}`); break }
        }
      }
    }
    console.log(`✅ Odds API: ${Object.keys(map).length} total matches`)
    return map
  }, TTL.S)
}

function findOdds(oddsMap, home, away) {
  const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "")
  const hN = norm(home), aN = norm(away)
  for (const key of Object.keys(oddsMap)) {
    const [kh, ka] = key.split("||").map(norm)
    if ((hN.startsWith(kh.slice(0,5)) || kh.startsWith(hN.slice(0,5)) || hN === kh) &&
        (aN.startsWith(ka.slice(0,5)) || ka.startsWith(aN.slice(0,5)) || aN === ka)) return oddsMap[key]
  }
  return null
}

// ══════════════════════════════════════════════════════════
//  ELO ENGINE
// ══════════════════════════════════════════════════════════
const ELO_BASE = {
  "Arsenal":1980,"Liverpool":1900,"Manchester City":1850,"Chelsea":1820,"Manchester United":1810,
  "Tottenham Hotspur":1780,"Newcastle United":1740,"Aston Villa":1750,"Brighton":1710,
  "Nottingham Forest":1650,"West Ham United":1700,"Fulham":1630,"Brentford":1620,"Crystal Palace":1640,
  "Everton":1590,"Bournemouth":1610,"Wolverhampton Wanderers":1650,"Leicester City":1600,
  "Ipswich Town":1540,"Southampton":1520,"Real Madrid":1900,"Barcelona":1905,"Atletico Madrid":1870,
  "Sevilla":1760,"Athletic Club":1720,"Villarreal":1730,"Real Sociedad":1740,"Girona":1700,
  "Bayern Munich":1970,"Borussia Dortmund":1880,"RB Leipzig":1840,"Bayer Leverkusen":1900,
  "Eintracht Frankfurt":1750,"VfB Stuttgart":1690,"Inter Milan":1900,"Juventus":1860,"AC Milan":1870,
  "Napoli":1850,"Roma":1790,"Lazio":1770,"Atalanta":1820,"Fiorentina":1740,
  "Paris Saint-Germain":1930,"Monaco":1800,"Marseille":1770,"Lille":1760,"Nice":1720,
  "Benfica":1820,"Porto":1830,"Sporting CP":1810,"Ajax":1800,"PSV":1820,"Feyenoord":1790,
  "Celtic":1680,"Rangers":1660,"Galatasaray":1720,"Fenerbahce":1700,
  "Flamengo":1760,"Palmeiras":1750,"Atletico Mineiro":1730
}

function getElo(name) {
  const db = teamDB.get(name)
  if (db && db.scaled_score > 0) return Math.round(1300 + db.scaled_score * 7.5)
  if (db && db.elo > 1300) return db.elo
  if (ELO_BASE[name]) return ELO_BASE[name]
  const lo = name.toLowerCase()
  for (const k of Object.keys(ELO_BASE)) {
    const kl = k.toLowerCase()
    if (lo.slice(0,5) && (lo.startsWith(kl.slice(0,5)) || kl.startsWith(lo.slice(0,5)))) return ELO_BASE[k]
  }
  return 1500
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

const PLAYSTYLES = {
  GK: { name:"Sweeper Keeper", desc:"Commands area, builds play from back", icon:"🧤" },
  CB: { name:"Ball-Playing CB", desc:"Line-breaking passes, steps into midfield", icon:"⚽" },
  LB: { name:"Attack Fullback", desc:"Overlapping runs, dangerous in final third", icon:"🏃" },
  RB: { name:"Attack Fullback", desc:"Overlapping runs, dangerous in final third", icon:"🏃" },
  CDM:{ name:"Press Conductor", desc:"Sets press triggers, shields the back four", icon:"🔥" },
  CM: { name:"Box-to-Box", desc:"Covers ground, contributes in both phases", icon:"⚙️" },
  CAM:{ name:"Playmaker", desc:"Creates between lines, key passes, shooting", icon:"✨" },
  LW: { name:"Inverted Winger", desc:"Cuts inside onto stronger foot", icon:"↩️" },
  RW: { name:"Inverted Winger", desc:"Cuts inside onto stronger foot", icon:"↩️" },
  ST: { name:"Target Striker", desc:"Holds up play, aerial threat, clinical finisher", icon:"🎯" },
  LWB:{ name:"Wingback", desc:"Very advanced, creates wide overloads", icon:"🏃" },
  RWB:{ name:"Wingback", desc:"Very advanced, creates wide overloads", icon:"🏃" },
  RM: { name:"Wide Midfielder", desc:"Two-way wide contribution", icon:"📐" },
  LM: { name:"Wide Midfielder", desc:"Two-way wide contribution", icon:"📐" }
}

function clamp(v) { return Math.min(99, Math.max(20, v)) }

function buildPlayerAttrs(name, pos, pElo, tElo, rating) {
  const ef = (pElo - 1300) / 700
  const isAtk = ["ST","LW","RW","CAM"].includes(pos)
  const isDef = ["CB","LB","RB","CDM","GK"].includes(pos)
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
  while (weaknesses.length < 1) weaknesses.push("Inconsistent when team underperforms collectively")
  return { speed: spd, attack: atk, defense: def, bigMatch: bm, playstyle: ps, strengths: strengths.slice(0,3), weaknesses: weaknesses.slice(0,2), isKey: pElo > tElo + 55 }
}

const POS_ID_MAP = { 24:"GK",25:"CB",26:"CM",27:"ST",28:"LB",29:"RB",30:"CDM",31:"CAM",32:"LW",33:"RW",34:"RM",35:"LM",36:"LWB",37:"RWB" }
function mapPosId(id) { return POS_ID_MAP[id] || "CM" }

// ══════════════════════════════════════════════════════════
//  PREDICTION ENGINE
// ══════════════════════════════════════════════════════════
function formScore(f) {
  if (!f || !f.length) return 0.5
  const w = [0.35, 0.25, 0.20, 0.12, 0.08]
  return f.slice(0,5).reduce((s, r, i) => s + (r === "W" ? 1 : r === "D" ? 0.4 : 0) * (w[i] || 0.05), 0)
}

function calcXG(tElo, oElo, form, isHome, realXg) {
  if (realXg && realXg > 0) return realXg
  const ed = (tElo - oElo) / 400
  const fb = (formScore(form) - 0.5) * 0.1
  return Math.max(0.3, (isHome ? 1.45 : 1.10) + ed * 0.9 + fb + (isHome ? 0.18 : -0.05))
}

function calcPressureIndex(hElo, aElo, hForm, aForm) {
  const eloDiff = Math.abs(hElo - aElo)
  const formDiff = Math.abs(formScore(hForm) - formScore(aForm)) * 100
  const base = Math.min(100, Math.round((eloDiff/600)*30 + (formDiff/50)*25 + (Math.max(hElo,aElo)/2000)*30 + Math.random()*15))
  return Math.min(99, Math.max(20, base))
}

function poisson(lambda) { let L = Math.exp(-lambda), p = 1, k = 0; do { k++; p *= Math.random() } while (p > L); return k - 1 }
function monteCarlo(hxg, axg, n) { n = n || 50000; let h = 0, d = 0, a = 0; for (let i = 0; i < n; i++) { const hg = poisson(hxg), ag = poisson(axg); if (hg > ag) h++; else if (hg < ag) a++; else d++ } return { homeWin: h/n, draw: d/n, awayWin: a/n } }
function fact(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r }
function pcs(hxg, axg, h, a) { return (Math.exp(-hxg) * Math.pow(hxg,h) / fact(h)) * (Math.exp(-axg) * Math.pow(axg,a) / fact(a)) }
function detectValue(prob, odds) { if (!odds || odds < 1.05) return { isValue: false, edge: 0 }; const edge = prob - 100/odds; return { isValue: edge > 4, edge: parseFloat(edge.toFixed(2)) } }
// Normalise verbose Sportmonks league names to clean display names
function normLeague(raw) {
  if (!raw) return raw
  const map = {
    // England
    "English Premier League": "Premier League",
    "Premier League (England)": "Premier League",
    "Barclays Premier League": "Premier League",
    "Premier League": "Premier League",
    "EPL": "Premier League",
    "EFL Championship": "Championship",
    "EFL Cup": "Carabao Cup",
    "Football League Cup": "Carabao Cup",
    "Carabao Cup": "Carabao Cup",
    "FA Cup": "FA Cup",
    "English FA Cup": "FA Cup",
    "The FA Cup": "FA Cup",
    "EFL Trophy": "EFL Trophy",
    // Spain
    "Spanish La Liga": "La Liga",
    "La Liga Santander": "La Liga",
    "La Liga": "La Liga",
    "Primera Division": "La Liga",
    "LaLiga": "La Liga",
    "Copa del Rey": "Copa del Rey",
    // Italy
    "Italian Serie A": "Serie A",
    "Serie A": "Serie A",
    "Coppa Italia": "Coppa Italia",
    // Germany
    "German Bundesliga": "Bundesliga",
    "Bundesliga 1": "Bundesliga",
    "Bundesliga": "Bundesliga",
    "DFB Pokal": "DFB Pokal",
    "2. Bundesliga": "2. Bundesliga",
    // France
    "French Ligue 1": "Ligue 1",
    "Ligue 1 Uber Eats": "Ligue 1",
    "Ligue 1": "Ligue 1",
    "Coupe de France": "Coupe de France",
    // UEFA
    "UEFA Champions League": "Champions League",
    "UEFA Europa League": "Europa League",
    "UEFA Conference League": "Conference League",
    // Others
    "Scottish Premiership": "Scottish Premiership",
    "Eredivisie (Netherlands)": "Eredivisie",
    "Dutch Eredivisie": "Eredivisie",
    "Eredivisie": "Eredivisie",
    "Primeira Liga (Portugal)": "Primeira Liga",
    "Primeira Liga": "Primeira Liga",
    "Süper Lig": "Super Lig",
    "Turkish Süper Lig": "Super Lig",
    "Brazilian Serie A": "Brasileirão",
    "Campeonato Brasileiro Série A": "Brasileirão",
    "MLS (Major League Soccer)": "MLS",
    "Major League Soccer": "MLS",
    "Argentine Primera División": "Argentine Primera",
    "Liga Profesional Argentina": "Argentine Primera",
    "Belgian First Division A": "Belgian Pro League",
    "Jupiler Pro League": "Belgian Pro League",
    "Egyptian Premier League": "Egyptian PL",
    "Saudi Professional League": "Saudi Pro League",
    "Saudi Pro League": "Saudi Pro League",
    "J1 League": "J-League",
    "Allsvenskan": "Allsvenskan",
    "Ekstraklasa": "Ekstraklasa",
    "Eliteserien": "Eliteserien"
  }
  return map[raw] || raw
}
function leagueFlag(c) { const f={"England":"🏴󠁧󠁢󠁥󠁮󠁧󠁿","Spain":"🇪🇸","Italy":"🇮🇹","Germany":"🇩🇪","France":"🇫🇷","Portugal":"🇵🇹","Netherlands":"🇳🇱","Brazil":"🇧🇷","Argentina":"🇦🇷","Turkey":"🇹🇷","Scotland":"🏴󠁧󠁢󠁳󠁣󠁴󠁿","Belgium":"🇧🇪","World":"⭐","Europe":"⭐","Egypt":"🇪🇬"}; return f[c] || "⚽" }
function inferTactics(elo, form) { const fs = formScore(form); if (elo>1850) return fs>0.7?"High Press 4-3-3":"Structured 4-2-3-1"; if (elo>1700) return "Balanced 4-3-3"; if (elo>1600) return "Counter 4-4-2"; return "Defensive 5-3-2" }

function extractSMOdds(list) {
  const r = { home: null, draw: null, away: null, ou: {}, btts: {}, dc: {} }
  if (!list || !list.length) return r
  for (const o of list) {
    const mkt = o.market_id, lbl = (o.label || o.name || "").toLowerCase(), val = parseFloat(o.value || o.dp3 || "0")
    if (!val || val < 1.01) continue
    if (mkt === 1) { if (lbl==="1"||lbl==="home") r.home=val; else if (lbl==="x"||lbl==="draw") r.draw=val; else if (lbl==="2"||lbl==="away") r.away=val }
    if (mkt === 14) { if (lbl==="yes") r.btts.yes=val; else if (lbl==="no") r.btts.no=val }
    if (mkt === 2) { if (lbl.includes("1x")||lbl.includes("home or draw")) r.dc.homeOrDraw=val; else if (lbl.includes("x2")||lbl.includes("away or draw")) r.dc.awayOrDraw=val; else if (lbl.includes("12")||lbl.includes("home or away")) r.dc.homeOrAway=val }
    if (mkt === 18) { const m=lbl.match(/(over|under)\s*([\d.]+)/i); if(m){ if(!r.ou[m[2]])r.ou[m[2]]={};r.ou[m[2]][m[1].toLowerCase()]=val } }
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
  const entry = xgData.find(x => x.participant_id === teamId && x.type_id === 5304)
  return entry && entry.data ? entry.data.value : null
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
      over:  (realOdds?.ou?.[k]?.over)  || (smOdds?.ou?.[k]?.over)  || parseFloat(Math.max(1.02, 1/Math.max(0.01,oPct/100)*1.06).toFixed(2)),
      under: (realOdds?.ou?.[k]?.under) || (smOdds?.ou?.[k]?.under) || parseFloat(Math.max(1.02, 1/Math.max(0.01,(100-oPct)/100)*1.06).toFixed(2))
    }
  }
  const bttsY = Math.round((1 - Math.exp(-hxg)) * (1 - Math.exp(-axg)) * 100)
  const bttsOdds = { yes: realOdds?.btts?.yes || smOdds?.btts?.yes || parseFloat((1/Math.max(0.01,bttsY/100)*1.06).toFixed(2)), no: realOdds?.btts?.no || smOdds?.btts?.no || parseFloat((1/Math.max(0.01,(100-bttsY)/100)*1.06).toFixed(2)) }
  const smH = smPred?.FULLTIME_RESULT_PROBABILITY?.home, smD = smPred?.FULLTIME_RESULT_PROBABILITY?.draw, smA = smPred?.FULLTIME_RESULT_PROBABILITY?.away
  const useSM = smH && smD && smA
  const homeProb = Math.round(useSM ? parseFloat(smH) : probs.homeWin * 100)
  const drawProb = Math.round(useSM ? parseFloat(smD) : probs.draw * 100)
  const awayProb = Math.round(useSM ? parseFloat(smA) : probs.awayWin * 100)
  const over25  = smPred?.OVER_UNDER_2_5_PROBABILITY?.yes ?? ouProbs[2.5].overPct
  const bttsFin = smPred?.BTTS_PROBABILITY?.yes ?? bttsY
  const cs = []
  for (let ch = 0; ch <= 5; ch++) for (let ca = 0; ca <= 5; ca++) cs.push({ score: `${ch}-${ca}`, prob: Math.round(pcs(hxg,axg,ch,ca)*1000)/10 })
  cs.sort((a,b) => b.prob - a.prob)
  return { homeProb, drawProb, awayProb, ouProbs, ouOdds, bttsYesPct: Math.round(Number(bttsFin)), bttsNoPct: 100-Math.round(Number(bttsFin)), bttsOdds, over25Prob: Math.round(Number(over25)), correctScores: cs.slice(0,9), hxg: parseFloat(hxg.toFixed(2)), axg: parseFloat(axg.toFixed(2)) }
}

function buildFactors(hElo, aElo, hForm, aForm, hxg, axg, smPred, pressureIndex) {
  const hfs = formScore(hForm)*100, afs = formScore(aForm)*100, ed = hElo - aElo
  const smH = smPred?.FULLTIME_RESULT_PROBABILITY?.home, smA = smPred?.FULLTIME_RESULT_PROBABILITY?.away
  const n = v => Math.min(99, Math.max(1, Math.round(v)))
  return [
    { name:"ELO RATING",       homeScore:n(hElo/20),      awayScore:n(aElo/20),                                                       color:"#00d4ff" },
    { name:"RECENT FORM",      homeScore:n(hfs),           awayScore:n(afs),                                                           color:"#00ff88" },
    { name:"xG ATTACK",        homeScore:n(hxg*35),        awayScore:n(axg*35),                                                        color:"#ff3b5c" },
    { name:"DEFENSIVE SHAPE",  homeScore:n(50+ed/40),      awayScore:n(50-ed/40),                                                      color:"#ffd700" },
    { name:"HOME ADVANTAGE",   homeScore:65,               awayScore:35,                                                               color:"#ff8c42" },
    { name:"SM AI PREDICTION", homeScore:smH?n(parseFloat(smH)):n(50+ed/30), awayScore:smA?n(parseFloat(smA)):n(50-ed/30),             color:"#cc88ff" },
    { name:"PRESS INTENSITY",  homeScore:n(pressureIndex), awayScore:n(100-pressureIndex),                                             color:"#44ddaa" },
    { name:"SQUAD DEPTH",      homeScore:n(50+ed/60),      awayScore:n(50-ed/60),                                                      color:"#ffaa44" },
    { name:"MOMENTUM",         homeScore:n(hfs*1.1),       awayScore:n(afs*1.1),                                                       color:"#ff6688" },
    { name:"TACTICAL FIT",     homeScore:n(50+ed/45),      awayScore:n(50-ed/45),                                                      color:"#4488ff" }
  ]
}

// ══════════════════════════════════════════════════════════
//  CORE PREDICTION BUILDER
// ══════════════════════════════════════════════════════════
async function buildPrediction(smFix, oddsMap) {
  const now   = Date.now()
  const pArr  = smFix.participants || []
  const homeP = pArr.find(p => p.meta && p.meta.location === "home") || {}
  const awayP = pArr.find(p => p.meta && p.meta.location === "away") || {}
  const home  = homeP.name || (smFix.name && smFix.name.split(" vs ")[0]) || "Home"
  const away  = awayP.name || (smFix.name && smFix.name.split(" vs ")[1]) || "Away"
  const homeId = homeP.id, awayId = awayP.id
  const rawLeagueName = (smFix.league && smFix.league.name) || "Football"
  const country = (smFix.league && smFix.league.country && smFix.league.country.name) || ""
  // Fix: Sportmonks sometimes returns "Premier League" for Egyptian PL — disambiguate by country
  let league = normLeague(rawLeagueName)
  if (country === "Egypt" && (league === "Premier League" || rawLeagueName.toLowerCase().includes("premier"))) {
    league = "Egyptian PL"
  }
  if (country === "Egypt" || rawLeagueName.toLowerCase().includes("egyptian")) {
    league = "Egyptian PL"
  }
  const kickMs  = smFix.starting_at_timestamp ? smFix.starting_at_timestamp * 1000 : new Date(smFix.starting_at || 0).getTime()
  const isLive  = kickMs < now && kickMs > now - 7200000

  // Odds
  const smOdds        = extractSMOdds(smFix.odds || [])
  const realOddsEntry = findOdds(oddsMap, home, away)
  if (realOddsEntry) {
    if (!smOdds.home) smOdds.home = realOddsEntry.home
    if (!smOdds.draw) smOdds.draw = realOddsEntry.draw
    if (!smOdds.away) smOdds.away = realOddsEntry.away
    if (!Object.keys(smOdds.ou).length && realOddsEntry.ou && Object.keys(realOddsEntry.ou).length) smOdds.ou = realOddsEntry.ou
    if (!smOdds.btts.yes && realOddsEntry.btts?.yes) smOdds.btts = realOddsEntry.btts
  }
  const hasRealOdds = !!(smOdds.home && smOdds.draw && smOdds.away)

  // SM Predictions
  const smPred = smFix.predictions ? extractSMPreds(smFix.predictions) : {}

  // Real xG
  const xgData = smFix.xGFixture || smFix.expected || []
  const homeRealXG = extractRealXG(xgData, homeId)
  const awayRealXG = extractRealXG(xgData, awayId)
  const hasRealXG  = !!(homeRealXG || awayRealXG)

  // ELO from Supabase/hardcoded (team rankings 403 on this plan)
  let hElo = getElo(home), aElo = getElo(away)

  // Form from trends in fixture data (no extra API call needed)
  let hForm = [], aForm = []
  if (smFix.trends) {
    const parseTrend = (ts, id) => {
      const t = (ts || []).find(x => x.participant_id === id)
      const fStr = (t && (t.form || t.value)) || ""
      return String(fStr).split("").slice(0,5).map(c => c==="W"?"W":c==="D"?"D":"L")
    }
    hForm = parseTrend(smFix.trends, homeId)
    aForm = parseTrend(smFix.trends, awayId)
  }
  // Only fetch form if not in fixture data — using the working between URL
  if (!hForm.length && homeId) hForm = await smTeamForm(homeId).then(f => f.map(x => x.result)).catch(() => [])
  if (!aForm.length && awayId) aForm = await smTeamForm(awayId).then(f => f.map(x => x.result)).catch(() => [])

  const pressureIndex = calcPressureIndex(hElo, aElo, hForm, aForm)
  const hxg = calcXG(hElo, aElo, hForm, true, homeRealXG)
  const axg = calcXG(aElo, hElo, aForm, false, awayRealXG)
  const markets = buildAllMarkets(hxg, axg, smOdds, smPred, realOddsEntry)
  const { homeProb, drawProb, awayProb } = markets

  const homeOdds = smOdds.home || parseFloat((1/Math.max(0.01,homeProb/100)*1.06).toFixed(2))
  const drawOdds = smOdds.draw || parseFloat((1/Math.max(0.01,drawProb/100)*1.06).toFixed(2))
  const awayOdds = smOdds.away || parseFloat((1/Math.max(0.01,awayProb/100)*1.06).toFixed(2))
  const confidence = Math.min(99, Math.max(homeProb, drawProb, awayProb))

  const hVal = detectValue(homeProb, homeOdds)
  const dVal = detectValue(drawProb, drawOdds)
  const aVal = detectValue(awayProb, awayOdds)

  // H2H and value bets in parallel (sidelined/coaches 404 on this plan)
  const [h2h, smVB] = await Promise.all([
    smH2H(homeId, awayId).catch(() => []),
    smValueBets(smFix.id).catch(() => [])
  ])

  // Referees from fixture include
  let referees = []
  if (smFix.referees && Array.isArray(smFix.referees)) {
    referees = smFix.referees.map(r => ({ name: (r.referee && (r.referee.display_name || r.referee.name)) || "Unknown", imagePath: r.referee && r.referee.image_path }))
  }

  // Lineups from fixture include
  const lus = smFix.lineups || []
  const buildLu = (tId, tName, tElo) => lus.filter(l => l.team_id === tId).slice(0,11).map((l, idx) => {
    const pos   = mapPosId(l.position_id) || "CM"
    const pName = l.player_name || (l.player && (l.player.display_name || l.player.name)) || "Unknown"
    const db    = playerDB.get(`${pName}__${tName}`)
    let playerXG = null
    if (l.xglineup && Array.isArray(l.xglineup)) { const xe = l.xglineup.find(x => x.type_id === 5304); if (xe && xe.data) playerXG = xe.data.value }
    const pElo  = (db && db.elo) || buildPlayerElo(pName, pos, tElo, null, 0, 0)
    const attrs = db || buildPlayerAttrs(pName, pos, pElo, tElo, null)
    return { number: l.jersey_number || idx+1, name: pName, position: pos, elo: pElo, xg: playerXG, isKey: (attrs && attrs.is_key) || false, speed: (attrs && attrs.speed)||60, attack: (attrs && attrs.attack)||60, defense: (attrs && attrs.defense)||60, bigMatch: (attrs && (attrs.bigMatch||attrs.big_match))||60, playstyle: (attrs && attrs.playstyle) || PLAYSTYLES[pos] || PLAYSTYLES.CM, strengths: (attrs && attrs.strengths)||[], weaknesses: (attrs && attrs.weaknesses)||[], imagePath: l.player && l.player.image_path }
  })

  // Score
  let score = null
  if (smFix.scores && smFix.scores.length) {
    const cH = smFix.scores.find(s => s.participant_id === homeId && s.description === "CURRENT")
    const cA = smFix.scores.find(s => s.participant_id === awayId && s.description === "CURRENT")
    if (cH || cA) score = `${(cH?.score?.goals)||0}-${(cA?.score?.goals)||0}`
  }

  // Venue
  const venue = smFix.venue ? { name: smFix.venue.name, city: smFix.venue.city_name, capacity: smFix.venue.capacity } : null

  return {
    id: smFix.id, smId: smFix.id, homeId, awayId,
    leagueId: smFix.league_id, seasonId: smFix.season_id,
    home, away, league, leagueName: league, flag: leagueFlag(country), country,
    date: smFix.starting_at, isLive, isFinished: smFix.state_id === 5, score, minute: null, venue,
    homeProb, drawProb, awayProb,
    homeOdds: parseFloat(homeOdds.toFixed(2)), drawOdds: parseFloat(drawOdds.toFixed(2)), awayOdds: parseFloat(awayOdds.toFixed(2)),
    homeMove: realOddsEntry?.homeMove || 0, drawMove: realOddsEntry?.drawMove || 0, awayMove: realOddsEntry?.awayMove || 0,
    homeMovement: realOddsEntry?.homeMove || 0, drawMovement: realOddsEntry?.drawMove || 0, awayMovement: realOddsEntry?.awayMove || 0,
    hasRealOdds, confidence,
    upsetProb: Math.min(95, Math.round(awayProb * 0.8 + (homeOdds < 1.6 ? 15 : 5))),
    isUpsetWatch: awayProb > 28 && homeOdds > 1.5,
    valueBet: hVal.isValue || dVal.isValue || aVal.isValue || smVB.some(v => v.isValue),
    homeValueEdge: hVal.edge, drawValueEdge: dVal.edge, awayValueEdge: aVal.edge,
    bestValueSide: hVal.isValue ? "home" : dVal.isValue ? "draw" : aVal.isValue ? "away" : null,
    smValueBets: smVB.slice(0,3),
    homeElo: hElo, awayElo: aElo, homeSmRank: null, awaySmRank: null,
    homeForm: hForm.slice(0,5), awayForm: aForm.slice(0,5),
    homeXg: parseFloat(hxg.toFixed(2)), awayXg: parseFloat(axg.toFixed(2)),
    homeXga: parseFloat((axg*0.9).toFixed(2)), awayXga: parseFloat((hxg*0.9).toFixed(2)),
    hasRealXG, homeRealXG, awayRealXG, pressureIndex,
    homeTactics: inferTactics(hElo, hForm), awayTactics: inferTactics(aElo, aForm),
    homeFormation: "4-3-3", awayFormation: "4-3-3",
    homeLineup: buildLu(homeId, home, hElo), awayLineup: buildLu(awayId, away, aElo),
    matchups: [], h2h,
    factors: buildFactors(hElo, aElo, hForm, aForm, hxg, axg, smPred, pressureIndex),
    injuries: { home: [], away: [] },  // sidelined endpoint 404 on this plan
    coaches: { home: null, away: null },
    referees, fixtureNews: [],
    smPredictions: smPred, markets,
    bttsProb: markets.bttsYesPct, over25Prob: markets.over25Prob,
    ouProbs: markets.ouProbs, ouOdds: markets.ouOdds, bttsOdds: markets.bttsOdds, correctScores: markets.correctScores,
    bookmaker: realOddsEntry ? "Real Odds" : hasRealOdds ? "Sportmonks" : "Model",
    imageHome: homeP.image_path, imageAway: awayP.image_path
  }
}

// ══════════════════════════════════════════════════════════
//  GITHUB AI
// ══════════════════════════════════════════════════════════
const SYS_PROMPT = "You are an elite sports analytics AI with deep expertise in football tactics, statistics, and betting markets. ALWAYS respond ONLY with valid JSON. No markdown, no preamble."

async function callAI(userPrompt, maxTokens) {
  maxTokens = maxTokens || 1400
  if (!aiClient) return { error: "GitHub AI not configured" }
  try {
    const response = await aiClient.chat.completions.create({ model: AI_MODEL, max_tokens: maxTokens, messages: [{ role:"system", content:SYS_PROMPT }, { role:"user", content:userPrompt }] })
    let raw = response.choices?.[0]?.message?.content || "{}"
    raw = raw.replace(/```json\n?|```\n?/g, "").trim()
    const jStart = raw.indexOf("{"), jEnd = raw.lastIndexOf("}") + 1
    if (jStart >= 0) raw = raw.slice(jStart, jEnd)
    return JSON.parse(raw)
  } catch(e) { console.log("❌ AI:", e.message?.slice(0,80)); return { error: "AI failed", detail: e.message?.slice(0,80) } }
}

// ══════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════

app.get("/predictions", async (req, res) => {
  try {
    const days = parseInt(req.query.days || "14")
    console.log(`\n📊 /predictions (${days} days)`)
    const [smList, oddsMap, liveList] = await Promise.all([
      smFixtures(days).catch(e => { console.log("⚠️  smFixtures:", e.message); return [] }),
      fetchOddsAPI().catch(e => { console.log("⚠️  fetchOddsAPI:", e.message); return {} }),
      smLive().catch(() => [])
    ])
    const all = new Map()
    for (const f of [...smList, ...liveList]) all.set(f.id, f)
    const fixtures = [...all.values()].slice(0, 250)
    console.log(`⚙️  Building predictions for ${fixtures.length} fixtures...`)
    const results = []
    const BATCH = 5
    for (let b = 0; b < fixtures.length; b += BATCH) {
      const bRes = await Promise.all(fixtures.slice(b, b+BATCH).map(f => buildPrediction(f, oddsMap).catch(e => { console.log(`⚠️  fix#${f.id}:`, e.message?.slice(0,50)); return null })))
      results.push(...bRes.filter(Boolean))
      if (b + BATCH < fixtures.length) await sleep(60)
    }
    console.log(`✅ ${results.length} predictions ready`)
    // Sort: top leagues first (by importance), then by date within league
    const LEAGUE_RANK = {
      "Champions League":1,"Premier League":2,"La Liga":3,"Serie A":4,"Bundesliga":5,
      "Ligue 1":6,"Europa League":7,"FA Cup":8,"Carabao Cup":9,"Copa del Rey":10,
      "Coppa Italia":11,"DFB Pokal":12,"Conference League":13,"Championship":14,
      "Eredivisie":15,"Primeira Liga":16,"Super Lig":17,"Scottish Premiership":18,
      "Brasileirão":19,"Argentine Primera":20,"Belgian Pro League":21,
      "MLS":22,"Saudi Pro League":23,"J-League":24,"Allsvenskan":25,"Ekstraklasa":26,
      "2. Bundesliga":27,"Coupe de France":28,"EFL Trophy":29
    }
    const leagueRankOf = name => LEAGUE_RANK[name] || 99
    res.json(results.sort((a,b) => {
      const rankDiff = leagueRankOf(a.league) - leagueRankOf(b.league)
      if (rankDiff !== 0) return rankDiff
      return new Date(a.date) - new Date(b.date)
    }))
  } catch(e) { console.error("❌ /predictions:", e.message); res.status(500).json({ error: e.message }) }
})

app.get("/livescores", async (req, res) => {
  try {
    const live = await smLive()
    const oddsMap = await fetchOddsAPI().catch(() => ({}))
    const results = await Promise.all(live.map(f => buildPrediction(f, oddsMap).catch(() => null)))
    res.json(results.filter(Boolean))
  } catch(e) { res.json([]) }
})

app.get("/news", async (req, res) => {
  try {
    const { team, league, match } = req.query
    const smNews = await smPreMatchNews().catch(() => [])
    let newsData = []
    if (NEWS_KEY) {
      const q = team || league || match
        ? `football ${[team, league, match].filter(Boolean).join(" ")} injury transfer`
        : "football premier league champions league la liga injury transfer"
      newsData = await cached("newsapi_" + (q.slice(0,30)), async () => {
        const r = await axios.get("https://newsapi.org/v2/everything", {
          params: { q, language:"en", sortBy:"publishedAt", pageSize:30, apiKey:NEWS_KEY },
          timeout: 15000
        })
        return (r.data.articles || []).map(a => ({
          title: a.title, source: a.source?.name, publishedAt: a.publishedAt, url: a.url,
          description: a.description, urlToImage: a.urlToImage
        }))
      }, TTL.M).catch(() => [])
    }
    // Filter SM news by team/league/match if query provided
    let filtered = smNews
    if (team) filtered = filtered.filter(a => (a.leagueName||"").toLowerCase().includes(team.toLowerCase()) || (a.body||"").toLowerCase().includes(team.toLowerCase()) || (a.title||"").toLowerCase().includes(team.toLowerCase()))
    if (league) filtered = filtered.filter(a => (a.leagueName||"").toLowerCase().includes(league.toLowerCase()))
    res.json([...filtered.slice(0,20), ...newsData.slice(0,15)])
  } catch(e) { res.json([]) }
})


// ── NEWS IMPACT ANALYSIS ──────────────────────────────────
app.post("/news/analyze", async (req, res) => {
  const { article, predictions } = req.body
  if (!article) return res.json({ error: "No article provided" })
  try {
    const topMatches = (predictions || []).slice(0, 20).map(m => `${m.home} vs ${m.away}(${m.league})`).join(", ")
    const prompt = `You are a football betting analyst. Analyze this news article and its impact on upcoming matches and betting markets.

Article Title: ${article.title || ""}
Article Body: ${(article.body || article.description || "").slice(0, 800)}
League: ${article.leagueName || article.source || "Football"}
Upcoming matches: ${topMatches || "Various"}

Return JSON with these exact keys:
{
  "summary": "2-sentence summary of the news",
  "impactLevel": "HIGH|MEDIUM|LOW|NONE",
  "marketImpact": "how this affects betting markets (odds movement, value)",
  "recommendation": "specific betting action for punters based on this news",
  "eloImpact": "any implied team ELO changes (injuries, suspensions, form)",
  "keyInsight": "the single most important insight for bettors",
  "impactTeams": ["team1", "team2"],
  "affectedMarkets": ["1x2", "BTTS", "Over/Under"]
}`
    res.json(await callAI(prompt, 600))
  } catch(e) { res.json({ error: "Analysis failed" }) }
})

app.get("/players/:team", (req, res) => {
  const team = decodeURIComponent(req.params.team)
  res.json([...playerDB.values()].filter(p => p.team_name === team))
})

app.get("/squad/:teamId/:teamName/:seasonId", async (req, res) => {
  try { res.json(await smSquadFallback(parseInt(req.params.teamId), decodeURIComponent(req.params.teamName))) } catch(e) { res.json([]) }
})
app.get("/squad/:teamId/:teamName", async (req, res) => {
  try { res.json(await smSquadFallback(parseInt(req.params.teamId), decodeURIComponent(req.params.teamName))) } catch(e) { res.json([]) }
})

// Squad endpoint returns from playerDB (populated by Supabase) — squads/teams 404 on this plan
async function smSquadFallback(teamId, teamName) {
  const fromDB = squadDB.get(teamName) || []
  if (fromDB.length) return fromDB
  return []
}

app.post("/analyze", async (req, res) => {
  const { match, type } = req.body
  try {
    let prompt = ""
    if (type === "match") {
      const m = match
      const smSum  = m.smPredictions ? Object.entries(m.smPredictions).slice(0,6).map(([k,v]) => `${k}:${JSON.stringify(v)}`).join(" | ") : "none"
      const smVBs  = (m.smValueBets||[]).filter(v => v.isValue).map(v => `${v.market}:${v.bet}@${v.odd}`).join(",") || "none"
      const hKeys  = (squadDB.get(m.home)||[]).filter(p=>p.is_key).map(p=>`${p.player_name}(${p.position},ELO${p.elo},${p.goals_this_season||0}g)`).slice(0,5).join(",") || "unknown"
      const aKeys  = (squadDB.get(m.away)||[]).filter(p=>p.is_key).map(p=>`${p.player_name}(${p.position},ELO${p.elo},${p.goals_this_season||0}g)`).slice(0,5).join(",") || "unknown"
      const h2hStr = (m.h2h||[]).slice(0,5).map(h=>`${h.homeGoals}-${h.awayGoals}(${h.winner==="Draw"?"D":h.winner===m.home?"H":"A"})`).join(",") || "N/A"
      const xgNote = m.hasRealXG ? "REAL SM xG" : "MODEL xG"
      prompt = `Match: ${m.home} vs ${m.away} | ${m.league} | ${m.date?.slice(0,10)}
ELO: H${m.homeElo} A${m.awayElo}
Probs: H${m.homeProb}% D${m.drawProb}% A${m.awayProb}%
SM Predictions: ${smSum}
SM Value Bets: ${smVBs}
xG (${xgNote}): H${m.homeXg} A${m.awayXg} | xGA: H${m.homeXga} A${m.awayXga}
Form: ${m.home}:${(m.homeForm||[]).join("")} | ${m.away}:${(m.awayForm||[]).join("")}
Odds: H${m.homeOdds} D${m.drawOdds} A${m.awayOdds} (${m.hasRealOdds?"REAL BOOKMAKER":"model"})
BTTS: ${m.bttsProb}% | Over2.5: ${m.over25Prob}%
Pressure Index: ${m.pressureIndex}/100
Key HOME: ${hKeys} | Key AWAY: ${aKeys}
H2H last 5: ${h2hStr}
Return JSON: {"mainAnalysis":"3-4 sentences","recommendation":"Home Win|Draw|Away Win|No Value","oneLineSummary":"sharp punchy line","keyFactors":["5 factors"],"valueAssessment":"edge vs bookmaker","bttsAnalysis":"BTTS insight","goalsMarket":"best goals market","newsImpact":"","matchFacts":["3 facts"],"playerWatch":"key player","coachingEdge":"tactical edge","confidenceRating":${m.confidence}}`
    } else if (type === "upset") {
      const m = match
      const aKeys = (squadDB.get(m.away)||[]).filter(p=>p.is_key).map(p=>`${p.player_name}(${p.goals_this_season||0}g)`).slice(0,4).join(",") || "unknown"
      prompt = `Upset: ${m.home}(ELO${m.homeElo},form:${(m.homeForm||[]).join("")}) vs ${m.away}(ELO${m.awayElo},odds:${m.awayOdds})\nAway keys: ${aKeys}\nH2H: ${(m.h2h||[]).slice(0,3).map(h=>`${h.homeGoals}-${h.awayGoals}`).join(",")}\nReturn JSON: {"upsetReasons":["4 reasons"],"upsetTrigger":"one scenario","worthBacking":true,"upsetConfidence":${m.awayProb},"keyVulnerability":"biggest home weakness"}`
    } else if (type === "parlay") {
      const legs = Array.isArray(match) ? match : [match]
      const co = legs.reduce((p,l) => p*l.odds, 1).toFixed(2)
      prompt = `${legs.length}-leg parlay:\n${legs.map((l,i) => `${i+1}. ${l.matchName}: ${l.label}@${l.odds}(${l.prob}%)`).join("\n")}\nCombined: ${co}x\nReturn JSON: {"assessment":"2-3 sentences","hasValue":true,"valueExplanation":"edge reasoning","weakestLeg":"name+reason","strongestLeg":"name+reason","suggestedSwap":"improvement","overallRating":70,"keyRisks":["2 risks"]}`
    } else if (type === "player") {
      const { player: pl, team: tn } = match
      prompt = `Scout: ${pl.name}(${pl.position}) at ${tn}. ELO:${pl.elo}\nStats: ${pl.goals_this_season||0}G ${pl.assists_this_season||0}A in ${pl.appearances||0} apps\nSpeed:${pl.speed} Atk:${pl.attack} Def:${pl.defense} BigMatch:${pl.bigMatch}\nReturn JSON: {"profile":"2-3 sentences","strengths":["3"],"weaknesses":["2"],"bigMatchRating":${pl.bigMatch||60},"tacticalRole":"role","bestAgainst":"type","worstAgainst":"type","similarTo":"real player"}`
    } else if (type === "matchup") {
      const { homePlayer: hp, awayPlayer: ap } = match
      prompt = `1v1: ${hp?.name}(${hp?.position},ELO${hp?.elo}) vs ${ap?.name}(${ap?.position},ELO${ap?.elo}) in ${match.match?.home} vs ${match.match?.away}\nReturn JSON: {"analysis":"2-3 sentences","advantage":"home|away|even","keyFactor":"deciding factor","impactOnGame":"game impact","mismatchHighlight":"key mismatch or empty"}`
    }
    res.json(await callAI(prompt))
  } catch(e) { res.json({ error:"Analysis failed", detail:e.message?.slice(0,80) }) }
})

app.post("/parlay/auto", async (req, res) => {
  const { predictions=[], targetOdds=4.0, riskLevel=5, minLegs=2, maxLegs=8, preferredMarkets=["auto"], timeframeDays=14, leagueFilter=null } = req.body
  if (!predictions.length) return res.json({ parlay:[], combinedOdds:1, error:"No predictions" })
  const now = Date.now(), maxMs = timeframeDays * 86400000
  const pool = predictions.filter(m => !m.isLive && !m.isFinished && (!m.date || new Date(m.date).getTime()-now<=maxMs) && (!leagueFilter?.length || leagueFilter.includes(m.league)))
  if (!pool.length) return res.json({ parlay:[], combinedOdds:1, notEnoughMatches:"No matches match filters" })
  const candidates = [], mkts = Array.isArray(preferredMarkets) ? preferredMarkets : ["auto"]
  for (const m of pool) {
    const addPick = (pick, label, odds, prob, market) => {
      if (!odds || odds < 1.04 || !prob || prob < 1) return
      const edge = prob - 100/odds
      const score = (prob*0.55) + (edge*2.5) + ((10-riskLevel)*0.8) + (m.hasRealOdds?6:0) + (m.smValueBets?.some(v=>v.isValue)?4:0)
      candidates.push({ matchId:m.id, pick, label, odds:parseFloat(odds.toFixed(2)), prob:Math.round(prob), matchName:`${m.home} vs ${m.away}`, league:m.league, confidence:m.confidence, hasRealOdds:m.hasRealOdds, market, score, edge:parseFloat(edge.toFixed(2)) })
    }
    for (const mkt of mkts) {
      if (mkt==="1x2"||mkt==="auto"||mkt==="h2h") { addPick("home",`${m.home} Win`,m.homeOdds,m.homeProb,"1x2"); addPick("draw","Draw",m.drawOdds,m.drawProb,"1x2"); addPick("away",`${m.away} Win`,m.awayOdds,m.awayProb,"1x2") }
      if (mkt==="btts"||mkt==="auto") { if(m.bttsOdds?.yes)addPick("btts_yes","Both Teams Score",m.bttsOdds.yes,m.bttsProb,"btts"); if(m.bttsOdds?.no)addPick("btts_no","No BTTS",m.bttsOdds.no,100-m.bttsProb,"btts") }
      for (const pts of [0.5,1.5,2.5,3.5,4.5,5.5]) {
        if (mkt===`ou_${pts}`||mkt==="auto") {
          const ou=m.ouOdds?.[pts], prb=m.ouProbs?.[pts]
          if(ou&&prb){if(ou.over&&prb.overPct)addPick(`over_${pts}`,`Over ${pts} Goals`,ou.over,prb.overPct,`ou_${pts}`);if(ou.under&&prb.underPct>35)addPick(`under_${pts}`,`Under ${pts} Goals`,ou.under,prb.underPct,`ou_${pts}`)}
        }
      }
    }
  }
  candidates.sort((a,b) => b.score - a.score)
  const used = new Set(), selected = []
  const minConf = 30 + (10-riskLevel)*3
  let co = 1.0
  for (const c of candidates) {
    if (used.has(c.matchId) || c.prob < minConf) continue
    if (selected.length >= maxLegs || (co >= targetOdds && selected.length >= minLegs)) break
    selected.push(c); used.add(c.matchId); co *= c.odds
  }
  if (!selected.length) return res.json({ parlay:[], combinedOdds:1, notEnoughMatches:"No picks meet criteria." })
  const combProb = selected.reduce((p,s) => p*(s.prob/100), 1)*100
  const avgConf  = selected.reduce((s,c) => s+c.prob, 0)/selected.length
  const score    = Math.max(10, Math.min(99, Math.round(avgConf - Math.max(0,(selected.length-3)*5) + (10-riskLevel)*2)))
  res.json({ parlay:selected, combinedOdds:parseFloat(co.toFixed(2)), combinedProb:parseFloat(combProb.toFixed(2)), targetOdds:parseFloat(String(targetOdds)), hitTarget:co>=targetOdds*0.92, score, marketBreakdown:[...new Set(selected.map(s=>s.market))], message:co<targetOdds*0.92?`Reached ${co.toFixed(2)}x vs target ${targetOdds}x — lower target or add legs`:null })
})

// ── SAVED PARLAYS (full storage with AI analysis) ────────
// ── NEWS SEARCH ───────────────────────────────────────────
app.get("/news/search", async (req, res) => {
  const { team, league, matchId } = req.query
  try {
    const allNews = await smPreMatchNews().catch(() => [])
    let filtered = [...allNews]
    if (team) filtered = filtered.filter(a =>
      (a.title||"").toLowerCase().includes(team.toLowerCase()) ||
      (a.body||"").toLowerCase().includes(team.toLowerCase()))
    if (league) filtered = filtered.filter(a =>
      (a.leagueName||"").toLowerCase().includes(league.toLowerCase()))
    if (matchId) filtered = filtered.filter(a => String(a.fixtureId) === String(matchId))
    res.json(filtered.slice(0, 40))
  } catch(e) { res.json([]) }
})

app.post("/parlays/save", async (req, res) => {
  if (!sb) return res.status(503).json({ error: "Supabase not configured" })
  const { user_id, legs, combined_odds, confidence_score, ai_analysis, risk_label, target_odds, market_mix, leg_count } = req.body
  if (!user_id || !legs?.length) return res.status(400).json({ error: "Missing fields" })
  const { data, error } = await sb.from("saved_parlays").insert({
    user_id, legs: JSON.stringify(legs), combined_odds, confidence_score,
    ai_analysis: ai_analysis || null, risk_label: risk_label || "MEDIUM",
    target_odds: target_odds || combined_odds, market_mix: market_mix || "mixed",
    leg_count: leg_count || legs.length, status: "pending",
    created_at: new Date().toISOString()
  }).select().single()
  if (error) {
    // table may not exist yet — return ok anyway so UX doesn't break
    console.log("⚠️  parlays/save:", error.message)
    return res.json({ ok: true, local_only: true, data: { id: Date.now(), legs, combined_odds, confidence_score } })
  }
  res.json({ ok: true, data })
})

app.get("/parlays/:userId", async (req, res) => {
  if (!sb) return res.json([])
  const { data, error } = await sb.from("saved_parlays").select("*")
    .eq("user_id", req.params.userId).order("created_at", { ascending: false }).limit(100)
  res.json(error ? [] : (data || []).map(p => ({
    ...p,
    legs: typeof p.legs === "string" ? JSON.parse(p.legs) : p.legs
  })))
})

app.patch("/parlays/:parlayId/result", async (req, res) => {
  if (!sb) return res.json({ ok: false })
  const { hits, status } = req.body
  const { data, error } = await sb.from("saved_parlays").update({ hits_count: hits, status: status || "settled" })
    .eq("id", req.params.parlayId).select().single()
  res.json(error ? { ok: false } : { ok: true, data })
})

// ── SAVED SLIPS ───────────────────────────────────────────
app.post("/slips", async (req, res) => {
  if (!sb) return res.status(503).json({ error:"Supabase not configured" })
  const { user_id, legs, combined_odds, confidence_score, sport } = req.body
  if (!user_id || !legs?.length) return res.status(400).json({ error:"Missing fields" })
  const { data, error } = await sb.from("saved_slips").insert({ user_id, legs, combined_odds, confidence_score, status:"pending", sport:sport||"football", created_at:new Date().toISOString() }).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})
app.get("/slips/:userId", async (req, res) => {
  if (!sb) return res.json([])
  const { data, error } = await sb.from("saved_slips").select("*").eq("user_id", req.params.userId).order("created_at",{ascending:false}).limit(50)
  res.json(error ? [] : data)
})
// ============================================================
// SLIP IQ — NEW SERVER ROUTES TO PASTE
// ============================================================
// WHERE TO PASTE:
//   Open server.js, find the line:
//     // ── HEALTH ────────────────────────────────────────────────
//   Paste ALL of the code below IMMEDIATELY ABOVE that line.
// ============================================================

// ── USER PROFILE ──────────────────────────────────────────
app.get("/profile/:userId", async (req, res) => {
  if (!sb) return res.json({ error: "Supabase not configured" })
  const { userId } = req.params

  // Fetch or auto-create profile
  let { data: profile, error } = await sb
    .from("user_profiles").select("*").eq("id", userId).single()

  if (!profile) {
    // Auto-create on first visit
    const { data: created } = await sb.from("user_profiles").insert({
      id: userId, display_name: "Bettor", plan: "free",
      joined_at: new Date().toISOString(), last_seen_at: new Date().toISOString()
    }).select().single()
    profile = created || { id: userId, plan: "free", total_parlays: 0 }
  } else {
    // Update last_seen
    await sb.from("user_profiles").update({ last_seen_at: new Date().toISOString() }).eq("id", userId)
  }

  // Fetch parlay stats
  const { data: parlays } = await sb.from("saved_parlays").select("status, combined_odds, confidence_score, leg_count, created_at")
    .eq("user_id", userId).order("created_at", { ascending: false }).limit(200)

  const allParlays = parlays || []
  const won   = allParlays.filter(p => p.status === "won").length
  const lost  = allParlays.filter(p => p.status === "lost").length
  const pending = allParlays.filter(p => p.status === "pending").length
  const biggestOdds = allParlays.reduce((max, p) => Math.max(max, p.combined_odds || 0), 0)
  const avgConf = allParlays.length ? Math.round(allParlays.reduce((s,p) => s + (p.confidence_score||0), 0) / allParlays.length) : 0
  const winRate = (won + lost) > 0 ? Math.round(won / (won + lost) * 100) : 0

  // Fetch referral code
  const { data: refCode } = await sb.from("user_referral_codes").select("*, user_referral_uses(count)").eq("user_id", userId).single()

  // Fetch active plan grants
  const { data: grants } = await sb.from("plan_grants").select("*")
    .eq("user_id", userId).eq("is_active", true).gte("expires_at", new Date().toISOString())

  res.json({
    ...profile,
    stats: { total: allParlays.length, won, lost, pending, winRate, biggestOdds, avgConf,
      totalLegs: allParlays.reduce((s,p) => s + (p.leg_count||0), 0) },
    referralCode: refCode || null,
    activeGrants: grants || [],
    recentParlays: allParlays.slice(0, 10)
  })
})

app.patch("/profile/:userId", async (req, res) => {
  if (!sb) return res.json({ error: "Supabase not configured" })
  const allowed = ["display_name", "email", "avatar_url"]
  const updates = {}
  for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k]
  updates.updated_at = new Date().toISOString()
  const { data, error } = await sb.from("user_profiles").update(updates).eq("id", req.params.userId).select().single()
  res.json(error ? { error: error.message } : { ok: true, data })
})

// ── USER REFERRAL CODE (personal, 3-refer = 3mo pro) ─────
app.post("/profile/:userId/referral-code", async (req, res) => {
  if (!sb) return res.status(503).json({ error: "Supabase not configured" })
  const { userId } = req.params

  // Check if they already have one
  const { data: existing } = await sb.from("user_referral_codes").select("*").eq("user_id", userId).single()
  if (existing) return res.json({ ok: true, code: existing, already_existed: true })

  // Get profile for display name
  const { data: profile } = await sb.from("user_profiles").select("display_name").eq("id", userId).single()
  const base = ((profile?.display_name || "USER").toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,6)).padEnd(3,"X")
  const suffix = Math.floor(100 + Math.random() * 9000)
  const code = base + suffix

  const { data, error } = await sb.from("user_referral_codes").insert({
    user_id: userId, code, uses_count: 0, max_uses: 100,
    reward_plan: "pro", reward_months: 3, threshold: 3, is_active: true,
    created_at: new Date().toISOString()
  }).select().single()

  if (error) return res.status(500).json({ error: error.message })

  // Save code on profile too
  await sb.from("user_profiles").update({ referral_code: code }).eq("id", userId)
  res.json({ ok: true, code: data })
})

// Apply someone's referral code when they sign up / first visit
app.post("/referral/apply", async (req, res) => {
  if (!sb) return res.status(503).json({ error: "Supabase not configured" })
  const { code, user_id, email } = req.body
  if (!code || !user_id) return res.status(400).json({ error: "code and user_id required" })

  // Validate code
  const { data: rc } = await sb.from("user_referral_codes").select("*").eq("code", code.toUpperCase()).eq("is_active", true).single()
  if (!rc) return res.status(404).json({ error: "Code not found or inactive" })
  if (rc.user_id === user_id) return res.status(400).json({ error: "Cannot use your own code" })

  // Check not already used by this user
  const { data: existing } = await sb.from("user_referral_uses").select("id").eq("code", code.toUpperCase()).eq("referred_user_id", user_id).single()
  if (existing) return res.json({ ok: true, already_applied: true })

  // Record the use
  await sb.from("user_referral_uses").insert({
    code: code.toUpperCase(), referrer_user_id: rc.user_id,
    referred_user_id: user_id, referred_email: email || null,
    joined_at: new Date().toISOString(), reward_granted: false
  })

  // Increment counter
  const newCount = (rc.uses_count || 0) + 1
  await sb.from("user_referral_codes").update({ uses_count: newCount }).eq("id", rc.id)

  // Mark code on referred user profile
  await sb.from("user_profiles").upsert({
    id: user_id, referred_by_code: code.toUpperCase(),
    last_seen_at: new Date().toISOString()
  }, { onConflict: "id" })

  // Check if threshold hit → grant reward
  let rewardGranted = false
  if (newCount > 0 && newCount % rc.threshold === 0) {
    const expiresAt = new Date(Date.now() + rc.reward_months * 30 * 86400000).toISOString()
    await sb.from("plan_grants").insert({
      user_id: rc.user_id, plan: rc.reward_plan, months: rc.reward_months,
      reason: "referral_reward", expires_at: expiresAt, is_active: true, granted_at: new Date().toISOString()
    })
    await sb.from("user_profiles").update({ plan: rc.reward_plan, plan_expires_at: expiresAt }).eq("id", rc.user_id)
    rewardGranted = true
  }

  res.json({ ok: true, uses_count: newCount, threshold: rc.threshold, reward_granted: rewardGranted,
    needs_more: rc.threshold - (newCount % rc.threshold === 0 ? rc.threshold : newCount % rc.threshold) })
})

// Get referral status for a user (how close they are to reward)
app.get("/profile/:userId/referral-status", async (req, res) => {
  if (!sb) return res.json({ error: "Supabase not configured" })
  const { data: rc } = await sb.from("user_referral_codes").select("*").eq("user_id", req.params.userId).single()
  if (!rc) return res.json({ code: null, uses: 0, threshold: 3, needs: 3 })
  const { data: uses } = await sb.from("user_referral_uses").select("*").eq("code", rc.code).order("joined_at", { ascending: false })
  const { data: grants } = await sb.from("plan_grants").select("*").eq("user_id", req.params.userId).eq("reason", "referral_reward").order("granted_at", { ascending: false })
  res.json({ code: rc, uses: uses || [], grants: grants || [],
    uses_count: rc.uses_count, threshold: rc.threshold,
    needs_more: rc.threshold - (rc.uses_count % rc.threshold || rc.threshold),
    total_rewards_earned: Math.floor(rc.uses_count / rc.threshold) })
})
// ── REFERRAL ──────────────────────────────────────────────
app.post("/referral/generate", async (req, res) => {
  if (!sb) return res.status(503).json({ error:"Supabase not configured" })
  const { affiliate_name, affiliate_email, type } = req.body
  if (!affiliate_name) return res.status(400).json({ error:"affiliate_name required" })
  const suffix = Math.floor(100 + Math.random() * 900)
  const code   = affiliate_name.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,6) + suffix
  const row    = { code, type:type||"affiliate", affiliate_name, affiliate_email:affiliate_email||null, discount_pct:25, first_month_commission_pct:25, recurring_commission_pct:10, is_active:true, total_uses:0, created_at:new Date().toISOString() }
  const { data, error } = await sb.from("referral_codes").insert(row).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})
app.get("/referral/codes", async (req, res) => { if (!sb) return res.json([]); const { data } = await sb.from("referral_codes").select("*, referral_uses(count)").order("created_at",{ascending:false}); res.json(data||[]) })
app.get("/referral/uses",  async (req, res) => { if (!sb) return res.json([]); const { data } = await sb.from("referral_uses").select("*, referral_codes(code,affiliate_name,type)").order("created_at",{ascending:false}).limit(500); res.json(data||[]) })
app.post("/referral/use", async (req, res) => {
  if (!sb) return res.status(503).json({ error:"Supabase not configured" })
  const { code, referred_user_email, referred_user_id, subscription_plan } = req.body
  if (!code) return res.status(400).json({ error:"code required" })
  const { data: rc } = await sb.from("referral_codes").select("*").eq("code",code).eq("is_active",true).single()
  if (!rc) return res.status(404).json({ error:"Code not found or inactive" })
  const planPrices = { starter:2.99, basic:4.99, pro:14.99, elite:49.99 }
  const price = planPrices[subscription_plan] || 0
  await sb.from("referral_uses").insert({ code, referred_user_email, referred_user_id, referrer_user_id:rc.user_id||null, subscription_plan, first_month_revenue:price, first_month_commission:price*(rc.first_month_commission_pct||25)/100, status:"active", created_at:new Date().toISOString() })
  res.json({ ok:true, discount_pct:rc.discount_pct, code })
})
app.get("/admin/affiliates", async (req, res) => {
  if (!sb) return res.json([])
  const { data } = await sb.from("referral_codes").select("*").eq("type","affiliate").order("total_uses",{ascending:false})
  const codes = data || []
  for (const c of codes) {
    const { data: uses } = await sb.from("referral_uses").select("*").eq("code",c.code)
    c.uses = uses||[]; c.total_revenue=(uses||[]).reduce((s,u)=>s+(u.first_month_revenue||0),0); c.total_commission=(uses||[]).reduce((s,u)=>s+(u.first_month_commission||0),0)
    c.tier_breakdown={}; for (const u of uses||[]) c.tier_breakdown[u.subscription_plan||"unknown"]=(c.tier_breakdown[u.subscription_plan||"unknown"]||0)+1
  }
  res.json(codes)
})

// ── HEALTH ────────────────────────────────────────────────
app.get("/health", async (req, res) => {
  const odds = await fetchOddsAPI().catch(() => ({}))
  res.json({ status:"ok", version:"v11.0", model:AI_MODEL, github_ai:aiClient?"✅":"❌", sportmonks:SM_KEY?"✅":"❌", odds_api:ODDS_KEY?"✅":"⚠️", news_api:NEWS_KEY?"✅":"⚠️", supabase:sb?"✅":"⚠️", realOddsMatches:Object.keys(odds).length, cachedTeams:teamDB.size, cachedPlayers:playerDB.size, cacheEntries:cache.size, port:PORT })
})

// ── DEBUG ─────────────────────────────────────────────────
app.get("/debug/sm", async (req, res) => {
  if (!SM_KEY) return res.json({ error:"No SM key" })
  const results = {}, today = new Date().toISOString().slice(0,10), week = new Date(Date.now()+7*86400000).toISOString().slice(0,10)
  for (const [label, url] of [
    ["between (works)", `${SM_BASE}/fixtures/between/${today}/${week}`],
    ["between/date (test)", `${SM_BASE}/fixtures/between/date/${today}/${week}`]
  ]) {
    try {
      const r = await http(url, { api_token: SM_KEY, per_page: 3, order: "asc" })
      results[label] = { count: r.data?.data?.length || 0, sample: r.data?.data?.slice(0,1).map(f=>({id:f.id,name:f.name,date:f.starting_at})) }
    } catch(e) { results[label + "_error"] = `${e.response?.status||e.code} ${e._smBody||e.message}` }
  }
  try { const r = await http(`${SM_BASE}/leagues`, { api_token: SM_KEY, per_page: 5 }); results.leagues_count = r.data?.data?.length || 0 } catch(e) { results.leagues_error = e.message }
  try { const r = await http(`${SM_BASE}/predictions/probabilities`, { api_token: SM_KEY, per_page: 1 }); results.predictions = (r.data?.data?.length||0)>0 } catch(e) { results.predictions_error = e.message }
  try { const r = await http(`${SM_BASE}/livescores`, { api_token: SM_KEY, per_page: 1 }); results.live_count = r.data?.data?.length||0 } catch(e) { results.livescores_error = e.message }
  res.json(results)
})

app.get("/debug/fixtures/:days", async (req, res) => {
  const days = parseInt(req.params.days) || 7
  cache.delete("sm_fix_" + days)
  const fixtures = await smFixtures(days).catch(e => ({ error: e.message }))
  if (Array.isArray(fixtures)) res.json({ count: fixtures.length, sample: fixtures.slice(0,3).map(f=>({id:f.id,name:f.name,date:f.starting_at,state_id:f.state_id,league:f.league?.name})) })
  else res.json(fixtures)
})

app.get("/admin/sql",  (req, res) => res.json({ note:"See supabase_schema.sql for schema" }))
app.post("/admin/refresh", (req, res) => { cache.clear(); res.json({ ok:true, message:"Cache cleared" }) })

// ══════════════════════════════════════════════════════════
//  STARTUP
// ══════════════════════════════════════════════════════════
app.listen(PORT, async () => {
  console.log(`\n╔═══════════════════════════════════════════════╗`)
  console.log(`║  ⚽  SLIP IQ  v11.0  PRODUCTION               ║`)
  console.log(`║  Port ${PORT}  |  AI: ${AI_MODEL.split("/").pop().slice(0,18).padEnd(18)}   ║`)
  console.log(`╚═══════════════════════════════════════════════╝\n`)
  console.log(`GitHub AI:    ${aiClient ? "✅ "+AI_MODEL : "❌ Add GITHUB_TOKEN"}`)
  console.log(`Sportmonks:   ${SM_KEY ? "✅" : "❌ Add SPORTMONKS_API_KEY"}`)
  console.log(`Odds API:     ${ODDS_KEY ? "✅" : "⚠️  Optional"}`)
  console.log(`News API:     ${NEWS_KEY ? "✅" : "⚠️  Optional"}`)
  console.log(`Supabase:     ${sb ? "✅" : "⚠️  Optional"}\n`)
  console.log(`✅ Plan-confirmed working endpoints:`)
  console.log(`   ✓ Fixtures:   /fixtures/between/{start}/{end}`)
  console.log(`   ✓ Live:       /livescores (no filter params)`)
  console.log(`   ✓ H2H:        /fixtures/head-to-head/{id}/{id}`)
  console.log(`   ✓ Predictions, Premium Odds, Pre-match News`)
  console.log(`   ✗ Sidelined, Squads, Team Rankings: 404/403 on this plan\n`)

  await loadSupabase().catch(() => {})

  console.log("🔄 Pre-warming caches...")
  smFixtures(14).then(f => console.log(`✅ SM fixtures: ${f.length} loaded`)).catch(e => console.log("⚠️  SM warm:", e.message))
  setTimeout(() => { fetchOddsAPI().then(o => console.log(`✅ Odds API: ${Object.keys(o).length} matches`)).catch(e => console.log("⚠️  Odds:", e.message)) }, 4000)
  setTimeout(() => { smPreMatchNews().catch(() => {}) }, 7000)

  console.log(`\n✅ Server ready → http://localhost:${PORT}`)
  console.log(`🔬 Diagnostics: GET /debug/sm`)
  console.log(`📅 Test:        GET /debug/fixtures/7`)
  console.log(`🔄 Clear cache: POST /admin/refresh\n`)
})