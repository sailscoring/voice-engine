// The app's reading of words as calls, lib/voice/calls.ts in a Sail Scoring
// checkout, used as it stands: the bench scores with it and the check page
// serves it, so there is one copy of it. The check page also serves the
// app's reading of a whole recording (timeline.ts and the modules beside
// it), so it shows a recording the way the app does.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUILD, ROOT } from './lib.mjs';

/** Where the app is: --app, else a sibling checkout. */
export const appDir = (given) => resolve(typeof given === 'string' ? given : join(ROOT, '..', 'sailscoring'));

function callsFile(dir) {
  const file = join(dir, 'lib', 'voice', 'calls.ts');
  if (!existsSync(file)) throw new Error(`${file} is missing: pass --app <a Sail Scoring checkout>`);
  return file;
}

/** calls.ts as JavaScript, for a browser. It imports nothing, so it stands
 *  alone. */
export const callsSource = (dir) => stripTypeScriptTypes(readFileSync(callsFile(dir), 'utf8'));

/** The app's pure modules the check page runs, each the name it is served
 *  under. They import only one another. */
export const APP_MODULES = ['calls', 'types', 'timeline', 'timeline-rows', 'live'];

/**
 * One of those modules as JavaScript, for a browser: its types stripped, and
 * its imports of the others pointed at their served names. Read afresh each
 * time, so a change in the app shows on the next reload.
 */
export function appModuleSource(dir, name) {
  if (!APP_MODULES.includes(name)) return null;
  const file = join(dir, 'lib', 'voice', `${name}.ts`);
  if (!existsSync(file)) throw new Error(`${file} is missing: the app's voice-recording branch has it`);
  return stripTypeScriptTypes(readFileSync(file, 'utf8')).replace(
    /from '\.\/([a-z-]+)'/g,
    (_, m) => `from './${m}.js'`,
  );
}

/** calls.ts as a module. Imported from a copy here, where package.json says
 *  what kind of module it is, so Node strips its types without guessing. */
export async function loadCalls(dir) {
  const copy = join(BUILD, 'app', 'calls.ts');
  mkdirSync(join(BUILD, 'app'), { recursive: true });
  copyFileSync(callsFile(dir), copy);
  return import(pathToFileURL(copy).href);
}
