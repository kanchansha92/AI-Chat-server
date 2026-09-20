// ─── PDF export (assistant replies -> a real document) ────────────────────────
// The general-chat assistant writes documents as text - notes, guides, cheat
// sheets, interview question banks. This turns one of those replies into a PDF
// the user can actually keep.
//
// It is deliberately its own small markdown subset rather than a dependency on
// a markdown->HTML->PDF chain: the assistant only ever emits headings, bullet
// and numbered lists, code fences, block quotes, rules, and paragraphs with
// bold/italic/code spans (see components/Markdown.tsx on the client, which
// parses the same subset). Anything unrecognised falls through as a paragraph,
// so a stray syntax never loses the user's content.
//
// Requires pdfkit:  npm install pdfkit
//
// The require is deliberately lazy. A top-level require of a missing module
// throws while the module graph is still loading, which takes down the whole
// server at boot - every route, not just this one - over an optional export
// feature. Resolving it on first use instead means the app always starts, and
// a missing install shows up as a clear error on the one endpoint that needs
// it. Cached after the first successful load, so this costs nothing per call.

let PDFDocument = null;

function loadPdfKit() {
  if (PDFDocument) return PDFDocument;
  try {
    // eslint-disable-next-line global-require
    PDFDocument = require('pdfkit');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      const e = new Error(
        'pdfkit is not installed - run "npm install" in the backend folder to enable PDF export.'
      );
      e.code = 'PDF_DEPENDENCY_MISSING';
      throw e;
    }
    throw err;
  }
  return PDFDocument;
}

/** Is PDF export actually available in this install? */
function hasPdfSupport() {
  try {
    loadPdfKit();
    return true;
  } catch {
    return false;
  }
}

// Page furniture, in points (72pt = 1in).
const MARGIN = 56;
const BODY_SIZE = 10.5;
const LINE_GAP = 3;

// The warm, low-contrast palette the rest of the product uses, so an exported
// document still looks like it came from ember.
const INK = '#2f2a26';
const INK_SOFT = '#5c534b';
const RUST = '#a8543a';
const RULE = '#e0d8d0';
const CODE_BG = '#f5f1ec';

const HEADING_SIZE = { 1: 19, 2: 15, 3: 12.5, 4: 11, 5: 11, 6: 11 };

/**
 * Split inline markdown into styled runs. Handles `code`, **bold**, *italic*,
 * __bold__, _italic_, and [label](url) (rendered as its label, since a PDF
 * reader can't be trusted with an invented link). Unmatched markers stay as
 * literal text rather than being swallowed.
 * @param {string} src
 * @returns {Array<{text: string, bold?: boolean, italic?: boolean, code?: boolean}>}
 */
function inlineRuns(src) {
  const runs = [];
  const re = /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\n]+?)\*|_([^_\n]+?)_|\[([^\]]*)\]\([^)]*\)/g;
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) runs.push({ text: src.slice(last, m.index) });
    if (m[2] !== undefined) runs.push({ text: m[2].trim(), code: true });
    else if (m[3] !== undefined) runs.push({ text: m[3], bold: true });
    else if (m[4] !== undefined) runs.push({ text: m[4], bold: true });
    else if (m[5] !== undefined) runs.push({ text: m[5], italic: true });
    else if (m[6] !== undefined) runs.push({ text: m[6], italic: true });
    else if (m[7] !== undefined) runs.push({ text: m[7] });
    last = re.lastIndex;
  }
  if (last < src.length) runs.push({ text: src.slice(last) });
  return runs.filter((r) => r.text !== '');
}

function fontFor(run) {
  if (run.code) return 'Courier';
  if (run.bold && run.italic) return 'Helvetica-BoldOblique';
  if (run.bold) return 'Helvetica-Bold';
  if (run.italic) return 'Helvetica-Oblique';
  return 'Helvetica';
}

/**
 * Write one paragraph of inline-formatted text at the current cursor, honouring
 * an optional left indent. Uses pdfkit's `continued` runs so bold/code stay
 * inline instead of each starting a new line.
 */
function writeRuns(doc, runs, opts = {}) {
  const { indent = 0, size = BODY_SIZE, color = INK, gap = LINE_GAP } = opts;
  if (!runs.length) return;
  const width = doc.page.width - MARGIN * 2 - indent;
  const x = MARGIN + indent;
  doc.x = x;
  runs.forEach((run, i) => {
    const isLast = i === runs.length - 1;
    doc
      .font(fontFor(run))
      .fontSize(run.code ? size - 0.5 : size)
      .fillColor(run.code ? RUST : color)
      .text(run.text, doc.x, doc.y, {
        width,
        align: 'left',
        lineGap: gap,
        continued: !isLast,
      });
  });
  doc.x = MARGIN;
}

/** Room left on the page - used to avoid orphaning a heading at the bottom. */
function spaceLeft(doc) {
  return doc.page.height - MARGIN - doc.y;
}

/**
 * Parse `src` (the assistant's reply) and draw it into `doc`.
 * Block types: ATX headings, fenced code, `>` quotes, `-`/`*`/`+` bullets,
 * `1.` ordered items, `---` rules, and paragraphs.
 */
function renderMarkdown(doc, src) {
  const lines = String(src || '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  let i = 0;
  let para = [];

  const flushParagraph = () => {
    if (!para.length) return;
    writeRuns(doc, inlineRuns(para.join(' ')));
    doc.moveDown(0.55);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    // blank line - paragraph break
    if (!line.trim()) {
      flushParagraph();
      i++;
      continue;
    }

    // fenced code block
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})\s*[\w+#.-]*\s*$/);
    if (fence) {
      flushParagraph();
      const marker = fence[1][0];
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${marker}{3,}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence
      drawCodeBlock(doc, body);
      continue;
    }

    // horizontal rule
    if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line)) {
      flushParagraph();
      doc.moveDown(0.2);
      doc
        .strokeColor(RULE)
        .lineWidth(0.75)
        .moveTo(MARGIN, doc.y)
        .lineTo(doc.page.width - MARGIN, doc.y)
        .stroke();
      doc.moveDown(0.6);
      i++;
      continue;
    }

    // heading
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const size = HEADING_SIZE[level] || 11;
      // don't strand a heading in the last inch of a page
      if (spaceLeft(doc) < size * 4) doc.addPage();
      doc.moveDown(level <= 2 ? 0.5 : 0.35);
      writeRuns(doc, [{ text: heading[2].trim(), bold: true }], {
        size,
        color: level <= 2 ? RUST : INK,
        gap: 1,
      });
      if (level <= 2) {
        doc
          .strokeColor(RULE)
          .lineWidth(0.75)
          .moveTo(MARGIN, doc.y + 2)
          .lineTo(doc.page.width - MARGIN, doc.y + 2)
          .stroke();
        doc.moveDown(0.45);
      } else {
        doc.moveDown(0.3);
      }
      i++;
      continue;
    }

    // block quote
    const quote = line.match(/^\s{0,3}>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      const body = [quote[1]];
      i++;
      while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i++;
      }
      const top = doc.y;
      writeRuns(doc, inlineRuns(body.join(' ')), { indent: 16, color: INK_SOFT });
      doc
        .strokeColor(RUST)
        .lineWidth(2)
        .moveTo(MARGIN + 4, top)
        .lineTo(MARGIN + 4, doc.y - 2)
        .stroke();
      doc.moveDown(0.5);
      continue;
    }

    // list item (bulleted or numbered) - consecutive items stay tight
    const item = line.match(/^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/);
    if (item) {
      flushParagraph();
      while (i < lines.length) {
        const it = lines[i].match(/^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/);
        if (!it) break;
        const depth = Math.min(Math.floor(it[1].length / 2), 3);
        const marker = it[2] ? '•' : `${it[3]}.`;
        const indent = 12 + depth * 14;
        const y = doc.y;
        doc
          .font('Helvetica')
          .fontSize(BODY_SIZE)
          .fillColor(RUST)
          .text(marker, MARGIN + indent - 12, y, { width: 14, lineGap: LINE_GAP });
        doc.y = y;
        writeRuns(doc, inlineRuns(it[4]), { indent: indent + 4 });
        doc.moveDown(0.18);
        i++;
      }
      doc.moveDown(0.35);
      continue;
    }

    // ordinary paragraph line
    para.push(line.trim());
    i++;
  }

  flushParagraph();
}

/** A code block on a tinted panel, wrapped rather than clipped. */
function drawCodeBlock(doc, body) {
  const text = body.join('\n') || ' ';
  const width = doc.page.width - MARGIN * 2;
  const pad = 8;
  doc.font('Courier').fontSize(BODY_SIZE - 1);
  const height = doc.heightOfString(text, { width: width - pad * 2, lineGap: 2 }) + pad * 2;

  // a block taller than a page can't be boxed in one piece - let it flow
  if (height < doc.page.height - MARGIN * 2 && spaceLeft(doc) < height) doc.addPage();

  const top = doc.y;
  doc.save().rect(MARGIN, top, width, height).fill(CODE_BG).restore();
  doc
    .fillColor(INK)
    .text(text, MARGIN + pad, top + pad, { width: width - pad * 2, lineGap: 2 });
  doc.y = Math.max(doc.y, top + height);
  doc.x = MARGIN;
  doc.moveDown(0.6);
}

/**
 * Footer: a page number on every page, added once the body is laid out.
 *
 * The footer sits inside the bottom margin, and pdfkit treats any write below
 * the margin box as content that overflows - which silently appends a fresh
 * page per footer and doubles the document. Zeroing the bottom margin for the
 * duration of the write keeps each footer on the page it belongs to. The page
 * count is also read once up front, so it can't grow while we loop over it.
 */
function addPageNumbers(doc) {
  const range = doc.bufferedPageRange();
  const total = range.count;
  for (let p = range.start; p < range.start + total; p++) {
    doc.switchToPage(p);
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(INK_SOFT)
      .text(`${p - range.start + 1} of ${total}`, MARGIN, doc.page.height - MARGIN + 16, {
        width: doc.page.width - MARGIN * 2,
        align: 'center',
        lineBreak: false,
      });
    doc.page.margins.bottom = saved;
  }
}

/**
 * The document title is usually taken from the content's own first heading
 * (titleFromContent), which would then print twice - once in the title block
 * and again as the first heading. Drop the heading when it says the same thing.
 */
function dropRedundantHeading(content, title) {
  const src = String(content || '');
  const norm = (s) =>
    String(s || '')
      .replace(/[*_`#>…]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  const lines = src.split('\n');
  const first = lines.findIndex((l) => l.trim());
  if (first < 0) return src;
  const heading = lines[first].match(/^\s{0,3}#{1,6}\s+(.+)$/);
  if (!heading) return src;
  const a = norm(heading[1]);
  const b = norm(title);
  // the title may have been truncated with an ellipsis, so compare by prefix
  if (!a || !b || !(a === b || a.startsWith(b) || b.startsWith(a))) return src;
  return lines.slice(first + 1).join('\n').replace(/^\n+/, '');
}

/**
 * Render `content` as a PDF and resolve with the finished Buffer.
 *
 * Buffered rather than streamed straight to the response so that page numbers
 * (which need the final page count) can be written after layout, and so a
 * mid-render failure rejects cleanly instead of leaving the client holding a
 * truncated download.
 *
 * @param {{title?: string, content: string, subtitle?: string}} opts
 * @returns {Promise<Buffer>}
 */
function renderPdf({ title = 'Document', content = '', subtitle = '' } = {}) {
  return new Promise((resolve, reject) => {
    try {
      const PdfDoc = loadPdfKit();
      const doc = new PdfDoc({
        size: 'A4',
        margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
        bufferPages: true,
        info: { Title: title, Creator: 'privateaile', Producer: 'privateaile' },
      });

      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // title block
      doc
        .font('Helvetica-Bold')
        .fontSize(22)
        .fillColor(INK)
        .text(title, { width: doc.page.width - MARGIN * 2, lineGap: 2 });
      if (subtitle) {
        doc.moveDown(0.25);
        doc.font('Helvetica').fontSize(10).fillColor(INK_SOFT).text(subtitle);
      }
      doc.moveDown(0.4);
      doc
        .strokeColor(RUST)
        .lineWidth(1.5)
        .moveTo(MARGIN, doc.y)
        .lineTo(MARGIN + 54, doc.y)
        .stroke();
      doc.moveDown(0.9);
      doc.x = MARGIN;

      renderMarkdown(doc, dropRedundantHeading(content, title));
      addPageNumbers(doc);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * A safe, readable filename for the download, derived from the title.
 * Falls back to "document" when the title has nothing usable (e.g. all emoji or
 * a non-Latin script), so the browser never gets an empty name.
 */
function pdfFilename(title) {
  const base = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base || 'document'}.pdf`;
}

/**
 * A short document title taken from the content's first heading, or the user's
 * question when there is no heading.
 */
function titleFromContent(content, fallback = 'Document') {
  const src = String(content || '');
  const heading = src.match(/^\s{0,3}#{1,6}\s+(.+)$/m);
  const raw = (heading ? heading[1] : (src.split('\n').find((l) => l.trim()) || '')).trim();
  const clean = raw
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return fallback;
  return clean.length > 80 ? `${clean.slice(0, 78).trimEnd()}…` : clean;
}

module.exports = {
  renderPdf,
  pdfFilename,
  titleFromContent,
  hasPdfSupport,
};
