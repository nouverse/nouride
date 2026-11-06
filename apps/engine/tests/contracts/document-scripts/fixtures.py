"""
Small documents for the document-skill script tests, written with the standard library only so the tests run on any
python3 - no openpyxl needed to *make* a workbook. Each one is the edge case it is named for.

    python3 fixtures.py OUTDIR
"""

import os
import sys
import zipfile

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)


def put(name, data):
    with open(os.path.join(OUT, name), "wb") as fh:
        fh.write(data if isinstance(data, bytes) else data.encode("utf-8"))


def zipped(name, parts):
    with zipfile.ZipFile(os.path.join(OUT, name), "w", zipfile.ZIP_DEFLATED) as z:
        for part, body in parts.items():
            z.writestr(part, body)


NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' \
     'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_RELS = ('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="' + REL + '/officeDocument" Target="{main}"/></Relationships>')


def rels(items):
    body = "".join(f'<Relationship Id="{i}" Type="{REL}/{t}" Target="{target}"/>' for i, t, target in items)
    return f'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{body}</Relationships>'


def workbook(risky=False, macro=False):
    ctype = "application/vnd.ms-excel.sheet.macroEnabled.main+xml" if macro else \
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
    types = ('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
             '<Default Extension="xml" ContentType="application/xml"/>'
             '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
             f'<Override PartName="/xl/workbook.xml" ContentType="{ctype}"/>'
             '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
             '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
             '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
             '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
             '</Types>')
    wb = (f'<?xml version="1.0" encoding="UTF-8"?><workbook {NS}><sheets>'
          '<sheet name="KK 1.2" sheetId="1" r:id="rId1"/><sheet name="Rahasia" sheetId="2" state="hidden" r:id="rId2"/>'
          '</sheets><definedNames><definedName name="Total">\'KK 1.2\'!$D$7</definedName></definedNames></workbook>')
    sst = (f'<?xml version="1.0" encoding="UTF-8"?><sst {NS[:NS.index(" xmlns:r")]} count="6" uniqueCount="6">'
           '<si><t>Laporan Kas 2026</t></si><si><t>No</t></si><si><t>Nama</t></si><si><t>Tanggal</t></si>'
           '<si><t>Jumlah</t></si><si><r><t>Ap</t></r><r><t>el</t></r><rPh sb="0" eb="2"><t>XX</t></rPh></si></sst>')
    styles = (f'<?xml version="1.0" encoding="UTF-8"?><styleSheet {NS[:NS.index(" xmlns:r")]}>'
              '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>')
    rows = (
        '<row r="1"><c r="A1" t="s"><v>0</v></c></row>'
        '<row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3" t="s"><v>2</v></c><c r="C3" t="s"><v>3</v></c><c r="D3" t="s"><v>4</v></c></row>'
        '<row r="4"><c r="A4"><v>1</v></c><c r="B4" t="s"><v>5</v></c><c r="C4" s="1"><v>46315</v></c><c r="D4"><v>1500</v></c></row>'
        '<row r="5"><c r="A5"><v>2</v></c><c r="B5" t="inlineStr"><is><t>Jeruk</t></is></c><c r="C5" s="1"><v>46316</v></c><c r="D5"><v>2500.5</v></c></row>'
        '<row r="7"><c r="C7" t="str"><v>Total</v></c><c r="D7"><f>SUM(D4:D5)</f><v>4000.5</v></c><c r="E7"><f>D7*2</f></c></row>'
        '<row r="40"><c r="A40" s="1"/><c r="Z40" s="1"/></row>'
    )
    ext = ('<extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main">'
           '<x14:dataValidations count="1"><x14:dataValidation type="list"><x14:formula1><xm:f xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">'
           'Rahasia!$A$1:$A$3</xm:f></x14:formula1><xm:sqref xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">B4:B5</xm:sqref>'
           '</x14:dataValidation></x14:dataValidations></ext></extLst>') if risky else ""
    drawing = '<drawing r:id="rId1"/>' if risky else ""
    sheet1 = (f'<?xml version="1.0" encoding="UTF-8"?><worksheet {NS}><dimension ref="A1:Z40"/>'
              '<sheetViews><sheetView workbookViewId="0"><pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
              f'<sheetData>{rows}</sheetData><mergeCells count="1"><mergeCell ref="A1:D1"/></mergeCells>'
              '<dataValidations count="1"><dataValidation type="whole" sqref="A4:A5"><formula1>1</formula1></dataValidation></dataValidations>'
              f'{drawing}{ext}</worksheet>')
    sheet2 = (f'<?xml version="1.0" encoding="UTF-8"?><worksheet {NS}><sheetData>'
              '<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c></row></sheetData></worksheet>')
    parts = {
        "[Content_Types].xml": types,
        "_rels/.rels": PKG_RELS.format(main="xl/workbook.xml"),
        "xl/workbook.xml": wb,
        "xl/_rels/workbook.xml.rels": rels([("rId1", "worksheet", "worksheets/sheet1.xml"), ("rId2", "worksheet", "worksheets/sheet2.xml"),
                                            ("rId3", "sharedStrings", "sharedStrings.xml"), ("rId4", "styles", "styles.xml")]),
        "xl/worksheets/sheet1.xml": sheet1,
        "xl/worksheets/sheet2.xml": sheet2,
        "xl/sharedStrings.xml": sst,
        "xl/styles.xml": styles,
    }
    if risky:
        parts["xl/worksheets/_rels/sheet1.xml.rels"] = rels([("rId1", "drawing", "../drawings/drawing1.xml")])
        parts["xl/drawings/drawing1.xml"] = (
            '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" '
            'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor><xdr:sp><xdr:txBody><a:p><a:r><a:t>Catatan</a:t>'
            '</a:r></a:p></xdr:txBody></xdr:sp></xdr:twoCellAnchor></xdr:wsDr>')
        parts["xl/drawings/_rels/drawing1.xml.rels"] = rels([("rId1", "chart", "../charts/chart1.xml")])
        parts["xl/charts/chart1.xml"] = '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>'
    if macro:
        parts["xl/vbaProject.bin"] = b"\x00" * 64
    return parts


zipped("book.xlsx", workbook())
zipped("risky.xlsx", workbook(risky=True))
zipped("macro.xlsm", workbook(macro=True))

with open(os.path.join(OUT, "book.xlsx"), "rb") as fh:
    whole = fh.read()
put("truncated.xlsx", whole[: len(whole) // 2])

put("empty.xlsx", b"")
put("bom-semicolon.csv", b"\xef\xbb\xbf" + "Nama;Harga;Tanggal\r\nApel;1.234,50;2026-10-01\r\nJeruk;2.000,00;2026-10-02\r\n".encode("utf-8"))
put("mixed.csv", "kota,nilai\nMédan,1\n".encode("utf-8") + "Bogotá,2\n".encode("cp1252"))
put("fake.xls", "<html><body><table><tr><th>Tanggal</th><th>Keterangan</th><th>Debit</th></tr>"
                "<tr><td>01/10/2026</td><td>Transfer</td><td>150.000</td></tr></table></body></html>")
put("sml.xls", '<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>'
               '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">'
               '<Worksheet ss:Name="Data"><Table><Row><Cell><Data ss:Type="String">Kode</Data></Cell><Cell><Data ss:Type="String">Qty</Data></Cell></Row>'
               '<Row><Cell><Data ss:Type="String">A1</Data></Cell><Cell><Data ss:Type="Number">5</Data></Cell></Row></Table></Worksheet></Workbook>')
put("garbage.docx", b"PK\x03\x04" + bytes(range(256)) * 4)
# A password-protected .xlsx is an OLE container holding EncryptionInfo and EncryptedPackage streams.
put("locked.xlsx", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 504 + "EncryptionInfo".encode("utf-16-le") + b"\x00" * 50
    + "EncryptedPackage".encode("utf-16-le") + b"\x00" * 400)

# A zip whose entries carry the "encrypted" flag, the way a password-zipped archive does.
zipped("secret.zip", {"a.txt": "hello", "b.txt": "world"})
path = os.path.join(OUT, "secret.zip")
with open(path, "rb") as fh:
    data = bytearray(fh.read())
for sig, off in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
    i = data.find(sig)
    while i != -1:
        data[i + off] |= 1
        i = data.find(sig, i + 4)
with open(path, "wb") as fh:
    fh.write(bytes(data))

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
doc_body = (
    '<w:p><w:pPr><w:pStyle w:val="Judul1"/></w:pPr><w:r><w:t>Pendahuluan</w:t></w:r></w:p>'
    '<w:p><w:r><w:t xml:space="preserve">Kalimat </w:t></w:r><w:ins w:id="1" w:author="Ani"><w:r><w:t>baru</w:t></w:r></w:ins>'
    '<w:del w:id="2" w:author="Ani"><w:r><w:delText>lama</w:delText></w:r></w:del><w:commentReference w:id="0"/></w:p>'
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Kolom A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Kolom B</w:t></w:r></w:p></w:tc></w:tr>'
    '<w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    '<w:p><w:pPr><w:pStyle w:val="Judul2"/></w:pPr><w:r><w:t>Metode</w:t></w:r></w:p>'
)
zipped("report.docx", {
    "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                           '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels": PKG_RELS.format(main="word/document.xml"),
    "word/document.xml": f'<?xml version="1.0"?><w:document {W}><w:body>{doc_body}</w:body></w:document>',
    "word/_rels/document.xml.rels": rels([("rId1", "styles", "styles.xml"), ("rId2", "comments", "comments.xml")]),
    "word/styles.xml": f'<?xml version="1.0"?><w:styles {W}><w:style w:styleId="Judul1"><w:name w:val="heading 1"/></w:style>'
                       '<w:style w:styleId="Judul2"><w:name w:val="heading 2"/></w:style></w:styles>',
    "word/comments.xml": f'<?xml version="1.0"?><w:comments {W}><w:comment w:id="0" w:author="Budi"><w:p><w:r><w:t>Cek angka ini</w:t></w:r></w:p></w:comment></w:comments>',
})

P = ('xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
     'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')


def shape(ph, text):
    return (f'<p:sp><p:nvSpPr><p:cNvPr id="1" name="s"/><p:cNvSpPr/><p:nvPr><p:ph type="{ph}"/></p:nvPr></p:nvSpPr>'
            f'<p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>')


zipped("deck.pptx", {
    "_rels/.rels": PKG_RELS.format(main="ppt/presentation.xml"),
    "ppt/presentation.xml": f'<p:presentation {P}><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst>'
                            '<p:sldSz cx="12192000" cy="6858000"/></p:presentation>',
    "ppt/_rels/presentation.xml.rels": rels([("rId1", "slide", "slides/slide1.xml"), ("rId2", "slide", "slides/slide2.xml")]),
    "ppt/slides/slide1.xml": f'<p:sld {P}><p:cSld><p:spTree>{shape("ctrTitle", "Rencana 2027")}{shape("body", "Tiga target")}</p:spTree></p:cSld></p:sld>',
    "ppt/slides/_rels/slide1.xml.rels": rels([("rId1", "notesSlide", "../notesSlides/notesSlide1.xml")]),
    "ppt/notesSlides/notesSlide1.xml": f'<p:notes {P}><p:cSld><p:spTree>{shape("body", "Sebut anggaran dulu")}</p:spTree></p:cSld></p:notes>',
    "ppt/slides/slide2.xml": f'<p:sld {P} show="0"><p:cSld><p:spTree>{shape("title", "Cadangan")}</p:spTree></p:cSld></p:sld>',
})
