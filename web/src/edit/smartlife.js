// Smart Life on the Mac: sign in by scanning a QR code with the Smart Life app (no Tuya
// developer account), or, for those who have one, a Tuya Cloud project. Native Mac only.
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { isNative, call } from '../bridge.js';
import { group, row, textRow, button, note } from './forms.js';

const REGIONS = [
  ['eu', 'Central Europe'], ['eu-w', 'Western Europe'], ['us', 'Western America'], ['us-e', 'Eastern America'],
  ['cn', 'China'], ['in', 'India'], ['sg', 'Singapore'],
];

export function createSmartLife({ onChange, connections }) {
  const boot = window.__HOUSE_BOOT__ || {};
  const tuya = {
    info: boot.tuya || { configured: false, accessId: '', region: 'eu' },
    account: boot.smartLife || { connected: false, userCode: '', account: '' },
    devices: null, busy: false, error: null,
    userCode: (boot.smartLife || {}).userCode || '',
    qr: null, message: null, bad: false,
    cloud: { id: (boot.tuya || {}).accessId || '', secret: '', region: (boot.tuya || {}).region || 'eu' },
    advanced: false,
  };
  const changed = () => onChange?.();
  // Signed in or out: the overview and the pickers follow.
  const smartLifeChanged = () => connections.refreshInfo().then(() => connections.load({ quiet: true }));

  let loginTimer = 0;
  const stopLogin = () => { clearInterval(loginTimer); loginTimer = 0; };

  async function fetchDevices() {
    tuya.busy = true; tuya.error = null; changed();
    try { tuya.devices = (await call('tuya.devices')).devices; } catch (e) { tuya.error = e.message; tuya.devices = null; }
    tuya.busy = false;
    changed();
  }

  async function begin() {
    stopLogin();
    tuya.bad = false;
    tuya.message = 'Requesting a login code…';
    tuya.qr = null;
    changed();
    try {
      const userCode = tuya.userCode.trim();
      const { token, qr } = await call('smartlife.begin', { userCode });
      tuya.qr = qr;
      tuya.message = 'Scan this code with the Smart Life app (the scan icon on the Home tab) and confirm the login. Waiting…';
      let tries = 0;
      loginTimer = setInterval(async () => {
        if (++tries > 90) { stopLogin(); tuya.bad = true; tuya.message = 'The code expired. Press “Show QR code” again.'; changed(); return; }
        const r = await call('smartlife.poll', { token, userCode }).catch(() => null);
        if (!r?.connected) return;
        stopLogin();
        tuya.account = r.info;
        tuya.qr = null;
        tuya.message = null;
        changed();
        smartLifeChanged();
      }, 2000);
    } catch (e) {
      tuya.bad = true;
      tuya.message = e.message;
    }
    changed();
  }

  async function signOut() {
    stopLogin();
    tuya.account = await call('smartlife.signOut');
    tuya.devices = null;
    tuya.qr = null;
    changed();
    smartLifeChanged();
  }

  async function saveCloud(ctx) {
    try {
      tuya.info = await call('tuya.save', { accessId: tuya.cloud.id, accessSecret: tuya.cloud.secret, region: tuya.cloud.region });
      smartLifeChanged();
      if (tuya.info.configured) await fetchDevices(); else changed();
    } catch (e) { ctx.toast(e.message, { tone: 'bad' }); }
  }

  function deviceList() {
    if (tuya.busy) return group(null, [row({ lead: h('span.ed-spin', icon('spinner', 18, 2.2)), title: 'Talking to Smart Life…' })]);
    if (tuya.error) return note(tuya.error, { tone: 'bad', icon: 'alert' });
    if (!tuya.devices) return null;
    if (!tuya.devices.length) return note('Connected, but this account has no devices yet.', { tone: 'bad', icon: 'alert' });
    return group(`${tuya.devices.length} devices in your account`, tuya.devices.map((d) => row({
      lead: h(`span.ed-dot${d.online ? '.on' : ''}`), title: d.name,
      subtitle: `${d.product || d.category || 'device'} · ${d.codes.join(', ') || 'no functions reported'}`,
    })));
  }

  function render(ctx) {
    const nodes = [];
    if (!isNative) nodes.push(note('Connecting works inside the House Control app (this is the browser preview).', { tone: 'warn', icon: 'info' }));
    if (tuya.account.connected) {
      if (!tuya.devices && !tuya.busy && !tuya.error && isNative) setTimeout(fetchDevices, 0);
      nodes.push(group('Smart Life account', [
        row({ lead: h('span.ed-dot.on'), title: tuya.account.account || 'Signed in', subtitle: `User Code ${tuya.account.userCode}` }),
        row({ icon: 'refresh', tint: 'rgba(61,139,255,.85)', title: 'Refresh devices', onClick: fetchDevices }),
        row({ icon: 'unlink', tint: 'rgba(255,69,58,.8)', title: 'Sign out', destructive: true, onClick: signOut }),
      ], 'Open a lamp or an AC on the plan and choose its device under “Real device”.'), deviceList());
    } else {
      nodes.push(group('Sign in with the Smart Life app', [
        row({ icon: 'phone', title: 'Copy your User Code', subtitle: 'Smart Life → Me → ⚙ Settings → Account and Security, at the bottom' }),
        textRow({ label: 'User Code', value: tuya.userCode, placeholder: 'e.g. aB12cD3', key: 'sl-code', onInput: (v) => { tuya.userCode = v; } }),
      ], 'Free and needs no Tuya developer account: the same sign-in the Home Assistant integration uses. The session is stored only on this Mac.'),
      button({ label: 'Show QR code', style: 'primary', wide: true, disabled: !isNative, onClick: begin }),
      tuya.qr ? h('div.ed-qr', h('img', { src: tuya.qr, alt: 'Smart Life login QR code', width: 220, height: 220 })) : null,
      tuya.message ? note(tuya.message, { tone: tuya.bad ? 'bad' : '', icon: tuya.bad ? 'alert' : 'info' }) : null);
    }
    // The developer-project route stays available for those who already have one.
    nodes.push(group(null, [row({ icon: 'key', title: 'Advanced: Tuya Cloud project', chevron: !tuya.advanced, onClick: () => { tuya.advanced = !tuya.advanced; changed(); } })]));
    if (tuya.advanced) {
      nodes.push(group('Tuya Cloud project', [
        textRow({ label: 'Access ID', value: tuya.cloud.id, placeholder: 'Access ID / Client ID', key: 'tc-id', onInput: (v) => { tuya.cloud.id = v; } }),
        textRow({ label: 'Secret', value: tuya.cloud.secret, type: 'password', placeholder: tuya.info.hasSecret ? '•••••••• (saved)' : 'Access Secret', key: 'tc-secret', onInput: (v) => { tuya.cloud.secret = v; } }),
        h('div.ed-row.ed-region', h('span.ed-row-title', 'Data centre'),
          h('select.ed-select', { 'data-key': 'tc-region', onchange: (ev) => { tuya.cloud.region = ev.target.value; } },
            REGIONS.map(([id, label]) => h('option', { value: id, selected: id === tuya.cloud.region }, `${label} (${id})`)))),
      ], 'Only if you already have a project on platform.tuya.com with your app account linked. The QR sign-in above takes priority when both are set.'),
      button({ label: 'Save & fetch devices', style: 'tinted', wide: true, disabled: !isNative, onClick: () => saveCloud(ctx) }),
      tuya.account.connected ? null : deviceList());
    }
    return nodes;
  }

  return { render, stop: stopLogin, tuya };
}
