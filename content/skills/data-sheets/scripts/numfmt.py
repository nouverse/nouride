"""
numfmt.py - numbers, money and percentages written the way a reader in a given locale writes them. Used by chart.py.

    fmt = Formatter("de-CH", "CHF")
    fmt.money(1234.5)          -> "CHF 1’234.50"
    fmt.money_short(1250000)   -> "CHF 1.25 Mio."
    fmt.number(1234567.891, 2) -> "1’234’567.89"
    fmt.percent(12.5)          -> "12.5%"

The locale is a BCP-47 tag (id-ID, en-US, en-IN, de-CH, fr-FR, ja-JP ...); the currency an ISO 4217 code (IDR, USD,
EUR ...). Separators, grouping (Indian 12,34,567 included), the currency's symbol, its side and spacing, and the short
forms (1,2 jt; 1.2M; 1,2 Mio.; 125万) come from CLDR: from Babel when it is importable (every CLDR locale), otherwise
from numfmt_cldr.json beside this file, generated from Babel for the common locales and currencies. A locale neither
knows is written plainly (1234567.89) and a currency neither knows is written as its code (XYZ 1234.50): a symbol is
never guessed.

Rebuild the table, with a Python that has Babel:  python3 numfmt.py --build-table
"""

from __future__ import annotations

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TABLE = os.path.join(HERE, "numfmt_cldr.json")
# Minor digits as amounts are commonly written, where that differs from ISO 4217's: Indonesian prices carry no sen.
DIGITS_OVERRIDE = {"IDR": 0}
# What people type for --unit, mapped to the currency code it means. Only unambiguous ones: "$" alone is not here.
SYMBOL_TO_CODE = {"rp": "IDR", "rp.": "IDR", "idr": "IDR", "€": "EUR", "£": "GBP", "₹": "INR", "us$": "USD", "usd": "USD",
                  "eur": "EUR", "gbp": "GBP", "jpy": "JPY", "inr": "INR", "chf": "CHF", "sgd": "SGD", "s$": "SGD",
                  "myr": "MYR", "rm": "MYR", "aud": "AUD", "cad": "CAD", "cny": "CNY", "krw": "KRW", "₩": "KRW",
                  "thb": "THB", "฿": "THB", "vnd": "VND", "₫": "VND", "php": "PHP", "₱": "PHP", "brl": "BRL", "r$": "BRL"}
BUILD_LOCALES = ["en-US", "en-GB", "en-IN", "en-SG", "en-AU", "en-CA", "id-ID", "ms-MY", "de-DE", "de-AT", "de-CH",
                 "fr-FR", "fr-CH", "fr-CA", "es-ES", "es-MX", "it-IT", "nl-NL", "pt-BR", "pt-PT", "ja-JP", "zh-CN",
                 "zh-TW", "ko-KR", "th-TH", "vi-VN", "tr-TR", "pl-PL", "sv-SE", "da-DK", "nb-NO", "fi-FI", "ru-RU",
                 "cs-CZ", "fil-PH", "hi-IN"]
BUILD_CURRENCIES = ["IDR", "USD", "EUR", "GBP", "JPY", "INR", "CHF", "SGD", "MYR", "AUD", "CAD", "CNY", "HKD", "TWD",
                    "KRW", "THB", "VND", "PHP", "BRL", "MXN", "TRY", "PLN", "SEK", "DKK", "NOK", "RUB", "CZK", "SAR",
                    "AED", "NZD", "ZAR"]
PLAIN = {"decimal": ".", "group": "", "minus": "-", "grouping": [3, 3], "currency": "¤ #,##0.00", "percent": "#,##0%",
         "compact": {}, "symbols": {}}


def from_babel(tag: str, currencies: list[str] | None = None) -> dict | None:
    try:
        from babel import Locale, UnknownLocaleError
        from babel import numbers as bn
    except ImportError:
        return None
    try:
        loc = Locale.parse(tag.replace("-", "_"))
    except (UnknownLocaleError, ValueError):
        return None
    # An older Babel lacks some of this (compact formats came in 2.11): then the built-in table answers, rather than a
    # traceback — a CI machine's Babel stopped every number here.
    try:
        sym = loc.number_symbols.get("latn", loc.number_symbols) if hasattr(loc.number_symbols, "get") else loc.number_symbols
        short = (getattr(loc, "compact_decimal_formats", None) or {}).get("short", {})
        forms = short.get("other") or (next(iter(short.values())) if short else {})
        compact = {m: (p.pattern if hasattr(p, "pattern") else str(p)) for m, p in forms.items()}
        data = {
            "decimal": sym["decimal"], "group": sym["group"], "minus": sym.get("minusSign", "-"),
            "grouping": list(loc.decimal_formats[None].grouping),
            "currency": loc.currency_formats["standard"].pattern.split(";")[0],
            "percent": loc.percent_formats[None].pattern.split(";")[0], "compact": compact, "symbols": {},
            "months": [loc.months["format"]["abbreviated"][i] for i in range(1, 13)],
            "_babel": bn,
            "_locale": loc,
        }
        for c in currencies or []:
            data["symbols"][c] = bn.get_currency_symbol(c, locale=loc)
    except (AttributeError, KeyError, TypeError, ValueError):
        return None
    return data


def table() -> dict:
    try:
        with open(TABLE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"locales": {}, "digits": {}}


class Formatter:
    def __init__(self, locale: str | None, currency: str | None = None):
        self.notes: list[str] = []
        self.tag = normalise(locale or "en-US")
        self.currency = currency.upper() if currency else None
        t = table()
        data = from_babel(self.tag, [self.currency] if self.currency else [])
        self.source = "Babel (CLDR)" if data else ""
        if data is None:
            data = lookup(t["locales"], self.tag)
            self.source = "built-in CLDR table" if data else ""
        if data is None:
            data = PLAIN
            self.source = "plain"
            self.notes.append(f"locale {self.tag} is not in the built-in table and Babel is not installed: numbers are "
                              "written plainly (1234567.89). `pip install babel` gives every locale")
        self.d = data
        self.digits = 2
        self.symbol = ""
        if self.currency:
            if not re.match(r"^[A-Z]{3}$", self.currency):
                raise ValueError(f"currency {currency!r} is not an ISO 4217 code (IDR, USD, EUR ...)")
            if "_babel" in data:
                bn = data["_babel"]
                self.digits = DIGITS_OVERRIDE.get(self.currency, bn.get_currency_precision(self.currency))
                self.symbol = data["symbols"].get(self.currency) or self.currency
            else:
                self.digits = DIGITS_OVERRIDE.get(self.currency, t.get("digits", {}).get(self.currency, 2))
                self.symbol = data.get("symbols", {}).get(self.currency) or self.currency
                if self.currency not in t.get("digits", {}):
                    self.notes.append(f"currency {self.currency} is not in the built-in table: written as its code, "
                                      "2 decimals - `pip install babel` for its symbol")

    # -- the parts

    def _group(self, digits: str) -> str:
        g = self.d["group"]
        if not g or len(digits) <= self.d["grouping"][0]:
            return digits
        p, s = self.d["grouping"][0], self.d["grouping"][1] or self.d["grouping"][0]
        head, tail = digits[:-p], digits[-p:]
        parts = []
        while len(head) > s:
            parts.insert(0, head[-s:])
            head = head[:-s]
        if head:
            parts.insert(0, head)
        return g.join(parts + [tail])

    def number(self, x: float, digits: int | None = None, trim: bool = False) -> str:
        """digits None: as many as needed up to 2. trim: drop trailing zeros of the fraction."""
        neg = x < 0
        x = abs(x)
        if digits is None:
            digits = 0 if float(x).is_integer() else 2
            trim = True
        s = f"{x:.{digits}f}"
        whole, _, frac = s.partition(".")
        if trim:
            frac = frac.rstrip("0")
        out = self._group(whole) + (self.d["decimal"] + frac if frac else "")
        return (self.d.get("minus", "-") if neg else "") + out

    def _place(self, pattern: str, num: str, symbol: str) -> str:
        """Put a formatted number and a symbol where a CLDR pattern has them (#,##0.00 and ¤ or %)."""
        neg = num.startswith(self.d.get("minus", "-"))
        body = num[len(self.d.get("minus", "-")):] if neg else num
        m = re.search(r"[#0][#0,.]*", pattern)
        if not m:
            return num
        out = pattern[: m.start()] + "\x00" + pattern[m.end():]
        # CLDR's currency spacing: a symbol that ends (or starts) with a letter is kept apart from the digits -
        # "IDR 1,234", not "IDR1,234" - while "$1,234" and "Rp1.234" stay as the locale writes them.
        if symbol and symbol[-1].isalpha() and "¤\x00" in out and len(symbol) > 2:
            out = out.replace("¤\x00", "¤\u00a0\x00")
        if symbol and symbol[0].isalpha() and "\x00¤" in out and len(symbol) > 2:
            out = out.replace("\x00¤", "\x00\u00a0¤")
        out = out.replace("¤", symbol).replace("'", "")
        out = out.replace("\x00", body)
        return (self.d.get("minus", "-") if neg else "") + out

    def money(self, x: float, digits: int | None = None) -> str:
        if not self.currency:
            return self.number(x, digits)
        return self._place(self.d["currency"], self.number(x, self.digits if digits is None else digits), self.symbol)

    def percent(self, x: float, digits: int | None = None) -> str:
        """x is already in percent units: 12.5 -> 12.5%."""
        return self._place(self.d["percent"], self.number(x, digits, trim=digits is None), "")

    def short(self, x: float) -> str:
        """1250000 -> 1.25M / 1,25 jt / 1,25 Mio. / 125万 / 12.5L - for axis ticks."""
        a = abs(x)
        patterns = self.d.get("compact") or {}
        best = None
        for mag in sorted(patterns, key=int):
            if a >= int(mag):
                best = mag
        if best is None or patterns[best].strip("'") in ("0", ""):
            return self.number(x, None)
        pat = patterns[best].replace("'", "")
        zeros = len(re.search(r"0+", pat).group(0))
        divisor = int(best) / 10 ** (zeros - 1)
        v = x / divisor
        digits = 0 if abs(v) >= 100 or float(round(v, 2)).is_integer() else (1 if abs(v) >= 10 else 2)
        num = self.number(round(v, digits), digits, trim=True)
        return re.sub(r"0+", lambda _: num, pat, count=1)

    def money_short(self, x: float) -> str:
        if not self.currency:
            return self.short(x)
        return self._place(self.d["currency"], self.short(x), self.symbol)

    def month(self, m: int) -> str:
        names = self.d.get("months") or ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        return names[m - 1]

    def describe(self) -> str:
        sample = self.money(1234567.5) if self.currency else self.number(1234567.5, 2)
        return f"{self.tag}{' ' + self.currency if self.currency else ''} ({self.source}): {sample}, short {self.money_short(1250000)}"


def normalise(tag: str) -> str:
    t = tag.replace("_", "-").strip()
    parts = t.split("-")
    if len(parts) == 1:
        return parts[0].lower()
    return parts[0].lower() + "-" + parts[1].upper()


def lookup(locales: dict, tag: str) -> dict | None:
    if tag in locales:
        return locales[tag]
    lang = tag.split("-")[0]
    # A bare language goes to its main country in the table: id -> id-ID, en -> en-US, de -> de-DE.
    for k in locales:
        if k.split("-")[0] == lang and (k.split("-")[1].lower() == lang or (lang, k) in (("en", "en-US"), ("ja", "ja-JP"),
                                                                                         ("zh", "zh-CN"), ("ko", "ko-KR"),
                                                                                         ("ms", "ms-MY"), ("vi", "vi-VN"),
                                                                                         ("sv", "sv-SE"), ("da", "da-DK"),
                                                                                         ("nb", "nb-NO"), ("cs", "cs-CZ"),
                                                                                         ("hi", "hi-IN"), ("fil", "fil-PH"),
                                                                                         ("pt", "pt-BR"), ("es", "es-ES"))):
            return locales[k]
    return None


def unit_to_currency(unit: str) -> str | None:
    """--unit Rp -> IDR. None when the unit is not a currency (kg, %, orang) or is ambiguous ($, ¥)."""
    u = (unit or "").strip().lower()
    if re.match(r"^[a-z]{3}$", u) and u.upper() in BUILD_CURRENCIES:
        return u.upper()
    return SYMBOL_TO_CODE.get(u)


def build_table(path: str) -> None:
    import babel
    from babel import numbers as bn
    out = {"source": f"CLDR via Babel {babel.__version__}", "locales": {}, "digits": {}}
    for c in BUILD_CURRENCIES:
        out["digits"][c] = DIGITS_OVERRIDE.get(c, bn.get_currency_precision(c))
    for tag in BUILD_LOCALES:
        d = from_babel(tag, BUILD_CURRENCIES)
        out["locales"][tag] = {k: v for k, v in d.items() if not k.startswith("_")}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {path}: {len(out['locales'])} locales, {len(out['digits'])} currencies")


if __name__ == "__main__":
    if sys.argv[1:] == ["--build-table"]:
        build_table(TABLE)
    else:
        print(__doc__)
