Untuk markdown standar, udah habis segitu. Sisanya fitur khas produk tertentu: artifact atau preview HTML ala Claude.ai, chart interaktif dari code block (`vega-lite`, `chart`), peta GeoJSON, atau model 3D STL kayak di GitHub. Itu fitur, bukan sintaks markdown.

SVG emang menarik, soalnya bisa jadi diagram, ikon, atau chart tanpa library apa pun. Ini variasi yang biasa dipakai buat ngetes:

## A. SVG inline
<svg width="220" height="80" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="5" width="210" height="70" rx="12" fill="#1e1b4b"/><circle cx="40" cy="40" r="18" fill="#f97316"/><text x="70" y="46" font-family="sans-serif" font-size="18" fill="#fff">Nouride 🦊</text></svg>

## B. SVG di code block bertanda `svg`
Beberapa UI nampilin preview gambarnya, bukan cuma kodenya.
```svg
<svg width="200" height="100" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="40" height="80" fill="#6366f1"/>
  <rect x="60" y="40" width="40" height="50" fill="#22c55e"/>
  <rect x="110" y="25" width="40" height="65" fill="#f97316"/>
  <line x1="5" y1="90" x2="195" y2="90" stroke="#888"/>
</svg>
```

## C. SVG sebagai gambar (data URI)
![svg data uri](data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'><circle cx='50' cy='50' r='40' fill='%2322c55e'/></svg>)

## D. SVG dengan animasi
<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="20" fill="#f97316"><animate attributeName="r" values="20;40;20" dur="1.5s" repeatCount="indefinite"/></circle></svg>

## E. Tes keamanan (harusnya GAK jalan)
<svg onload="alert('svg-xss')" width="50" height="50"><circle cx="25" cy="25" r="20" fill="red"/></svg>

Kalau muncul popup `svg-xss`, berarti ada lubang XSS: SVG dari agent bisa jalanin script di dashboard pakai session lu. Di dashboard sendiri efeknya cuma alert, gak bahaya, tapi itu sinyal yang harus di-fix.

Kalau nanti SVG mau didukung beneran, gw bakal render lewat `<img src="data:image/svg+xml,...">`. Gambar yang dimuat lewat `<img>` gak bisa jalanin script sama sekali, jadi gak perlu sanitizer buat itu. Inline SVG yang di-sanitize dengan DOMPurify juga bisa, tapi butuh dependency baru dan permukaan serangannya lebih besar.