const fs=require('node:fs');
const {runtime}=require('./runtime.cjs');
const r=runtime();
const book={folders:[{id:'inbox',name:'未分类'},{id:'exam',name:'真题'}],entries:[
  {word:'R&D',folderId:'inbox',meaning:'"研究"\n开发 <b>',phonetic:'test',note:'A\tB',contexts:[{sentence:'He said "hi".',trans:'中文',meaning:'义项'},{sentence:'another',trans:'另一个',meaning:'义项2'}]},
  {word:'R&D',folderId:'exam',meaning:'真题义项',phonetic:'test',note:'',contexts:[]}
]};
r.ctx.sampleBook=book;
fs.mkdirSync('test-results',{recursive:true});
fs.writeFileSync('test-results/anki-sample.txt',r.run('ankiText(sampleBook.entries,sampleBook)'));
