// OpenTandem phone pairing for DeepSeek Harness.
//
// Adds the `/opentandem` command and a page on the dsh web server (`/opentandem`). The page runs
// `opentandem remote --json` (the OpenTandem command line, whose launcher this plugin fetches from the OpenTandem
// server itself, so nothing has to be installed beforehand), shows the QR code it prints, and reports
// when the phone has signed in and allowed this computer. Signing in happens on the phone, in OpenTandem,
// so this plugin never sees an OpenTandem account or password, and it does not use the DeepSeek account.
// Every route sits behind dsh's own connection check (`requestRejection`), the same one dsh uses for its APIs.
import { execFile, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'opentandem-phone'
export const inject = ['webServer', 'connection', 'commands']

const PAGE = '/opentandem'
// The OpenTandem Runner on this computer reads ~/.opentandem-dsh/web-<pid>.json to send a phone message into a dsh
// session that this dsh web already holds (a session is written by one process only). The file names the local address
// and this run's access token, so it is readable by the current user only, and it is removed when dsh web stops.
const ADVERT_DIR = path.join(os.homedir(), '.opentandem-dsh')
const API = '/opentandem/api'
// What this page remembers across a dsh web restart: that this computer has been paired (or a pairing was under way), and who it is
// paired with. Not the truth, only the reason to ask the OpenTandem command line again on start: `remote --json` answers at once with
// `already_connected` (space, account, computer name from its own store) when connected, and prints a fresh QR code when not.
const STATE_FILE = path.join(ADVERT_DIR, 'phone.json')
const PENDING_MS = 10 * 60_000

const savedState = {
  load() { try { const value = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); return value && typeof value === 'object' ? value : null } catch { return null } },
  save(value) { try { fs.mkdirSync(ADVERT_DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(STATE_FILE, JSON.stringify(value), { mode: 0o600 }) } catch { /* the page still works from memory */ } },
  clear() { try { fs.rmSync(STATE_FILE, { force: true }) } catch { /* already gone */ } },
}

/** A pairing command left behind by a dsh web that was stopped with Ctrl-C (plugins are not unloaded then): stop it, so two
 *  of them do not wait for the same phone. Only a process that really is the pairing command is touched. */
function stopLeftover(pid) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || process.platform === 'win32') return
  try {
    const command = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout || ''
    if (/launcher\.mjs/.test(command) && /\bremote\b/.test(command)) process.kill(pid, 'SIGTERM')
  } catch { /* gone already */ }
}

// The command line launcher. OPENTANDEM_CLI (a path to a launcher or CLI .cjs/.mjs file, or to an `opentandem` executable)
// wins; otherwise the launcher is downloaded from the OpenTandem server (it carries no credentials and is the same
// file the npm package ships), kept under ~/.opentandem-dsh, and run on the Node.js that runs dsh. When the server cannot
// be reached, an earlier copy is used if there is one. The launcher then installs everything else by itself.
const SERVER = () => process.env.OPENTANDEM_SERVER || 'https://opentandem.org'

async function cliCommand() {
  const custom = process.env.OPENTANDEM_CLI
  if (custom) return /\.(c|m)?js$/.test(custom) ? { cmd: process.execPath, args: [custom] } : { cmd: custom, args: [] }
  const dir = path.join(os.homedir(), '.opentandem-dsh')
  const file = path.join(dir, 'launcher.mjs')
  try {
    const response = await fetch(`${SERVER()}/api/cli-script?file=launcher.mjs`, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'dsh-phone' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    fs.mkdirSync(dir, { recursive: true })
    const part = `${file}.${process.pid}.part`
    fs.writeFileSync(part, Buffer.from(await response.arrayBuffer()))
    fs.renameSync(part, file)
  } catch (error) {
    if (!fs.existsSync(file)) throw Object.assign(new Error(`Cannot reach ${SERVER()} (${error.message})`), { code: 'unreachable' })
  }
  return { cmd: process.execPath, args: [file] }
}

/** An SVG, or '' when it could not be made. Rendered in its own process: after dsh web hot-replaces this plugin, `qrcode` in this
 *  process can be left as an empty module (its lib/server.js cached but never run), and only a restart would clear that. */
function qrSvg(url) {
  return new Promise(resolve => {
    execFile(process.execPath, [fileURLToPath(new URL('./qr-svg.cjs', import.meta.url)), url], { timeout: 10_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
      (error, stdout) => resolve(!error && stdout.startsWith('<svg') ? stdout : ''))
  })
}

function createJob(onChange) {
  const job = { phase: 'idle', url: '', qr: '', team: '', account: '', name: '', code: '', message: '', switching: false }
  let child = null
  let preparing = false
  let generation = 0
  let expiry = null
  const set = patch => {
    Object.assign(job, patch)
    clearTimeout(expiry)
    expiry = null
    if (job.phase === 'qr') {
      // The command stops waiting after ten minutes; do not leave a dead QR code on the page if it says nothing.
      expiry = setTimeout(() => { if (job.phase === 'qr') { stopChild(); set({ phase: 'error', code: 'expired', message: '' }) } }, PENDING_MS + 5000)
      savedState.save({ phase: 'qr', pid: child?.pid, at: Date.now() })
    } else if (job.phase === 'connected' || job.phase === 'already') {
      savedState.save({ phase: job.phase, team: job.team, account: job.account, name: job.name, at: Date.now() })
    } else if (job.phase === 'error' && job.code === 'expired') savedState.clear()
    onChange?.(job)
  }
  const stopChild = () => { if (child) { child.kill('SIGTERM'); child = null } }
  const handle = async event => {
    if (event.type === 'qr') set({ phase: 'qr', url: event.url, qr: await qrSvg(event.url) })
    // macOS: the phone allowed and the OpenTandem app is being installed (opentandem 0.3.6+).
    else if (event.type === 'preparing') set({ phase: 'preparing' })
    else if (event.type === 'connected') set({ phase: 'connected', team: event.team, account: event.account, name: event.name })
    else if (event.type === 'already_connected') set({ phase: 'already', url: event.url, qr: event.url ? await qrSvg(event.url) : '', team: event.team, account: event.account, name: event.name })
    else if (event.type === 'error') set({ phase: 'error', code: event.code, message: event.message })
  }
  return {
    state: () => ({ ...job }),
    running: () => child !== null || preparing,
    /** `first` is the phase shown while the command starts: 'starting' when the user asked for a QR code, 'checking' when the page
     *  asks on its own whether this computer is already connected. */
    async start(first = 'starting', switching = false) {
      if (child || preparing) return
      const mine = ++generation
      preparing = true
      set({ phase: first, url: '', qr: '', team: '', account: '', name: '', code: '', message: '', switching })
      let command
      try {
        command = await cliCommand()
      } catch (error) {
        preparing = false
        if (mine === generation) set({ phase: 'error', code: error.code || 'spawn', message: error.message })
        return
      }
      preparing = false
      if (mine !== generation) return
      let proc
      try {
        proc = spawn(command.cmd, [...command.args, 'remote', '--json', '--source', 'dsh', ...(switching ? ['--switch'] : [])], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
      } catch (error) {
        set({ phase: 'error', code: 'spawn', message: error.message })
        return
      }
      child = proc
      let buffer = ''
      let lastError = ''
      proc.stderr.setEncoding('utf8')
      proc.stderr.on('data', chunk => { const line = chunk.split('\n').map(x => x.trim()).filter(Boolean).pop(); if (line) lastError = line })
      let chain = Promise.resolve()
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', chunk => {
        buffer += chunk
        let i
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i).trim()
          buffer = buffer.slice(i + 1)
          if (!line) continue
          let event
          try { event = JSON.parse(line) } catch { continue }
          chain = chain.then(() => handle(event)).catch(() => {})
        }
      })
      proc.on('error', error => {
        if (child === proc) child = null
        if (mine !== generation) return
        set({ phase: 'error', code: 'spawn', message: error.message })
      })
      proc.on('close', code => {
        chain.then(() => {
          if (child === proc) child = null
          // A command stopped by Cancel must not report on the check that replaced it.
          if (mine !== generation) return
          // Finished without a result event: the command died.
          if (['starting', 'checking', 'qr', 'preparing'].includes(job.phase)) set({ phase: 'error', code: 'exited', message: lastError || `opentandem exited with code ${code}` })
        })
      })
    },
    /** The plugin is being unloaded (dsh web stopping or reloading the plugin): stop the command but keep what the page remembers. */
    shutdown() { generation++; stopChild(); preparing = false; clearTimeout(expiry) },
    /** The user pressed Cancel. */
    cancel() {
      generation++
      stopChild()
      preparing = false
      // Switching account: this computer is still connected to the current one, so go back to showing it.
      if (job.switching) { void this.start('checking'); return }
      if (job.phase === 'qr' || job.phase === 'starting' || job.phase === 'checking') savedState.clear()
      set({ phase: 'idle', url: '', qr: '', message: '', code: '' })
    },
  }
}

const TEXT = {
  en: {
    title: 'Use this dsh from your phone',
    intro: 'Scan the QR code with your phone to connect this computer. Android phones are guided to install the OpenTandem app: sign in there and scan this code in the app. On iPhone, sign in in the browser and tap Allow. Then pick this computer in OpenTandem and send tasks to dsh.',
    noQr: 'The QR code could not be shown. Open the link above on your phone.', switchAccount: 'Switch account', switchDenied: 'Denied on the phone. This computer stays connected to the current account.', switchWaiting: 'Scan with your phone and tap Allow with the account you want. To use another account, tap Use another account on the phone. Until you allow, this computer stays connected to the current account.',
    preparing: 'Allowed. Preparing OpenTandem on this computer (2–3 minutes the first time)…',
    start: 'Show QR code', waiting: 'Waiting for your phone… (valid for 10 minutes)', starting: 'Preparing OpenTandem (about a minute the first time). You can leave this page; the QR code shows up here when it is ready.', checking: 'Checking whether this computer is already connected…',
    steps: ['Prepare', 'Scan and allow', 'Done'], link: 'Cannot scan? Open this link on your phone:',
    guide: ['Press "Show QR code" below. The first time, OpenTandem is prepared on this computer (2–3 minutes on a Mac, about a minute elsewhere).', 'Scan the QR code with your phone. Android phones are guided to install the OpenTandem app: sign in there and scan this code in the app. On iPhone, sign in in the browser and tap "Allow".', 'Open OpenTandem on your phone. The project folders your dsh uses, and their recent sessions, are added to the task list automatically (if dsh has not recorded any folder yet, you pick one). The phone and this computer continue the same session.'],
    connected: 'Connected. Open OpenTandem on your phone: the project folders your dsh uses and their recent sessions are added to the task list automatically.',
    already: 'This computer is connected to the account below. Scan to open OpenTandem on your phone with that account. To use another account, press Switch account.',
    cancel: 'Cancel', again: 'Try again',
    err: { managed_by_app: 'This computer is already connected to that workspace through the OpenTandem app. Open the app to manage it, or press Try again and sign in to another workspace on the phone.', denied: 'Denied on the phone. Nothing was connected.', expired: 'The QR code has expired. Press Try again for a new one.', unreachable: 'Cannot reach the OpenTandem server.', rate: 'Too many attempts from this network. Try again in 10 minutes.' },
    account: 'Account', team: 'Space', computer: 'Computer',
  },
  zh: {
    title: '在手机上使用这台电脑上的 dsh',
    intro: '用手机扫码连接这台电脑：安卓手机会引导安装 OpenTandem App，装好后在 App 里登录并扫这个码；iPhone 直接在浏览器里登录并点「允许」。之后在 OpenTandem 里选这台电脑，就能把任务发给 dsh。',
    noQr: '二维码显示不出来，请在手机上打开上面的链接。', switchAccount: '换账号连接', switchDenied: '手机上已拒绝，这台电脑仍然连接在原来的账号。', switchWaiting: '用手机扫码，用要连接的账号点「允许」。手机上显示的不是这个账号时，点「使用其他账号」。点「允许」之前，这台电脑仍然连接在原来的账号。',
    preparing: '已允许，正在这台电脑上准备 OpenTandem（首次约 2–3 分钟）…',
    start: '显示二维码', waiting: '等待手机操作…（10 分钟内有效）', starting: '正在准备 OpenTandem（首次约 1 分钟）。可以离开这个页面，准备好后回到这里就会看到二维码。', checking: '正在确认这台电脑是否已经连接…',
    steps: ['准备', '手机扫码并允许', '完成'], link: '扫不了？在手机上打开这个链接：',
    guide: ['点下面的「显示二维码」。第一次会在这台电脑上准备 OpenTandem（Mac 约 2–3 分钟，其他系统约 1 分钟）。', '用手机扫码连接这台电脑。安卓手机会引导安装 OpenTandem App，装好后在 App 里登录并扫这个码；iPhone 直接在浏览器里登录并点「允许」。', '在手机上打开 OpenTandem。你在 dsh 里使用的项目目录和其中最近的会话会自动添加到任务列表（如果 dsh 里还没有记录过目录，则由你选一个）。手机和这台电脑接着同一个会话聊。'],
    connected: '已连接。在手机上打开 OpenTandem：你在 dsh 里使用的项目目录和其中最近的会话会自动添加到任务列表。',
    already: '这台电脑已经连接到下面这个账号。扫描二维码后，用这个账号在手机上打开 OpenTandem。要用其他账号，请点「换账号连接」。',
    cancel: '取消', again: '重试',
    err: { managed_by_app: '这台电脑已经通过 OpenTandem 客户端连接到了该空间。请打开客户端管理，或点「重试」后在手机上登录另一个空间。', denied: '手机上已拒绝，没有连接任何东西。', expired: '二维码已过期，点「重试」生成新的。', unreachable: '连不上 OpenTandem 服务器。', rate: '当前网络尝试次数过多，请 10 分钟后再试。' },
    account: '账号', team: '空间', computer: '电脑',
  },
}

const html = () => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenTandem</title>
<style>
:root{color-scheme:light dark;font:15px/1.6 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
body{margin:0;display:flex;justify-content:center;padding:48px 16px}
main{max-width:460px;width:100%}
h1{font-size:20px;margin:0 0 8px}
p{margin:8px 0;opacity:.8}
button{font:inherit;padding:8px 18px;border-radius:8px;border:1px solid #8884;background:#2563eb;color:#fff;cursor:pointer}
button.ghost{background:transparent;color:inherit}
#buttons{display:flex;gap:8px}
#qr{margin:20px 0;display:flex;justify-content:center}
#qr svg{width:240px;height:240px;background:#fff;border-radius:12px;padding:8px;box-sizing:content-box}
.gd{margin:10px 0 0;padding-left:20px;font-size:14px;opacity:.85}.gd li{margin:4px 0}.lk{font-size:12px;word-break:break-all;text-align:center}.ok{color:#16a34a;font-weight:600}.bad{color:#dc2626}
.st{display:flex;gap:6px;list-style:none;padding:0;margin:16px 0}.st li{flex:1;font-size:13px;opacity:.5;display:flex;align-items:center;gap:6px;border-top:3px solid #8883;padding-top:8px}
.st li b{width:20px;height:20px;border-radius:50%;background:#8885;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:12px}
.st li.cur{opacity:1;border-color:#2563eb}.st li.cur b{background:#2563eb}.st li.done{opacity:1;color:#16a34a;border-color:#16a34a}.st li.done b{background:#16a34a}
.pg{height:6px;background:#8883;border-radius:3px;overflow:hidden;margin:10px 0}.pg i{display:block;height:100%;width:35%;background:#2563eb;border-radius:3px;animation:mv 1.4s ease-in-out infinite}@keyframes mv{0%{margin-left:-35%}100%{margin-left:100%}}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:12px 0}dt{opacity:.6}dd{margin:0}
</style></head><body><main>
<h1 id="title"></h1><p id="intro"></p><ol class="gd" id="gd"></ol><ol class="st" id="st"></ol><div id="qr"></div><p id="lnk" class="lk"></p><div id="msg"></div><dl id="info"></dl><div id="buttons"></div>
</main><script>
const T=${JSON.stringify(TEXT)};const L=/^zh/i.test(navigator.language)?'zh':'en';const S=T[L];
const $=id=>document.getElementById(id);
$('title').textContent=S.title;$('intro').textContent=S.intro;document.documentElement.lang=L;
const post=p=>fetch('${API}/'+p,{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.json());
function btn(label,fn,ghost){const b=document.createElement('button');b.textContent=label;if(ghost)b.className='ghost';b.onclick=fn;return b}
function steps(n){const e=$('st');e.innerHTML='';if(n<0)return;S.steps.forEach((t,i)=>{const li=document.createElement('li');li.className=i<n?'done':i===n?'cur':'';const b=document.createElement('b');b.textContent=i<n?'✓':String(i+1);li.append(b,t);e.append(li)})}
function render(s){
  const g=$('gd');g.innerHTML='';if(s.phase==='idle')S.guide.forEach(t=>{const li=document.createElement('li');li.textContent=t;g.append(li)});
  steps(s.phase==='starting'?0:s.phase==='qr'?1:s.phase==='preparing'?2:s.phase==='connected'||s.phase==='already'?3:-1);
  $('qr').innerHTML=(s.phase==='qr'||s.phase==='already')?s.qr:'';
  const lk=$('lnk');lk.innerHTML='';if(s.phase==='qr'&&/^https?:/.test(s.url)){lk.append(S.link+' ');const a=document.createElement('a');a.href=s.url;a.textContent=s.url;a.target='_blank';a.rel='noopener';lk.append(a)}
  const m=$('msg'),i=$('info'),b=$('buttons');m.className='';i.innerHTML='';b.innerHTML='';
  if(s.phase==='idle'){b.append(btn(S.start,()=>post('start').then(render)))}
  else if(s.phase==='starting'||s.phase==='checking'||s.phase==='preparing'){m.textContent=s.phase==='checking'?S.checking:s.phase==='preparing'?S.preparing:S.starting;m.insertAdjacentHTML('beforeend','<div class="pg"><i></i></div>')}
  else if(s.phase==='qr'){m.textContent=!s.qr?S.noQr:s.switching?S.switchWaiting:S.waiting;b.append(btn(S.cancel,()=>post('cancel').then(render),true))}
  else if(s.phase==='already'||s.phase==='connected'){
    m.className=s.phase==='connected'?'ok':'';m.textContent=s.phase==='connected'?S.connected:S.already;
    for(const [k,v] of [[S.computer,s.name],[S.team,s.team],[S.account,s.account]]){if(v){i.insertAdjacentHTML('beforeend','<dt></dt><dd></dd>');const n=i.children.length;i.children[n-2].textContent=k;i.children[n-1].textContent=v}}
    b.append(btn(S.switchAccount,()=>post('switch').then(render),true))
  }
  else if(s.phase==='error'){m.className='bad';m.textContent=s.switching&&s.code==='denied'?S.switchDenied:S.err[s.code]||s.message;b.append(btn(S.again,()=>post('start').then(render)));if(s.switching)b.append(btn(S.cancel,()=>post('cancel').then(render),true))}
}
async function tick(){try{render(await (await fetch('${API}/state')).json())}catch{}}
tick();setInterval(tick,1500);
</script></body></html>`

const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' } }

function advertiseWeb(ctx) {
  const file = path.join(ADVERT_DIR, `web-${process.pid}.json`)
  try {
    fs.mkdirSync(ADVERT_DIR, { recursive: true, mode: 0o700 })
    // Files left by dsh web processes that died without cleaning up.
    for (const name of fs.readdirSync(ADVERT_DIR)) {
      const m = /^web-(\d+)\.json$/.exec(name)
      if (m && Number(m[1]) !== process.pid && !alive(Number(m[1]))) fs.rmSync(path.join(ADVERT_DIR, name), { force: true })
    }
    // DSH 0.1.x serves plain HTTP and has no protocol property; 0.2.x supplies it.
    const base = `${String(ctx.webServer.protocol ?? 'http:').replace(/:$/, '')}://127.0.0.1:${ctx.webServer.port}/`
    const token = new URL(ctx.connection.authenticatedUrl(base)).searchParams.get('token')
    if (!token) return () => {}
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify({ pid: process.pid, url: base, token, started_at: new Date().toISOString() }), { mode: 0o600 })
    fs.renameSync(temp, file)
  } catch {
    return () => {}
  }
  const remove = () => { try { fs.rmSync(file, { force: true }) } catch { /* already gone */ } }
  // dsh web is usually stopped with Ctrl-C, which exits the process without unloading plugins.
  process.once('exit', remove)
  return () => { process.removeListener('exit', remove); remove() }
}

export function apply(ctx) {
  const job = createJob()
  ctx.effect(() => advertiseWeb(ctx), 'opentandem-phone: advertise the local address to the Runner')
  const rejected = (req, res) => {
    const code = ctx.connection.requestRejection(req)
    if (code === undefined) return false
    res.statusCode = code
    res.end()
    return true
  }
  const json = (res, status, body) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }
  const post = (req, res, action) => {
    if (req.method !== 'POST') { res.statusCode = 405; res.setHeader('allow', 'POST'); res.end(); return }
    // A cross-site form cannot send application/json without a preflight, so this refuses forged requests.
    if (String(req.headers['content-type']).split(';', 1)[0].trim().toLowerCase() !== 'application/json') { res.statusCode = 415; res.end(); return }
    req.resume()
    action()
    json(res, 200, job.state())
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: PAGE,
    handler: (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET') { res.statusCode = 405; res.setHeader('allow', 'GET'); res.end(); return }
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(html())
    },
  }), `opentandem-phone: GET ${PAGE}`)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: `${API}/state`,
    handler: (req, res) => { if (rejected(req, res)) return; json(res, 200, job.state()) },
  }), `opentandem-phone: GET ${API}/state`)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: `${API}/start`,
    handler: (req, res) => { if (rejected(req, res)) return; post(req, res, () => job.start('starting', job.state().switching)) },
  }), `opentandem-phone: POST ${API}/start`)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: `${API}/switch`,
    handler: (req, res) => { if (rejected(req, res)) return; post(req, res, () => job.start('starting', true)) },
  }), `opentandem-phone: POST ${API}/switch`)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: `${API}/cancel`,
    handler: (req, res) => { if (rejected(req, res)) return; post(req, res, () => job.cancel()) },
  }), `opentandem-phone: POST ${API}/cancel`)
  ctx.effect(() => () => job.shutdown(), 'opentandem-phone: stop pairing')

  // The page must not start from scratch every time dsh web starts: when this computer has been paired before (or a pairing was
  // under way), ask the command line right away. Connected: it answers with who this computer is connected to. A QR code that was
  // still waiting: a fresh one is shown. Never used: the page waits for the button as before.
  const saved = savedState.load()
  if (saved) {
    stopLeftover(saved.pid)
    void job.start('checking')
  }

  ctx.commands.register({
    name: 'opentandem',
    description: 'Connect your phone to this computer through OpenTandem',
    recordInput: false,
    handler: () => ({ kind: 'success', text: `Open ${PAGE} on this dsh web page (for example http://127.0.0.1:<port>${PAGE}) and scan the QR code with your phone.` }),
  })
}
