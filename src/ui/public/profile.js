const text = document.getElementById('text'), status = document.getElementById('status');
function show(d) {
  status.textContent = d.status + '\n' + (d.missing.length ? 'Completá: ' + d.missing.join(', ') : '') + '\n' +
    (d.questions || []).map(item => item.section + ': ' + item.question).join('\n\n') + '\n' + (d.advice || '');
}
fetch('/api/profile').then(r => r.json()).then(d => {text.value=d.text; text.readOnly=d.legacy; document.getElementById('save').disabled=d.legacy; document.getElementById('file').disabled=d.legacy; show(d.diagnosis);}).catch(e=>status.textContent=e.message);
document.getElementById('file').onchange=async e=>{if(e.target.files[0])text.value=await e.target.files[0].text();};
document.getElementById('save').onclick=async()=>{try{const r=await fetch('/api/profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:text.value})});const d=await r.json();if(!r.ok)throw Error(d.error);show(d.diagnosis);}catch(e){status.textContent=e.message;}};
