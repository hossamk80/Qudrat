const fs=require('fs'),vm=require('vm'),assert=require('assert');
const nodes=new Map(),storage=new Map();
function el(){return {innerHTML:'',textContent:'',value:'',style:{},dataset:{},classList:{toggle(){}},addEventListener(){},appendChild(){},prepend(){},append(){},after(){},remove(){},querySelector(){return el()}}}
const ctx={console,Date,Math,Set,Map,Blob,URL,AbortController,location:{protocol:'file:'},confirm:()=>true,alert(){},setInterval:()=>1,clearInterval(){},setTimeout:()=>1,addEventListener(){},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},document:{querySelector:s=>{if(!nodes.has(s))nodes.set(s,el());return nodes.get(s)},querySelectorAll:()=>[],createElement:el,body:el()}};ctx.window=ctx;vm.createContext(ctx);for(const f of ['data.js','core.js','app.js','learn.js','engine.js'])vm.runInContext(fs.readFileSync('dist/'+f,'utf8'),ctx,{filename:f});const run=s=>vm.runInContext(s,ctx);

run(`
function ok(value,message){if(!value)throw Error(message)}
const originalNow=Date.now;let now=originalNow();Date.now=()=>now;
// Every blank must remain visible both in reports and the spaced-review queue.
history=[];attempts=[];exam=null;startLearningExam('diagnostic');finishExam();
ok(counts(attempts[0]).blank===20&&reviewItems().length===20,'blank review queue');
// Legacy reports previously omitted blanks from history; they must migrate logically.
history=[];ok(reviewItems().length===20,'legacy blank reconstruction');
// Strict mode blocks answer resources; open mode is an explicit persisted alternative.
startLearningExam('sectioned');const id=exam.id;go('lessons');ok(view==='exams'&&exam.id===id,'strict navigation');
ok(validateBackup(clone(snapshot())).activeExam.strict===true,'strict backup');
// Ten observed seconds, then a 54m50s absence: no phantom time on unseen questions.
for(let i=0;i<10;i++){now+=1000;syncBlocks()}
const saved=clone(exam);now+=54*60000+50000;
exam=checkedExam(saved,true);syncBlocks();exam.clockSuspended=false;
ok(exam.block===2&&exam.index===48,'resume block');
ok(exam.times[0]===10&&exam.times[24]===0&&exam.times[48]===0,'no phantom question time');
ok(exam.unobservedSeconds===3290,'complete gap accounting');
ok(exam.times.reduce((a,b)=>a+b,0)+exam.unobservedSeconds===3300,'wall clock conservation');
now+=2000;syncBlocks();ok(exam.times[48]===2,'resumed observed time');
// A delayed callback across the boundary cannot answer a newly displayed question.
now=exam.blockDeadline+1000;setExamAnswer(0);ok(exam.block===3&&exam.answers[72]===null,'stale answer');
// Backward OS clock changes never decrease lastTouch or add negative time.
const touched=exam.lastTouch;now-=2000;touchExam();ok(exam.lastTouch===touched,'clock reversal');now=touched;
// Expiry cannot allocate the missing interval to any question.
now=exam.deadline+60000;syncBlocks();ok(!exam&&attempts.at(-1).reason==='timeout','expiry');
const ended=attempts.at(-1);ok(Math.abs(ended.times.reduce((a,b)=>a+b,0)+ended.unobservedSeconds-(ended.finishedAt-ended.startedAt)/1000)<.001,'expiry time conservation');
// Repetition is separate: one wrong first attempt followed by five correct retries.
history=[];attempts=[];const q=data.questions[0];
record(q,(q.answer+1)%4);for(let i=0;i<5;i++)record(q,q.answer);
let skill=skillStats().find(g=>g.name===q.category);
ok(skill.ids.size===1&&skill.percent===0&&skill.repeatPercent===100,'first vs repeat accuracy');
const oldText=q.text;q.text+=' تغيّر';skill=skillStats().find(g=>g.name===q.category);ok(skill.ids.size===0,'question-version isolation');q.text=oldText;
// Reviewed-only is the default; Excel-like additions require an explicit full-bank selection.
const custom={...clone(q),id:'AUDIT-CUSTOM',text:'سؤال إضافي للاختبار'};delete custom.review;customQuestions.push(custom);rebuild();
ok(!questionBank().some(q=>q.id==='AUDIT-CUSTOM'),'unreviewed excluded');settings.bankScope='all';ok(questionBank().some(q=>q.id==='AUDIT-CUSTOM'),'explicit full bank');settings.bankScope='reviewed';
settings.strict=false;startLearningExam('diagnostic');go('lessons');ok(view==='lessons'&&!!exam,'open mode');now+=2000;touchExam();ok(exam.times.reduce((a,b)=>a+b,0)===0&&exam.unobservedSeconds===2,'off-screen time');finishExam();
// Custom section settings survive backup validation and maintain distribution/total.
settings.simBlocks=3;settings.simSize=10;settings.simMinutes=10;settings.simVerbal=75;startLearningExam('sectioned');
ok(exam.qs.length===30&&exam.qs.filter(q=>q.section==='لفظي').length===23,'custom distribution');
let backup=validateBackup(clone(snapshot()));ok(backup.activeExam.blockCount===3&&backup.settings.simVerbal===75,'custom restore');
const invalid=clone(snapshot());invalid.activeExam.blockSize=24;let rejected=false;try{validateBackup(invalid)}catch{rejected=true}ok(rejected,'invalid section geometry rejected');finishExam();
// Legacy six-by-twenty active sessions remain resumable without changing their blueprint.
const legacy={...clone(ended),id:'legacy-running',index:20,block:1,blockDeadline:now+60000,startedAt:now-60000,deadline:now+600000,lastTouch:now};delete legacy.blockCount;delete legacy.blockSize;delete legacy.blockMinutes;delete legacy.finishedAt;delete legacy.reason;
const restored=checkedExam(legacy,true);ok(restored.blockCount===6&&restored.blockSize===20,'legacy section migration');
// Restored event content keys and blank status must remain intact.
backup=validateBackup(clone(snapshot()));ok(backup.history.some(h=>h.status==='blank'&&h.contentKey),'history metadata restored');
// Never overwrite a newer write from another tab.
const external=JSON.stringify({...snapshot(),exportedAt:'external-revision'});localStorage.setItem(STORE,external);ok(save()===false&&localStorage.getItem(STORE)===external,'concurrent-tab protection');
Date.now=originalNow;
`);
console.log('PASS: blanks and legacy migration, strict/open navigation, 55-minute resume, observed/unobserved time conservation, expiry and stale clicks, versioned mastery, repeated answers, reviewed scope, configurable sections, backup metadata, old six-section sessions and concurrent-tab protection.');
