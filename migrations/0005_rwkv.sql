ALTER TABLE reviews ADD COLUMN duration INTEGER;
ALTER TABLE reviews ADD COLUMN shown INTEGER;
CREATE INDEX IF NOT EXISTS reviews_ts ON reviews(ts);
CREATE INDEX IF NOT EXISTS reviews_event ON reviews(card_id, ts, grade);
