#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const METRICS = [
    { key: 'score', label: 'Score', fmt: v => String(Math.round(v)) },
    { key: 'fcp', label: 'FCP', fmt: v => `${(v / 1000).toFixed(2)} s` },
    { key: 'lcp', label: 'LCP', fmt: v => `${(v / 1000).toFixed(2)} s` },
    { key: 'tbt', label: 'TBT', fmt: v => `${Math.round(v)} ms` },
    { key: 'cls', label: 'CLS', fmt: v => v.toFixed(3) },
    { key: 'si', label: 'SI', fmt: v => `${(v / 1000).toFixed(2)} s` },
    { key: 'weight', label: 'Weight', fmt: v => `${(v / 1048576).toFixed(1)} MB` },
    { key: 'requests', label: 'Requests', fmt: v => String(Math.round(v)) },
];

function die(msg) {
    process.stderr.write(`lighthouse-audit: ${msg}\n`);
    process.exit(2);
}

function usage() {
    process.stderr.write(`Usage: lighthouse-audit.mjs [--site NAME] [--conf FILE] [--log FILE]
  --site     only this site from the config (default: all)
  --conf     config file (default: .claude/lighthouse-audit.conf)
  --log      log file (default: LOG_FILE from config)
`);
    process.exit(1);
}

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const name = argv[i];
        if (!['--site', '--conf', '--log'].includes(name) || argv[i + 1] === undefined) {
            usage();
        }
        args[name.slice(2)] = argv[++i];
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
        die(`${file} missing — copy the template: cp .claude/skills/lighthouse-audit/lighthouse-audit.conf.dist ${file}`);
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
        log: conf.LOG_FILE || 'docs/Performance/History-Lighthouse.md',
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
    const dir = mkdtempSync(join(tmpdir(), 'lighthouse-audit-'));
    const rows = [];
    try {
        for (const site of sites) {
            for (const { page, path } of site.pages) {
                for (const device of conf.devices) {
                    const ok = [];
                    const errors = [];
                    for (let i = 1; i <= conf.runs; i++) {
                        const r = lighthouse(conf.version, site.base + path, device, join(dir, `${site.name}-${page}-${device}-${i}.json`));
                        process.stderr.write(`${site.name} ${page} ${device} run ${i}/${conf.runs}: ${r.error ? `error ${r.error}` : `score ${Math.round(r.score)}`}\n`);
                        if (r.error) {
                            errors.push(r.error);
                        } else {
                            ok.push(r);
                        }
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

function render(rows, meta) {
    const lines = [
        `## ${meta.date} ${meta.start} UTC`,
        '',
        `Measured ${meta.start}–${meta.end} UTC, Lighthouse ${meta.version}, median of ${meta.runs} runs, performance category only.`,
        '',
        `| Site | Page | Device | URL | ${METRICS.map(m => m.label).join(' | ')} |`,
        `|${'---|'.repeat(4 + METRICS.length)}`,
    ];
    for (const row of rows) {
        const cells = METRICS.map(m => (row[m.key] === undefined ? 'error' : m.fmt(row[m.key])));
        lines.push(`| ${row.site} | ${row.page} | ${row.device} | \`${row.path}\` | ${cells.join(' | ')} |`);
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
    return `# Performance History — Lighthouse

Lighthouse lab results of the configured pages. Newest first.

> Each value is the median of ${conf.runs} Lighthouse runs (performance category, ${conf.devices.join(' and ')}). Mobile uses Lighthouse's default throttled mobile profile, desktop uses \`--preset=desktop\`. Lab data from one machine and network: compare entries measured from the same place; a single entry is no field (CrUX) data. Score is 0–100; FCP, LCP and SI in seconds, TBT in ms, CLS unitless, Weight = total transferred bytes, Requests = network requests.

`;
}

const args = parseArgs(process.argv.slice(2));
const root = git('rev-parse', '--show-toplevel') || process.cwd();
const conf = readConf(resolve(root, args.conf || '.claude/lighthouse-audit.conf'));
const sites = args.site ? conf.sites.filter(s => s.name === args.site) : conf.sites;
if (!sites.length) {
    die(`site "${args.site}" not in config (${conf.sites.map(s => s.name).join(', ')})`);
}
const logFile = resolve(root, args.log || conf.log);
const started = new Date().toISOString();
const rows = measure(conf, sites);
const meta = {
    date: started.slice(0, 10),
    start: started.slice(11, 16),
    end: new Date().toISOString().slice(11, 16),
    version: conf.version,
    runs: conf.runs,
};
const existing = existsSync(logFile) ? readFileSync(logFile, 'utf8') : header(conf);
const entry = render(rows, meta);
const at = existing.search(/^## /m);
const text = at === -1 ? `${existing.replace(/\n*$/, '\n\n')}${entry}` : `${existing.slice(0, at)}${entry}\n${existing.slice(at)}`;
mkdirSync(dirname(logFile), { recursive: true });
writeFileSync(logFile, text);
process.stdout.write(entry);
process.stdout.write(`\nwritten to ${logFile}\n`);
