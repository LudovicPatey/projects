// First-use tutorial: its content and placement logic. No dependency, so that it can be unit tested.
// KEEP THIS UP TO DATE: a new menu area needs a step (tests/tour.test.mjs fails otherwise).

export const TOUR_KINDS = ['home', 'project'];

const SHARED_END = [
  { id: 'search', target: 'search', side: 'bottom', title: 'Find anything', text: 'Search facts, messages, files, references, people and help from here. Press ⌘K or Ctrl K on any page.' },
  { id: 'feedback', target: 'feedback', side: 'right', title: 'Tell us what to improve', text: 'Report a bug or request a feature from any page, then follow its status here. Reports are private.' },
  { id: 'alerts', target: 'alerts', side: 'right', title: 'Your alerts', text: 'You are told here when someone mentions you, replies to you, or reviews a fact you entered.' },
];

export function buildSteps(kind, ctx = {}) {
  if (kind === 'home') {
    return [
      { id: 'welcome', target: null, title: 'Welcome to Open Questions', text: 'Each project gathers researchers and AI around open problems. This short tour shows you where things are.' },
      { id: 'projects', target: 'nav-projects', side: 'right', title: 'Your projects', text: 'Every project you belong to is listed on this page. Open one and a second short tour will present its areas.' },
      { id: 'new-project', target: 'new-project', side: 'bottom', title: 'Start a project', text: 'Create a project by stating an open question. You become its owner and can invite colleagues with their ORCID iD.' },
      ...SHARED_END,
      { id: 'profile', target: 'profile', side: 'right', title: 'Your profile', text: 'Edit your details here, and create the personal API key that connects your own AI client.' },
      { id: 'help', target: 'help', side: 'right', title: 'Help is always here', text: 'The help center explains every feature. You can replay this tour from it at any time.' },
    ];
  }
  const title = ctx.title || 'this project';
  const owner = ctx.role === 'owner';
  return [
    { id: 'welcome', target: null, title: `Welcome to ${title}`, text: `You are ${owner ? 'an owner' : 'a member'} of this project. Here is a quick look at its areas. Nothing will be changed or marked as read.` },
    { id: 'overview', target: 'nav-overview', side: 'right', title: 'Overview', text: owner ? 'The dashboard: the main problem, what needs your attention, progress and recent activity. As an owner, you can edit the problem.' : 'The dashboard: the main problem, what needs your attention, progress and recent activity. You can also download a full copy.' },
    { id: 'questions', target: 'nav-questions', side: 'right', title: 'Questions', text: 'Big questions split into sub-questions. Each one can have several proof strategies. AI can propose an answer backed by a fact, and a human ratifies it.' },
    { id: 'conversations', target: 'nav-conversations', side: 'right', title: 'Mail', text: 'Linear discussions, like a webmail. Only the people you include can read them. Type @ in any text to cite any object of the project.' },
    { id: 'facts', target: 'nav-facts', side: 'right', title: 'Facts', text: 'A graph of statements and proofs. AI clients add them, and humans endorse or deny them.' },
    { id: 'files', target: 'nav-files', side: 'right', title: 'Files', text: 'PDFs and LaTeX sources with their versions, clearly marked as written by a human or by AI. Select text in a PDF to comment on it.' },
    { id: 'bib', target: 'nav-bib', side: 'right', title: 'Bibliography', text: 'References added by DOI, arXiv or BibTeX, with optional PDFs.' },
    { id: 'members', target: 'nav-members', side: 'right', title: 'People', text: owner ? 'Add researchers by ORCID iD and create AI agents for this project.' : 'The researchers and AI agents of this project.' },
    { id: 'badges', target: 'nav-conversations', side: 'right', title: 'Red badges', text: 'A red number counts what is new for you. Each person has their own read state.' },
    ...SHARED_END,
    { id: 'profile', target: 'profile', side: 'right', title: 'Connect your AI', text: 'Create a personal API key on your profile so that your AI client can read the project and submit facts.' },
    { id: 'help', target: 'help', side: 'right', title: 'You are all set', text: 'The help center explains every feature using this project’s data. You can replay this tour from it at any time.' },
  ];
}

/** Which tutorial should open by itself on this page, if any. */
export function tourToStart({ route, projectLoaded, seen = [], running = false }) {
  if (running) return null;
  if (route?.name === 'projects') return seen.includes('home') ? null : 'home';
  if (route?.name === 'project' && projectLoaded) return seen.includes('project') ? null : 'project';
  return null;
}

/** Position of the bubble beside its target, always kept inside the viewport. */
export function placeBubble(target, bubble, viewport, side = 'right', margin = 12, gap = 14) {
  const x = (v) => Math.max(margin, Math.min(v, viewport.width - bubble.width - margin));
  const y = (v) => Math.max(margin, Math.min(v, viewport.height - bubble.height - margin));
  if (!target) return { left: x((viewport.width - bubble.width) / 2), top: y((viewport.height - bubble.height) / 2), side: 'none', arrow: null };
  const fits = {
    right: target.right + gap + bubble.width + margin <= viewport.width,
    left: target.left - gap - bubble.width - margin >= 0,
    bottom: target.bottom + gap + bubble.height + margin <= viewport.height,
    top: target.top - gap - bubble.height - margin >= 0,
  };
  const chosen = [side, 'right', 'bottom', 'left', 'top'].find((s) => fits[s]);
  if (!chosen) return { left: x((viewport.width - bubble.width) / 2), top: viewport.height - bubble.height - margin, side: 'none', arrow: null };
  const cx = (target.left + target.right) / 2;
  const cy = (target.top + target.bottom) / 2;
  const edge = (v, size) => Math.max(16, Math.min(v, size - 16));
  if (chosen === 'right' || chosen === 'left') {
    const top = y(cy - bubble.height / 2);
    return { left: chosen === 'right' ? target.right + gap : target.left - gap - bubble.width, top, side: chosen, arrow: edge(cy - top, bubble.height) };
  }
  const left = x(cx - bubble.width / 2);
  return { left, top: chosen === 'bottom' ? target.bottom + gap : target.top - gap - bubble.height, side: chosen, arrow: edge(cx - left, bubble.width) };
}
