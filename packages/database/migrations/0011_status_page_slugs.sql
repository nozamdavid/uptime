ALTER TABLE "status_pages" ADD COLUMN "public_slug" text;
ALTER TABLE "status_pages" ADD CONSTRAINT "status_pages_public_slug_format"
  CHECK (
    "public_slug" IS NULL OR (
      length("public_slug") BETWEEN 3 AND 64
      AND "public_slug" ~ '^[a-z0-9]+([.-][a-z0-9]+)*$'
    )
  );
ALTER TABLE "status_pages" ADD CONSTRAINT "status_pages_public_slug_unique" UNIQUE("public_slug");
