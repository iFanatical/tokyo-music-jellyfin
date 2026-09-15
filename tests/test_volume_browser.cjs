const { spawn } = require('node:child_process');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const profile = fs.mkdtempSync('/tmp/tokyo-volume-chrome-');
const browser = spawn(process.env.CHROME_BIN || 'chromium',
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
    await call('Page.navigate',{url:process.env.TOKYO_TEST_URL || 'http://127.0.0.1:8099/tests/volume-browser.html'});
    for(let i=0;i<80;i++) { if(await evaluate('window.ready')) break; await sleep(100); }
    assert(await evaluate('window.ready'), JSON.stringify(errors));
    const results=[];
    for(const v of [0,0.4,0.5,0.75,1]) {
      for(const mode of ['sine','step','burst']) {
        const r=await evaluate(`renderAudio(${v},1,${JSON.stringify(mode)})`);
        results.push(r); console.log(JSON.stringify(r));
      }
    }
    fs.writeFileSync(profile+'/audio-results.json',JSON.stringify(results,null,2));
    for(const r of results) {
      if(r.position<=0.5) assert(r.error<1e-5, 'Unity/attenuation accuracy: '+JSON.stringify(r));
      assert(r.peak<=1.001, 'Peak ceiling: '+JSON.stringify(r));
    }
    const bounds=await evaluate('document.querySelector(".volume-wrap .range").getBoundingClientRect().toJSON()');
    await evaluate(`window.events=[]; for(const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture']) document.addEventListener(type,e=>events.push({type,id:e.pointerId,x:e.clientX,buttons:e.buttons,target:e.target.className}),true)`);
    assert(bounds.width >= 180 && bounds.height >= 32, JSON.stringify(bounds));
    const mouse=(type,x,y,button='none',buttons=0)=>call('Input.dispatchMouseEvent',{type,x,y,button,buttons,clickCount:1});
    const x=ratio=>bounds.left+bounds.width*ratio, y=bounds.top+bounds.height/2;
    await mouse('mousePressed',x(.2),y,'left',1);
    await mouse('mouseMoved',x(.8),y-130,'none',1);
    await mouse('mouseReleased',x(.8),y-130,'left');
    assert(Math.abs(await evaluate('player.volume')-.8)<.01, 'Outside release keeps dragged value');
    await mouse('mousePressed',x(.3),y,'left',1);
    await mouse('mouseMoved',x(.7),y,'none',1);
    await evaluate(`document.querySelector('.volume-wrap .range').dispatchEvent(new PointerEvent('pointercancel', {pointerId:1, clientX:0, bubbles:true}))`);
    assert(Math.abs(await evaluate('player.volume')-.7)<.01, 'Cancel keeps last pointermove');
    assert.equal(await evaluate('document.querySelector(".volume-wrap .range").isDragging()'),false);
    await mouse('mouseReleased',x(.7),y,'left');
    await evaluate('document.querySelector(".volume-unity").click()');
    assert.equal(await evaluate('player.volume'),.5);
    assert.equal(await evaluate('document.querySelector(".volume-readout").textContent'),'0 dB');
    await evaluate(`window.keyBubbles=0; document.addEventListener('keydown',()=>window.keyBubbles++); document.querySelector('.volume-wrap .range').focus()`);
    await call('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
    assert(Math.abs(await evaluate('player.volume')-.51)<1e-6);
    assert.equal(await evaluate('window.keyBubbles'),0);
    const enterDb = async (value) => {
      await evaluate(`document.querySelector('.volume-readout').click(); document.querySelector('.volume-db-input').value=${JSON.stringify(value)}`);
      await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    };
    await enterDb('-36');
    assert.equal(await evaluate('document.querySelector(".volume-readout").textContent'),'-36.0 dB');
    const minus36 = await evaluate('player.volume');
    assert(minus36>0 && minus36<.5);
    await enterDb('34');
    assert.equal(await evaluate('player.volume'),minus36);
    assert.equal(await evaluate('document.querySelector(".volume-db-input").getAttribute("aria-invalid")'),'true');
    assert.equal(await evaluate('document.querySelector(".volume-db-error").hidden'),false);
    await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    assert.equal(await evaluate('document.querySelector(".volume-db-input").hidden'),true);
    await enterDb('0');
    assert.equal(await evaluate('player.volume'),.5);
    const dimensions=await evaluate(`({seek:getComputedStyle(document.querySelector('.seek-row .range-track')).height,
      volume:getComputedStyle(document.querySelector('.volume-wrap .range-track')).height,
      buttons:[...document.querySelectorAll('.player-right > button')].map(b=>b.getBoundingClientRect().height)})`);
    assert.equal(dimensions.seek,dimensions.volume);
    assert.equal(dimensions.seek,'8px');
    assert(dimensions.buttons.every(h=>h>=42));
    const spacing=await evaluate(`(() => {
      const rect=s=>document.querySelector(s).getBoundingClientRect();
      const quality=rect('.player-right .bitrate-tag');
      const fullscreen=rect('.player-right > .icon-btn');
      const transport=rect('.transport');
      return {quality:fullscreen.left-quality.right,
        above:transport.top-rect('.player').top-1,
        below:rect('.seek-row .range-track').top-transport.bottom};
    })()`);
    assert.equal(spacing.quality,9,'Quality/fullscreen gap includes the extra 5px');
    assert(Math.abs(spacing.above-spacing.below)<=1,JSON.stringify(spacing));
    const playback=await evaluate('checkPlayback()');
    assert.equal(playback.running,'running');
    assert.equal(playback.reused,true);
    assert.equal(playback.elementGain,1);
    assert(Math.abs(playback.gain-Math.pow(10,6/20))<1e-5);
    console.log('Playback',playback);
    fs.writeFileSync(profile+'/desktop.png',Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
    for(const width of [1100,1000,800,720,390]) {
      await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
      assert(await evaluate('document.documentElement.scrollWidth <= innerWidth'), `Layout overflow at ${width}`);
    }
    for(const width of [980,800,720,390,320]) {
      await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
      await evaluate('document.querySelector(".volume-toggle").click()');
      const popup=await evaluate(`({open:document.querySelector('.volume-toggle').getAttribute('aria-expanded'),
        rect:document.querySelector('.volume-wrap').getBoundingClientRect().toJSON()})`);
      assert.equal(popup.open,'true');
      assert(popup.rect.width>250 && popup.rect.x>=0 && popup.rect.right<=width, JSON.stringify(popup));
      await enterDb('-36');
      assert.equal(await evaluate('document.querySelector(".volume-readout").textContent'),'-36.0 dB');
      if(width===390) fs.writeFileSync(profile+'/compact.png',Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
      await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      assert.equal(await evaluate('document.querySelector(".volume-toggle").getAttribute("aria-expanded")'),'false');
      assert.equal(await evaluate('document.activeElement.classList.contains("volume-toggle")'),true);
      await evaluate('document.querySelector(".volume-toggle").click()');
      await mouse('mousePressed',5,100,'left',1); await mouse('mouseReleased',5,100,'left');
      assert.equal(await evaluate('document.querySelector(".volume-toggle").getAttribute("aria-expanded")'),'false');
    }
    await evaluate('document.querySelector(".volume-toggle").click()');
    await call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await sleep(50);
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".volume-toggle")).display'),'none');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".volume-wrap")).display'),'flex');
    assert.equal(await evaluate('document.querySelector(".volume-toggle").getAttribute("aria-expanded")'),'false');
    assert.equal(errors.length,0,JSON.stringify(errors));
    console.log('PASS: audio, drag/cancellation, keyboard, exact dB entry and responsive popover. Artifacts:', profile);
  } finally { socket?.close(); browser.kill(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
