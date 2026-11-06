# Analysis recipes for `doc.py query`

Every query runs on SQLite over the clean CSV (`clean.py` output) or a sheet. The table is `t`; column names are the
headers in lower case with underscores; `python3 DOC query FILE` alone lists them. Dates from `clean.py` are ISO text
(`2026-03-12`), which SQLite's date functions read directly. Run each recipe, read the result, and keep the query: it
is how the person can repeat your number.

## Totals and groups

```sql
-- the reference total: every later group must add up to this
SELECT COUNT(*) AS rows, SUM(total) AS total FROM t;

-- per group, with each group's share of the whole
SELECT city, SUM(total) AS total, COUNT(*) AS n,
       ROUND(100.0 * SUM(total) / (SELECT SUM(total) FROM t), 1) AS pct
FROM t GROUP BY city ORDER BY total DESC;

-- blanks are a group too: without COALESCE they vanish from GROUP BY results' labels and are easy to miss
SELECT COALESCE(NULLIF(city, ''), '(blank)') AS city, SUM(total) FROM t GROUP BY 1;
```

`100.0 *`, not `100 *`: integer division in SQLite drops the fraction (`7 / 2` is 3).

## Top N, and the rest

```sql
WITH g AS (SELECT product, SUM(total) AS total FROM t GROUP BY product),
     r AS (SELECT *, ROW_NUMBER() OVER (ORDER BY total DESC) AS rk FROM g)
SELECT CASE WHEN rk <= 10 THEN product ELSE 'Others' END AS product, SUM(total) AS total
FROM r GROUP BY 1 ORDER BY MIN(rk);
```

## Pivot: one row per group, one column per category

```sql
SELECT city,
       SUM(CASE WHEN product = 'Coffee' THEN total ELSE 0 END) AS coffee,
       SUM(CASE WHEN product = 'Tea'          THEN total ELSE 0 END) AS tea,
       SUM(total) AS all_products
FROM t GROUP BY city ORDER BY all_products DESC;
```

List the categories first (`SELECT DISTINCT product FROM t`) and write one line per category; a category you leave
out is missing from the row total if you add the columns up instead of using `SUM(total)`.

## Time

```sql
-- per month
SELECT strftime('%Y-%m', date) AS month, SUM(total) AS total, COUNT(*) AS n FROM t GROUP BY month ORDER BY month;

-- month-on-month change, absolute and in percent
WITH m AS (SELECT strftime('%Y-%m', date) AS month, SUM(total) AS total FROM t GROUP BY month)
SELECT month, total,
       total - LAG(total) OVER (ORDER BY month) AS change,
       ROUND(100.0 * (total - LAG(total) OVER (ORDER BY month)) / LAG(total) OVER (ORDER BY month), 1) AS pct
FROM m ORDER BY month;

-- year-on-year: the same month a year earlier
WITH m AS (SELECT strftime('%Y-%m', date) AS month, SUM(total) AS total FROM t GROUP BY month)
SELECT a.month, a.total, b.total AS last_year, ROUND(100.0 * (a.total - b.total) / b.total, 1) AS pct
FROM m a LEFT JOIN m b ON b.month = strftime('%Y-%m', date(a.month || '-01', '-1 year')) ORDER BY a.month;

-- running total
SELECT date, total, SUM(total) OVER (ORDER BY date, _row) AS running_total FROM t ORDER BY date, _row;

-- per week (starting Monday) and per weekday (0 = Sunday)
SELECT date(date, '-6 days', 'weekday 1') AS week, SUM(total) FROM t GROUP BY week ORDER BY week;
SELECT strftime('%w', date) AS weekday, SUM(total) FROM t GROUP BY weekday ORDER BY weekday;
```

Before saying something "rose" or "fell": are both periods complete? A month with data only up to the 12th is not
comparable to a full month; check `MIN(date)` and `MAX(date)` per period, and say it when the last one is
partial. Missing months do not appear in a GROUP BY at all; look at the list for gaps.

## Medians and spread

SQLite has no MEDIAN. `profile.py --columns total` prints min, max, mean and median for a whole column. Per group:

```sql
WITH r AS (SELECT city, total, ROW_NUMBER() OVER (PARTITION BY city ORDER BY total) AS i,
                  COUNT(*) OVER (PARTITION BY city) AS n FROM t WHERE total IS NOT NULL AND total != '')
SELECT city, AVG(total) AS median FROM r WHERE i IN ((n + 1) / 2, (n + 2) / 2) GROUP BY city;
```

Report a median beside an average when a few large values pull the average up (profile's `outliers` says when).

## Duplicates

```sql
-- the same ID more than once
SELECT invoice, COUNT(*) AS n, GROUP_CONCAT(_row) AS rows FROM t GROUP BY invoice HAVING n > 1;
-- keep one row per ID (the first)
SELECT * FROM t WHERE _row IN (SELECT MIN(_row) FROM t GROUP BY invoice);
```

`_row` is the row number `doc.py` adds: the CSV's line, or the sheet's row. With `clean.py --row-numbers`, the column
`source_row` is the row in the person's original file; quote that one to them.

## Joining two tables

Put both in one workbook (`xlsx_write.py both.xlsx "orders=orders.csv" "customers=customers.csv"`); the first sheet is
`t`, the others are named after their sheet, lower case with underscores.

```sql
-- 1. how many rows on each side, and is the key unique on the side you look up?
SELECT COUNT(*), COUNT(DISTINCT id) FROM customers;
-- 2. rows that find no match - they disappear from an inner JOIN without a word
SELECT COUNT(*) FROM t LEFT JOIN customers c ON c.id = t.customer_id WHERE c.id IS NULL;
-- 3. the join itself; the total must still equal t's own total
SELECT c.segment, SUM(t.total) FROM t LEFT JOIN customers c ON c.id = t.customer_id GROUP BY c.segment;
```

Keys that should match but do not: different case or spaces (`TRIM(UPPER(a)) = TRIM(UPPER(b))`), leading zeros lost in
one file (`'0' || x`), a number stored as text in one and as a number in the other (`CAST(x AS TEXT)`). Say how many
rows did not match.

## Filters that bite

- `WHERE city = 'Jakarta'` misses `'jakarta '`: clean with `--unify` first, or `TRIM(LOWER(city)) = 'jakarta'`.
- An empty cell is `''` in a CSV-backed table and NULL in a numeric column: `WHERE x IS NULL OR x = ''`.
- `BETWEEN '2026-01-01' AND '2026-03-31'` on dates with times misses the last day after midnight: use
  `date < '2026-04-01'`.
