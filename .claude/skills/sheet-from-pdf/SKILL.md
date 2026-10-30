---
name: sheet-from-pdf
description: Turn a character sheet PDF into a Campaign Chronicle sheet template (a starter file in db/starter-templates/), laid out like the PDF. Use when asked to make, convert or import a template from a character sheet PDF.
---

# A sheet template from a PDF

You turn one character sheet PDF into one starter template: `db/starter-templates/<key>.json`. The scripts in
`tools/sheet-agent/` read the PDF and draw your template; your job is the judgement in between: which boxes are
fields, what they are called, how wide each is, and how the sections sit, so the result looks and reads like the
sheet it came from, on a desktop and on a phone.

Needs: Node, and `npm ci` once in `tests/` (the scripts use the Playwright installed there). Work files go in a
scratch folder outside the repo, never in it.

## 1. Read the PDF

```
node tools/sheet-agent/extract.js <sheet.pdf> <work>
```

This writes `<work>/extract.json` and a picture of each page, `<work>/page-<n>.png`. **Look at every page picture
before you write anything.** In `extract.json`, for each page:

- `width`, `height`: the page in points (612 × 792 is US Letter). PDF y counts up from the bottom of the page.
- `fields`: the form fields of a fillable PDF: `name`, `type` (text, checkbox, radio, choice), `rect`
  [x0, y0, x1, y1], `multiline`, `options`, and hints: `cols` (the box's share of the page width, in the sheet's
  12 half-columns), `size` when a named size fits, and `tall` for a box over 40 points high.
- `texts`: every piece of text with its position and height. Labels are usually just above or left of their box.
- `rows`: field names that share a line, top to bottom.
- `gutters`: the x of each clear gap that splits the page into columns.
- `headings`: text clearly taller than the rest: likely section titles.

`draft` is the editor's own first guess (the same one Import from PDF makes); `from` says whether it came from form
fields or, for a flat PDF, from lines of text. Start from it, then fix it.

A flat PDF (no `fields`) has only `texts`: read the labels off the page picture and the text, and judge widths from
the picture, measuring the box against the page width.

## 2. Write the template

The file:

```json
{
 "name": "Game Name (Edition)",
 "game": "Game Name",
 "edition": "Edition",
 "source": { "title": "The sheet's title", "owner": "Its publisher", "url": "https://where/the/pdf/is", "licence": null },
 "layout": { "sections": [ ... ] }
}
```

The file name is the starter key: lower case, digits and dashes (`call-of-cthulhu-7e.json`). Look at two or three
files in `db/starter-templates/` and match them. The layout rules are in `static/sheetlayout.js` (its header
comment and `validate`); the ones that matter most here:

- **Sections** `{ key, title, fields, page?, width?, compact? }`. Keys are lower case with underscores, unique
  across the whole template, and permanent.
- **Fields** `{ key, label, type, size?, cols?, ... }`, `type` one of text, longtext, number, counter (current /
  max), pips (a row of dots or boxes, `count`), checkbox, choice (`options`), list (a table, `columns`).
- **Labels only.** Use the sheet's own field names and game terms. Never copy rules text, descriptions, flavour
  text or art. A label is 60 characters at most.

### Make it look like the sheet

- **Box widths.** Use the field's `cols` hint: 1 → `"size": "small"`, 2 → medium (leave size out), 4 →
  `"size": "large"`, 11 or 12 → `"size": "full"`, anything else → `"cols": n`. Round to what the sheet means, not
  to the point: a row of six equal stat boxes is six smalls, whatever they measure. Long text and lists always run
  the full width.
- **Rows.** Fields in one of `rows` belong together, in that order. Keep them in one section, in that order.
- **Sections.** A heading, a ruled box or a shaded band on the page is a section. Use the sheet's heading as the
  title, in title case.
- **Side by side.** Where `gutters` splits a page into two columns of sections, give those sections
  `"width": "half"` (three columns: `"third"`; a wide one beside a narrow one: `"two-thirds"` and `"third"`).
  Sections fill a line left to right in the order you list them, so list them in reading order across the line.
  On a phone every section takes the full width on its own.
- **Compact.** A long list of short entries, label then a small box (skills, saving throws), is
  `"compact": true`: the label sits beside its box, two or three to a line.
- **Pages.** A sheet over several PDF pages, or with clearly separate parts (a front, spells, gear, story), gets
  `"page": "<name>"` on its sections; the sheet shows each page as a tab. Every section on a page needs the same
  `page`, and a template has 20 pages at most. A one-page sheet has no pages.
- **Types.** A number box is `number`. Current and maximum together (hit points, sanity) is a `counter`. A row of
  circles or boxes to tick is `pips` with their `count`. A tick box alone is a `checkbox`. Radio buttons or a
  printed list of choices is a `choice`. A ruled table (weapons, gear, spells) is a `list` whose `columns` are the
  table's headings.
- **Summary.** Mark `"summary": true` on the two or three fields that say who a character is at a glance
  (class, level, career); `"play": true` on what changes during a session (hit points, stress, luck).

## 3. Check it, look at it, fix it

```
node tools/sheet-agent/check.js db/starter-templates/<key>.json
node tools/sheet-agent/preview.js db/starter-templates/<key>.json <work>/preview
```

`check.js` applies the starter test's rules. `preview.js` draws the template with the app's own CSS and code, one
picture per page at 1200 and 390 pixels wide, and lists problems: a sheet wider than the screen, a label cut
short, a box off the edge.

**Open the pictures and compare them with the PDF's pages**, side by side, section by section. Ask: are the same
fields there, in the same order, the same relative widths, grouped the same way? Fix the template and run both
again. Repeat until `check.js` says ok, `preview.js` says nothing looks wrong, and the pictures read like the PDF.
Three rounds is usual.

## 4. Record the source and finish

- The About page lists every starter template's source on its own, from the file's `source`. Set `licence` to
  the licence's name if the sheet is openly licensed (for example "CC BY 4.0"), otherwise `null`.
- A sheet that is not openly licensed (most are) also needs a row in `SOURCES-TO-LICENSE.md` (gitignored; at the
  repo root, with a copy in the project files folder), in its starter templates table, following the rows
  already there: the next number, the sheet and game, the owner, **No licence**, what was used (section and field
  labels, field types and order), the file, and status "To ask (or rely on fan policy)".
- Run the starter tests: `cd tests && npx playwright test browser/starter-templates.spec.js --project=chromium`.
- Say in the pull request that the new template reaches the site when an admin presses **Load starter templates**
  on the *Users* page, and that there is no database change.
