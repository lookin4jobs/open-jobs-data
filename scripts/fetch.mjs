#!/usr/bin/env node
// Standalone, zero-dependency fetcher for the open-jobs-data dataset.
//
// Reads companies.json (a fixed, curated list of companies + their ATS platform
// and slug/board URL), fetches each company's public job postings feed, and
// normalizes everything into one schema. Writes data/jobs.json, data/jobs.csv,
// and data/summary.json.
//
// This is intentionally narrow: it only works for the platforms and companies
// listed in companies.json. It does not auto-detect a company's ATS, does not
// dedupe across platforms, and does not accept an arbitrary company list at
// runtime. For that, see the paid Apify actor linked in the README.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const CONCURRENCY = 5;
const REQUEST_DELAY_MS = 150;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;
const FETCH_TIMEOUT_MS = 20000;
const USER_AGENT = 'open-jobs-data/1.0 (+https://github.com/) polite-bot';
// Workday tenants all sit on the same Workday infrastructure, so they are
// fetched one tenant at a time with a longer pause, and a 403 is retried after
// a few seconds instead of being treated as a missing board.
const WORKDAY_DELAY_MS = 400;
const WORKDAY_403_BACKOFF_MS = 5000;
// Companies that fail on the first pass get one more try at the end of the run.
const RETRY_PASS_WAIT_MS = 60000;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

// NOTE: the abort timeout must stay armed until the response body has been
// fully read, not just until headers arrive. fetch() resolving only means
// headers are in; the body is read lazily via res.text(), and if we clear the
// timeout as soon as fetch() resolves, that body read has no timeout
// protection at all and can hang forever on a stalled connection. So we read
// the body *inside* the try block, still under the same AbortController, and
// only clear the timeout once that's done (success or failure).
async function fetchWithRetryText(url, options = {}) {
  let lastErr;
  let lastStatus = null;
  const { retry403, ...fetchOptions } = options;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        ...fetchOptions,
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json,text/xml,*/*', ...(fetchOptions.headers || {}) },
      });
      // Some platforms (Personio, BambooHR) 302 to a marketing page for an
      // unknown/inactive slug instead of returning a real 404.
      if (res.status >= 300 && res.status < 400) {
        clearTimeout(timeout);
        return { notFound: true, status: res.status };
      }
      if (res.status === 404 || res.status === 422) {
        clearTimeout(timeout);
        return { notFound: true, status: res.status };
      }
      if (res.status === 429 || res.status >= 500 || (options.retry403 && res.status === 403)) {
        lastStatus = res.status;
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) {
        clearTimeout(timeout);
        return { notFound: true, status: res.status };
      }
      const text = await res.text();
      clearTimeout(timeout);
      return { text };
    } catch (err) {
      clearTimeout(timeout);
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        const base = lastStatus === 403 ? WORKDAY_403_BACKOFF_MS : RETRY_BASE_MS;
        const backoff = base * 2 ** attempt + Math.random() * 200;
        await sleep(backoff);
        continue;
      }
    }
  }
  // A 403 that never cleared is reported as not-found with its status, so the
  // summary shows that the board refused us rather than that it is gone.
  if (lastStatus === 403) return { notFound: true, status: 403 };
  throw lastErr ?? new Error('fetch failed');
}

async function getJson(url) {
  const { text, notFound, status } = await fetchWithRetryText(url);
  if (notFound) return { notFound: true, status };
  try {
    return { data: JSON.parse(text) };
  } catch {
    return { notFound: true, status: 'bad-json' };
  }
}

async function getText(url) {
  const { text, notFound, status } = await fetchWithRetryText(url);
  if (notFound) return { notFound: true, status };
  return { data: text };
}

async function postJson(url, body, extra = {}) {
  const { headers: extraHeaders, ...rest } = extra;
  const { text, notFound, status } = await fetchWithRetryText(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
    body: JSON.stringify(body),
    ...rest,
  });
  if (notFound) return { notFound: true, status };
  try {
    return { data: JSON.parse(text) };
  } catch {
    return { notFound: true, status: 'bad-json' };
  }
}

// Lets only one Workday tenant fetch at a time while other platforms run in parallel.
let workdayQueue = Promise.resolve();
function workdayGate() {
  let release;
  const next = new Promise((r) => (release = r));
  const wait = workdayQueue;
  workdayQueue = workdayQueue.then(() => next);
  return wait.then(() => release);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Small shared utilities (mirrors the paid actor's logic, reimplemented)
// ---------------------------------------------------------------------------

function detectRemote(locations, explicit) {
  if (typeof explicit === 'boolean') return explicit;
  if (locations.some((l) => /remote/i.test(l))) return true;
  return null;
}

function stripHtml(html) {
  if (!html) return null;
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function nowIso() {
  return new Date().toISOString();
}

function baseJob(overrides) {
  return {
    company: null,
    platform: null,
    jobId: null,
    title: null,
    department: null,
    locations: [],
    isRemote: null,
    employmentType: null,
    applyUrl: null,
    postedAt: null,
    scrapedAt: nowIso(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Platform fetchers — each returns { jobs, notFound, error }
// ---------------------------------------------------------------------------

const platforms = {
  async greenhouse(company) {
    const slug = company.slug;
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=false`;
    const { data, notFound } = await getJson(url);
    if (notFound) return { jobs: [], notFound: true };
    return {
      jobs: (data.jobs ?? []).map((job) => {
        const locations = job.location?.name ? [job.location.name] : [];
        return baseJob({
          company: company.name,
          platform: 'greenhouse',
          jobId: String(job.id),
          title: job.title,
          department: job.departments?.[0]?.name ?? null,
          locations,
          isRemote: detectRemote(locations),
          employmentType: null,
          applyUrl: job.absolute_url,
          postedAt: job.first_published ?? null,
        });
      }),
    };
  },

  async lever(company) {
    const slug = company.slug;
    const url = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
    const { data, notFound } = await getJson(url);
    if (notFound) return { jobs: [], notFound: true };
    if (!Array.isArray(data)) return { jobs: [], notFound: true };
    return {
      jobs: data.map((job) => {
        const locations = job.categories?.allLocations?.length
          ? job.categories.allLocations
          : job.categories?.location
          ? [job.categories.location]
          : [];
        const workplaceRemote =
          job.workplaceType === 'remote' ? true : job.workplaceType === 'on-site' ? false : null;
        return baseJob({
          company: company.name,
          platform: 'lever',
          jobId: job.id,
          title: job.text,
          department: job.categories?.department ?? null,
          locations,
          isRemote: detectRemote(locations, workplaceRemote),
          employmentType: job.categories?.commitment ?? null,
          applyUrl: job.applyUrl ?? job.hostedUrl,
          postedAt: job.createdAt ? new Date(job.createdAt).toISOString() : null,
        });
      }),
    };
  },

  async ashby(company) {
    const slug = company.slug;
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`;
    const { data, notFound } = await getJson(url);
    if (notFound) return { jobs: [], notFound: true };
    return {
      jobs: (data.jobs ?? []).map((job) => {
        const locations = [
          ...(job.location ? [job.location] : []),
          ...(job.secondaryLocations?.map((l) => l.location) ?? []),
        ];
        return baseJob({
          company: company.name,
          platform: 'ashby',
          jobId: job.id,
          title: job.title.trim(),
          department: job.department ?? null,
          locations,
          isRemote: detectRemote(locations, job.isRemote ?? null),
          employmentType: job.employmentType ?? null,
          applyUrl: job.applyUrl ?? job.jobUrl,
          postedAt: job.publishedAt ?? null,
        });
      }),
    };
  },

  async workday(company) {
    const { tenant, site, shard, searchTexts } = company.workday ?? {};
    if (!tenant || !site || !shard) return { jobs: [], notFound: true, status: 'bad-config' };
    const release = await workdayGate();
    try {
    const origin = `https://${tenant}.${shard}.myworkdayjobs.com`;
    const reqOpts = {
      retry403: true,
      headers: { Accept: 'application/json', 'Accept-Language': 'en-US', Origin: origin, Referer: `${origin}/${site}` },
    };
    const baseUrl = `https://${tenant}.${shard}.myworkdayjobs.com/wday/cxs/${tenant}/${site}`;
    const PAGE_SIZE = 20;
    const MAX_JOBS = 500;
    // Large tenants list thousands of jobs and the 500 cap cuts most of them off.
    // An optional searchTexts array runs one keyword search per term (each capped
    // at 500) and merges the results, so the roles we care about stay in range.
    const searches = Array.isArray(searchTexts) && searchTexts.length ? searchTexts : [''];
    const byPath = new Map();
    let anyFound = false;
    let lastStatus = null;
    const failedSearches = [];
    for (const searchText of searches) {
      let offset = 0;
      let total = Infinity;
      let fetched = 0;
      while (offset < total && fetched < MAX_JOBS) {
        const limit = Math.min(PAGE_SIZE, MAX_JOBS - fetched);
        const { data, notFound, status } = await postJson(`${baseUrl}/jobs`, { appliedFacets: {}, limit, offset, searchText }, reqOpts);
        if (notFound) {
          lastStatus = status;
          failedSearches.push({ searchText, offset, status });
          break;
        }
        anyFound = true;
        if (offset === 0) total = data.total ?? 0;
        if (!data.jobPostings || data.jobPostings.length === 0) break;
        for (const p of data.jobPostings) {
          if (p.externalPath && !byPath.has(p.externalPath)) byPath.set(p.externalPath, p);
        }
        fetched += data.jobPostings.length;
        offset += data.jobPostings.length;
        await sleep(WORKDAY_DELAY_MS);
      }
    }
    if (!anyFound) return { jobs: [], notFound: true, status: lastStatus };
    const postings = [...byPath.values()];
    return {
      // Non-empty when some searches or pages failed after others worked. The
      // company is then incomplete, so a missing job is not evidence it closed.
      failedSearches,
      jobs: postings.map((posting) => {
        const locations = posting.locationsText ? [posting.locationsText] : [];
        const explicitRemote =
          posting.remoteType === 'Remote' ? true : posting.remoteType === 'On-Site' || posting.remoteType === 'Onsite' ? false : null;
        return baseJob({
          company: company.name,
          platform: 'workday',
          jobId: posting.externalPath,
          title: posting.title,
          department: null,
          locations,
          isRemote: detectRemote(locations, explicitRemote),
          employmentType: posting.timeType ?? null,
          applyUrl: `https://${tenant}.${shard}.myworkdayjobs.com/${site}${posting.externalPath}`,
          postedAt: null,
        });
      }),
    };
    } finally {
      release();
    }
  },

  async smartrecruiters(company) {
    const slug = company.slug;
    const PAGE_SIZE = 100;
    const MAX_JOBS = 500;
    const searches = Array.isArray(company.searchTexts) && company.searchTexts.length ? company.searchTexts : [''];
    const byId = new Map();
    let anyFound = false;
    for (const q of searches) {
      let offset = 0;
      let totalFound = Infinity;
      let fetched = 0;
      while (offset < totalFound && fetched < MAX_JOBS) {
        const limit = Math.min(PAGE_SIZE, MAX_JOBS - fetched);
        const qs = q ? `&q=${encodeURIComponent(q)}` : '';
        const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=${limit}&offset=${offset}${qs}`;
        const { data, notFound } = await getJson(url);
        if (notFound) break;
        anyFound = true;
        totalFound = data.totalFound ?? 0;
        if (!data.content || data.content.length === 0) break;
        for (const j of data.content) if (!byId.has(j.id)) byId.set(j.id, j);
        fetched += data.content.length;
        offset += data.content.length;
        await sleep(REQUEST_DELAY_MS);
      }
    }
    if (!anyFound) return { jobs: [], notFound: true };
    const jobs = [...byId.values()];
    return {
      jobs: jobs.map((job) => {
        const locations = job.location?.fullLocation ? [job.location.fullLocation] : [];
        return baseJob({
          company: company.name,
          platform: 'smartrecruiters',
          jobId: job.id,
          title: job.name,
          department: job.department?.label ?? job.function?.label ?? null,
          locations,
          isRemote: detectRemote(locations, job.location?.remote ?? null),
          employmentType: job.typeOfEmployment?.label ?? null,
          applyUrl: `https://jobs.smartrecruiters.com/${encodeURIComponent(job.company?.identifier ?? slug)}/${job.id}`,
          postedAt: job.releasedDate ?? null,
        });
      }),
    };
  },

  async workable(company) {
    const slug = company.slug;
    const url = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=false`;
    const { data, notFound } = await getJson(url);
    if (notFound) return { jobs: [], notFound: true };
    return {
      jobs: (data.jobs ?? []).map((job) => {
        const locations = [job.city, job.state, job.country].filter(Boolean);
        return baseJob({
          company: company.name,
          platform: 'workable',
          jobId: job.shortcode,
          title: job.title,
          department: job.department ?? null,
          locations,
          isRemote: detectRemote(locations, job.telecommuting ?? null),
          employmentType: job.employment_type ?? null,
          applyUrl: job.application_url ?? job.shortlink ?? job.url ?? `https://apply.workable.com/j/${job.shortcode}`,
          postedAt: job.published_on ?? null,
        });
      }),
    };
  },

  async recruitee(company) {
    const slug = company.slug;
    const url = `https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`;
    const { data, notFound } = await getJson(url);
    if (notFound) return { jobs: [], notFound: true };
    return {
      jobs: (data.offers ?? []).map((offer) => {
        const locations = offer.locations?.length
          ? offer.locations.map((l) => l.name).filter(Boolean)
          : offer.location
          ? [offer.location]
          : [];
        const explicitRemote = offer.remote === true ? true : offer.hybrid === true ? null : offer.remote === false ? false : null;
        return baseJob({
          company: company.name,
          platform: 'recruitee',
          jobId: String(offer.id),
          title: offer.title,
          department: offer.department ?? null,
          locations,
          isRemote: detectRemote(locations, explicitRemote),
          employmentType: offer.employment_type_code ?? null,
          applyUrl: offer.careers_url,
          postedAt: offer.published_at ?? null,
        });
      }),
    };
  },

  async personio(company) {
    const slug = company.slug;
    const url = `https://${encodeURIComponent(slug)}.jobs.personio.de/xml`;
    const { data: xml, notFound } = await getText(url);
    if (notFound || !xml || !xml.includes('<position>')) return { jobs: [], notFound: true };
    const positions = parsePersonioXml(xml);
    return {
      jobs: positions.map((position) =>
        baseJob({
          company: company.name,
          platform: 'personio',
          jobId: position.id,
          title: position.name,
          department: position.department,
          locations: position.locations,
          isRemote: detectRemote(position.locations),
          employmentType: position.employmentType,
          applyUrl: `https://${slug}.jobs.personio.de/job/${position.id}`,
          postedAt: position.createdAt,
        })
      ),
    };
  },

  async bamboohr(company) {
    const slug = company.slug;
    const url = `https://${encodeURIComponent(slug)}.bamboohr.com/careers/list`;
    const { data: body, notFound } = await getText(url);
    if (notFound) return { jobs: [], notFound: true };
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return { jobs: [], notFound: true };
    }
    if (!Array.isArray(data.result)) return { jobs: [], notFound: true };
    return {
      jobs: data.result.map((job) => {
        const location = job.location ?? {};
        const atsLocation = job.atsLocation ?? {};
        const locations = [location.city, location.state, atsLocation.city, atsLocation.province, atsLocation.state, atsLocation.country]
          .filter((v, i, all) => Boolean(v) && all.indexOf(v) === i);
        return baseJob({
          company: company.name,
          platform: 'bamboohr',
          jobId: job.id,
          title: job.jobOpeningName.trim(),
          department: job.departmentLabel ?? null,
          locations,
          isRemote: detectRemote(locations, job.isRemote ?? null),
          employmentType: job.employmentStatusLabel ?? null,
          applyUrl: `https://${slug}.bamboohr.com/careers/${job.id}`,
          postedAt: null,
        });
      }),
    };
  },
};

function parsePersonioXml(xml) {
  const positions = [];
  const blocks = xml.match(/<position>[\s\S]*?<\/position>/g) ?? [];
  for (const block of blocks) {
    const id = matchTag(block, 'id');
    const name = matchTag(block, 'name');
    if (!id || !name) continue;
    const officeValues = [...block.matchAll(/<office>([\s\S]*?)<\/office>/g)].map((m) => m[1].trim());
    const locations = officeValues.flatMap((v) => v.split(',')).map((p) => p.trim()).filter(Boolean);
    positions.push({
      id,
      name: decodeEntities(name).trim(),
      department: matchTag(block, 'department'),
      employmentType: matchTag(block, 'employmentType'),
      locations,
      createdAt: matchTag(block, 'createdAt'),
    });
  }
  return positions;
}

function matchTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  if (!m) return null;
  const value = decodeEntities(m[1]).trim();
  return value.length > 0 ? value : null;
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

// ---------------------------------------------------------------------------
// Runner: bounded concurrency over companies.json, never let one failure sink the run
// ---------------------------------------------------------------------------

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
      await sleep(REQUEST_DELAY_MS);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

function xmlEscape(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function jobKey(job) {
  return `${job.platform}:${job.jobId}`;
}

function toRss(newJobs, meta) {
  const items = newJobs
    .map((job) => {
      const title = xmlEscape(`${job.title ?? 'Untitled role'} — ${job.company ?? 'Unknown company'}`);
      const link = xmlEscape(job.applyUrl ?? '');
      const locations = Array.isArray(job.locations) ? job.locations.join(', ') : '';
      const description = xmlEscape(
        [job.company, locations, job.platform].filter(Boolean).join(' · ')
      );
      const pubDate = new Date(job.firstSeenAt ?? Date.now()).toUTCString();
      const guid = xmlEscape(jobKey(job));
      return `    <item>
      <title>${title}</title>
      <link>${link}</link>
      <description>${description}</description>
      <pubDate>${pubDate}</pubDate>
      <guid isPermaLink="false">${guid}</guid>
    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>open-jobs-data — new postings since last snapshot</title>
    <link>https://github.com/ConorsCode/open-jobs-data</link>
    <description>Postings that appeared since the previous daily snapshot (${xmlEscape(
      meta.previousSnapshotAt ?? 'no previous snapshot'
    )}). This means "newly appeared in our data," not necessarily "posted today" — a company added to our tracked list will show all its jobs as new on that first run.</description>
    <language>en-us</language>
    <lastBuildDate>${new Date(meta.generatedAt).toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}

function toCsv(rows) {
  const headers = ['company', 'platform', 'jobId', 'title', 'department', 'locations', 'isRemote', 'employmentType', 'applyUrl', 'postedAt', 'scrapedAt'];
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = Array.isArray(v) ? v.join('; ') : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(','));
  }
  return lines.join('\n') + '\n';
}

async function readPreviousSnapshot() {
  try {
    const raw = await readFile(path.join(ROOT, 'data', 'jobs.json'), 'utf8');
    const jobs = JSON.parse(raw);
    if (!Array.isArray(jobs)) return null;
    return jobs;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    // Malformed previous file — treat like "no previous snapshot" rather than
    // crashing the whole run, but this is unusual enough to be worth a log.
    console.error('Could not parse previous data/jobs.json, treating as no previous snapshot:', err.message);
    return null;
  }
}

async function readPreviousSummary() {
  try {
    const raw = await readFile(path.join(ROOT, 'data', 'summary.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function main() {
  const companiesRaw = await readFile(path.join(ROOT, 'companies.json'), 'utf8');
  const companies = JSON.parse(companiesRaw);

  // Must be read BEFORE we overwrite data/jobs.json below.
  const previousJobs = await readPreviousSnapshot();
  const previousSummary = await readPreviousSummary();
  const previousSnapshotAt = previousSummary?.generatedAt ?? null;

  console.log(`Fetching ${companies.length} companies across ${new Set(companies.map((c) => c.platform)).size} platforms...`);

  const startedAt = Date.now();
  const perCompanyStatus = [];

  async function runOne(company, attempt) {
    const fetcher = platforms[company.platform];
    const entry = { company: company.name, platform: company.platform, attempt };
    if (!fetcher) return { entry: { ...entry, status: 'unsupported-platform', jobs: 0 }, jobs: [] };
    try {
      const { jobs, notFound, status, failedSearches } = await fetcher(company);
      if (notFound) return { entry: { ...entry, status: 'not-found', httpStatus: status ?? null, jobs: 0 }, jobs: [] };
      const ok = { ...entry, status: 'ok', jobs: jobs.length };
      if (failedSearches && failedSearches.length) {
        ok.status = 'partial';
        ok.failedSearches = failedSearches;
      }
      return { entry: ok, jobs };
    } catch (err) {
      return { entry: { ...entry, status: `error: ${err.message}`, jobs: 0 }, jobs: [] };
    }
  }

  const firstPass = await mapWithConcurrency(companies, CONCURRENCY, (company) => runOne(company, 1));
  const outcome = new Map(companies.map((c, i) => [c, firstPass[i]]));

  // One retry pass for anything that failed or came back partial, after a pause.
  const retry = companies.filter((c) => {
    const st = outcome.get(c).entry.status;
    return st !== 'ok' && st !== 'unsupported-platform';
  });
  if (retry.length) {
    console.log(`Retrying ${retry.length} companies after ${RETRY_PASS_WAIT_MS / 1000}s: ${retry.map((c) => c.name).join(', ')}`);
    await sleep(RETRY_PASS_WAIT_MS);
    const second = await mapWithConcurrency(retry, 2, (company) => runOne(company, 2));
    retry.forEach((c, i) => {
      const before = outcome.get(c);
      const after = second[i];
      // Keep whichever attempt got further.
      const rank = (r) => (r.entry.status === 'ok' ? 2 : r.entry.status === 'partial' ? 1 : 0);
      if (rank(after) > rank(before) || (rank(after) === rank(before) && after.jobs.length >= before.jobs.length)) {
        outcome.set(c, after);
      }
    });
  }
  for (const c of companies) perCompanyStatus.push(outcome.get(c).entry);
  const results = companies.map((c) => outcome.get(c).jobs);

  const allJobs = results.flat();
  const elapsedMs = Date.now() - startedAt;

  await mkdir(path.join(ROOT, 'data'), { recursive: true });

  // ---------------------------------------------------------------------
  // Diff against the previous snapshot BEFORE overwriting it.
  //
  // Semantics: "newSinceLastSnapshot" means a (platform, jobId) pair that
  // did not exist in the previous run's data/jobs.json. This is NOT the
  // same as "posted today" — postedAt (when platforms expose it) is the
  // platform's own claim about posting date; a job can appear here because
  // it's genuinely brand new, or because it belongs to a company that was
  // just added to companies.json and is appearing in our data for the
  // first time.
  //
  // To avoid the misleading "we just added a company, so all 40 of its
  // jobs are 'new'" case, we only count a job as new if its company was
  // ALSO present in the previous snapshot. Jobs from companies with no
  // presence in the previous snapshot (brand new company additions) are
  // excluded from new-jobs.json/xml entirely — see data/README.md.
  let newJobs = [];
  let firstRun = previousJobs === null;
  if (!firstRun) {
    const previousKeys = new Set(previousJobs.map(jobKey));
    const previousCompanies = new Set(previousJobs.map((j) => j.company));
    const generatedAt = nowIso();
    newJobs = allJobs
      .filter((job) => !previousKeys.has(jobKey(job)) && previousCompanies.has(job.company))
      .map((job) => ({ ...job, firstSeenAt: generatedAt }));
  }

  await writeFile(path.join(ROOT, 'data', 'jobs.json'), JSON.stringify(allJobs, null, 2) + '\n');
  await writeFile(path.join(ROOT, 'data', 'jobs.csv'), toCsv(allJobs));

  // new-jobs.json is a plain array, same convention as jobs.json, so the app
  // (and any other consumer) can treat it identically — just fewer rows,
  // each with an added firstSeenAt. Metadata (count, previousSnapshotAt,
  // first-run note) lives in summary.json, not duplicated here.
  const newJobsGeneratedAt = nowIso();
  await writeFile(path.join(ROOT, 'data', 'new-jobs.json'), JSON.stringify(newJobs, null, 2) + '\n');
  await writeFile(
    path.join(ROOT, 'data', 'new-jobs.xml'),
    toRss(newJobs, { generatedAt: newJobsGeneratedAt, previousSnapshotAt })
  );

  const byPlatform = {};
  const byCompany = {};
  for (const job of allJobs) {
    byPlatform[job.platform] = (byPlatform[job.platform] ?? 0) + 1;
    byCompany[job.company] = (byCompany[job.company] ?? 0) + 1;
  }

  const summary = {
    generatedAt: nowIso(),
    total: allJobs.length,
    byPlatform,
    byCompany,
    companiesAttempted: companies.length,
    companiesOk: perCompanyStatus.filter((s) => s.status === 'ok').length,
    companiesPartial: perCompanyStatus.filter((s) => s.status === 'partial').length,
    companiesFailed: perCompanyStatus.filter((s) => s.status !== 'ok' && s.status !== 'partial').length,
    elapsedMs,
    // "new since last snapshot" — see data/README.md for exact semantics
    // (appeared-in-data, not necessarily posted-today; excludes jobs whose
    // company wasn't present in the previous snapshot).
    newSinceLastSnapshot: newJobs.length,
    previousSnapshotAt,
    newSinceLastSnapshotFirstRun: firstRun,
    perCompanyStatus,
  };
  await writeFile(path.join(ROOT, 'data', 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

  console.log(`Done in ${(elapsedMs / 1000).toFixed(1)}s. Total jobs: ${allJobs.length}`);
  console.log('By platform:', byPlatform);
  console.log(`Companies ok: ${summary.companiesOk}/${summary.companiesAttempted}`);
  console.log(
    firstRun
      ? 'New-since-last-snapshot: first run, no previous snapshot to diff against (0 by definition).'
      : `New since last snapshot: ${newJobs.length} (previous snapshot: ${previousSnapshotAt})`
  );
  const failed = perCompanyStatus.filter((s) => s.status !== 'ok');
  if (failed.length) {
    console.log('Failed/empty companies:', failed.map((f) => `${f.company}(${f.platform}):${f.status}`).join(', '));
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
