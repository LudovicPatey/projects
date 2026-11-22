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
    keywords: 'menu navigation rail sidebar top bar shortcuts keyboard phone mobile switch project',
    blocks: [
      h('Left menu'),
      p('The left menu switches between the areas of the project, like a webmail client. A red number shows what is new in each area. At the bottom are the **Help** center, your **Alerts** and your **profile**.'),
      p('The square at the top left shows the initials of the project. Click it to [switch to another project](app:projects).'),
      h('Top bar'),
      p('The top bar shows the current project, the [search bar](help:search), and a **Help** button that opens the article about the page you are on.'),
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
    keywords: 'orcid login sign in sign out logout profile name affiliation email account password',
    blocks: [
      p('Your account is your **ORCID iD**. You sign in on orcid.org, so the platform has no password of its own.'),
      h('Change your details'),
      steps('Open [your profile](app:profile).', 'Edit your **display name**, **affiliation** or **email**.', 'Click **Save**.'),
      p('Your email address is visible only to you. It is not shown to other members or included in project downloads.'),
      p('**Sign out** is on the same page.'),
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
    keywords: 'question overview status open solved archived edit title dashboard activity attention progress team',
    blocks: [
      p('The [Overview](app:overview) page is the dashboard of the project: the main problem, how many questions are settled, **what needs your attention**, the big questions, the state of the facts and strategies, recent activity and the team.'),
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
      warn('Ratify is unavailable while the fact has no human endorsement, is denied, disputed or retracted, or relies on a denied, disputed or retracted fact.'),
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
      tip('Keep failed strategies. Recording why an approach fails saves the group from trying it again.'),
    ],
    related: ['open-questions', 'answers', 'comments'],
  },
  {
    slug: 'people', category: 'project', title: 'Researchers and roles', summary: 'Add colleagues, change roles, or leave a project.',
    keywords: 'members people researchers invite add remove owner member role leave orcid team',
    blocks: [
      live((c) => [line(`This project has ${n(c.people.researchers, 'researcher')}. You are **${c.project.role}**. Owners:`, c.people.owners.map(toPerson))]),
      h('Add a researcher (owners)'),
      steps('Open [People](app:members).', 'Enter their **ORCID iD** or ORCID link.', 'Choose **Member** or **Owner**, and click **Add**.'),
      p('They do not need to have signed in before. Their public ORCID name is fetched automatically.'),
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
    ],
    related: ['comments', 'writing'],
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
        ['Fact', '`fact:`'], ['Fact review', '`review:`'], ['Lean proof', '`lean:`'],
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
      p('Type `@` then a few letters to cite **anything in the project**: a person, question, strategy, answer, fact, Lean proof, file, reference, conversation, message or comment. See [References to anything](help:references).'),
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
      list('**Upload PDF** attaches one PDF to a reference, which you can read and annotate.', 'The **BibTeX** tab lets you correct an entry.', 'The copy icon copies its `\\cite{…}` command.', 'The download icon exports the whole bibliography as `.bib`.', 'The **Mentions** tab shows where it is cited.'),
    ],
    related: ['pdf', 'writing'],
  },

  // ---------------------------------------------------------------- Fact database
  {
    slug: 'facts-overview', category: 'facts', title: 'What is the fact database?', summary: 'A shared graph of statements, proofs and dependencies.',
    keywords: 'facts database graph dag statement proof intuition dependency list danus knowledge',
    blocks: [
      p('[Facts](app:facts) records what the project knows. A fact has a **statement**, usually a **proof**, an optional **intuition**, and the **facts it depends on**. Together they form a graph.'),
      live((c) => c.facts.total ? [line(`This project has ${n(c.facts.total, 'fact')}.` + (c.facts.to_review_count ? ` ${n(c.facts.to_review_count, 'fact')} await your review:` : ' You have reviewed them all.'), c.facts.to_review.map(toFact)),
        c.facts.most_used && line(`The most reused result is used by ${n(c.facts.most_used.used_by, 'other fact')}:`, [toFact(c.facts.most_used)])].filter(Boolean)
        : [line('This project has no fact yet. Your [AI client](help:ai-client) can extract them from your papers and discussions.')]),
      h('List and graph'),
      list('**List:** search, filter by status, proof origin, label or Lean, and sort. Click **Filters** to show them.', '**Graph:** a fact appears below what it depends on. Click one to highlight its lineage. Drag to pan, and scroll to move. Use the zoom buttons or **Fit**.'),
      h('How facts are added'),
      p('Facts are not typed in the interface. **AI clients and agents submit them through the API**, so they all follow one validated format. Humans then [review and endorse](help:reviews) them.'),
      h('Reading a fact'),
      table(['Tab', 'Content'], ['**Fact**', 'Statement, proof, intuition and sources'], ['**Reviews**', 'Verdicts of humans and AI'], ['**Lean**', 'Formal proofs'], ['**Links**', 'What it uses, and what uses it'], ['**Trace**', 'Where it comes from, and who is credited']),
    ],
    related: ['fact-labels', 'reviews', 'traceability'],
  },
  {
    slug: 'fact-labels', category: 'facts', title: 'Labels and kinds of facts', summary: 'Counterexample, conclusion, dead end and the other labels.',
    keywords: 'labels kinds counterexample conclusion example proof attempt plan dead end direction obstacle guidance verification elaboration lemma theorem definition',
    blocks: [
      p('Each fact has a mathematical **kind** (definition, lemma, theorem…) and one or more **labels**, taken from the Danus vocabulary.'),
      live((c) => { const e = Object.entries(c.facts.labels); return e.length ? [line('Labels used in this project: ' + e.map(([k, v]) => `**${k.replaceAll('_', ' ')}** (${v})`).join(', ') + '.'), c.facts.counterexamples.length ? line('Counterexamples:', c.facts.counterexamples.map(toFact)) : null].filter(Boolean) : [line('No fact has a label yet in this project.')]; }),
      table(['Label', 'Meaning'],
        ['**conclusion**', 'An established result'], ['**example**', 'A worked example'], ['**counterexample**', 'A case refuting a claim'], ['**proof attempt**', 'A proof not yet accepted'],
        ['**plan**', 'A plan of work'], ['**direction**', 'A line of attack'], ['**obstacle**', 'A difficulty met'], ['**dead end**', 'An approach that failed, recorded to avoid repeating it'],
        ['**master guidance**', 'Guidance for the overall effort'], ['**verification**', 'A check of another result'], ['**elaboration**', 'A more detailed version of a result']),
      tip('Filter the list by label to review, for example, every **dead end** before trying a new approach.'),
    ],
    related: ['facts-overview', 'danus'],
  },
  {
    slug: 'reviews', category: 'facts', title: 'Reviewing and endorsing facts', summary: 'How facts become trusted, and what each status means.',
    keywords: 'review endorse endorsement deny denied validate verdict correct gap incorrect status unchecked disputed checked double trust validate',
    blocks: [
      live((c) => c.facts.to_review.length ? [line(`${n(c.facts.to_review_count, 'fact')} await your review. Start with:`, c.facts.to_review.map(toFact)), c.facts.disputed.length ? line('Disputed, and worth a look:', c.facts.disputed.map(toFact)) : null].filter(Boolean) : [line(c.facts.total ? 'You have reviewed every fact of this project.' : 'There is nothing to review yet.')]),
      h('Endorse'),
      p('**Endorse** is one click at the top of a fact. It means that you checked this revision and consider it correct. Click again to withdraw.'),
      h('Deny'),
      p('**Deny** is next to it. It means that you found an error, and asks you to point to it. The fact becomes **Disputed**, and facts relying on it are flagged. Only human endorsement lets a fact support a [ratified answer](help:answers).'),
      h('Write a review'),
      steps('Open the **Reviews** tab.', 'Choose **Correct**, **Gap** or **Incorrect**.', 'Explain what you checked. An explanation is required for a gap or an error.', 'Click **Submit review**.'),
      h('Status'),
      table(['Status', 'Meaning'], ['**Unchecked**', 'No independent check yet'], ['**AI-checked**', 'Accepted by an AI model other than its author'], ['**Human-checked**', 'Accepted by a human'], ['**Human + AI checked**', 'Accepted by both'], ['**Disputed**', 'A reviewer found a gap or an error'], ['**Retracted**', 'Withdrawn by a member']),
      warn('A new revision needs **new reviews**: endorsements of older revisions no longer count. An AI model cannot validate its own work.'),
      p('A warning also appears on a fact that relies on an unchecked, disputed or retracted fact, even if the fact itself is accepted.'),
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
      p('**Built on** lists every fact in the dependency chain, so you can see which human proofs an AI result relies on.'),
      warn('The AI client states which part of a PDF contains the statement or proof, and the platform cannot verify this. Compare a fact with its cited page before endorsing it.'),
    ],
    related: ['reviews', 'ai-labels'],
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
      steps('Open the fact and click **Retract**.', 'Give the reason.', 'Everything that depends on it is flagged, and its authors are notified.'),
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
      steps('Open [your profile](app:profile), under **Personal API keys**.', 'Name the key and click **Create key**.', '**Copy it now:** it is shown only once.', 'Copy the setup commands into the terminal of your AI client.', 'Give it the instructions shown on the same screen.'),
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
        ['**Extract facts**', 'Automatically, when a person uploads a file or a new version', 'Facts with an exact quotation. A quotation not found in the file is refused'],
        ['**Answer a question**', 'Write `@AI` in a message or a comment', 'A reply in the same thread, labelled with its model'],
        ['**Find references**', 'A request on the AI work page', 'Suggestions that a person must accept'],
        ['**Prove new facts**', 'A member starts a [proof search](help:danus) from their client', 'New facts, marked unchecked']),
      h('Ask the AI in a discussion'),
      steps('Type `@` in a message or a comment.', 'Choose **Ask AI**, or keep typing `@AI`.', 'Write your question and send it.', 'The next AI client to run answers in the same thread, and you are notified.'),
      h('Validate suggested references'),
      p('A suggestion must give a DOI, an arXiv id or an address. **Open the link to check it**, because an AI can invent a reference. **Accept** adds it to the [bibliography](help:bibliography) with its AI origin. **Reject** removes it from the list.'),
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
    keywords: 'backup backups automatic weekly retention keep copies update updates upgrade new version latest app desktop graphic interface limit limits usage quota subscription budget percent pause hours tokens stop command line billing cost price pay api key credits extra',
    blocks: [
      p('The AI client has a **graphic interface** and a **command line**. Both use the same engine and the same limits.'),
      h('Install the Mac app'),
      steps('Open the [AI client page](app:client). When the Mac app is published, a **Download** button appears there. Until then, the page gives one command that opens the same interface.', 'Open it and drag **Open Questions AI** to **Applications**.', 'Open the app. If macOS blocks it, open **System Settings**, then **Privacy & Security**, and click **Open Anyway**. This appears because the app is not yet signed with an Apple developer certificate.', 'On the **Accounts** page, install or sign in to your AI, then paste your [personal key](help:ai-client).', 'On **Home**, click **Start**. Closing the window keeps it working from the menu bar. Choose **Quit** there to stop it.'),
      p('The installable app includes everything it needs. The one-command version needs Python 3.8 or later, on Mac, Windows or Linux.'),
      shot('app-home.webp', 'The Home page of the client, with its status, usage meters, projects and activity', 'Home: is it working, and how much has it used?'),
      h('Keep your subscription for yourself'),
      p('Before each task, the client checks your limits. If one is reached, it waits and resumes later. Your AI account is not used while it waits.'),
      shot('app-limits.webp', 'The Usage limits page, with sliders, daily caps and types of work', 'Usage limits.'),
      table(['Limit', 'Default', 'Works with'],
        ['Share of the session limit', '50%', 'ChatGPT'], ['Share of the weekly limit', '50%', 'ChatGPT'],
        ['Tasks per day', '20', 'Both'], ['Computing minutes per day', '120', 'Both'], ['Tokens per day', '2,000,000', 'Both'],
        ['Maximum minutes per task', '30', 'Both'], ['Working hours', 'All day', 'Both']),
      warn('**ChatGPT** reports the real share of your subscription. **Claude** does not report it to unattended tools, so the client applies its daily caps and stops when Claude says a limit is reached. These caps count only what this client used, not your other use of Claude.'),
      p('A task already running can go slightly past a limit, because limits are checked between tasks. A [proof search](help:danus) runs only when you start it, with its own stops, checked every 30 seconds.'),
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
      h('From the command line'),
      cmd('python3 oq.py update --check', 'Check for a new version'),
      cmd('python3 oq.py app', 'Open the graphic interface'),
      cmd('python3 oq.py limits --max-session-percent 30 --max-weekly-percent 40 --hours 22-7', 'Change the limits'),
      cmd('python3 oq.py limits --pause', 'Pause'),
      cmd('python3 oq.py limits --resume', 'Resume'),
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
    keywords: 'prove proof proving search new facts agents danus run launch start stop button duration time limit session weekly reset resume continue import sync synchronize wrapper watch serve fact graph predecessors batch derive',
    blocks: [
      live((c) => (c.facts.danus.length ? [line('Facts imported from Danus in this project:', c.facts.danus.map(toFact))] : [line('No fact has been imported from Danus in this project.')])),
      p('**Prove new facts** lets a team of AI agents search for new proofs on your computer. It is powered by [Danus](https://github.com/frenzymath/Danus), an open-source multi-agent system that builds a graph of AI-verified mathematical facts. You do not need to know or configure Danus: the client handles it.'),
      h('Set it up once'),
      steps('Open the [AI client](help:ai-app), then the **Prove new facts** page.', 'Click **Set up proving**. The client creates an isolated Linux machine and installs Danus in it.', 'Sign in to ChatGPT when the page shows a code.'),
      p('The first installation downloads about 2 GB.'),
      h('Start a proof search'),
      p('This is the heaviest use of your subscription, so **it starts only when you press Start proving**. A **Prove new facts** request on the platform waits until a member chooses it as the goal of a search.'),
      steps('Choose the **project**, then a **goal**: the whole project, a question, or a waiting request.', 'Choose how many **agents** work in parallel.', 'Set when to **stop**: a running time, a share of your session limit, and a share of your weekly limit. The first one reached stops the run.', 'Choose what happens at a usage limit: **end the run**, or **wait and continue after the reset**.', 'Press **Start proving**. Facts appear in the project as they are found.'),
      shot('app-danus.webp', 'The proof search form, with project, goal, agents, running time, session and weekly stops, and what to do at a limit', 'Set up a run.'),
      table(['Stop', 'What it means'], ['Running time', 'Time the agents actually work. Time spent waiting for a reset does not count. `0` means no time limit.'], ['Session usage', 'Stops at this percentage of your ChatGPT session limit.'], ['Weekly usage', 'Stops at this percentage of your ChatGPT weekly limit.']),
      p('Your [general limits](help:ai-app) always apply: a run cannot go above them. Usage is checked every 30 seconds, so a run can pass a limit slightly, especially with many agents.'),
      shot('app-danus-run.webp', 'A running proof search with its running time, session and weekly usage against their stops, new facts and a Stop button', 'Follow a run, and stop it at any time. Facts found so far are kept.'),
      warn('With **no time limit** and **continue after the reset**, the search uses your subscription up to your stop level in every period, until you stop it.'),
      p('If the client or computer stops, the search halts by itself within a few minutes. A search set to continue picks up when you reopen the app.'),
      cmd('python3 oq.py danus run --project 1 --minutes 120 --stop-session 40 --stop-weekly 50 --on-limit resume', 'From the command line'),
      cmd('python3 oq.py danus stop', 'Stop it from another terminal'),
      warn('Proof searches need a **ChatGPT** account, because the Danus agents and verifier run on Codex. With Claude alone, you can turn on **Prove new facts automatically** in the client limits, which uses Claude directly.'),
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
      warn('Imported facts arrive as **unchecked**. The Danus verifier is itself an AI, and the platform cannot confirm that it ran.'),
    ],
    related: ['ai-client', 'fact-labels'],
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
      warn('A fact extracted from a private conversation is visible to all members. Its quote and link stay hidden from non-participants, and your AI client must ask you before citing such a conversation.'),
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
export const VIEW_HELP = { overview: 'question', questions: 'open-questions', conversations: 'conversations', facts: 'facts-overview', files: 'files', bib: 'bibliography', ai: 'ai-work', members: 'people', help: 'welcome' };

/** The article covering each server feature. Adding a controller without help makes the tests fail. */
export const CONTROLLER_HELP = {
  AuthController: 'account', FeedbackController: 'feedback', ProjectController: 'question', DashboardController: 'question', ReferenceController: 'references', QuestionController: 'open-questions', AgentController: 'project-agents', KeyController: 'ai-client', AiTaskController: 'ai-work', BibController: 'bibliography',
  DocumentController: 'files', FactController: 'facts-overview', ConversationController: 'conversations', CommentController: 'comments',
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
