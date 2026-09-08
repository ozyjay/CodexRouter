/** Static nonce-authorised webview code for safe, dependency-free Markdown rendering. */
export const markdownScript = `
function appendInlineMarkdown(parent,text){
  const patterns=[
    {regex:/^\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+|mailto:[^\\s)]+)\\)/,tag:'a'},
    {regex:/^\\*\\*([^*]+)\\*\\*/,tag:'strong'},
    {regex:/^__([^_]+)__/,tag:'strong'},
    {regex:/^~~([^~]+)~~/,tag:'s'},
    {regex:/^\\*([^*]+)\\*/,tag:'em'},
    {regex:/^_([^_]+)_/,tag:'em'},
    {regex:new RegExp('^'+String.fromCharCode(96)+'([^'+String.fromCharCode(96)+']+)'+String.fromCharCode(96)),tag:'code'}
  ];
  while(text){
    let match,pattern;
    for(const candidate of patterns){match=text.match(candidate.regex);if(match){pattern=candidate;break;}}
    if(match&&pattern){
      const element=document.createElement(pattern.tag);
      if(pattern.tag==='a'){element.textContent=match[1];element.href=match[2];element.title=match[2];}
      else if(pattern.tag==='code')element.textContent=match[1];
      else appendInlineMarkdown(element,match[1]);
      parent.append(element);text=text.slice(match[0].length);continue;
    }
    let next=text.length;
    for(let index=1;index<text.length;index++)if('*_~['.includes(text[index])||text.charCodeAt(index)===96){next=index;break;}
    parent.append(document.createTextNode(text.slice(0,next)));text=text.slice(next);
  }
}
function renderMarkdown(target,source){
  target.replaceChildren();
  const lines=source.replace(/\\r\\n?/g,'\\n').split('\\n');
  const fence=String.fromCharCode(96,96,96);let index=0;
  while(index<lines.length){
    const line=lines[index];
    if(!line.trim()){index++;continue;}
    if(line.startsWith(fence)){
      const language=line.slice(3).trim(),content=[];index++;
      while(index<lines.length&&!lines[index].startsWith(fence))content.push(lines[index++]);
      if(index<lines.length)index++;
      const pre=document.createElement('pre'),code=document.createElement('code');code.textContent=content.join('\\n');
      if(language)code.className='language-'+language.replace(/[^a-z0-9_-]/gi,'');pre.append(code);target.append(pre);continue;
    }
    const heading=line.match(/^(#{1,6})\\s+(.+)$/);
    if(heading){const element=document.createElement('h'+heading[1].length);appendInlineMarkdown(element,heading[2]);target.append(element);index++;continue;}
    if(/^\\s*([-*_])(?:\\s*\\1){2,}\\s*$/.test(line)){target.append(document.createElement('hr'));index++;continue;}
    const list=line.match(/^\\s*(?:([-+*])|(\\d+)\\.)\\s+(.+)$/);
    if(list){
      const ordered=Boolean(list[2]),container=document.createElement(ordered?'ol':'ul');
      while(index<lines.length){const item=lines[index].match(/^\\s*(?:([-+*])|(\\d+)\\.)\\s+(.+)$/);if(!item||Boolean(item[2])!==ordered)break;const li=document.createElement('li');appendInlineMarkdown(li,item[3]);container.append(li);index++;}
      target.append(container);continue;
    }
    if(/^>\\s?/.test(line)){const quote=document.createElement('blockquote'),parts=[];while(index<lines.length&&/^>\\s?/.test(lines[index]))parts.push(lines[index++].replace(/^>\\s?/,''));appendInlineMarkdown(quote,parts.join('\\n'));target.append(quote);continue;}
    const parts=[line];index++;
    while(index<lines.length&&lines[index].trim()&&!lines[index].startsWith(fence)&&!(/^(#{1,6})\\s+/.test(lines[index]))&&!(/^\\s*(?:[-+*]|\\d+\\.)\\s+/.test(lines[index]))&&!(/^>\\s?/.test(lines[index])))parts.push(lines[index++]);
    const paragraph=document.createElement('p');appendInlineMarkdown(paragraph,parts.join('\\n'));target.append(paragraph);
  }
}
`;
