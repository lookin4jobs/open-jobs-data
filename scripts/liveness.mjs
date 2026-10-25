#!/usr/bin/env node
// Nightly browser liveness check for a short list of job postings.
//
// Reads data/liveness-targets.json, opens each posting once in headless
// Chromium (Playwright), and writes data/liveness.json with what it saw.
// This is for employer postings whose pages only render in a real browser
// (ADP, Eightfold, Avature and similar), so the morning check can tell a live
// posting from a closed one without a person opening it.
//
// Ground rules:
//   - robots.txt is honored. A path disallowed for us or for "*" is skipped
//     and recorded as robots_disallowed. robots.txt that cannot be read
//     (5xx or network error) also means skip.
//   - Challenges are never bypassed. A CAPTCHA, a "verify you are human"
//     page or a bot-protection interstitial is recorded as blocked and left
//     alone. No stealth plugins, no retries after a challenge, no proxies.
//   - One page load per posting per run, one at a time, with a pause
//     between loads. The one exception: when the site's own app shows a
//     generic error ("an unexpected error has occurred, please try again"),
//     the page is loaded once more after a short wait. ADP did this on
//     10/23/2026 for two postings it had shown fine five hours earlier.
//   - Text is read from every frame on the page, not only the top one:
//     iCIMS shows the posting inside an iframe on the same site.
//   - The script always exits 0 so it can never fail the dataset workflow.
//     Problems are recorded in the output instead.
//
// Outcomes per target:
//   live               page rendered and the posting's title appears on it
//   closed_text        the page says the posting is closed, filled, expired or gone
//   gone               HTTP 404 or 410
//   redirected         landed somewhere else without the title (often a closed
//                      req bounced to the careers home page, but not proof)
//   blocked            bot protection or CAPTCHA, or HTTP 401/403/429
//   robots_disallowed  robots.txt asks automated agents not to load this path
//   robots_unavailable robots.txt could not be read, so the page was not loaded
//   unclear            rendered, but neither the title nor closed wording found
//   error              navigation failed (timeout, DNS, TLS)
//
// A target with "captureText": true also keeps up to 8,000 characters of the
// page's text in its result, for postings no other route can read.
//
// Boards (the "boards" list in the targets file, added 10/23/2026): some
// employers' own careers sites only list their jobs in a browser (Burns &
// McDonnell and HNTB on .jobs sites, EquipmentShare). For each board the
// script loads the listing page once, under the same robots.txt and
// no-challenge rules, and records the job links it shows (title text and
// URL) in data/liveness.json under "boards". That is a list for discovery,
// not a verdict on any one posting. Board outcomes: listed, empty, blocked,
// robots_disallowed, robots_unavailable, error.
//
// Robots audit (the "robotsAudit" list, added 10/25/2026): for each host, the
// script reads robots.txt only and records what it says to each agent for the
// listed paths, under "robotsAudit" in data/liveness.json.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = process.env.LIVENESS_TARGETS || path.join(ROOT, 'data', 'liveness-targets.json');
const OUT = process.env.LIVENESS_OUT || path.join(ROOT, 'data', 'liveness.json');
const BOT_TOKEN = 'open-jobs-data-liveness';
const MAX_TARGETS = 40;
const MAX_BOARDS = 10;
const MAX_BOARD_LINKS = 200;
const CAPTURE_TEXT_CHARS = 8000;
const PAUSE_MS = Number(process.env.LIVENESS_PAUSE_MS ?? 4000);
const NAV_TIMEOUT_MS = 45000;
const RENDER_WAIT_MS = 15000;
const APP_ERROR_RETRY_MS = Number(process.env.LIVENESS_APP_ERROR_RETRY_MS ?? 20000);
const APP_ERROR = /(?:an unexpected error has occurred|something went wrong)[^.]{0,40}[.!]?\s*(?:please )?try again/i;

const CLOSED_PATTERNS = [
  /no longer (?:accepting applications|available|open|active|posted)/i,
  /(?:job|position|posting|requisition|opening|role)[^.]{0,40}(?:has been|is|was) (?:filled|closed|removed|expired|deleted|cancell?ed)/i,
  /this (?:job|position|posting|requisition|opening) (?:has )?expired/i,
  /(?:job|position|posting) (?:not found|does not exist|could not be found)/i,
  /the job you are (?:trying to apply for|looking for) (?:has been filled|is no longer)/i,
  /sorry,? (?:this|the) (?:job|position|posting)[^.]{0,40}(?:removed|closed|filled|unavailable|no longer)/i,
  /applications? (?:for this (?:job|position|role) )?(?:are|is) (?:now )?closed/i,
  /the (?:job|position|posting) you are looking for (?:may have|has) (?:been )?closed/i,
];
const CHALLENGE_TEXT = [
  /just a moment\.\.\./i, /attention required/i, /verify (?:that )?you are (?:a )?human/i,
  /are you a robot/i, /unusual traffic/i, /access denied/i, /request (?:was )?blocked/i,
  /checking your browser/i, /press (?:&|and) hold/i, /enable javascript and cookies to continue/i,
];
const CHALLENGE_HTML = [/cf-chl|challenge-platform/i, /captcha/i, /datadome/i, /perimeterx|px-captcha/i, /_incapsula_|imperva/i, /akamai.{0,40}bot manager/i];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// innerText of the top frame first, then of each child frame. A frame that
// cannot be read (detached, still navigating) is skipped.
async function pageText(page) {
  const parts = [];
  for (const f of page.frames()) {
    try { parts.push(await f.evaluate(() => (document.body && document.body.innerText) || '')); } catch { /* skip */ }
  }
  return parts.join('\n');
}
const norm = s => String(s || '').toLowerCase().replace(/&amp;/g, '&').replace(/[^a-z0-9]+/g, '');
const clip = (s, n = 160) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// ---- robots.txt -----------------------------------------------------------
const robotsCache = new Map();

function parseRobots(text) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === 'allow' || key === 'disallow')) cur.rules.push({ allow: key === 'allow', path: val });
    }
  }
  return groups;
}

function ruleMatches(rulePath, target) {
  if (!rulePath) return false;
  const anchored = rulePath.endsWith('$');
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const re = new RegExp('^' + body.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''));
  return re.test(target);
}

function robotsAllows(groups, target) {
  // A group naming our token wins; otherwise the "*" group applies.
  let chosen = groups.filter(g => g.agents.some(a => a !== '*' && BOT_TOKEN.includes(a)));
  if (!chosen.length) chosen = groups.filter(g => g.agents.includes('*'));
  let best = null;
  for (const g of chosen) for (const r of g.rules) {
    if (!ruleMatches(r.path, target)) continue;
    const len = r.path.replace(/\$$/, '').length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}

async function checkRobots(url) {
  const u = new URL(url);
  const key = u.origin;
  if (!robotsCache.has(key)) {
    let entry;
    try {
      const res = await fetch(key + '/robots.txt', {
        headers: { 'user-agent': `${BOT_TOKEN}/1.0 (+https://github.com/lookin4jobs/open-jobs-data)` },
        redirect: 'follow', signal: AbortSignal.timeout(15000),
      });
      if (res.status >= 500) entry = { unavailable: `robots.txt HTTP ${res.status}` };
      // A 2xx that is not 200 (Jacobs answered 202 with an empty body on 10/25, a bot-check
      // response) is not a robots file, so it is treated as unreadable rather than as "no rules".
      else if (res.status < 300 && res.status !== 200) entry = { unavailable: `robots.txt HTTP ${res.status}` };
      else if (res.status >= 400) entry = { groups: [] };          // no robots.txt = no restrictions
      else entry = { groups: parseRobots(await res.text()) };
    } catch (err) {
      entry = { unavailable: `robots.txt ${err.name}: ${clip(err.message, 80)}` };
    }
    robotsCache.set(key, entry);
  }
  const entry = robotsCache.get(key);
  if (entry.unavailable) return { ok: false, outcome: 'robots_unavailable', evidence: entry.unavailable };
  if (!robotsAllows(entry.groups, u.pathname + u.search)) return { ok: false, outcome: 'robots_disallowed', evidence: `robots.txt disallows ${u.pathname}` };
  return { ok: true };
}

// ---- robots audit (added 10/25/2026) --------------------------------------
// Reads robots.txt for the hosts listed under "robotsAudit" in the targets file
// and records, for each listed path, what the file says to this script, to "*",
// to Anthropic's user-initiated fetcher (Claude-User), to its crawler
// (ClaudeBot) and to a mainstream crawler for comparison. That way a refusal
// can be read and understood (and re-checked over time) instead of guessed at.
// Only robots.txt itself is requested here; no other page on the host is loaded.
const AUDIT_AGENTS = [BOT_TOKEN, '*', 'Claude-User', 'ClaudeBot', 'anthropic-ai', 'Googlebot'];
const MAX_AUDIT_HOSTS = 25;

function robotsVerdict(groups, agent, target) {
  const a = agent.toLowerCase();
  let chosen = a === '*' ? [] : groups.filter(g => g.agents.some(x => x !== '*' && a.includes(x)));
  const named = chosen.length > 0;
  if (!named) chosen = groups.filter(g => g.agents.includes('*'));
  let best = null;
  for (const g of chosen) for (const r of g.rules) {
    if (!ruleMatches(r.path, target)) continue;
    const len = r.path.replace(/\$$/, '').length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow, rule: `${r.allow ? 'Allow' : 'Disallow'}: ${r.path}` };
  }
  return { allowed: best ? best.allow : true, rule: best ? best.rule : null, group: named ? 'named' : chosen.length ? '*' : 'none' };
}

async function auditRobots(entry) {
  const host = String(entry.host || '').replace(/\/+$/, '');
  const out = { host, paths: entry.paths || ['/'], why: entry.why };
  try {
    const res = await fetch(host + '/robots.txt', {
      headers: { 'user-agent': `${BOT_TOKEN}/1.0 (+https://github.com/lookin4jobs/open-jobs-data)` },
      redirect: 'follow', signal: AbortSignal.timeout(15000),
    });
    out.status = res.status;
    out.finalUrl = res.url;
    if (res.status < 300 && res.status !== 200) out.unreadable = `HTTP ${res.status} is not a robots file (treated as unreadable)`;
    const text = res.status < 400 ? await res.text() : '';
    out.text = clip(text, 6000);
    const groups = res.status < 400 ? parseRobots(text) : [];
    out.verdicts = {};
    for (const p of out.paths) {
      out.verdicts[p] = {};
      for (const agent of AUDIT_AGENTS) out.verdicts[p][agent] = robotsVerdict(groups, agent, p);
    }
  } catch (err) {
    out.error = `${err.name}: ${clip(err.message, 100)}`;
  }
  return out;
}

// ---- page check -----------------------------------------------------------
function jobPostingFrom(ldBlocks) {
  for (const raw of ldBlocks) {
    let data;
    try { data = JSON.parse(raw); } catch { continue; }
    const items = [].concat(data, ...(Array.isArray(data) ? [] : [data['@graph'] || []]));
    for (const it of items.flat()) {
      if (it && /JobPosting/i.test([].concat(it['@type']).join(' '))) {
        return { title: clip(it.title, 120), datePosted: it.datePosted || null, validThrough: it.validThrough || null };
      }
    }
  }
  return null;
}

async function checkOne(browser, t) {
  const base = { id: t.id, company: t.company, title: t.title, url: t.url, checkedAt: new Date().toISOString(), ...(t.captureText ? { captureText: true } : {}) };
  let u;
  try { u = new URL(t.url); } catch { return { ...base, outcome: 'error', evidence: 'not a valid URL' }; }
  const allowHttp = process.env.LIVENESS_ALLOW_HTTP === '1' && ['localhost', '127.0.0.1'].includes(u.hostname); // local tests only
  if (u.protocol !== 'https:' && !allowHttp) return { ...base, outcome: 'error', evidence: 'only https URLs are checked' };

  const robots = await checkRobots(t.url);
  if (!robots.ok) return { ...base, outcome: robots.outcome, evidence: robots.evidence };

  const want = norm(t.title);
  let r = await loadPage(browser, t, want);
  // Reload once only for the site's own generic error page: never after a
  // challenge or a refusal status.
  const appError = rd => rd && APP_ERROR.test(rd.text.slice(0, 1000)) && !norm(rd.text).includes(want)
    && ![401, 403, 429].includes(rd.status) && !CHALLENGE_TEXT.some(re => re.test(rd.pageTitle) || re.test(rd.text.slice(0, 3000)));
  if (appError(r.read)) {
    const first = clip(r.read.text.match(APP_ERROR)[0], 80);
    await r.close();
    await sleep(APP_ERROR_RETRY_MS);
    r = await loadPage(browser, t, want);
    if (r.read) r.read.retried = `reloaded once after "${first}"`;
  }
  try {
    return r.read ? classify(base, u, want, r.read) : { ...base, ...r.failed };
  } finally {
    await r.close();
  }
}

async function loadPage(browser, t, want) {
  const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
  const close = () => ctx.close().catch(() => {});
  try {
    const page = await ctx.newPage();
    let resp;
    try {
      resp = await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    } catch (err) {
      return { close, failed: { outcome: 'error', evidence: clip(`${err.name}: ${err.message}`, 160) } };
    }
    const status = resp ? resp.status() : null;
    // Script-rendered boards (ADP, Eightfold, iCIMS frames) fill in after
    // load: poll every frame for the title or closed wording, up to the limit.
    const deadline = Date.now() + RENDER_WAIT_MS;
    for (;;) {
      const txt = await pageText(page);
      if ((want && norm(txt).includes(want)) || CLOSED_PATTERNS.some(re => re.test(txt)) || Date.now() > deadline) break;
      await sleep(500);
    }
    const finalUrl = page.url();
    const pageTitle = clip(await page.title(), 120);
    const text = await pageText(page);
    const html = await page.content();
    const ld = await page.$$eval('script[type="application/ld+json"]', els => els.map(e => e.textContent)).catch(() => []);
    return { close, read: { status, finalUrl, pageTitle, text, html, ld } };
  } catch (err) {
    return { close, failed: { outcome: 'error', evidence: clip(`${err.name}: ${err.message}`, 160) } };
  }
}

function classify(base, u, want, { status, finalUrl, pageTitle, text, html, ld, retried }) {
  const jsonLd = jobPostingFrom(ld);
  const out = { ...base, finalUrl, httpStatus: status, pageTitle, jsonLd, ...(retried ? { retried } : {}) };
  // captureText targets keep the page text so the posting can be screened
  // when no other route can read it. It is the employer's page, as data.
  if (base.captureText) out.pageText = clip(text, CAPTURE_TEXT_CHARS);

  // A 404 or 410 is the site's own answer, even when the error page carries
  // a CAPTCHA script (Netflix's does), so it is read before challenge markers.
  if (status === 404 || status === 410) {
    return { ...out, outcome: 'gone', evidence: clip(`HTTP ${status} ${text.match(CLOSED_PATTERNS.find(r => r.test(text)) || /$^/)?.[0] || pageTitle}`) };
  }
  const challenged = CHALLENGE_TEXT.some(r => r.test(pageTitle) || r.test(text.slice(0, 3000)))
    || (CHALLENGE_HTML.some(r => r.test(html)) && !norm(text).includes(want));
  if (challenged || [401, 403, 429].includes(status)) {
    return { ...out, outcome: 'blocked', evidence: clip(`HTTP ${status} ${pageTitle} ${text.slice(0, 120)}`) };
  }

  const closed = CLOSED_PATTERNS.map(r => text.match(r)).find(Boolean);
  if (closed) return { ...out, outcome: 'closed_text', evidence: clip(closed[0]) };

  if (jsonLd && jsonLd.validThrough && Date.parse(jsonLd.validThrough) < Date.now()) {
    return { ...out, outcome: 'closed_text', evidence: `JobPosting validThrough ${jsonLd.validThrough} is past` };
  }
  if (want && norm(text).includes(want)) {
    return { ...out, outcome: 'live', evidence: `title "${clip(base.title, 80)}" shown on the page` };
  }
  const landedElsewhere = new URL(finalUrl).host !== u.host || new URL(finalUrl).pathname !== u.pathname;
  if (landedElsewhere) return { ...out, outcome: 'redirected', evidence: clip(`landed on ${finalUrl}`) };
  return { ...out, outcome: 'unclear', evidence: clip(`title not found; page starts: ${text.slice(0, 120)}`) };
}

// ---- boards ---------------------------------------------------------------
// linkPattern (a regex source matched against each link's absolute URL) picks
// out job links; without one, a same-site link counts when its path mentions
// "job" and carries a posting id (5+ digits or 16+ hex characters), which
// keeps navigation links out. Links whose text is too short or too long to be
// a title are dropped.
async function scanBoard(browser, b) {
  const base = { id: b.id, company: b.company, url: b.url, checkedAt: new Date().toISOString() };
  let u;
  try { u = new URL(b.url); } catch { return { ...base, outcome: 'error', evidence: 'not a valid URL', jobs: [] }; }
  const allowHttp = process.env.LIVENESS_ALLOW_HTTP === '1' && ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !allowHttp) return { ...base, outcome: 'error', evidence: 'only https URLs are checked', jobs: [] };
  const robots = await checkRobots(b.url);
  if (!robots.ok) return { ...base, outcome: robots.outcome, evidence: robots.evidence, jobs: [] };
  let pattern;
  try { pattern = b.linkPattern ? new RegExp(b.linkPattern, 'i') : null; } catch { return { ...base, outcome: 'error', evidence: 'bad linkPattern', jobs: [] }; }
  const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
  try {
    const page = await ctx.newPage();
    let resp;
    try {
      resp = await page.goto(b.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    } catch (err) {
      return { ...base, outcome: 'error', evidence: clip(`${err.name}: ${err.message}`, 160), jobs: [] };
    }
    const status = resp ? resp.status() : null;
    let rejected = [];
    const collect = async () => {
      const links = [];
      for (const f of page.frames()) {
        try {
          // A job card's link often wraps the title plus location and dates, so
          // the title is the first non-empty line of the link's text.
          links.push(...await f.$$eval('a[href]', as => as.map(a => {
            // Some boards (Oracle) put an empty link over the card: fall back to
            // the link's label, then to the text of the card around it.
            let raw = (a.innerText || a.textContent || '').trim() || a.getAttribute('aria-label') || a.getAttribute('title') || '';
            for (let el = a.parentElement, n = 0; !raw.trim() && el && n < 4; el = el.parentElement, n++) raw = el.innerText || '';
            const title = (raw.split(/\n/).map(t => t.trim()).find(Boolean) || '').replace(/\s+/g, ' ');
            const all = raw.replace(/\s+/g, ' ').trim();
            return all !== title ? { title, url: a.href, text: all.slice(0, 200) } : { title, url: a.href };
          })));
        } catch { /* skip */ }
      }
      const seen = new Set();
      rejected = [];
      return links.filter(l => {
        let lu;
        try { lu = new URL(l.url); } catch { return false; }
        const ok = pattern ? pattern.test(l.url) : (lu.host === u.host && /job/i.test(lu.pathname) && /[0-9]{5,}|[0-9a-f]{16,}/i.test(lu.pathname));
        if (!ok || seen.has(l.url)) return false;
        if (l.title.length < 6 || l.title.length > 160) { if (rejected.length < 5) rejected.push(l); return false; }
        seen.add(l.url);
        return true;
      });
    };
    const deadline = Date.now() + RENDER_WAIT_MS;
    let jobs = [];
    for (;;) {
      jobs = await collect();
      if (jobs.length || Date.now() > deadline) break;
      await sleep(750);
    }
    const pageTitle = clip(await page.title(), 120);
    const text = await pageText(page);
    const out = { ...base, finalUrl: page.url(), httpStatus: status, pageTitle };
    if (CHALLENGE_TEXT.some(r => r.test(pageTitle) || r.test(text.slice(0, 3000))) || [401, 403, 429].includes(status)) {
      return { ...out, outcome: 'blocked', evidence: clip(`HTTP ${status} ${pageTitle} ${text.slice(0, 120)}`), jobs: [] };
    }
    if (!jobs.length) {
      const sample = await page.$$eval('a[href]', as => as.slice(0, 400).map(a => a.href)).catch(() => []);
      return { ...out, outcome: 'empty', evidence: clip(`no job links found; page starts: ${text.slice(0, 120)}`), jobs: [],
        sampleLinks: [...new Set(sample)].filter(h => /job|career|opening|position/i.test(h)).slice(0, 25),
        ...(rejected.length ? { untitledLinks: rejected } : {}) };
    }
    return { ...out, outcome: 'listed', count: jobs.length, truncated: jobs.length > MAX_BOARD_LINKS || undefined, jobs: jobs.slice(0, MAX_BOARD_LINKS) };
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ---- main -----------------------------------------------------------------
async function main() {
  const started = new Date();
  const report = { generatedAt: started.toISOString(), runner: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local', results: [], boards: [] };
  let targets = [], boards = [], audits = [];
  try {
    const file = JSON.parse(await readFile(TARGETS, 'utf8'));
    targets = (file.targets || []).filter(t => t && t.url);
    boards = (file.boards || []).filter(b => b && b.url).slice(0, MAX_BOARDS);
    audits = (file.robotsAudit || []).filter(a => a && a.host).slice(0, MAX_AUDIT_HOSTS);
  } catch (err) {
    report.error = `could not read targets: ${clip(err.message, 120)}`;
  }
  if (targets.length > MAX_TARGETS) {
    report.skipped = targets.length - MAX_TARGETS;
    targets = targets.slice(0, MAX_TARGETS);
  }
  if (targets.length || boards.length) {
    let browser;
    try {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ executablePath: process.env.PW_EXECUTABLE || undefined });
      report.userAgent = await browser.newPage().then(async p => { const ua = await p.evaluate(() => navigator.userAgent); await p.close(); return ua; });
      for (const [i, t] of targets.entries()) {
        if (i) await sleep(PAUSE_MS);
        let r;
        try { r = await checkOne(browser, t); } catch (err) { r = { id: t.id, url: t.url, outcome: 'error', evidence: clip(err.message) }; }
        report.results.push(r);
        console.log(`${r.outcome.padEnd(18)} ${t.company || ''} | ${t.title || ''} | ${r.evidence || ''}`);
      }
      for (const b of boards) {
        await sleep(PAUSE_MS);
        let r;
        try { r = await scanBoard(browser, b); } catch (err) { r = { id: b.id, url: b.url, outcome: 'error', evidence: clip(err.message), jobs: [] }; }
        report.boards.push(r);
        console.log(`board ${r.outcome.padEnd(12)} ${b.company || ''} | ${r.count ?? 0} job links | ${r.evidence || ''}`);
      }
    } catch (err) {
      report.error = `browser failed: ${clip(err.message, 160)}`;
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }
  if (audits.length) {
    report.robotsAudit = [];
    for (const a of audits) {
      const r = await auditRobots(a);
      report.robotsAudit.push(r);
      const deny = Object.entries(r.verdicts || {}).flatMap(([p, v]) => Object.entries(v).filter(([, x]) => !x.allowed).map(([ag]) => `${ag} ${p}`));
      console.log(`robots ${r.host} | HTTP ${r.status ?? '-'} | ${deny.length ? 'disallows: ' + deny.join(', ') : 'allows all listed'}${r.error ? ' | ' + r.error : ''}`);
      await sleep(1000);
    }
  }
  report.counts = report.results.reduce((c, r) => ({ ...c, [r.outcome]: (c[r.outcome] || 0) + 1 }), {});
  report.seconds = Math.round((Date.now() - started) / 1000);
  await writeFile(OUT, JSON.stringify(report, null, 2) + '\n');
  console.log(`liveness: ${report.results.length} checked ${JSON.stringify(report.counts)}${report.error ? ' | ' + report.error : ''}`);
}

main().catch(async err => {
  console.error('liveness failed:', err);
  try { await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), error: clip(err.message), results: [] }, null, 2) + '\n'); } catch {}
}).finally(() => process.exit(0));
