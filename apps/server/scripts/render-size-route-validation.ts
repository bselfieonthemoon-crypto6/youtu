// Explicit deterministic layout experiment, preserving complete AI inputs.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp from 'sharp';
const root='../../artifacts';
const out=`${root}/size-route-validation-20260915`;
await mkdir(out,{recursive:false});
const posterPath='../small-transparent-poster-1789446946495-route-check-poster/result.png';
const assetPath='../small-transparent-poster-1789446946495-route-check-asset/result.png';
const poster=await readFile(`${out}/${posterPath}`),asset=await readFile(`${out}/${assetPath}`);
const posterResult=await sharp(poster).resize(320,270,{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer();
await writeFile(`${out}/poster-320x270.png`,posterResult);
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="70" viewBox="0 0 1280 280"><rect width="1280" height="280" fill="#eed49d"/><rect x="12" y="12" width="1256" height="256" fill="none" stroke="#8c301f" stroke-width="5"/><rect x="24" y="24" width="1232" height="232" fill="none" stroke="#b47b44" stroke-width="2"/><path d="M68 58H816 M68 222H816" stroke="#b47b44" stroke-width="3"/><text x="65" y="198" font-family="KaiTi,SimSun,serif" font-size="176" font-weight="bold" fill="#951f16">回家吃饭</text><image x="944" y="12" width="256" height="256" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${asset.toString('base64')}"/></svg>`;
await writeFile(`${out}/banner-editable.svg`,svg);
await sharp(Buffer.from(svg),{density:288}).resize(320,70).png().toFile(`${out}/banner-320x70.png`);
const checks=[];
for(const [name,w,h] of [['poster-320x270.png',320,270],['banner-320x70.png',320,70]] as const){const m=await sharp(`${out}/${name}`).metadata();assert.equal(m.width,w);assert.equal(m.height,h);checks.push({name,width:m.width,height:m.height});}
await writeFile(`${out}/validation.json`,JSON.stringify({checks,poster:{source:[1280,1088],method:'contain; entire image; integer rounding',expectedContent:[318,270],transparentPadding:'1px left and right'},banner:{source:[1024,1024],method:'full asset uniformly scaled to 64x64; vector background and text; no crop',layout:'320x70',opaqueBackground:true},productChanges:false},null,2));
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>两条尺寸路线验证</title><style>body{font:16px system-ui;margin:32px auto;max-width:1000px;color:#222}img{background:repeating-conic-gradient(#ddd 0% 25%,#fff 0% 50%) 0/16px 16px;max-width:100%;height:auto}.large{width:960px}section{padding:20px;border:1px solid #ddd;margin:20px 0}</style><h1>尺寸路线验证</h1><p>两次项目 images/generations 调用，gpt-image-2.5-flare，low，各一张无重试。原始图片不改动，以下成品使用明确的程序缩放/排版；不是声称 AI 原生输出了小尺寸。</p><section><h2>320×270：完整场景等比例缩小</h2><img src="poster-320x270.png" width="320" height="270"><p>原始1280×1088；contain等比缩小，内容约318×270，两侧各1像素透明留边。未裁切内容；像素栅格有取整。</p><a href="${posterPath}">AI 原图</a> · <a href="../small-transparent-poster-1789446946495-route-check-poster/request.json">提示词与参数</a></section><section><h2>320×70：精确画布排版</h2><p>实际尺寸</p><img src="banner-320x70.png" width="320" height="70"><p>放大查看（不是另一张图）</p><img class="large" src="banner-320x70.png"><p>暖色背景和标题由程序排版，完整1024×1024透明饭菜素材等比缩为64×64。背景为不透明；此路线不再要求整幅AI场景铺满。素材位置与标题可在SVG修改。</p><a href="${assetPath}">AI 透明素材原图</a> · <a href="../small-transparent-poster-1789446946495-route-check-asset/request.json">提示词与参数</a> · <a href="banner-editable.svg">可编辑SVG</a></section><a href="validation.json">尺寸检查记录</a></html>`;
await writeFile(`${out}/index.html`,html);
console.log(JSON.stringify({out,checks}));
