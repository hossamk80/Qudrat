// Reads a .xlsx into rows of strings, with no dependencies: unzips with zlib and walks the XML.
// Shared with the import tooling so a sheet can be read the same way on the server as in the page.
const fs = require('node:fs'), zlib = require('node:zlib');

function entries(buf) {
  const out = new Map();
  // walk the central directory from the end-of-central-directory record
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw Error('not a zip file');
  let at = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) break;
    const method = buf.readUInt16LE(at + 10);
    const compSize = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localAt + 26);
    const lExtraLen = buf.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataAt, dataAt + compSize);
    out.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// Writers differ in how they escape. This sheet encodes every Arabic letter as a numeric
// character reference (&#1576;), which a named-entity-only decoder leaves as literal text and no
// header would then ever match. Numeric references are decoded first, &amp; last so a decoded
// value cannot be re-decoded.
const unescapeXml = s => s
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const textOf = frag => {
  let s = '';
  for (const m of frag.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)) s += m[1];
  return unescapeXml(s);
};
const colIndex = ref => {
  let n = 0;
  for (const ch of String(ref).replace(/[^A-Z]/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

function readRows(file) {
  const zip = entries(fs.readFileSync(file));
  const sheetName = [...zip.keys()].find(k => /^xl\/worksheets\/sheet1\.xml$/.test(k))
    || [...zip.keys()].find(k => /^xl\/worksheets\/.*\.xml$/.test(k));
  if (!sheetName) throw Error('no worksheet found');
  let shared = [];
  if (zip.has('xl/sharedStrings.xml')) {
    const xml = zip.get('xl/sharedStrings.xml').toString('utf8');
    shared = [...xml.matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)].map(m => textOf(m[1]));
  }
  const sheet = zip.get(sheetName).toString('utf8');
  const rows = [];
  for (const rm of sheet.matchAll(/<(?:\w+:)?row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    const cells = [];
    for (const cm of rm[2].matchAll(/<(?:\w+:)?c\s[^>]*r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/(?:\w+:)?c>/g)) {
      const attrs = cm[2], body = cm[3];
      let v = '';
      if (/t="s"/.test(attrs)) {
        const n = (body.match(/<(?:\w+:)?v>(\d+)<\/(?:\w+:)?v>/) || [])[1];
        v = n !== undefined ? (shared[Number(n)] ?? '') : '';
      } else if (/t="inlineStr"/.test(attrs)) v = textOf(body);
      else {
        const m = body.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/);
        v = m ? unescapeXml(m[1]) : '';
      }
      cells[colIndex(cm[1])] = v;
    }
    rows[Number(rm[1]) - 1] = Array.from({ length: cells.length }, (_, i) => cells[i] ?? '');
  }
  return Array.from({ length: rows.length }, (_, i) => rows[i] ?? []);
}

module.exports = { readRows };
