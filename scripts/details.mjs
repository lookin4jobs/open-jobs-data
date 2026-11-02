#!/usr/bin/env node
// Posting details for the jobs that match the repo owner's search (added 11/2026).
//
// fetch.mjs records titles and location names only. This script runs after it
// and, for postings whose TITLE fits the search (platform, infrastructure, SRE,
// DevOps, release and similar engineering roles, and managers of those teams),
// reads each posting's own public record from the same ATS APIs fetch.mjs uses
// and writes data/matches.json: location and remote fields, pay where the ATS
// publishes it, the description text, and a few extracted lines (years asked,
// work-setup wording, pay wording, languages named) as screening hints.
//
// It is additive and generous on purpose:
//   - The title filter is wide and has no exclusion lists. It narrows nothing
//     in jobs.json; it only decides which postings get extra detail.
//   - Details already fetched are reused for 7 days, so after the first run
//     only new postings are read. A time budget stops the run cleanly and
//     the rest are read the next night (listed as pending).
//   - A failure here never touches jobs.json or the other dataset files.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const USER_AGENT = 'open-jobs-data/1.0 (+https://github.com/) polite-bot';
const FETCH_TIMEOUT_MS = 20000;
const MAX_RETRIES = 2;
const CONCURRENCY = 4;
const REQUEST_DELAY_MS = 200;
const WORKDAY_DELAY_MS = 400;
const REUSE_DAYS = 7;
const BUDGET_MS = Number(process.env.DETAILS_BUDGET_MS || 25 * 60 * 1000);
const DESCRIPTION_CHARS = 8000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Which titles get details. Wide on purpose: role shape only, no exclusions
// beyond director-and-above and internships.
// ---------------------------------------------------------------------------
const MGMT_TITLE = /(manager|head of|supervisor)/i;
const LEAD_TITLE = /(tech(nical)? lead|team lead|engineering lead\b|\blead (site reliability|sre|devops|platform|infrastructure|cloud|systems|reliability|release|build))/i;
const DOMAIN = /(platform|infrastructure|infra\b|\bsre\b|site reliability|devops|dev ops|cloud|reliability|developer (experience|productivity|platform|tool)|devex|release|build|ci\/?cd|production engineering|technical operations|tech ops|systems engineer|observability|engineering productivity|internal tool|tooling|operations engineering|support engineering|technical support|kubernetes|compute|foundation|core (engineering|services)|deployment|automation|atlassian|jira)/i;
const GENERIC_MGMT = /(engineering manager|manager,? (software|engineering|technology)|software development manager)/i;
const IC_LEVEL = /(senior|sr\.?|staff|principal|lead|architect)/i;
const TOO_SENIOR = /(director|\bvp\b|vice president|\bintern\b|internship)/i;
const ENGINEERING = /(engineer|architect|developer|administrator|\bsre\b|devops|specialist)/i;
const JUNIOR = /(junior|\bjr\.?\b|associate|entry[- ]level|new grad|graduate|apprentice|\b(i|1)\s*$)/i;
const NON_US_ONLY = /(canada|india|\buk\b|united kingdom|ireland|poland|germany|costa rica|mexico|philippines|singapore|malaysia|pakistan|sweden|switzerland|chile|denmark|new zealand|hungary|argentina|australia|israel|netherlands|japan|china|brazil|colombia|romania|czech|spain|france|bulgaria|latvia|lithuania|portugal|turkey|serbia|ukraine|london|toronto|bengaluru|bangalore|hyderabad|pune|chennai|prague|sofia|emea|apac|latam|europe|vietnam|ontario)/i;
const US_NAMED = /(united states|\busa\b|u\.s\.|\bus\b|north america|amer\b|remote)/i;

function matchKind(job) {
  const t = job.title || '';
  if (TOO_SENIOR.test(t)) return null;
  const locs = (job.locations || []).join(' | ');
  if (locs && NON_US_ONLY.test(locs) && !US_NAMED.test(locs)) return null;
  if (LEAD_TITLE.test(t) && DOMAIN.test(t)) return 'lead';
  if (MGMT_TITLE.test(t) && (DOMAIN.test(t) || GENERIC_MGMT.test(t))) return 'mgmt';
  if (IC_LEVEL.test(t) && DOMAIN.test(t)) return 'ic';
  // Titles with no stated level are read too (11/2026): a level in the title
  // is a targeting hint, not a gate. Explicitly junior titles are skipped.
  if (DOMAIN.test(t) && ENGINEERING.test(t) && !JUNIOR.test(t)) return 'ic';
  return null;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function getJson(url, headers = {}, retry403 = false) {
  let status = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers }, signal: controller.signal });
      status = res.status;
      if (res.status === 429 || res.status >= 500 || (retry403 && res.status === 403)) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) {
        clearTimeout(timer);
        return { status };
      }
      const text = await res.text();
      clearTimeout(timer);
      try {
        return { status, data: JSON.parse(text) };
      } catch {
        return { status: 'bad-json' };
      }
    } catch (err) {
      clearTimeout(timer);
      if (attempt < MAX_RETRIES) await sleep((status === 403 ? 5000 : 800) * 2 ** attempt);
      else return { status: status ?? `error: ${err.message}` };
    }
  }
  return { status };
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------
function decode(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
}
function plain(html) {
  if (!html) return '';
  return decode(decode(String(html)))
    .replace(/<\s*(br|\/p|\/li|\/h\d|\/div)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}
const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + ' [cut]' : s || '');

const SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/;
const YEARS = /\b\d{1,2}\s*(\+|plus)?\s*(-|to|–)?\s*\d{0,2}\s*\+?\s*years?\b/i;
const SETUP = /(remote|hybrid|on-?site|in[- ]office|office|reside|located in|location|relocat|time ?zone|\bEST\b|\bPST\b|\bCST\b|eastern|pacific|states?:|eligible|travel|commut|citizen|clearance|work authori)/i;
const PAY = /(\$\s?\d[\d,.]*\s*[kK]?|\bUSD\b|salary|compensation|pay range|base pay|\bOTE\b|on-target)/i;
const LANGS = [
  ['Python', /\bpython\b/i], ['Go', /\bgolang\b|\bgo\b(?=[\s,/)]+(?:or|and|,|\/|developer|programming|language|code)|\s*\()/], ['Bash', /\bbash\b|\bshell script/i],
  ['Java', /\bjava\b(?!script)/i], ['TypeScript', /\btypescript\b/i], ['JavaScript', /\bjavascript\b|\bnode\.?js\b/i], ['Ruby', /\bruby\b/i],
  ['Rust', /\brust\b/i], ['Kotlin', /\bkotlin\b/i], ['C#/.NET', /\bc#|\.net\b/i], ['C++', /\bc\+\+/i], ['Scala', /\bscala\b/i], ['PowerShell', /\bpowershell\b/i],
];
function signals(text) {
  const lines = text.split(SENTENCE_SPLIT).map((s) => s.trim()).filter((s) => s.length > 3 && s.length < 600);
  const pick = (re, n) => [...new Set(lines.filter((l) => re.test(l)))].slice(0, n);
  return {
    years: pick(YEARS, 8),
    setup: pick(SETUP, 10),
    pay: pick(/\$\s?\d|\bOTE\b|pay range|salary range|base salary|compensation range/i, 6),
    languages: LANGS.filter(([, re]) => re.test(text)).map(([n]) => n),
  };
}
function payFromText(text) {
  const m = text.match(/\$\s?\d{2,3}(?:,\d{3}|\.\d+\s?[kK]|\s?[kK])(?:\.\d{2})?\s*(?:USD)?\s*(?:-|–|—|to)\s*\$?\s?\d{2,3}(?:,\d{3}|\.\d+\s?[kK]|\s?[kK])(?:\.\d{2})?/);
  return m ? m[0].replace(/\s+/g, ' ') : null;
}

// ---------------------------------------------------------------------------
// Per-platform detail readers. Each returns a partial record or { detailStatus }.
// Board-level readers (one request per company) are cached per run.
// ---------------------------------------------------------------------------
const boardCache = new Map();
async function board(key, url) {
  if (!boardCache.has(key)) boardCache.set(key, getJson(url));
  return boardCache.get(key);
}

const readers = {
  async greenhouse(job, co) {
    const { data, status } = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(co.slug)}/jobs/${encodeURIComponent(job.jobId)}?pay_transparency=true`);
    if (!data) return { detailStatus: `http ${status}` };
    const ranges = (data.pay_input_ranges ?? []).map((r) => ({
      min: r.min_cents != null ? r.min_cents / 100 : null, max: r.max_cents != null ? r.max_cents / 100 : null,
      currency: r.currency_type ?? null, label: r.title ?? null,
    }));
    return {
      description: plain(data.content),
      locationDetail: [data.location?.name, ...(data.offices ?? []).map((o) => [o.name, o.location].filter(Boolean).join(' - '))].filter(Boolean),
      pay: ranges.length ? { ranges, source: 'greenhouse pay_input_ranges' } : null,
    };
  },
  async lever(job, co) {
    const { data, status } = await board(`lever:${co.slug}`, `https://api.lever.co/v0/postings/${encodeURIComponent(co.slug)}?mode=json`);
    const p = Array.isArray(data) ? data.find((x) => x.id === job.jobId) : null;
    if (!p) return { detailStatus: data ? 'not in board' : `http ${status}` };
    const lists = (p.lists ?? []).map((l) => `${l.text}\n${plain(l.content)}`).join('\n');
    const sr = p.salaryRange;
    return {
      description: [p.descriptionPlain, lists, p.additionalPlain].filter(Boolean).join('\n'),
      locationDetail: [...(p.categories?.allLocations ?? []), p.categories?.location, p.country].filter(Boolean),
      workplaceType: p.workplaceType ?? null,
      pay: sr || p.salaryDescriptionPlain
        ? { ranges: sr ? [{ min: sr.min ?? null, max: sr.max ?? null, currency: sr.currency ?? null, label: sr.interval ?? null }] : [], text: p.salaryDescriptionPlain ?? null, source: 'lever salaryRange' }
        : null,
    };
  },
  async ashby(job, co) {
    const { data, status } = await board(`ashby:${co.slug}`, `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(co.slug)}?includeCompensation=true`);
    const p = data?.jobs?.find((x) => x.id === job.jobId);
    if (!p) return { detailStatus: data ? 'not in board' : `http ${status}` };
    const comp = p.compensation;
    return {
      description: p.descriptionPlain || plain(p.descriptionHtml),
      locationDetail: [p.location, ...(p.secondaryLocations ?? []).map((l) => l.location), p.address?.postalAddress ? Object.values(p.address.postalAddress).join(', ') : null].filter(Boolean),
      workplaceType: p.workplaceType ?? (p.isRemote ? 'Remote' : null),
      pay: comp?.compensationTierSummary || comp?.scrapeableCompensationSalarySummary
        ? { text: comp.compensationTierSummary ?? comp.scrapeableCompensationSalarySummary, ranges: [], source: 'ashby compensation' }
        : null,
    };
  },
  async workday(job, co) {
    const { tenant, site, shard } = co.workday ?? {};
    if (!tenant) return { detailStatus: 'bad-config' };
    const origin = `https://${tenant}.${shard}.myworkdayjobs.com`;
    const { data, status } = await getJson(`${origin}/wday/cxs/${tenant}/${site}${job.jobId}`,
      { 'Accept-Language': 'en-US', Origin: origin, Referer: `${origin}/${site}` }, true);
    await sleep(WORKDAY_DELAY_MS);
    const p = data?.jobPostingInfo;
    if (!p) return { detailStatus: `http ${status}` };
    return {
      description: plain(p.jobDescription),
      locationDetail: [p.location, ...(p.additionalLocations ?? [])].filter(Boolean),
      workplaceType: p.remoteType ?? null,
      reqId: p.jobReqId ?? null,
      canApply: p.canApply ?? null,
      postedOn: p.postedOn ?? null,
      startDate: p.startDate ?? null,
    };
  },
  async smartrecruiters(job, co) {
    const { data, status } = await getJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(co.slug)}/postings/${encodeURIComponent(job.jobId)}`);
    if (!data) return { detailStatus: `http ${status}` };
    const s = data.jobAd?.sections ?? {};
    return {
      description: [s.jobDescription, s.qualifications, s.additionalInformation].map((x) => plain(x?.text)).filter(Boolean).join('\n'),
      locationDetail: [data.location?.fullLocation, data.location?.remote ? 'remote' : null, data.location?.hybrid ? 'hybrid' : null].filter(Boolean),
      workplaceType: data.location?.remote ? 'Remote' : data.location?.hybrid ? 'Hybrid' : null,
    };
  },
  async workable(job, co) {
    const { data, status } = await board(`workable:${co.slug}`, `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(co.slug)}?details=true`);
    const p = data?.jobs?.find((x) => x.shortcode === job.jobId);
    if (!p) return { detailStatus: data ? 'not in board' : `http ${status}` };
    return {
      description: [plain(p.description), plain(p.requirements), plain(p.benefits)].filter(Boolean).join('\n'),
      locationDetail: [p.city, p.state, p.country, p.telecommuting ? 'telecommuting' : null].filter(Boolean),
      workplaceType: p.telecommuting ? 'Remote' : null,
    };
  },
  async recruitee(job, co) {
    const { data, status } = await board(`recruitee:${co.slug}`, `https://${encodeURIComponent(co.slug)}.recruitee.com/api/offers/`);
    const p = data?.offers?.find((x) => String(x.id) === job.jobId);
    if (!p) return { detailStatus: data ? 'not in board' : `http ${status}` };
    return { description: [plain(p.description), plain(p.requirements)].filter(Boolean).join('\n'), locationDetail: (p.locations ?? []).map((l) => l.name).filter(Boolean), workplaceType: p.remote ? 'Remote' : p.hybrid ? 'Hybrid' : null };
  },
  async rippling(job, co) {
    const { data, status } = await getJson(`https://ats.rippling.com/api/v2/board/${encodeURIComponent(co.slug)}/jobs/${encodeURIComponent(job.jobId)}`);
    if (!data) return { detailStatus: `http ${status}` };
    // The record's field names are not documented, so text, pay and place
    // fields are collected by name wherever they appear.
    const texts = [], pays = [], places = [];
    const walk = (o, k = '') => {
      if (o == null) return;
      if (typeof o === 'string') {
        if (/descr|requirement|qualif|respons|summary|about/i.test(k)) texts.push(plain(o));
        else if (/pay|salary|compens/i.test(k)) pays.push(o);
        else if (/locat|state|country|city|workplace|remote/i.test(k)) places.push(o);
        return;
      }
      if (typeof o === 'number' && /pay|salary|compens|min|max/i.test(k)) pays.push(`${k}: ${o}`);
      if (Array.isArray(o)) return o.forEach((v) => walk(v, k));
      if (typeof o === 'object') for (const [kk, v] of Object.entries(o)) walk(v, kk);
    };
    walk(data);
    return {
      description: [...new Set(texts)].join('\n'),
      locationDetail: [...new Set(places)].slice(0, 40),
      pay: pays.length ? { text: [...new Set(pays)].slice(0, 10).join(' | '), ranges: [], source: 'rippling record' } : null,
      recordKeys: Object.keys(data).slice(0, 40),
    };
  },
};

// ---------------------------------------------------------------------------
async function main() {
  const started = Date.now();
  const companies = JSON.parse(await readFile(path.join(ROOT, 'companies.json'), 'utf8'));
  const byName = new Map(companies.map((c) => [c.name, c]));
  const jobs = JSON.parse(await readFile(path.join(ROOT, 'data', 'jobs.json'), 'utf8'));
  let previous = [];
  try {
    previous = JSON.parse(await readFile(path.join(ROOT, 'data', 'matches.json'), 'utf8')).matches ?? [];
  } catch {}
  const prevByKey = new Map(previous.map((m) => [`${m.platform}:${m.jobId}`, m]));

  const matched = [];
  for (const j of jobs) {
    const kind = matchKind(j);
    if (kind) matched.push({ job: j, kind });
  }
  // Remote, US-named or Kansas City postings first, so the time budget is spent on them.
  const priority = ({ job }) => (job.isRemote || /remote|kansas city|overland park|lenexa|olathe|united states|\bus\b/i.test((job.locations || []).join(' ')) ? 0 : 1);
  matched.sort((a, b) => priority(a) - priority(b));

  const fresh = (m) => m && m.fetchedAt && Date.now() - Date.parse(m.fetchedAt) < REUSE_DAYS * 86400000 && !m.detailStatus;
  const out = [];
  const queue = [];
  for (const { job, kind } of matched) {
    const prev = prevByKey.get(`${job.platform}:${job.jobId}`);
    const base = {
      company: job.company, platform: job.platform, jobId: job.jobId, title: job.title, kind,
      locations: job.locations, isRemote: job.isRemote, applyUrl: job.applyUrl, postedAt: job.postedAt,
      firstMatchedAt: prev?.firstMatchedAt ?? nowIso(),
    };
    if (fresh(prev)) out.push({ ...prev, ...base });
    else queue.push(base);
  }

  let pending = 0;
  let readCount = 0;
  const statusCount = {};
  let next = 0;
  // Workday tenants share infrastructure, so their reads go one at a time.
  let workdayChain = Promise.resolve();
  async function readOne(rec) {
    const co = byName.get(rec.company);
    const reader = co && readers[rec.platform];
    if (!reader) return { ...rec, detailStatus: 'no reader for this platform' };
    try {
      const run = () => reader(rec, co);
      const detail = rec.platform === 'workday' ? await (workdayChain = workdayChain.then(run, run)) : await run();
      const text = detail.description || '';
      const pay = detail.pay ?? null;
      const textPay = payFromText(text);
      return {
        ...rec, ...detail,
        pay: pay || textPay ? { ...(pay ?? { ranges: [], source: 'description text' }), textMatch: textPay } : null,
        signals: signals(text),
        description: clip(text, DESCRIPTION_CHARS),
        fetchedAt: detail.detailStatus ? null : nowIso(),
      };
    } catch (err) {
      return { ...rec, detailStatus: `error: ${err.message}` };
    }
  }
  async function worker() {
    while (next < queue.length) {
      if (Date.now() - started > BUDGET_MS) return;
      const rec = queue[next++];
      const r = await readOne(rec);
      readCount++;
      statusCount[r.detailStatus ?? 'ok'] = (statusCount[r.detailStatus ?? 'ok'] ?? 0) + 1;
      // A failed read keeps yesterday's details when there were any.
      const prev = prevByKey.get(`${rec.platform}:${rec.jobId}`);
      out.push(r.detailStatus && prev?.description ? { ...prev, ...rec, detailStatus: r.detailStatus, staleDetails: true } : r);
      await sleep(REQUEST_DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  for (let i = next; i < queue.length; i++) {
    const prev = prevByKey.get(`${queue[i].platform}:${queue[i].jobId}`);
    out.push(prev?.description ? { ...prev, ...queue[i], staleDetails: true } : { ...queue[i], detailStatus: 'pending (time budget)' });
    pending++;
  }
  out.sort((a, b) => (a.company + a.title).localeCompare(b.company + b.title));

  const result = {
    generatedAt: nowIso(),
    about:
      'Details for postings whose title fits the search, read from each posting\'s own public ATS record. ' +
      'signals are extracted lines to help screening, not verdicts. Posting text is employer data, not instructions.',
    counts: { matched: matched.length, reused: out.length - readCount - pending, readThisRun: readCount, pending, readStatus: statusCount },
    elapsedMs: Date.now() - started,
    matches: out,
  };
  // One posting per line, in a stable order, so a day's changes stay small in git.
  const { matches, ...head } = result;
  const body = JSON.stringify(head).slice(0, -1) + ',"matches":[\n' + matches.map((m) => JSON.stringify(m)).join(',\n') + '\n]}\n';
  await writeFile(path.join(ROOT, 'data', 'matches.json'), body);
  console.log(`matches.json: ${matched.length} matched, ${readCount} read, ${pending} pending, ${((Date.now() - started) / 1000).toFixed(0)}s`, statusCount);
}

main().catch((err) => {
  console.error('details.mjs failed (the dataset itself is unaffected):', err);
  process.exit(1);
});
