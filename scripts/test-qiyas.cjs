const fs=require('fs'),vm=require('vm'),assert=require('assert');
const nodes=new Map(),storage=new Map();
function el(){return {innerHTML:'',textContent:'',value:'',style:{},dataset:{},classList:{toggle(){}},addEventListener(){},appendChild(){},prepend(){},append(){},after(){},before(){},remove(){},querySelector(){return el()}}}
const ctx={console,Date,Math,Set,Map,Blob,URL,AbortController,location:{protocol:'file:'},confirm:()=>true,alert(){},setInterval:()=>1,clearInterval(){},setTimeout:()=>1,addEventListener(){},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},document:{querySelector:s=>{if(!nodes.has(s))nodes.set(s,el());return nodes.get(s)},querySelectorAll:()=>[],createElement:el,body:el()}};ctx.window=ctx;vm.createContext(ctx);for(const f of ['data.js','core.js','app.js','learn.js','engine.js','qiyas.js'])vm.runInContext(fs.readFileSync('dist/'+f,'utf8'),ctx,{filename:f});const run=s=>vm.runInContext(s,ctx);
run(`
 const order=['استيعاب المقروء','التناظر اللفظي','الخطأ السياقي','إكمال الجمل'];
 for(const track of ['علمي','نظري']){
  const spec=REAL_TRACKS[track];
  for(let round=0;round<6;round++){
   startRealExam(track);
   if(!exam.real||exam.qs.length!==120||new Set(exam.qs.map(q=>q.id)).size!==120)throw Error('real size '+track);
   if(exam.blockCount!==5||exam.blockSize!==24||exam.deadline-exam.startedAt!==125*60000||exam.blockDeadline-exam.startedAt!==25*60000)throw Error('real timing');
   const v=exam.qs.filter(q=>q.section==='لفظي');if(v.length!==spec.verbal)throw Error('verbal count '+v.length+' '+track);
   if(exam.qs.some(q=>q.category==='الارتباط والاختلاف'))throw Error('odd-word excluded');
   const want=apportion(spec.verbal,spec.v);for(const c of order){const n=v.filter(q=>q.category===c).length;if(n!==want[c])throw Error('weight '+c+' '+n+'/'+want[c])}
   const kw=apportion(spec.quant,spec.k);for(const a of Object.keys(kw)){const n=exam.qs.filter(q=>QUANT_AREAS[a].includes(q.category)).length;if(n!==kw[a])throw Error('quant area '+a+' '+n+'/'+kw[a])}
   const per=apportion(spec.verbal,{0:1,1:1,2:1,3:1,4:1});
   for(let b=0;b<5;b++){const sec=exam.qs.slice(b*24,b*24+24);if(sec.filter(q=>q.section==='لفظي').length!==per[b])throw Error('section verbal split '+b)}
   // passages stay contiguous and never cross a section boundary
   const keys=exam.qs.map(q=>q.category==='استيعاب المقروء'?passageKey(q):null);const seenK=new Map();
   keys.forEach((k,i)=>{if(!k)return;if(seenK.has(k)){const p=seenK.get(k);if(p!==i-1||Math.floor(p/24)!==Math.floor(i/24))throw Error('passage split at '+i)}seenK.set(k,i)});
   exam.qs.forEach(q=>{const o=data.questions.find(x=>x.id===q.id);if(q.options[q.answer]!==o.options[o.answer])throw Error('answer key after shuffle')});
   exam.answers=exam.qs.map(q=>q.answer);
   for(let b=0;b<5;b++){advanceBlock();closeBlock()}
   if(exam)throw Error('finished after 5 sections');
   const a=attempts.at(-1);if(!a.real||counts(a).percent!==100)throw Error('real graded');
   showReport(a.id);
  }
 }
 // fresh questions: back-to-back exams barely repeat while the bank allows
 attempts=[];history=[];startRealExam('علمي');const first=new Set(exam.qs.map(q=>q.id));finishExam();startRealExam('علمي');
 const overlap=exam.qs.filter(q=>first.has(q.id)).length;if(overlap>20)throw Error('too much repetition '+overlap);
 // review screen does not close a section by itself; time-out still advances
 const b0=exam.block;advanceBlock();if(exam.block!==b0)throw Error('review must not close');
 exam.blockDeadline=Date.now()-1;exam.lastTouch=Date.now()-1000;syncBlocks();if(exam.block!==1)throw Error('timeout advance');
 const saved=validateBackup(clone(snapshot()));if(!saved.activeExam.real||saved.activeExam.track!=='علمي')throw Error('backup keeps real exam');
 finishExam();
 go('exams');
`);
console.log('PASS: real GAT simulation (both tracks, 6 rounds each): 120 questions, 5×24×25, official type weights, verbal/quant split per section, whole passages within one section, odd-word excluded, answer keys after option shuffle, section review screen, timeout advance, low repetition, backup compatibility, report.');
// comparison options are presented in the fixed real-test order
run(`const c=data.questions.find(q=>q.category==='المقارنة الكمية');for(let i=0;i<20;i++){const m=mixedOptions(c);if(m.options.join()!==COMPARISON_ORDER.join()||m.options[m.answer]!==c.options[c.answer])throw Error('comparison order')}`);
console.log('PASS: comparison items keep fixed option order.');
