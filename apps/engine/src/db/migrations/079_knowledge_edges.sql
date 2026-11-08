-- 0.8.23: the memory graph's conversation→document and document→tag edges (KNOWLEDGE_BASE §12). The documents a
-- conversation opened are kept on its episode file (`documents:`) when it is filed, and here for the graph; a
-- document's frontmatter `tags:` are kept when it is read. The files are the truth: both are rebuilt from them.
CREATE TABLE memory_episode_documents (
  episode_id TEXT NOT NULL,
  document TEXT NOT NULL,         -- `<collection>/<path>`, as the knowledge index keys a document
  PRIMARY KEY (episode_id, document)
) WITHOUT ROWID;

ALTER TABLE knowledge_documents ADD COLUMN tags TEXT;  -- a JSON list: what a text document's frontmatter tags it with

-- Read once more at the next sync, so a document kept before this has its tags: only what can carry frontmatter.
UPDATE knowledge_documents SET mtime = 0 WHERE lower(substr(path, -3)) = '.md' OR lower(substr(path, -9)) = '.markdown' OR lower(substr(path, -4)) = '.txt';
