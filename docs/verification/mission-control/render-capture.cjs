const fs = require('fs');
const { Terminal } = require(process.cwd()+'/node_modules/@xterm/headless');
const [label,c,r] = process.argv.slice(2); const cols=+c, rows=+r;
const base='docs/verification/mission-control/'+label;
const t=new Terminal({cols, rows, allowProposedApi:true});
const raw=fs.readFileSync(base+'.ansi','utf8');
const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
t.write(raw,()=>{
 let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${cols*9+32}" height="${rows*18+32}" style="background:#0f131a"><rect width="100%" height="100%" fill="#0f131a"/><g font-family="Menlo,monospace" font-size="14" fill="#f8fafc">`;
 const lines=[];
 const palette=['#151b26','#f87171','#4ade80','#facc15','#60a5fa','#c084fc','#38bdf8','#cbd5e1','#94a3b8','#fca5a5','#86efac','#fde68a','#93c5fd','#d8b4fe','#67e8f9','#ffffff'];
 for(let y=0;y<rows;y++) { const line=t.buffer.active.getLine(y); lines.push(line?.translateToString(true)||'');
 for(let x=0;x<cols;x++){const cell=line?.getCell(x);const chars=cell?.getChars();if(!chars||chars===' ')continue;
 const fg=cell.getFgColor();const fill=cell.isFgRGB()?'#'+fg.toString(16).padStart(6,'0'):cell.isFgPalette()?palette[fg]||'#cbd5e1':'#f8fafc';
 svg+=`<text x="${16+x*9}" y="${30+y*18}" fill="${fill}"${cell.isBold()?' font-weight="bold"':''}>${esc(chars)}</text>`;}}
 svg+='</g></svg>';fs.writeFileSync(base+'.svg',svg);fs.writeFileSync(base+'.txt',lines.join('\n')); console.log(lines.join('\n'));
});
