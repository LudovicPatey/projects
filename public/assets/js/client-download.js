// Which AI client to offer on this device. No dependency, so that it can be unit tested.

export const SYSTEMS = {
  'mac-arm64': { label: 'Mac with Apple silicon', short: 'Mac', family: 'mac' },
  'mac-x64': { label: 'Mac with an Intel processor', short: 'Intel Mac', family: 'mac' },
  windows: { label: 'Windows', short: 'Windows', family: 'windows' },
  linux: { label: 'Linux', short: 'Linux', family: 'linux' },
};

/** Browsers do not always reveal the processor of a Mac: Apple silicon is then assumed, and the other build stays listed. */
export function detectSystem({ userAgent = '', platform = '', architecture = '', touchPoints = 0 } = {}) {
  const ua = userAgent.toLowerCase();
  const pf = platform.toLowerCase();
  if (/iphone|ipad|ipod|android/.test(ua) || (pf.includes('mac') && touchPoints > 1)) return 'phone';
  if (pf.includes('win') || ua.includes('windows')) return 'windows';
  if (pf.includes('mac') || ua.includes('mac os')) return architecture === 'x86' ? 'mac-x64' : 'mac-arm64';
  if (pf.includes('linux') || ua.includes('linux') || ua.includes('x11')) return 'linux';
  return 'unknown';
}

export function clientCommand(system, site) {
  if (SYSTEMS[system]?.family === 'windows') {
    return `mkdir $HOME\\open-questions -Force; cd $HOME\\open-questions; curl.exe -fsSL ${site}/api/client/oq.py -o oq.py; py oq.py app`;
  }
  return `mkdir -p ~/open-questions && cd ~/open-questions && curl -fsSL ${site}/api/client/oq.py -o oq.py && python3 oq.py app`;
}

/** What the page offers: the installer when it is published, and otherwise the Python client with its graphic interface. */
export function downloadPlan(system, info) {
  const installers = info?.installers || [];
  const installer = installers.find((x) => x.system === system) || null;
  const others = installers.filter((x) => x !== installer);
  return { system, label: SYSTEMS[system]?.label || 'your computer', phone: system === 'phone', installer, others, useScript: !installer && system !== 'phone' };
}

export function formatSize(bytes) {
  if (!bytes) return '';
  return bytes >= 1048576 ? `${Math.round(bytes / 1048576)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export const GITHUB_REPO = 'LudovicPatey/projects';
// If you run a modified version as a service, the AGPL requires offering its source: point this to your copy.
export const SOURCE_URL = `https://github.com/${GITHUB_REPO}`;
export const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`;
export const INSTALLER_NAMES = { 'mac-arm64': 'open-questions-ai-mac-arm64.dmg', 'mac-x64': 'open-questions-ai-mac-x64.dmg', windows: 'open-questions-ai-windows.exe', linux: 'open-questions-ai-linux.AppImage' };

const newer = (a, b) => {
  const x = String(a || '').split('.').map(Number); const y = String(b || '').split('.').map(Number);
  if (x.length !== 3 || x.some(Number.isNaN)) return false;
  if (y.length !== 3 || y.some(Number.isNaN)) return true;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

/** Adds the installers of the latest GitHub release, unless it needs a newer server than this platform. */
export function mergeRelease(info, release) {
  const out = { ...info, installers: [...(info?.installers || [])] };
  if (!release || release.draft || release.prerelease) return out;
  const version = String(release.tag_name || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) return out;
  const needs = Number(String(release.body || '').match(/requires-api:\s*(\d+)/i)?.[1] || 1);
  if (needs > Number(info?.api_level || 1)) return out;
  const prefix = `${RELEASES_URL}/download/`;
  for (const [system, name] of Object.entries(INSTALLER_NAMES)) {
    const asset = (release.assets || []).find((a) => a.name === name && String(a.browser_download_url || '').startsWith(prefix));
    if (!asset) continue;
    const entry = { system, file: name, size: asset.size, version, url: asset.browser_download_url, sha256: String(asset.digest || '').replace(/^sha256:/, '') || null };
    const at = out.installers.findIndex((x) => x.system === system);
    if (at < 0) out.installers.push(entry);
    else if (newer(version, out.installers[at].version)) out.installers[at] = entry;
  }
  return out;
}
