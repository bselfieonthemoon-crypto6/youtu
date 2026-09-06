import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeLocalDesignFile as normalize} from './local-design-file-format.mjs';
import {inspectImportBuffer} from '../apps/server/src/features/design-resources/design-resource-import-service.ts';

test('uses file signature instead of a misleading JPEG suffix',()=>{
 const bytes=Buffer.from([137,80,78,71,13,10,26,10]);
 assert.equal(normalize(bytes,'.jpeg').mime,'image/png');
 assert.equal(normalize(bytes,'.jpeg').bytes,bytes);
});
test('legacy external SVG DTD is removed without fetching it',async()=>{
 const raw=Buffer.from('<?xml version="1.0"?><!DOCTYPE svg PUBLIC "old" "https://example.invalid/old.dtd"><!-- generator --><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
 const result=normalize(raw,'.svg');
 assert.ok(result.bytes.toString().startsWith('<svg'));
 assert.ok(raw.toString().includes('DOCTYPE'));
 assert.equal((await inspectImportBuffer(result.bytes,result.mime)).kind,'svg');
});
test('rejects internal entities instead of expanding them',()=>{
 assert.throws(()=>normalize(Buffer.from('<!DOCTYPE svg [<!ENTITY x "bad">]><svg/>'),'.svg'),/entity/);
});
test('an incomplete comment terminates with an error',()=>{
 assert.throws(()=>normalize(Buffer.from('<!-- unfinished'),'.svg'),/Unterminated/);
});
test('normalization does not bypass active SVG validation',async()=>{
 const result=normalize(Buffer.from('<!-- header --><svg width="10" height="10"><script>alert(1)</script></svg>'),'.svg');
 await assert.rejects(inspectImportBuffer(result.bytes,result.mime),/active content/);
});
test('external SVG image references remain forbidden',async()=>{
 const result=normalize(Buffer.from('<svg width="10" height="10"><image href="https://example.invalid/a.png"/></svg>'),'.svg');
 await assert.rejects(inspectImportBuffer(result.bytes,result.mime),/active content/);
});
