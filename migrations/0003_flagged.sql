-- Cards the owner flagged while reviewing (e.g. poorly written).
ALTER TABLE cards ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0;
