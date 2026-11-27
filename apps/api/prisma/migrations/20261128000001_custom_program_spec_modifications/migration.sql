-- The lift modifications a program slot starts with on (#1155). Ids, like lift_record.modifications.
ALTER TABLE "custom_program_spec" ADD COLUMN "modifications" TEXT[] DEFAULT ARRAY[]::TEXT[];
