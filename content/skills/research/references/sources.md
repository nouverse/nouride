# Sources: where the answer lives, and how much to trust it

Read this on your first research task, and again when you are unsure whether a page is good enough to cite.

## 1. Five questions for every page

Ask them before the page goes into the ledger. A page that fails one is not thrown away; it is cited with that said.

| Ask | Look at | A bad sign |
|---|---|---|
| **Who** wrote it, and could they know? | the byline, the "about" page, the domain (`.go.id`, `.ac.id`, a company) | no author, no organisation, a content farm with ten topics a day |
| **When** was it written or last updated? | `web_fetch`'s frontmatter (`date`, `modified`), the page header, the URL (`/2021/03/`) | no date on a figure that changes; "updated" with no change shown |
| **Where** did *they* get it? | links, footnotes, "according to …" | a number with no source (follow it back or do not use it) |
| **Who benefits** if you believe it? | who published it, who paid, what it sells | a vendor's savings figure, a party's poll, a sponsored article (`advertorial`, `sponsored`, `kerja sama`) |
| **Does anyone else** independent say the same? | a second search for the claim itself | everyone quotes one press release; only one site has it |

The habit that does most: **lateral reading.** When you do not know a site, do not judge it by its own "about" page;
search for the site's name and see what others say about it (a known newspaper, a known hoax site, a company's own
blog).

## 2. Primary first

The primary source is the thing itself; everything else is someone telling you about it, with room for error at each
retelling. Follow a claim back until you reach it, and cite that.

| The fact is about | The primary source is |
|---|---|
| a law, a regulation, a rule | the text of the regulation (its number and year), on the issuer's site or a regulation database |
| a statistic | the statistics office's table or release, with its definition and period |
| a company's numbers | its annual report or filing to the exchange or regulator |
| a product's behaviour, price, version | the vendor's own docs, pricing page, changelog, release notes |
| a scientific finding | the paper (preferably the published version; a preprint is said as one) |
| what someone said | the full transcript or video, not the headline |
| a court decision | the decision document itself |
| an event | several independent first-hand reports; official statements for what an institution says |

A secondary source is still useful: to find the primary, to explain it, and when the primary is not public. Then say
"as reported by …".

## 3. A country's topics: where to look

Every country publishes the same kinds of primary sources; only the names and domains differ. For a topic tied to a
place, search in that place's language (`lang`), and find its versions of these:

| Kind | What to search for | It settles |
|---|---|---|
| the official legislation database or gazette | "<country> legislation database", "official gazette" | what a law or regulation says, and whether it is still in force |
| the national statistics office | "<country> national statistics office <topic>" | official figures with definitions and periods |
| the central bank | "<country> central bank policy rate" | interest rates, exchange rates, inflation targets |
| the financial regulator | "<country> financial services authority licensed list" | whether a bank, insurer, lender or investment product is licensed |
| the company registry, the stock exchange's filings | "<country> company registry", "<exchange> annual report <company>" | who owns a company, its reported numbers |
| the courts' decision database | "<country> court decisions database" | what a court decided |
| the regulator for the sector | food and drug, telecoms, energy, competition | product approvals, tariffs, enforcement |
| fact-checkers and the established press | "<country> fact check", the national news agency | how a claim was reported and checked |

Government sites usually sit under a government domain (`.gov`, `.gov.uk`, `.gouv.fr`, `.bund.de`, `.go.id`,
`.go.jp`); a look-alike domain selling something is not the agency. Many government sites refuse automated fetches
(HTTP 403 below): read those with the `browser-automation` skill.

Examples, checked to answer in November 2026 (* refused a plain fetch):

| Place | Laws | Statistics | Central bank | Companies, filings | Courts |
|---|---|---|---|---|---|
| United States | `federalregister.gov`, `ecfr.gov`, `congress.gov`* | `census.gov`, `bls.gov`* | `federalreserve.gov` | `sec.gov` EDGAR* | `courtlistener.com`* |
| United Kingdom | `legislation.gov.uk` | `ons.gov.uk` | `bankofengland.co.uk` | Companies House (`find-and-update.company-information.service.gov.uk`) | `caselaw.nationalarchives.gov.uk` |
| European Union | `eur-lex.europa.eu` | Eurostat (`ec.europa.eu/eurostat`) | `ecb.europa.eu` | the member state's registry | `curia.europa.eu` |
| Germany | `gesetze-im-internet.de` | `destatis.de` | `bundesbank.de` | `unternehmensregister.de` | the federal courts' sites |
| Indonesia | `peraturan.bpk.go.id` (full text and status), `peraturan.go.id` | `bps.go.id` | `bi.go.id`* | `ahu.go.id`; listed firms at `idx.co.id`* | `putusan3.mahkamahagung.go.id`* |

### Indonesia in detail

Search in Indonesian (`lang: "id"`) and in the source's own vocabulary. Domains below were checked to answer in
November 2026; some refuse automated fetches (marked *): read those with the `browser-automation` skill.

| Need | Where |
|---|---|
| Laws and regulations (UU, PP, Perpres, Permen, Perda) | `peraturan.bpk.go.id` (JDIH BPK, full text and status: *dicabut*, *diubah*), `peraturan.go.id`, the ministry's own `jdih.<ministry>.go.id` |
| Court decisions | `putusan3.mahkamahagung.go.id`* |
| Statistics: inflation, population, poverty, GDP, trade | `bps.go.id` (BPS): tables and the "Berita Resmi Statistik" releases; regional BPS at `<daerah>.bps.go.id` |
| Monetary: BI rate, exchange rates (JISDOR), inflation targets | `bi.go.id`* (Bank Indonesia) |
| Financial licences: banks, insurers, *pinjol*, investment products | `ojk.go.id`: its lists of licensed firms; its warnings on illegal ones |
| Government datasets | `data.go.id` (Satu Data Indonesia), and each ministry's open-data page |
| Companies: registration, owners | `ahu.go.id` (Kemenkumham AHU); listed companies' reports at `idx.co.id`* |
| Food, drug, cosmetic registration | `cekbpom.pom.go.id` |
| Taxes | `pajak.go.id`, and the regulation itself |
| Indonesian research | `garuda.kemdiktisaintek.go.id` (Garuda), SINTA*, university repositories (`repository.<univ>.ac.id`) |
| Fact checks | `cekfakta.com`, `turnbackhoax.id` (Mafindo), and the newspapers' own *cek fakta* sections |
| Data journalism | `databoks.katadata.co.id` (charts that name their source): cite that source, after checking it |
| News | Kompas, Tempo, Antara (the state news agency, for official positions), Detik, CNBC Indonesia, Kontan and Bisnis.com (business), Tirto, The Jakarta Post (English) |

Other countries have the same depth: when a topic needs one, build the same table for it from the kinds above.

Watch for, in any country:

- **Rules change by amendment.** A law's database page states whether it is in force, amended or repealed, in the
  law's language ("amended by", "repealed"; "geändert durch", "aufgehoben"; "diubah", "dicabut"). Check it before
  relying on one.
- **Advertorials look like news**: "sponsored", "advertorial", "paid partnership", and the local words for them.
- **Numbers and dates are written the local way.** `1.234.567,89` (much of Europe, Latin America, Indonesia) and
  `1,234,567.89` (US, UK) are the same number; `12,34,567` is Indian grouping; short words for big numbers differ:
  an Indonesian `M` (miliar) is a billion, a Spanish `M` a million. `03/04/2026` is 3 April in most of the world and
  March 4 in the US. Convert to the person's convention in the report, consistently.
- **Month names** in the page's language (Maret, März, mars): read them as dates, and write the date in the
  person's language.

## 4. Science, technology, health

| Need | Where |
|---|---|
| papers | `web_search` with `sources: ["papers"]` (arXiv); OpenAlex API (`https://api.openalex.org/works?search=<terms>&per-page=10`, JSON, no key); Crossref (`https://api.crossref.org/works?query=<terms>&rows=10`) to confirm a DOI, title, authors and year |
| health | WHO, the national health ministry, Cochrane reviews, the paper itself; a news story about one study is weak evidence |
| software | the project's docs, changelog, release notes, issue tracker; `sources: ["code"]` |
| standards | the standards body (ISO, IETF RFCs at `rfc-editor.org`, W3C) |

Before citing a paper, confirm it exists and says what you say: its DOI resolves (`https://doi.org/<doi>`), and the
claim is in its abstract or text, not only in an article about it. One study is one study: say its size and kind
(a survey of 200 people, a trial, a model) when the claim rests on it.

## 5. When the page will not come

| What happens | Do |
|---|---|
| `web_fetch` returns bytes beginning `%PDF` or noise | it is a PDF: `curl -fsSL --max-time 60 -o "$TMPDIR/src/x.pdf" URL`, then the `document-reading` skill's `doc.py extract` and `grep -n` |
| empty page, "enable JavaScript", a cookie wall, HTTP 403 | the `browser-automation` skill; HTTP 403 from a government site is often a bot guard, not a missing page |
| paywall | the same fact elsewhere (the primary is usually free); a press release; an abstract (say that you read only the abstract) |
| 404, or the page changed | `https://archive.org/wayback/available?url=<url>` names the latest snapshot; cite the snapshot URL with its date |
| `[Truncated at the 200KB fetch cap…]` | a more specific URL (a section, a chapter); or download the page with `curl` to a file and `grep -n` it |
| `fallback: answered by …` under search results | the search ran on a fallback backend, results are thinner: search again with different words before concluding there is nothing |
| a CAPTCHA | stop and tell the person; do not try to get around it |

## 6. Recency

| Kind of fact | Too old after (a rule of thumb, not a law) |
|---|---|
| prices, exchange rates, tariffs, interest rates | weeks to months; give the date with the figure |
| software versions, APIs, product features | months |
| regulations | until amended; check the status, whatever the age |
| statistics | until the next release; use the latest period published and name it |
| science | years, but a newer review or a retraction overrides an older paper |
| history, definitions | rarely |

Write the date the source gives next to every figure that changes. Where the newest available figure is old, say so:
"the latest published is for 2024".
