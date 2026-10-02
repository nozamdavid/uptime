ALTER TABLE "monitors" DROP CONSTRAINT "monitors_public_slug_format";
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_public_slug_format"
  CHECK (
    "public_slug" IS NULL OR (
      length("public_slug") BETWEEN 3 AND 64
      AND "public_slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    )
  );
