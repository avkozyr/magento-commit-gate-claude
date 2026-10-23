#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const PHASES = ['baseline', 'before', 'after'];
const METRICS = [
    { key: 'score', label: 'Score', fmt: v => String(Math.round(v)), better: 'up' },
    { key: 'fcp', label: 'FCP', fmt: v => `${(v / 1000).toFixed(2)} s`, better: 'down', unit: v => (v / 1000).toFixed(2) },
    { key: 'lcp', label: 'LCP', fmt: v => `${(v / 1000).toFixed(2)} s`, better: 'down', unit: v => (v / 1000).toFixed(2) },
    { key: 'tbt', label: 'TBT', fmt: v => `${Math.round(v)} ms`, better: 'down', unit: v => String(Math.round(v)) },
    { key: 'cls', label: 'CLS', fmt: v => v.toFixed(3), better: 'down', unit: v => v.toFixed(3) },
    { key: 'si', label: 'SI', fmt: v => `${(v / 1000).toFixed(2)} s`, better: 'down', unit: v => (v / 1000).toFixed(2) },
    { key: 'weight', label: 'Weight', fmt: v => `${(v / 1048576).toFixed(1)} MB`, better: 'down', unit: v => (v / 1048576).toFixed(1) },
    { key: 'requests', label: 'Requests', fmt: v => String(Math.round(v)), better: 'down', unit: v => String(Math.round(v)) },
];

function die(msg) {
    process.stderr.write(`prod-lighthouse: ${msg}\n`);
    process.exit(2);
}

function usage() {
    process.stderr.write(`Usage: prod-lighthouse.mjs --phase baseline|before|after [--release TAG] [--site NAME] [--conf FILE] [--log FILE]
  --phase    baseline: reference run, before: just before deploy, after: just after deploy (adds delta vs before)
  --release  release tag the run belongs to (default: git describe --tags --abbrev=0)
  --site     only this site from the config (default: all)
  --conf     config file (default: .claude/prod-lighthouse-log.conf)
  --log      log file (default: LOG_FILE from config)
`);
    process.exit(1);
}

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const name = argv[i];
        if (!name.startsWith('--') || argv[i + 1] === undefined) {
            usage();
        }
        args[name.slice(2)] = argv[++i];
    }
    if (!PHASES.includes(args.phase)) {
        usage();
    }
    return args;
}

function git(...cmd) {
    try {
        return execFileSync('git', cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return '';
    }
}

function readConf(file) {
    if (!existsSync(file)) {
        die(`${file} missing — copy the template: cp .claude/skills/prod-lighthouse-log/prod-lighthouse-log.conf.dist ${file}`);
    }
    const conf = {};
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m) {
            conf[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
        }
    }
    const sites = Object.keys(conf)
        .filter(k => k.startsWith('SITE_'))
        .map(k => {
            const name = k.slice(5);
            if (!/^https?:\/\/[^/]+/.test(conf[k])) {
                die(`${k} must be a base URL like https://www.example.com`);
            }
            const pages = (conf[`PAGES_${name}`] || '').split(/\s+/).filter(Boolean).map(p => {
                const [page, ...path] = p.split('=');
                return { page, path: path.join('=') };
            });
            if (!pages.length || pages.some(p => !p.page || !p.path.startsWith('/'))) {
                die(`PAGES_${name} must be "name=/path name=/path ..."`);
            }
            return { name, base: conf[k].replace(/\/+$/, ''), pages };
        });
    if (!sites.length) {
        die(`${file} defines no SITE_<name>`);
    }
    return {
        version: conf.LIGHTHOUSE_VERSION || die('LIGHTHOUSE_VERSION missing'),
        runs: Number(conf.RUNS || 3),
        devices: (conf.DEVICES || 'mobile desktop').split(/\s+/).filter(Boolean),
        log: conf.LOG_FILE || 'docs/Performance/Prod-Lighthouse.md',
        sites,
    };
}

function lighthouse(version, url, device, out) {
    const args = ['-y', `lighthouse@${version}`, url,
        '--only-categories=performance', '--output=json', `--output-path=${out}`, '--quiet',
        '--max-wait-for-load=90000', '--chrome-flags=--headless=new'];
    if (device === 'desktop') {
        args.push('--preset=desktop');
    }
    const res = spawnSync('npx', args, { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 300000 });
    if (res.status !== 0 || !existsSync(out)) {
        return { error: (res.stderr || 'timeout').trim().split('\n').pop() };
    }
    const report = JSON.parse(readFileSync(out, 'utf8'));
    const a = report.audits;
    if (report.runtimeError || report.categories.performance.score === null) {
        return { error: report.runtimeError?.code || 'no performance score' };
    }
    return {
        score: report.categories.performance.score * 100,
        fcp: a['first-contentful-paint'].numericValue,
        lcp: a['largest-contentful-paint'].numericValue,
        tbt: a['total-blocking-time'].numericValue,
        cls: a['cumulative-layout-shift'].numericValue,
        si: a['speed-index'].numericValue,
        weight: a['total-byte-weight'].numericValue,
        requests: a['network-requests'].details.items.length,
    };
}

function median(values) {
    const s = [...values].sort((x, y) => x - y);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function measure(conf, sites) {
    const dir = mkdtempSync(join(tmpdir(), 'prod-lighthouse-'));
    const rows = [];
    try {
        for (const site of sites) {
            for (const { page, path } of site.pages) {
                for (const device of conf.devices) {
                    const url = site.base + path;
                    const ok = [];
                    const errors = [];
                    for (let i = 1; i <= conf.runs; i++) {
                        const r = lighthouse(conf.version, url, device, join(dir, `${site.name}-${page}-${device}-${i}.json`));
                        process.stderr.write(`${site.name} ${page} ${device} run ${i}/${conf.runs}: ${r.error ? `error ${r.error}` : `score ${Math.round(r.score)}`}\n`);
                        (r.error ? errors : ok).push(r.error ? r.error : r);
                    }
                    const row = { site: site.name, page, path, device, runs: ok.length, errors };
                    if (ok.length) {
                        for (const m of METRICS) {
                            row[m.key] = median(ok.map(r => r[m.key]));
                        }
                    }
                    rows.push(row);
                }
            }
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
    return rows;
}

function parseEntry(text, release, phase) {
    const head = new RegExp(`^## \\S+ ${release.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ${phase}$`, 'm');
    const m = head.exec(text);
    if (!m) {
        return null;
    }
    const rest = text.slice(m.index + m[0].length);
    const end = rest.search(/^## /m);
    const body = end === -1 ? rest : rest.slice(0, end);
    const prev = {};
    for (const line of body.split('\n')) {
        const cells = line.split('|').slice(1, -1).map(c => c.trim());
        if (cells.length !== 4 + METRICS.length || cells[0] === 'Site' || cells[0].startsWith('-')) {
            continue;
        }
        const values = {};
        METRICS.forEach((mt, i) => {
            const n = parseFloat(cells[4 + i]);
            if (!Number.isNaN(n)) {
                values[mt.key] = n;
            }
        });
        prev[`${cells[0]}|${cells[1]}|${cells[2]}`] = values;
    }
    return prev;
}

function cell(row, m, prev) {
    if (row[m.key] === undefined) {
        return 'error';
    }
    const v = m.fmt(row[m.key]);
    const before = prev?.[`${row.site}|${row.page}|${row.device}`]?.[m.key];
    if (before === undefined) {
        return v;
    }
    const shown = m.unit ? m.unit(row[m.key]) : v;
    const decimals = (shown.split('.')[1] || '').length;
    const diff = Number((parseFloat(shown) - before).toFixed(decimals));
    if (diff === 0) {
        return `${v} (=)`;
    }
    const sign = diff > 0 ? '+' : '−';
    const worse = m.better === 'up' ? diff < 0 : diff > 0;
    return `${v} (${sign}${Math.abs(diff).toFixed(decimals)}${worse ? ' ⚠' : ''})`;
}

function render(rows, meta, prev) {
    const lines = [
        `## ${meta.date} ${meta.release} ${meta.phase}`,
        '',
        `Commit \`${meta.commit}\`, measured ${meta.start}–${meta.end} UTC, Lighthouse ${meta.version}, median of ${meta.runs} runs, performance category only.` +
            (meta.phase === 'after' ? (prev ? ` Values in brackets: change vs \`${meta.release} before\`, ⚠ = worse.` : ` No \`${meta.release} before\` entry found, no delta.`) : ''),
        '',
        `| Site | Page | Device | URL | ${METRICS.map(m => m.label).join(' | ')} |`,
        `|${'---|'.repeat(4 + METRICS.length)}`,
    ];
    for (const row of rows) {
        lines.push(`| ${row.site} | ${row.page} | ${row.device} | \`${row.path}\` | ${METRICS.map(m => cell(row, m, prev)).join(' | ')} |`);
    }
    const failed = rows.filter(r => r.errors.length);
    if (failed.length) {
        lines.push('', 'Failed runs:', '');
        for (const r of failed) {
            lines.push(`- ${r.site} ${r.page} ${r.device}: ${r.errors.length}/${r.errors.length + r.runs} failed (${[...new Set(r.errors)].join(', ')})`);
        }
    }
    return lines.join('\n') + '\n';
}

function header(conf) {
    return `# Prod Lighthouse

Lighthouse lab results on production, measured before and after each release. Newest first.

> Each value is the median of ${conf.runs} Lighthouse runs (performance category, ${conf.devices.join(' and ')}). Mobile uses Lighthouse's default throttled mobile profile, desktop uses \`--preset=desktop\`. Lab data from one machine and network: compare entries measured from the same place; a single entry is no field (CrUX) data. Score is 0–100; FCP, LCP and SI in seconds, TBT in ms, CLS unitless, Weight = total transferred bytes, Requests = network requests.

`;
}

const args = parseArgs(process.argv.slice(2));
const root = git('rev-parse', '--show-toplevel') || process.cwd();
const conf = readConf(resolve(root, args.conf || '.claude/prod-lighthouse-log.conf'));
const sites = args.site ? conf.sites.filter(s => s.name === args.site) : conf.sites;
if (!sites.length) {
    die(`site "${args.site}" not in config (${conf.sites.map(s => s.name).join(', ')})`);
}
const release = args.release || git('describe', '--tags', '--abbrev=0') || die('no git tag found, pass --release');
const logFile = resolve(root, args.log || conf.log);
const iso = () => new Date().toISOString();
const started = iso();
const rows = measure(conf, sites);
const meta = {
    date: started.slice(0, 10),
    start: started.slice(11, 16),
    end: iso().slice(11, 16),
    release,
    phase: args.phase,
    commit: git('rev-parse', '--short', `${release}^{commit}`) || git('rev-parse', '--short', 'HEAD') || 'unknown',
    version: conf.version,
    runs: conf.runs,
};
const existing = existsSync(logFile) ? readFileSync(logFile, 'utf8') : header(conf);
const prev = args.phase === 'after' ? parseEntry(existing, release, 'before') : null;
const entry = render(rows, meta, prev);
const at = existing.search(/^## /m);
const text = at === -1 ? `${existing.replace(/\n*$/, '\n\n')}${entry}` : `${existing.slice(0, at)}${entry}\n${existing.slice(at)}`;
mkdirSync(dirname(logFile), { recursive: true });
writeFileSync(logFile, text);
process.stdout.write(entry);
process.stdout.write(`\nwritten to ${logFile}\n`);
