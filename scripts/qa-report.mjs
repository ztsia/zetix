#!/usr/bin/env node
/**
 * Turns a QA run into one self-contained HTML report.
 *
 *   node scripts/qa-report.mjs qa-artifacts/<branch>
 *
 * Reads `results.json` and the PNGs in `screens/`, and writes `report.html`
 * beside them with every screenshot inlined as a data URI. Self-contained
 * matters twice over: the container is ephemeral, and a published Artifact
 * cannot load an image from anywhere but itself.
 *
 * The output is deliberately a **fragment** — a `<title>`, a `<style>` and the
 * body content, with no `<!doctype>`/`<html>`/`<head>`/`<body>` wrapper. That is
 * what the Artifact publisher expects, and browsers render it unchanged when the
 * file is opened directly, so one file serves both.
 *
 * Nothing here interprets the run. It renders what the reviewer recorded; a
 * missing section is simply omitted rather than invented.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/qa-report.mjs qa-artifacts/<branch>');
  process.exit(1);
}

const resultsPath = join(dir, 'results.json');
if (!existsSync(resultsPath)) {
  console.error(`No results.json in ${dir}. The QA reviewer writes it in phase 6.`);
  process.exit(1);
}

const r = JSON.parse(readFileSync(resultsPath, 'utf8'));
const screensDir = join(dir, 'screens');

/* ---------- screenshots ---------------------------------------------------- */

const available = existsSync(screensDir)
  ? Object.fromEntries(readdirSync(screensDir).map((f) => [f, join(screensDir, f)]))
  : {};

let embeddedBytes = 0;
const missing = new Set();
const used = new Set();

/** A PNG as a data URI, or null when the reviewer named a file that is not there. */
function dataUri(name) {
  if (!name) return null;
  const key = available[name] ? name : available[basename(name)] ? basename(name) : null;
  if (!key) {
    missing.add(name);
    return null;
  }
  used.add(key);
  const bytes = readFileSync(available[key]);
  embeddedBytes += bytes.length;
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

/**
 * Screenshots indexed by the phase-5 naming convention,
 * `FLOW-<id>-step-<n>-<what>.png`.
 *
 * A reviewer reliably *names* its captures that way and less reliably wires each
 * one into `results.json` — a run that shot 50 and listed 4 is what prompted
 * this. Rather than lose 46 of them, the filename is treated as the attachment:
 * a step with no explicit `screenshot` picks up the shot named for it, anything
 * else matching the flow lands at the end of that flow, and whatever is left
 * over is shown as loose evidence. Nothing captured goes unshown.
 */
const FLOW_STEP = /^(FLOW-[0-9]+[a-z]?)-step-([0-9]+)[-.](.*)\.png$/i;
const byFlowStep = new Map(); // flowId -> step -> [name]
const byFlow = new Map(); // flowId -> [name] in file order

for (const name of Object.keys(available).sort()) {
  const m = FLOW_STEP.exec(name);
  if (!m) continue;
  const flowId = m[1].toUpperCase();
  const step = Number(m[2]);
  if (!byFlowStep.has(flowId)) byFlowStep.set(flowId, new Map());
  const steps = byFlowStep.get(flowId);
  if (!steps.has(step)) steps.set(step, []);
  steps.get(step).push(name);
  if (!byFlow.has(flowId)) byFlow.set(flowId, []);
  byFlow.get(flowId).push(name);
}

/** The shot named for this flow and step, if the reviewer did not name one. */
function conventionShot(flowId, step) {
  const candidates = byFlowStep.get(String(flowId).toUpperCase())?.get(Number(step));
  return candidates?.find((n) => !used.has(n)) ?? null;
}

function figure(name, caption) {
  const uri = dataUri(name);
  if (!uri) return '';
  return `<figure class="shot"><img src="${uri}" alt="${esc(caption ?? name)}" loading="lazy"><figcaption>${esc(name)}</figcaption></figure>`;
}

/* ---------- html helpers --------------------------------------------------- */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Backtick spans and fenced blocks, which is all the reviewer's prose uses. */
function richText(s) {
  if (!s) return '';
  const blocks = String(s).split(/```/);
  return blocks
    .map((chunk, i) =>
      i % 2
        ? `<pre class="block"><code>${esc(chunk.replace(/^\w*\n/, ''))}</code></pre>`
        : esc(chunk)
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\n{2,}/g, '</p><p>')
            .replace(/\n/g, '<br>'),
    )
    .join('');
}

const para = (s) => (s ? `<p>${richText(s)}</p>` : '');
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const STATUS = {
  pass: 'pass',
  fail: 'fail',
  unreachable: 'skip',
  'not reachable': 'skip',
  skip: 'skip',
  blocked: 'fail',
};
const statusClass = (s) => STATUS[String(s ?? '').toLowerCase()] ?? 'skip';

const SEVERITY_ORDER = { blocker: 0, major: 1, minor: 2, note: 3 };

/* ---------- sections ------------------------------------------------------- */

function verdictBlock() {
  const s = r.summary ?? {};
  const cells = [
    ['criteria', s.criteria],
    ['pass', s.pass],
    ['fail', s.fail],
    ['not reachable', s.unreachable ?? s.notReachable],
  ].filter(([, v]) => v !== undefined && v !== null);

  const counts = cells
    .map(
      ([label, value]) => `
      <div class="readout">
        <div class="readout-value ${label === 'fail' && Number(value) > 0 ? 'is-bad' : ''}">${esc(value)}</div>
        <div class="readout-label">${esc(label)}</div>
      </div>`,
    )
    .join('');

  const checks = Object.entries(r.suites ?? {})
    .map(
      ([k, v]) =>
        `<div class="check"><span class="check-name">${esc(k)}</span><span class="check-value">${esc(v)}</span></div>`,
    )
    .join('');

  return `
  <header class="masthead">
    <div class="eyebrow">
      <span>QA pass</span>
      ${r.module ? `<span class="sep">/</span><span>module ${esc(r.module)}</span>` : ''}
      ${r.phases ? `<span class="sep">/</span><span>phases ${esc(r.phases)}</span>` : ''}
    </div>
    <h1 class="verdict verdict--${slug(r.verdict ?? 'unknown')}">${esc(r.verdict ?? 'no verdict')}</h1>
    ${r.branch ? `<p class="branch"><code>${esc(r.branch)}</code></p>` : ''}
    ${r.headline ? `<p class="headline">${richText(r.headline)}</p>` : ''}
    <div class="readouts">${counts}</div>
    ${checks ? `<div class="checks">${checks}</div>` : ''}
    ${r.generatedAt ? `<p class="stamp">Run ${esc(r.generatedAt)}</p>` : ''}
  </header>`;
}

function findingsBlock() {
  const list = [...(r.findings ?? [])].sort(
    (a, b) =>
      (SEVERITY_ORDER[String(a.severity).toLowerCase()] ?? 9) -
      (SEVERITY_ORDER[String(b.severity).toLowerCase()] ?? 9),
  );
  if (!list.length) {
    return `<section id="findings"><h2>Findings</h2><p class="empty">No findings recorded.</p></section>`;
  }

  const rows = list
    .map((f, i) => {
      const sev = slug(f.severity ?? 'note');
      const shots = (f.screenshots ?? [])
        .map((name) => {
          const uri = dataUri(name);
          return uri
            ? `<figure class="shot"><img src="${uri}" alt="${esc(name)}" loading="lazy"><figcaption>${esc(name)}</figcaption></figure>`
            : '';
        })
        .join('');

      return `
      <article class="finding sev--${sev}" id="finding-${esc(f.id ?? i + 1)}">
        <div class="finding-head">
          <span class="sev-chip sev-chip--${sev}">${esc(f.severity ?? 'Note')}</span>
          <h3>${esc(f.title ?? 'Untitled finding')}</h3>
          ${f.status ? `<span class="state state--${statusClass(f.status === 'fixed' ? 'pass' : f.status)}">${esc(f.status)}</span>` : ''}
        </div>
        ${para(f.detail)}
        ${f.repro ? `<div class="labelled"><span class="label">Repro</span><pre class="block"><code>${esc(f.repro)}</code></pre></div>` : ''}
        ${f.evidence ? `<div class="labelled"><span class="label">Output</span><pre class="block"><code>${esc(f.evidence)}</code></pre></div>` : ''}
        ${f.spec ? `<p class="cite">${esc(f.spec)}</p>` : ''}
        ${shots ? `<div class="shots">${shots}</div>` : ''}
      </article>`;
    })
    .join('');

  return `<section id="findings"><h2>Findings <span class="count">${list.length}</span></h2>${rows}</section>`;
}

function flowsBlock() {
  const flows = r.flows ?? [];
  if (!flows.length) return '';

  const items = flows
    .map((flow) => {
      const steps = (flow.steps ?? [])
        .map((step, i) => {
          const n = step.n ?? i + 1;
          const named = step.screenshot;
          const shot = named ?? conventionShot(flow.id, n);
          const fig = figure(shot, `${flow.id} step ${n}`);
          return `
          <li class="step">
            <div class="step-marker">${esc(n)}</div>
            <div class="step-body">
              <p class="step-action">${richText(step.action)}</p>
              ${step.assertion ? `<p class="step-assert"><span class="label">Asserted</span>${richText(step.assertion)}</p>` : ''}
              ${step.status ? `<span class="state state--${statusClass(step.status)}">${esc(step.status)}</span>` : ''}
              ${fig || (named ? `<p class="shot-missing">screenshot not captured: <code>${esc(named)}</code></p>` : '')}
            </div>
          </li>`;
        })
        .join('');

      // Anything else shot during this flow — extra states, viewports, sad-path
      // variants the reviewer captured but did not list as a numbered step.
      const extras = (byFlow.get(String(flow.id).toUpperCase()) ?? [])
        .filter((n) => !used.has(n))
        .map((n) => figure(n, `${flow.id} further capture`))
        .join('');

      return `
      <article class="flow" id="${esc(slug(flow.id ?? flow.title ?? 'flow'))}">
        <div class="flow-head">
          <span class="flow-id">${esc(flow.id ?? '')}</span>
          <h3>${esc(flow.title ?? '')}</h3>
          ${flow.kind ? `<span class="kind kind--${slug(flow.kind)}">${esc(flow.kind)} path</span>` : ''}
          ${flow.status ? `<span class="state state--${statusClass(flow.status)}">${esc(flow.status)}</span>` : ''}
        </div>
        <dl class="meta">
          ${flow.actor ? `<div><dt>Actor</dt><dd>${esc(flow.actor)}</dd></div>` : ''}
          ${flow.entry ? `<div><dt>Entry</dt><dd><code>${esc(flow.entry)}</code></dd></div>` : ''}
          ${flow.covers?.length ? `<div><dt>Covers</dt><dd>${flow.covers.map((c) => `<code>${esc(c)}</code>`).join(' ')}</dd></div>` : ''}
          ${flow.spec ? `<div><dt>Spec</dt><dd>${esc(flow.spec)}</dd></div>` : ''}
        </dl>
        ${flow.ends ? `<p class="flow-ends"><span class="label">Ends</span>${richText(flow.ends)}</p>` : ''}
        <ol class="steps">${steps}</ol>
        ${extras ? `<div class="extras"><span class="label">Also captured on this flow</span><div class="shots">${extras}</div></div>` : ''}
      </article>`;
    })
    .join('');

  return `<section id="flows"><h2>Flows walked <span class="count">${flows.length}</span></h2>${items}</section>`;
}

function criteriaBlock() {
  const list = r.criteria ?? [];
  if (!list.length) return '';
  const rows = list
    .map(
      (c) => `
      <tr>
        <td class="mono">${esc(c.id ?? '')}</td>
        <td>${esc(c.title ?? '')}${c.evidence ? `<span class="evidence">${richText(c.evidence)}</span>` : ''}</td>
        <td class="mono cite-cell">${esc(c.spec ?? '')}</td>
        <td><span class="state state--${statusClass(c.status)}">${esc(c.status ?? '')}</span></td>
      </tr>`,
    )
    .join('');
  return `
  <section id="criteria">
    <h2>Acceptance criteria <span class="count">${list.length}</span></h2>
    <p class="section-note">Written from <code>docs/spec/</code> before the implementation was opened.</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>ID</th><th>Criterion</th><th>Spec</th><th>Result</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

function probesBlock() {
  const list = r.probes ?? [];
  if (!list.length) return '';
  const rows = list
    .map(
      (p) => `
      <tr>
        <td>${richText(p.broke)}</td>
        <td><span class="state state--${p.caught ? 'pass' : 'fail'}">${p.caught ? 'caught it' : 'missed it'}</span><span class="evidence">${p.caught ? 'suite went red' : 'suite stayed green'}</span></td>
        <td>${esc(p.note ?? '')}</td>
      </tr>`,
    )
    .join('');
  return `
  <section id="probes">
    <h2>Do the tests have teeth? <span class="count">${list.length}</span></h2>
    <p class="section-note">Each probe breaks the implementation on purpose and reverts it. A suite that stays green while the behaviour it names is broken is the more serious finding — nobody will be told when it regresses.</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>What was broken</th><th>Did the suite notice</th><th>Note</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

function gapsBlock() {
  const list = r.notTested ?? [];
  if (!list.length) return '';
  return `
  <section id="gaps">
    <h2>What could not be tested</h2>
    <p class="section-note">An honest gap is worth more than a clean sheet.</p>
    <ul class="gaps">${list.map((g) => `<li>${richText(typeof g === 'string' ? g : `${g.what} — ${g.why}`)}</li>`).join('')}</ul>
  </section>`;
}

/**
 * Captures that belong to no flow step — criterion evidence (`AC-*`), one-off
 * probes, viewport checks. Rendered last so the run's evidence is complete.
 *
 * Must be called after every other section, once `used` is final.
 */
function looseEvidenceBlock() {
  const leftovers = Object.keys(available)
    .sort()
    .filter((n) => !used.has(n));
  if (!leftovers.length) return '';

  const figs = leftovers.map((n) => figure(n, n)).join('');
  return `
  <section id="evidence">
    <h2>Other captures <span class="count">${leftovers.length}</span></h2>
    <p class="section-note">Screenshots taken outside a numbered flow step — criterion evidence, viewport checks and one-off probes.</p>
    <div class="gallery">${figs}</div>
  </section>`;
}

/* ---------- page ----------------------------------------------------------- */

const nav = [
  ['findings', 'Findings'],
  r.flows?.length ? ['flows', 'Flows'] : null,
  r.criteria?.length ? ['criteria', 'Criteria'] : null,
  r.probes?.length ? ['probes', 'Test teeth'] : null,
  r.notTested?.length ? ['gaps', 'Gaps'] : null,
  Object.keys(available).length ? ['evidence', 'Captures'] : null,
]
  .filter(Boolean)
  .map(([id, label]) => `<a href="#${id}">${label}</a>`)
  .join('');

const head = verdictBlock();
const sections = [findingsBlock(), flowsBlock(), probesBlock(), criteriaBlock(), gapsBlock()];
// After the rest, so `used` is final and only genuinely unshown files remain.
sections.push(looseEvidenceBlock());
const body = [head, `<nav class="toc">${nav}</nav>`, ...sections].join('\n');

const html = `<title>${esc(r.module ? `Module ${r.module} QA` : 'QA Report')}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Instrument+Serif:ital@0;1&family=Source+Sans+3:wght@400;600;700&display=swap">
<style>
/* Light palette is the complete set; the two blocks below only redefine tokens. */
:root {
  --ground: #fbfcfd;
  --surface: #ffffff;
  --surface-sunk: #f2f5f8;
  --ink: #10151c;
  --ink-soft: #46525f;
  --ink-faint: #74818f;
  --rule: #dce3ea;
  --rule-strong: #c3cedb;
  --accent: #2f4b7c;
  --accent-soft: #e7edf6;

  --blocker: #b4232b;
  --major: #c2600c;
  --minor: #8a6d1f;
  --note: #55637a;
  --pass: #1e7a55;
  --pass-soft: #e4f2ec;
  --fail-soft: #fbe9e9;
  --skip-soft: #eef1f5;

  --display: "Instrument Serif", Georgia, "Times New Roman", serif;
  --sans: "Source Sans 3", ui-sans-serif, system-ui, -apple-system, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ground: #0d1117;
    --surface: #151b23;
    --surface-sunk: #1c242e;
    --ink: #e8edf3;
    --ink-soft: #aab6c4;
    --ink-faint: #7d8b9b;
    --rule: #262f3a;
    --rule-strong: #38434f;
    --accent: #8fb0e0;
    --accent-soft: #1a2634;
    --blocker: #f07178;
    --major: #e8a75c;
    --minor: #d4bb72;
    --note: #9aa8bd;
    --pass: #5fce9f;
    --pass-soft: #14291f;
    --fail-soft: #2b1618;
    --skip-soft: #1c242e;
  }
}
:root[data-theme="dark"] {
  --ground: #0d1117;
  --surface: #151b23;
  --surface-sunk: #1c242e;
  --ink: #e8edf3;
  --ink-soft: #aab6c4;
  --ink-faint: #7d8b9b;
  --rule: #262f3a;
  --rule-strong: #38434f;
  --accent: #8fb0e0;
  --accent-soft: #1a2634;
  --blocker: #f07178;
  --major: #e8a75c;
  --minor: #d4bb72;
  --note: #9aa8bd;
  --pass: #5fce9f;
  --pass-soft: #14291f;
  --fail-soft: #2b1618;
  --skip-soft: #1c242e;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 16px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
.page { max-width: 1080px; margin: 0 auto; padding: 32px 20px 96px; display: flex; flex-direction: column; gap: 40px; }
code { font-family: var(--mono); font-size: 0.87em; background: var(--surface-sunk); padding: 0.1em 0.36em; border-radius: 3px; }
pre.block { font-family: var(--mono); font-size: 12.5px; line-height: 1.6; background: var(--surface-sunk); border: 1px solid var(--rule); border-radius: 6px; padding: 12px 14px; overflow-x: auto; margin: 8px 0 0; }
pre.block code { background: none; padding: 0; font-size: inherit; }
h2 { font-size: 21px; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 4px; display: flex; align-items: center; gap: 10px; }
h3 { font-size: 16.5px; font-weight: 700; margin: 0; letter-spacing: -0.005em; }
p { margin: 0 0 10px; }
section > p:last-child { margin-bottom: 0; }
.count { font-family: var(--mono); font-size: 12px; font-weight: 500; color: var(--ink-faint); background: var(--surface-sunk); border-radius: 20px; padding: 2px 9px; }
.section-note { color: var(--ink-soft); font-size: 14px; max-width: 68ch; margin-bottom: 14px; }
.label { font-family: var(--mono); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.09em; color: var(--ink-faint); margin-right: 8px; }
.cite { font-family: var(--mono); font-size: 12px; color: var(--ink-faint); margin: 10px 0 0; }
.empty { color: var(--ink-faint); }

/* Masthead: the readout you get before scrolling anywhere. */
.masthead { border-bottom: 2px solid var(--rule-strong); padding-bottom: 28px; }
.eyebrow { font-family: var(--mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.11em; color: var(--ink-faint); display: flex; gap: 8px; flex-wrap: wrap; }
.eyebrow .sep { color: var(--rule-strong); }
.verdict { font-family: var(--display); font-size: clamp(46px, 9vw, 78px); font-weight: 400; line-height: 1; margin: 10px 0 6px; letter-spacing: -0.015em; text-wrap: balance; }
.verdict--ship { color: var(--pass); }
.verdict--fix-first { color: var(--major); }
.verdict--blocked { color: var(--blocker); }
.branch { margin: 0 0 14px; }
.branch code { background: none; padding: 0; color: var(--ink-soft); font-size: 13px; }
.headline { font-size: 17px; color: var(--ink-soft); max-width: 62ch; margin-bottom: 22px; }
.readouts { display: flex; flex-wrap: wrap; gap: 28px 40px; padding: 18px 0; border-top: 1px solid var(--rule); }
.readout-value { font-family: var(--mono); font-size: 30px; font-weight: 500; line-height: 1; font-variant-numeric: tabular-nums; }
.readout-value.is-bad { color: var(--blocker); }
.readout-label { font-family: var(--mono); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.09em; color: var(--ink-faint); margin-top: 7px; }
.checks { display: flex; flex-wrap: wrap; gap: 8px; border-top: 1px solid var(--rule); padding-top: 16px; }
.check { display: flex; gap: 8px; align-items: baseline; background: var(--surface-sunk); border-radius: 5px; padding: 5px 10px; }
.check-name { font-family: var(--mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--ink-faint); }
.check-value { font-size: 13px; font-weight: 600; }
.stamp { font-family: var(--mono); font-size: 11px; color: var(--ink-faint); margin: 14px 0 0; }

.toc { display: flex; flex-wrap: wrap; gap: 4px; margin-top: -16px; }
.toc a { font-family: var(--mono); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--ink-soft); text-decoration: none; padding: 6px 11px; border: 1px solid var(--rule); border-radius: 5px; }
.toc a:hover { border-color: var(--accent); color: var(--accent); }
.toc a:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* A finding is lifted by its severity stripe and nothing else. */
.finding { border-left: 3px solid var(--note); background: var(--surface); border-top: 1px solid var(--rule); border-right: 1px solid var(--rule); border-bottom: 1px solid var(--rule); border-radius: 0 7px 7px 0; padding: 18px 20px; margin-top: 14px; }
.finding.sev--blocker { border-left-color: var(--blocker); }
.finding.sev--major { border-left-color: var(--major); }
.finding.sev--minor { border-left-color: var(--minor); }
.finding-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.sev-chip { font-family: var(--mono); font-size: 10.5px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.08em; padding: 3px 8px; border-radius: 4px; color: var(--surface); background: var(--note); }
.sev-chip--blocker { background: var(--blocker); }
.sev-chip--major { background: var(--major); }
.sev-chip--minor { background: var(--minor); }
.labelled { margin-top: 10px; }

.state { font-family: var(--mono); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.07em; padding: 2px 8px; border-radius: 20px; white-space: nowrap; }
.state--pass { background: var(--pass-soft); color: var(--pass); }
.state--fail { background: var(--fail-soft); color: var(--blocker); }
.state--skip { background: var(--skip-soft); color: var(--ink-faint); }

/* Flows: a step timeline, screenshot inline where it was taken. */
.flow { border: 1px solid var(--rule); border-radius: 8px; background: var(--surface); padding: 20px; margin-top: 14px; }
.flow-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.flow-id { font-family: var(--mono); font-size: 12px; font-weight: 500; color: var(--accent); background: var(--accent-soft); padding: 3px 8px; border-radius: 4px; }
.kind { font-family: var(--mono); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--ink-faint); border: 1px solid var(--rule-strong); border-radius: 20px; padding: 2px 8px; }
.kind--sad { color: var(--major); border-color: var(--major); }
.meta { display: flex; flex-wrap: wrap; gap: 6px 28px; margin: 12px 0 0; font-size: 13.5px; }
.meta div { display: flex; gap: 8px; align-items: baseline; }
.meta dt { font-family: var(--mono); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.09em; color: var(--ink-faint); }
.meta dd { margin: 0; color: var(--ink-soft); }
.flow-ends { margin: 12px 0 0; font-size: 14px; color: var(--ink-soft); }
.steps { list-style: none; margin: 18px 0 0; padding: 0; display: flex; flex-direction: column; gap: 0; }
.step { display: flex; gap: 14px; padding: 16px 0; border-top: 1px solid var(--rule); }
.step:first-child { border-top: none; padding-top: 4px; }
.step-marker { flex: none; width: 26px; height: 26px; border-radius: 50%; border: 1px solid var(--rule-strong); display: flex; align-items: center; justify-content: center; font-family: var(--mono); font-size: 12px; color: var(--ink-soft); font-variant-numeric: tabular-nums; }
.step-body { min-width: 0; flex: 1; }
.step-action { font-weight: 600; margin: 2px 0 4px; }
.step-assert { font-size: 14px; color: var(--ink-soft); margin: 0 0 8px; }
.shot { margin: 12px 0 0; }
.shot img { display: block; width: 100%; height: auto; border: 1px solid var(--rule-strong); border-radius: 6px; background: var(--surface-sunk); }
.shot figcaption { font-family: var(--mono); font-size: 10.5px; color: var(--ink-faint); margin-top: 6px; }
.shots { display: flex; flex-direction: column; gap: 16px; margin-top: 14px; }
.extras { margin-top: 18px; padding-top: 16px; border-top: 1px dashed var(--rule-strong); }
.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 18px; align-items: start; }
.shot-missing { font-size: 13px; color: var(--ink-faint); margin: 10px 0 0; }

.table-wrap { overflow-x: auto; border: 1px solid var(--rule); border-radius: 8px; background: var(--surface); }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th { text-align: left; font-family: var(--mono); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-faint); font-weight: 500; padding: 11px 14px; border-bottom: 1px solid var(--rule-strong); white-space: nowrap; }
td { padding: 11px 14px; border-bottom: 1px solid var(--rule); vertical-align: top; }
tr:last-child td { border-bottom: none; }
td.mono { font-family: var(--mono); font-size: 12.5px; white-space: nowrap; }
td.cite-cell { color: var(--ink-faint); }
.evidence { display: block; font-family: var(--mono); font-size: 12px; color: var(--ink-faint); margin-top: 5px; }
.gaps { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 9px; color: var(--ink-soft); }
.gaps li { max-width: 74ch; }

@media (max-width: 620px) {
  .page { padding: 22px 14px 72px; gap: 32px; }
  .readouts { gap: 20px 26px; }
  .finding, .flow { padding: 15px 14px; }
  .step { gap: 10px; }
}
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>
<div class="page">
${body}
</div>`;

const out = join(dir, 'report.html');
writeFileSync(out, html, 'utf8');

const mb = (n) => (n / 1024 / 1024).toFixed(2);
const total = statSync(out).size;
console.log(`wrote ${out}`);
console.log(`  screenshots: ${used.size} of ${Object.keys(available).length} shown, ${mb(embeddedBytes)} MB of PNG`);
console.log(`  page size: ${mb(total)} MB${total > 15 * 1024 * 1024 ? '  ** over the 16 MB Artifact limit **' : ''}`);
if (missing.size) {
  console.log(`  named but not found in screens/: ${[...missing].join(', ')}`);
}
