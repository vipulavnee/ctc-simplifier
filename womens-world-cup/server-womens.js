const express = require("express");
const cors = require("cors");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || process.env.WOMENS_PORT || 3001;
const CACHE_TTL_MS = 15000;
let matchCache = { data: null, fetchedAt: 0 };
let matchFetchPromise = null;

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
  next();
});

app.use(express.static(path.join(__dirname, "public"), {
  etag: false,
  lastModified: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, private");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
  }
}));

const WOMENS_WORLD_CUP_TEAMS = {
  ausw: "Australia Women", banw: "Bangladesh Women", engw: "England Women",
  indw: "India Women", irew: "Ireland Women", nzw: "New Zealand Women",
  nedw: "Netherlands Women", pakw: "Pakistan Women", scow: "Scotland Women",
  rsaw: "South Africa Women", slw: "Sri Lanka Women", wiw: "West Indies Women"
};

const TEAM_SHORT = {
  "Australia Women": "AUSW", "Bangladesh Women": "BANW",
  "England Women": "ENGW", "India Women": "INDW", "Ireland Women": "IREW",
  "New Zealand Women": "NZW", "Netherlands Women": "NEDW",
  "Pakistan Women": "PAKW", "Scotland Women": "SCOW",
  "South Africa Women": "RSAW", "Sri Lanka Women": "SLW",
  "West Indies Women": "WIW"
};

const ALL_SHORTS = Object.values(TEAM_SHORT);

function clean(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function oversToDecimal(oversText) {
  const text = clean(oversText).replace(/ov/i, "").replace(/[()]/g, "").trim();

  if (!text) return null;

  const parts = text.split(".");
  const overs = parseInt(parts[0] || "0", 10);
  const balls = parts.length > 1 ? parseInt(parts[1] || "0", 10) : 0;

  if (Number.isNaN(overs) || Number.isNaN(balls)) return null;

  return overs + balls / 6;
}

function calculateRR(scoreText, oversText) {
  const runsMatch = clean(scoreText).match(/(\d+)/);
  const runs = runsMatch ? parseInt(runsMatch[1], 10) : null;
  const overs = oversToDecimal(oversText);

  if (runs === null || !overs || overs <= 0) return "";

  return (runs / overs).toFixed(2);
}

function inferCompletedResult(teams, scores) {
  const rows = (teams || []).map(team => {
    const short = getTeamShort(team);
    const score = (scores || []).find(row => clean(row.team).toUpperCase() === short);
    const runs = parseInt(String(score?.score || "").match(/\d+/)?.[0] || "NaN", 10);
    const wickets = parseInt(String(score?.score || "").match(/\/(\d+)/)?.[1] || "0", 10);
    return { team, score, runs, wickets, overs: oversToDecimal(score?.overs) };
  }).filter(row => Number.isFinite(row.runs));

  if (rows.length < 2) return "Match complete";
  if (rows[0].runs === rows[1].runs) return "Match tied";

  const winner = rows[0].runs > rows[1].runs ? rows[0] : rows[1];
  const loser = winner === rows[0] ? rows[1] : rows[0];
  const likelyChase = Number.isFinite(winner.overs) && winner.overs < 20 &&
    Number.isFinite(loser.overs) && loser.overs >= 20;

  return likelyChase
    ? `${winner.team} won by ${Math.max(10 - winner.wickets, 0)} wickets`
    : `${winner.team} won by ${winner.runs - loser.runs} runs`;
}



function isValidScoreCandidate(runs, wickets, overs) {
  const r = parseInt(runs, 10);
  const w = parseInt(wickets, 10);
  const o = oversToDecimal(overs);

  if (Number.isNaN(r) || Number.isNaN(w)) return false;
  if (w < 0 || w > 10) return false;
  if (overs && (o === null || o < 0 || o > 20)) return false;

  return true;
}

function getMatchId(url) {
  const parts = String(url || "").split("/").filter(Boolean);
  return parts.find(part => /^\d+$/.test(part)) || url;
}

function getSlug(url) {
  const parts = String(url || "").split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function parseTeams(slug) {
  const lower = String(slug || "").toLowerCase();
  const match = lower.match(/^([a-z]+)-vs-([a-z]+)/);

  if (!match) return [];

  const first = WOMENS_WORLD_CUP_TEAMS[match[1]];
  const second = WOMENS_WORLD_CUP_TEAMS[match[2]];

  return [first, second].filter(Boolean);
}

function getTeamShort(teamName) {
  return TEAM_SHORT[teamName] || clean(teamName).toUpperCase();
}

function isWomensT20WorldCup(slug, teams) {
  const lower = String(slug || "").toLowerCase();

  return (
    teams.length === 2 && lower.includes("women") && lower.includes("world-cup")
  );
}

function getMatchName(teams, slug) {
  if (teams.length >= 2) return `${teams[0]} vs ${teams[1]}`;

  return slug
    .replace(/-\d+(st|nd|rd|th)-match.*/i, "")
    .split("-")
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

async function fetchHtml(url) {
  const finalUrl = `${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`;

  const response = await axios.get(finalUrl, {
    timeout: 18000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.cricbuzz.com/",
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  });

  return response.data;
}

function extractStatus(titleText, detailText) {
  const title = clean(titleText);
  const detail = clean(detailText);

  const titleParts = title.split(" - ");
  const titleStatus = titleParts.length >= 2
    ? clean(titleParts.slice(1).join(" - "))
    : "";

  if (titleStatus && !/^(complete|completed)$/i.test(titleStatus)) {
    return titleStatus;
  }

  const usefulPatterns = [
    /[A-Z]{2,5}\s+opt to bat/i,
    /[A-Z]{2,5}\s+opt to bowl/i,
    /[A-Z]{2,5}\s+chose to bat/i,
    /[A-Z]{2,5}\s+chose to bowl/i,
    /[A-Z]{2,5}\s+elected to bat/i,
    /[A-Z]{2,5}\s+elected to bowl/i,
    /[A-Za-z ]+\s+need\s+\d+\s+runs?\s+in\s+\d+\s+balls?/i,
    /Need\s+\d+\s+off\s+\d+b/i,
    /[A-Za-z ]+\s+won\s+by\s+\d+\s+(?:runs?|wkts?|wickets?)/i,
    /[A-Z]{2,5}\s+won/i,
    /Match starts[^.]+/i,
    /Preview/i
  ];

  for (const pattern of usefulPatterns) {
    const titleMatch = title.match(pattern);
    if (titleMatch) return clean(titleMatch[0]);

    const detailMatch = detail.match(pattern);
    if (detailMatch) return clean(detailMatch[0]);
  }

  if (titleStatus) return titleStatus;

  if (/preview/i.test(title)) return "Preview";
  if (/won/i.test(title)) return title;
  if (/need/i.test(title)) return title;

  return clean(detail || title || "Situation not available").slice(0, 180);
}

function classifyState(status) {
  const text = clean(status).toLowerCase();

  if (
    text.includes("won") ||
    text === "complete" ||
    text.includes("completed") ||
    text.includes("no result") ||
    text.includes("abandoned")
  ) {
    return "Finished";
  }

  if (
    text.includes("preview") ||
    text.includes("match starts") ||
    text.includes("starts soon") ||
    text.includes("yet to begin")
  ) {
    return "Upcoming";
  }

  if (
    text.includes("need") ||
    text.includes("innings break") ||
    text.includes("opt to") ||
    text.includes("chose to") ||
    text.includes("elected to") ||
    text.includes("drinks") ||
    text.includes("strategic timeout")
  ) {
    return "Live";
  }

  return "Unknown";
}

function extractStartISO(text) {
  const source = clean(text);
  const dated = source.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}[^\d]{0,20}(\d{1,2}:\d{2})\s*GMT/i);
  if (!dated) return "";

  const datePart = source.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}/i)?.[0];
  const parsed = datePart ? Date.parse(`${datePart} ${dated[1]} GMT`) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function extractStructuredText($) {
  const selectors = [
    ".cb-text-live",
    ".cb-text-complete",
    ".cb-text-preview",
    ".cb-min-inf",
    ".cb-min-bat-rw",
    ".cb-font-20",
    ".cb-font-16",
    ".cb-col",
    ".cb-scrd-itms",
    ".cbz-ui-status",
    ".cbz-ui-home-team",
    ".cbz-ui-away-team",
    ".cb-scrd-hdr-rw"
  ];

  const parts = [];

  for (const selector of selectors) {
    $(selector).each((index, element) => {
      const text = clean($(element).text());

      if (text && text.length <= 900 && !parts.includes(text)) {
        parts.push(text);
      }
    });
  }

  return clean(parts.join(" "));
}

function chooseBestScores(scores) {
  const byTeam = new Map();

  for (const score of scores || []) {
    if (!score.team || !score.score) continue;

    const key = clean(score.team).toUpperCase();
    const existing = byTeam.get(key);

    if (!existing) {
      byTeam.set(key, score);
      continue;
    }

    const currentHasOvers = Boolean(score.overs);
    const existingHasOvers = Boolean(existing.overs);
    const currentHasRR = Boolean(score.rr);
    const existingHasRR = Boolean(existing.rr);

    if (!existingHasOvers && currentHasOvers) {
      byTeam.set(key, score);
      continue;
    }

    if (!existingHasRR && currentHasRR) {
      byTeam.set(key, score);
      continue;
    }

    const currentRuns = parseInt(String(score.score).match(/\d+/)?.[0] || "0", 10);
    const existingRuns = parseInt(String(existing.score).match(/\d+/)?.[0] || "0", 10);

    if (currentRuns >= existingRuns && (currentHasOvers || currentHasRR)) {
      byTeam.set(key, score);
    }
  }

  return Array.from(byTeam.values());
}

function extractCrr(text) {
  const match = clean(text).match(/\bCRR[:\s]*([\d.]+)/i);
  return match ? match[1] : "";
}

function extractScoresFromText(text, teams) {
  const source = clean(text);
  const scores = [];
  const crr = extractCrr(source);

  const knownShorts = teams.map(team => TEAM_SHORT[team]).filter(Boolean);
  const shorts = Array.from(new Set([...knownShorts, ...ALL_SHORTS]));

  for (const short of shorts) {
    const patterns = [
      new RegExp(`\\b${short}\\s+(\\d{1,3})\\s*[-/]\\s*(\\d{1,2})\\s*\\((\\d{1,2}(?:\\.\\d)?)(?:\\/20)?\\)`, "gi"),
      new RegExp(`\\b${short}\\s+(\\d{1,3})\\s*\\/\\s*(\\d{1,2})\\s*\\((\\d{1,2}(?:\\.\\d)?)(?:\\/20)?\\s*ov\\)`, "gi"),
      new RegExp(`\\b${short}\\s+(\\d{1,3})\\s*\\/\\s*(\\d{1,2})`, "gi"),
      new RegExp(`\\b${short}\\s+(\\d{1,3})\\s*-\\s*(\\d{1,2})`, "gi")
    ];

    for (const regex of patterns) {
      let match;

      while ((match = regex.exec(source)) !== null) {
        const runs = match[1];
        const wickets = match[2];
        const overs = match[3] || "";
if (!isValidScoreCandidate(runs, wickets, overs)) continue;

const score = `${runs}/${wickets}`;

scores.push({
          team: short,
          score,
          overs,
          rr: overs ? calculateRR(score, overs) : crr,
          raw: clean(match[0])
        });
      }
    }
  }

  return chooseBestScores(scores);
}

function scorecardUrlFromLiveUrl(url) {
  return String(url || "").replace("/live-cricket-scores/", "/live-cricket-scorecard/");
}

function normalizeScoreText(runs, wickets) {
  if (wickets === undefined || wickets === null || wickets === "") {
    return String(runs);
  }

  return `${runs}/${wickets}`;
}

function extractFullScorecardScores(text, teams) {
  const source = clean(text);
  const scores = [];

  for (const fullTeam of teams) {
    const shortTeam = getTeamShort(fullTeam);
    const escapedFull = fullTeam.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedShort = shortTeam.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const patterns = [
      new RegExp(`${escapedFull}\\s+(?:Innings)?\\s*(\\d{1,3})\\s*[-/]\\s*(\\d{1,2})\\s*\\((\\d{1,2}(?:\\.\\d)?)(?:\\/20)?\\s*Ov\\)`, "i"),
      new RegExp(`${escapedShort}\\s+(\\d{1,3})\\s*[-/]\\s*(\\d{1,2})\\s*\\((\\d{1,2}(?:\\.\\d)?)(?:\\/20)?\\s*Ov\\)`, "i"),
      new RegExp(`${escapedFull}[^\\d]{0,60}(\\d{1,3})\\s*[-/]\\s*(\\d{1,2})[^\\d]{0,20}(\\d{1,2}(?:\\.\\d)?)\\s*Ov`, "i"),
      new RegExp(`${escapedShort}[^\\d]{0,60}(\\d{1,3})\\s*[-/]\\s*(\\d{1,2})[^\\d]{0,20}(\\d{1,2}(?:\\.\\d)?)\\s*Ov`, "i")
    ];

    for (const pattern of patterns) {
      const match = source.match(pattern);

      if (match) {
        const runs = match[1];
        const wickets = match[2];
        const overs = match[3];
        const score = normalizeScoreText(runs, wickets);

        scores.push({
          team: shortTeam,
          score,
          overs,
          rr: calculateRR(score, overs),
          raw: clean(match[0])
        });

        break;
      }
    }
  }

  return chooseBestScores(scores);
}

async function fetchFinishedScorecardScores(url, teams) {
  const urlsToTry = [
    scorecardUrlFromLiveUrl(url),
    url
  ];

  for (const tryUrl of urlsToTry) {
    try {
      const html = await fetchHtml(tryUrl);
      const $ = cheerio.load(html);

      const structuredText = extractStructuredText($);
      const bodyText = clean($("body").text());
      const combined = clean(`${structuredText} ${bodyText}`);

      let scores = extractFullScorecardScores(combined, teams);

      if (scores.length < teams.length) {
        const fallbackScores = extractScoresFromText(combined, teams);
        scores = chooseBestScores([...scores, ...fallbackScores]);
      }

      if (scores.length) {
        return scores;
      }
    } catch {
      // Try next URL.
    }
  }

  return [];
}

function parseLiveDetails(text, scores) {
  const source = clean(text);

  const details = {
    toss: "",
    chase: "",
    rr: "",
    requiredRR: "",
    lastFive: "",
    battingTeam: "",
    target: "",
    simpleSituation: ""
  };


  const teamPattern = ALL_SHORTS
    .map(short => short.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const tossMatch = source.match(
    new RegExp(`\\b(?:${teamPattern})\\s+(?:opt|opts|chose|choose|elected|elects)\\s+to\\s+(?:bat|bowl)\\b`, "i")
  );

  if (tossMatch) details.toss = clean(tossMatch[0]);

  const crrMatch = source.match(/\bCRR[:\s]*([\d.]+)/i);
  if (crrMatch) details.rr = crrMatch[1];

  const reqMatch = source.match(/\bRequired RR[:\s]*([\d.]+)/i);
  if (reqMatch) details.requiredRR = reqMatch[1];

  const lastFiveMatch = source.match(/Last 5 overs?[:\s]+(\d+\s+runs?,?\s*\d*\s*wkts?)/i);
  if (lastFiveMatch) details.lastFive = clean(lastFiveMatch[1]);

  const chaseMatch = source.match(/([A-Za-z ]+)\s+need\s+(\d+)\s+runs?\s+in\s+(\d+)\s+balls?/i);
  if (chaseMatch) {
    details.chase = `${clean(chaseMatch[1])} need ${chaseMatch[2]} runs in ${chaseMatch[3]} balls`;
    details.simpleSituation = details.chase;
  }

  const shortChaseMatch = source.match(/Need\s+(\d+)\s+off\s+(\d+)b/i);
  if (shortChaseMatch) {
    details.chase = `Need ${shortChaseMatch[1]} off ${shortChaseMatch[2]}b`;
    details.simpleSituation = details.chase;
  }

  if (!details.rr && scores.length) {
    const latestScore = scores[scores.length - 1];
    details.rr = latestScore.rr || calculateRR(latestScore.score, latestScore.overs);
  }

  if (!details.requiredRR && scores.length <= 1) {
    details.requiredRR = "First innings";
  }

  if (!details.simpleSituation && details.toss) {
    details.simpleSituation = details.toss;
  }

  if (!details.simpleSituation) {
    details.simpleSituation = source.slice(0, 180);
  }

  return details;
}

async function fetchMatchDetail(url, teams, stateHint) {
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const schemaStart = String(html).match(/"startDate"\s*:\s*"([^"]+)"/i)?.[1] || "";

    const structuredText = extractStructuredText($);
    const bodyText = clean($("body").text());
    const combinedText = clean(`${structuredText} ${bodyText}`);

    let scores = extractScoresFromText(combinedText, teams);

    if (stateHint === "Finished" || combinedText.toLowerCase().includes("won")) {
      const finishedScores = await fetchFinishedScorecardScores(url, teams);

      if (finishedScores.length) {
        scores = chooseBestScores([...scores, ...finishedScores]);
      }
    }

    const liveDetails = parseLiveDetails(combinedText, scores);

    return {
      detailText: structuredText,
      rawText: combinedText.slice(0, 2500),
      scores,
      liveDetails,
      startISO: schemaStart && Number.isFinite(Date.parse(schemaStart))
        ? new Date(schemaStart).toISOString()
        : ""
    };
  } catch {
    return {
      detailText: "",
      rawText: "",
      scores: [],
      liveDetails: {},
      startISO: ""
    };
  }
}

async function scrapeWomensT20WorldCupBase() {
  const map = new Map();
  const listUrls = [
    "https://www.cricbuzz.com/cricket-match/live-scores",
    "https://www.cricbuzz.com/cricket-match/live-scores/recent-matches",
    "https://www.cricbuzz.com/cricket-match/live-scores/upcoming-matches"
  ];

  for (const listUrl of listUrls) {
    let $;
    try {
      const html = await fetchHtml(listUrl);
      $ = cheerio.load(html);
    } catch {
      continue;
    }

    $("a[href*='/live-cricket-scores/']").each((index, element) => {
      const link = $(element);
      const href = link.attr("href") || "";
      if (!href) return;

      const fullUrl = href.startsWith("http") ? href : `https://www.cricbuzz.com${href}`;
      const slug = getSlug(fullUrl);
      const teams = parseTeams(slug);
      if (!isWomensT20WorldCup(slug, teams)) return;

      const id = getMatchId(fullUrl);
      const titleText = clean(link.attr("title") || link.text());
      const stateHint = listUrl.includes("recent-matches")
        ? "Finished"
        : listUrl.includes("upcoming-matches")
          ? "Upcoming"
          : "";
      if (!map.has(id)) map.set(id, { id, url: fullUrl, slug, teams, titleText, stateHint });
    });
  }

  return Array.from(map.values()).slice(0, 24);
}

async function scrapeWomensT20WorldCup() {
  const baseMatches = await scrapeWomensT20WorldCupBase();
  const matches = [];

  for (const item of baseMatches) {
    const preliminaryStatus = extractStatus(item.titleText, "");
    const preliminaryState = classifyState(preliminaryStatus) === "Unknown"
      ? item.stateHint || "Unknown"
      : classifyState(preliminaryStatus);

    const detail = await fetchMatchDetail(item.url, item.teams, preliminaryState);

    let status = extractStatus(item.titleText, detail.detailText);
    let state = classifyState(status);
    if (state === "Unknown" && item.stateHint) state = item.stateHint;
    const startISO = detail.startISO || extractStartISO(`${item.titleText} ${detail.detailText} ${detail.rawText}`);

    let finalScores = detail.scores;

    if (state === "Finished" && finalScores.length < item.teams.length) {
      const scorecardScores = await fetchFinishedScorecardScores(item.url, item.teams);
      finalScores = chooseBestScores([...finalScores, ...scorecardScores]);
    }

    if (state === "Finished" && !/(?:won|tied|no result|abandoned)/i.test(status)) {
      status = inferCompletedResult(item.teams, finalScores);
    }

    const matchScore =
      finalScores.length > 0
        ? finalScores
            .map(score => `${score.team} ${score.score}${score.overs ? ` (${score.overs} ov)` : ""}`)
            .join(" | ")
        : "Score not available";

    matches.push({
      id: item.id,
      name: getMatchName(item.teams, item.slug),
      teams: item.teams,
      category: "Women's T20 World Cup",
      state,
      status,
      startISO,
      url: item.url,
      source: "Cricbuzz",
      score: matchScore,
      scores: finalScores,
      liveDetails: detail.liveDetails,
      liveScorecard: null,
      rawText: detail.rawText
    });
  }

  return matches.sort((a, b) => {
    const rank = { Live: 1, Upcoming: 2, Finished: 3, Unknown: 4 };
    return (rank[a.state] || 9) - (rank[b.state] || 9);
  });
}

async function getCachedMatches() {
  const now = Date.now();
  if (matchCache.data && now - matchCache.fetchedAt < CACHE_TTL_MS) {
    return { data: matchCache.data, cached: true };
  }

  if (!matchFetchPromise) {
    matchFetchPromise = scrapeWomensT20WorldCup()
      .then(data => {
        matchCache = { data, fetchedAt: Date.now() };
        return data;
      })
      .finally(() => {
        matchFetchPromise = null;
      });
  }

  try {
    return { data: await matchFetchPromise, cached: false };
  } catch (error) {
    if (matchCache.data) return { data: matchCache.data, cached: true, stale: true };
    throw error;
  }
}

app.get("/api/womens-t20-world-cup", async (req, res) => {
  try {
    const { data, cached, stale } = await getCachedMatches();

    res.json({
      status: "success",
      fetchedAt: new Date().toISOString(),
      cached,
      stale: Boolean(stale),
      data,
      meta: {
        total: data.length,
        womensT20WorldCup: data.length,
        live: data.filter(match => match.state === "Live").length,
        upcoming: data.filter(match => match.state === "Upcoming").length,
        finished: data.filter(match => match.state === "Finished").length,
        unknown: data.filter(match => match.state === "Unknown").length
      }
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      error: error.message || "Failed to fetch Women's T20 World Cup matches"
    });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    app: "Vipul AI Dashboard",
    port: PORT,
    routes: ["/api/womens-t20-world-cup", "/api/health"]
  });
});

app.get("/", (req, res) => {
  res.redirect("/womens-world-cup.html");
});



app.get("/api/test-cricapi", async (req, res) => {
  try {
    const response = await axios.get("https://api.cricapi.com/v1/currentMatches", {
      params: {
        apikey: process.env.CRICAPI_KEY,
        offset: 0
      }
    });

    res.json(response.data);
  } catch (error) {
    res.status(500).json({
      error: error.message,
      details: error.response?.data || null
    });
  }
});




app.get("/api/test-entitysport", async (req, res) => {
  try {
    const response = await axios.get("https://restapi.entitysport.com/v2/matches/", {
      params: {
        token: process.env.ENTITYSPORT_TOKEN
      }
    });

    res.json(response.data);
  } catch (error) {
    res.status(500).json({
      error: error.message,
      details: error.response?.data || null
    });
  }
});



app.listen(PORT, () => {
  console.log(`Vipul AI Dashboard running at http://localhost:${PORT}`);
});
