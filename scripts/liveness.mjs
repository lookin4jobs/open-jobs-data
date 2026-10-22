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
//     alone. No stealth plugins, no retries, no proxies.
//   - One page load per posting per run, one at a time, with a pause
//     between loads.
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

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = process.env.LIVENESS_TARGETS || path.join(ROOT, 'data', 'liveness-targets.json');
const OUT = process.env.LIVENESS_OUT || path.join(ROOT, 'data', 'liveness.json');
const BOT_TOKEN = 'open-jobs-data-liveness';
const MAX_TARGETS = 40;
const PAUSE_MS = Number(process.env.LIVENESS_PAUSE_MS ?? 4000);
const NAV_TIMEOUT_MS = 45000;
const RENDER_WAIT_MS = 15000;

const CLOSED_PATTERNS = [
  /no longer (?:accepting applications|available|open|active|posted)/i,
  /(?:job|position|posting|requisition|opening|role)[^.]{0,40}(?:has been|is|was) (?:filled|closed|removed|expired|deleted|cancell?ed)/i,
  /this (?:job|position|posting|requisition|opening) (?:has )?expired/i,
  /(?:job|position|posting) (?:not found|does not exist|could not be found)/i,
  /the job you are (?:trying to apply for|looking for) (?:has been filled|is no longer)/i,
  /sorry,? (?:this|the) (?:job|position|posting)[^.]{0,40}(?:removed|closed|filled|unavailable|no longer)/i,
  /applications? (?:for this (?:job|position|role) )?(?:are|is) (?:now )?closed/i,
];
const CHALLENGE_TEXT = [
  /just a moment\.\.\./i, /attention required/i, /verify (?:that )?you are (?:a )?human/i,
  /are you a robot/i, /unusual traffic/i, /access denied/i, /request (?:was )?blocked/i,
  /checking your browser/i, /press (?:&|and) hold/i, /enable javascript and cookies to continue/i,
];
const CHALLENGE_HTML = [/cf-chl|challenge-platform/i, /captcha/i, /datadome/i, /perimeterx|px-captcha/i, /_incapsula_|imperva/i, /akamai.{0,40}bot manager/i];

const sleep = ms => new Promise(r => setTimeout(r, ms));
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
  const base = { id: t.id, company: t.company, title: t.title, url: t.url, checkedAt: new Date().toISOString() };
  let u;
  try { u = new URL(t.url); } catch { return { ...base, outcome: 'error', evidence: 'not a valid URL' }; }
  const allowHttp = process.env.LIVENESS_ALLOW_HTTP === '1' && ['localhost', '127.0.0.1'].includes(u.hostname); // local tests only
  if (u.protocol !== 'https:' && !allowHttp) return { ...base, outcome: 'error', evidence: 'only https URLs are checked' };

  const robots = await checkRobots(t.url);
  if (!robots.ok) return { ...base, outcome: robots.outcome, evidence: robots.evidence };

  const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  try {
    let resp;
    try {
      resp = await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    } catch (err) {
      return { ...base, outcome: 'error', evidence: clip(`${err.name}: ${err.message}`, 160) };
    }
    const status = resp ? resp.status() : null;
    const want = norm(t.title);
    // Script-rendered boards (ADP, Eightfold) fill in after load: wait for the
    // title, closed wording or a challenge to show up, whichever comes first.
    await page.waitForFunction(({ want, closed }) => {
      const txt = (document.body && document.body.innerText) || '';
      const n = txt.toLowerCase().replace(/[^a-z0-9]+/g, '');
      return (want && n.includes(want)) || closed.some(src => new RegExp(src, 'i').test(txt));
    }, { want, closed: CLOSED_PATTERNS.map(r => r.source) }, { timeout: RENDER_WAIT_MS }).catch(() => {});

    const finalUrl = page.url();
    const pageTitle = clip(await page.title(), 120);
    const text = await page.evaluate(() => (document.body && document.body.innerText) || '');
    const html = await page.content();
    const ld = await page.$$eval('script[type="application/ld+json"]', els => els.map(e => e.textContent)).catch(() => []);
    const jsonLd = jobPostingFrom(ld);
    const out = { ...base, finalUrl, httpStatus: status, pageTitle, jsonLd };

    const challenged = CHALLENGE_TEXT.some(r => r.test(pageTitle) || r.test(text.slice(0, 3000)))
      || (CHALLENGE_HTML.some(r => r.test(html)) && !norm(text).includes(want));
    if (challenged || [401, 403, 429].includes(status)) {
      return { ...out, outcome: 'blocked', evidence: clip(`HTTP ${status} ${pageTitle} ${text.slice(0, 120)}`) };
    }
    if (status === 404 || status === 410) return { ...out, outcome: 'gone', evidence: `HTTP ${status}` };

    const closed = CLOSED_PATTERNS.map(r => text.match(r)).find(Boolean);
    if (closed) return { ...out, outcome: 'closed_text', evidence: clip(closed[0]) };

    if (jsonLd && jsonLd.validThrough && Date.parse(jsonLd.validThrough) < Date.now()) {
      return { ...out, outcome: 'closed_text', evidence: `JobPosting validThrough ${jsonLd.validThrough} is past` };
    }
    if (want && norm(text).includes(want)) {
      return { ...out, outcome: 'live', evidence: `title "${clip(t.title, 80)}" shown on the page` };
    }
    const landedElsewhere = new URL(finalUrl).host !== u.host || new URL(finalUrl).pathname !== u.pathname;
    if (landedElsewhere) return { ...out, outcome: 'redirected', evidence: clip(`landed on ${finalUrl}`) };
    return { ...out, outcome: 'unclear', evidence: clip(`title not found; page starts: ${text.slice(0, 120)}`) };
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ---- main -----------------------------------------------------------------
async function main() {
  const started = new Date();
  const report = { generatedAt: started.toISOString(), runner: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local', results: [] };
  let targets = [];
  try {
    targets = (JSON.parse(await readFile(TARGETS, 'utf8')).targets || []).filter(t => t && t.url);
  } catch (err) {
    report.error = `could not read targets: ${clip(err.message, 120)}`;
  }
  if (targets.length > MAX_TARGETS) {
    report.skipped = targets.length - MAX_TARGETS;
    targets = targets.slice(0, MAX_TARGETS);
  }
  if (targets.length) {
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
    } catch (err) {
      report.error = `browser failed: ${clip(err.message, 160)}`;
    } finally {
      if (browser) await browser.close().catch(() => {});
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
