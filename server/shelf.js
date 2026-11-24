import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { queryEntries, getSetting, setSetting } from './db.js';
import { DEFAULT_SHELF_SETTINGS, normalizeShelfSettings, shelfDataFromEntries, renderShelfHtml } from '../shared/shelf-render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SHELF_DIR = process.env.KT_SHELF_DIR || path.join(__dirname, '..', 'public-shelf');
export { DEFAULT_SHELF_SETTINGS };

export function getShelfSettings() {
  return normalizeShelfSettings(getSetting('shelf', {}) || {});
}

export function saveShelfSettings(patch = {}) {
  return setSetting('shelf', normalizeShelfSettings(getShelfSettings(), patch));
}

export function buildShelfData(settings = getShelfSettings()) {
  return shelfDataFromEntries(queryEntries({ minRating: settings.minRating, sort: 'rating', limit: 500 }), settings);
}

export function publishShelf(overrides = {}) {
  const settings = Object.keys(overrides).length ? saveShelfSettings(overrides) : getShelfSettings();
  const data = buildShelfData(settings);
  fs.mkdirSync(SHELF_DIR, { recursive: true });
  fs.writeFileSync(path.join(SHELF_DIR, 'index.html'), renderShelfHtml(data));
  fs.writeFileSync(path.join(SHELF_DIR, 'shelf.json'), JSON.stringify(data, null, 2));
  return { ok: true, count: data.count, dir: SHELF_DIR, files: ['index.html', 'shelf.json'], settings };
}

// CLI: npm run shelf -- --min 4
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--min');
  const res = publishShelf(i >= 0 ? { minRating: Number(args[i + 1]) } : {});
  console.log(`Published ${res.count} item(s) to ${res.dir}/index.html (min ${res.settings.minRating}★)`);
}
