// Writes Resources/sample-home.json: the default home (Riley's Studio) in its "Cozy" scene,
// which the widgets show until the app has written the real home (the widget gallery, a
// fresh install). Its devices are shown simulated: the gallery never drives real hardware.
//   node widgets/make-sample.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

globalThis.window = globalThis;
globalThis.location = { search: '' };
globalThis.localStorage = { getItem: () => null, setItem() {} };

const web = fileURLToPath(new URL('../web/', import.meta.url));
const { normalize } = await import(`${web}src/config.js`);
const { createStore } = await import(`${web}src/store.js`);
const { widgetSnapshot } = await import(`${web}src/widgets.js`);
const { DEFAULT_PLAN } = await import(`${web}src/config.js`);

const config = normalize(JSON.parse(readFileSync(`${web}public/plans/${DEFAULT_PLAN}.json`, 'utf8')));
const store = createStore(config);
store.applyScene('cozy');
const ac = config.acs[0];
store.setAC(ac.id, { on: true, target: ac.unit === 'F' ? 73 : 23 });
for (const a of Object.values(store.state.acs)) a.roomTemp = ac.unit === 'F' ? 77.5 : 25.4;
const snapshot = { ...widgetSnapshot(config, store, DEFAULT_PLAN), updated: 0 };
for (const d of [...snapshot.lights, ...snapshot.acs]) Object.assign(d, { service: null, links: null });
writeFileSync(new URL('Resources/sample-home.json', import.meta.url), `${JSON.stringify(snapshot)}\n`);
process.exit(0); // the store's simulation timer would keep node running
