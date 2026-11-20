-- Supplements (#1372, #1374): day types, items, doses, mix parts and an append-only change log,
-- plus the caffeine cutoff on user_settings. See docs/adr/ADR-046-supplement-storage.md.

-- AlterTable
ALTER TABLE "user_settings" ADD COLUMN     "supplementCaffeineCutoff" TEXT;

-- CreateTable
CREATE TABLE "supplement_day_type" (
    "userId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sessionTime" TEXT,
    "position" INTEGER NOT NULL,

    CONSTRAINT "supplement_day_type_pkey" PRIMARY KEY ("userId","id")
);

-- CreateTable
CREATE TABLE "supplement_item" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyCompound" TEXT NOT NULL,
    "timing" TEXT NOT NULL,
    "shortNote" TEXT NOT NULL,
    "longNote" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "unverified" BOOLEAN NOT NULL,
    "links" TEXT[],
    "ingredients" JSONB NOT NULL,
    "isMix" BOOLEAN NOT NULL,
    "foldedInto" TEXT,
    "position" INTEGER NOT NULL,

    CONSTRAINT "supplement_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplement_dose" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "slot" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "servings" DOUBLE PRECISION NOT NULL,
    "dayTypes" TEXT[],

    CONSTRAINT "supplement_dose_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplement_mix_part" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mixId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "partItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ingredients" JSONB NOT NULL,

    CONSTRAINT "supplement_mix_part_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplement_change" (
    "userId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplement_change_pkey" PRIMARY KEY ("userId","seq")
);

-- CreateIndex
CREATE INDEX "supplement_item_userId_idx" ON "supplement_item"("userId");

-- CreateIndex
CREATE INDEX "supplement_dose_userId_idx" ON "supplement_dose"("userId");

-- CreateIndex
CREATE INDEX "supplement_dose_itemId_idx" ON "supplement_dose"("itemId");

-- CreateIndex
CREATE INDEX "supplement_mix_part_userId_idx" ON "supplement_mix_part"("userId");

-- CreateIndex
CREATE INDEX "supplement_mix_part_mixId_idx" ON "supplement_mix_part"("mixId");

-- AddForeignKey
ALTER TABLE "supplement_dose" ADD CONSTRAINT "supplement_dose_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "supplement_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplement_mix_part" ADD CONSTRAINT "supplement_mix_part_mixId_fkey" FOREIGN KEY ("mixId") REFERENCES "supplement_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddConstraint: the lists match packages/types/src/supplements.ts.
ALTER TABLE "supplement_item"
  ADD CONSTRAINT "supplement_item_status_check" CHECK ("status" IN ('active', 'pending'));
ALTER TABLE "supplement_dose"
  ADD CONSTRAINT "supplement_dose_slot_check" CHECK ("slot" IN ('pre', 'intra', 'post', 'all', 'am', 'noon', 'pm'));
ALTER TABLE "supplement_change"
  ADD CONSTRAINT "supplement_change_type_check" CHECK ("type" IN ('added', 'edited', 'moved', 'started',
    'moved_to_pending', 'removed', 'restored', 'confirmed', 'mix_created', 'folded_into_mix', 'mix_split'));

-- EnableRLS
ALTER TABLE "supplement_day_type" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplement_day_type" FORCE ROW LEVEL SECURITY;
CREATE POLICY "supplement_day_type_user_isolation" ON "supplement_day_type"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "supplement_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplement_item" FORCE ROW LEVEL SECURITY;
CREATE POLICY "supplement_item_user_isolation" ON "supplement_item"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "supplement_dose" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplement_dose" FORCE ROW LEVEL SECURITY;
CREATE POLICY "supplement_dose_user_isolation" ON "supplement_dose"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "supplement_mix_part" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplement_mix_part" FORCE ROW LEVEL SECURITY;
CREATE POLICY "supplement_mix_part_user_isolation" ON "supplement_mix_part"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "supplement_change" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplement_change" FORCE ROW LEVEL SECURITY;
CREATE POLICY "supplement_change_user_isolation" ON "supplement_change"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

