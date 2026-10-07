ALTER TABLE {{schema}}.status_pages
  ADD COLUMN font_family TEXT NOT NULL DEFAULT 'josefin-sans'
  CONSTRAINT status_pages_font_family_valid CHECK (
    font_family IN ('josefin-sans', 'rubik', 'roboto', 'open-sans', 'inter', 'dm-sans', 'poppins', 'nunito', 'ubuntu', 'helvetica')
  );
