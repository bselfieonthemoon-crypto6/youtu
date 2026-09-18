import {mkdir,copyFile,writeFile} from 'node:fs/promises';
import sharp from 'sharp';
import assert from 'node:assert/strict';
const dir='../../artifacts/ai-gold-banner-320x70-20260915';
await mkdir(dir,{recursive:false});
const background='C:/Users/lenovo/.codex/generated_images/01a05cc2-e6f6-7681-a19d-0830665ac6fd/exec-ae3429a1-7d48-47a4-898b-fbe717d8386e.png';
const subject='C:/Users/lenovo/AppData/Local/Temp/codex-clipboard-ad56eccb-88b0-41bd-9984-0bf06ff2e430.webp';
await copyFile(background,`${dir}/ai-background-original.png`);
await copyFile(subject,`${dir}/subject-original.webp`);
// Crop only the background. Work at 4x final resolution for smooth downsampling.
const bg=await sharp(background).resize(1280,280,{fit:'cover',position:'centre'}).png().toBuffer();
const fg=await sharp(subject).resize(342,280,{fit:'inside'}).png().toBuffer();
const fm=await sharp(fg).metadata();
await sharp(bg).composite([{input:fg,left:1280-fm.width!-12,top:Math.floor((280-fm.height!)/2)}]).png().toFile(`${dir}/composite-4x.png`);
await sharp(`${dir}/composite-4x.png`).resize(320,70).png().toFile(`${dir}/result.png`);
const m=await sharp(`${dir}/result.png`).metadata();assert.equal(m.width,320);assert.equal(m.height,70);
await writeFile(`${dir}/index.html`,'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>AI游戏主题横额</title><style>body{font:16px system-ui;margin:40px auto;max-width:1000px;color:#222}img{max-width:100%;height:auto}</style><h1>AI背景＋原素材 · 320×70</h1><p>实际尺寸</p><img src="result.png" width="320" height="70"><p>放大预览</p><img src="composite-4x.png" width="960"><p>背景由内置imagegen生成；经确认仅裁掉背景上下部分以铺满横额。右侧为上传原素材，完整等比缩小，无新增文字。没有重新生成人物。</p><a href="result.png">下载320×70 PNG</a> · <a href="ai-background-original.png">AI背景原图</a> · <a href="subject-original.webp">上传原素材</a></html>');
console.log(JSON.stringify({dir,width:m.width,height:m.height,background:'cover centre crop',subject:'contain, full image, original alpha'}));
