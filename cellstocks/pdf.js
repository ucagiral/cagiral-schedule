// A very small PDF writer -- enough for one thing: the printable map of the freezer that
// goes on the door. No dependencies, in the same spirit as xlsx.js next to it, and for
// the same reason: this repository has no build step and nothing to install.
//
// What it supports is deliberately the minimum that map needs -- pages, lines of text in
// one built-in font at a few sizes, rectangles, and horizontal rules. There is no image
// support, no embedded font, no unicode beyond Latin-1: the standard 14 fonts are
// single-byte, so text is encoded as WinAnsi and anything outside it is transliterated
// (see latin1()) rather than silently dropped. Turkish names in this lab do go through
// that -- "Şişli" prints as "Sisli" -- which is a real limitation, chosen over embedding
// a font subsetter to print a freezer map.
//
// The file format itself: a header, a numbered object per page plus shared resources, a
// cross-reference table giving each object's byte offset, and a trailer pointing at the
// catalog. Offsets are counted in bytes as the body is built, which is why everything is
// assembled as strings of single-byte characters and only encoded at the very end.
(function (root) {
  "use strict";

  var FONTS = { regular: "F1", bold: "F2" };

  // The standard-14 fonts are single-byte. Rather than drop what does not fit, the few
  // accented letters this lab actually types are folded to their base letter, so a name
  // still reads. Anything else outside Latin-1 becomes "?" -- visible, not silent.
  var FOLD = {
    "ç":"c","Ç":"C","ğ":"g","Ğ":"G","ı":"i","İ":"I","ö":"o","Ö":"O",
    "ş":"s","Ş":"S","ü":"u","Ü":"U","â":"a","î":"i","û":"u","°":" deg "
  };

  function latin1(text) {
    var out = "";
    var s = String(text === null || text === undefined ? "" : text);
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (FOLD[ch] !== undefined) { out += FOLD[ch]; continue; }
      var code = s.charCodeAt(i);
      out += code < 256 ? ch : "?";
    }
    return out;
  }

  // ( ) and \ are the only characters that need escaping inside a PDF string literal.
  function pdfString(text) {
    return "(" + latin1(text).replace(/([\\()])/g, "\\$1") + ")";
  }

  function fmt(n) {
    var v = Math.round(Number(n) * 100) / 100;
    return String(v);
  }

  // A4 in points, which is the unit PDF works in (72 to the inch).
  var PAGE = { width: 595.28, height: 841.89 };

  function createDocument(options) {
    var o = options || {};
    var pages = [];
    var current = null;

    function newPage() {
      current = { ops: [], y: PAGE.height - (o.margin || 40) };
      pages.push(current);
      return current;
    }

    function ensure(space) {
      if (!current) newPage();
      if (current.y - space < (o.margin || 40)) newPage();
      return current;
    }

    var api = {
      get pageCount() { return pages.length; },
      addPage: function () { newPage(); return api; },

      // One line of text at the current cursor, which then moves down.
      text: function (value, opts) {
        var t = opts || {};
        var size = t.size || 10;
        var lead = t.lead === undefined ? size * 1.45 : t.lead;
        var page = ensure(lead);
        var x = (o.margin || 40) + (t.indent || 0);
        page.ops.push("BT /" + (t.bold ? FONTS.bold : FONTS.regular) + " " + fmt(size) + " Tf " +
                      fmt(x) + " " + fmt(page.y - size) + " Td " + pdfString(value) + " Tj ET");
        page.y -= lead;
        return api;
      },

      // Text placed exactly, without moving the cursor -- what the grid cells use.
      textAt: function (value, x, y, opts) {
        var t = opts || {};
        var size = t.size || 8;
        var page = ensure(0);
        page.ops.push("BT /" + (t.bold ? FONTS.bold : FONTS.regular) + " " + fmt(size) + " Tf " +
                      fmt(x) + " " + fmt(y) + " Td " + pdfString(value) + " Tj ET");
        return api;
      },

      rect: function (x, y, w, h, opts) {
        var t = opts || {};
        var page = ensure(0);
        var ops = [];
        if (t.fill) ops.push(fmt(t.fill[0]) + " " + fmt(t.fill[1]) + " " + fmt(t.fill[2]) + " rg");
        ops.push(fmt(t.line === undefined ? 0.6 : t.line) + " w");
        ops.push("0.6 0.6 0.6 RG");
        ops.push(fmt(x) + " " + fmt(y) + " " + fmt(w) + " " + fmt(h) + " re");
        ops.push(t.fill ? "B" : "S");
        page.ops.push("q " + ops.join(" ") + " Q");
        return api;
      },

      rule: function () {
        var page = ensure(10);
        page.ops.push("q 0.8 0.8 0.8 RG 0.5 w " + fmt(o.margin || 40) + " " + fmt(page.y) +
                      " m " + fmt(PAGE.width - (o.margin || 40)) + " " + fmt(page.y) + " l S Q");
        page.y -= 10;
        return api;
      },

      gap: function (h) { ensure(h); current.y -= h; return api; },
      get cursorY() { return current ? current.y : PAGE.height - (o.margin || 40); },
      set cursorY(v) { ensure(0); current.y = v; },
      get width() { return PAGE.width; },
      get margin() { return o.margin || 40; },

      // Serialises everything built so far. Returns a Uint8Array, so a caller can hand it
      // to a Blob in the browser or writeFileSync in node without knowing the difference.
      toBytes: function () {
        if (!pages.length) newPage();
        var objects = [];        // 1-based; objects[i] is object number i+1
        function add(body) { objects.push(body); return objects.length; }

        var fontRegular = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
        var fontBold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
        var resources = add("<< /Font << /" + FONTS.regular + " " + fontRegular + " 0 R /" +
                            FONTS.bold + " " + fontBold + " 0 R >> >>");

        // The /Pages node is written last but every page has to name it as its Parent, so
        // its object number is worked out ahead of time: what exists now, plus the two
        // objects each page adds (its content stream and the page itself), plus one.
        var pagesObj = objects.length + pages.length * 2 + 1;
        var kids = [];
        pages.forEach(function (page) {
          var stream = page.ops.join("\n");
          var contents = add("<< /Length " + stream.length + " >>\nstream\n" + stream + "\nendstream");
          var pageObj = add("<< /Type /Page /Parent " + pagesObj + " 0 R /MediaBox [0 0 " +
                            fmt(PAGE.width) + " " + fmt(PAGE.height) + "] /Resources " + resources +
                            " 0 R /Contents " + contents + " 0 R >>");
          kids.push(pageObj + " 0 R");
        });
        var pagesNode = add("<< /Type /Pages /Count " + pages.length + " /Kids [" + kids.join(" ") + "] >>");
        var catalog = add("<< /Type /Catalog /Pages " + pagesNode + " 0 R >>");

        var out = "%PDF-1.4\n";
        var offsets = [];
        objects.forEach(function (body, i) {
          offsets.push(out.length);
          out += (i + 1) + " 0 obj\n" + body + "\nendobj\n";
        });
        var xref = out.length;
        out += "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n";
        offsets.forEach(function (off) {
          out += ("0000000000" + off).slice(-10) + " 00000 n \n";
        });
        out += "trailer\n<< /Size " + (objects.length + 1) + " /Root " + catalog +
               " 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";

        var bytes = new Uint8Array(out.length);
        for (var i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
        return bytes;
      }
    };
    return api;
  }

  root.PdfLite = { createDocument: createDocument, latin1: latin1, PAGE: PAGE };
})(typeof globalThis !== "undefined" ? globalThis : this);
