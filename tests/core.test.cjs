const {test}=require('node:test'),assert=require('node:assert/strict');
const {runtime,html}=require('./runtime.cjs');
const plain=x=>JSON.parse(JSON.stringify(x));
test('all page scripts initialize, including permanent book and usage UI',()=>{const r=runtime();assert.equal(r.run('APP_VERSION'),'1.5');assert.equal(r.run('vocabBook.defaultFolderId'),'inbox');});
test('partial / total failure complete without a scope error',async()=>{
  for(const successes of [0,1]){
    const r=runtime();r.run(`state.apiKey='test';$('#articleInput').value='He works. She left.';splitArticle=async()=>[['He works.','She left.']];runBatches=async list=>list.forEach((s,i)=>{s.status=i<${successes}?'ok':'error';s.data=i<${successes}?{segments:[{text:s.text,type:'subject'}]}:null;});`);
    await r.run('analyze(true)');assert.match(r.node('#status').textContent,successes?/完成：1 句成功/:/全部分析失败/);assert.equal(r.run('activeTask'),null);assert.equal(r.run('state.analyzing'),false);assert.equal(r.node('#analyzeBtn').disabled,false);
  }
});
test('single retry persists result and enables print without using edited input',async()=>{
  const r=runtime();r.run(`state.apiKey='test';state.articleCacheKey='ds_ana_v6_original';state.sentences=[{text:'He works.',status:'error',para:0}];callAPI=async()=>JSON.stringify({sentences:[{segments:[{text:'He works.',type:'subject'}],trans:'他工作。'}]});$('#articleInput').value='another article';fillSentenceError(state.sentences[0]);`);
  const button=r.node('#article .p-sent[data-idx="0"] .p-detail [data-retry]');
  await button.onclick({stopPropagation(){},currentTarget:{dataset:{retry:'0'}}});
  assert.equal(JSON.parse(r.store.get('ds_ana_v6_original')).sentences[0].data.trans,'他工作。');assert.equal(r.node('#printBtn').disabled,false);
});
test('stale retry cannot change a new article or its cache',async()=>{
  const r=runtime();let resolve;r.ctx.reply=new Promise(x=>resolve=x);
  r.run(`state.apiKey='test';state.articleCacheKey='ds_ana_v6_old';state.sentences=[{text:'old',status:'error',para:0}];callAPI=async()=>reply;fillSentenceError(state.sentences[0]);`);
  const button=r.node('#article .p-sent[data-idx="0"] .p-detail [data-retry]');const pending=button.onclick({stopPropagation(){},currentTarget:{dataset:{retry:'0'}}});
  r.run(`articleRevision++;state.articleCacheKey='ds_ana_v6_new';state.sentences=[{text:'new',status:'ok',data:{trans:'新'}}];`);resolve(JSON.stringify({sentences:[{segments:[{text:'old'}],trans:'旧'}]}));await pending;
  assert.equal(r.run('state.sentences[0].data.trans'),'新');assert.equal(r.store.has('ds_ana_v6_new'),false);
});
test('identical clauses are marked at separate locations and nested clauses survive',()=>{
  const r=runtime();const clauses=r.run(`(()=>{const s='The man who came met the woman who came.';return alignClauses(s,s.toLowerCase(),[{text:'who came',type:'attr_clause'},{text:'who came',type:'attr_clause'}],tokenize(s),[]);})()`);
  assert.equal(clauses.length,2);assert.notEqual(clauses[0].start,clauses[1].start);
  assert.equal(r.run(`(()=>{const s='He knew that she said that it worked.';return alignClauses(s,s.toLowerCase(),[{text:'that she said that it worked',type:'obj_clause'},{text:'that it worked',type:'obj_clause'}],tokenize(s),[]).length;})()`),2);
});
test('split validation rejects inter-paragraph transfer',()=>{const r=runtime();assert.equal(r.run(String.raw`normalizeSplit({paragraphs:[['He'],['left. She stayed.']]},'He left.\n\nShe stayed.',['He left.','She stayed.'])`),null);});
test('actual grammar prompt context changes cache key',()=>{
  const r=runtime();const keys=r.run(`(()=>{const s={text:'It was cold.',data:{trans:'天气冷'}};state.sentences=[{text:'They discussed the weather.'},s];state.paragraphs=[[0,1]];const a=grammarCacheKey(s.text,s);state.sentences[0].text='They examined the metal.';return [a,grammarCacheKey(s.text,s)];})()`);assert.notEqual(keys[0],keys[1]);
});
test('word cache keys include paragraph context',async()=>{
  const r=runtime();r.run(`state.apiKey='test';loadDict=async()=>true;callAPI=async()=>JSON.stringify({meaning:'冷'});state.sentences=[{text:'weather'},{text:'It was cold.',data:{trans:'冷'}}];state.paragraphs=[[0,1]];`);
  await r.run(`explainWord('cold','It was cold.',false,state.sentences[1])`);r.run(`state.sentences[0].text='metal';`);await r.run(`explainWord('cold','It was cold.',false,state.sentences[1])`);
  assert.equal([...r.store.keys()].filter(k=>k.startsWith('ds_word_v4_')).length,2);
});
test('async image processing preserves input order and stable IDs',()=>{
  const r=runtime(),readers=[],callbacks=[];r.ctx.FileReader=function(){readers.push(this);this.readAsDataURL=()=>{};};r.ctx.compressImage=(v,cb)=>callbacks.push({v,cb});
  r.run(`addImages([{name:'page1.png',type:'image/png'},{name:'page2.png',type:'image/png'}])`);
  readers.forEach((x,i)=>{x.result='page'+(i+1);x.onload();});callbacks[1].cb('page2');callbacks[0].cb('page1');
  assert.deepEqual(plain(r.run('state.images.map(p=>p.dataUrl)')),['page1','page2']);assert.equal(r.run('imgBusy'),0);
});
test('book merges same word contexts, moves collisions, and deletes default folder safely',async()=>{
  const r=runtime();r.run(`loadDict=async()=>true;dictLookup=()=>({entry:{tr:'冷',ph:'kəʊld'}});vocabBook.folders.push({id:'exam',name:'真题'});vocabBook.defaultFolderId='exam';`);
  await r.run(`collectWord('cold',{text:'It was cold.',data:{trans:'天气冷'}})`);await r.run(`collectWord('Cold',{text:'The metal was cold.',data:{trans:'金属冷'}})`);await r.run(`collectWord('cold',{text:'It was cold.',data:{trans:'天气冷'}})`);
  assert.equal(r.run('vocabBook.entries.length'),1);assert.equal(r.run('vocabBook.entries[0].contexts.length'),2);
  r.run(`vocabBook.defaultFolderId='inbox'`);await r.run(`collectWord('cold',{text:'She was cold.',data:{}})`);
  r.run(`changeBook(book=>deleteBookFolder(book,'exam'))`);assert.equal(r.run('vocabBook.entries.length'),1);assert.equal(r.run('vocabBook.entries[0].contexts.length'),3);assert.equal(r.run('vocabBook.defaultFolderId'),'inbox');
});
test('cache expiry and clear do not erase permanent vocabulary / rates / usage',()=>{
  const r=runtime();r.store.set('ds_vocab_book_v1','book');r.store.set('ds_rates_v1','rates');r.store.set('ds_usage_v1','usage');r.store.set('ds_ana_v6_test','cache');r.run('clearAllCache()');assert.equal(r.store.get('ds_vocab_book_v1'),'book');assert.equal(r.store.get('ds_usage_v1'),'usage');assert.equal(r.store.has('ds_ana_v6_test'),false);
});
test('quota failure leaves book unchanged, backup validator rejects malformed entries',()=>{
  const r=runtime();r.ctx.localStorage.setItem=()=>{throw new Error('quota');};assert.equal(r.run(`changeBook(book=>book.folders.push({id:'x',name:'x'}))`),false);assert.equal(r.run('vocabBook.folders.length'),1);assert.throws(()=>r.run(`validateBook({version:1,folders:[{id:'inbox',name:'未分类'}],defaultFolderId:'inbox',entries:[{id:'x',word:'a',folderId:'inbox',contexts:[]}]})`));
});
test('restored folders cannot disguise duplicate names through the built-in inbox',()=>{
  const r=runtime();assert.throws(()=>r.run(`validateBook({version:1,folders:[{id:'inbox',name:'renamed'},{id:'x',name:'未分类'}],defaultFolderId:'inbox',entries:[]})`),/名称重复/);
});
test('dictionary loading waits and ignores older word results in the same phrase',async()=>{
  const r=runtime();let resolve;r.ctx.dictReady=new Promise(x=>resolve=x);
  r.run(`dictState='loading';loadDict=()=>dictReady;testUnit=document.querySelector('phrase');`);
  const older=r.run(`openDictCard(testUnit,'rare','rare bird')`),newer=r.run(`openDictCard(testUnit,'bird','rare bird')`);
  assert.match(r.node('#dictCard').innerHTML,/载入中/);
  r.run(`dictState='ready';dictCardBody=(_res,word)=>word;dictLookupBest=()=>({});`);resolve();await Promise.all([older,newer]);
  assert.equal(r.node('#dictCard').innerHTML,'bird');
});
test('Anki export declares deck / HTML, escapes content and merges example sentences',()=>{
  const r=runtime();const text=r.run(String.raw`ankiText([{word:'R&D',folderId:'inbox',meaning:'"研究"\n开发 <b>',phonetic:'test',note:'A\tB',contexts:[{sentence:'He said "hi".',trans:'中文',meaning:'义项'},{sentence:'another',trans:'另一个',meaning:'义项2'}]}])`);
  assert.match(text,/#separator:Tab/);assert.match(text,/#deck column:3/);assert.match(text,/R&amp;D/);assert.match(text,/&lt;b&gt;/);assert.match(text,/考研生词::未分类/);assert.match(text,/another/);assert.match(text,/&quot;研究&quot;<br>/);
});
test('fee formula, missing usage and historical snapshots',async()=>{
  const r=runtime();const u=plain(r.run(`usageDelta({prompt_tokens:1000,prompt_cache_hit_tokens:200,completion_tokens:300},RATE_PRESETS.peak)`));assert.equal(u.cost,(200*.04+800*2+300*8)/1e6);assert.equal(r.run(`usageDelta(null,RATE_PRESETS.peak).unknown`),1);
  r.run(`recordUsage('analysis',{prompt_tokens:1000,prompt_cache_hit_tokens:200,completion_tokens:300},{...rates},null);rates={hit:10,miss:10,out:10};`);assert.equal(r.run(`usageTotals.analysis.cost`),u.cost);
  assert.equal(JSON.parse(r.store.get('ds_usage_v1')).receipts[0].rates.miss,2);
  assert.equal(r.run('usageDelta({prompt_tokens:200,completion_tokens:20},rates).input'),200);
  assert.equal(r.run('usageDelta({prompt_tokens:200,completion_tokens:20},rates).miss'),0);
});
test('truncated and invalid model content still account usage exactly once',async()=>{
  const r=runtime();r.ctx.fetch=async()=>({ok:true,json:async()=>({usage:{prompt_tokens:100,prompt_cache_hit_tokens:10,completion_tokens:20},choices:[{finish_reason:'length',message:{content:'bad'}}]})});
  await assert.rejects(r.run(`callAPI([])`),/截断/);assert.equal(r.run('usageTotals.analysis.requests'),1);assert.equal(r.run('usageTotals.analysis.out'),20);
  r.ctx.fetch=async()=>({ok:true,json:async()=>({usage:{prompt_tokens:100,prompt_cache_hit_tokens:10,completion_tokens:20},choices:[{message:{content:'not JSON'}}]})});
  const raw=await r.run('callAPI([])');assert.throws(()=>r.run(`parseJSON(${JSON.stringify(raw)})`));assert.equal(r.run('usageTotals.analysis.requests'),2);
});
test('word requests during analysis do not hide the ongoing / completed analysis total',()=>{
  const r=runtime();r.run(`analysisTask=beginTask('analysis');recordUsage('analysis',{prompt_tokens:100,prompt_cache_hit_tokens:0,completion_tokens:20},rates,analysisTask);recordUsage('word',{prompt_tokens:10,prompt_cache_hit_tokens:0,completion_tokens:2},rates,null);renderUsage();`);
  assert.match(r.node('#usageBody').innerHTML,/<h4>当前任务<\/h4>/);
  const current=r.node('#usageBody').innerHTML.split('<h4>本地累计</h4>')[0];assert.match(current,/分析/);assert.doesNotMatch(current,/解词/);
  r.run('endTask(analysisTask)');assert.equal(r.run('lastTask.usage.analysis.requests'),1);
});
test('cancel split aborts request, does not start local fallback, and records unknown',async()=>{
  const r=runtime();r.run(`state.apiKey='test';$('#articleInput').value='He works.';`);let calls=0;
  r.ctx.fetch=(url,{signal})=>new Promise((resolve,reject)=>{calls++;signal.addEventListener('abort',()=>{const e=new Error('abort');e.name='AbortError';reject(e);},{once:true});});
  const pending=r.run('analyze(false)');await new Promise(x=>setImmediate(x));r.run('cancelActiveTask()');await pending;assert.equal(calls,1);assert.equal(r.run('state.sentences.length'),0);assert.equal(r.run('activeTask'),null);assert.equal(r.run('usageTotals.split.unknown'),1);
});
test('cancel retry wait prevents a second request',async()=>{
  const r=runtime();r.run(`state.articleCacheKey='ds_ana_v6_test';state.sentences=[{text:'test',status:'pending'}];`);let calls=0;r.ctx.callAPI=async()=>{calls++;throw new Error('network');};const task=r.run(`beginTask('analysis')`);r.ctx.testTask=task;
  const pending=r.run('runBatches(state.sentences,1,testTask)');await new Promise(x=>setImmediate(x));task.controller.abort();await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(calls,1);r.run('endTask(testTask)');
});
test('request cancellation respects both explicit signal and owning task',async()=>{
  for(const source of ['explicit','task']){
    const r=runtime();r.run(`explicit=new AbortController();apiTask=beginTask('analysis');`);
    r.ctx.fetch=(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{const e=new Error('abort');e.name='AbortError';reject(e);},{once:true}));
    const pending=r.run(`callAPI([],{signal:explicit.signal,task:apiTask})`);
    r.run(source==='explicit'?'explicit.abort()':'apiTask.controller.abort()');
    await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(r.run('usageTotals.analysis.requests'),1);r.run('endTask(apiTask)');
  }
});
test('OCR cancellation preserves completed pages and manual text',async()=>{
  const r=runtime();r.run(`state.apiKey='test';state.images=[{id:'1',name:'1',dataUrl:'a',status:'ready',text:''},{id:'2',name:'2',dataUrl:'b',status:'ready',text:'manual'}];`);let calls=0;
  r.ctx.callAPI=async(messages,{task})=>{if(++calls===1)return 'page one';return new Promise((resolve,reject)=>task.controller.signal.addEventListener('abort',()=>{const e=new Error();e.name='AbortError';reject(e);},{once:true}));};
  const pending=r.run('startOcr()');await new Promise(x=>setImmediate(x));r.run('cancelActiveTask()');await pending;assert.deepEqual(plain(r.run('state.images.map(p=>p.text)')),['page one','manual']);assert.equal(r.run('activeTask'),null);
});
