import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

describe('self-hosted fonts', () => {
  const stylesPath = resolve(__dirname, 'styles.css');
  const publicFontsDir = resolve(__dirname, '../public/fonts');
  const headersPath = resolve(__dirname, '../public/_headers');
  const stylesContent = readFileSync(stylesPath, 'utf8');

  it('does not contain any external Google Fonts stylesheet or asset imports', () => {
    expect(stylesContent).not.toContain('fonts.googleapis.com');
    expect(stylesContent).not.toContain('fonts.gstatic.com');
  });

  it('defines @font-face rules with font-display: swap for required font families and weights', () => {
    expect(stylesContent).toContain("font-family: 'Inter'");
    expect(stylesContent).toContain("font-family: 'JetBrains Mono'");
    expect(stylesContent).toContain("font-family: 'Space Grotesk'");
    expect(stylesContent).toContain('font-display: swap');

    // Inter 400, 500, 600
    expect(stylesContent).toMatch(/font-family:\s*'Inter'[\s\S]*?font-weight:\s*400/);
    expect(stylesContent).toMatch(/font-family:\s*'Inter'[\s\S]*?font-weight:\s*500/);
    expect(stylesContent).toMatch(/font-family:\s*'Inter'[\s\S]*?font-weight:\s*600/);

    // JetBrains Mono 400, 500, 600
    expect(stylesContent).toMatch(/font-family:\s*'JetBrains Mono'[\s\S]*?font-weight:\s*400/);
    expect(stylesContent).toMatch(/font-family:\s*'JetBrains Mono'[\s\S]*?font-weight:\s*500/);
    expect(stylesContent).toMatch(/font-family:\s*'JetBrains Mono'[\s\S]*?font-weight:\s*600/);

    // Space Grotesk 500, 600
    expect(stylesContent).toMatch(/font-family:\s*'Space Grotesk'[\s\S]*?font-weight:\s*500/);
    expect(stylesContent).toMatch(/font-family:\s*'Space Grotesk'[\s\S]*?font-weight:\s*600/);
  });

  it('all referenced local font files exist in public/fonts', () => {
    const fontUrlRegex = /url\('\/fonts\/([^']+)'\)/g;
    const matches = [...stylesContent.matchAll(fontUrlRegex)];
    expect(matches.length).toBeGreaterThan(0);

    const referencedFiles = new Set(
      matches
        .map((m) => m[1])
        .filter((file): file is string => typeof file === 'string' && file.length > 0),
    );
    for (const filename of referencedFiles) {
      const filePath = resolve(publicFontsDir, filename);
      expect(existsSync(filePath)).toBe(true);
    }
  });

  it('includes OFL license files for all self-hosted fonts', () => {
    expect(existsSync(resolve(publicFontsDir, 'inter-LICENSE.txt'))).toBe(true);
    expect(existsSync(resolve(publicFontsDir, 'jetbrains-mono-OFL.txt'))).toBe(true);
    expect(existsSync(resolve(publicFontsDir, 'space-grotesk-OFL.txt'))).toBe(true);
  });

  it('has CSP restricting font-src to self in _headers', () => {
    const headersContent = readFileSync(headersPath, 'utf8');
    expect(headersContent).toContain("font-src 'self'");
    expect(headersContent).not.toContain('fonts.gstatic.com');
  });
});
