import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const js=fs.readFileSync(new URL('../public/js/admin-action-menu.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../public/admin.html',import.meta.url),'utf8');
function setup(){
 const handlers={},windowHandlers={};const document={documentElement:{clientWidth:390},activeElement:null,
  addEventListener:(name,fn)=>{handlers[name]=fn},body:{append(menu){menu.parentNode=this}}};
 const window={innerHeight:844,addEventListener:(name,fn,capture)=>{windowHandlers[name]=fn;if(name==='scroll')assert.equal(capture,true)}};
 vm.runInNewContext(js,{window,document});
 const parent={isConnected:true,insertBefore(menu){menu.parentNode=this}};
 let rect={top:760,bottom:790,right:380};const attrs={};
 const button={isConnected:true,setAttribute:(k,v)=>{attrs[k]=v},focus(){document.activeElement=this},getBoundingClientRect:()=>rect};
 const items=Array.from({length:5},()=>({focus(){document.activeElement=this}}));
 const visible=new Set();const menu={parentNode:parent,scrollHeight:260,style:{},classList:{add:k=>visible.add(k),remove:k=>visible.delete(k)},
  querySelector:()=>items[0],querySelectorAll:()=>items,contains:target=>target===menu,remove(){this.removed=true}};
 return {api:window.adminActionMenu,document,window,handlers,windowHandlers,button,menu,parent,attrs,items,
  rect:r=>{rect=r},open:()=>window.adminActionMenu.toggle({stopPropagation(){},currentTarget:button},menu)};
}
for(const [name,rect,w,h,content,up] of [
 ['middle',{top:200,bottom:230,right:500},1280,850,260,false],
 ['last',{top:760,bottom:790,right:380},390,844,260,true],
 ['narrow',{top:370,bottom:400,right:310},320,440,500,true],
 ['tall',{top:500,bottom:530,right:700},900,1400,260,false]
])test(`action menu layout ${name}`,()=>{
 const {api}=setup(),p=api.layout(rect,w,h,content);assert.equal(p.up,up);
 assert.ok(p.left>=0&&p.left+p.width<=w);assert.ok(p.top>=0&&p.top+Math.min(content,p.maxHeight)<=h);
});
test('portal escapes overflow, fits viewport and restores original parent on close',()=>{
 const h=setup();h.open();assert.equal(h.menu.parentNode,h.document.body);assert.equal(h.attrs['aria-expanded'],'true');
 assert.equal(h.document.activeElement,h.items[0]);assert.ok(parseFloat(h.menu.style.top)<760);
 h.api.close();assert.equal(h.menu.parentNode,h.parent);assert.equal(h.attrs['aria-expanded'],'false');
});
test('container scroll and resize reposition the same interactive menu',()=>{
 const h=setup();h.open();const old=h.menu.style.top;h.rect({top:200,bottom:230,right:380});
 h.windowHandlers.scroll({target:h.parent});assert.notEqual(h.menu.style.top,old);assert.equal(h.menu.style.top,'236px');
 h.document.documentElement.clientWidth=320;h.windowHandlers.resize();assert.ok(parseFloat(h.menu.style.left)+parseFloat(h.menu.style.width)<=320);
 assert.equal(h.menu.querySelectorAll()[0],h.items[0]);
});
test('Escape closes and restores trigger focus; Tab and arrows navigate options',()=>{
 const h=setup();h.open();const key=key=>h.handlers.keydown({key,preventDefault(){}});
 key('Tab');assert.equal(h.document.activeElement,h.items[1]);key('End');assert.equal(h.document.activeElement,h.items[4]);
 key('ArrowDown');assert.equal(h.document.activeElement,h.items[0]);key('Escape');assert.equal(h.document.activeElement,h.button);
 assert.equal(h.attrs['aria-expanded'],'false');
});
test('offscreen or removed trigger closes menu, own scroll does not reposition',()=>{
 const h=setup();h.open();const top=h.menu.style.top;h.rect({top:900,bottom:930,right:380});
 h.windowHandlers.scroll({target:h.menu});assert.equal(h.menu.style.top,top);
 h.windowHandlers.scroll({target:h.parent});assert.equal(h.attrs['aria-expanded'],'false');
});
test('CSS uses fixed portal, scrollable height, z-index below dialogs and wrapped labels',()=>{
 const css=html.match(/\.acciones-menu \{[\s\S]*?\}/)[0];
 assert.match(css,/position: fixed/);assert.match(css,/overflow-y: auto/);assert.match(css,/overflow-x: hidden/);
 assert.match(css,/z-index: 900/);assert.match(css,/min-width: 0/);
 assert.match(html,/\.acciones-menu button \{[\s\S]*?overflow-wrap: anywhere/);
});
test('existing property and CRM handlers remain intact, keyboard native trigger and script loaded',()=>{
 assert.match(html,/verPublicacionesUsuario\('\$\{u\._id\}'\); cerrarMenusAcciones\(\)/);
 assert.match(html,/abrirCrmDelegado\('\$\{u\._id\}'\); cerrarMenusAcciones\(\)/);
 assert.match(html,/aria-expanded="false" aria-controls="acciones-\$\{u\._id\}"/);
 assert.match(html,/<script src="\/js\/admin-action-menu.js"><\/script>/);
});
test('repeated open/close creates no listeners per menu and clears portal state',()=>{
 const h=setup();h.window.addEventListener=()=>assert.fail('no per-open listeners');
 h.document.addEventListener=()=>assert.fail('no per-open listeners');
 for(let i=0;i<10;i++){
  h.open();h.api.close();assert.equal(h.menu.parentNode,h.parent);assert.equal(h.attrs['aria-expanded'],'false');
 }
 h.windowHandlers.scroll({target:h.parent});h.windowHandlers.resize();
 assert.equal(h.menu.parentNode,h.parent);
});
test('closing after row removal removes portal instead of retaining detached parent',()=>{
 const h=setup();h.open();h.parent.isConnected=false;h.api.close();assert.equal(h.menu.removed,true);
});
test('menu closes through action handlers before leaving the existing overlays in control',()=>{
 assert.match(html,/\.modal-overlay \{[\s\S]*?z-index: 1000/);
 assert.match(html,/\.admin-delete-modal-backdrop \{[\s\S]*?z-index: 3000/);
 assert.match(html,/verEstadisticas\('\$\{u\._id\}'\); cerrarMenusAcciones\(\)/);
 assert.match(html,/abrirCrmDelegado\('\$\{u\._id\}'\); cerrarMenusAcciones\(\)/);
});
