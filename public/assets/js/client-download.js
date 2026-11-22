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
