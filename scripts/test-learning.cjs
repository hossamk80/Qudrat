const fs=require('fs'),vm=require('vm'),assert=require('assert');
const nodes=new Map(),storage=new Map();
function el(){return {innerHTML:'',textContent:'',value:'',style:{},dataset:{},classList:{toggle(){}},addEventListener(){},appendChild(){},prepend(){},append(){},after(){},remove(){},querySelector(){return el()}}}
const ctx={console,Date,Math,Set,Map,Blob,URL,AbortController,location:{protocol:'file:'},confirm:()=>true,alert(){},setInterval:()=>1,clearInterval(){},setTimeout:()=>1,addEventListener(){},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},document:{querySelector:s=>{if(!nodes.has(s))nodes.set(s,el());return nodes.get(s)},querySelectorAll:()=>[],createElement:el,body:el()}};ctx.window=ctx;vm.createContext(ctx);for(const f of ['data.js','core.js','app.js','learn.js','engine.js'])vm.runInContext(fs.readFileSync('dist/'+f,'utf8'),ctx,{filename:f});const run=s=>vm.runInContext(s,ctx);
run(`
 if(view!=='home')throw Error('initial learning route');
 for(const v of ['home','lessons','review','practice','progress','exams','reports','manage','references'])go(v);
 const base=clone(data.questions[0]);for(let i=0;i<100;i++){const m=mixedOptions(base);if(m.options[m.answer]!==base.options[base.answer])throw Error('shuffle grading');}
 const dupe=clone(base);dupe.id='duplicate';if(uniqueQuestions([base,dupe]).length!==1)throw Error('dedupe');
 startLearningExam('diagnostic');if(exam.qs.length!==20||exam.deadline-exam.startedAt!==25*60000||exam.qs.filter(q=>q.section==='لفظي').length!==10)throw Error('diagnostic');
 if(new Set(exam.qs.map(q=>q.category)).size!==13)throw Error('skill coverage');
 exam.answers[0]=exam.qs[0].answer;finishExam();if(counts(attempts.at(-1)).correct!==1||counts(attempts.at(-1)).blank!==19)throw Error('grading report');
 startLearningExam('sectioned');if(exam.qs.length!==120||new Set(exam.qs.map(q=>q.id)).size!==120)throw Error('long form');
 if(exam.blockCount!==5||exam.blockSize!==24||exam.deadline-exam.startedAt!==125*60000)throw Error('new section profile');for(let b=0;b<5;b++){if(exam.qs.slice(b*24,b*24+24).filter(q=>q.section==='لفظي').length!==12)throw Error('block distribution');}
 jump(24);if(exam.index!==0)throw Error('future block jump');jump(19);if(exam.index!==19)throw Error('within block');
 const saved=validateBackup(clone(snapshot()));if(saved.activeExam.profile!=='sectioned'||saved.activeExam.blockDeadline!==exam.blockDeadline)throw Error('backup section persistence');
 exam.blockDeadline=Date.now()-1;exam.lastTouch=Date.now()-10000;const answerBefore=exam.answers[24];setExamAnswer(0);if(exam.block!==1||exam.index!==24||exam.answers[24]!==answerBefore)throw Error('stale click at transition');jump(0);if(exam.index!==24)throw Error('closed block');
 finishExam();validateBackup(clone(snapshot()));
 startExam('اختبار 1','fixed');if(exam.qs.map(q=>q.id).join()!==data.tests['اختبار 1'].join())throw Error('fixed preserved');finishExam();
 history=[];attempts=[];const q=data.questions[0];history.push({id:q.id,category:q.category,section:q.section,contentKey:contentKey(q),correct:false,at:new Date().toISOString()});if(!reviewItems()[0].dueNow)throw Error('wrong due');history.push({id:q.id,category:q.category,section:q.section,contentKey:contentKey(q),correct:true,at:new Date().toISOString()});if(reviewItems()[0].dueNow)throw Error('spaced correct');if(!reviewItems(Date.now()+86400001)[0].dueNow)throw Error('next day due');
 settings.goal=20;if(validateBackup(clone(snapshot())).settings.goal!==20)throw Error('goal persistence');
 trainSkill('الجبر');if(!question||question.category!=='الجبر')throw Error('skill practice');selected=question.answer;record(question,selected);if(!history.at(-1).correct)throw Error('practice grading');
`);
console.log('PASS: learning routes, 13-skill diagnostic, option grading, duplicates, 120-question five-section distribution, deadline transition, closed-section locks, stale-click protection, compatible backups, fixed forms, spaced review, goal, focused practice. DOM state tests; browser layout not tested.');
