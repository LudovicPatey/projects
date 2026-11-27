// Help center content. KEEP THIS UP TO DATE: every new or changed feature must be explained here
// (tests/help.test.mjs fails when a controller or a menu view has no article).
//
// Inline syntax: **bold**, `code`, [label](help:slug), [label](app:view), [label](https://...).
// live(c => [...]) blocks show real items of the current project; `c` comes from /api/projects/{id}/help-context.
// This file has no dependency, so that it can be tested outside the browser.

const p = (text) => ({ type: 'p', text });
const h = (text) => ({ type: 'h', text });
const steps = (...items) => ({ type: 'steps', items });
const list = (...items) => ({ type: 'list', items });
const tip = (text) => ({ type: 'tip', text });
const warn = (text) => ({ type: 'warn', text });
const table = (head, ...rows) => ({ type: 'table', head, rows });
const live = (render) => ({ type: 'live', render });
const replayTour = { type: 'tour' };
const shot = (src, alt, caption) => ({ type: 'shot', src, alt, caption });
const cmd = (text, os) => ({ type: 'cmd', text, os }); // {site} becomes the address of this platform

// ----- pointers to real items of the project -----
const toFact = (f) => ({ label: f.title, code: f.label, to: { view: 'facts', id: f.id } });
const toFile = (f) => ({ label: f.title, to: { view: 'files', id: f.id } });
const toRef = (b) => ({ label: b.title, code: b.label, to: { view: 'bib', id: b.id } });
const toConv = (x) => ({ label: x.title, to: { view: 'conversations', id: x.id } });
const toPerson = (u) => ({ label: u.title, to: { view: 'members', query: { user: u.id } } });
const n = (count, one, many = one + 's') => `${count} ${count === 1 ? one : many}`;
const line = (text, links = []) => ({ text, links: links.filter(Boolean) });
const isOwner = (c) => c.project.role === 'owner';

export const CATEGORIES = [
  { id: 'start', title: 'Getting started', icon: 'home' },
  { id: 'project', title: 'Your project', icon: 'users' },
  { id: 'talk', title: 'Conversations and comments', icon: 'mail' },
  { id: 'docs', title: 'Files and bibliography', icon: 'files' },
  { id: 'facts', title: 'Fact database', icon: 'graph' },
  { id: 'ai', title: 'Working with AI', icon: 'bot' },
  { id: 'find', title: 'Staying up to date', icon: 'bell' },
  { id: 'admin', title: 'Privacy and administration', icon: 'key' },
];

// The steps shared by the Claude and ChatGPT installation guides.
const clientSteps = (tool) => [
  h('Step 4: Check Python'),
  p('The connector is a small Python program. Copy this command into the terminal and press **Enter**:'),
  cmd('python3 --version', 'macOS and Linux'),
  cmd('py --version', 'Windows'),
  p('If you see `Python 3.8` or a higher number, continue. Otherwise, install Python from [python.org](https://www.python.org/downloads/), close the terminal, open it again and retry. On Windows, tick **Add python.exe to PATH** in the installer.'),
  h('Step 5: Download the connector'),
  p('This creates a folder named `open-questions` in your home folder and puts the connector in it:'),
  cmd('mkdir -p ~/open-questions && cd ~/open-questions && curl -fsSL {site}/api/client/oq.py -o oq.py', 'macOS and Linux'),
  cmd('mkdir $HOME\\open-questions -Force; cd $HOME\\open-questions; curl.exe -fsSL {site}/api/client/oq.py -o oq.py', 'Windows (PowerShell)'),
  h('Step 6: Create your personal key'),
  steps('Open [your profile](app:profile) in a new tab.', 'Under **Personal API keys**, type a name such as `My laptop`.', 'Click **Create key**.', 'Click **Copy** next to the key. It is shown only once.'),
  shot('key-create.webp', 'The Personal API keys panel of the profile page, with a name field and a Create key button', 'The key panel on your profile page.'),
  h('Step 7: Connect this computer'),
  cmd('python3 oq.py setup', 'macOS and Linux'),
  cmd('py oq.py setup', 'Windows'),
  steps('Press **Enter** to accept the address of the platform.', 'Paste your key and press **Enter**. **Nothing appears while you paste:** this is normal, it protects your key.', 'The program lists your projects.'),
  shot('term-setup.webp', 'A terminal showing the setup command, the hidden key prompt and the list of projects', 'A successful connection.'),
  h('Step 8: Check that everything is ready'),
  cmd('python3 oq.py doctor', 'macOS and Linux'),
  cmd('py oq.py doctor', 'Windows'),
  shot(`term-doctor-${tool}.webp`, 'A terminal showing a list of checks marked OK', 'Each line should say `OK`. A line marked `!!` tells you what to fix. Your version numbers will differ.'),
  tip('Prefer a window? Run `python3 oq.py app` (`py oq.py app` on Windows). See [the app and usage limits](help:ai-app). Check your limits before starting.'),
  h('Step 9: Start working'),
  cmd(`python3 oq.py run --provider ${tool === 'claude' ? 'claude' : 'codex'}`, 'macOS and Linux'),
  cmd(`py oq.py run --provider ${tool === 'claude' ? 'claude' : 'codex'}`, 'Windows'),
  p('**Leave this window open.** The client checks for work every minute and processes it. Press **Ctrl+C** to stop it. Nothing is lost: an unfinished task returns to the queue.'),
  shot(`term-run-${tool}.webp`, 'A terminal showing the client processing an extraction, a question and a reference search', 'The client at work.'),
  h('Step 10: See the result'),
  p('Open [AI work](app:ai). A green banner confirms that your client is running.'),
  shot('ai-page.webp', 'The AI work page with a green status banner, figures, the queue and the new request form', 'The AI work page.'),
  h('Next time'),
  p('Open a terminal and run these two commands:'),
  cmd(`cd ~/open-questions\npython3 oq.py run --provider ${tool === 'claude' ? 'claude' : 'codex'}`, 'macOS and Linux'),
  cmd(`cd $HOME\\open-questions\npy oq.py run --provider ${tool === 'claude' ? 'claude' : 'codex'}`, 'Windows'),
  h('If something goes wrong'),
  table(['What you see', 'What to do'],
    ['`command not found` or `not recognized`', 'Close the terminal, open a new one and retry. If it persists, redo the installation step of that command.'],
    ['`Invalid or revoked API key`', 'Create a new key on your profile, then run `setup` again.'],
    ['`Cannot reach the platform`', 'Check your internet connection and the address of the platform.'],
    [tool === 'claude' ? 'Claude asks you to log in' : 'Codex asks you to sign in', `Run \`${tool === 'claude' ? 'claude' : 'codex'}\` once, sign in, exit, and start the client again.`],
    ['A task is marked **Failed**', 'Open it on the [AI work](app:ai) page to read the reason, then click **Try again**.']),
];

export const ARTICLES = [
  // ---------------------------------------------------------------- Getting started
  {
    slug: 'welcome', category: 'start', title: 'Welcome to Open Questions', summary: 'What the platform is for and how its parts fit together.',
    keywords: 'introduction overview tour what is start',
    blocks: [
      p('Open Questions is a workspace where a group of researchers works on **one open problem per project**, with AI handling intermediate problems and humans keeping control of what is accepted.'),
      live((c) => [line(`You are in **${c.project.title}** as **${c.project.role}**, with ${n(c.people.researchers, 'researcher')} and ${n(c.people.agents.length, 'AI agent')}. It holds ${n(c.facts.total, 'fact')}, ${n(c.files.total, 'file')}, ${n(c.bib.total, 'reference')}, and you take part in ${n(c.conversations.total, 'conversation')}.`)]),
      h('The main areas'),
      table(['Area', 'What it is for'],
        ['[Overview](app:overview)', 'The open problem, its status and a summary of the project'],
        ['[Questions](app:questions)', 'Big questions, sub-questions and their proof strategies'],
        ['[Mail](app:conversations)', 'Discussions with the people you choose'],
        ['[Facts](app:facts)', 'Statements and proofs, linked by what they depend on'],
        ['[Files](app:files)', 'PDFs and LaTeX sources, with their versions'],
        ['[Biblio](app:bib)', 'The references of the project'],
        ['[People](app:members)', 'Researchers and AI agents']),
      h('How humans and AI work together'),
      list('**Everything from AI is labelled** with its model, the person it worked for, and its generation time when measured.',
        '**AI clients enter the facts,** so that they all follow the same format.',
        '**Humans decide:** they endorse, dispute or retract results.',
        '**Each result is traceable** back to its sources and to the people credited.'),
      tip('Press **⌘K** or **Ctrl K** anywhere to search your projects and this help center.'),
    ],
    related: ['navigate', 'create-project', 'facts-overview'],
  },
  {
    slug: 'tutorial', category: 'start', title: 'The guided tour', summary: 'Speech bubbles that present the interface on first use.',
    keywords: 'tutorial tour guide onboarding first use speech bubble walkthrough replay skip',
    blocks: [
      p('The first time you sign in, speech bubbles point at the main parts of the interface. A second short tour presents the areas of a project the first time you open one.'),
      replayTour,
      h('Controls'),
      table(['Action', 'Button', 'Key'], ['Next step', '**Next**', '`→`'], ['Previous step', '**Back**', '`←`'], ['Stop all tutorials', '**Skip tour**', '`Esc`']),
      p('The tour only points at things: it does not open items, change data or mark anything as read. Your progress is saved with your account, so it does not reappear on your other devices.'),
    ],
    related: ['welcome', 'navigate'],
  },
  {
    slug: 'navigate', category: 'start', title: 'Finding your way around', summary: 'The left menu, the top bar and keyboard shortcuts.',
    keywords: 'menu navigation rail sidebar top bar shortcuts keyboard phone mobile switch project button what does it do effect hover explain',
    blocks: [
      h('Left menu'),
      p('The left menu switches between the areas of the project, like a webmail client. A red number shows what is new in each area. At the bottom are the **Help** center, your **Alerts** and your **profile**.'),
      p('The square at the top left shows the initials of the project. Click it to [switch to another project](app:projects).'),
      h('Top bar'),
      p('The top bar shows the current project, the [search bar](help:search), and a **Help** button that opens the article about the page you are on.'),
      h('Before you click'),
      p('Point at a button to see what it changes and what it leaves as it is. Buttons whose effect reaches further than you might expect say it beside them too, or ask you to confirm with the same explanation: **Retract** withdraws a fact for every member, while **Deny** only records your verdict; **Accept** on a consolidation proposal says what it does for that kind of proposal; on the notation page, **What each choice changes** lists each button of an entry, and **Applies to** says which objects the entry covers.'),
      p('**Not final yet** also lists what a fact waits for from a person: a question the AI asked when it made a choice the text does not settle, such as whether a source counts 0 among its finite sums, or when it could only read a summary of a source. Checking the rewrite, or reviewing the cited result, answers it; these questions also appear in **Needs your attention** on the overview.'),
      p('**Not final yet** marks what an AI pass is still due on: a fact the AI will rewrite in the project notation, a rewrite a second AI will check, a cited result it will look for in its source, a proof it will review, a notation entry whose parameters it will type, a proposal it will read a second time. The notice names the pass, says what it will do, whether it is queued now or once nobody has added facts for a while, and what you should do meanwhile. Do not fix by hand what the AI is about to redo; where your own judgment is needed, such as a review or a verdict, it still counts and wins.'),
      h('Keyboard shortcuts'),
      table(['Keys', 'Action'],
        ['`⌘K` or `Ctrl K`', 'Open the search'], ['`/`', 'Open the search, when you are not typing'],
        ['`↑` `↓` then `Enter`', 'Choose and open a search result'], ['`Esc`', 'Close the search or a window'],
        ['`⌘Enter` or `Ctrl Enter`', 'Send a message or a comment'], ['`@`', 'Mention someone or something while writing']),
      h('On a phone'),
      p('Lists and items are shown one at a time. Use **Back to list** to return to the list.'),
    ],
    related: ['search', 'unread'],
  },
  {
    slug: 'account', category: 'start', title: 'Your account and profile', summary: 'ORCID sign-in, your name, affiliation and email.',
    keywords: 'orcid login sign in sign out logout stay signed in remember phone disconnected session profile name affiliation email account password',
    blocks: [
      p('Your account is your **ORCID iD**. You sign in on orcid.org, so the platform has no password of its own.'),
      h('Change your details'),
      steps('Open [your profile](app:profile).', 'Edit your **display name**, **affiliation** or **email**.', 'Click **Save**.'),
      p('Your email address is visible only to you. It is not shown to other members or included in project downloads.'),
      p('**Sign out** is on the same page.'),
      p('Each device stays signed in for 60 days after its last visit, even when the browser or the phone closes the page. **Sign out** ends it on that device only. On a shared computer, sign out when you leave.'),
      tip('You can be added to a project before your first sign-in: you will find it when you sign in with that ORCID iD.'),
    ],
    related: ['people', 'privacy'],
  },
  {
    slug: 'create-project', category: 'start', title: 'Creating a project', summary: 'Start a new project around one open question.',
    keywords: 'new project create start question title',
    blocks: [
      steps('Open [your projects](app:projects).', 'Click **New project**.', 'Enter a **title** and state **the open question** precisely. LaTeX between `$…$` is rendered.', 'Click **Create project**. You become its owner.', 'Add your colleagues under [People](help:people).'),
      p('If you do not see **New project**, the administrator of this installation has limited who can create projects.'),
    ],
    related: ['question', 'people'],
  },

  // ---------------------------------------------------------------- Your project
  {
    slug: 'question', category: 'project', title: 'The project overview', summary: 'The main problem, its status and a summary of the project.',
    keywords: 'question overview status open solved archived edit title dashboard activity attention progress team worth reading suggestions read',
    blocks: [
      p('The [Overview](app:overview) page is the dashboard of the project: the main problem, how many questions are settled, **what needs your attention**, the big questions, the state of the facts and strategies, recent activity and the team.'),
      h('Worth reading'),
      p('Most facts are written by AI and many are routine steps, so nobody can read them all. After reading the whole database, the [consolidation](help:consolidation) marks the few that are **real progress**: a new result on a question, a key step, a surprising counterexample. They appear under **Worth reading** on the overview, with the reason, until you open the fact, review it, or click **Not for me**. The fact itself shows the reason at the top.'),
      p('When such a fact relies on [cited results](help:reviews) nobody accepted yet, its details line says how many, such as **2 cited results to check**; point at it, or tap it on a phone, to list them with links: AI uses citations without waiting, so these are the sources worth checking. Open one and click **Accept** once you have read its source.'),
      live((c) => [line(`The status of this project is **${c.project.status}**.` + (isOwner(c) ? ' As an owner, you can edit the question and change the status.' : ' Only its owners can edit the question or change the status.'), c.people.owners.map(toPerson))]),
      h('Edit the question (owners)'),
      steps('Click **Edit** under the problem.', 'Change the title or the statement.', 'Click **Save**.'),
      h('Status'),
      table(['Status', 'Meaning'], ['**Open**', 'Work in progress'], ['**Solved**', 'The question is answered'], ['**Archived**', 'The project is no longer active']),
    ],
    related: ['people', 'download-project'],
  },
  {
    slug: 'open-questions', category: 'project', title: 'Questions and sub-questions', summary: 'Organize the big questions of a project into a tree.',
    keywords: 'questions open problems sub-questions subquestions tree hierarchy goal priority status solved refuted partial progress roadmap',
    blocks: [
      p('A project can pursue several **big questions**. In [Questions](app:questions), split each one into **sub-questions**, at any depth up to eight levels. Each question has a statement, a status, a priority, comments and links to facts, files and references.'),
      live((c) => [
        line(c.questions.total ? `This project has ${n(c.questions.big, 'big question')}, ${n(c.questions.total, 'question')} in total, ${c.questions.open} not settled, and ${n(c.questions.strategies, 'proof strategy', 'proof strategies')}.` : 'This project has no question yet. Open [Questions](app:questions) to state the first one.', c.questions.top.map((q) => ({ label: q.title, to: { view: 'questions', id: q.id } }))),
        c.questions.without_strategy_count ? line(`${n(c.questions.without_strategy_count, 'unsettled question')} without a strategy:`, c.questions.without_strategy.map((q) => ({ label: q.title, to: { view: 'questions', id: q.id } }))) : null,
      ]),
      h('Add a question'),
      steps('Open [Questions](app:questions) and click **Question**.', 'Give it a title and, if you wish, a statement with LaTeX and @mentions.', 'Under **Part of**, choose its parent question, or leave it as a big question.', 'Click **Save**.'),
      tip('To add a sub-question directly, open the parent and click **Sub-question**.'),
      h('Status'),
      table(['Status', 'Meaning'], ['**Open**', 'Nobody is working on it yet'], ['**In progress**', 'Being worked on'], ['**Partial result**', 'Some progress is established'], ['**Solved**', 'Answered positively. Only a human can set this'], ['**Refuted**', 'Answered negatively. Only a human can set this'], ['**Abandoned**', 'No longer pursued']),
      p('In the tree and on the overview, a status is a small icon: a clock while in progress, a check for a partial result, a circled check when solved, a cross when refuted, a box when abandoned. Point at it for its meaning. **Open**, the usual case, shows no icon. Beside a question, the route icon counts its proof strategies.'),
      p('The bar on a question shows how many of its sub-questions are settled, meaning solved, refuted or abandoned. A parent is **never closed automatically**: whether its sub-questions answer it is a human judgment.'),
      h('Reorganize'),
      p('Click **Edit** and change **Part of** to move a question with all its sub-questions. A question cannot be placed under one of its own sub-questions. To delete a question, first move or delete its sub-questions. Its author or a project owner can delete it.'),
    ],
    related: ['answers', 'proof-strategies', 'question'],
  },
  {
    slug: 'answers', category: 'project', title: 'Answering a question', summary: 'Propose an answer backed by a fact, then ratify it.',
    keywords: 'answer positive negative yes no propose proposal ratify ratification reject revoke withdraw solved refuted',
    blocks: [
      p('An answer to a question is always **backed by a fact** of the database. A human or an AI client can propose it, but **only a human can ratify it**. Until then, the question does not change.'),
      live((c) => [
        c.questions.pending.length ? line(`${n(c.questions.pending_count, 'question')} with an answer to ratify:`, c.questions.pending.map((q) => ({ label: q.title, to: { view: 'questions', id: q.id } }))) : line('No answer is waiting for ratification in this project.'),
        c.questions.at_risk.length ? line('Ratified answers whose fact needs attention:', c.questions.at_risk.map((q) => ({ label: q.title, to: { view: 'questions', id: q.id } }))) : null,
      ]),
      h('Propose an answer'),
      steps('Open a question in [Questions](app:questions).', 'Under **Answer**, click **Propose an answer**.', 'Choose **Positive** or **Negative**, then the fact.', 'Explain why this fact answers the question, and click **Propose**.'),
      h('Ratify an answer'),
      steps('Read the fact and the explanation. Click the fact to open its proof.', 'If you checked it, click **Endorse fact**. If it is wrong, click **Deny fact** and say why.', 'Once a human has endorsed the fact, click **Ratify**.'),
      p('A positive answer marks the question **Solved**, and a negative answer marks it **Refuted**. The status then stays locked to the ratified answer.'),
      warn('Ratify is unavailable while the fact has no human endorsement, is denied, disputed, proof-disputed or retracted, or relies on a fact that is one of these.'),
      h('If the fact changes later'),
      p('If a ratified fact is revised, denied, retracted or loses an endorsement, or a fact it relies on is denied or retracted, the person who ratified it is alerted and the answer is flagged. The question **does not reopen by itself**: a human decides, with **Revoke ratification**, which returns it to In progress and keeps the record.'),
      h('Other actions'),
      table(['Action', 'Who', 'Effect'], ['**Reject**', 'Any human member, with a reason', 'Closes the proposal'], ['**Withdraw**', 'Its author', 'Takes the proposal back'], ['**Revoke ratification**', 'Any human member, with a reason', 'Reopens the question']),
    ],
    related: ['open-questions', 'reviews', 'proof-strategies'],
  },
  {
    slug: 'proof-strategies', category: 'project', title: 'Proof strategies', summary: 'Track each approach to a question and how it evolves.',
    keywords: 'proof strategy strategies approach plan attempt idea blocked failed succeeded revision history version evolve timeline restore',
    blocks: [
      p('Each question can have several **proof strategies**, the approaches being tried in parallel. A strategy has a name, a status, a description, comments, links, and a full history.'),
      live((c) => [
        c.questions.blocked.length ? line('Blocked strategies that could use a fresh look:', c.questions.blocked.map((s) => ({ label: s.title, to: { view: 'questions', id: s.id, query: { strategy: s.strategy } } }))) : line(c.questions.strategies ? `This project has ${n(c.questions.strategies, 'proof strategy', 'proof strategies')}, and none is blocked.` : 'No strategy has been written in this project yet.'),
      ]),
      h('Add a strategy'),
      steps('Open a question in [Questions](app:questions).', 'Under **Proof strategies**, click **Strategy**.', 'Name it, choose a status and describe the approach.', 'Click **Add strategy**.'),
      h('How a strategy evolves'),
      p('Click **Revise** to change it, and say what changed and why. Each change of name, status or text creates a **new version**. The **How it evolved** timeline shows who changed what, and when, with the AI model if any.'),
      list('**View** displays an earlier version.', '**Restore** brings it back as a new version, so nothing is lost.', 'If someone revised the strategy while you were editing, your save is refused instead of overwriting their work.'),
      h('Status'),
      table(['Status', 'Meaning'], ['**Idea**', 'Proposed, not tried yet'], ['**Being tried**', 'Work in progress'], ['**Blocked**', 'Stuck on an obstacle'], ['**Succeeded**', 'It works. Only a human can set this'], ['**Failed**', 'It cannot work, or was shown not to'], ['**Abandoned**', 'No longer pursued']),
      p('In lists, a strategy\'s status is an icon (a bulb for an idea, a route while tried, a lock when blocked); point at it for its meaning, and at the date for its version.'),
      tip('Keep failed strategies. Recording why an approach fails saves the group from trying it again.'),
    ],
    related: ['open-questions', 'answers', 'comments'],
  },
  {
    slug: 'administration', category: 'project', title: 'Administer a project', summary: 'Maintenance for owners: empty the facts, reset extraction, clean the AI queue.',
    keywords: 'admin administration owner maintenance reset empty delete facts database extraction status start over clean base queue cancel retry failed notation backup restore command ssh audit auditor key read-only api review',
    blocks: [
      p('The **Admin** page appears only for the owners of a project. It shows what the project holds and runs maintenance actions. Each action first says exactly what it will change.'),
      live((c) => [line('Open the administration of this project (owners only).', [{ label: 'Open Admin', to: { view: 'admin' } }])]),
      table(['Action', 'What it does'],
        ['**Cancel the waiting AI tasks**', 'Tasks no client has taken are cancelled. Running ones finish'],
        ['**Try the failed AI tasks again**', 'Failed tasks wait again, with their attempts reset'],
        ['**Extract what is not extracted yet**', 'Queues each file and reference PDF with no extraction waiting or finished'],
        ['**Reset the extraction status**', 'Every file and reference PDF shows as not extracted. Facts stay. Optionally extracts everything again'],
        ['**Clear the project notation**', 'Deletes the proposals nobody agreed on, or everything, including the rewritten facts'],
        ['**Empty the facts database**', 'Deletes every fact with its reviews, proofs, Lean proofs, comments and rewrites, and the answers they support. Extraction starts over']),
      warn('The last three actions delete data. A **verified backup of the whole platform** is made first, and you must type the title of the project. Only the administrator can restore that backup. The bibliography and its PDFs, the files, conversations, questions and members are never changed.'),
      h('Start again with a clean base'),
      steps('Open **Admin** and click **Review…** on **Empty the facts database**.', 'Tick **Then extract every file and reference PDF again** if you want the AI clients to start at once. Tick **Also delete the project notation** to start that over too.', 'Read what will be deleted, type the title of the project, and confirm.'),
      p('Ratified answers backed by a deleted fact are deleted. Their questions keep their status, so check them afterwards.'),
      h('Audit access'),
      p('An **audit key** lets an auditor, a person or an AI, read this project\'s facts, reviews and notation through the audit API, for example to look for duplicate facts, clashing notation or weak proofs. Create one under **Audit access**: give it a label and a duration of 1, 7 or 30 days, then copy it, because it is shown only once.'),
      list('It is read-only, and works for this project only. It cannot sign in or open anything else.', 'Private conversations stay hidden, and no email or ORCID iD is shared.', 'The page shows when each key was last used and how often. **Revoke** stops it at once.', 'With a copy of the repository, `npm run audit:fetch` saves everything to a local folder for the audit.'),
      h('From the server'),
      p('The administrator can run the same actions with `php bin/admin.php --project ID ACTION` on the server, or `npm run admin -- --project ID ACTION` over SSH. Without `--apply`, or before you type `APPLY`, it only shows what would change.'),
    ],
    related: ['people', 'backups', 'ai-work', 'notation'],
  },
  {
    slug: 'people', category: 'project', title: 'Researchers and roles', summary: 'Add colleagues, change roles, or leave a project.',
    keywords: 'members people researchers invite add remove owner member role leave orcid team',
    blocks: [
      live((c) => [line(`This project has ${n(c.people.researchers, 'researcher')}. You are **${c.project.role}**. Owners:`, c.people.owners.map(toPerson))]),
      h('Add a researcher (owners)'),
      steps('Open [People](app:members).', 'Enter their **ORCID iD** or ORCID link.', 'Choose **Member** or **Owner**, and click **Add**.'),
      p('They do not need to have signed in before. Their public ORCID name is fetched automatically.'),
      p('Each card says when the researcher became a member, and whether they use the platform: **created the project 3 d ago**, **added 2 d ago**, or **added 2 d ago, has not signed in yet** until their first sign-in. The overview reports **Ann added Bob** when an owner adds a member, or a member connects an AI agent.'),
      h('What each role can do'),
      table(['Action', 'Member', 'Owner'],
        ['Read the project, write, upload, review', 'Yes', 'Yes'],
        ['Delete what they added', 'Yes', 'Yes'],
        ['Delete what others added', 'No', 'Yes'],
        ['Edit the question and status', 'No', 'Yes'],
        ['Manage members and AI agents', 'No', 'Yes']),
      h('Leave a project'),
      p('Click **Leave** on your line in [People](app:members). A project must keep at least one owner.'),
    ],
    related: ['project-agents', 'privacy'],
  },
  {
    slug: 'download-project', category: 'project', title: 'Downloading a copy of the project', summary: 'Get everything you can see as a .zip file.',
    keywords: 'download export copy zip archive backup offline save',
    blocks: [
      p('Any member can download a complete copy of what they can see.'),
      steps('Open the [Overview](app:overview) page.', 'Click **Download project**.', 'The download starts when the copy is ready.'),
      p('The [AI client](help:ai-app) can optionally make this copy for you on a schedule and keep only the latest ones.'),
      live((c) => [line(`Your copy of **${c.project.title}** would contain ${n(c.facts.total, 'fact')}, ${n(c.files.total, 'file')} with all their versions, ${n(c.bib.total, 'reference')} and your ${n(c.conversations.total, 'conversation')}.`)]),
      h('What is inside'),
      table(['Folder', 'Content'], ['`facts/`', 'Readable facts and JSON, with reviews, Lean proofs and traceability'], ['`files/`', 'Every version, with its PDF and sources'], ['`bibliography/`', 'A `.bib` file, the PDFs and comments'], ['`conversations/`', 'The conversations you take part in'], ['`manifest.json`', 'The list of files with their SHA-256']),
      warn('The copy does not include private conversations you are not part of, email addresses, API credentials or read state.'),
    ],
    related: ['privacy', 'backups'],
  },

  // ---------------------------------------------------------------- Conversations and comments
  {
    slug: 'conversations', category: 'talk', title: 'Conversations', summary: 'Linear discussions with the people you choose.',
    keywords: 'mail messages discussion inbox starred archived reply send participants thread email',
    blocks: [
      p('[Mail](app:conversations) works like a webmail: the list on the left, the selected conversation in the middle, and its comments on the right.'),
      live((c) => c.conversations.unread.length ? [line('Waiting for you:', c.conversations.unread.map(toConv))]
        : c.conversations.latest ? [line('You are up to date. Your latest conversation:', [toConv(c.conversations.latest)])]
          : [line('You do not take part in any conversation of this project yet.')]),
      h('Start a conversation'),
      steps('Click **New**.', 'Enter a **subject** and choose the **participants**.', 'Write your message and click **Send**.'),
      warn('Only participants can see a conversation. People you add later see its whole history.'),
      h('Organize'),
      table(['Action', 'Effect'], ['**Star**', 'Keeps it in the Starred folder'], ['**Archive**', 'Removes it from the inbox. A new message brings it back'], ['**Mark as unread**', 'Shows it as new again, for you only'], ['**Leave**', 'You no longer see it, unless someone adds you back']),
      p('You can edit your own messages. An edited message is marked as such.'),
      h('Ask the AI'),
      p('Write your question and click **Ask AI**, or leave the draft empty to ask its opinion on the discussion. Everyone in the conversation sees the question and the answer. The work runs on the AI client of a participant, so the discussion is sent to that person’s AI provider.'),
      h('Extract facts from a conversation'),
      steps('Open the conversation.', 'Click **Extract facts**.', 'If the conversation is private, read the notice and confirm.', 'The next AI client of a **participant** adds the results to [Facts](app:facts), each with the message it comes from and an exact quotation.'),
      list('Extraction never starts by itself on a conversation.', 'Guesses and ideas are not recorded as theorems, and a claim withdrawn later in the discussion is left out.', 'After new messages, the button becomes **Extract new messages**.'),
      warn('Every project member sees the statements and proofs extracted from a private conversation. Its quotes and link stay hidden from non-participants. The other participants are notified, only the messages present when you confirm are read, and the request stops if one of them is edited before it runs.'),
    ],
    related: ['comments', 'writing', 'ai-work'],
  },
  {
    slug: 'comments', category: 'talk', title: 'Comments and threads', summary: 'Discuss a passage, a file, a reference or a fact.',
    keywords: 'comment thread reply resolve reopen highlight passage selection annotate pdf',
    blocks: [
      p('Comments are short threads attached to something, separate from conversations. They appear in the right column of Mail, Files, Biblio and Facts.'),
      live((c) => c.thread ? [line('An open thread in this project:', [{ label: 'Open this thread', to: { view: c.thread.view, id: c.thread.id, query: { comment: c.thread.comment } } }])] : [line('There is no open comment thread in this project at the moment.')]),
      h('Comment on a passage'),
      steps('Select text in a **PDF** or in a **message**.', 'Click **Comment**, or write in the panel that appears.', 'Your comment stays attached to that passage, which is highlighted.'),
      p('Click a highlight to find its thread, or click a thread to jump to its passage.'),
      h('General comments'),
      p('Click **Comment** at the top of the right column.'),
      h('Follow-up'),
      list('**Reply** continues the thread and notifies those who took part.', '**Resolve** hides the thread once settled. Tick **Show resolved** to see it again, and **Reopen** it if needed.', 'On files, comments belong to a version. Tick **Show comments of all versions** to see the others.'),
    ],
    related: ['pdf', 'writing'],
  },
  {
    slug: 'references', category: 'talk', title: 'References to anything', summary: 'Cite any object of the project from any rich text.',
    keywords: 'reference references cite citation mention link at @ chip preview object filter private backlink mentioned',
    blocks: [
      p('In any message, comment, statement, strategy or answer, type `@` and a few letters to cite **any object** of the project. It appears as a colored chip with a live title and status.'),
      table(['You can cite', 'Filter'],
        ['Question', '`q:`'], ['Strategy', '`s:`'], ['Strategy version', '`rev:`'], ['Answer', '`a:`'],
        ['Fact', '`fact:`'], ['Fact review', '`review:`'], ['Other proof of a fact', '`proof:`'], ['Notation entry', '`notation:`'], ['Lean proof', '`lean:`'],
        ['File', '`file:`'], ['File version', '`version:`'], ['Reference', '`bib:`'],
        ['Suggested reference', '`suggestion:`'], ['Conversation', '`conv:`'], ['Message', '`msg:`'], ['Comment', '`comment:`'], ['AI task', '`task:`'],
        ['Person', '`who:`'], ['Project', '`project:`']),
      tip('Type a filter to search one kind of object, for example `@lean:scale` or `@q:residue`.'),
      h('Reading a reference'),
      list('**Hover** a chip to preview it, with its status, author and AI model.', '**Click** it, or press **Enter**, to open exactly that object: a message scrolls into view, a version opens on that version.', 'The title and status are **always current**, even if the object was renamed after being cited.', 'A crossed-out chip means the object has been deleted.'),
      h('Privacy'),
      p('A reference never reveals a private conversation. Someone who does not take part in it sees a gray **Private** chip, with no subject and no content. This applies to the conversation, its messages and its comments.'),
      live((c) => [line('Questions, strategies, facts, files and references list where they are cited under **Mentioned in**.', c.questions.top.slice(0, 1).map((q) => ({ label: q.title, to: { view: 'questions', id: q.id } })))]),
    ],
    related: ['writing', 'comments', 'open-questions'],
  },
  {
    slug: 'writing', category: 'talk', title: 'Writing: formatting, LaTeX and mentions', summary: 'Rich text, formulas and @mentions.',
    keywords: 'latex katex math formula equation mention at @ bold italic format editor rich text link',
    blocks: [
      h('LaTeX'),
      table(['You type', 'Result'], ['`$x^2 + y^2$`', 'A formula in the text'], ['`$$\\sum_i x_i$$`', 'A centered formula']),
      h('Mentions'),
      p('Type `@` then a few letters to cite **anything in the project**: a person, question, strategy, answer, fact, other proof, Lean proof, file, reference, conversation, message or comment. See [References to anything](help:references).'),
      tip('Mentioning an AI agent is how you ask it to answer, if its owner runs it. See [project agents](help:project-agents).'),
      h('Formatting'),
      p('The toolbar offers bold, italics, code, links, quotes and lists. **⌘Enter** or **Ctrl Enter** sends.'),
    ],
    related: ['conversations', 'comments'],
  },

  // ---------------------------------------------------------------- Files and bibliography
  {
    slug: 'files', category: 'docs', title: 'Files and versions', summary: 'PDFs, LaTeX sources, versions and the human or AI mark.',
    keywords: 'file upload pdf latex tex sources version restore history zip human ai model document paper',
    blocks: [
      p('A file in [Files](app:files) is **one PDF**, with optional **LaTeX sources** (`.tex`, `.bib`, figures, `.zip`), and a full version history.'),
      live((c) => c.files.total ? [line(`This project has ${n(c.files.total, 'file')}. For example:`, [c.files.human && toFile(c.files.human), c.files.ai && toFile(c.files.ai)]),
        c.files.versioned ? line('A file with several versions:', [toFile(c.files.versioned)]) : line('No file has a second version yet.')]
        : [line('This project has no file yet.', [{ label: 'Upload the first one', to: { view: 'files', query: { upload: 1 } } }])]),
      h('Upload a file'),
      steps('Click **Upload**.', 'Enter a **title** and say whether a **human** or an **AI** wrote it.', 'For AI, enter the **model**, which is required. Add the generation time only if you measured it.', 'Choose the **PDF**, and optionally the sources.', 'Click **Upload file**.'),
      h('Versions'),
      list('**New version** adds a PDF and sources. You can keep the sources of the current version.', 'The **Versions** tab lists the history, with downloads.', '**Restore** creates a new version identical to an old one, so history is never lost.', '**.zip** downloads a version with its sources.'),
      warn('A banner tells you whether a file is human or AI-written. Check AI-written files carefully before relying on them.'),
    ],
    related: ['pdf', 'ai-labels'],
  },
  {
    slug: 'pdf', category: 'docs', title: 'Reading and annotating PDFs', summary: 'The built-in viewer and comments on selected text.',
    keywords: 'pdf viewer read zoom annotate highlight select page download',
    blocks: [
      p('PDFs of files and references open directly in the page. Use the toolbar to **zoom**, **fit the width**, open the PDF in a new tab or **download** it.'),
      live((c) => (c.files.latest ? [line('Try it on:', [toFile(c.files.latest)])] : [line('Upload a PDF under [Files](app:files) to use the viewer.')])),
      h('Annotate'),
      steps('Select a passage with the mouse.', 'Write your comment in the right column.', 'The passage stays highlighted for everyone in the project.'),
      tip('The search bar finds file titles, descriptions and file names, but **not the text inside PDFs**.'),
    ],
    related: ['comments', 'files'],
  },
  {
    slug: 'bibliography', category: 'docs', title: 'Bibliography', summary: 'Add references by DOI, arXiv or BibTeX, and attach PDFs.',
    keywords: 'bibliography references biblio bibtex doi arxiv citation cite export pdf paper',
    blocks: [
      live((c) => c.bib.total ? [line(`This project has ${n(c.bib.total, 'reference')}.` + (c.bib.without_pdf_count ? ` ${n(c.bib.without_pdf_count, 'reference')} without a PDF:` : ' All have a PDF.'), c.bib.without_pdf.map(toRef))]
        : [line('The bibliography of this project is empty.', [{ label: 'Open Biblio', to: { view: 'bib' } }])]),
      h('Add references'),
      steps('Open [Biblio](app:bib) and click **Add**.', 'Choose **DOI / arXiv**, **Paste BibTeX** (several entries at once) or **Manual**.', 'Click **Add**.'),
      h('Use them'),
      p('Each card shows the title, year and authors, then small icons: a red PDF icon when its PDF is attached (gray without), a sparkle once its facts were extracted (a clock while queued, a cross if it failed, a bubble when new comments call for a new extraction), and a robot for the AI that entered it. Point at an icon for what it means. The cite key is on the reference\'s page, with the copy icon.'),
      list('**Upload PDF** attaches one PDF to a reference, which you can read and annotate.', 'The **BibTeX** tab lets you correct an entry.', 'The copy icon copies its `\\cite{…}` command.', 'The download icon exports the whole bibliography as `.bib`.', 'When a reference has a PDF, **Extract facts** asks a running [AI client](help:ai-work) to add the results it states, with exact quotations and page numbers.', 'The **progress bars** above the list show how many references have a PDF, and how many of those PDFs had their facts extracted. **Extract remaining** queues all the others at once. Replacing a PDF starts its extraction over.', 'The **Mentions** tab shows where it is cited.'),
    ],
    related: ['pdf', 'writing'],
  },

  // ---------------------------------------------------------------- Fact database
  {
    slug: 'facts-overview', category: 'facts', title: 'What is the fact database?', summary: 'A shared graph of statements, proofs and dependencies.',
    keywords: 'facts database graph dag statement proof intuition dependency list link lemma theorem number hover preview danus knowledge star stars starred interesting important key facts large huge big graph neighborhood around depth subject tag tags topic consolidate',
    blocks: [
      p('[Facts](app:facts) records what the project knows. A fact has a **statement**, usually a **proof**, an optional **intuition**, and the **facts it depends on**. Together they form a graph.'),
      live((c) => c.facts.total ? [line(`This project has ${n(c.facts.total, 'fact')}.` + (c.facts.to_review_count ? ` ${n(c.facts.to_review_count, 'fact')} await your review:` : ' You have reviewed them all.'), c.facts.to_review.map(toFact)),
        c.facts.most_used && line(`The most reused result is used by ${n(c.facts.most_used.used_by, 'other fact')}:`, [toFact(c.facts.most_used)])].filter(Boolean)
        : [line('This project has no fact yet. Your [AI client](help:ai-client) can extract them from your papers and discussions.')]),
      h('List and graph'),
      list('**List:** search, filter by status, proof origin, label, star, [subject tag](help:consolidation) or Lean, and sort, for example by **Most starred**. Click **Filters** to show them.', '**Graph:** a fact appears below what it depends on. Click one to highlight its lineage. Drag to pan, and scroll to move. Use the zoom buttons or **Fit**.'),
      h('Stars and large graphs'),
      p('Not every fact matters as much. Click the star in the bar of a fact, or in the list, to mark the ones that do. Stars are shared: everyone sees how many a fact has and who gave them, and **Starred by me** shows only yours. Only people give stars.'),
      table(['Graph view', 'What it shows'], ['**★ Key facts**', 'Only starred facts. Two are linked when one relies on the other, directly or through other facts, and the link says through how many. Links implied by others are left out, so the map stays readable however large the database is'], ['**Worth reading**', 'Only the facts marked [worth reading](help:consolidation): real progress, a key step, a surprising example. They are linked the same way as key facts, so you see how the important results build on each other'], ['**Around a fact**', 'The selected fact, what it relies on and what relies on it, 1, 2, 3 or 5 steps away, or its whole lineage. Without a selection, it centers on the most starred or used fact'], ['**Everything**', 'Every fact. Starred ones stand out with a gold border and keep their name when you zoom out']),
      p('A project with more than 300 facts opens on **Key facts** when some are starred, and on **Around a fact** otherwise. Only the part on screen is drawn, so even the whole graph stays fluid.'),
      p('Each fact shows its title, with formulas in plain characters; point at it for its status, proof and key. A fact sits below the facts it relies on. In **Everything**, facts linked to no other fact are grouped below the rest, and wide rows wrap, so the whole map fits on screen.'),
      h('How facts are added'),
      p('Facts are not typed in the interface. **AI clients and agents submit them through the API**, so they all follow one validated format. Humans then [review and endorse](help:reviews) them.'),
      h('Reading a fact'),
      table(['Tab', 'Content'], ['**Fact**', 'Statement, proof, intuition and sources'], ['**Reviews**', 'Verdicts of humans and AI'], ['**Lean**', 'Formal proofs'], ['**Links**', 'What it uses, and what uses it'], ['**Trace**', 'Where it comes from, and who is credited']),
      p('A proof often names other facts the way its paper does, such as **Lemma 2.4** or **Theorem 3**. When the database holds that result, the name is a **link**: point at it, or reach it with the Tab key, to see the fact, and click it to open it. A name is linked only when exactly one fact of that kind has that number, among the facts the proof depends on and then among those found in the same paper, so a name that could mean two facts stays plain text. A fact cited with `@fact:` works the same way.'),
    ],
    related: ['fact-labels', 'reviews', 'traceability', 'consolidation'],
  },
  {
    slug: 'fact-labels', category: 'facts', title: 'Labels and kinds of facts', summary: 'Counterexample, conclusion, dead end and the other labels.',
    keywords: 'labels kinds counterexample conclusion example proof attempt plan dead end direction obstacle guidance verification elaboration lemma theorem definition',
    blocks: [
      p('Each fact has a mathematical **kind** (definition, lemma, theorem…) and one or more **labels**, taken from the Danus vocabulary.'),
      list('The buttons above the fact list **filter by kind**: theorems, propositions, lemmas, corollaries, definitions, conjectures and remarks.', 'Danus does not state a kind, so its facts show the kind their own text announces.', 'In the **Readable** view, definitions, statements, claims and proofs appear as separate blocks, and a bar at the top jumps to each one.'),
      live((c) => { const e = Object.entries(c.facts.labels); return e.length ? [line('Labels used in this project: ' + e.map(([k, v]) => `**${k.replaceAll('_', ' ')}** (${v})`).join(', ') + '.'), c.facts.counterexamples.length ? line('Counterexamples:', c.facts.counterexamples.map(toFact)) : null].filter(Boolean) : [line('No fact has a label yet in this project.')]; }),
      table(['Label', 'Meaning'],
        ['**conclusion**', 'An established result'], ['**example**', 'A worked example'], ['**counterexample**', 'A case refuting a claim'], ['**proof attempt**', 'A proof not yet accepted'],
        ['**plan**', 'A plan of work'], ['**direction**', 'A line of attack'], ['**obstacle**', 'A difficulty met'], ['**dead end**', 'An approach that failed, recorded to avoid repeating it'],
        ['**master guidance**', 'Guidance for the overall effort'], ['**verification**', 'A check of another result'], ['**elaboration**', 'A more detailed version of a result']),
      p('An extraction labels each fact of a paper or a discussion: **conclusion** for a result, **example**, **counterexample** for a case showing that a statement fails, and **obstacle** for a result showing that a method cannot work (AI client 1.19.0 and later).'),
      tip('Filter the list by label to review, for example, every **dead end** before trying a new approach.'),
    ],
    related: ['facts-overview', 'danus'],
  },
  {
    slug: 'reviews', category: 'facts', title: 'Reviewing and endorsing facts', summary: 'How facts become trusted, and what each status means.',
    keywords: 'review endorse endorsement deny denied validate verdict correct gap incorrect status unchecked disputed checked double trust validate result proof another alternative propose believe true false cited citation accept source check outside reference incomplete',
    blocks: [
      live((c) => c.facts.to_review.length ? [line(`${n(c.facts.to_review_count, 'fact')} await your review. Start with:`, c.facts.to_review.map(toFact)), c.facts.disputed.length ? line('Disputed, and worth a look:', c.facts.disputed.map(toFact)) : null].filter(Boolean) : [line(c.facts.total ? 'You have reviewed every fact of this project.' : 'There is nothing to review yet.')]),
      h('What to verify first'),
      p('The platform ranks the proved facts that no person has checked yet by what rests on them. First come the facts an answer to a question rests on, directly or through other facts, then those a result worth reading rests on, then those many facts rely on. Among equals, the least checked come first. The AI reviews follow this order, and so does the overview\'s **What needs you**.'),
      list('In the list of facts, sort by **To verify first**. Under **Filters**, **To verify** keeps only these facts. **AI review due** keeps those an AI will review next, so there is no need to check them by hand first. **Waiting for a person** keeps those that only a person can settle now.', 'A target icon marks a fact an answer rests on, an eye one that a result worth reading rests on, and a stack with a number one that many facts rely on. Point at the icon for the reason and for what it waits for.', 'A check is **independent** when it comes from a person, or from an AI of another company than the one whose model wrote the proof. Two Claude models, or two GPT models, share their blind spots. The AI-checked icon is gray when only an AI of the same company checked the proof. The automatic review then gives the proof to another company\'s AI when a client of one is around.', 'A member whose AI client is signed in to both Claude and ChatGPT runs everything on one of them, and reviews proofs with the other. Their reviews are independent of everything the first one wrote. This needs client 1.21.0.'),
      h('Endorse'),
      p('**Endorse** is one click in the bar of a fact, which stays at the top of the page while you read. It means that you checked this revision and consider it correct. Click again to withdraw.'),
      p('The bar also holds the parts of the fact (the fact itself, its reviews, Lean proofs, links and trace) and three menus, each item saying what it does: the cross to disagree (**Result, not proof** or **Deny**), **AI** to ask an AI client for a review, a Lean proof, an answer or new facts built on it, and the dots for **Cite**, **Mark as unread**, **Retract** and **Delete**. Above the bar, one line says where the fact stands, as icons with their words: point at each for what it means. A warning there, such as **Rests on unchecked facts**, opens its trace.'),
      h('Cited results and proved facts'),
      p('A fact is either a **cited result** or a **proved fact**. A cited result states a result of another work without its proof, for example a theorem a paper cites from an earlier one. A proved fact has its proof here.'),
      list('A cited result can only be accepted by a person who read its source: click **Accept**. An AI reads the source of each new cited result **automatically**, once, and says whether the source states it. This is upkeep, done by a [sweep](help:ai-work) once the project has been quiet for a while: results found in the same source are checked together, ten at a time, with the source itself when the project has it: the file, or the PDF attached to the reference. **The source could not be read** means that the AI had neither that text nor what the work states on the web; it says nothing about the result. A check made without the source is made once more when its file or PDF arrives. Its answer is shown apart, as **Source confirmed by AI**, and never accepts the citation: the [native prover](help:native-prover) may use any cited result unless people dispute it or a check finds that its source states something else. Nobody needs to accept every citation: when a result worth reading relies on some nobody accepted, the overview lists them beside it. **Check the source** asks for another check.', 'A proof relies only on facts of the database, cited results included. A review checks it against them: an AI reviewer assumes its dependencies and does not search the web.', 'When a proof still uses a result of another work directly, the fact shows **Outside result**, and what relies on it is marked as incomplete. Under **Results used from other works**, link each one to the fact that states it, or mark it **Not used** when the proof only mentions the work. A consolidation proposes these links and writes the cited results that are missing.', 'Proposing a proof of a cited result makes it a proved fact.'),
      p('The **Trace** tab lists the cited results a fact rests on, at any depth, and how many a member accepted. Filter the list by **Proved here**, **Cited results** or **Using an outside result**.'),
      h('Accept the result, not the proof'),
      p('**Result, not proof**, in the cross menu of the bar, means that you believe the result, but its proof has a gap or an error. Say which, and point to the step. The fact becomes **Proof disputed**: facts that use it stay usable and are marked as relying on an unproved result, and it cannot support a ratified answer until a proof is accepted.'),
      h('Deny'),
      p('**Deny**, in the same menu, means that the result itself is false, and asks you to point to the error or give a counterexample. The fact becomes **Disputed**, and facts relying on it are flagged. Only human endorsement lets a fact support a [ratified answer](help:answers).'),
      h('When an AI finds a flaw: the repair'),
      p('When an AI review finds a gap or an error, the proof is not left there. An AI of **another company** than the reviewer answers the review, with the fact\'s definitions and the facts it may rely on: it **repairs** the proof, or explains why **the review is wrong**, or says the gap **cannot be fixed**. A repaired proof is added as another proof, marked **Repair**: the reviewed text never changes, and the statement is never weakened. An AI of the **reviewer\'s side** then checks the repair, or reads the answer.'),
      table(['Outcome', 'What it means'], ['**Both AIs agree on a proof**', 'The reviewer\'s side accepts the repaired proof, or the answer. The review no longer counts against the fact, which is AI-checked: a person still checks it before an answer can rest on it'], ['**Both AIs see a gap neither can fix**', 'Left to people, with what is missing'], ['**No agreement**', 'After three rounds, left to people with both sides\' arguments']),
      list('**Repair of the proof**, under the proof, shows where it stands and each step, with its reasons under **Why**. While a step is due, the fact says which AI it waits for: no need to repair it by hand meanwhile.', 'A person\'s review starts nothing by itself. To have AIs answer it, open the **AI** menu of the fact and click **Repair the proof**.', 'AI clients run the repairs from version 1.22.0, or earlier once their member turns on **Repair proofs** and **Check repairs** on the Work page.'),
      h('Propose another proof'),
      steps('Open the fact, under **Other proofs**.', 'Click **Propose another proof**, write it with `$…$` for formulas, and save.', 'Other members mark it **Correct**, **Gap** or **Error**. Nobody checks their own proof, and an AI model never checks a proof it wrote.'),
      list('One accepted proof is enough: the fact counts as checked even if another proof is disputed.', 'A reviewer who says the result is false still disputes the fact, whatever proof is accepted.', 'Rewriting a proof clears its reviews. Its author or a project owner can withdraw it.', 'AI clients can propose proofs too, labelled with their model. Cite one as `@proof:`.'),
      h('Write a review'),
      steps('Open the **Reviews** tab.', 'Judge **the proof**: **Correct**, **Gap** or **Incorrect**.', 'If it is not correct, say whether **the result itself** is true, false, or you are not sure.', 'Explain what you checked. An explanation is required for a gap or an error.', 'Click **Submit review**.'),
      h('Status'),
      p('A fact opens in a **Readable** view, with headings, lists, numbered formulas, and formulas typeset in LaTeX. Each formula is read back and compared with the stored text, and one that does not match exactly stays as written. **Original** shows the stored text, which never changes.'),
      table(['Status', 'Meaning'], ['**Unchecked**', 'No independent check yet'], ['**AI-checked**', 'Accepted by an AI model other than its author. A gray icon means only an AI of its author\'s company accepted it'], ['**Human-checked**', 'Accepted by a human'], ['**Human + AI checked**', 'Accepted by both'], ['**Citation accepted**', 'A cited result that a member accepted after reading its source'], ['**Source confirmed by AI**', 'A cited result whose source an AI read: evidence, not an acceptance'], ['**Proof disputed**', 'The result is accepted, but every proof has a reported gap or error'], ['**Disputed**', 'A reviewer says the result is false, or found a flaw and nobody accepts the result'], ['**Retracted**', 'Withdrawn by a member']),
      p('In the list of facts, each card shows its title and statement, then small icons: its status (a clock while unchecked, a check once checked, a cross when disputed), where its proof comes from (a person, a sparkle for an AI, both), a book for a cited result, and a robot for the AI that wrote it. Point at an icon for what it means, and at the robot for the exact model. The label **conclusion**, which almost every fact has, is not shown; rarer labels, such as **counterexample**, are. A fact\'s key serves to cite it: **Cite** on the fact\'s page copies it, and typing @ in any text of the platform links a fact.'),
      warn('A new revision needs **new reviews**: endorsements of older revisions no longer count. An AI model cannot validate its own work.'),
      p('A warning also appears on a fact that relies on an unchecked, unproved, disputed or retracted fact, on a citation nobody accepted, or on a proof that still uses an outside result directly, even if the fact itself is accepted.'),
    ],
    related: ['retract', 'traceability', 'lean'],
  },
  {
    slug: 'traceability', category: 'facts', title: 'Traceability: who proved what', summary: 'Human or AI proof, sources, credit and lineage.',
    keywords: 'trace traceability origin human proof ai proof credit author source quote lineage provenance',
    blocks: [
      p('The **Trace** tab of a fact shows where it comes from.'),
      live((c) => [c.facts.human_proofs.length ? line('Facts with a human proof:', c.facts.human_proofs.map(toFact)) : line('No fact of this project has a human proof yet.'), c.facts.ai_proofs.length ? line('Facts with an AI proof:', c.facts.ai_proofs.map(toFact)) : null].filter(Boolean)),
      h('Proof origin'),
      table(['Mark', 'Meaning'], ['**Human proof**', 'The proof is in a human source'], ['**AI proof**', 'The proof was written by AI, even if the statement is human'], ['**Human + AI proof**', 'From both kinds of source'], ['**No proof**', 'No proof is recorded']),
      h('How credit is established'),
      list('**Author of a message or comment:** known by the platform.', '**Authors in the bibliography:** from the reference.', '**Named by the AI client:** marked as unconfirmed.', '**Uploader of a file:** shown as uploader, who may not be the author.'),
      p('**Built on** lists every fact in the dependency chain, so you can see which human proofs an AI result relies on. **Rests on** lists the cited results among them: what a reader must accept from other works for the fact to hold.'),
      warn('The AI client states which part of a PDF contains the statement or proof, and the platform cannot verify this. Compare a fact with its cited page before endorsing it.'),
    ],
    related: ['reviews', 'ai-labels'],
  },
  {
    slug: 'notation', category: 'facts', title: 'Project notation', summary: 'One meaning per symbol, and facts rewritten in it.',
    keywords: 'notation symbol definition definitions glossary convention clash meaning FS NS finite sums rewrite rephrase same symbol different meaning variant agree',
    blocks: [
      p('Papers often write the same symbol for different things. For Hindman\'s theorem, some write $\\mathrm{FS}(X)$ for the non-empty finite sums of $X$, and others include $0$ and write $\\mathrm{NS}(X)$ for the sums without it. The project agrees on **one meaning per symbol**, and facts are shown in that notation.'),
      live(() => [line('Open the notation of this project.', [{ label: 'Open the notation', to: { view: 'facts', query: { mode: 'notation' } } }])]),
      h('Agree on the notation'),
      steps('In [Facts](app:facts), click **Notation**.', 'Click **Ask AI to review the notation**: an AI client looks at the notation every fact defines for itself and at the sources, and proposes global entries, one meaning per symbol. You can also propose an entry yourself.', 'For each proposal, click **Agree**, **Local**, **Edit** or **Reject**. **What each choice changes** under an entry says what each button changes and what it leaves as it is, and pointing at a button says it too. A symbol has one agreed meaning at a time.'),
      p('Most of this needs nobody: the [consolidation](help:consolidation) adopts the notation itself, when the project lets it apply changes, and the facts are rewritten in it. People look over its choices, confirm or reopen them, and undo any one.'),
      p('The symbols listed under **Defined in several facts** are settled by an AI too: once the project is quiet, a sweep takes thirty of them at a time, and makes each one global, keeps it local to its paper, or records it as another spelling of an entry. It settles the entries still proposed the same way, and rejects those the agreed symbols already express. When the facts word a symbol in several ways, the sweep sorts the wordings into groups of equivalent ones, each in its own color, and settles each meaning that matters on its own: one can become project notation while another stays local to its paper. **8 wordings, all equivalent** means they define the same thing, while **2 different meanings** shows which wordings agree and which differ, with the project entry each meaning is. Wordings added since are shown apart as **Not compared yet**. A symbol that waits for a member offers three choices: **Same as this entry**, when it is another spelling of an entry (the entries naming the same term, such as full-match (HT) and full-match (FUT), are listed first); **Keep local**, when it is a notion of one paper, such as a forcing notion; and **Propose as global**. A settled symbol links to its entry, where it can be reopened or its automatic decision undone. Each symbol of the list says where it stands: compared and settled **now**, in the **next** sweep (the thirty most used), in a **later** one, or **left to the members** when two sweeps read it without settling it; then propose it yourself, or discuss it. It also says what the parameters of each agreed or local entry stand for, when nobody did. An expression in agreed symbols, such as $\\mathrm{FIN}\\cup\\{\\emptyset\\}$ once $\\mathrm{FIN}$ is agreed, needs no entry: it is marked **from project symbols**, and facts are rewritten with it. **Reject** sets an entry aside: it is not project notation, facts keep their own definition, and the AI does not propose it again. A glossary that defines two symbols at once, such as $\\lambda(n), \\mu(n)$, counts as two symbols. Click a figure at the top of the page to go to its section.'),
      h('What an entry applies to'),
      p('An entry applies to the objects its symbol is written with, its **parameters**, and to nothing else. $Y \\leq X$, for infinite block sequences $X$ and $Y$, gives a meaning to $\\leq$ between block sequences only: $\\leq$ between numbers, or for another order, keeps its own meaning, and rewrites leave it as the fact writes it. Each parameter has its color in the symbol: point at it to see its type. **Applies to** under the meaning lists them. A type nobody gave yet reads **type not stated yet**: an AI fills it in when it reviews the notation, or click **Edit** and write one line per type, such as `X, Y: infinite block sequences`. A letter written under or over a relation, the $c$ of $\\le_c$ or the $W$ of $\\le_W$, names the relation and is never a parameter. Another letter that is part of a name gets the type `not a parameter`: it then leaves the parameters, and an AI that wrote such a type, for instance "fixed subscript, not a variable", is read the same way.'),
      p('Uses in a fact are marked between objects written with the same letters, indexed or primed as a proof writes them ($Y_1 \\leq X_0$, $X\' \\leq X$), never between other letters, such as $n \\leq m$. Pointing at a mark shows the meaning, and the types.'),
      list('Click **Local** on a proposal that is too specific to be a project symbol, such as $B \\cup C$ written for a union with $\\max B < \\min C$. Rewrites then unfold it, or define it within the fact. The AI only proposes notations that several facts or sources use.', 'A term that depends on its setting gets one entry per setting, with the setting in parentheses in its name: **full-match (HT)** for Hindman\'s theorem, **full-match (FUT)** for the finite union theorem, **homogeneous (pairs)**. Each is agreed on its own. A fact that stays in one setting may write the bare term, and its notation says which entry it stands for.', 'A notion such as an IP set or a full-match makes sense in any semigroup. Its entry gives the general definition, and lists under **Other forms** how papers define it or write it, for example in $(\\mathbb{N}, +)$ or $(\\mathrm{FIN}, \\cup)$. Facts in one setting keep using it. **Other meanings** are real clashes, which rewrites remove. Each entry shows its symbol, who decided it and the buttons on one line, its meaning below, then labelled rows: **Applies to**, **How sources differ**, **Other forms**, **Other meanings** and **Defined in**, its definition first.', 'Click **Discuss** on an entry to comment on it beside the list. Every member sees the discussion, and an AI proposing or rewriting the notation reads it. Write `@AI` there to ask its opinion.', 'An entry gives the symbol in LaTeX, its meaning, how sources differ, and the other meanings found, with where they appear.', 'Editing the symbol, the meaning or the types of an agreed entry makes it a proposal again.', 'Cite an entry with `@notation:`.'),
      h('Each fact\'s own notation'),
      p('A fact reads alone. It uses the project symbols, and defines every other symbol itself, under **Notation in this fact**. Extraction, proof searches and rewrites fill this in. A local abbreviation stays there rather than becoming a project symbol.'),
      p('In the statement and the proofs, each use of a symbol the fact defines, or of an agreed project symbol, is **underlined with dots**. Point at it, tap it, or reach it with the Tab key to see its meaning, and whether it is the fact\'s own or the project\'s. A symbol the fact defines for itself takes precedence over a project symbol of the same name, and so does a **local** entry of its paper: in Kreuzer\'s facts, $(\\mu)$ is Feferman\'s functional, even though the project\'s $\\mu(n)$ is a binary exponent. A field may keep its standard symbol this way, as long as the fact or its paper defines it. Proposals are not marked until the project agrees on them.'),
      p('The Notation page lists the symbols **defined in several facts**, with each wording of their definition. Wordings often differ while the notion is the same, as for the infinite pigeonhole principle stated for all numbers of colors or for every finite coloring: the page does not judge this itself. The consolidation compares them, adopts the notion once, and records as **other meanings in sources** only the ones that really differ, which the page then shows. One notion written in several ways, such as FS(X), FS(Y) and $\\mathrm{FS}(S)$, is listed once, with its spellings. Single-letter variables of one proof, such as $x_n$, are left out. Click **Propose as global** to make one a project symbol, or let the AI review do it. Once agreed, rewrites use the global symbol instead of the local definitions.'),
      h('Definitions'),
      p('A definition is a convention, not a result. Definitions are no longer listed among the facts, have no review status, and never flag the facts that use them as unchecked. They appear on the Notation page, under **Definitions from the facts**: click **Make an entry** to give one its agreed symbol. New extractions no longer create definition facts, and propose no project notation: a definition found in a paper goes into the notation of each fact that uses it. Project symbols are decided afterwards, by a review of the whole project. When an AI proposes a symbol the project already has, even written another way, such as FS(X) and $\\mathrm{FS}(H)$, it is recorded on that entry, as a clash when its meaning differs.'),
      h('Rewrite the facts'),
      steps('Facts are rewritten automatically, by a [sweep](help:ai-work), once the project has been quiet for a while. Click **Rewrite N facts** on the Notation page to start now, or, in the **AI** menu of one fact, **Write it in the project notation**.', 'An AI client writes the facts again in the agreed notation, a dozen at a time, using what each source means by each symbol.', 'The fact shows this version, with **Project** and **As written** above the statement to switch. Beside them, a label says whether a second AI found the same meaning: point at it for what each symbol meant in its source, and for **Same meaning** and **Not the same**.'),
      list('The reviewed text never changes, so endorsements and reviews stay valid.', 'A second AI compares each rewrite with its original, in a sweep, and says whether it states exactly the same. One it finds not the same is hidden, the original is shown with what changed, and the fact is rewritten once more, avoiding that change.', 'Click **Same meaning** or **Not the same** to give your own verdict, before or after the AI\'s: yours replaces it, and no AI changes it.', 'When the agreed notation changes, facts show that their rewrite is out of date, and can be rewritten again.', 'New extractions already write statements and proofs in the agreed notation. Only their quotations keep the paper\'s own notation.'),
    ],
    related: ['facts-overview', 'reviews', 'ai-work'],
  },
  {
    slug: 'consolidation', category: 'facts', title: 'Consolidate the facts', summary: 'Duplicates across sources, missing dependencies, open questions in remarks, subject tags and the project notation.',
    keywords: 'consolidate consolidation notation normalize symbol adopt duplicate same result merge unmerge undo automatic confident confidence history dependency cross paper source link remark open question kind topic topics tag tags subject filter',
    blocks: [
      p('Extraction reads one source at a time, so it cannot see that two papers state the same theorem, or that a proof in one paper relies on a result from another. After the last waiting extraction of a project, an AI client reads the **whole facts database** and proposes changes.'),
      p('A large database, mostly written by AI, cannot all be checked by people. So the AI rates its **confidence** in each change. What it is **confident** about is **applied at once**: merges of facts that state the same result, dependencies, kinds, subject tags and cited results. **Notation** and subject tags change no result, so they are applied when it finds them **probable** too. The rest is read again by a **second AI**, which checks each proposal against the facts: it applies those it agrees with, drops the others, and leaves to people only what needs their judgment, with its reason. What remains waits for people, with **Confident**, **Probable** or **Unsure** beside it.'),
      list('Each applied change is listed under **Applied automatically**, and in the history of its facts, under **Revisions and changes** in the **Trace** tab.', 'Any change can be undone. **Unmerge** brings back a merged fact with its sources, dependencies, proof, stars, tags and question links, and the facts that relied on it rely on it again. The AI never proposes again what people undid.', 'Any member undoes what the AI applied on its own. A merge or an open question that a person accepted, an owner undoes.', 'What the second reading dropped is under **Decided**, with its reason: click **Bring back** to decide it yourself.', 'An owner can turn automatic changes off, under **Ask for a consolidation**: everything then waits for people, the second reading stops, and suggested references are no longer added on their own.'),
      live(() => [line('See what the AI proposed for this project.', [{ label: 'Open Consolidate', to: { view: 'facts', query: { mode: 'consolidate' } } }])]),
      table(['Proposal', 'What accepting does', 'Who decides'],
        ['**Same result**', 'Keeps the first fact. The other leaves the list: its sources, stars, question links and proposed answers move to the kept fact, its proof becomes [another proof](help:reviews) of it, and the facts that relied on it rely on the kept fact. Its old link opens the kept fact.', 'An owner'],
        ['**Missing dependency**', 'Records that a proof relies on another fact. The text does not change, so reviews stay valid. A dependency that would make a cycle is refused.', 'Any member'],
        ['**Open question**', 'A remark that asks something open becomes an [open question](help:open-questions), linked to its source, and leaves the facts. A remark that other facts rely on stays.', 'An owner'],
        ['**Kind**', 'Corrects the kind of a fact, for example a remark that states and proves a lemma.', 'Any member'],
        ['**Subject tags**', 'Adds free tags to the fact.', 'Any member'],
        ['**Notation**', 'Adopts a symbol as the [project notation](help:notation), keeps it local to the facts, or sets a proposed entry aside. The facts are then rewritten in the notation, beside their unchanged, reviewed text.', 'Any member'],
        ['**Worth reading**', 'Marks a fact as real progress: it appears in every member\'s reading suggestions on the [overview](help:question), until each one opens it.', 'Any member']),
      steps('In [Facts](app:facts), click **Consolidate**.', 'Read each proposal, the two facts it concerns and the reason the AI gives. Click a fact to open it.', 'Click **Accept** or **Reject**, or **Accept all** and **Reject all** for a whole group. Point at **What Accept and Reject do**, above the proposals, for what each changes and how to undo it.'),
      list('The AI never proposes again what people rejected or undid.', 'Click **Ask AI to consolidate** to run it at any time, for example after adding facts by hand.', 'Each proposal shows the model that made it and its computing time.'),
      h('Notation'),
      p('The consolidation also settles the [project notation](help:notation), so that people need not decide each symbol. When sources disagree, it chooses the most common convention, and gives another symbol to a meaning that also matters. A wrong choice is cheap: undoing it brings the notation back as it was, and the rewrites made in that notation are shown again.'),
      list('An entry it adopted shows **Adopted by the consolidation** on the Notation page. Click **Confirm** to make it the team\'s decision.', 'What a person decided, agreeing, keeping local, rejecting or accepting its proposal, the consolidation never changes.', 'After a change, the facts are rewritten in the new notation by the next sweep.'),
      h('Subject tags'),
      p('Tags are free words for the subject of a fact: an area, a method, an object. They are not a fixed list, so they fit any field. The AI reuses the tags already in the project, so that a subject keeps one name.'),
      list('On a fact, click **Add tags** or **Edit** beside the tag icon, and type the tags separated by commas. A fact has at most 8 tags.', 'Filter the list or the graph by subject under **Filters**. Click a tag to see every fact that has it.', 'The Consolidate page lists every tag in use, with its number of facts.'),
    ],
    related: ['facts-overview', 'notation', 'ai-work', 'reviews'],
  },
  {
    slug: 'lean', category: 'facts', title: 'Lean proofs', summary: 'Attach formal proofs and report whether they compile.',
    keywords: 'lean formal proof compile sorry axiom mathlib verification check',
    blocks: [
      live((c) => (c.facts.lean.length ? [line('Facts with a Lean proof:', c.facts.lean.map(toFact))] : [line('No fact of this project has a Lean proof yet.')])),
      p('AI clients and agents attach Lean proofs to facts. They appear in the **Lean** tab.'),
      h('Report a check'),
      steps('Compile the code on your computer.', 'Click **Report check** on the proof.', 'Choose **Compiles** or **Fails**, and give the Lean version.'),
      warn('**The platform does not run Lean.** "Compiling" means that someone reported it. Also check that the Lean statement says the same thing as the informal one.'),
      p('Code containing `sorry`, `admit` or `axiom` is detected, and cannot be reported as compiling.'),
    ],
    related: ['reviews', 'ai-client'],
  },
  {
    slug: 'retract', category: 'facts', title: 'Retracting or deleting a fact', summary: 'What to do when a result turns out to be wrong.',
    keywords: 'retract retraction reinstate delete wrong error false broken dependents chain',
    blocks: [
      live((c) => [c.facts.retracted.length ? line('Retracted in this project:', c.facts.retracted.map(toFact)) : line('No fact is retracted in this project.'), c.facts.broken_count ? line(`${n(c.facts.broken_count, 'fact')} rely on a disputed or retracted fact:`, c.facts.broken.map(toFact)) : null].filter(Boolean)),
      h('Retract'),
      steps('Open the fact, click the dots at the end of its bar, then **Retract**.', 'Give the reason.', 'Everything that depends on it is flagged, and its authors are notified.'),
      p('The fact stays visible, marked as retracted. Any human member can retract a fact or **Reinstate** it.'),
      h('Delete'),
      p('The person who added a fact, or an owner, can delete it if **nothing depends on it**. Otherwise, retract it.'),
    ],
    related: ['reviews', 'traceability'],
  },

  // ---------------------------------------------------------------- Working with AI
  {
    slug: 'ai-client', category: 'ai', title: 'Personal API keys', summary: 'What your AI client can read and write.',
    keywords: 'api key personal token ai client claude code connect extract facts instructions',
    blocks: [
      tip('To set up an AI client, follow the [step-by-step guide](help:ai-setup). This page explains what a key allows, and how to use it with your own tools.'),
      p('A **personal API key** lets your own AI client read what you can read, and submit facts, reviews, Lean proofs, open questions, proof strategies and proposed answers.'),
      live((c) => [line(c.me.keys ? `You have ${n(c.me.keys, 'active key')}.` : 'You have no API key yet.', [{ label: 'Open your keys', to: { path: '#/profile' } }]), line(`Project id to give your client: \`${c.project.id}\`.`)]),
      h('Set it up'),
      steps('Open [your profile](app:profile), under **Personal API keys**.', 'Name the key and click **Create key**.', '**Copy it now:** it is shown only once.', 'In the **AI client app**, open **Accounts** and paste the key. With the command line or another AI client, open **Command line or another AI client** in the same window instead.'),
      h('What your client can do'),
      table(['Can', 'Cannot'], ['Read everything you can read', 'Write messages or comments in your name'], ['Submit and revise its facts, process AI tasks', 'Change files, or add to the bibliography without validation'], ['Add questions, revise strategies and propose answers', 'Ratify an answer, or declare a question solved or a strategy successful'], ['Submit reviews and Lean proofs', 'Manage members or retract facts']),
      h('Ask it to'),
      list('**Extract** results from a paper or a discussion, with the page and an exact quote.', '**Deduce** new results, with a proof.', '**Review** a fact with a different model.', '**Import** a [Danus](help:danus) fact graph.'),
      warn('Treat a key like a password. Revoke it on your profile if it may have leaked. Before citing a private conversation, your client must ask you, because every project member sees facts.'),
    ],
    related: ['ai-labels', 'danus', 'project-agents'],
  },
  {
    slug: 'ai-work', category: 'ai', title: 'How AI works in this platform', summary: 'The queue, what AI clients do, and what stays in human hands.',
    keywords: 'ai work queue task request client decentralized extract facts opinion @ai ask references suggestions derive computation',
    blocks: [
      p('The platform **stores and displays** the research. It never runs an AI model. Each member can run an **AI client on their own computer**, with their own Claude or ChatGPT account. When a client is running, it takes the waiting work, one task at a time.'),
      live((c) => [line('See what is waiting in this project.', [{ label: 'Open AI work', to: { view: 'ai' } }])]),
      shot('ai-page.webp', 'The AI work page with a status banner, figures, the queue and the new request form', 'The AI work page.'),
      h('What the AI does'),
      table(['Work', 'How it starts', 'What you get'],
        ['**Consolidate the facts**', 'Automatically after the last waiting extraction, or on the Consolidate page', '[Proposals](help:consolidation) to merge duplicates, add dependencies, turn remarks into questions, tag subjects and settle the notation'],
        ['**Agree on notation**', 'A request on the Notation page, or on one fact', 'Proposed notation entries that a person agrees on, or a fact rewritten in the agreed notation'],
        ['**Extract facts**', 'Automatically for an uploaded file or new version. On request for a reference or a [conversation](help:conversations)', 'Facts with an exact quotation. A quotation not found in the source is refused'],
        ['**Answer a question**', 'Write `@AI` in a message or a comment', 'A reply in the same thread, labelled with its model'],
        ['**Find references**', 'A request on the AI work page or the bibliography', 'References confirmed by their DOI or arXiv record, added at once; suggestions that a person accepts for the others'],
        ['**Check the sources**', 'A sweep, once the project is quiet: up to 10 new cited results of one source at a time. On request for one', 'Whether each source states the result. Evidence only: a person accepts the citation'],
        ['**Rewrite in the project notation**', 'A sweep, once the project is quiet, or **Rewrite N facts** on the Notation page', 'Facts written again in the agreed notation, a dozen at a time, beside their unchanged text'],
        ['**Check rewrites**', 'A sweep, after the rewrites', 'Whether each rewrite states exactly what the original states. One that does not is hidden'],
        ['**Settle the notation**', 'A sweep, once the project is quiet', 'The symbols several facts define, made global, kept local or attached to an entry, thirty at a time'],
        ['**Second reading**', 'A sweep, after a consolidation', 'The proposals the consolidation was not sure of, applied or dropped, and the rest left to people'],
        ['**Repair proofs**, **Check repairs**', 'As soon as an AI review finds a flaw, round after round, on clients with them turned on (by default from 1.22.0)', 'An AI of another company repairs the proof or answers the review; one of the reviewer\'s side checks it. Up to three rounds; then people decide'],
        ['**Review proofs**', 'A sweep, once the project is quiet, on clients that turned it on', 'An independent AI review of each proof nobody checked, six at a time, in the order of **What to verify first**: what an answer to a question rests on first. Never by the model that wrote the proof, and another company\'s AI first: a client signed in to both Claude and ChatGPT reviews with the one that did not write the proof. A proof only its author\'s company checked goes to the other company\'s AI when one is around. A proof one model could not check goes to another, then to people. Two models give two reviews'],
        ['**Prove new facts**', 'A member starts a [proof search](help:danus) from their client', 'New facts, marked unchecked']),
      p('These actions are also available where they are useful: on a reference, a file, a conversation, a fact or a question. They all join the same queue.'),
      h('Your AI requests'),
      p('Each member may make **40 AI requests in any 24 hours**, so that nobody uses up the AI subscriptions of the team by accident. **Your AI requests**, in the request form of the AI work page, shows how many you made, as a bar that turns amber near the limit and red at it, and when the oldest one frees up: each request counts for 24 hours. Pointing at an AI button anywhere shows the same count. At the limit the buttons are greyed out until a request frees up. Only what you ask for counts: the upkeep the platform queues on its own, sweeps and the extraction of uploaded files, counts for nobody.'),
      h('In what order'),
      p('AI clients do first what someone is waiting for, and heavy background work last: a question to `@AI`, then reviews, source checks and reference searches, then consolidation and notation, proof searches, rewrites in the project notation, and the extraction of files last. Your own request goes before the same work queued automatically. Some tasks wait for others: a consolidation waits for the extractions that are adding facts, and rewrites in the project notation wait for the consolidation that may change it.'),
      h('Upkeep: sweeps'),
      p('Work that nobody waits for is not one task per fact. Checking the sources of cited results, rewriting facts in the project notation, checking those rewrites, reading uncertain proposals again, reviewing proofs and consolidating are done by **sweeps**: one task for each kind, queued once the project has been quiet for 30 minutes (no new facts, no extraction running), at most every hour, or every day for the consolidation when something changed. A sweep takes what is left when an AI client starts it, a batch at a time, and the next one carries on at once while work is left, so a change of notation is caught up within the hour. So a large extraction makes one sweep, not one task per fact.'),
      p('AI clients run the checks of rewrites and the second reading from version 1.20.0. An older client runs them only once its user turns them on, on the **Work** page of the client. **Review proofs** is new: each member turns it on there, since it uses a strong model for every proof nobody reviewed.'),
      p('So the queue shows one line per kind of work, with a bar of how many are done, running and waiting, and **after other work** when everything of that kind waits for something else. Click a line to see its tasks, in the order they will run. The activity on the overview groups the same way: an extraction that adds 40 facts makes one line.'),
      h('AI clients and computing time'),
      p('The **AI clients** panel of the AI work page lists the clients that are running now or have worked on this project.'),
      list('A green dot means the client is online and waiting for work. A blue dot means it is working, with the task and how long it has run.', 'Each client shows its owner, model and version. **Update available** means a newer client exists.', 'The figures show the computing time of this project over 7 days, 30 days or all time, split between **standard tasks** (extraction, questions, references, reviews and Lean) and **proving new facts** (proof searches), with the number of new facts they produced. They also show each client and each kind of work.', 'Time is measured by each client. It counts finished tasks and tasks that failed for good, when the client measured them. Proof searches report their time even when they stop without a result, from client 1.9.1.', 'On the overview, **AI on** marks the members whose client is running, and **AI computing** gives the total time of the project. The list of projects shows it for each project.'),
      h('Choose the models'),
      p('Each member chooses the model for each kind of work in their client, on the **Work** page, because the work uses their own subscription. **Automatic** uses Sonnet for extraction, questions and references, and Opus for automatic proving. Those names follow new Claude releases. With ChatGPT, Automatic uses the model set in Codex. The model that really ran is recorded on each result.'),
      h('Avoid repeating work'),
      p('A client does not repeat an extraction of the same PDF or file version if a model **at least as strong** already finished it. Opus 5.5 covers Sonnet 5.5, and Sonnet 5.5 covers Haiku 5.5. Models that cannot be compared, such as Claude and GPT, or Opus 4 and Sonnet 5, may each run it. An **Extract again** request then waits for a suitable model.'),
      h('Comments and fact extraction'),
      list('Extraction reads the **comments** on a file or a reference, including the passage and page they point to.', 'A comment never becomes the result: statements, proofs and quotations come only from the text.', 'A comment about a result appears among the sources of its fact, marked as **supporting**, **disputing** or **clarifying** it. This does not change the status of the fact.', 'When people add, edit, resolve or remove a comment, the reference shows **new comments**, and extraction can run again.'),
      h('Check a fact'),
      list('**Independent review**, in the **AI** menu of a fact, asks a model independent of the author to referee the proof. It cannot be the same model or one known to be weaker. A client with both Claude and ChatGPT can review the work of either.', '**Lean proof**, in the same menu, asks a client with Lean installed to formalize the fact. The proof is recorded only if Lean compiles it with no `sorry` and only the standard axioms, and a different AI model judges that the Lean statement matches the fact. If Lean proves the **negation**, the fact receives an incorrect review instead.'),
      warn('A compiled Lean proof proves **the Lean statement**. The comparison with the fact is an AI judgment, so a person should still confirm it. An AI review is useful evidence, not a proof.'),
      h('Ask the AI in a discussion'),
      steps('In a conversation, write your question and click **Ask AI**. With an empty draft, it asks for the AI’s opinion on the discussion.', 'Anywhere else, type `@` in a message or a comment, then choose **Ask AI** or keep typing `@AI`.', 'The next AI client of someone who can read the discussion answers in the same thread, and you are notified.'),
      p('In a conversation, a line above the reply box shows whether the AI is waiting for a client, working, or could not answer. The AI reads up to the 100 latest messages before your question, and its answer is labelled with its model.'),
      p('It also reads the beginning of each fact\'s statement. Cite a fact in your question with `@fact:` and it reads that fact\'s whole statement and proof, up to 10 facts.'),
      h('Validate suggested references'),
      p('A suggestion must give a DOI, an arXiv id or an address. When its DOI record at Crossref, or its arXiv record, has the same title and first author, the reference is real: it is added to the [bibliography](help:bibliography) at once, and listed under **Added automatically**, where **Take back** removes it again if nobody used it. Only the identifier is sent to Crossref or arXiv.'),
      p('The others wait for you. **Open the link to check it**, because an AI can invent a reference. **Accept** adds it to the bibliography with its AI origin. **Reject** removes it from the list.'),
      shot('ai-suggestions.webp', 'Suggested references with their reason, source link, and Accept and Reject buttons', 'Suggested references wait for a person.'),
      h('Privacy'),
      list('A task from a **private conversation** goes only to the AI clients of its participants.', 'A client sends the content of its tasks to **the AI provider of the member who runs it**. Each file uploaded to the project can therefore be read by the provider of any member running a client.', 'To limit what your client handles, use for example `--only ask,bib`.'),
      warn('Do not upload a document to a project if it must not reach the AI services used by its members.'),
      h('Safety'),
      p('The AI runs in a read-only mode and does not receive your key. It returns a structured answer, which the client checks and submits. AI content stays labelled, and only people [endorse facts](help:reviews) and [ratify answers](help:answers).'),
    ],
    related: ['ai-setup', 'ai-client', 'danus'],
  },
  {
    slug: 'ai-setup', category: 'ai', title: 'Install an AI client', summary: 'Choose your guide: Claude or ChatGPT. No experience needed.',
    keywords: 'install setup tutorial step by step beginner terminal claude chatgpt codex openai anthropic client commands',
    blocks: [
      tip('Start from the [AI client page](app:client). It detects your system and shows the easiest way to install.'),
      p('You need **about 15 minutes** and one AI subscription. You do not need to know how to program: each step gives a command to copy.'),
      h('Choose your guide'),
      table(['If you use', 'Follow'], ['**Claude**', '[Install with Claude](help:ai-setup-claude)'], ['**ChatGPT**', '[Install with ChatGPT](help:ai-setup-chatgpt)']),
      p('You control how much of your subscription it uses: see [the app and usage limits](help:ai-app).'),
      h('What is a terminal?'),
      p('A terminal is a window where you type commands. Copy a command from the guide with its **Copy** button, paste it in the terminal, and press **Enter**.'),
      list('**Mac:** press ⌘ Space, type `Terminal`, press Enter.', '**Windows:** open the Start menu, type `PowerShell`, press Enter.', '**Linux:** open the Terminal application.'),
      tip('Your computer must stay on, with the client running, for it to work. Any member can run one: the team needs only one at a time.'),
    ],
    related: ['ai-setup-claude', 'ai-setup-chatgpt', 'ai-work'],
  },
  {
    slug: 'ai-app', category: 'ai', title: 'The AI client app and your usage limits', summary: 'Start, stop and limit what the client uses of your subscription.',
    keywords: 'windows exe smartscreen protected linux appimage fuse libfuse2 ubuntu debian fedora projects active paused pause resume contribute contribution switch backup backups automatic weekly retention keep copies update updates upgrade new version latest app desktop graphic interface limit limits usage quota subscription budget percent pause hours tokens stop command line billing cost price pay api key credits extra',
    blocks: [
      p('The AI client has a **graphic interface** and a **command line**. Both use the same engine and the same limits.'),
      h('Install the Mac app'),
      steps('Open the [AI client page](app:client). When the Mac app is published, a **Download** button appears there. Until then, the page gives one command that opens the same interface.', 'Open it and drag **Open Questions AI** to **Applications**.', 'Open the app. If macOS blocks it, open **System Settings**, then **Privacy & Security**, and click **Open Anyway**. This appears because the app is not yet signed with an Apple developer certificate.', 'On the **Accounts** page, install or sign in to your AI, then paste your [personal key](help:ai-client).', 'On **Home**, click **Start**. Closing the window keeps it working from the menu bar. Choose **Quit** there to stop it.'),
      h('Install the Windows app'),
      steps('On the [AI client page](app:client), download **open-questions-ai-windows.exe**, for 64-bit Windows 10 or 11 on Intel or AMD computers.', 'Open it. The app installs for your account, without administrator rights, and adds a shortcut.', 'If Windows shows **Windows protected your PC**, click **More info**, then **Run anyway**. This appears because the app is not signed with a paid certificate.'),
      h('Install the Linux app'),
      steps('On the [AI client page](app:client), download **open-questions-ai-linux.AppImage**. It runs on most distributions from 2020 on, on Intel and AMD computers (x86-64).', 'Make it executable: right-click it, **Properties**, **Allow executing as a program**, or run `chmod +x open-questions-ai-linux.AppImage`.', 'Double-click it, or run `./open-questions-ai-linux.AppImage`.'),
      list('If it does not start and mentions FUSE, install `libfuse2` (Ubuntu 22.04 and later: `sudo apt install libfuse2`), or start it with `./open-questions-ai-linux.AppImage --appimage-extract-and-run`.', 'On ARM computers, use the one-command version below.'),
      p('The installable app includes everything it needs. The one-command version needs Python 3.8 or later, on Mac, Windows or Linux.'),
      shot('app-home.webp', 'The Home page of the client, with its status, usage meters, projects and activity', 'Home: is it working, and how much has it used?'),
      h('Choose your active projects'),
      p('The **Home** page lists your projects, each with an **Active** or **Paused** switch. Your computer only takes work from active projects, and a new project starts active.'),
      list('A task already running finishes. A proof search on a paused project ends, or waits if you chose to continue after a reset.', 'Pausing affects only this computer. The requests stay in the queue, and other members\' clients can process them.', 'Your usage limits are the same for all projects and are shared between the active ones.'),
      p('From the command line: `python3 oq.py projects` shows the list, `python3 oq.py projects pause 12` pauses a project, and `python3 oq.py projects resume 12` makes it active again.'),
      h('Choose the work and the models'),
      p('The **Work** page lists every kind of work, grouped by purpose. Each one has a switch, to let this computer take it on or not, and its model. **Automatic** shows the model it uses today, and follows new releases. Changes are saved together, with **Save** at the bottom.'),
      shot('app-work.webp', 'The Work page, with a switch and a model for each kind of work', 'Work: what this computer does, and with which model.'),
      list('With both Claude and ChatGPT signed in, **Models for** switches between the models of each. Work runs on the AI in use; the other one reviews independently what the first wrote.', '**Other model…** at the bottom of a menu takes an exact model name.', 'Lean proofs need Lean: **Install Lean** is under Checking.'),
      h('Keep your subscription for yourself'),
      p('Before each task, the client checks your limits. If one is reached, it waits and resumes later. Your AI account is not used while it waits.'),
      shot('app-limits.webp', 'The Limits page, with levels, the share of the subscription, daily limits and working hours', 'Limits.'),
      p('Choose a **level**, or set your own values under **Custom**. Working hours are set with **From** and **Until**, overnight included.'),
      table(['Limit', 'Light', 'Balanced (default)', 'Generous', 'Works with'],
        ['Share of the session limit', '30%', '50%', '80%', 'ChatGPT'], ['Share of the weekly limit', '30%', '50%', '80%', 'ChatGPT'],
        ['Tasks per day', '10', '20', 'No cap', 'Both'], ['Computing minutes per day', '60', '120', '480', 'Both'],
        ['Longest task', '20 min', '30 min', '60 min', 'Both'], ['Tokens per day (Advanced)', '1,000,000', '2,000,000', 'No cap', 'Both']),
      warn('**ChatGPT** reports the real share of your subscription. **Claude** does not report it to unattended tools, so the client applies its daily caps and stops when Claude says a limit is reached. These caps count only what this client used, not your other use of Claude.'),
      p('A task already running can go slightly past a limit, because limits are checked between tasks. A [proof search](help:danus) runs only when you start it, with its own stops, checked every 30 seconds.'),
      h('New kinds of work from the platform'),
      p('Much of the AI work is only reasoning: answering @AI, reviewing the notation, consolidating the facts. The platform defines these **procedures** itself, with their instructions and the form of their answer, so a new one reaches your client **without an update**. The client runs it with the model you choose, and sends the answer back. The platform checks the answer and records it.'),
      list('A new procedure is **off** until you turn it on, under **Added by the platform** on the **Work** page, or run `python3 oq.py procedures --on ID`. The ones your client already knew of when it was released, such as checking the source of a cited result, are on until you turn them off. Turn on **Turn on new kinds of work automatically** to accept them in advance.', 'Choose its model on the same row, or with `python3 oq.py models --set ID=opus`. By default a demanding procedure uses a strong model, and a simple one a fast model.', 'A procedure gets only the task\'s data. The model has no shell and no access to your files. Web search is allowed only when the procedure needs it, and its description says so.', 'A procedure that needs something your client cannot do yet is shown as **Needs a newer client**, and never runs.', 'Your limits, working hours and paused projects apply to every procedure.'),
      h('Who pays'),
      p('By default the client uses **your subscription only**. It ignores API keys found on your computer, and stops with an explanation if your AI tool is set to use a paid key. To use a paid API key on purpose, choose it on the **Accounts** page, or run `python3 oq.py limits --billing api`.'),
      warn('The client cannot see whether **usage credits** are on in your Claude account. Keep them off, or set a monthly cap, to be sure nothing is charged past your plan limit.'),
      h('Optional automatic backups'),
      p('The **Backups** page of the client can save a dated copy of each of your projects on your computer. **It is off until you turn it on.** It then runs **every week and keeps the last 4 copies** of each project, unless you change this.'),
      steps('Open the client and click **Backups**.', 'Tick **Back up automatically**.', 'Choose the frequency, how many copies to keep and, if you wish, a folder.', 'Click **Save**. To make a first copy at once, click **Back up now**.'),
      list('Each copy is verified before it is kept. Older copies are removed only after that, so a failed backup never costs you an earlier one.', 'Automatic backups run while the client is open. If your computer was off, the client catches up when you open it again.', 'From the command line: `python3 oq.py backup --on` turns them on, `--off` turns them off, `python3 oq.py backup` makes one copy now, and `--list` shows them.'),
      warn('A copy contains what you can see in the project, so keep its folder private. It is a [readable copy](help:download-project) for you. It cannot restore the whole platform, which remains the [administrator\'s backup](help:backups).'),
      h('Keep it up to date'),
      p('The client looks for the latest release on [GitHub](https://github.com/LudovicPatey/projects/releases), and on your platform, when it starts and every few hours. Its menu shows your version, and **Check for updates** checks at once. A release that needs a newer platform is not offered.'),
      list('**Command-line version:** click **Update now**, or run `python3 oq.py update`. The file is verified with a checksum before it replaces the old one, and the client restarts.', '**Installed app:** when a new app is released, a **Download** button appears. Install it over the old one.'),
      p('An update never starts while work is running, and your settings and limits are kept.'),
      warn('When the platform changes in a way that an old client cannot follow, it refuses that client. The client then stops and shows **Update required**. Nothing is lost: the waiting work stays in the queue until an up-to-date client takes it.'),
      h('From the command line'),
      cmd('python3 oq.py update --check', 'Check for a new version'),
      cmd('python3 oq.py app', 'Open the graphic interface'),
      cmd('python3 oq.py limits --max-session-percent 30 --max-weekly-percent 40 --hours 22-7', 'Change the limits'),
      cmd('python3 oq.py limits --pause', 'Pause'),
      cmd('python3 oq.py limits --resume', 'Resume'),
      cmd('python3 oq.py procedures', 'List the platform\'s procedures, and whether each one runs here'),
      cmd('python3 oq.py procedures --on consolidate --auto off', 'Turn one on, and keep new ones off'),
    ],
    related: ['ai-setup', 'ai-work', 'danus'],
  },
  {
    slug: 'ai-setup-claude', category: 'ai', title: 'Install with Claude', summary: 'Step-by-step tutorial for Claude Code, with screenshots.',
    keywords: 'claude code anthropic install tutorial step by step setup terminal login oq.py',
    blocks: [
      p('This guide installs **Claude Code**, the command-line version of Claude, then connects it to this platform.'),
      h('Step 1: Check your Claude plan'),
      p('Claude Code needs a paid plan such as Pro, Max, Team or Enterprise, or a Console account. The free plan of claude.ai does not include it.'),
      p('With a plan, the client uses **your plan limits, at no extra cost**. The Anthropic API is a separate paid product, and you do not need it.'),
      warn('Keep **usage credits** off in your Claude settings, or set a monthly cap. If they are on, work past your plan limit can be charged. Anthropic intends plans for ordinary individual use, so keep the limits of the client moderate and check its current terms.'),
      h('Step 2: Install Claude Code'),
      tip('Using the **Open Questions AI app** with **Claude for Mac** already installed? The app finds the Claude Code included in it, so you can skip this step. The commands below still need a separate installation in the Terminal.'),
      p('Open a [terminal](help:ai-setup), copy the command for your system, and press **Enter**:'),
      cmd('curl -fsSL https://claude.ai/install.sh | bash', 'macOS and Linux'),
      cmd('irm https://claude.ai/install.ps1 | iex', 'Windows (PowerShell)'),
      p('**Close the terminal and open a new one**, then check the installation:'),
      cmd('claude --version'),
      h('Step 3: Sign in to Claude'),
      cmd('claude'),
      steps('Your browser opens. Sign in with your Claude account and approve.', 'Back in the terminal, answer the first questions.', 'Type `/exit` and press **Enter**.'),
      p('To read long PDFs, also install **Poppler**: `brew install poppler` on a Mac, or `sudo apt install poppler-utils` on Debian and Ubuntu.'),
      ...clientSteps('claude'),
    ],
    related: ['ai-work', 'ai-setup-chatgpt', 'danus'],
  },
  {
    slug: 'ai-setup-chatgpt', category: 'ai', title: 'Install with ChatGPT', summary: 'Step-by-step tutorial for Codex, with screenshots.',
    keywords: 'chatgpt codex openai gpt install tutorial step by step setup terminal login pdftotext oq.py',
    blocks: [
      p('This guide installs **Codex**, the command-line tool of ChatGPT, then connects it to this platform.'),
      h('Step 1: Check your ChatGPT plan'),
      p('You need a ChatGPT account whose plan includes Codex. Check the current plans on the OpenAI website.'),
      h('Step 2: Install Codex'),
      p('Open a [terminal](help:ai-setup), copy the command for your system, and press **Enter**:'),
      cmd('curl -fsSL https://chatgpt.com/codex/install.sh | sh', 'macOS and Linux'),
      p('On **Windows**, first install the LTS version of [Node.js](https://nodejs.org/), open a new PowerShell, then run:'),
      cmd('npm install -g @openai/codex', 'Windows (PowerShell)'),
      p('**Close the terminal and open a new one**, then check the installation:'),
      cmd('codex --version'),
      p('The client needs **pdftotext** to read PDFs with Codex:'),
      cmd('brew install poppler', 'macOS (with Homebrew)'),
      cmd('sudo apt install poppler-utils', 'Debian and Ubuntu'),
      p('On Windows, download the command line tools from [xpdfreader.com](https://www.xpdfreader.com/download.html) and add their folder to your PATH.'),
      h('Step 3: Sign in to ChatGPT'),
      cmd('codex'),
      steps('Choose **Sign in with ChatGPT**.', 'Your browser opens. Sign in and approve.', 'Back in the terminal, press **Ctrl+C** twice to leave.'),
      ...clientSteps('codex'),
    ],
    related: ['ai-work', 'ai-setup-claude', 'danus'],
  },
  {
    slug: 'project-agents', category: 'ai', title: 'Project agents', summary: 'AI members that take part in discussions.',
    keywords: 'agent bot ai member token prover automated conversation mention',
    blocks: [
      p('A **project agent** is an AI member of one project. Unlike a personal key, it can join conversations, comment and upload AI files.'),
      live((c) => (c.people.agents.length ? [line('Agents of this project:', c.people.agents.map((a) => ({ label: `${a.title} (${a.model || 'no model'})`, to: { view: 'members', query: { user: a.id } } })))] : [line('This project has no agent yet.' + (isOwner(c) ? ' You can create one under [People](app:members).' : ' An owner can create one.'))])),
      h('Create an agent (owners)'),
      steps('Open [People](app:members), under **AI agents**.', 'Enter a **name** and its **AI model**, which is required.', 'Click **Create agent**, and **copy the token**: it is shown only once.', 'Run your agent with this token. An example built on Claude is in the [repository](https://github.com/LudovicPatey/projects/blob/master/examples/claude_agent.py).'),
      h('Talk to it'),
      p('Add it to a conversation, or [@mention](help:writing) it. It answers only while its program is running.'),
      p('An agent cannot modify human-written files, manage members or retract facts. **New token** revokes the old one at once.'),
    ],
    related: ['ai-client', 'ai-labels'],
  },
  {
    slug: 'ai-labels', category: 'ai', title: 'How AI content is labelled', summary: 'Model, responsible user and generation time.',
    keywords: 'ai label model generation time responsible user provenance transparency badge',
    blocks: [
      p('Everything written by AI displays a violet label such as `claude-opus-5-5 · for Claire · 12.4 s`.'),
      table(['Part', 'Meaning'], ['**Model**', 'The model that produced it. Always required'], ['**for…**', 'The person it worked for: the owner of the key, or the owner who issued the agent’s token'], ['**Time**', 'The generation time, shown only when it was actually measured']),
      p('This information is stored with each item, so it stays correct if an agent later changes model.'),
      warn('An AI label says who produced the content, not that it is correct. See [reviewing facts](help:reviews).'),
    ],
    related: ['traceability', 'ai-client'],
  },
  {
    slug: 'danus', category: 'ai', title: 'Prove new facts', summary: 'Let a team of AI agents search for proofs, powered by Danus.',
    keywords: 'merge database continue earlier run build on established claims verifier strategies claude engine chatgpt experimental native mac macos directly sandbox isolated machine virtual disk space prove proof proving search new facts agents danus run launch start stop button duration time limit session weekly reset resume continue import sync synchronize wrapper watch serve fact graph predecessors batch derive',
    blocks: [
      live((c) => (c.facts.danus.length ? [line('Facts imported from Danus in this project:', c.facts.danus.map(toFact))] : [line('No fact has been imported from Danus in this project.')])),
      p('**Prove new facts** lets a team of AI agents search for new proofs on your computer. It is powered by [Danus](https://github.com/frenzymath/Danus), an open-source multi-agent system that builds a graph of AI-verified mathematical facts. You do not need to know or configure Danus: the client handles it.'),
      p('A proof search receives the project\'s [agreed notation](help:notation), and a fact to start from in that notation, so that its new facts use the same meaning for each symbol. `oq.py danus pull` also writes facts in the project notation, with the notation in `NOTATION.md`.'),
      h('It builds on the project'),
      p('A proof search does not start from scratch. **Before every start, and every resume, the client merges the project\'s facts** into it, so that it builds on what the team, its papers and earlier searches already have, and adds only what changed since the last merge.'),
      table(['On the platform', 'In the proof search'],
        ['Established: checked by a person or an independent AI, or a citation a member accepted, and the same for everything it relies on', 'A fact the agents build on and cite, without proving it again'],
        ['Not checked yet', 'A claim with its proof, which the agents may send to their verifier before using it. The verifier\'s verdict comes back as a review of that fact.'],
        ['Disputed or retracted', 'Left out. If it had been merged, it is withdrawn, with what was built on it.'],
        ['Strategies of the question', 'Directions to explore, and dead ends for those abandoned']),
      list('All searches on one question continue the same work, and so do searches without a question in one project.', 'Facts that came from the project are never sent back as new ones. A new fact that relies on one relies on the project\'s fact.', 'On a question, the search keeps one strategy, **Proof search with Danus**, revised with its own summary of the state of the search and its next steps.'),
      h('Set it up once'),
      steps('Open the [AI client](help:ai-app), then the **Prove new facts** page.', 'On a Mac, choose the **AI engine**: ChatGPT or Claude.', 'With ChatGPT, choose where it runs. Then click **Set up proving**, and the client installs Danus there.', 'With ChatGPT, sign in when the page shows a code. Claude uses the sign-in already on your Mac.'),
      h('Choose the AI engine'),
      table(['', 'ChatGPT', 'Claude (experimental)'], ['Account', 'ChatGPT plan with Codex', 'Claude plan'], ['Available on', 'Mac, Windows, Linux', 'Mac'], ['Runs', 'Isolated machine or directly on the Mac', 'Directly on the Mac'], ['Commands', 'Inside the Codex sandbox', 'None: the agents have no shell'], ['Files it can read', 'Depends on where it runs', 'Its folder, its project and the Danus instructions'], ['Usage stops', 'Session and weekly percentages', 'Time limit (required), daily caps, and limits reported by Claude']),
      warn('With **Claude**, the agents can search the web, and what they read is sent to Claude. Claude does not report how much of your plan remains, so set a time limit you are comfortable with.'),
      table(['', 'Isolated machine (default)', 'Directly on this Mac'], ['Disk space', 'About 8 GB', 'About 1 GB'], ['Read your files', 'No', '**Yes**'], ['Write outside its folder', 'No', 'Temporary folders only'], ['Direct network access', 'Yes, inside the machine', 'No'], ['Available on', 'Mac, Windows, Linux', 'Mac']),
      warn('**Directly on this Mac**, the agents can read the files of your macOS account, and what they read can be sent to ChatGPT as part of their work. Choose it only if you trust the problems and sources you give them.'),
      p('You can switch on the **Prove new facts** page. Each place has its own installation and ChatGPT sign-in, and an existing Danus on your Mac is left untouched. If you no longer need the isolated machine, **Remove it** frees its disk space.'),
      cmd('python3 oq.py danus setup --native --accept-risk', 'Run directly on this Mac, from the command line'),
      h('Start a proof search'),
      p('This is the heaviest use of your subscription, so **it starts only when you press Start proving**. A **Prove new facts** request on the platform waits until a member chooses it as the goal of a search.'),
      steps('Choose the **project**, then a **goal**: the whole project, a question, or a waiting request.', 'Choose how many **agents** work in parallel.', 'Set when to **stop**: a running time, a share of your session limit, and a share of your weekly limit. The first one reached stops the run.', 'Choose what happens at a usage limit: **end the run**, or **wait and continue after the reset**.', 'Press **Start proving**. Facts appear in the project as they are found.'),
      shot('app-danus.webp', 'The proof search form, with project, goal, agents, running time, session and weekly stops, and what to do at a limit', 'Set up a run.'),
      table(['Stop', 'What it means'], ['Running time', 'Time the agents actually work. Time spent waiting for a reset does not count. With ChatGPT, `0` means no time limit.'], ['Session usage', 'With ChatGPT, stops at this percentage of your session limit.'], ['Weekly usage', 'With ChatGPT, stops at this percentage of your weekly limit.']),
      p('Your [general limits](help:ai-app) always apply: a run cannot go above them. Usage is checked every 30 seconds, so a run can pass a limit slightly, especially with many agents.'),
      shot('app-danus-run.webp', 'A running proof search with its running time, session and weekly usage against their stops, new facts and a Stop button', 'Follow a run, and stop it at any time. Facts found so far are kept.'),
      warn('With **no time limit** and **continue after the reset**, the search uses your subscription up to your stop level in every period, until you stop it.'),
      p('If the client or computer stops, the search halts by itself within a few minutes. A search set to continue picks up when you reopen the app.'),
      cmd('python3 oq.py danus run --project 1 --minutes 120 --stop-session 40 --stop-weekly 50 --on-limit resume', 'From the command line'),
      cmd('python3 oq.py danus stop', 'Stop it from another terminal'),
      cmd('python3 oq.py danus setup --engine claude --accept-risk', 'Prove with Claude on this Mac, from the command line'),
      p('On a server, `python3 oq.py danus setup` does the same. `python3 oq.py danus remove` deletes the prover and its machine.'),
      h('If you already run Danus yourself'),
      p('After [installing the client](help:ai-setup), run these commands from its folder. Replace `PATH` with the `fact_graph` folder of your Danus project, and `MODEL` with the model used by Danus.'),
      live((c) => [line(`This project has the id \`${c.project.id}\`.`)]),
      table(['Command', 'What it does'],
        ['`python3 oq.py danus push PATH --project ID --model MODEL`', 'Sends new facts. Add `--dry-run` to check first. Facts already sent are skipped.'],
        ['`python3 oq.py danus watch PATH --project ID --model MODEL`', 'Sends new facts as Danus produces them.'],
        ['`python3 oq.py danus pull PATH --project ID`', 'Copies the facts of the platform into a separate `platform_facts` folder. Your Danus graph is not modified.'],
        ['`python3 oq.py danus serve PATH --project ID --model MODEL --command "..."`', 'Takes **Prove new facts** requests, runs your Danus command, then sends the new facts. In the command, `{task}` is the request file and `{graph}` the graph folder.']),
      warn('Danus runs its agents with full access to the computer, and its authors recommend an isolated, disposable machine. A request can contain text from other members, so run `serve` only on such a machine.'),
      warn('Imported facts arrive as **unchecked**. The Danus verifier is itself an AI that reads the proof in natural language. It **does not produce or check a Lean proof**, and the platform cannot confirm that it ran.'),
    ],
    related: ['ai-client', 'fact-labels', 'native-prover'],
  },
  {
    slug: 'native-prover', category: 'ai', title: 'The native prover (experimental)', summary: 'A proof search on the project\'s own facts, shared by every member\'s client.',
    keywords: 'native prover campaign round lead worker lane verifier verify cite literature notes dead end comparison danus experimental mcp tools',
    blocks: [
      p('The native prover searches for proofs like [Danus](help:danus), whose instructions it adapts, but it works directly on the project\'s facts: there is nothing to copy or translate. It runs beside Danus while the two are compared.'),
      table(['', 'What it is'],
        ['**Campaign**', 'A proof search on a question, or on the whole project. Every member\'s client can join it, within its own limits.'],
        ['**Lead**', 'A round every 30 minutes: one client sums up the state of the search, gives guidance and splits the work into **lanes**. The summary becomes a revision of the strategy **Proof search with the native prover** on the question.'],
        ['**Worker**', 'A round: a session of at most 30 minutes on one lane. The AI searches the facts and the notes, shares notes, and submits results.'],
        ['**Verifier**', 'A fresh session that sees only the statement, the proof and the facts it cites. Accepted, the result becomes a fact, with the verifier\'s review. Rejected, its repair hints are shared as a note.']),
      list('A proof may build only on facts that are established or that the verifier accepted, and on cited results, with everything they rely on. An unchecked proved fact must be verified first.', 'A result of the literature becomes a [cited result](help:reviews), checked against its source at once. The prover may use any cited result unless people dispute it or its source states something else: people check the citations that matter, not all of them. When a result worth reading relies on cited results nobody accepted, the overview lists them, so that you check those sources.', 'The verifier is the other AI when your computer has both Claude and ChatGPT: its acceptance then counts as an independent check.', 'The sessions have no shell: they read, search the web, and use the prover\'s tools. Your platform key stays in the client.'),
      h('Run it'),
      cmd('python3 oq.py prove run --project ID --question ID --workers 2 --minutes 120', 'Join or start a campaign'),
      cmd('python3 oq.py prove stop', 'Stop after the rounds in progress'),
      h('A continuous lead'),
      p('By default the lead answers once every 30 minutes. In a **continuous** campaign, a lead session runs all the time, like the lead agent of Danus: it watches the notes and facts as they arrive, revises the guidance and the lanes within minutes, searches the literature, and hands over to the next session every hour. When a session has nothing left to do, it stops, and the client wakes a new one as soon as a worker reports something, or after 15 minutes: waiting costs nothing. Workers reread their lane after each submission and every 20 minutes. It is closer to Danus, and heavier on the subscription of the member who runs it.'),
      cmd('python3 oq.py prove run --project ID --question ID --workers 3 --lead-mode continuous --lead', 'Start a continuous campaign; this computer runs the lead session with one of its workers'),
      list('Only a computer started with `--lead` runs the lead session. Without one, a lead still answers every 30 minutes.', '`--lead-minutes` sets the length of a session; the next one continues from its handover.'),
      cmd('python3 oq.py prove status --project ID', 'The campaigns of a project, with their rounds, facts and summary'),
      cmd('python3 oq.py prove stats --project ID', 'Danus and the native prover side by side: computing time, facts, facts per hour, and what became of them'),
      warn('It is experimental and starts only from the command line. Like Danus, it is the heaviest use of your subscription: your [usage limits](help:ai-client) apply between rounds, and each round has its own time limit.'),
    ],
    related: ['danus', 'ai-client', 'reviews'],
  },

  {
    slug: 'license', category: 'admin', title: 'Source code and license', summary: 'The platform and its client are free software under the AGPL-3.0.',
    keywords: 'license licence agpl open source free software code github copyright modify contribute',
    blocks: [
      p('Open Questions and its AI client are **free software**, under the [GNU AGPL-3.0](https://github.com/LudovicPatey/projects/blob/master/LICENSE). The [source code](https://github.com/LudovicPatey/projects) is on GitHub.'),
      list('You may use, study, modify and share it.', 'If you distribute it, you must keep the license and provide the source code.', 'If you run a **modified version** as a service, you must offer its users the source of that version.'),
      p('The research in a project is not covered by this license. It belongs to its authors and stays private to the project.'),
    ],
    related: ['download-project', 'ai-app'],
  },

  // ---------------------------------------------------------------- Staying up to date
  {
    slug: 'search', category: 'find', title: 'Searching', summary: 'Find facts, messages, files, people and help.',
    keywords: 'search find look query shortcut command k filter results',
    blocks: [
      p('The search bar at the top finds **facts** (including proofs, labels, reviews and Lean code), **conversations**, **comments**, **files**, **references**, **people**, **projects** and **help articles**.'),
      steps('Press **⌘K**, **Ctrl K** or `/`, or click the bar.', 'Type a few words. All of them must match.', 'Use `↑` `↓` and `Enter`, or click a result.'),
      list('Choose **This project** or **All projects**.', 'Accents are ignored: `erdos` finds Erdős.', '**Show all** lists every result of a kind.'),
      p('Search returns only what you can see, and never other people’s private conversations.'),
      warn('The text **inside PDFs** is not searched, only titles, descriptions and file names.'),
    ],
    related: ['navigate', 'privacy'],
  },
  {
    slug: 'unread', category: 'find', title: 'Unread items and badges', summary: 'What the red numbers mean.',
    keywords: 'unread badge new red number read mark highlight dot',
    blocks: [
      live((c) => { const u = c.unread; const parts = [['conversation', 'new in Mail', 'conversations'], ['fact', 'in Facts', 'facts'], ['document', 'in Files', 'files'], ['bib', 'in Biblio', 'bib'], ['member', 'in People', 'members']].filter(([k]) => u[k]); return parts.length ? [line('New for you right now:', parts.map(([k, label, view]) => ({ label: `${u[k]} ${label}`, to: { view } })))] : [line('You have read everything in this project.')]; }),
      p('Each person has their own read state. Red badges count what you have not read, on the left menu, in lists, on graph nodes and on project cards.'),
      list('An item counts as read after it stays open for about a second.', '**Read all** clears a whole list.', 'The envelope icon on an item **marks it as unread**.', 'What your own AI client wrote stays unread for you until you open it.'),
    ],
    related: ['notifications', 'navigate'],
  },
  {
    slug: 'notifications', category: 'find', title: 'Alerts', summary: 'When you are notified directly.',
    keywords: 'alerts notifications bell mention reply notified',
    blocks: [
      p('**Alerts**, at the bottom of the left menu, lists what concerns you personally:'),
      list('someone **@mentioned** you;', 'someone **replied** in a thread you took part in;', 'you were **added** to a project or a conversation;', 'someone **reviewed** a fact you entered;', 'a fact in **your dependency chain** was retracted.'),
      p('Click an alert to go to the item. **Mark all read** clears the list.'),
    ],
    related: ['unread', 'comments'],
  },

  // ---------------------------------------------------------------- Privacy and administration
  {
    slug: 'privacy', category: 'admin', title: 'Who can see what', summary: 'Visibility of your data within a project.',
    keywords: 'privacy private visibility security who can see access permissions confidential',
    blocks: [
      table(['Content', 'Visible to'], ['Question, facts, files, bibliography and their comments', 'All project members, including AI agents'], ['Conversations and their comments', 'Their participants only'], ['Your email address', 'You only'], ['Your read state', 'You only'], ['Your API keys', 'You only, and only when created']),
      warn('A fact extracted from a private conversation is visible to all members. Its quote and link stay hidden from non-participants, and a participant must confirm before the extraction is queued.'),
      p('People outside a project cannot see anything in it. Your own AI client sees what you see.'),
    ],
    related: ['people', 'download-project'],
  },
  {
    slug: 'backups', category: 'admin', title: 'Backups and installation', summary: 'For the administrator of this platform.',
    keywords: 'backup restore administrator install deploy server update hosting',
    blocks: [
      p('The administrator can create full backups of the platform and restore them from the command line. Members cannot do this, but each can [download their own copy](help:download-project) of a project, or choose to let the [AI client](help:ai-app) keep regular copies.'),
      list('[Installation guide](https://github.com/LudovicPatey/projects#installation)', '[Backup and restoration](https://github.com/LudovicPatey/projects/blob/master/docs/BACKUP.md)', '[Deployment](https://github.com/LudovicPatey/projects/blob/master/docs/DEPLOY.md)', '[API for AI clients](https://github.com/LudovicPatey/projects/blob/master/docs/AGENT_API.md)'),
    ],
    related: ['download-project', 'privacy'],
  },
  {
    slug: 'feedback', category: 'admin', title: 'Reporting a bug or requesting a feature', summary: 'Tell the administrators what breaks or what is missing.',
    keywords: 'feedback bug report issue problem error feature request idea suggestion improvement support contact administrator',
    blocks: [
      p('The **Feedback** button, at the bottom of the left menu, is available on every page. It opens a short form without leaving what you are doing.'),
      steps('Click **Feedback**.', 'Choose **Bug report** or **Feature request**.', 'Give a title and a description. For a bug, say what you did, what you expected and what happened.', 'Say how much it matters, and click **Send**.'),
      tip('Leave **Include the page address** checked for a bug: it helps to reproduce it. Only the address and your browser are sent, never the content of the page.'),
      h('Follow your reports'),
      p('The [Feedback](app:feedback) page lists your reports with their status. A red badge on the menu tells you when one changes or gets an answer. You can edit or delete a report until it is being handled.'),
      table(['Status', 'Meaning'], ['**Received**', 'Waiting to be read'], ['**Planned**', 'Accepted, to be done'], ['**In progress**', 'Being worked on'], ['**Done**', 'Fixed or added'], ['**Declined**', 'Will not be done, usually with an explanation']),
      h('Privacy'),
      p('A report can be read only by **you and the platform administrators**, and not by the other members of your projects. Avoid pasting unpublished results.'),
      h('For administrators'),
      p('The people whose ORCID iD is listed under `feedback_admins` in `config/config.php` also see **All reports**. They can change the status and answer the author.'),
      warn('If `feedback_admins` is empty, reports are stored, but nobody can read them except their authors.'),
    ],
    related: ['welcome', 'privacy'],
  },
];

/** The article explaining each area of the application. */
export const VIEW_HELP = { overview: 'question', questions: 'open-questions', conversations: 'conversations', facts: 'facts-overview', files: 'files', bib: 'bibliography', ai: 'ai-work', members: 'people', admin: 'administration', help: 'welcome' };

/** The article covering each server feature. Adding a controller without help makes the tests fail. */
export const CONTROLLER_HELP = {
  AuthController: 'account', FeedbackController: 'feedback', ProjectController: 'question', DashboardController: 'question', ReferenceController: 'references', QuestionController: 'open-questions', AgentController: 'project-agents', KeyController: 'ai-client', AiTaskController: 'ai-work', BibController: 'bibliography',
  DocumentController: 'files', FactController: 'facts-overview', NotationController: 'notation', ConsolidationController: 'consolidation', ProverController: 'native-prover', AdminController: 'administration', AuditController: 'administration', ConversationController: 'conversations', CommentController: 'comments',
  NotificationController: 'notifications', ExportController: 'download-project', SearchController: 'search', HelpController: 'welcome',
};

export const articleBySlug = (slug) => ARTICLES.find((a) => a.slug === slug) || null;

/** What this user could usefully do next in the project. */
export function nextSteps(c) {
  const out = [];
  const u = c.unread || {};
  if (c.conversations.unread.length) out.push({ icon: 'mail', text: `Read ${n(u.conversation || c.conversations.unread.length, 'new message')}`, to: { view: 'conversations', id: c.conversations.unread[0].id }, help: 'conversations' });
  if (c.questions.at_risk.length) out.push({ icon: 'eye', text: `Check the answer to “${c.questions.at_risk[0].title}”`, to: { view: 'questions', id: c.questions.at_risk[0].id }, help: 'answers' });
  if (c.questions.pending.length) out.push({ icon: 'check-circle', text: `Ratify an answer to “${c.questions.pending[0].title}”`, to: { view: 'questions', id: c.questions.pending[0].id }, help: 'answers' });
  if (c.facts.disputed.length) out.push({ icon: 'graph', text: `Look at ${n(c.facts.by_status.disputed || 0, 'disputed fact')}`, to: { view: 'facts', id: c.facts.disputed[0].id }, help: 'reviews' });
  if (c.facts.to_review.length) out.push({ icon: 'check-circle', text: `Review ${n(c.facts.to_review_count, 'fact')}`, to: { view: 'facts', id: c.facts.to_review[0].id }, help: 'reviews' });
  if (!c.questions.total) out.push({ icon: 'target', text: 'State the big questions of this project', to: { view: 'questions' }, help: 'open-questions' });
  else if (c.questions.without_strategy.length) out.push({ icon: 'target', text: `Propose a strategy for “${c.questions.without_strategy[0].title}”`, to: { view: 'questions', id: c.questions.without_strategy[0].id }, help: 'proof-strategies' });
  if (c.thread) out.push({ icon: 'comment', text: 'Answer an open comment thread', to: { view: c.thread.view, id: c.thread.id, query: { comment: c.thread.comment } }, help: 'comments' });
  if (!c.facts.total) out.push({ icon: 'key', text: 'Install an AI client to build the fact database', to: { view: 'help', query: { a: 'ai-setup' } }, help: 'ai-setup' });
  if (!c.files.total) out.push({ icon: 'upload', text: 'Upload a first paper', to: { view: 'files', query: { upload: 1 } }, help: 'files' });
  if (!c.bib.total) out.push({ icon: 'book', text: 'Add references', to: { view: 'bib' }, help: 'bibliography' });
  else if (c.bib.without_pdf.length) out.push({ icon: 'pdf', text: `Attach a PDF to ${n(c.bib.without_pdf_count, 'reference')}`, to: { view: 'bib', id: c.bib.without_pdf[0].id }, help: 'bibliography' });
  if (c.people.researchers < 2 && c.project.role === 'owner') out.push({ icon: 'user-plus', text: 'Invite a colleague', to: { view: 'members' }, help: 'people' });
  return out.slice(0, 5);
}

// ----- links -----
const GLOBAL_VIEWS = { profile: '#/profile', projects: '#/projects', feedback: '#/feedback', client: '#/client' };

/** URL of a `help:slug` or `app:view` target, or null when it needs a project and there is none. */
export function resolveTarget(target, pid) {
  if (/^https?:/.test(target)) return target;
  if (target.startsWith('help:')) return pid ? `#/p/${pid}/help?a=${target.slice(5)}` : `#/help?a=${target.slice(5)}`;
  if (target.startsWith('app:')) {
    const view = target.slice(4);
    if (GLOBAL_VIEWS[view]) return GLOBAL_VIEWS[view];
    return pid ? `#/p/${pid}/${view}` : null;
  }
  return null;
}

export function pointerHref(to, pid) {
  if (to.path) return to.path;
  const q = to.query ? '?' + new URLSearchParams(to.query) : '';
  return `#/p/${pid}/${to.view}${to.id ? '/' + to.id : ''}${q}`;
}

/** Splits inline markup into typed pieces. Text is never interpreted as HTML. */
export function inlineTokens(text) {
  const out = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let pos = 0;
  for (let m; (m = re.exec(text));) {
    if (m.index > pos) out.push({ t: 'text', v: text.slice(pos, m.index) });
    if (m[1] !== undefined) out.push({ t: 'b', v: m[1] });
    else if (m[2] !== undefined) out.push({ t: 'code', v: m[2] });
    else out.push({ t: 'link', v: m[3], target: m[4] });
    pos = re.lastIndex;
  }
  if (pos < text.length) out.push({ t: 'text', v: text.slice(pos) });
  return out;
}

// ----- search -----
const FOLD = { ø: 'o', ł: 'l', đ: 'd', ß: 'ss', æ: 'ae', œ: 'oe', '–': '-', '—': '-' };
const fold = (s) => [...String(s).toLowerCase()].map((c) => FOLD[c] ?? c.normalize('NFD').replace(/\p{M}/gu, '')).join('');
const strip = (s) => s.replace(/\*\*|`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

export function articleText(a) {
  const parts = [];
  for (const b of a.blocks) {
    if (b.text) parts.push(strip(b.text));
    if (b.items) parts.push(...b.items.map(strip));
    if (b.rows) parts.push(...b.rows.flat().map(strip));
  }
  return parts.join(' ');
}

const INDEX = ARTICLES.map((a) => { const body = articleText(a); return { a, body, title: fold(a.title), summary: fold(a.summary), keys: fold(a.keywords || ''), text: fold(body) }; });

export function searchHelp(query, limit = 40) {
  const terms = [...new Set(fold(query).split(/\s+/).filter(Boolean))];
  if (terms.join('').length < 2) return [];
  const found = [];
  for (const x of INDEX) {
    const all = `${x.title} ${x.summary} ${x.keys} ${x.text}`;
    if (!terms.every((t) => all.includes(t))) continue;
    let score = x.title === terms.join(' ') ? 60 : 0;
    for (const t of terms) score += (x.title.includes(t) ? 12 : 0) + (x.keys.includes(t) ? 8 : 0) + (x.summary.includes(t) ? 4 : 0) + (x.text.includes(t) ? 1 : 0);
    const at = x.text.indexOf(terms[0]);
    let snippet = x.a.summary;
    if (at >= 0 && !x.summary.includes(terms[0])) {
      const start = Math.max(0, at - 45);
      snippet = (start ? '…' : '') + x.body.slice(start, at + 90).trim() + '…';
    }
    found.push({ slug: x.a.slug, title: x.a.title, category: x.a.category, snippet, score });
  }
  return found.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
}
