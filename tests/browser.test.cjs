const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {html}=require('./runtime.cjs');
let server,browser,url;
const usage={prompt_tokens:1000,prompt_cache_hit_tokens:200,completion_tokens:300};
const reply=(content,extra={})=>({choices:[{message:{content:typeof content==='string'?content:JSON.stringify(content)},finish_reason:'stop'}],usage,...extra});
before(async()=>{
  server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end(html);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:process.platform==='win32'?{channel:'msedge'}:{})});
});
after(async()=>{await browser?.close();await new Promise(r=>server?.close(r));});
async function pageFixture(viewport={width:1440,height:1000}){
  const context=await browser.newContext({viewport}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await context.addInitScript(()=>localStorage.setItem('ds_api_key','sk-test-only'));
  await page.route('https://api.deepseek.com/**',route=>route.abort()); // Every test explicitly mocks any API it needs.
  await page.goto(url);return {page,context,errors};
}
async function article(page,text='He is a rare bird.'){
  await page.evaluate(text=>{state.articleCacheKey=cacheKeyFor(text);$('#articleInput').value=text;loadResult([{text,para:0,data:{segments:[{text,type:'subject',note:'test'}],clauses:[],gloss:[{w:'rare bird',t:'罕见的人',pos:'phr.'}],vocab:[{w:'rare bird',t:'罕见的人',pos:'phr.'}],trans:'他是个罕见的人。'}}]);},text);
}

test('independent lookup works without an article / API key and collects local dictionary entries',async()=>{
  const {page,context,errors}=await pageFixture();let calls=0;page.on('request',req=>{if(req.url().includes('api.deepseek.com'))calls++;});
  try{
    await page.evaluate(()=>state.apiKey='');await page.locator('#lookupBtn').click();await page.locator('#lookupInput').fill('brought');await page.locator('#lookupInput').press('Enter');
    await page.locator('#lookupResult').getByRole('button',{name:'收藏到生词本'}).waitFor();assert.match(await page.locator('#lookupResult').innerText(),/bring/);assert.match(await page.locator('#lookupResult').innerText(),/变形/);assert.equal(calls,0);
    await page.locator('#lookupResult').getByRole('button',{name:'收藏到生词本'}).click();await page.waitForFunction(()=>vocabBook.entries.length===1);assert.equal(await page.evaluate(()=>vocabBook.entries[0].word),'brought');assert.equal(await page.evaluate(()=>vocabBook.entries[0].contexts.length),0);
    await page.locator('#lookupInput').fill('  ');await page.locator('#lookupInput').press('Enter');assert.match(await page.locator('#lookupResult').innerText(),/请输入/);assert.equal(calls,0);
    await page.locator('#lookupInput').fill('<img src=x onerror=alert(1)>');await page.locator('#lookupInput').press('Enter');await page.locator('#keyModal.show').waitFor();assert.equal(await page.locator('#lookupResult img').count(),0);assert.equal(calls,0);assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('unknown standalone phrase automatically uses AI, caches it and records word usage',async()=>{
  const {page,context,errors}=await pageFixture();let calls=0,prompt='';
  try{
    await page.unroute('https://api.deepseek.com/**');await page.route('https://api.deepseek.com/**',async route=>{calls++;prompt=route.request().postDataJSON().messages.at(-1).content;await route.fulfill({json:reply({meaning:'整条词组的释义',usage:'短语用法',examples:[]})});});
    await page.locator('#lookupBtn').click();await page.locator('#lookupInput').fill('rare zqxvlookup');await page.locator('#lookupInput').press('Enter');await page.waitForFunction(()=>wordModalMeaning==='整条词组的释义');
    assert.match(prompt,/rare zqxvlookup/);assert.match(prompt,/无上下文/);assert.equal(await page.locator('#lookupModal.show').count(),0);assert.equal(await page.evaluate(()=>usageTotals.word.requests),1);
    await page.locator('#wmCollect').click();await page.waitForFunction(()=>vocabBook.entries.length===1);assert.equal(await page.evaluate(()=>vocabBook.entries[0].meaning),'整条词组的释义');
    await page.keyboard.press('Escape');await page.locator('#lookupBtn').click();await page.locator('#lookupInput').press('Enter');await page.waitForFunction(()=>wordModalMeaning==='整条词组的释义');assert.equal(calls,1);assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('mobile lookup is reachable and its form stays in the viewport',async()=>{
  const {page,context,errors}=await pageFixture({width:390,height:844});
  try{
    await page.locator('#moreBtn').click();await page.locator('[data-act="lookup"]').click();await page.locator('#lookupInput').fill('bird');await page.locator('#lookupSubmit').click();await page.locator('#lookupResult').getByRole('button',{name:'收藏到生词本'}).waitFor();
    const rect=await page.locator('#lookupModal .modal').boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=390);assert.equal(await page.locator('#lookupSubmit').isEnabled(),true);assert.deepEqual(errors,[]);
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('#lookupModal .modal')).opacity==='1');fs.mkdirSync(path.join(__dirname,'../test-results'),{recursive:true});await page.screenshot({path:path.join(__dirname,'../test-results/mobile-lookup.png')});
    await page.keyboard.press('Escape');assert.equal(await page.locator('#lookupModal.show').count(),0);
  }finally{await context.close();}
});
test('desktop Alt-click collects clicked word in a phrase, folders persist, editing/export/backup work',async()=>{
  const {page,context,errors}=await pageFixture();
  try{
    await article(page);await page.locator('.p-num').click();
    // The phrase is one unit. Click the center of its last word by DOM range coordinates.
    const point=await page.evaluate(()=>{const w=[...document.querySelectorAll('.unit .w')].find(w=>w.textContent.includes('rare bird'));const text=w.querySelector('.unit-sym')?.firstChild||w.firstChild;const start=text.textContent.indexOf('bird');const range=document.createRange();range.setStart(text,start);range.setEnd(text,start+4);const r=range.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
    await page.keyboard.down('Alt');await page.mouse.click(point.x,point.y);await page.keyboard.up('Alt');
    await page.waitForFunction(()=>vocabBook.entries.length===1);assert.equal(await page.evaluate(()=>vocabBook.entries[0].word),'bird');assert.equal(await page.locator('#dictCard.show').count(),0);
    await page.locator('#bookBtn').click();assert.match(await page.locator('#bookEntries').innerText(),/bird/);
    page.once('dialog',d=>d.accept('真题'));await page.locator('#bookNew').click();
    const folderId=await page.evaluate(()=>vocabBook.folders.find(f=>f.name==='真题').id);
    await page.locator('#bookDefault').selectOption(folderId);await page.keyboard.press('Escape');
    await page.evaluate(()=>collectWord('bird',state.sentences[0]));await page.locator('#bookBtn').click();
    await page.locator('#bookFolders [data-folder="'+folderId+'"]').click();await page.locator('.book-entry summary').click();
    await page.locator('[data-book-meaning]').fill('罕见的人\n鸟');await page.locator('[data-book-note]').fill('<script>恶意标记</script>');await page.locator('[data-book-save]').click();
    assert.equal(await page.evaluate(()=>window['恶意标记']),undefined);
    const download=page.waitForEvent('download');await page.locator('[data-anki-export="current"]').click();const file=await download;const data=fs.readFileSync(await file.path(),'utf8');assert.match(data,/考研生词::真题/);assert.match(data,/&lt;script&gt;/);assert.match(data,/He is a rare bird/);
    const backup=page.waitForEvent('download');await page.locator('#bookBackup').click();const b=await backup;const saved=JSON.parse(fs.readFileSync(await b.path(),'utf8'));assert.equal(saved.defaultFolderId,folderId);
    saved.entries[0].note='恢复测试';page.once('dialog',d=>d.accept());await page.locator('#bookRestore').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(saved))});await page.waitForFunction(()=>vocabBook.entries[0].note==='恢复测试');
    // Clear caches and reload without rewriting the book via an init script.
    await page.evaluate(()=>clearAllCache());await page.reload();assert.equal(await page.evaluate(()=>vocabBook.defaultFolderId),folderId);assert.equal(await page.evaluate(()=>vocabBook.entries.length),2);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
test('collapsed words, dictionary collect button, AI meaning, grammar rendering and printing',async()=>{
  const {page,context,errors}=await pageFixture();
  try{
    await article(page);await page.locator('.p-word[data-w="bird"]').click();await page.waitForFunction(()=>dictState==='ready');
    await page.locator('#dictCard button').filter({hasText:'收藏到生词本'}).click();await page.waitForFunction(()=>vocabBook.entries.length===1);
    await page.unroute('https://api.deepseek.com/**');await page.route('https://api.deepseek.com/**',async route=>{const body=route.request().postDataJSON();await route.fulfill({json:reply(body.response_format?{meaning:'语境释义',usage:'用法',examples:[{en:'A bird',zh:'鸟'}]}:'## 一、句子主干\n\n**He** (他)\n\n| 成分 | 中文 |\n|---|---|\n| 主语 | 他 |')});});
    await page.evaluate(()=>explainWord('bird',state.sentences[0].text,false,state.sentences[0]));assert.match(await page.locator('#wmBody').innerText(),/语境释义/);await page.locator('#wmCollect').click();await page.waitForFunction(()=>vocabBook.entries[0].contexts.some(c=>c.meaning==='语境释义'));await page.keyboard.press('Escape');
    await page.locator('.p-num').click();await page.locator('[data-gram-run]').click();await page.waitForFunction(()=>state.sentences[0].grammar?.status==='ok');assert.equal(await page.locator('.gram-sec table').count(),1);
    await page.evaluate(()=>ensureAllBuilt());await page.emulateMedia({media:'print'});assert.equal(await page.locator('.p-detail').isVisible(),true);await page.emulateMedia({media:'screen'});
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
test('real UI partial completion, retry persistence and usage snapshots',async()=>{
  const {page,context,errors}=await pageFixture();let retry=false,calls=0;
  try{
    await page.unroute('https://api.deepseek.com/**');await page.route('https://api.deepseek.com/**',async route=>{
      calls++;const user=route.request().postDataJSON().messages.at(-1).content;
      let content;
      if(user.includes('paragraphs'))content={paragraphs:[['He works.','She left.']]};
      else content={sentences:retry?[{segments:[{text:'She left.',type:'subject'}],trans:'她离开了。'}]:[{segments:[{text:'He works.',type:'subject'}],trans:'他工作。'},null]};
      await route.fulfill({json:reply(content)});
    });
    await page.locator('#articleInput').fill('He works. She left.');await page.locator('#analyzeBtn').click();await page.waitForFunction(()=>activeTask===null && state.hasResult);
    assert.match(await page.locator('#status').innerText(),/1 句成功，1 句失败/);assert.equal(calls,2);
    retry=true;await page.locator('[data-retry]').click();await page.waitForFunction(()=>activeTask===null && state.sentences.every(s=>s.status==='ok'));
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem(state.articleCacheKey)).sentences[1].data.trans),'她离开了。');
    const before=await page.evaluate(()=>usageTotals.analysis.cost);await page.locator('#usageBtn').click();await page.locator('#ratePreset').selectOption('offpeak');await page.locator('#rateSave').click();assert.equal(await page.evaluate(()=>usageTotals.analysis.cost),before);
    assert.match(await page.locator('#usageBody').innerText(),/合计/);await page.keyboard.press('Escape');
    await page.locator('#analyzeBtn').click();assert.equal(calls,3);assert.equal(await page.evaluate(()=>usageTotals.analysis.cost),before);assert.match(await page.locator('#status').innerText(),/命中本地缓存/);assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
test('cancel in-flight split via UI and start a new task safely',async()=>{
  const {page,context,errors}=await pageFixture();let calls=0;
  try{
    await page.unroute('https://api.deepseek.com/**');await page.route('https://api.deepseek.com/**',async route=>{calls++;await new Promise(r=>setTimeout(r,1000));await route.fulfill({json:reply({paragraphs:[['He works.']]})}).catch(()=>{});});
    await page.locator('#articleInput').fill('He works.');await page.locator('#analyzeBtn').click();await page.waitForFunction(()=>activeTask!==null);await page.locator('#cancelBtn').click();await page.waitForFunction(()=>activeTask===null);
    assert.equal(calls,1);assert.equal(await page.evaluate(()=>state.sentences.length),0);assert.equal(await page.locator('#analyzeBtn').isEnabled(),true);assert.match(await page.locator('#status').innerText(),/已取消断句/);assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
test('compact OCR thumbnails reorder and automatically replace text / return to text tab',async()=>{
  const {page,context,errors}=await pageFixture();let calls=0,dialogs=0;
  page.on('dialog',async d=>{dialogs++;await d.dismiss();});
  try{
    await page.locator('#articleInput').fill('Existing article.');await page.locator('[data-tab="image"]').click();
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=','base64');
    await page.locator('#fileInput').setInputFiles([{name:'first.png',mimeType:'image/png',buffer:png},{name:'second.png',mimeType:'image/png',buffer:png}]);await page.waitForFunction(()=>imgBusy===0);
    assert.equal(await page.locator('#imgList textarea').count(),0);assert.equal(await page.locator('#ocrApply').count(),0);
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.img-item')).transform==='none');const rect=await page.locator('.img-item').first().boundingBox();assert.equal(rect.width,96);assert.equal(rect.height,96);
    await page.locator('.img-item').nth(0).dragTo(page.locator('.img-item').nth(1));assert.deepEqual(await page.evaluate(()=>state.images.map(p=>p.name)),['second.png','first.png']);
    await page.locator('.img-item').nth(0).focus();await page.keyboard.press('ArrowRight');assert.deepEqual(await page.evaluate(()=>state.images.map(p=>p.name)),['first.png','second.png']);
    await page.keyboard.press('ArrowLeft');assert.deepEqual(await page.evaluate(()=>state.images.map(p=>p.name)),['second.png','first.png']);
    await page.waitForTimeout(450);await page.locator('[data-zoom]').first().click();assert.equal(await page.locator('#zoomImage').isVisible(),true);await page.keyboard.press('Escape');
    fs.mkdirSync(path.join(__dirname,'../test-results'),{recursive:true});await page.screenshot({path:path.join(__dirname,'../test-results/desktop-ocr-simple.png')});
    await page.unroute('https://api.deepseek.com/**');await page.route('https://api.deepseek.com/**',route=>route.fulfill({json:reply(++calls===1?'Page two.':'Page one.')}));
    await page.locator('#ocrBtn').click();await page.waitForFunction(()=>activeTask===null&&state.images.every(p=>p.status==='ok'));
    assert.equal(await page.locator('#articleInput').inputValue(),'Page two.\n\nPage one.');assert.equal(await page.locator('#tabText').isVisible(),true);assert.equal(await page.locator('#tabImage').isVisible(),false);assert.equal(dialogs,0);assert.equal(calls,2);assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('partial OCR failure leaves original text and global retry only fills missing images',async()=>{
  const {page,context,errors}=await pageFixture();let calls=0;
  try{
    await page.locator('#articleInput').fill('Keep original.');await page.locator('[data-tab="image"]').click();
    await page.evaluate(()=>{state.images=[{id:'one',name:'one',status:'ready',text:'',dataUrl:'data:image/png;base64,iVBORw0KGgo='},{id:'two',name:'two',status:'ready',text:'',dataUrl:'data:image/png;base64,iVBORw0KGgo='}];renderImgList();});
    await page.unroute('https://api.deepseek.com/**');await page.route('https://api.deepseek.com/**',route=>route.fulfill({json:++calls===2?{error:{message:'failed'},choices:[]}:reply(calls===1?'First.':'Second.')}));
    await page.locator('#ocrBtn').click();await page.waitForFunction(()=>activeTask===null&&state.images.some(p=>p.status==='error'));
    assert.equal(await page.locator('#articleInput').inputValue(),'Keep original.');assert.equal(await page.locator('#tabImage').isVisible(),true);assert.equal(await page.locator('.img-error').count(),1);assert.match(await page.locator('#status').innerText(),/正文未替换/);
    await page.locator('#ocrBtn').click();await page.waitForFunction(()=>activeTask===null&&state.images.every(p=>p.status==='ok'));
    assert.equal(calls,3);assert.equal(await page.locator('#articleInput').inputValue(),'First.\n\nSecond.');assert.equal(await page.locator('#tabText').isVisible(),true);assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('mobile thumbnails support touch dragging without page editors',async()=>{
  const {page,context,errors}=await pageFixture({width:390,height:844});
  try{
    await page.locator('[data-tab="image"]').click();
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=','base64');
    await page.locator('#fileInput').setInputFiles([{name:'first.png',mimeType:'image/png',buffer:png},{name:'second.png',mimeType:'image/png',buffer:png}]);await page.waitForFunction(()=>imgBusy===0);
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.img-item')).transform==='none');const a=await page.locator('.img-item').nth(0).boundingBox(),b=await page.locator('.img-item').nth(1).boundingBox();
    const cdp=await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:a.x+a.width/2,y:a.y+a.height/2}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:b.x+b.width/2,y:b.y+b.height/2}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await page.waitForFunction(()=>state.images[0].name==='second.png');assert.equal(await page.locator('#imgList textarea').count(),0);
    assert.ok(b.x+b.width<=390);await page.waitForFunction(()=>getComputedStyle(document.querySelector('.img-item')).transform==='none');await page.screenshot({path:path.join(__dirname,'../test-results/mobile-ocr-simple.png')});assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('mobile menus and modal / OCR layouts remain within the viewport',async()=>{
  const {page,context,errors}=await pageFixture({width:390,height:844});
  try{
    await article(page);await page.locator('#moreBtn').click();await page.locator('[data-act="book"]').click();assert.equal(await page.locator('#bookModal').isVisible(),true);assert.equal(await page.locator('#bookBtn').isVisible(),false);
    const fits=await page.evaluate(()=>{const r=document.querySelector('#bookModal .modal').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth;});assert.equal(fits,true);
    await page.keyboard.press('Escape');await page.locator('#moreBtn').click();await page.locator('[data-act="usage"]').click();assert.equal(await page.locator('#usageModal').isVisible(),true);assert.deepEqual(errors,[]);
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('#usageModal .modal')).opacity==='1');
    fs.mkdirSync(path.join(__dirname,'../test-results'),{recursive:true});await page.screenshot({path:path.join(__dirname,'../test-results/mobile-usage.png')});
  }finally{await context.close();}
});
test('downloaded single HTML opens through file URL without runtime resources',async()=>{
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{await page.goto(require('node:url').pathToFileURL(path.join(__dirname,'../index.html')).href);await page.locator('#bookBtn').click();assert.equal(await page.locator('#bookModal').isVisible(),true);await page.keyboard.press('Escape');await page.locator('#lookupBtn').click();await page.locator('#lookupInput').fill('bird');await page.locator('#lookupInput').press('Enter');await page.locator('#lookupResult').getByRole('button',{name:'收藏到生词本'}).waitFor();assert.match(await page.locator('#lookupResult').innerText(),/鸟/);assert.deepEqual(errors,[]);}finally{await context.close();}
});
test('toolbar remains reachable at desktop / tablet breakpoint widths',async()=>{
  const {page,context}=await pageFixture();
  try{
    for(const width of [901,920,1080,1160,1200,1280,1300,1440]){
      await page.setViewportSize({width,height:1000});
      const r=await page.locator('#keyBtn').boundingBox();assert.ok(r.x+r.width<=width,`API key button overflows at ${width}`);
      if(width<=1280){await page.locator('#moreBtn').click();assert.equal(await page.locator('[data-act="book"]').isVisible(),true);assert.equal(await page.locator('[data-act="lookup"]').isVisible(),true);await page.keyboard.press('Escape');}
      else{const b=await page.locator('#lookupBtn').boundingBox();assert.ok(b && b.x+b.width<=width,`lookup inaccessible at ${width}`);}
    }
    await article(page);await page.locator('#bookBtn').click();await page.evaluate(()=>collectWord('bird',state.sentences[0]));
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('#bookModal .modal')).opacity==='1');
    await page.screenshot({path:path.join(__dirname,'../test-results/desktop-book.png')});
  }finally{await context.close();}
});
test('cancel batch processing saves completed work and resume only requests missing sentences',async()=>{
  const {page,context,errors}=await pageFixture();let calls=0,resuming=false;
  try{
    const sentences=Array.from({length:21},(_,i)=>`Sentence ${i+1} works.`);
    await page.unroute('https://api.deepseek.com/**');await page.route('https://api.deepseek.com/**',async route=>{
      calls++;const prompt=route.request().postDataJSON().messages.at(-1).content;
      if(prompt.includes('paragraphs')){await route.fulfill({json:reply({paragraphs:[sentences]})});return;}
      const batch=prompt.split('句子列表：\n')[1].split('\n').map(s=>s.replace(/^\[\d+\] /,''));
      if(!resuming && batch[0]!==sentences[0])await new Promise(r=>setTimeout(r,1200));
      await route.fulfill({json:reply({sentences:batch.map(text=>({segments:[{text,type:'subject'}],trans:'译文'}))})}).catch(()=>{});
    });
    await page.locator('#articleInput').fill(sentences.join(' '));await page.locator('#analyzeBtn').click();await page.waitForFunction(()=>state.sentences.filter(s=>s.status==='ok').length===5);await page.locator('#cancelBtn').click();await page.waitForFunction(()=>activeTask===null);
    const done=await page.evaluate(()=>state.sentences.filter(s=>s.status==='ok').length);assert.equal(done,5);
    const cached=await page.evaluate(()=>JSON.parse(localStorage.getItem(state.articleCacheKey)));assert.equal(cached.sentences.filter(s=>s.data).length,5);
    const before=calls;resuming=true;await page.locator('#analyzeBtn').click();await page.waitForFunction(()=>activeTask===null && state.sentences.every(s=>s.status==='ok'));
    assert.equal(calls-before,4);assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
test('OCR UI cancel keeps the completed page and resume skips it',async()=>{
  const {page,context,errors}=await pageFixture();let calls=0,resuming=false;
  try{
    await page.locator('#articleInput').fill('Original.');await page.locator('[data-tab="image"]').click();
    await page.evaluate(()=>{state.images=[{id:'one',name:'one',status:'ready',text:'',dataUrl:'data:image/png;base64,iVBORw0KGgo='},{id:'two',name:'two',status:'ready',text:'',dataUrl:'data:image/png;base64,iVBORw0KGgo='}];renderImgList();});
    await page.unroute('https://api.deepseek.com/**');await page.route('https://api.deepseek.com/**',async route=>{const n=++calls;if(n===2&&!resuming)await new Promise(r=>setTimeout(r,1200));await route.fulfill({json:reply(n===1?'First completed.':'Second completed.')}).catch(()=>{});});
    await page.locator('#ocrBtn').click();await page.waitForFunction(()=>state.images[0].status==='ok' && state.images[1].status==='loading');await page.locator('#cancelBtn').click();await page.waitForFunction(()=>activeTask===null);assert.equal(await page.evaluate(()=>state.images[0].text),'First completed.');assert.equal(await page.locator('#articleInput').inputValue(),'Original.');assert.equal(await page.locator('#tabImage').isVisible(),true);
    resuming=true;const before=calls;await page.locator('#ocrBtn').click();await page.waitForFunction(()=>activeTask===null && state.images.every(p=>p.status==='ok'));assert.equal(calls-before,1);assert.equal(await page.locator('#articleInput').inputValue(),'First completed.\n\nSecond completed.');assert.equal(await page.locator('#tabText').isVisible(),true);assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
