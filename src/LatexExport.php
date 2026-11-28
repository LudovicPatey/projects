<?php
declare(strict_types=1);

namespace App;

use App\Controllers\BibController;
use App\Controllers\FactController;

/**
 * A proved fact as a LaTeX article: every fact its proof relies on, proved before it is used, and the results of other works
 * stated with their sources. The text is the facts' own, converted from their rich text; nothing is rewritten. An AI client
 * with LaTeX compiles it, and the platform adds the file to the project.
 */
final class LatexExport
{
    private const ENVS = ['theorem' => 'Theorem', 'proposition' => 'Proposition', 'lemma' => 'Lemma', 'corollary' => 'Corollary',
        'definition' => 'Definition', 'conjecture' => 'Conjecture', 'remark' => 'Remark'];
    private const CHECKED = ['human_checked' => 'checked by a member of the project', 'ai_checked' => 'checked by an independent AI review',
        'double_checked' => 'checked by a member and by an independent AI review', 'accepted' => 'accepted by a member', 'definition' => 'a definition'];
    /** Characters KaTeX reads and pdfLaTeX does not: each becomes its command, in a formula or in the text. */
    private const UNICODE = ['∀' => '\forall', '∃' => '\exists', '∄' => '\nexists', '∈' => '\in', '∉' => '\notin', '∋' => '\ni', '⊆' => '\subseteq', '⊂' => '\subset',
        '⊇' => '\supseteq', '⊃' => '\supset', '⊊' => '\subsetneq', '∪' => '\cup', '∩' => '\cap', '⋃' => '\bigcup', '⋂' => '\bigcap', '∖' => '\setminus',
        '→' => '\to', '←' => '\leftarrow', '↔' => '\leftrightarrow', '⇒' => '\Rightarrow', '⇐' => '\Leftarrow', '⇔' => '\Leftrightarrow', '↦' => '\mapsto',
        '≤' => '\le', '≥' => '\ge', '≠' => '\ne', '≈' => '\approx', '≡' => '\equiv', '≅' => '\cong', '∼' => '\sim', '≺' => '\prec', '≻' => '\succ', '⪯' => '\preceq', '⪰' => '\succeq',
        '×' => '\times', '·' => '\cdot', '∘' => '\circ', '∞' => '\infty', '∅' => '\emptyset', '¬' => '\neg', '∧' => '\wedge', '∨' => '\vee', '⊢' => '\vdash', '⊨' => '\models',
        '⟨' => '\langle', '⟩' => '\rangle', '…' => '\ldots', '⋯' => '\cdots', '±' => '\pm', '∑' => '\sum', '∏' => '\prod', '√' => '\surd', '∂' => '\partial', '∇' => '\nabla',
        'ℕ' => '\mathbb{N}', 'ℤ' => '\mathbb{Z}', 'ℚ' => '\mathbb{Q}', 'ℝ' => '\mathbb{R}', 'ℂ' => '\mathbb{C}', '′' => '\prime', '⊕' => '\oplus', '⊗' => '\otimes', '△' => '\triangle',
        'α' => '\alpha', 'β' => '\beta', 'γ' => '\gamma', 'δ' => '\delta', 'ε' => '\varepsilon', 'ζ' => '\zeta', 'η' => '\eta', 'θ' => '\theta', 'ι' => '\iota', 'κ' => '\kappa',
        'λ' => '\lambda', 'μ' => '\mu', 'ν' => '\nu', 'ξ' => '\xi', 'π' => '\pi', 'ρ' => '\rho', 'σ' => '\sigma', 'τ' => '\tau', 'φ' => '\varphi', 'χ' => '\chi', 'ψ' => '\psi', 'ω' => '\omega',
        'Γ' => '\Gamma', 'Δ' => '\Delta', 'Θ' => '\Theta', 'Λ' => '\Lambda', 'Ξ' => '\Xi', 'Π' => '\Pi', 'Σ' => '\Sigma', 'Φ' => '\Phi', 'Ψ' => '\Psi', 'Ω' => '\Omega'];
    /** @var array<string, string> names of facts in the text being converted => their reference */
    private static array $names = [];
    private const TEXT_UNICODE = ['–' => '--', '—' => '---', '‘' => '`', '’' => "'", '“' => '``', '”' => "''", "\u{00A0}" => '~', '•' => '\textbullet{}'];

    /** Why this fact cannot be exported yet, or null when it can. @param array<int, array> $byId the facts of FactController::graph() */
    public static function problem(array $byId, int $fid): ?string
    {
        $f = $byId[$fid] ?? null;
        if (!$f) return 'This fact is not in the project.';
        if ($f['basis'] === 'cited') return 'This result is cited from another work: there is no proof to assemble.';
        if (in_array($f['display_kind'], ['definition', 'conjecture', 'remark'], true)) return 'Only a proved result can be assembled into a document.';
        $usable = FactController::usable($byId);
        if (!($usable[$fid] ?? false)) {
            foreach (self::closure($byId, $fid) as $id) {
                if (!($usable[$id] ?? false) && $id !== $fid && !array_filter($byId[$id]['deps'], fn($d) => !($usable[(int)$d] ?? false))) {
                    return "It relies on {$byId[$id]['label']}, which is not checked yet: a document can only assemble checked proofs.";
                }
            }
            return 'Its proof is not checked yet, or it relies on an unsettled outside result: a document can only assemble checked proofs.';
        }
        return null;
    }

    /** The fact and everything it relies on, each after what it uses. @return list<int> */
    public static function closure(array $byId, int $fid): array
    {
        $order = []; $seen = [];
        $visit = function (int $id) use (&$visit, &$order, &$seen, $byId): void {
            if (isset($seen[$id]) || !isset($byId[$id])) return;
            $seen[$id] = true;
            $deps = array_map('intval', $byId[$id]['deps']);
            sort($deps);
            foreach ($deps as $d) $visit($d);
            $order[] = $id;
        };
        $visit($fid);
        return $order;
    }

    /** @return array{tex: string, bib: string, title: string, facts: list<int>, models: list<string>, sha256: string} */
    public static function build(int $pid, int $fid): array
    {
        $byId = array_column(FactController::graph($pid)['facts'], null, 'id');
        if ($why = self::problem($byId, $fid)) throw new HttpError(422, $why);
        $ids = self::closure($byId, $fid);
        $project = Db::one('SELECT title FROM projects WHERE id = ?', [$pid]);
        [$in, $params] = Db::in($ids);
        $rev = [];
        foreach (Db::all("SELECT r.fact_id, r.revision_no, r.statement_html, r.proof_html, r.external_refs_json FROM fact_revisions r JOIN facts f ON f.id = r.fact_id AND r.revision_no = f.current_revision WHERE r.fact_id IN $in", $params) as $r) $rev[(int)$r['fact_id']] = $r;
        $kinds = [];
        foreach ($ids as $id) $kinds[$id] = isset(self::ENVS[$byId[$id]['display_kind']]) ? $byId[$id]['display_kind'] : 'lemma';

        // The sources of each cited result: references of the bibliography, files of the project, or the reference as the fact gives it.
        $bib = []; $docs = []; $cites = [];
        foreach ($ids as $id) {
            foreach (Db::all("SELECT source_type, source_id, page FROM fact_sources WHERE fact_id = ? AND revision_no = ? AND covers <> 'context' AND source_type IN ('bib', 'document') ORDER BY id",
                [$id, $rev[$id]['revision_no']]) as $s) {
                if ($s['source_type'] === 'bib') {
                    $row = Db::one('SELECT * FROM bib_entries WHERE id = ? AND project_id = ?', [$s['source_id'], $pid]);
                    if (!$row) continue;
                    $bib[(int)$row['id']] = BibController::present($row)['bibtex'];
                    $cites[$id][] = ['key' => $row['cite_key'], 'page' => $s['page']];
                } else {
                    $d = Db::one('SELECT d.id, d.title, d.origin, u.name, d.created_at FROM documents d JOIN users u ON u.id = d.created_by WHERE d.id = ? AND d.project_id = ? AND d.deleted_at IS NULL', [$s['source_id'], $pid]);
                    if (!$d) continue;
                    $key = 'oqfile' . $d['id'];
                    $docs[$key] = sprintf("@misc{%s,\n  title = {%s},\n  author = {%s},\n  year = {%s},\n  note = {File of the project %s}\n}", $key,
                        self::bibText((string)$d['title']), self::bibText($d['origin'] === 'ai' ? 'AI-generated' : (string)$d['name']), substr((string)$d['created_at'], 0, 4), self::bibText((string)$project['title']));
                    $cites[$id][] = ['key' => $key, 'page' => $s['page']];
                }
            }
        }

        // The names a text gives the other facts of the document ("lem:full-match-gives-left-match", "Lemma 2.4", "fact 1484") become references.
        self::$names = [];
        foreach ($ids as $id) foreach (FactRefs::resolve($pid, $id, [Sanitizer::toText((string)$rev[$id]['statement_html']), Sanitizer::toText((string)$rev[$id]['proof_html'])]) as $x) {
            if (isset($kinds[$x['fact_id']])) self::$names[$x['text']] = self::ENVS[$kinds[$x['fact_id']]] . '~\ref{fact' . $x['fact_id'] . '}';
        }
        foreach ($ids as $id) self::$names['fact ' . $id] = self::$names['Fact ' . $id] = self::ENVS[$kinds[$id]] . '~\ref{fact' . $id . '}';

        $definitions = [];
        // One entry per symbol: a symbol two facts define differently lists both meanings, each with its fact.
        foreach ($ids as $id) foreach (FactController::definitions($pid, $id, (int)$rev[$id]['revision_no']) as $d) {
            $definitions[$d['symbol']][$d['meaning']][] = $id;
        }

        $models = array_values(array_unique(array_filter(array_map(fn($id) => $byId[$id]['ai_model'], $ids))));
        $main = $byId[$fid];
        $proved = count(array_filter($ids, fn($id) => $byId[$id]['basis'] !== 'cited'));
        $cited = count($ids) - $proved;
        $base = rtrim((string)Config::get('app_url', ''), '/');
        $ref = fn(int $id) => self::ENVS[$kinds[$id]] . '~\ref{fact' . $id . '}';

        $tex = "% Assembled by Open Questions from the facts of a project. Each statement and proof is the fact's own text.\n"
            . "\\documentclass[11pt]{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage[T1]{fontenc}\n\\usepackage{lmodern}\n"
            . "\\usepackage{amsmath,amssymb,amsthm,mathrsfs,mathtools}\n\\usepackage[margin=2.8cm]{geometry}\n\\usepackage[hidelinks]{hyperref}\n\n"
            . "\\theoremstyle{plain}\n\\newtheorem{theorem}{Theorem}\n\\newtheorem{proposition}[theorem]{Proposition}\n\\newtheorem{lemma}[theorem]{Lemma}\n\\newtheorem{corollary}[theorem]{Corollary}\n"
            . "\\newtheorem{conjecture}[theorem]{Conjecture}\n\\theoremstyle{definition}\n\\newtheorem{definition}[theorem]{Definition}\n\\newtheorem{remark}[theorem]{Remark}\n\n"
            // What KaTeX knows and LaTeX does not, and the shorthands papers use (public/assets/js/bare-tex.js, COMMON_MACROS).
            . "\\providecommand{\\N}{\\mathbb{N}}\n\\providecommand{\\Z}{\\mathbb{Z}}\n\\providecommand{\\Q}{\\mathbb{Q}}\n\\providecommand{\\R}{\\mathbb{R}}\n"
            . "\\providecommand{\\msf}[1]{\\mathsf{#1}}\n\\providecommand{\\mrm}[1]{\\mathrm{#1}}\n\\providecommand{\\mbf}[1]{\\mathbf{#1}}\n\\providecommand{\\mbb}[1]{\\mathbb{#1}}\n"
            . "\\providecommand{\\mcal}[1]{\\mathcal{#1}}\n\\providecommand{\\mfrak}[1]{\\mathfrak{#1}}\n\\providecommand{\\msc}[1]{\\mathscr{#1}}\n\\providecommand{\\mtt}[1]{\\mathtt{#1}}\n"
            . "\\providecommand{\\llbracket}{[\\![}\n\\providecommand{\\rrbracket}{]\\!]}\n\\providecommand{\\coloneqq}{\\mathrel{:=}}\n\\providecommand{\\restriction}{\\upharpoonright}\n\n"
            . '\title{' . self::inline((string)$main['title']) . "}\n"
            . '\author{Assembled from the facts of the project ``' . self::text((string)$project['title']) . "''}\n\\date{" . gmdate('F j, Y') . "}\n\n\\begin{document}\n\\maketitle\n\n"
            . "\\begin{abstract}\nThis document proves " . $ref($fid) . '. It assembles ' . self::count($proved, 'proved fact') . ' of the project, each proved before it is used'
            . ($cited ? ', and ' . self::count($cited, 'result') . ' cited from other works' : '') . '. The statements and proofs were written by AI models'
            . ($models ? ' (' . self::text(implode(', ', $models)) . ')' : '') . ' and are reproduced as the project records them; after each proof, a note says how it was checked. '
            . ($cited ? 'Cited results are stated with their sources and are not proved here. ' : '') . "\n\\end{abstract}\n\n";

        if ($definitions) {
            $tex .= "\\section*{Notation and definitions}\n\\begin{itemize}\n";
            foreach ($definitions as $symbol => $meanings) {
                $parts = [];
                foreach ($meanings as $meaning => $where) $parts[] = self::inline((string)$meaning) . (count($meanings) > 1 ? ' (' . implode(', ', array_map(fn($w) => self::ENVS[$kinds[$w]] . '~\ref{fact' . $w . '}', array_unique($where))) . ')' : '');
                $tex .= '\item ' . self::inline((string)$symbol, true) . ': ' . implode('; ', $parts) . "\n";
            }
            $tex .= "\\end{itemize}\n\n";
        }
        if ($cited) {
            $tex .= "\\section{Results from other works}\n\n";
            foreach ($ids as $id) if ($byId[$id]['basis'] === 'cited') $tex .= self::statement($id, $byId[$id], $kinds[$id], $rev[$id], $byId, $kinds, $cites[$id] ?? [], $base, $pid);
        }
        $tex .= "\\section{Proofs}\n\n";
        foreach ($ids as $id) if ($byId[$id]['basis'] !== 'cited') $tex .= self::statement($id, $byId[$id], $kinds[$id], $rev[$id], $byId, $kinds, $cites[$id] ?? [], $base, $pid);
        $bibText = implode("\n\n", array_merge(array_values($bib), array_values($docs)));
        if ($bibText !== '') $tex .= "\\bibliographystyle{plain}\n\\bibliography{refs}\n\n";
        $tex .= "\\end{document}\n";
        self::$names = [];
        $bibText .= $bibText === '' ? '' : "\n";
        return ['tex' => $tex, 'bib' => $bibText, 'title' => (string)$main['title'], 'facts' => $ids, 'models' => $models, 'sha256' => hash('sha256', $tex . "\0" . $bibText)];
    }

    private static function statement(int $id, array $f, string $kind, array $rev, array $byId, array $kinds, array $cites, string $base, int $pid): string
    {
        $refs = array_map(fn($c) => '\cite' . ($c['page'] ? '[p.~' . (int)$c['page'] . ']' : '') . '{' . $c['key'] . '}', $cites);
        if ($f['basis'] === 'cited' && !$refs) {
            foreach (json_decode((string)$rev['external_refs_json'], true) ?: [] as $x) $refs[] = self::text(is_array($x) ? (string)($x['text'] ?? $x['label'] ?? json_encode($x)) : (string)$x);
        }
        $name = self::inline((string)$f['title']);
        // Braces keep a citation's own [p.~3] inside the theorem's optional argument.
        $out = '\begin{' . $kind . '}[{' . $name . ($refs ? ', ' . implode('; ', $refs) : '') . '}]\label{fact' . $id . "}\n"
            . self::html((string)$rev['statement_html'], $byId, $kinds) . "\n\\end{" . $kind . "}\n";
        $link = $base !== '' ? '\href{' . str_replace(['#', '%'], ['\#', '\%'], $base) . '/\#/p/' . $pid . '/facts/' . $id . '}{fact ' . $id . '}' : 'fact ' . $id;
        if ($f['basis'] === 'cited') return $out . '\noindent\emph{Cited without proof; in the project: ' . $link . ".}\n\n";
        if (trim(strip_tags((string)$rev['proof_html'])) !== '') $out .= "\\begin{proof}\n" . self::html((string)$rev['proof_html'], $byId, $kinds) . "\n\\end{proof}\n";
        return $out . '\noindent\emph{' . ucfirst(self::CHECKED[$f['status']] ?? 'reviewed as correct') . '; in the project: ' . $link . ".}\n\n";
    }

    private static function count(int $n, string $what): string { return $n . ' ' . $what . ($n === 1 ? '' : 's'); }

    /** Rich text of a fact as LaTeX: formulas as written, text escaped, citations of other facts as references. */
    public static function html(string $html, array $byId = [], array $kinds = []): string
    {
        $doc = new \DOMDocument();
        @$doc->loadHTML('<?xml encoding="utf-8"?><div>' . $html . '</div>', LIBXML_NOERROR | LIBXML_NOWARNING | LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD);
        $root = $doc->getElementsByTagName('div')->item(0);
        $out = $root ? self::nodes($root, $byId, $kinds) : self::inline(strip_tags($html));
        $out = preg_replace("/\n{3,}/", "\n\n", trim($out)) ?? $out;
        return $out;
    }

    private static function nodes(\DOMNode $n, array $byId, array $kinds): string
    {
        // A formula may span several text nodes (x^<em>...</em> was once stored so): convert the text of a run of inline nodes together.
        $out = '';
        foreach ($n->childNodes as $c) $out .= self::node($c, $byId, $kinds);
        return $out;
    }

    private static function node(\DOMNode $c, array $byId, array $kinds): string
    {
        if ($c instanceof \DOMText) return self::inline($c->data);
        if (!$c instanceof \DOMElement) return '';
        $inner = fn() => self::nodes($c, $byId, $kinds);
        switch (strtolower($c->tagName)) {
            case 'p': case 'div': return "\n\n" . $inner() . "\n\n";
            case 'br': return "\\\\\n";
            case 'strong': case 'b': return '\textbf{' . $inner() . '}';
            case 'em': case 'i': return '\emph{' . $inner() . '}';
            case 'u': return '\underline{' . $inner() . '}';
            case 's': return $inner();
            case 'code': return '\texttt{' . self::text($c->textContent) . '}';
            case 'pre': return "\n\\begin{verbatim}\n" . str_replace('\end{verbatim}', '\end {verbatim}', $c->textContent) . "\n\\end{verbatim}\n";
            case 'ul': return "\n\\begin{itemize}\n" . $inner() . "\\end{itemize}\n";
            case 'ol': return "\n\\begin{enumerate}\n" . $inner() . "\\end{enumerate}\n";
            case 'li': return '\item ' . trim($inner()) . "\n";
            case 'blockquote': return "\n\\begin{quote}\n" . $inner() . "\n\\end{quote}\n";
            case 'h1': case 'h2': case 'h3': case 'h4': return "\n\n\\paragraph{" . $inner() . "}\n";
            case 'a':
                $href = $c->getAttribute('href');
                return preg_match('#^https?://#i', $href) ? '\href{' . str_replace(['\\', '#', '%', '{', '}'], ['', '\#', '\%', '', ''], $href) . '}{' . $inner() . '}' : $inner();
            case 'span':
                if (str_contains(' ' . $c->getAttribute('class') . ' ', ' mention ')) {
                    $id = (int)$c->getAttribute('data-id');
                    if ($c->getAttribute('data-type') === 'fact' && isset($kinds[$id])) return self::ENVS[$kinds[$id]] . '~\ref{fact' . $id . '}';
                    return self::text($c->getAttribute('data-label') ?: ltrim($c->textContent, '@'));
                }
                return $inner();
            default: return $inner();
        }
    }

    /** Plain text that may hold formulas ($...$, \(...\), \[...\], $$...$$): formulas kept, the rest escaped. */
    public static function inline(string $s, bool $symbol = false): string
    {
        // A notation symbol is a formula: \le_W, w_t(a), K, F'; a phrase ("left match") stays text.
        if ($symbol && !str_contains($s, '$') && (preg_match('/[\\\\^_{}]/', $s) || preg_match("/^[A-Za-z][A-Za-z0-9']{0,2}(\\(\\w+\\))?(,\\s*[A-Za-z][A-Za-z0-9']{0,2}(\\(\\w+\\))?)*$/u", $s))) {
            return implode(', ', array_map(fn($x) => '$' . self::math(trim($x)) . '$', preg_split('/,\s*(?![^(]*\))/', $s)));
        }
        $out = '';
        $pos = 0;
        preg_match_all('/\$\$.+?\$\$|\\\\\[.+?\\\\\]|\\\\\(.+?\\\\\)|(?<!\\\\)\$(?:\\\\.|[^$\\\\])+\$/s', $s, $m, PREG_OFFSET_CAPTURE);
        foreach ($m[0] as [$f, $at]) {
            $out .= self::text(substr($s, $pos, $at - $pos));
            $out .= self::math($f);
            $pos = $at + strlen($f);
        }
        return $out . self::text(substr($s, $pos));
    }

    private static function math(string $f): string
    {
        // A command followed by a letter needs a space: \in x, not \inx.
        return preg_replace_callback('/./u', fn($c) => isset(self::UNICODE[$c[0]]) ? self::UNICODE[$c[0]] . ' ' : $c[0], $f) ?? $f;
    }

    /** Text outside formulas: LaTeX's special characters escaped, symbols KaTeX reads typeset as formulas. */
    public static function text(string $s): string
    {
        // An escape the author already wrote (\$, \%, \_) stays one, and a name of a fact of the document becomes its reference.
        $kept = [];
        if (self::$names) {
            $names = self::$names; uksort($names, fn($a, $b) => strlen($b) <=> strlen($a));
            $s = preg_replace_callback('/(?<![\w:\/-])(' . implode('|', array_map(fn($n) => preg_quote($n, '/'), array_keys($names))) . ')(?![\w-])/u',
                function ($m) use (&$kept, $names) { $kept[] = $names[$m[1]]; return "\x01" . (count($kept) - 1) . "\x01"; }, $s) ?? $s;
        }
        $s = preg_replace_callback('/\\\\([$%&#_{}])/', function ($m) use (&$kept) { $kept[] = '\\' . $m[1]; return "\x01" . (count($kept) - 1) . "\x01"; }, $s) ?? $s;
        $s = strtr($s, ['\\' => '\textbackslash{}', '{' => '\{', '}' => '\}', '$' => '\$', '%' => '\%', '&' => '\&', '#' => '\#', '_' => '\_', '^' => '\^{}', '~' => '\~{}']);
        $s = strtr($s, ['\textbackslash\{\}' => '\textbackslash{}', '\^\{\}' => '\^{}', '\~\{\}' => '\~{}']);
        $s = strtr($s, self::TEXT_UNICODE);
        $s = preg_replace_callback('/./u', fn($c) => isset(self::UNICODE[$c[0]]) ? '$' . self::UNICODE[$c[0]] . '$' : $c[0], $s) ?? $s;
        return preg_replace_callback('/\x01(\d+)\x01/', fn($m) => $kept[(int)$m[1]], $s) ?? $s;
    }

    private static function bibText(string $s): string
    {
        return str_replace(['{', '}', '\\'], ['', '', ''], $s);
    }
}
