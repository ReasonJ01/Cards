-- Optional domain model: topic-level prerequisite links. Visual only.
CREATE TABLE IF NOT EXISTS links (topic TEXT NOT NULL, requires TEXT NOT NULL, PRIMARY KEY (topic, requires));
