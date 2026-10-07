ALTER TABLE "status_pages" ADD COLUMN "font_family" text NOT NULL DEFAULT 'josefin-sans';
ALTER TABLE "status_pages" ADD CONSTRAINT "status_pages_font_family_valid"
  CHECK ("font_family" IN ('josefin-sans', 'rubik', 'roboto', 'open-sans', 'inter', 'dm-sans', 'poppins', 'nunito', 'ubuntu', 'helvetica'));
