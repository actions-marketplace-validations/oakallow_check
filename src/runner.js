// Minimal GitHub Actions runner helpers. No dependencies, so there is
// nothing to bundle and nothing third party in the supply chain.

import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export function getInput(name, { required = false, fallback = '' } = {}) {
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  const value = (process.env[key] ?? '').trim();
  if (!value && required) throw new Error(`Input required and not supplied: ${name}`);
  return value || fallback;
}

function escapeData(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function command(cmd, message) {
  process.stdout.write(`::${cmd}::${escapeData(message)}\n`);
}

export const log = {
  info: (m) => process.stdout.write(`${m}\n`),
  notice: (m) => command('notice', m),
  warning: (m) => command('warning', m),
  error: (m) => command('error', m),
};

export function mask(value) {
  if (value) command('add-mask', value);
}

function appendKeyValue(fileVar, name, value) {
  const file = process.env[fileVar];
  if (!file) return;
  const delimiter = `ghadelimiter_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value ?? ''}\n${delimiter}\n`);
}

export function setOutput(name, value) {
  appendKeyValue('GITHUB_OUTPUT', name, value);
}

export function appendSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown}\n`);
}

export function setFailed(message) {
  process.exitCode = 1;
  log.error(message);
}
