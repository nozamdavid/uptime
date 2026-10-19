// Applies the saved font and theme before first paint. Kept out of index.html so the
// Content-Security-Policy can stay `script-src 'self'`.
try {
  const savedFont = localStorage.getItem('uptime.fontFamily');
  const fonts = ['josefin-sans', 'rubik', 'roboto', 'open-sans', 'inter', 'dm-sans', 'poppins', 'nunito', 'ubuntu', 'helvetica'];
  document.documentElement.dataset.font = fonts.includes(savedFont) ? savedFont : 'josefin-sans';
  const savedTheme = localStorage.getItem('uptime.theme');
  const dark = savedTheme === 'dark' ||
    (savedTheme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
} catch {
  document.documentElement.dataset.font = 'josefin-sans';
  document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark' : 'light';
}
