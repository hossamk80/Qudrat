const fs=require('fs'),vm=require('vm'),assert=require('assert'),path=require('path'),cp=require('child_process');
const root=path.resolve(__dirname,'../dist');
const JSZip=require('../dist/vendor/jszip.min.js');
const storage=new Map();let failStorage=false;
// DOM test double: interaction state is tested without claiming browser layout QA.
class XMLNode{
 constructor(n){this.n=n;this.textContent=n.text;this.children=(n.children||[]).map(c=>new XMLNode(c))}
 getAttribute(k){return this.n.attrs[k]??null}
 getAttributeNS(ns,k){return this.n.attrs['{'+ns+'}'+k]??null}
 getElementsByTagNameNS(ns,name){const a=[];for(const c of this.children){if(c.n.tag.split('}').at(-1)===name)a.push(c);a.push(...c.getElementsByTagNameNS(ns,name))}return a}
 getElementsByTagName(name){return this.getElementsByTagNameNS('*',name)}
}
class DOMParser{parseFromString(s){const py=`import sys,json,xml.etree.ElementTree as E\ndef conv(n): return dict(tag=n.tag,attrs=n.attrib,text=''.join(n.itertext()),children=[conv(c) for c in n])\ntry: print(json.dumps(dict(tag='document',attrs={},text='',children=[conv(E.fromstring(sys.stdin.read()))])))\nexcept Exception: print(json.dumps(dict(tag='document',attrs={},text='',children=[dict(tag='parsererror',attrs={},text='error',children=[])])))`;
return new XMLNode(JSON.parse(cp.execFileSync('python',['-c',py],{input:s,encoding:'utf8',maxBuffer:50*1024*1024})))}}
function newContext(){let nodes={},tools=[];const el=()=>({innerHTML:'',textContent:'',style:{},hidden:false,value:'',classList:{toggle(){}},appendChild(){},prepend(){},append(){},after(){},querySelector(){return el()},click(){},remove(){},addEventListener(){}});const ctx={console,DOMParser,JSZip,Blob,URL,ArrayBuffer,Uint8Array,TextDecoder,AbortController,Date,location:{protocol:'file:'},setTimeout:()=>1,setInterval:()=>1,clearInterval(){},addEventListener(){},alert(){},confirm:()=>true,document:{querySelector:s=>nodes[s]??=el(),querySelectorAll:()=>[],createElement:el,body:el(),modelContext:{registerTool:t=>tools.push(t)}},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>{if(failStorage)throw Error('Quota');storage.set(k,v)},removeItem:k=>storage.delete(k)}};ctx.window=ctx;vm.createContext(ctx);for(const f of ['data.js','core.js','app.js','learn.js','engine.js'])vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx,{filename:f});return {ctx,tools,nodes,run:s=>vm.runInContext(s,ctx)}}
(async()=>{
 const t=newContext();
 t.run(`if(data.questions.length!==1490||data.sourceVersion!==10)throw Error('base');if(data.questions.some(q=>questionProblems(q).length))throw Error('bank schema');`);
 // Import real XLSX files through JSZip and DOM-equivalent XML nodes.
 for(const file of [path.join(root,'GAT_Import_Template.xlsx'),path.join(__dirname,'fixtures','bank-original-v9.xlsx')].filter(f=>fs.existsSync(f))){
 const buffer=fs.readFileSync(file);t.ctx.testFile={name:path.basename(file),size:buffer.length,arrayBuffer:async()=>buffer};
 const r=await t.run(`(async()=>{workbook=await openWorkbook(testFile);const i=workbook.sheets.findIndex(s=>s.name==='بنك_الأسئلة_1000');const rows=await readSheet(workbook,i<0?0:i);return analyzeRows(rows)})()`);
 assert.equal(r.errors.length,0);if(file.endsWith('Template.xlsx')){assert.equal(r.newCount,1);assert.equal(r.items[0].answer,1);assert.equal(r.items[0].options[1],'63')}else{assert.equal(r.skipped.length+r.items.length,1000);assert(r.items.every(q=>q.id==='Q-P-004'),'only the replaced legacy question may be newly imported')}
 }
 t.run(`
 const h=['معرف السؤال','القسم','التصنيف','الصعوبة','السؤال','الخيار أ','الخيار ب','الخيار ج','الخيار د','الإجابة الصحيحة','الشرح'];
 const row=['TEST-NEW','كمي','الحساب','سهل','سؤال اختبار الاستيراد فقط','أول','ثان','ثالث','رابع','ب','شرح تجريبي'];
 const rows=[{row:1,values:h},{row:2,values:row},{row:3,values:[...row.slice(0,1),'غير صالح',...row.slice(2)]}];
 const result=analyzeRows(rows);if(result.newCount!==1||result.errors.length!==1)throw Error('row validation');
 pendingImport=result;applyImport();if(data.questions.length!==1491)throw Error('commit import');
 startExam('اختبار 1','fixed');const firstIds=exam.qs.map(q=>q.id).join();
 exam.answers[0]=exam.qs[0].answer;exam.answers[1]=(exam.qs[1].answer+1)%4;finishExam();
 if(attempts.length!==1||counts(attempts[0]).correct!==1||counts(attempts[0]).wrong!==1||counts(attempts[0]).blank!==58)throw Error('detailed counts');
 startExam('اختبار 1','fixed');if(firstIds!==exam.qs.map(q=>q.id).join())throw Error('fixed repeat');finishExam();
 startExam('متجدد','random');if(exam.qs.filter(q=>q.section==='كمي').length!==30||new Set(exam.qs.map(q=>q.id)).size!==60)throw Error('balanced');
 const prevIds=new Set(exam.qs.map(q=>q.id));finishExam();startExam('متجدد','random');if(exam.qs.some(q=>prevIds.has(q.id)))throw Error('fresh pool');
 exam.answers=exam.qs.map(q=>q.answer);finishExam();if(counts(attempts.at(-1)).percent!==100)throw Error('score');
 const oldText=attempts[0].qs[0].text;data.questions.find(q=>q.id===attempts[0].qs[0].id).text='new bank text';if(attempts[0].qs[0].text!==oldText)throw Error('snapshot immutable');rebuild();
 const good=snapshot();validateBackup(good);const bad=clone(good);bad.attempts[0].answers[0]=9;let rejected=false;try{validateBackup(bad)}catch{rejected=true}if(!rejected)throw Error('bad backup accepted');
 startExam('اختبار 2','fixed');setExamAnswer(2);save();
 `);
 const resumed=newContext();resumed.run(`if(!exam||exam.answers[0]!==2)throw Error('resume');exam.deadline=Date.now()-1;exam.lastTouch=exam.deadline;finishExam('timeout');if(attempts.at(-1).reason!=='timeout')throw Error('expiry');resetWorkspace(false);if(attempts.length||history.length||exam||customQuestions.length!==1||data.questions.length!==1491)throw Error('progress reset');resetWorkspace(true);if(data.questions.length!==1490||customQuestions.length||attempts.length||history.length)throw Error('factory reset');`);
 const r2=newContext();r2.run(`if(data.questions.length!==1490||attempts.length||history.length)throw Error('persist reset');pendingImport={items:[{...clone(data.questions[0]),id:'quota-test',text:'unique'}],updateCount:0};`);failStorage=true;r2.run(`applyImport();if(customQuestions.length||data.questions.length!==1490)throw Error('quota rollback')`);failStorage=false;
 assert.equal(t.tools.length,2);assert.throws(()=>t.tools[1].execute({mode:'bogus'}));
 for(const p of ['index.html','data.js','app.js','core.js','style.css','GAT_Import_Template.xlsx','READ_ME.html','START_WINDOWS.bat','serve.py','vendor/jszip.min.js','vendor/JSZip-LICENSE.md',...t.ctx.GAT_BASE.references.map(r=>r.url)])assert(fs.existsSync(path.join(root,p)),p);
 console.log('PASS: real template XLSX parsing (original v9 fixture optional), row validation, import, balanced fresh/fixed exams, per-attempt grading and immutable details, resume/expiry, backup validation, scoped resets, quota rollback, asset paths.');
 console.log('Browser visual QA and native WebMCP validation unavailable for this static preview profile; state/DOM-double tests only.');
})().catch(e=>{console.error(e);process.exitCode=1});
