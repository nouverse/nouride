-- 0.8.20: the knowledge base (KNOWLEDGE_BASE §4 to §8 in the private RFCs). A document is a file in a collection, a
-- folder under `.nouride/knowledge/`; its sections are the items memory's word index (`memory_fts`) and its vectors
-- (`memory_vectors`) know as `knowledge:<collection>/<path>#<n>`. The files are the truth: both tables are rebuilt
-- from them, and a row whose file is gone is dropped.
CREATE TABLE knowledge_documents (
  collection TEXT NOT NULL,       -- the folder's name under `.nouride/knowledge/`
  path TEXT NOT NULL,             -- the file, relative to the collection's folder, with `/` between its parts
  size INTEGER NOT NULL,          -- bytes, as last seen: with `mtime`, what says the file changed without reading it
  mtime INTEGER NOT NULL,         -- epoch ms, as last seen
  title TEXT NOT NULL,            -- its first heading, else its file name without the extension
  status TEXT NOT NULL,           -- 'indexed', 'unreadable' (`reason` says why), or 'listed' (a kind not read: a picture)
  reason TEXT,                    -- why it is not indexed, in a sentence a person reads
  needs TEXT,                     -- the package that would read it, when one is missing (`poppler-utils`): asked for on the page
  sections INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL,    -- epoch ms
  PRIMARY KEY (collection, path)
) WITHOUT ROWID;

CREATE TABLE knowledge_sections (
  item TEXT PRIMARY KEY,          -- `knowledge:<collection>/<path>#<n>`, the id memory's index and vectors know it by
  collection TEXT NOT NULL,
  path TEXT NOT NULL,
  n INTEGER NOT NULL,             -- its place in the document, from 0
  trail TEXT NOT NULL,            -- the document's title and the headings above it: `Expense policy › Travel › Hotels`
  page_from INTEGER,              -- a PDF's pages it spans; null elsewhere
  page_to INTEGER,
  text TEXT NOT NULL              -- the words, as search and `memory_read` show them
) WITHOUT ROWID;

CREATE INDEX knowledge_sections_document ON knowledge_sections (collection, path, n);
