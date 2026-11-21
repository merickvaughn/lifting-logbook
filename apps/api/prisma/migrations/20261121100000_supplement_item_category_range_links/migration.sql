-- Supplements 5a/9 (#1409): the lifter's own category and typical range, and labelled product
-- links. `links` goes from text[] to jsonb [{label, url}], keeping every URL in order with an
-- empty label. Row-level security on supplement_item is unchanged: it is per table, not per column,
-- so the new and replaced columns are covered, and no policy or grant is touched.
ALTER TABLE "supplement_item" ADD COLUMN "category" TEXT NOT NULL DEFAULT '',
ADD COLUMN "typicalRange" TEXT NOT NULL DEFAULT '',
ADD COLUMN "links_json" JSONB NOT NULL DEFAULT '[]';

UPDATE "supplement_item" AS i
SET "links_json" = COALESCE(
  (SELECT jsonb_agg(jsonb_build_object('label', '', 'url', u.url) ORDER BY u.ord)
   FROM unnest(i."links") WITH ORDINALITY AS u(url, ord)),
  '[]'::jsonb);

ALTER TABLE "supplement_item" DROP COLUMN "links";
ALTER TABLE "supplement_item" RENAME COLUMN "links_json" TO "links";
