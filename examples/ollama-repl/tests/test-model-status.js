/* test-model-status.js: test the Quota / Reset column of the /model health table */
import { modelStatusTable } from '../lib/gateway/model-status.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-model-status: ${what}`);
};
const plain = s => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/* build a small av object with one READY, one COOLDOWN and one NEEDS_KEY entry */
const now = Date.now();
const at = 100 * 60e3; // 100 minutes from now for cooldown
const av = {
  at: now,
  byModel: new Map([
    ['ready-model', {
      blocked: false,
      status: 'ready',
      until: null,
      approx: false,
      kinds: [],
      permanent: false,
      blocks: [],
      rows: 1,
      platforms: ['x'],
      intelligence: 0.5,
    }],
    ['cooldown-model', {
      blocked: true,
      status: 'exhausted',
      until: now + 600_000, // 10 minutes
      approx: false,
      kinds: ['cooldown'],
      permanent: false,
      blocks: [{ kind: 'cooldown', until: now + 600_000, detail: 'the provider named a retry time' }],
      rows: 1,
      platforms: ['x'],
      intelligence: 0.4,
    }],
    ['needs-key-model', {
      blocked: false,
      status: 'needsKey',
      until: null,
      approx: false,
      kinds: [],
      permanent: false,
      blocks: [],
      rows: 1,
      platforms: ['y'],
      intelligence: 0.3,
    }],
  ]),
  rate: new Map(),
  budget: new Map(),
};

/* get the table */
const { rows, header } = modelStatusTable(av);
const quotaCol = header.indexOf('Quota / Reset');
check('Quota / Reset column exists', quotaCol >= 0);

/* check READY model cell 5 (Quota / Reset) is "-" */
const readyRow = rows.find(r => r[0] === 'ready-model');
check('READY model has Quota / Reset column', readyRow && readyRow[quotaCol]);
check('READY model Quota / Reset is "-"', readyRow[quotaCol] === '-');

/* check COOLDOWN model cell 5 contains "10m ·" after stripping escapes */
const cooldownRow = rows.find(r => r[0] === 'cooldown-model');
check('COOLDOWN model has Quota / Reset column', cooldownRow && cooldownRow[quotaCol]);
const cooldownText = plain(cooldownRow[quotaCol]);
check('COOLDOWN model Quota / Reset contains "10m ·"', cooldownText.includes('10m ·'));

/* check NEEDS_KEY model quota cell is colored magenta */
const needsKeyRow = rows.find(r => r[0] === 'needs-key-model');
check('NEEDS_KEY model has Quota / Reset column', needsKeyRow && needsKeyRow[quotaCol]);
const needsKeyText = needsKeyRow[quotaCol];
check('NEEDS_KEY model Quota / Reset is colored magenta', needsKeyText.includes('\x1b[35m') && needsKeyText.includes('\x1b[0m'));

console.log('test-model-status: ok');