// The app's reading of words as calls, lib/voice/calls.ts in a Sail Scoring
// checkout, used as it stands: the bench scores with it and the check page
// serves it, so there is one copy of it.

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

/** calls.ts as a module. Imported from a copy here, where package.json says
 *  what kind of module it is, so Node strips its types without guessing. */
export async function loadCalls(dir) {
  const copy = join(BUILD, 'app', 'calls.ts');
  mkdirSync(join(BUILD, 'app'), { recursive: true });
  copyFileSync(callsFile(dir), copy);
  return import(pathToFileURL(copy).href);
}
