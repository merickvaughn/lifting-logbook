-- Supplements 3/9 (#1375): the catalog entry an item was created from, and a snapshot of that
-- entry's read-only reference content, copied at creation. Both stay NULL on existing rows and on
-- items not created from the catalog. RLS on supplement_item already covers the new columns.
ALTER TABLE "supplement_item" ADD COLUMN "catalogKey" TEXT,
ADD COLUMN "reference" JSONB;
