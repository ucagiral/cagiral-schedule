// Minimal .xlsx reader and writer, with no dependencies.
//
// The rest of this repository ships no build step and no libraries, and an .xlsx is
// only a zip of XML files, so both halves are reachable from plain JS:
//   reading  -- walk the zip central directory by hand, inflate with the platform's
//               DecompressionStream("deflate-raw") (Safari/iOS 16.4+, node 18+);
//   writing  -- emit the XML and zip it with method 0 (stored). A valid zip needs no
//               compressor, only a CRC-32, and Excel, Numbers and openpyxl all open
//               stored zips quite happily.
//
// Deliberately a plain script rather than a module, for the same reason as
// cellstocks/engine.js: the app loads it with a <script> tag and
// tools/cellstocks-selftest.mjs evaluates this same file in node. One copy, tested
// where it runs.
//
// This file moves bytes and nothing else. Every rule about what a cell MEANS -- which
// column is a passage, whether a date is ambiguous -- lives in engine.js.
(function (root) {
  "use strict";

  // =====================================================================
  // Bytes
  // =====================================================================

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function utf8(str) { return new TextEncoder().encode(str); }
  function fromUtf8(bytes) { return new TextDecoder("utf-8").decode(bytes); }

  // =====================================================================
  // Zip: read
  // =====================================================================

  // The End Of Central Directory record sits at the very end of the file, after a
  // comment of up to 65535 bytes. Scan backwards for its signature.
  function findEOCD(b) {
    var max = Math.min(b.length, 65557);
    for (var i = b.length - 22; i >= b.length - max; i--) {
      if (i >= 0 && u32(b, i) === 0x06054b50) return i;
    }
    return -1;
  }

  function zipEntries(b) {
    var eocd = findEOCD(b);
    if (eocd < 0) throw new Error("Not a zip file (no end-of-central-directory record).");
    var count = u16(b, eocd + 10);
    var offset = u32(b, eocd + 16);
    var entries = {};
    var p = offset;
    for (var i = 0; i < count; i++) {
      if (u32(b, p) !== 0x02014b50) throw new Error("Corrupt zip: bad central directory entry.");
      var method = u16(b, p + 10);
      var compSize = u32(b, p + 20);
      var size = u32(b, p + 24);
      var nameLen = u16(b, p + 28);
      var extraLen = u16(b, p + 30);
      var commentLen = u16(b, p + 32);
      var localOffset = u32(b, p + 42);
      var name = fromUtf8(b.subarray(p + 46, p + 46 + nameLen));
      entries[name] = { name: name, method: method, compSize: compSize, size: size, localOffset: localOffset };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  function inflateRaw(bytes) {
    if (typeof DecompressionStream !== "function") {
      return Promise.reject(new Error(
        "This browser cannot unzip .xlsx files (DecompressionStream is missing). " +
        "Safari 16.4 / iOS 16.4 or newer is needed."));
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Response(stream).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  function readEntry(b, entry) {
    var lo = entry.localOffset;
    if (u32(b, lo) !== 0x04034b50) throw new Error("Corrupt zip: bad local header for " + entry.name);
    var nameLen = u16(b, lo + 26);
    var extraLen = u16(b, lo + 28);
    var start = lo + 30 + nameLen + extraLen;
    var data = b.subarray(start, start + entry.compSize);
    if (entry.method === 0) return Promise.resolve(data);
    if (entry.method === 8) return inflateRaw(data);
    return Promise.reject(new Error("Unsupported zip compression method " + entry.method + " in " + entry.name));
  }

  // =====================================================================
  // Zip: write (stored, no compression)
  // =====================================================================

  function concat(chunks) {
    var total = 0, i;
    for (i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Uint8Array(total), at = 0;
    for (i = 0; i < chunks.length; i++) { out.set(chunks[i], at); at += chunks[i].length; }
    return out;
  }

  function put32(arr, o, v) { arr[o] = v & 255; arr[o + 1] = (v >>> 8) & 255; arr[o + 2] = (v >>> 16) & 255; arr[o + 3] = (v >>> 24) & 255; }
  function put16(arr, o, v) { arr[o] = v & 255; arr[o + 1] = (v >>> 8) & 255; }

  function zipStore(files) {
    // files: [{ name, bytes }]. Stored (method 0), no data descriptors, no zip64 --
    // a cell inventory is kilobytes, not gigabytes.
    var local = [], central = [], offset = 0, i;
    for (i = 0; i < files.length; i++) {
      var nameBytes = utf8(files[i].name);
      var data = files[i].bytes;
      var crc = crc32(data);

      var lh = new Uint8Array(30 + nameBytes.length);
      put32(lh, 0, 0x04034b50);
      put16(lh, 4, 20);            // version needed
      put16(lh, 6, 0x0800);        // flags: UTF-8 names
      put16(lh, 8, 0);             // method: stored
      put16(lh, 10, 0); put16(lh, 12, 0);   // mod time/date: fixed, so output is deterministic
      put32(lh, 14, crc);
      put32(lh, 18, data.length);
      put32(lh, 22, data.length);
      put16(lh, 26, nameBytes.length);
      put16(lh, 28, 0);
      lh.set(nameBytes, 30);
      local.push(lh, data);

      var ch = new Uint8Array(46 + nameBytes.length);
      put32(ch, 0, 0x02014b50);
      put16(ch, 4, 20); put16(ch, 6, 20);
      put16(ch, 8, 0x0800);
      put16(ch, 10, 0);
      put16(ch, 12, 0); put16(ch, 14, 0);
      put32(ch, 16, crc);
      put32(ch, 20, data.length);
      put32(ch, 24, data.length);
      put16(ch, 28, nameBytes.length);
      put16(ch, 30, 0); put16(ch, 32, 0); put16(ch, 34, 0);
      put16(ch, 36, 0); put32(ch, 38, 0);
      put32(ch, 42, offset);
      ch.set(nameBytes, 46);
      central.push(ch);

      offset += lh.length + data.length;
    }
    var centralBytes = concat(central);
    var eocd = new Uint8Array(22);
    put32(eocd, 0, 0x06054b50);
    put16(eocd, 8, files.length);
    put16(eocd, 10, files.length);
    put32(eocd, 12, centralBytes.length);
    put32(eocd, 16, offset);
    return concat([concat(local), centralBytes, eocd]);
  }

  // =====================================================================
  // XML
  // =====================================================================

  function unescapeXml(s) {
    if (s.indexOf("&") === -1) return s;
    return s.replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
            .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(parseInt(d, 10)); })
            .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
            .replace(/&amp;/g, "&");
  }

  function escapeXml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c];
    // Control characters are illegal in XML 1.0 and Excel refuses the file outright.
    }).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  }

  function attrs(tag) {
    var out = {}, re = /([\w:.-]+)\s*=\s*"([^"]*)"/g, m;
    while ((m = re.exec(tag))) out[m[1]] = unescapeXml(m[2]);
    return out;
  }

  // =====================================================================
  // Workbook parts
  // =====================================================================

  function parseSharedStrings(xml) {
    var out = [], re = /<si>([\s\S]*?)<\/si>|<si\s*\/>/g, m;
    while ((m = re.exec(xml))) {
      if (m[1] === undefined) { out.push(""); continue; }
      // Rich text splits one string across several <r><t> runs; join them back.
      var txt = "", tre = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g, tm;
      while ((tm = tre.exec(m[1]))) txt += tm[1] === undefined ? "" : unescapeXml(tm[1]);
      out.push(txt);
    }
    return out;
  }

  // Builtin number formats that mean a date or a time. Anything at 164 or above is
  // custom and has to be judged from its format code.
  var BUILTIN_DATE_FORMATS = {
    14: "m/d/yyyy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM",
    19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "m/d/yyyy h:mm",
    45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0"
  };

  function parseStyles(xml) {
    var fmts = {}, re = /<numFmt\b[^>]*\/>/g, m;
    while ((m = re.exec(xml))) {
      var a = attrs(m[0]);
      if (a.numFmtId !== undefined) fmts[a.numFmtId] = a.formatCode || "";
    }
    var xfs = [];
    var block = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
    if (block) {
      var xre = /<xf\b[^>]*?(?:\/>|>)/g, xm;
      while ((xm = xre.exec(block[1]))) xfs.push(attrs(xm[0]).numFmtId || "0");
    }
    return { fmts: fmts, xfs: xfs };
  }

  function formatCodeFor(styles, styleIndex) {
    if (styleIndex === undefined || styleIndex === null || styleIndex === "") return { id: 0, code: "" };
    var id = styles.xfs[Number(styleIndex)];
    if (id === undefined) return { id: 0, code: "" };
    var n = Number(id);
    var code = styles.fmts[id] !== undefined ? styles.fmts[id] : (BUILTIN_DATE_FORMATS[n] || "");
    return { id: n, code: code };
  }

  function isDateFormat(fmt) {
    if (BUILTIN_DATE_FORMATS[fmt.id] !== undefined) return true;
    if (!fmt.code) return false;
    // Strip the bits of a format code that can contain letters without meaning a date:
    // [Red], "literal text", and escaped characters.
    var s = fmt.code.replace(/\[[^\]]*\]/g, "").replace(/"[^"]*"/g, "").replace(/\\./g, "");
    return /[dy]/i.test(s) && /[dmy]/i.test(s);
  }

  var MONTHS = ["January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"];

  // Excel serial -> UTC date. Serial 1 is 1900-01-01, and Excel believes 1900 was a
  // leap year, so everything at or below serial 60 sits one day behind the real
  // calendar. Modern dates are all far above that, but get it right anyway.
  function serialToDate(serial) {
    var s = serial < 61 ? serial + 1 : serial;
    return new Date(Math.round((s - 25569) * 86400000));
  }

  function pad(n, w) { var s = String(n); while (s.length < w) s = "0" + s; return s; }

  function isoDate(d) {
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1, 2) + "-" + pad(d.getUTCDate(), 2);
  }

  // Render a date the way the sheet renders it, so "what the cell displays" can be
  // captured verbatim. Handles the date tokens only -- these are inventory dates, not
  // timesheets, and a wrong guess about "m" meaning minutes would be worse than a
  // plain ISO fallback.
  function formatDate(d, code) {
    if (!code || /[hs]/i.test(code.replace(/\[[^\]]*\]/g, "").replace(/"[^"]*"/g, ""))) return isoDate(d);
    var y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1, day = d.getUTCDate();
    return code.replace(/\[[^\]]*\]/g, "").replace(/;.*$/, "")
      .replace(/(yyyy|yy|mmmmm|mmmm|mmm|mm|m|dddd|ddd|dd|d)/gi, function (t) {
        switch (t.toLowerCase()) {
          case "yyyy": return String(y);
          case "yy": return pad(y % 100, 2);
          case "mmmmm": return MONTHS[mo - 1].charAt(0);
          case "mmmm": return MONTHS[mo - 1];
          case "mmm": return MONTHS[mo - 1].slice(0, 3);
          case "mm": return pad(mo, 2);
          case "m": return String(mo);
          case "dddd": case "ddd": return t; // weekday names: not worth the table
          case "dd": return pad(day, 2);
          case "d": return String(day);
        }
        return t;
      }).trim();
  }

  function colIndex(ref) {
    var n = 0;
    for (var i = 0; i < ref.length; i++) {
      var c = ref.charCodeAt(i);
      if (c < 65 || c > 90) break;
      n = n * 26 + (c - 64);
    }
    return n - 1;
  }

  function colName(index) {
    var s = "", n = index + 1;
    while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  var EMPTY = { value: null, text: "", formula: null, isDate: false, iso: null, type: null };

  function parseSheet(xml, shared, styles) {
    // Shared formulas store their text once, on the master cell, and every other cell
    // in the range points at it by index. Without resolving these, most of a
    // formula-filled column looks empty.
    var sharedFormulas = {};
    var rows = [];
    var rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g, rm;
    while ((rm = rowRe.exec(xml))) {
      var rowAttrs = attrs(rm[1] !== undefined ? rm[1] : rm[3]);
      var rowNum = Number(rowAttrs.r || (rows.length + 1));
      var cells = [];
      var body = rm[2] || "";
      var cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, cm;
      while ((cm = cellRe.exec(body))) {
        var a = attrs(cm[1]);
        var inner = cm[2] || "";
        var idx = a.r ? colIndex(a.r) : cells.length;

        var formula = null;
        var fm = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(inner);
        if (fm) {
          var fa = attrs(fm[1]);
          var ftext = fm[2] === undefined ? "" : unescapeXml(fm[2]);
          if (fa.t === "shared" && fa.si !== undefined) {
            if (ftext) sharedFormulas[fa.si] = ftext;
            formula = ftext || sharedFormulas[fa.si] || null;
          } else {
            formula = ftext || null;
          }
          if (formula) formula = "=" + formula;
        }

        var vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
        var raw = vm ? unescapeXml(vm[1]) : null;
        var value = null, text = "", isDate = false, iso = null, type = a.t || "n";

        if (a.t === "s") {
          value = shared[Number(raw)] !== undefined ? shared[Number(raw)] : "";
          text = value;
          type = "string";
        } else if (a.t === "inlineStr") {
          var t2 = "", tre2 = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g, tm2;
          while ((tm2 = tre2.exec(inner))) t2 += tm2[1] === undefined ? "" : unescapeXml(tm2[1]);
          value = t2; text = t2; type = "string";
        } else if (a.t === "str") {
          value = raw === null ? "" : raw; text = value; type = "string";
        } else if (a.t === "b") {
          value = raw === "1"; text = value ? "TRUE" : "FALSE"; type = "boolean";
        } else if (a.t === "e") {
          // #N/A and friends. Kept as text so a formula gap stays visible rather than
          // silently becoming an empty cell.
          value = raw; text = raw === null ? "" : raw; type = "error";
        } else if (raw !== null && raw !== "") {
          var num = Number(raw);
          var fmt = formatCodeFor(styles, a.s);
          if (!isNaN(num) && isDateFormat(fmt)) {
            var d = serialToDate(num);
            value = num; iso = isoDate(d); text = formatDate(d, fmt.code); isDate = true; type = "date";
          } else {
            value = isNaN(num) ? raw : num;
            text = String(raw);
            type = "number";
          }
        } else if (formula) {
          // A formula with no cached value: whatever last wrote the file did not
          // calculate. The importer has to say so rather than import a blank.
          type = "uncalculated";
        }

        while (cells.length < idx) cells.push(EMPTY);
        cells[idx] = { value: value, text: text, formula: formula, isDate: isDate, iso: iso, type: type };
      }
      while (rows.length < rowNum - 1) rows.push([]);
      rows[rowNum - 1] = cells;
    }
    return rows;
  }

  function parseMerges(xml) {
    var out = [], re = /<mergeCell\b[^>]*ref="([^"]+)"[^>]*\/>/g, m;
    while ((m = re.exec(xml))) {
      var parts = m[1].split(":");
      if (parts.length !== 2) continue;
      out.push({
        ref: m[1],
        startCol: colIndex(parts[0]), startRow: Number(parts[0].replace(/^[A-Z]+/, "")),
        endCol: colIndex(parts[1]), endRow: Number(parts[1].replace(/^[A-Z]+/, ""))
      });
    }
    return out;
  }

  // =====================================================================
  // readWorkbook
  // =====================================================================

  function readWorkbook(buffer) {
    var b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var entries;
    try {
      entries = zipEntries(b);
    } catch (e) {
      return Promise.reject(new Error("That does not look like an .xlsx file. (" + e.message + ")"));
    }
    if (!entries["xl/workbook.xml"]) {
      return Promise.reject(new Error(
        "That zip has no xl/workbook.xml, so it is not an .xlsx workbook. " +
        "An .xls or .csv file has to be saved as .xlsx first."));
    }

    function text(name) {
      if (!entries[name]) return Promise.resolve("");
      return readEntry(b, entries[name]).then(fromUtf8);
    }

    var out = { sheets: [] };
    return Promise.all([text("xl/workbook.xml"), text("xl/_rels/workbook.xml.rels"),
                        text("xl/sharedStrings.xml"), text("xl/styles.xml")])
      .then(function (parts) {
        var wbXml = parts[0], relsXml = parts[1];
        var shared = parseSharedStrings(parts[2]);
        var styles = parseStyles(parts[3]);

        var rels = {}, rre = /<Relationship\b[^>]*\/>/g, rm;
        while ((rm = rre.exec(relsXml))) {
          var ra = attrs(rm[0]);
          if (ra.Id) rels[ra.Id] = ra.Target;
        }

        var defs = [], sre = /<sheet\b[^>]*\/>/g, sm;
        while ((sm = sre.exec(wbXml))) {
          var sa = attrs(sm[0]);
          var target = rels[sa["r:id"]] || rels[sa.id] || "";
          if (target.charAt(0) === "/") target = target.slice(1);
          else if (target.indexOf("xl/") !== 0) target = "xl/" + target.replace(/^\.\//, "");
          defs.push({ name: sa.name || "", path: target });
        }

        return defs.reduce(function (chain, def) {
          return chain.then(function () {
            if (!entries[def.path]) { out.sheets.push({ name: def.name, rows: [], merges: [] }); return; }
            return text(def.path).then(function (sx) {
              out.sheets.push({
                name: def.name,
                rows: parseSheet(sx, shared, styles),
                merges: parseMerges(sx)
              });
            });
          });
        }, Promise.resolve());
      })
      .then(function () { return out; });
  }

  // =====================================================================
  // writeWorkbook
  // =====================================================================

  var CONTENT_TYPES_HEAD =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';

  var STYLES_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
    // openpyxl warns, and some Excel builds complain, when a workbook has no named
    // "Normal" style. Two elements to say nothing at all is cheap insurance.
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '<dxfs count="0"/>' +
    '</styleSheet>';

  function sheetXml(rows, headerRow) {
    var parts = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'];
    if (headerRow) parts.push('<sheetViews><sheetView workbookViewId="0">' +
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '</sheetView></sheetViews>');
    parts.push("<sheetData>");
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r] || [];
      parts.push('<row r="' + (r + 1) + '">');
      for (var c = 0; c < row.length; c++) {
        var v = row[c];
        if (v === null || v === undefined || v === "") continue;
        var ref = colName(c) + (r + 1);
        var style = (headerRow && r === 0) ? ' s="1"' : "";
        if (typeof v === "number" && isFinite(v)) {
          parts.push('<c r="' + ref + '"' + style + '>' + "<v>" + v + "</v></c>");
        } else {
          // Inline strings, so no sharedStrings part is needed at all.
          parts.push('<c r="' + ref + '"' + style + ' t="inlineStr"><is><t xml:space="preserve">' +
                     escapeXml(v) + "</t></is></c>");
        }
      }
      parts.push("</row>");
    }
    parts.push("</sheetData></worksheet>");
    return parts.join("");
  }

  // Excel refuses a workbook whose sheet name is over 31 characters or contains any of
  // : \ / ? * [ ] -- and silently refusing is exactly the kind of failure that is
  // impossible to debug from a phone, so clean the name here.
  function safeSheetName(name, index) {
    var s = String(name || ("Sheet" + (index + 1))).replace(/[:\\\/?*\[\]]/g, "-").slice(0, 31);
    return s || ("Sheet" + (index + 1));
  }

  function writeWorkbook(sheets, options) {
    var opts = options || {};
    var used = {};
    var defs = sheets.map(function (s, i) {
      var name = safeSheetName(s.name, i);
      var base = name, n = 2;
      while (used[name.toLowerCase()]) { name = (base.slice(0, 28) + "-" + n).slice(0, 31); n++; }
      used[name.toLowerCase()] = true;
      return { name: name, rows: s.rows || [] };
    });

    var files = [];
    var types = [CONTENT_TYPES_HEAD];
    var wbSheets = [], wbRels = [];
    defs.forEach(function (d, i) {
      var n = i + 1;
      types.push('<Override PartName="/xl/worksheets/sheet' + n + '.xml" ' +
                 'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>');
      wbSheets.push('<sheet name="' + escapeXml(d.name) + '" sheetId="' + n + '" r:id="rId' + n + '"/>');
      wbRels.push('<Relationship Id="rId' + n + '" ' +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
        'Target="worksheets/sheet' + n + '.xml"/>');
      files.push({ name: "xl/worksheets/sheet" + n + ".xml", bytes: utf8(sheetXml(d.rows, opts.headerRow !== false)) });
    });
    types.push("</Types>");

    var styleRelId = "rId" + (defs.length + 1);
    wbRels.push('<Relationship Id="' + styleRelId + '" ' +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>');

    files.unshift(
      { name: "[Content_Types].xml", bytes: utf8(types.join("")) },
      { name: "_rels/.rels", bytes: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        "</Relationships>") },
      { name: "xl/workbook.xml", bytes: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        "<sheets>" + wbSheets.join("") + "</sheets></workbook>") },
      { name: "xl/_rels/workbook.xml.rels", bytes: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        wbRels.join("") + "</Relationships>") },
      { name: "xl/styles.xml", bytes: utf8(STYLES_XML) }
    );

    return zipStore(files);
  }

  root.XlsxLite = {
    readWorkbook: readWorkbook,
    writeWorkbook: writeWorkbook,
    // Exported for the selftest and for anything that needs a column letter.
    colName: colName,
    colIndex: colIndex,
    serialToDate: serialToDate,
    isoDate: isoDate,
    crc32: crc32
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
