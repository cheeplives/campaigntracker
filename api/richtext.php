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
    'a' => ['href'], 'table' => [], 'thead' => [], 'tbody' => [], 'tr' => [], 'th' => [], 'td' => [], 'aside' => [],
];
/** A secret paragraph: GM only. rich_open() takes them out of whatever a player is sent. Never nested (rich_copy unwraps
 * an aside inside another), and an allowed element never carries attributes, so each one is exactly <aside>…</aside>. */
const RICH_SECRET_RE = '#<aside>.*?</aside>#su';
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

function rich_copy(DOMNode $from, DOMNode $to, DOMDocument $out, int $depth, bool $inSecret = false): void {
    foreach ($from->childNodes as $n) {
        if ($n instanceof DOMText) { $to->appendChild($out->createTextNode($n->nodeValue ?? '')); continue; }
        if (!$n instanceof DOMElement) continue;                  // comments, processing instructions
        $tag = strtolower($n->nodeName);
        if (in_array($tag, RICH_DROP, true)) continue;
        $tag = RICH_ALIAS[$tag] ?? $tag;
        if (!isset(RICH_TAGS[$tag]) || $depth >= RICH_MAX_DEPTH || ($tag === 'aside' && $inSecret)) { rich_copy($n, $to, $out, $depth, $inSecret); continue; }
        $e = $out->createElement($tag);
        if ($tag === 'a') {
            $href = rich_href($n->getAttribute('href'));
            if ($href === null) { rich_copy($n, $to, $out, $depth); continue; }
            $e->setAttribute('href', $href);
        }
        $to->appendChild($e);
        rich_copy($n, $e, $out, $depth + 1, $inSecret || $tag === 'aside');
    }
}

/** Plain text of stored rich text, for previews: one line per paragraph, list item or table row. */
function rich_html_plain(string $html): string {
    $t = preg_replace('#<br\s*/?>|</(p|h[1-6]|li|tr|pre|blockquote|div|aside)>|<(ul|ol|table)>#i', "\n", $html);
    $t = preg_replace('#<li>#i', '• ', $t);
    $t = preg_replace('#</t[dh]>#i', ' | ', $t);
    $t = html_entity_decode(strip_tags($t), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $t = preg_replace('/ \| *(\n|$)/', '$1', $t);
    return trim(preg_replace("/\n{2,}/", "\n", preg_replace('/[ \t]+\n/', "\n", $t)));
}

/** Stored rich text without its secret paragraphs: what a player may be sent. */
function rich_open(?string $html): string {
    return trim(preg_replace(RICH_SECRET_RE, '', (string)$html) ?? '');
}
/** Only the secret paragraphs of stored rich text ('' when there are none). */
function rich_secrets(?string $html): string {
    preg_match_all(RICH_SECRET_RE, (string)$html, $m);
    return implode('', $m[0]);
}
/** Rich text as $isGm may see it. */
function rich_for(?string $html, bool $isGm): ?string {
    return $isGm || $html === null ? $html : rich_open($html);
}
/** A day note as $isGm may see it: only rich text has secret paragraphs (plain text is shown as typed). */
function note_for(?string $text, ?string $format, bool $isGm): ?string {
    return $format === 'html' ? rich_for($text, $isGm) : $text;
}

/** A player's save of rich text they could only see without its secret paragraphs ($new, cleaned): the stored copy's
 * ($old) secret paragraphs are put back, each run after the paragraph it followed before (matched by its text), at the
 * start when it came first, or at the end when that paragraph is gone. Anything secret the player sent is dropped. */
function rich_keep_secrets(?string $old, string $new): string {
    $new = rich_open($new);
    if (rich_secrets($old) === '') return $new;
    $text = fn(DOMNode $n) => trim(preg_replace('/\s+/u', ' ', $n->textContent ?? '') ?? '');
    $groups = [];                                   // [anchor text or null, html of the run of secret paragraphs]
    $oldTop = rich_nodes((string)$old);
    $anchor = null;
    foreach ($oldTop['nodes'] as $n) {
        $html = $oldTop['doc']->saveHTML($n);
        if ($n instanceof DOMElement && strtolower($n->nodeName) === 'aside') {
            $last = array_key_last($groups);
            if ($last !== null && $groups[$last][2]) $groups[$last][1] .= $html;  // still the same run
            else $groups[] = [$anchor, $html, true];
            continue;
        }
        if ($groups) $groups[array_key_last($groups)][2] = false;
        if (preg_match(RICH_SECRET_RE, $html)) $groups[] = ['', rich_secrets($html), false]; // inside a list or table: kept at the end
        if ($text($n) !== '') $anchor = $text($n);
    }
    $out = '';
    $put = function (?string $after) use (&$groups, &$out) {
        foreach ($groups as $i => $g) if ($g[0] === $after) { $out .= $g[1]; unset($groups[$i]); }
    };
    $put(null);
    $newTop = rich_nodes($new);
    foreach ($newTop['nodes'] as $n) {
        $out .= $newTop['doc']->saveHTML($n);
        $t = $text($n);
        if ($t !== '') $put($t);
    }
    foreach ($groups as $g) $out .= $g[1];
    return $out;
}
/** The top-level nodes of stored (already clean) rich text, with the document that owns them. */
function rich_nodes(string $html): array {
    $doc = new DOMDocument();
    $prev = libxml_use_internal_errors(true);
    $doc->loadHTML('<?xml encoding="utf-8"?><body>' . $html . '</body>', LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING);
    libxml_clear_errors();
    libxml_use_internal_errors($prev);
    $body = $doc->getElementsByTagName('body')->item(0);
    return ['doc' => $doc, 'nodes' => $body ? iterator_to_array($body->childNodes) : []];
}

/** A day note as it is sent to the browser: rich text gets a plain copy for previews. */
function day_note_text(?string $text, ?string $format): string {
    return $format === 'html' ? rich_html_plain((string)$text) : (string)$text;
}
