# Interface rules

Every page, panel, button and notice of Open Questions follows these rules. Read them before changing the interface, and check them in
every audit (`docs/AUDIT.md`, "The interface"). `AGENTS.md` makes them part of the definition of done.

## Who reads the interface

Members are mathematicians, not users of this platform. They do not know its vocabulary, what runs on its own, or what a button reaches.
Assume a newcomer who must understand each screen from what it says, without the help center.

## 1. Every action says what it does

- **Name it without ambiguity.** "Agree", "Keep local", "Reject", not "OK" or "Apply". Two buttons never share a name for different effects.
- **Say what it changes and what it leaves as it is**, on hover (`explain()` and the registry `public/assets/js/action-help.js`) and in
  its confirmation. "Agree on Y \leq X" changes the meaning between block sequences only, and leaves \leq between numbers alone.
- **Say how far it reaches**: this fact only, every fact of a paper, the whole project, every member. When the reach is not obvious, say
  it beside the button, not only on hover (the notation page's "What each choice changes" is the model).
- **Say whether it can be undone, and how**: "Undo under Consolidate", "a member can reopen it", or that it is final. A confirmation
  that cannot be undone says so.
- **Confirm what reaches further than expected**: retracting for every member, deleting, rewriting many facts. The confirmation repeats
  the same explanation as the hover.
- **A disabled button says why**, and what would enable it (the AI request limit: "Limit reached. The next request is available in 20 min.").

## 2. Every piece of data says whether it is final

- **Waiting for an AI pass.** Data a sweep will still change is marked **Not final yet** with the `ai-pending` component
  (`Sweeps::pendingForFact`, `Sweeps::pendingItems`, `PENDING_PASSES` in `ai-model.js`): which pass, what it will do, whether it is
  queued now or once the project is quiet, and what a person should do meanwhile. Nobody should fix by hand what an AI is about to redo,
  or take a draft for final. A new sweep adds its pass there, and the page that shows its data uses `ai-pending`.
- **Waiting for a person.** Data that only a person can settle says so, and says who: any member, an owner, the person who read the
  source. It appears in "Needs your attention" on the overview when it is the member's to do.
- **Left by the AI.** When an AI tried and gave up (two sweeps read a symbol without settling it, a review left a proposal to people),
  say so: it will not come back on its own.
- **Decided by whom.** Every decision shows whether a person or an AI took it ("Adopted by the consolidation", a person's name), with
  the model for AI work, and how to overrule it. A person's decision always wins over an AI's.
- **State words mean one thing.** "not compared yet", "unchecked", "proposed" each say what will happen next, not only what is missing.

## 3. Limits and costs are visible

- A person sees what they use of a limited resource before they hit it: the AI request meter, the count on each AI button.
- What counts and what does not is said: the platform's own sweeps count for nobody.

## 4. Mathematics reads as mathematics

- Formulas are rendered with KaTeX, everywhere text can contain them, types and notes included (`math-text`); raw `$` never shows.
- A symbol is drawn one way everywhere: `asMath` (words as text, formulas as math), and `colorMath(asMath(symbol), params)` where its
  parameters are colored. Never wrap a symbol in dollars by hand.
- `scripts/visual-audit.js` reports formulas KaTeX cannot read, dollars left in the text, and words set as a formula in italics. A change
  to how symbols or formulas are drawn is checked against every symbol of a real project with its types, not against a few examples.
- Words are text and formulas are math (`asMath`): "C large for \mathcal D" renders "large for" as words.
- Notation parameters are colored, with their type on hover; a letter that only names a symbol (the c of \le_c) is not a parameter.

## 5. Layout

- Structured components (`panel`, `kpi`, `pill`, `StackBar`, work lists, `SectionHome`), not plain text.
- Works at 1440, 1024, 800 and 375 pixels: run `scripts/visual-audit.js` on each affected view and dialog, then look at a screenshot.
- `select.sm` beside `btn sm`; never `background:` or a small right padding on a `select`.
- Status colors always come with a word or an icon, never color alone.
- Cards side by side keep their controls on one line at the bottom, at one height across a row: a text whose length varies goes on
  its own line above them, never in the row of buttons.
- Before committing an interface change: the audit and a screenshot at each width, on realistic data (long names and labels, every
  state), not on a test page with short texts.

## 6. New information re-thinks the layout

Adding a piece of information to a page is a moment to redesign the part it joins, not to append a block. Before adding one, list
everything the card or panel already shows and give each its place in one structure: a header (what it is, its state, who decided it,
the actions), the main content, then labelled rows or sections for the rest, each with a label that says what it is. Color is not a
structure: it marks what color alone carries (a parameter's identity, a status with its word), never a block that would otherwise be
lost among the others. The notation entry is the example: symbol, decision and actions in its header, the meaning, then one panel of
labelled rows (Applies to, How sources differ, Other forms, Other meanings, Defined in), instead of boxes and colored notes stacked.

## 7. Help follows the interface

Each new notice, state or action has its explanation in the help center (`public/assets/js/help/content.js`), and the first-use tour
and front page are updated when what they say becomes wrong.
