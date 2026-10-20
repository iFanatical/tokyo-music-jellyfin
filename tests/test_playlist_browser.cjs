const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const CHROME = process.env.CHROME_BIN || 'chromium';
// Skip rather than fail where no browser is installed (CI, minimal hosts).
if (spawnSync(CHROME, ['--version'], { stdio: 'ignore' }).error) {
  console.log(`skip: ${CHROME} not found (set CHROME_BIN to run browser tests)`);
  process.exit(0);
}
const profile = fs.mkdtempSync('/tmp/tokyo-playlist-chrome-');
const browser = spawn(CHROME,
  ['--headless', '--no-sandbox', '--disable-gpu', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
   '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], {stdio:'ignore'});
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let socket;
  try {
    let targets;
    for (let i=0; i<80; i++) {
      try { const port=fs.readFileSync(profile+'/DevToolsActivePort','utf8').split('\n')[0]; targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); break; }
      catch { await sleep(200); }
    }
    assert(targets, 'Browser started');
    socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => socket.addEventListener('open', r, {once:true}));
    let next = 0;
    const pending = new Map(), errors = [];
    socket.addEventListener('message', ({data}) => {
      const m = JSON.parse(data);
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params);
      if (m.id) { const p=pending.get(m.id); pending.delete(m.id); m.error?p.reject(m.error):p.resolve(m.result); }
    });
    const call = (method, params={}) => new Promise((resolve,reject) => {
      const id=++next; pending.set(id,{resolve,reject}); socket.send(JSON.stringify({id,method,params}));
    });
    const evaluate = async expression => {
      const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
      if(result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await call('Runtime.enable'); await call('Page.enable');
    await call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await call('Page.navigate',{url:process.env.TOKYO_TEST_URL || 'http://127.0.0.1:8099/tests/playlist-browser.html'});
    for(let i=0;i<80;i++) { if(await evaluate('window.ready')) break; await sleep(100); }
    assert(await evaluate('window.ready'), JSON.stringify(errors));

    const save=()=>evaluate("document.querySelector('.modal-foot .primary').click()");
    const setFields=(name, visibility)=>evaluate(`document.querySelector('#playlist-edit-name').value=${JSON.stringify(name)}; document.querySelector('#playlist-edit-visibility').value=${JSON.stringify(visibility)}`);
    const waitClosed=async()=>{ for(let i=0;i<60;i++){ if(await evaluate("!document.querySelector('.modal')"))return; await sleep(20); } throw new Error('Dialog did not close'); };
    await evaluate('showPlaylist()');
    assert(await evaluate("[...document.querySelectorAll('.detail-actions button')].some(b=>b.textContent==='Edit playlist')"));
    assert.equal(await evaluate("document.querySelector('.hero-line .strong').textContent"),'Private');
    await evaluate('openEditor()');
    await setFields('New name','private');
    await save(); await waitClosed();
    assert.deepEqual(await evaluate('writes.at(-1)'),{path:'/Playlists/playlist-test',body:{Name:'New name'}});
    assert.equal(await evaluate('changed'),1);
    assert.equal(await evaluate('callbacks'),1);
    assert.deepEqual(await evaluate('state.ItemIds'),['song-1','song-2','song-1']);
    assert.deepEqual(await evaluate('state.Shares'),[{UserId:'friend',CanEdit:true}]);
    await evaluate('openEditor()');
    await setFields('New name','public');
    await save(); await waitClosed();
    assert.deepEqual(await evaluate('writes.at(-1).body'),{IsPublic:true});
    await evaluate('showPlaylist()');
    assert.equal(await evaluate("document.querySelector('.hero-line .strong').textContent"),'Public');
    await evaluate('openEditor()');
    await setFields('New name','private');
    await save(); await waitClosed();
    assert.deepEqual(await evaluate('writes.at(-1).body'),{IsPublic:false});
    assert.deepEqual(await evaluate('state.Shares'),[{UserId:'friend',CanEdit:true}]);
    const savedCount=await evaluate('writes.length');
    await evaluate('openEditor()'); await save(); await waitClosed();
    assert.equal(await evaluate('writes.length'),savedCount);
    await evaluate('openEditor()'); await setFields('   ','public'); await save();
    assert.equal(await evaluate('writes.length'),savedCount);
    assert.equal(await evaluate("document.querySelector('.modal [role=alert]').textContent"),'Enter a playlist name.');
    await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await waitClosed();
    await evaluate('state.canEdit=false; permissionMissing=true; openEditor()');
    assert.equal(await evaluate("document.querySelector('.modal-foot .primary').disabled"),true);
    assert.equal(await evaluate("document.querySelector('#playlist-edit-visibility').disabled"),true);
    assert((await evaluate("document.querySelector('.modal [role=status]').textContent")).includes('Read-only'));
    await evaluate("document.querySelector('.modal-backdrop').close()");
    await evaluate('state.canEdit=true; permissionMissing=false; failSave=true; openEditor()');
    await setFields('Not saved','public'); await save();
    assert((await evaluate("document.querySelector('.modal [role=alert]').textContent")).includes('permission'));
    assert.equal(await evaluate("document.querySelector('.modal-foot .primary').disabled"),false);
    assert.equal(await evaluate('state.Name'),'New name');
    await evaluate("document.querySelector('.modal-backdrop').close(); failSave=false; failLoad=true; openEditor()");
    assert.equal(await evaluate("document.querySelector('.modal-foot .primary').disabled"),true);
    assert((await evaluate("document.querySelector('.modal [role=status]').textContent")).includes('nothing has been changed'));
    await evaluate("document.querySelector('.modal-backdrop').close(); failLoad=false; delaySave=true; openEditor()");
    await setFields('Save once','public'); await save(); await save();
    assert.equal(await evaluate("document.querySelector('.modal-foot .primary').disabled"),true);
    await evaluate('releaseSave()'); await waitClosed();
    assert.equal(await evaluate('writes.length'),savedCount+2); // rejected save + one successful save
    await evaluate('delaySave=false; openEditor()');
    await sleep(300); // allow the existing modal entrance animation to settle
    fs.writeFileSync(profile+'/playlist-desktop.png',Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
    assert(await evaluate("document.querySelector('.modal').getBoundingClientRect().right<=innerWidth"));
    fs.writeFileSync(profile+'/playlist-mobile.png',Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
    assert.equal(errors.length,0,JSON.stringify(errors));
    console.log('PASS: detail controls, rename, public/private, preserving tracks/shares, permissions, validation, cancellation, errors, duplicate-submit protection and responsive modal. Artifacts:',profile);
  } finally { socket?.close(); browser.kill(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
