<?php
/**
 * Rich text (the day's Public and Secret notes): HTML from the word-processor editor, cleaned to a strict
 * allow-list before it is stored. static/richtext.js runs the same allow-list again before anything is shown,
 * so a note never carries a script, a style, an event handler, an image or a javascript: link.
 */
declare(strict_types=1);

/** Elements a note may keep, and the attributes each may carry. Everything else is unwrapped (its text kept). */
const RICH_TAGS = [
    'p' => [], 'br' => [], 'strong' => [], 'em' => [], 'u' => [], 's' => [], 'code' => [], 'pre' => [],
    'h1' => [], 'h2' => [], 'h3' => [], 'blockquote' => [], 'ul' => [], 'ol' => [], 'li' => [], 'hr' => [],
    'a' => ['href'], 'table' => [], 'thead' => [], 'tbody' => [], 'tr' => [], 'th' => [], 'td' => [],
];
/** The editor's and the browser's spellings of the same thing. */
const RICH_ALIAS = ['b' => 'strong', 'i' => 'em', 'strike' => 's', 'del' => 's', 'h4' => 'h3', 'h5' => 'h3', 'h6' => 'h3', 'div' => 'p'];
/** Dropped with everything inside them, not just unwrapped. */
const RICH_DROP = ['script', 'style', 'template', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'svg', 'math',
    'head', 'title', 'meta', 'link', 'base', 'textarea', 'select', 'option', 'button', 'input', 'form', 'img', 'picture', 'video', 'audio',
    'source', 'track', 'canvas', 'map', 'area'];
const RICH_MAX_DEPTH = 24;

/** A safe href, or null: http(s) and mailto only. */
function rich_href(string $href): ?string {
    $h = trim(preg_replace('/[\x00-\x20\x7f]+/u', '', $href) ?? '');
    return preg_match('#^(https?://|mailto:)#i', $h) && mb_strlen($h) <= 2000 ? $h : null;
}

/** Clean editor HTML to the allow-list. Returns '' for a note with no text and no table. */
function rich_html_clean(string $html): string {
    if (trim($html) === '') return '';
    $src = new DOMDocument();
    $prev = libxml_use_internal_errors(true);
    // The XML declaration makes libxml read the text as UTF-8; LIBXML_NONET keeps it off the network.
    $src->loadHTML('<?xml encoding="utf-8"?><body>' . $html . '</body>', LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING);
    libxml_clear_errors();
    libxml_use_internal_errors($prev);
    $out = new DOMDocument('1.0', 'UTF-8');
    $root = $out->createElement('div');
    $out->appendChild($root);
    $body = $src->getElementsByTagName('body')->item(0);
    if ($body) rich_copy($body, $root, $out, 0);
    $res = '';
    foreach ($root->childNodes as $n) $res .= $out->saveHTML($n);
    // The editor writes runs of spaces as &nbsp;, which would stop lines wrapping.
    $res = str_replace(["\u{00A0}", '&nbsp;'], ' ', $res);
    return rich_html_plain($res) === '' && stripos($res, '<table') === false ? '' : $res;
}

function rich_copy(DOMNode $from, DOMNode $to, DOMDocument $out, int $depth): void {
    foreach ($from->childNodes as $n) {
        if ($n instanceof DOMText) { $to->appendChild($out->createTextNode($n->nodeValue ?? '')); continue; }
        if (!$n instanceof DOMElement) continue;                  // comments, processing instructions
        $tag = strtolower($n->nodeName);
        if (in_array($tag, RICH_DROP, true)) continue;
        $tag = RICH_ALIAS[$tag] ?? $tag;
        if (!isset(RICH_TAGS[$tag]) || $depth >= RICH_MAX_DEPTH) { rich_copy($n, $to, $out, $depth); continue; }
        $e = $out->createElement($tag);
        if ($tag === 'a') {
            $href = rich_href($n->getAttribute('href'));
            if ($href === null) { rich_copy($n, $to, $out, $depth); continue; }
            $e->setAttribute('href', $href);
        }
        $to->appendChild($e);
        rich_copy($n, $e, $out, $depth + 1);
    }
}

/** Plain text of stored rich text, for previews: one line per paragraph, list item or table row. */
function rich_html_plain(string $html): string {
    $t = preg_replace('#<br\s*/?>|</(p|h[1-6]|li|tr|pre|blockquote|div)>|<(ul|ol|table)>#i', "\n", $html);
    $t = preg_replace('#<li>#i', '• ', $t);
    $t = preg_replace('#</t[dh]>#i', ' | ', $t);
    $t = html_entity_decode(strip_tags($t), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $t = preg_replace('/ \| *(\n|$)/', '$1', $t);
    return trim(preg_replace("/\n{2,}/", "\n", preg_replace('/[ \t]+\n/', "\n", $t)));
}

/** A day note as it is sent to the browser: rich text gets a plain copy for previews. */
function day_note_text(?string $text, ?string $format): string {
    return $format === 'html' ? rich_html_plain((string)$text) : (string)$text;
}
