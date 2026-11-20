<?php
declare(strict_types=1);

namespace App;

/**
 * Allow-list HTML sanitizer for rich text (Quill output).
 * Keeps basic formatting, links and @mention chips; strips everything else.
 */
final class Sanitizer
{
    private const TAGS = [
        'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'a', 'ul', 'ol', 'li', 'blockquote',
        'pre', 'code', 'h1', 'h2', 'h3', 'span', 'sub', 'sup',
    ];
    private const MENTION_TYPES = ['user', 'document', 'bib'];

    /** @return array{html:string, mentions:list<array{type:string,id:int}>, text:string} */
    public static function clean(string $html): array
    {
        $html = trim($html);
        if ($html === '') return ['html' => '', 'mentions' => [], 'text' => ''];

        $doc = new \DOMDocument();
        libxml_use_internal_errors(true);
        $doc->loadHTML('<?xml encoding="utf-8"?><div id="__root">' . $html . '</div>', LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD | LIBXML_NONET);
        libxml_clear_errors();
        $root = $doc->getElementById('__root') ?? $doc->documentElement;

        $mentions = [];
        self::walk($root, $doc, $mentions);

        $out = '';
        foreach ($root->childNodes as $child) $out .= $doc->saveHTML($child);
        $out = str_replace("\u{00A0}", ' ', $out);
        $out = str_replace('&nbsp;', ' ', $out);
        $text = trim(preg_replace('/\s+/u', ' ', html_entity_decode(strip_tags(str_replace(['</p>', '<br>'], [' </p>', ' <br>'], $out)), ENT_QUOTES | ENT_HTML5, 'UTF-8')));
        // Drop empty paragraphs at the end (Quill adds <p><br></p>).
        $out = preg_replace('#(<p><br></p>\s*)+$#', '', $out);
        return ['html' => $out, 'mentions' => array_values(array_unique($mentions, SORT_REGULAR)), 'text' => $text];
    }

    /**
     * Rich text from a request: either `body_html` (web UI) or `body_text` (agents).
     * Returns null when neither field was sent.
     */
    public static function fromRequest(Request $r, int $projectId): ?array
    {
        if ($r->input('body_html') !== null) return self::clean($r->str('body_html'));
        if ($r->input('body_text') !== null) return self::clean(self::textToHtml((string)$r->input('body_text'), $projectId));
        return null;
    }

    /**
     * Converts plain text to HTML. Supports blank-line paragraphs, line breaks,
     * **bold**, *italic*, `code`, and mentions written @{user:3}, @{document:5}, @{bib:2}
     * (or @{bib:citekey}). LaTeX ($...$) is left untouched and rendered by the browser.
     */
    public static function textToHtml(string $text, int $projectId): string
    {
        $text = str_replace(["\r\n", "\r"], "\n", trim($text));
        $html = '';
        foreach (preg_split('/\n\s*\n/', $text) as $para) {
            $p = htmlspecialchars($para, ENT_QUOTES | ENT_HTML5, 'UTF-8');
            $p = preg_replace('/`([^`\n]+)`/', '<code>$1</code>', $p);
            $p = preg_replace('/\*\*([^*\n]+)\*\*/', '<strong>$1</strong>', $p);
            $p = preg_replace('/(?<![*\w$\\\\])\*([^*\n$]+)\*(?![*\w])/', '<em>$1</em>', $p);
            $p = preg_replace_callback('/@\{(user|document|bib):([^}\s]+)\}/', fn($m) => self::mentionSpan($m[1], $m[2], $projectId), $p);
            $html .= '<p>' . nl2br($p, false) . '</p>';
        }
        return $html;
    }

    private static function mentionSpan(string $type, string $ref, int $projectId): string
    {
        $row = match ($type) {
            'user' => Db::one('SELECT u.id, u.name AS label FROM users u JOIN project_members pm ON pm.user_id = u.id AND pm.project_id = ? WHERE u.id = ?', [$projectId, (int)$ref]),
            'document' => Db::one('SELECT id, title AS label FROM documents WHERE project_id = ? AND id = ? AND deleted_at IS NULL', [$projectId, (int)$ref]),
            'bib' => ctype_digit($ref)
                ? Db::one('SELECT id, cite_key AS label FROM bib_entries WHERE project_id = ? AND id = ?', [$projectId, (int)$ref])
                : Db::one('SELECT id, cite_key AS label FROM bib_entries WHERE project_id = ? AND cite_key = ?', [$projectId, $ref]),
        };
        if (!$row) return '@{' . $type . ':' . htmlspecialchars($ref) . '}';
        $label = htmlspecialchars($row['label'], ENT_QUOTES | ENT_HTML5, 'UTF-8');
        return '<span class="mention" data-type="' . $type . '" data-id="' . (int)$row['id'] . '" data-label="' . $label . '">@' . $label . '</span>';
    }

    /** Plain-text rendering of stored rich text (for agents); mentions become @{type:id}. */
    public static function toText(string $html): string
    {
        $html = preg_replace('#<span class="mention" data-type="bib" data-id="\d+" data-label="([^"]*)">[^<]*</span>#', '@{bib:$1}', $html);
        $html = preg_replace('#<span class="mention" data-type="(\w+)" data-id="(\d+)"[^>]*>[^<]*</span>#', '@{$1:$2}', $html);
        $html = preg_replace('#<br\s*/?>#i', "\n", $html);
        $html = preg_replace('#</(p|li|h\d|blockquote|pre)>#i', "\n", $html);
        $html = preg_replace('#<li[^>]*>#i', '- ', $html);
        return trim(preg_replace("/\n{3,}/", "\n\n", html_entity_decode(strip_tags($html), ENT_QUOTES | ENT_HTML5, 'UTF-8')));
    }

    private static function walk(\DOMNode $node, \DOMDocument $doc, array &$mentions): void
    {
        for ($i = $node->childNodes->length - 1; $i >= 0; $i--) {
            $child = $node->childNodes->item($i);
            if ($child instanceof \DOMText) continue;
            if (!$child instanceof \DOMElement) { $node->removeChild($child); continue; }
            $tag = strtolower($child->tagName);

            if (!in_array($tag, self::TAGS, true)) {
                if (in_array($tag, ['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template'], true)) {
                    $node->removeChild($child);
                    continue;
                }
                // Unwrap unknown element (e.g. div) but keep its content.
                self::walk($child, $doc, $mentions);
                while ($child->firstChild) $node->insertBefore($child->firstChild, $child);
                $node->removeChild($child);
                continue;
            }

            // Mention chip: rebuild it entirely from trusted data.
            if ($tag === 'span' && preg_match('/\bmention\b/', $child->getAttribute('class'))) {
                $type = $child->getAttribute('data-type');
                $id = (int)$child->getAttribute('data-id');
                $label = $child->getAttribute('data-label') ?: ltrim($child->textContent, '@');
                if (in_array($type, self::MENTION_TYPES, true) && $id > 0) {
                    $span = $doc->createElement('span');
                    $span->setAttribute('class', 'mention');
                    $span->setAttribute('data-type', $type);
                    $span->setAttribute('data-id', (string)$id);
                    $span->setAttribute('data-label', mb_substr($label, 0, 200));
                    $span->appendChild($doc->createTextNode('@' . mb_substr($label, 0, 200)));
                    $node->replaceChild($span, $child);
                    $mentions[] = ['type' => $type, 'id' => $id];
                } else {
                    $node->replaceChild($doc->createTextNode($child->textContent), $child);
                }
                continue;
            }

            // Strip attributes except a small allow-list.
            $keep = [];
            if ($tag === 'a') {
                $href = trim($child->getAttribute('href'));
                if (preg_match('#^(https?://|mailto:)#i', $href)) $keep['href'] = $href;
            }
            $class = $child->getAttribute('class');
            if ($class && preg_match_all('/\bql-(indent-[1-8]|align-(center|right|justify))\b/', $class, $m)) {
                $keep['class'] = implode(' ', $m[0]);
            }
            if ($tag === 'li' && in_array($child->getAttribute('data-list'), ['bullet', 'ordered', 'checked', 'unchecked'], true)) {
                $keep['data-list'] = $child->getAttribute('data-list');
            }
            while ($child->attributes->length) $child->removeAttribute($child->attributes->item(0)->name);
            foreach ($keep as $k => $v) $child->setAttribute($k, $v);
            if ($tag === 'a') { $child->setAttribute('target', '_blank'); $child->setAttribute('rel', 'noopener noreferrer'); }

            self::walk($child, $doc, $mentions);
        }
    }
}
