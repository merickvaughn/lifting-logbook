-- CreateTable
CREATE TABLE "body_weight" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "program" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "body_weight_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "body_weight_userId_program_idx" ON "body_weight"("userId", "program");

-- AddConstraint: enforce valid unit values at the DB layer (mirrors strength_goal_unit_check)
ALTER TABLE "body_weight"
  ADD CONSTRAINT "body_weight_unit_check" CHECK ("unit" IN ('lbs', 'kg'));

-- EnableRLS
ALTER TABLE "body_weight" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "body_weight" FORCE ROW LEVEL SECURITY;
CREATE POLICY "body_weight_user_isolation" ON "body_weight"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));
