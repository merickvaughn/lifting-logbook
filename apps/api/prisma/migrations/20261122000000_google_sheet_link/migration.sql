-- Link a Google Sheet (#1432), as approved in ADR-047's "Migration outline": one link per user,
-- with the refresh token envelope-encrypted under google-oauth-token-kek, and one pending OAuth
-- request per user. No existing table changes.
--
-- RLS: both tables are ENABLE and FORCE ROW LEVEL SECURITY with the usual userId isolation
-- policy, and lifting_app gets SELECT, INSERT, UPDATE, DELETE on each (the default privileges in
-- 20260611000000 already give it these; the grants are stated here so the table reads whole).
--
-- Deploy ordering: this runs in the Cloud Run migration job ahead of the new API revision
-- (ADR-027). The old API doesn't read either table.
--
-- Rollback: DROP TABLE "google_oauth_request"; DROP TABLE "google_sheet_link"; DROP TYPE
-- "google_sheet_link_status". A linked lifter then loses the link and links again; the tokens left
-- at Google expire after six months unused.

-- CreateEnum
CREATE TYPE "google_sheet_link_status" AS ENUM ('linked', 'needs_relink', 'sheet_missing');

-- CreateTable
CREATE TABLE "google_sheet_link" (
    "userId" TEXT NOT NULL,
    "status" "google_sheet_link_status" NOT NULL,
    "spreadsheetId" TEXT NOT NULL,
    "spreadsheetUrl" TEXT NOT NULL,
    "grantedScope" TEXT NOT NULL,
    "refreshTokenCiphertext" BYTEA,
    "refreshTokenDekCiphertext" BYTEA,
    "refreshTokenNonce" BYTEA,
    "lastMirroredSeq" INTEGER,
    "lastMirroredAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "mirrorLeaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_sheet_link_pkey" PRIMARY KEY ("userId"),
    -- linked and sheet_missing keep the token (decision 12 reuses it); needs_relink has none.
    CONSTRAINT "google_sheet_link_token_check" CHECK (
      CASE "status"
        WHEN 'needs_relink' THEN "refreshTokenCiphertext" IS NULL AND "refreshTokenDekCiphertext" IS NULL
          AND "refreshTokenNonce" IS NULL
        ELSE "refreshTokenCiphertext" IS NOT NULL AND "refreshTokenDekCiphertext" IS NOT NULL
          AND "refreshTokenNonce" IS NOT NULL
      END
    )
);

-- CreateTable
CREATE TABLE "google_oauth_request" (
    "userId" TEXT NOT NULL,
    "stateHash" BYTEA NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "google_oauth_request_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "google_sheet_link" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "google_sheet_link" FORCE ROW LEVEL SECURITY;
CREATE POLICY "google_sheet_link_user_isolation" ON "google_sheet_link"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "google_oauth_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "google_oauth_request" FORCE ROW LEVEL SECURITY;
CREATE POLICY "google_oauth_request_user_isolation" ON "google_oauth_request"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "google_sheet_link" TO "lifting_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "google_oauth_request" TO "lifting_app";
