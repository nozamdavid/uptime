ALTER TABLE "monitors" ADD COLUMN "public_slug" text;
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_public_slug_format"
  CHECK ("public_slug" IS NULL OR "public_slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_public_slug_unique" UNIQUE("public_slug");
