#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { run } from './run.js';

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  fetch,
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: (path, text) => writeFile(path, text),
  sleep: (ms) => sleep(ms),
  now: () => Date.now(),
});
