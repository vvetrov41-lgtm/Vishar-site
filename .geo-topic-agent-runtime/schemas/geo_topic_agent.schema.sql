CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  domain TEXT,
  brand TEXT,
  language TEXT,
  target_goal TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY,
  project_id INTEGER,
  topic TEXT,
  slug TEXT,
  status TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS fanout_queries (
  id INTEGER PRIMARY KEY,
  topic_id INTEGER,
  source_query TEXT,
  fanout_query TEXT,
  branch TEXT,
  priority TEXT,
  evidence_ref TEXT
);

CREATE TABLE IF NOT EXISTS serp_results (
  id INTEGER PRIMARY KEY,
  topic_id INTEGER,
  query TEXT,
  engine TEXT,
  position INTEGER,
  url TEXT,
  title TEXT,
  snippet TEXT,
  cited_in_ai INTEGER DEFAULT 0,
  evidence_ref TEXT
);

CREATE TABLE IF NOT EXISTS ai_answers (
  id INTEGER PRIMARY KEY,
  topic_id INTEGER,
  prompt TEXT,
  provider TEXT,
  model TEXT,
  answer_text TEXT,
  citation_url TEXT,
  citation_title TEXT,
  brand_mentioned INTEGER DEFAULT 0,
  project_url_cited INTEGER DEFAULT 0,
  evidence_ref TEXT
);

CREATE TABLE IF NOT EXISTS placement_opportunities (
  id INTEGER PRIMARY KEY,
  topic_id INTEGER,
  url TEXT,
  domain TEXT,
  opportunity_type TEXT,
  rationale TEXT,
  priority TEXT,
  evidence_ref TEXT
);

