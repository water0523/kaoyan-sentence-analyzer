const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function runtime(){
  const store=new Map(),nodes=new Map();
  function node(key){
    if(nodes.has(key))return nodes.get(key);
    const classes=new Set();
    const n={value:'',textContent:'',innerHTML:'',hidden:false,disabled:false,style:{},dataset:{},classList:{add:(...xs)=>xs.forEach(x=>classes.add(x)),remove:(...xs)=>xs.forEach(x=>classes.delete(x)),contains:x=>classes.has(x),toggle:(x,on)=>{on=on??!classes.has(x);on?classes.add(x):classes.delete(x);return on;}},addEventListener(){},focus(){},appendChild(){},remove(){},querySelector:s=>node(key+' '+s),querySelectorAll:()=>[],closest:s=>node(s),getBoundingClientRect:()=>({top:0,left:0,bottom:30,width:100,height:30})};
    n.setAttribute=()=>{};n.removeAttribute=()=>{};
    nodes.set(key,n);return n;
  }
  const ctx={console:{log(){},warn(){},error(){},info(){}},document:{querySelector:node,querySelectorAll:()=>[],addEventListener(){},createElement:()=>node('created'),body:node('body')},window:{addEventListener(){},matchMedia:()=>({matches:true,addEventListener(){}}),getSelection:()=>'',innerWidth:1400},navigator:{},localStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k),key:i=>[...store.keys()][i],get length(){return store.size;}},confirm:()=>true,alert(){},prompt:()=>null,setTimeout,clearTimeout,requestAnimationFrame(){},performance,AbortController,Blob,Response,DecompressionStream,atob,URL,crypto:require('node:crypto').webcrypto};
  vm.createContext(ctx);for(const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g))vm.runInContext(m[1],ctx);
  return {ctx,store,nodes,run:s=>vm.runInContext(s,ctx),node};
}
module.exports={runtime,html};
