/** Static nonce-authorised webview code. All event text is rendered with textContent. */
export const activityScript = `
let activityFeed, activityClock, activityTimer, activityStartedAt=0, lastActivityAt=0;
const activityRows=new Map();
function updateActivityClock(){
  const now=Date.now();
  if(activityClock)activityClock.textContent='Elapsed '+Math.floor((now-activityStartedAt)/1000)+'s · No new activity for '+Math.floor((now-lastActivityAt)/1000)+'s';
  for(const {summary,value} of activityRows.values())summary.textContent=value.label+' · '+value.status+' · '+Math.max(0,Math.floor(((value.finishedAt||now)-value.startedAt)/1000))+'s';
}
function startActivityFeed(){
  clearInterval(activityTimer);activityRows.clear();
  activityStartedAt=lastActivityAt=Date.now();
  activityFeed=document.createElement('section');activityFeed.className='live-feed';activityFeed.setAttribute('aria-label','Live activity');activityFeed.setAttribute('aria-live','off');
  const title=document.createElement('strong');title.textContent='Live activity';
  activityClock=document.createElement('p');activityClock.className='hint';
  const hint=document.createElement('p');hint.className='hint';hint.textContent='Expand an entry for details. Output is limited to 16,384 characters per entry and 100 entries per turn. Partial lines appear when complete. Credential filtering is best effort.';
  activityFeed.append(title,activityClock,hint);conversation.append(activityFeed);
  updateActivityClock();activityTimer=setInterval(updateActivityClock,1000);
}
function showTurnActivity(value){
  if(!activityFeed)return;
  lastActivityAt=Date.now();
  let row=activityRows.get(value.id);
  if(!row){
    const details=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('pre');
    details.append(summary,body);activityFeed.append(details);row={summary,body,value};activityRows.set(value.id,row);
  }
  row.value=value;row.body.textContent=value.detail||'No details supplied yet.';
  if(typeof uiState!=='undefined'&&uiState==='stopping'){updateActivityClock();return;}
  if(!value.finishedAt)activityMessage.textContent=value.label+' · '+value.status;
  else {
    const active=[...activityRows.values()].filter(entry=>!entry.value.finishedAt).pop();
    activityMessage.textContent=active?active.value.label+' · '+active.value.status:'Waiting for the next Codex update…';
  }
  updateActivityClock();
}
function finishActivityFeed(){
  clearInterval(activityTimer);activityTimer=undefined;
  if(activityClock)activityClock.textContent='Turn ended · Elapsed '+Math.floor((Date.now()-activityStartedAt)/1000)+'s';
}
window.addEventListener('message',event=>{
  const message=event.data;
  if(message.type==='activity'&&message.state==='running'&&!activityTimer)startActivityFeed();
  if(message.type==='turn-activity')showTurnActivity(message.value);
  if(message.type==='output'){lastActivityAt=Date.now();}
  if(message.type==='finished')finishActivityFeed();
  if(message.type==='conversation-reset'){finishActivityFeed();activityRows.clear();activityFeed=undefined;activityClock=undefined;}
});
window.addEventListener('pagehide',()=>clearInterval(activityTimer));
`;
