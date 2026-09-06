// Normalize inert legacy headers only; callers must still run the upload validator.
export function normalizeLocalDesignFile(bytes, extension) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return {bytes,mime:'image/png',extension:'.png'};
  if (bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return {bytes,mime:'image/jpeg',extension:'.jpeg'};
  if (bytes.subarray(0,4).toString()==='RIFF' && bytes.subarray(8,12).toString()==='WEBP') return {bytes,mime:'image/webp',extension:'.webp'};
  if (extension==='.svg') {
    let source=bytes.toString('utf8');
    if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(source)) throw Error('SVG entity declarations are not supported');
    // Do not resolve the external DTD. Remove only its inert declaration.
    source=source.replace(/<!DOCTYPE\s+svg\s+(?:PUBLIC\s+"[^"]*"\s+"[^"]*"|SYSTEM\s+"[^"]*")\s*>/i,'');
    source=source.replace(/^\uFEFF/,'').replace(/^\s*<\?xml[^>]*>/,'');
    while (/^\s*<!--/.test(source)) {
      const match=source.match(/^\s*<!--[\s\S]*?-->/);
      if (!match) throw Error('Unterminated SVG header comment');
      source=source.slice(match[0].length);
    }
    return {bytes:Buffer.from(source.trimStart()),mime:'image/svg+xml',extension:'.svg'};
  }
  const mime={'.ttf':'font/ttf','.otf':'font/otf','.woff':'font/woff','.woff2':'font/woff2'}[extension];
  if (!mime) throw Error('Unsupported local resource format: '+extension);
  return {bytes,mime,extension};
}
