"use strict";var Ee=Object.create;var z=Object.defineProperty;var Be=Object.getOwnPropertyDescriptor;var De=Object.getOwnPropertyNames;var Ae=Object.getPrototypeOf,Le=Object.prototype.hasOwnProperty;var Me=(o,e)=>{for(var r in e)z(o,r,{get:e[r],enumerable:!0})},ae=(o,e,r,t)=>{if(e&&typeof e=="object"||typeof e=="function")for(let i of De(e))!Le.call(o,i)&&i!==r&&z(o,i,{get:()=>e[i],enumerable:!(t=Be(e,i))||t.enumerable});return o};var B=(o,e,r)=>(r=o!=null?Ee(Ae(o)):{},ae(e||!o||!o.__esModule?z(r,"default",{value:o,enumerable:!0}):r,o)),Fe=o=>ae(z({},"__esModule",{value:!0}),o);var it={};Me(it,{activate:()=>rt,getProjectCwd:()=>U,projectCwd:()=>ne,setProjectCwd:()=>Pe});module.exports=Fe(it);var c=B(require("vscode"));var J=B(require("vscode")),$=null,O=null;function D(){return O}function V(){return(typeof window<"u"?window:typeof self<"u"?self:globalThis).crossOriginIsolated===!0}async function j(o,e="project"){return O||($||($=(async()=>{if(!V())throw new Error("This page is not cross-origin isolated. The dev environment needs the hosting server to send Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: credentialless headers.");let t=(J.extensions.getExtension("amplytic.webide-dev")??J.extensions.getExtension("webide-dev"))?.extensionUri?.toString(),i=typeof document<"u"?document.baseURI:t?t.replace(/\/+$/,"")+"/":void 0;if(!i)throw new Error("Cannot resolve the app origin for the nodine runtime URL from this worker context.");let n=new URL(o,i).href,s=await(await import(new URL("./sdk.mjs",n).href)).Container.boot({runtimeUrl:n,coep:"credentialless",workdirName:e});return O=s,s.__bootTag="boot-"+Math.random().toString(36).slice(2,8),console.error("[webide-dev] bootContainer created",s.__bootTag),s})().catch(r=>{throw $=null,r})),$)}var p=B(require("vscode")),se="nodine",ce="nodine://nodine/Nodine/",Y="/Nodine";function N(){return p.Uri.parse(ce)}var H=class{constructor(e){this.getContainer=e}getContainer;watchCalls=0;async ready(){let e=await this.getContainer();if(!e)throw p.FileSystemError.Unavailable("Dev environment is still booting (nodine runtime)");return e}toContainerPath(e){let r=e.path;return r===Y?"/":r.startsWith(`${Y}/`)?r.slice(Y.length):r.startsWith("/")?r:`/${r}`}toWorkspaceUri(e){let r=e.replace(/^\/+/,"");return p.Uri.parse(`${ce}${r}`)}stat(e){return this._stat(this.toContainerPath(e))}async _stat(e){let r=await this.ready();try{return await r.fs.readdir(e),{type:p.FileType.Directory,ctime:0,mtime:Date.now(),size:0}}catch{try{let t=await r.fs.readFile(e);return{type:p.FileType.File,ctime:0,mtime:Date.now(),size:t.length}}catch{throw p.FileSystemError.FileNotFound(e)}}}readDirectory(e){return(async()=>{let r=await this.ready(),t=this.toContainerPath(e),i;try{i=await r.fs.readdir(t,{withFileTypes:!0})}catch{throw p.FileSystemError.FileNotFound(e)}let n=[],a=[];for(let l of i){let s=typeof l=="string"?l:l.name??String(l),h=typeof l=="object"&&l!==null?typeof l.isDirectory=="function"?l.isDirectory()?"directory":"file":l._kind??(l.type===2?"directory":l.type===1?"file":void 0):void 0;h==="directory"?n.push([s,p.FileType.Directory]):h==="file"?n.push([s,p.FileType.File]):a.push(s)}for(let l of a)try{await r.fs.readdir(`${t}/${l}`),n.push([l,p.FileType.Directory])}catch{n.push([l,p.FileType.File])}return n})()}readFile(e){return(async()=>(await this.ready()).fs.readFile(this.toContainerPath(e)).catch(()=>{throw p.FileSystemError.FileNotFound(e)}))()}writeFile(e,r,t){return(async()=>{let i=await this.ready(),n=this.toContainerPath(e);if(!t.overwrite)try{if(await i.fs.readFile(n),!t.overwrite)throw p.FileSystemError.FileExists(e)}catch(a){if(a instanceof p.FileSystemError&&a.code==="FileExists")throw a}await i.fs.writeFile(n,r),this._fireDidChange(e)})()}createDirectory(e){return(async()=>{await(await this.ready()).fs.mkdir(this.toContainerPath(e),{recursive:!0}),this._fireFileCreated(e)})()}fireExternalChange(e,r){this._onDidChangeFile.fire([{type:e,uri:this.toWorkspaceUri(r)}])}async exists(e){let r=await this.ready();try{return await r.fs.readdir(e),!0}catch{try{return await r.fs.readFile(e),!0}catch{return!1}}}delete(e,r){return(async()=>{let t=await this.ready(),i=this.toContainerPath(e);if(!await this.exists(i))throw p.FileSystemError.FileNotFound(e);await t.fs.rm(i,{recursive:r.recursive,force:!0}),this._fireFileDeleted(e)})()}rename(e,r,t){return(async()=>{let i=await this.ready(),n=this.toContainerPath(e),a=this.toContainerPath(r);if(!t.overwrite&&await this.exists(a))throw p.FileSystemError.FileExists(r);await i.fs.rename(n,a),this._fireFileDeleted(e),this._fireFileCreated(r)})()}watch(e){this.watchCalls++;let r=this.toContainerPath(e),t;return this.ready().then(i=>{try{t=i.fs.watch(r,(n,a)=>{let l=(a??"").startsWith("/")?a:`${r}/${a??""}`,s=l.replace(/\/+$/,"").split("/");s.pop();let h=s.join("/")||"/";this._fireDidChange(this.toWorkspaceUri(h)),this._fireDidChange(this.toWorkspaceUri(l))})}catch{}}).catch(()=>{}),new p.Disposable(()=>t?.close())}_onDidChangeFile=new p.EventEmitter;onDidChangeFile=this._onDidChangeFile.event;_fireDidChange(e){this._onDidChangeFile.fire([{type:p.FileChangeType.Changed,uri:e}])}_fireFileCreated(e){this._onDidChangeFile.fire([{type:p.FileChangeType.Created,uri:e}])}_fireFileDeleted(e){this._onDidChangeFile.fire([{type:p.FileChangeType.Deleted,uri:e}])}get scheme(){return se}};async function le(o){let e=N(),r=p.workspace.workspaceFolders;if(r?.some(n=>n.uri.scheme===se))return;p.workspace.updateWorkspaceFolders(0,r?.length??0,{uri:e,name:"Nodine"})||console.error("[webide-dev] updateWorkspaceFolders returned false (workspace change rejected)")}var C=B(require("vscode"));var ue=null,fe=0;function he(o){ue=o}function pe(){return fe}var q=class{constructor(e){this.runtimeUrl=e}runtimeUrl;writeEmitter=new C.EventEmitter;onDidWrite=this.writeEmitter.event;closeEmitter=new C.EventEmitter;onDidClose=this.closeEmitter.event;container=null;current=null;inputWriter=null;inheritSpawn=!1;outSub=null;outDecoder=null;acceptUntil=0;buffer="";running=!1;cwd=null;atLineStart=!0;stdinHintShown=!1;cd(e){e?this.cwd=e.replace(/\/+$/,"")||"/":this.cwd="/",this.container&&this.prompt()}resolveCwd(e){return this.cwd??"/"}outBuf="";outTimer=null;write(e){this.outBuf+=e.replace(/\r\n/g,`
`).replace(/\n/g,`\r
`),this.outTimer===null&&(this.outTimer=setTimeout(()=>this.flushOut(),12))}flushOut(){if(this.outTimer!==null&&(clearTimeout(this.outTimer),this.outTimer=null),!this.outBuf)return;let e=this.outBuf;this.outBuf="",this.atLineStart=e.endsWith(`\r
`)||e.endsWith(`
`),this.writeEmitter.fire(e)}clearScreen(){this.flushOut(),this.writeEmitter.fire("\x1B[2J\x1B[3J\x1B[H"),this.atLineStart=!0}async open(e){this.clearScreen(),this.write(`\x1B[90mstarting dev environment\u2026\x1B[0m\r
`);try{this.container=await j(this.runtimeUrl),console.error("[webide-dev] terminal using container",this.container.__bootTag)}catch(t){console.error("[webide-dev] runtime boot failed:",t),this.write(`\x1B[31mfailed to start the dev environment (the host must send cross-origin isolation headers).\x1B[0m\r
`),this.closeEmitter.fire(1);return}this.outDecoder=new TextDecoder,this.outSub=this.container.onOutput(t=>{if(!this.running&&Date.now()>this.acceptUntil)return;let i=typeof t=="string"?t:this.outDecoder.decode(t,{stream:!0});this.write(i)});let r=await this.nodeVersion();this.clearScreen(),r&&this.write(`Node.js ${r}\r
\r
`),this.prompt()}nodeVersionCache=null;async nodeVersion(){if(this.nodeVersionCache!==null)return this.nodeVersionCache;try{let e=await this.container.spawn("node",["-p","process.version"]),r="",t=(async()=>{if(!e.output)return;let n=e.output.getReader();for(;;){let{done:a,value:l}=await n.read();if(a)break;r+=l}})(),i=await Promise.race([e.exit,new Promise(n=>setTimeout(()=>n(null),2e4))]);if(await Promise.race([t,new Promise(n=>setTimeout(n,2e3))]),i===null){try{await e.kill()}catch{}this.nodeVersionCache=null}else this.nodeVersionCache=r.trim().replace(/^['"]|['"]$/g,"")||null}catch{this.nodeVersionCache=null}return this.nodeVersionCache}displayCwd(){let e=this.cwd??"/";return e==="/"?"Nodine/":`Nodine${e}`}prompt(){this.flushOut(),this.atLineStart||(this.writeEmitter.fire(`\r
`),this.atLineStart=!0),this.writeEmitter.fire(`\x1B[36m${this.displayCwd()}\x1B[0m \u276F `)}changeDir(e){if(!this.container)return;let r=this.resolveCwd(this.container),t;!e||e==="~"?t=this.container.workdir:e==="/"||e==="-"?t="/":e.startsWith("/")?t=e:t=`${r}/${e}`;let i=[];for(let n of t.split("/"))if(!(!n||n===".")){if(n===".."){i.pop();continue}i.push(n)}this.cwd="/"+i.join("/")}supStdin(){let e=this.container.__sup;return e?.sendStdin&&e.foreground&&!e.foreground.exited?r=>{try{e.sendStdin(r)}catch{}}:null}handleInput(e){if(this.container){if(this.running){if(e.includes("")){let r=this.supStdin();if(r)r(new Uint8Array([3]));else{this.inputWriter&&this.inputWriter.write("");try{this.current?.kill()}catch{}}this.write(`^C\r
`),this.atLineStart=!0;return}for(let r of e){let t=this.inheritSpawn?this.supStdin():null,i=new TextEncoder().encode(r);t?t(i):this.inputWriter&&(r==="\r"&&this.writeEmitter.fire(`\r
`),this.inputWriter.write(r))}return}for(let r of e)if(r==="\r"){let t=this.buffer;this.buffer="",this.write(`\r
`),this.runLine(t);return}else r==="\x7F"?this.buffer.length>0&&(this.buffer=this.buffer.slice(0,-1),this.writeEmitter.fire("\b \b")):r===""?(this.buffer="",this.write(`^C\r
`),this.prompt()):r>=" "&&(this.buffer+=r,this.writeEmitter.fire(r))}}async runLine(e){let r=this.container;if(!r)return;let t=Re(e);if(t.every(i=>de(i).length===0)){this.prompt();return}this.running=!0;try{for(let i of t)if(await this.runSegment(i,r)!==0)break}finally{this.finishCommand()}}async runSegment(e,r){let t=de(e);if(t.length===0)return 0;let i=null;for(let n=1;n<t.length;n++)if(t[n]===">"||t[n]===">>"){let a=t[n+1];if(!a)return this.write(`\x1B[31msyntax error: expected file after redirect\x1B[0m\r
`),2;i={path:a,append:t[n]===">>"},t.length=n;break}if(t[0]==="clear")return this.clearScreen(),0;if(t[0]==="cd")return this.changeDir(t[1]),0;if(t[0]==="pwd"){let n=`${this.resolveCwd(r)}\r
`;return i?await this.writeContainerFile(r,i,n.replace(`\r
`,`
`)):this.write(n),0}if(t[0]==="echo"){let n=`${t.slice(1).join(" ")}\r
`;return i?await this.writeContainerFile(r,i,t.slice(1).join(" ")+`
`):this.write(n),0}if(t[0]==="exit")return this.closeEmitter.fire(0),0;if(t[0]===">"){let n=e.replace(/^\s*>\s*/,"");if(!n)return 0;let a=await r.spawn("node",["-e",Ne(n)],{cwd:this.resolveCwd(r),env:{...r.baseEnv}});return this.current=a,this.inheritSpawn=!1,await this.pump(a,r)}try{let n,a={cwd:this.resolveCwd(r),env:{...r.baseEnv,...t[0]==="npm"||t[0]==="npx"?{npm_config_progress:"false"}:{}},stdio:i?"pipe":"inherit"};if(t[0]==="node"){if(t.length===1)return this.write(`\x1B[90musage: node <file.js> \xB7 node -v \xB7 node -e "<code>"\x1B[0m\r
`),0;n=await r.spawn("node",t.slice(1),a)}else n=await r.spawn(t[0],t.slice(1),a);return this.current=n,this.inheritSpawn=!i,this.inputWriter=n.input?n.input.getWriter():null,await this.pump(n,r,i)}catch(n){let a=String(n).split(`
`)[0].replace(/^FileSystemError:\s*/,"");return this.write(`\x1B[31m${a}\x1B[0m\r
`),1}}async writeContainerFile(e,r,t){let i=this.resolveCwd(e),n=r.path.startsWith("/")?r.path:`${i}/${r.path}`,a=t;if(r.append)try{a=new TextDecoder().decode(await e.fs.readFile(n))+t}catch{}else{let l=n.slice(0,n.lastIndexOf("/"))||"/";try{await e.fs.mkdir(l,{recursive:!0})}catch{}}await e.fs.writeFile(n,a)}async pump(e,r,t){let i="";if(e.output){let a=e.output.getReader();try{for(;;){let{done:l,value:s}=await a.read();if(l)break;t?i+=s:this.write(s)}}catch{}}let n=await e.exit;if(t){try{await this.writeContainerFile(r,t,i)}catch(a){return this.write(`\x1B[31mwrite failed: ${String(a).split(`
`)[0]}\x1B[0m\r
`),1}return n===0?0:n}return n!==0&&this.write(`\x1B[90m(exit ${n})\x1B[0m\r
`),n}finishCommand(){if(this.running=!1,this.current=null,this.stdinHintShown=!1,this.inheritSpawn=!1,this.acceptUntil=Date.now()+600,this.flushOut(),this.inputWriter){try{this.inputWriter.close()}catch{}this.inputWriter=null}try{fe++,ue?.()}catch{}setTimeout(()=>{this.flushOut(),this.container&&this.prompt()},160)}setDimensions(e){}async close(){if(this.outSub){try{this.outSub()}catch{}this.outSub=null}if(this.inputWriter){try{await this.inputWriter.close()}catch{}this.inputWriter=null}if(this.current)try{await this.current.kill()}catch{}}};function Ne(o){return`(function(){const __r=eval(${JSON.stringify(o)});if(__r!==undefined)console.log(__r)})()`}function Re(o){let e=[],r="",t=null;for(let i=0;i<o.length;i++){let n=o[i];t?(r+=n,n===t&&(t=null)):n==='"'||n==="'"?(t=n,r+=n):n==="&"&&o[i+1]==="&"?(e.push(r),r="",i++):r+=n}return e.push(r),e.map(i=>i.trim())}function de(o){let e=[],r="",t=null,i=!1;for(let n=0;n<o.length;n++){let a=o[n];t?a===t?t=null:r+=a:a==='"'||a==="'"?(t=a,i=!0):a==="\\"&&n+1<o.length?(r+=o[++n],i=!0):/\s/.test(a)?(r||i)&&(e.push(r),r="",i=!1):(r+=a,i=!0)}return(r||i)&&e.push(r),e}function W(o){let r=C.workspace.getConfiguration("webide-dev").get("runtimeUrl","/nodine/supervisor.mjs"),t=new q(r),i=C.window.createTerminal({name:"node (nodine)",pty:t,iconPath:new C.ThemeIcon("terminal")});return o.subscriptions.push(i),i.show(),i}var R=null,Z=null;function ee(o){if(R&&R.exitStatus===void 0)return Z&&Z.cd(U()??""),R.show(),R;let r=C.workspace.getConfiguration("webide-dev").get("runtimeUrl","/nodine/supervisor.mjs"),t=new q(r);t.cd(U()??"");let i=C.window.createTerminal({name:"node (nodine)",pty:t,iconPath:new C.ThemeIcon("terminal")});return R=i,Z=t,o.subscriptions.push(i),i.show(),i}var Q=class{runtimeUrl;constructor(e){this.runtimeUrl=e}provideTerminalProfile(e){let r=new q(this.runtimeUrl);return r.cd(U()??""),{name:"node (nodine)",options:{pty:r}}}};var _=B(require("vscode")),qe=new Set(["node_modules",".git",".github",".vscode","dist","build",".next",".turbo",".cache","coverage",".idea","out",".parcel-cache","target"]),Ue=new Set([".log",".map"]),Ie=new Set(["package-lock.json","yarn.lock","pnpm-lock.yaml"]),G=1e3,ze=512;function $e(o){o=o.trim().replace(/\.git$/,"");let e,r=o.match(/#([\w./-]+)$/);r&&(e=r[1],o=o.slice(0,r.index));let t=o.match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/tree\/([\w./-]+))?/i);return t?{owner:t[1],repo:t[2],ref:t[3]||e}:(t=o.match(/^([\w.-]+)\/([\w.-]+)$/),t?{owner:t[1],repo:t[2],ref:e}:null)}function Oe(o){let e=o.split("/").pop()||"";if(Ie.has(e))return!0;if(o.split("/").some(t=>qe.has(t)))return!1;let r=o.lastIndexOf(".");return!(r>=0&&Ue.has(o.slice(r)))}async function te(o,e){let r={Accept:"application/vnd.github+json"};e&&(r.Authorization=`Bearer ${e}`);let t=await fetch(`https://api.github.com${o}`,{headers:r});if(t.status===404)throw new Error("repo, ref or path not found (404) \u2014 check the URL"+(e?"":" and whether the repo is private (a token is needed for that)"));if(t.status===401)throw new Error("GitHub rejected the token (401).");if(t.status===403){let i=await t.json().catch(()=>({}));throw i?.message?.includes("rate limit")?new Error("GitHub rate limit exceeded. Provide a PAT (raises it to 5000/hr)."):new Error(String(i?.message||"HTTP 403 (forbidden \u2014 private repo? a token is needed)"))}if(!t.ok)throw new Error(`GitHub returned HTTP ${t.status}`);return t.json()}var me;async function ge(o,e,r,t){let{repoInput:i,tokenInput:n}=o,a=$e(i);if(!a){_.window.showErrorMessage(`Not a GitHub repository: ${i}`);return}let{owner:l,repo:s,ref:h}=a,f=n.trim()||me,m=_.workspace.getConfiguration("webide-dev").get("githubMaxFileKb",ze);await _.window.withProgress({location:_.ProgressLocation.Notification,title:`Importing ${l}/${s}${h?`#${h}`:""}`,cancellable:!1},async T=>{try{T.report({message:"resolving ref\u2026"});let y;h&&/^[0-9a-f]{40}$/i.test(h)?y=h:y=(await te(`/repos/${l}/${s}/commits/${encodeURIComponent(h??"HEAD")}`,f)).sha,n.trim()&&(me=n.trim()),T.report({message:"listing files\u2026"});let I=await te(`/repos/${l}/${s}/git/trees/${y}?recursive=1`,f);I.truncated&&_.window.showWarningMessage("Repo tree truncated by GitHub (very large repo) \u2014 importing a subset.");let A=I.tree.filter(k=>k.type==="blob"&&Oe(k.path)&&(k.size??0)<=m*1024);A.length>G&&_.window.showWarningMessage(`Repo has ${A.length} importable files \u2014 importing the first ${G} (large-repo cap).`);let X=A.slice(0,G),L=new Set,d=0,u=0,g=0,S=Array.from({length:6},async()=>{for(;;){let k=X.shift();if(!k)return;try{let E=await te(`/repos/${l}/${s}/git/blobs/${k.sha}`,f),Te=E.encoding==="base64"?je(E.content):new TextEncoder().encode(E.content),oe=k.path.split("/").slice(0,-1).join("/"),K=oe?`${l}-${s}/${oe}`:`${l}-${s}`;L.has(K)||(await r(K),L.add(K)),await e(`${l}-${s}/${k.path}`,Te),d++}catch(E){u++,console.warn(`[webide-dev] blob fetch failed for ${k.path}:`,E)}g++;let M=Math.min(A.length,G);if(g%(M<50?1:10)===0||g===M){let E=M>0?Math.round(g/M*100):100;T.report({message:`${g}/${M} files \xB7 ${E}%`,increment:100/M})}}});await Promise.all(S),await t(`${l}-${s}`),_.window.showInformationMessage(`Imported ${d} files from ${l}/${s}`+(u?` \u2014 ${u} failed`:"")+". node_modules and build artifacts were skipped.")}catch(y){_.window.showErrorMessage(`GitHub import failed: ${y instanceof Error?y.message:String(y)}`)}})}function je(o){let e=atob(o.replace(/\n/g,"")),r=new Uint8Array(e.length);for(let t=0;t<e.length;t++)r[t]=e.charCodeAt(t);return r}var v=B(require("vscode")),ve=new Set(["node_modules",".git",".github",".vscode","dist","build",".next",".cache","coverage",".idea",".turbo","out"]),we=512;async function be(o,e){let r;try{r=await v.workspace.fs.readDirectory(o)}catch{return 0}let t=0;for(let[i,n]of r)if(n===v.FileType.Directory){if(ve.has(i))continue;t+=await be(v.Uri.joinPath(o,i),e)}else if(n===v.FileType.File){if(i.endsWith(".map")||i===".DS_Store")continue;t++}return t}async function ye(o,e,r,t,i,n){let a;try{a=await v.workspace.fs.readDirectory(o)}catch{return 0}await t(e);let l=0;for(let[s,h]of a)if(h===v.FileType.Directory){if(ve.has(s))continue;l+=await ye(v.Uri.joinPath(o,s),`${e}/${s}`,r,t,i,n)}else if(h===v.FileType.File){if(s.endsWith(".map")||s===".DS_Store")continue;try{if((await v.workspace.fs.stat(v.Uri.joinPath(o,s))).size>we*1024){n.skipped++;continue}let m=await v.workspace.fs.readFile(v.Uri.joinPath(o,s));await r(`${e}/${s}`,m),l++,n.copied++,n.copied%(n.copied<50?1:10)===0&&i(0,`${n.copied} files copied${n.skipped?` \xB7 ${n.skipped} skipped`:""}`)}catch(f){n.skipped++,console.warn(`[webide-dev] upload: failed to read ${s}:`,f)}}return l}async function Ce(o,e,r,t){let i=await v.window.showOpenDialog({canSelectFiles:!1,canSelectFolders:!0,canSelectMany:!1,openLabel:"Upload Folder",title:"Choose a local folder to upload into the dev environment"});if(console.log("[webide-dev] upload: picker returned",i?.map(l=>l.toString())),!i||i.length===0)return;let n=i[0],a=n.path.split("/").filter(Boolean).pop()||"uploaded-folder";await v.window.withProgress({location:v.ProgressLocation.Notification,title:`Uploading ${a}`,cancellable:!1},async l=>{try{l.report({message:"booting dev environment\u2026"}),await t(),l.report({message:"scanning files\u2026"});let s={copied:0,skipped:0},h=await be(n,s);if(h===0){v.window.showWarningMessage(`No uploadable files found in ${a} (node_modules and build artifacts are skipped).`);return}l.report({message:`copying ${h} files\u2026`,increment:0});let f=await ye(n,a,o,e,(T,y)=>l.report({message:y}),s);if(f===0){v.window.showWarningMessage(`No files uploaded from ${a} (empty, or all filtered by ignore rules).`);return}l.report({message:"preparing workspace\u2026",increment:100}),await r(a);let m=s.skipped?` (${s.skipped} skipped \u2014 ignored dirs or >${we} KB)`:"";v.window.showInformationMessage(`Uploaded ${f} of ${h} files from ${a}${m} \u2014 dev terminal is booting at /${a}.`)}catch(s){v.window.showErrorMessage(`Folder upload failed: ${s instanceof Error?s.message:String(s)}`)}})}var w=B(require("vscode"));var He=`
	:root { color-scheme: light dark; }
	body {
		margin: 0; padding: clamp(12px, 4vw, 28px);
		font-family: var(--vscode-font-family, system-ui, sans-serif);
		font-size: var(--vscode-font-size, 13px);
		color: var(--vscode-foreground, #ccc);
		background: var(--vscode-editor-background, transparent);
		line-height: 1.5;
	}
	h2 { font-size: 1.05em; margin: 0 0 4px; font-weight: 600; }
	.sub { opacity: .75; margin: 0 0 14px; }
	.card {
		border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3));
		border-radius: 6px; padding: 14px 16px; margin: 0 0 14px;
	}
	.step { display: inline-block; min-width: 1.6em; text-align: center;
		background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff);
		border-radius: 50%; margin-right: 8px; font-size: .85em; }
	#qrbox { display: flex; justify-content: center; padding: 10px 0; }
	#qrbox img { max-width: min(420px, 88vw); height: auto; image-rendering: pixelated; }
	.code {
		width: 100%; box-sizing: border-box; word-break: break-all;
		font-family: monospace; font-size: 11px; opacity: .8; margin-top: 8px;
	}
	button {
		font-family: inherit; font-size: 12px; cursor: pointer;
		background: var(--vscode-button-secondaryBackground, #3a3d41);
		color: var(--vscode-button-secondaryForeground, #fff);
		border: none; border-radius: 2px; padding: 5px 12px; margin: 6px 4px 0 0;
	}
	button.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
	button:disabled { opacity: .45; cursor: default; }
	textarea {
		width: 100%; box-sizing: border-box; min-height: 74px; resize: vertical;
		font-family: monospace; font-size: 11px;
		background: var(--vscode-input-background, #3c3c3c);
		color: var(--vscode-input-foreground, #ccc);
		border: 1px solid var(--vscode-input-border, rgba(128,128,128,.4));
		border-radius: 2px; padding: 6px;
	}
	#status { margin: 2px 0 0; font-weight: 600; }
	#status.ok { color: var(--vscode-testing-iconPassed, #73c991); }
	#status.err { color: var(--vscode-testing-iconFailed, #f14c4c); }
	.muted { opacity: .65; font-size: 12px; }
	.hidden { display: none; }
`,Qe=["(function () {","'use strict';","var vscode = acquireVsCodeApi ? acquireVsCodeApi() : null;","var dc = null; var pc = null; var sharedPort = 0;","var chunks = Object.create(null); // sid -> {parts:[], n}","function $(id) { return document.getElementById(id); }",'function setStatus(msg, cls) { var el = $("status"); el.textContent = msg; el.className = cls || ""; }','function b64uFromBytes(bytes) { var s = ""; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, ""); }','function bytesFromB64u(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; var bin = atob(s); var out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }','async function deflateCode(str) { var bytes = new TextEncoder().encode(str); var cs = new CompressionStream("deflate"); var stream = new Blob([bytes]).stream().pipeThrough(cs); var buf = await new Response(stream).arrayBuffer(); return b64uFromBytes(new Uint8Array(buf)); }','async function inflateCode(code) { var bytes = bytesFromB64u(code); var ds = new DecompressionStream("deflate"); var stream = new Blob([bytes]).stream().pipeThrough(ds); var buf = await new Response(stream).arrayBuffer(); return new TextDecoder().decode(buf); }','function iceComplete(pc) { return new Promise(function (resolve) { if (pc.iceGatheringState === "complete") return resolve(); var t = setTimeout(resolve, 2500); pc.addEventListener("icegatheringstatechange", function () { if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(); } }); }); }','function dcSend(obj) { var s = JSON.stringify(obj); var MAX = 64000; if (s.length <= MAX) { dc.send(s); return; } var sid = "s" + Math.random().toString(36).slice(2); var n = Math.ceil(s.length / MAX); for (var i = 0; i < n; i++) dc.send(JSON.stringify({ t: "chunk", sid: sid, i: i, n: n, d: s.slice(i * MAX, (i + 1) * MAX) })); }','function dcFeed(frame) { if (frame.t === "chunk") { var c = chunks[frame.sid] || (chunks[frame.sid] = { parts: [], n: frame.n }); c.parts[frame.i] = frame.d; if (c.parts.filter(function (p) { return p !== undefined; }).length === c.n) { var full = c.parts.join(""); delete chunks[frame.sid]; return JSON.parse(full); } return null; } return frame; }','function renderQr(text) { try { var qr = qrcode(0, "L"); qr.addData(text, "Byte"); qr.make(); $("qrbox").innerHTML = qr.createImgTag(4, 8); $("offerUrl").textContent = text; } catch (e) { $("qrbox").innerHTML = ""; $("offerUrl").textContent = "(URL too long for a QR code - use the copy button below)"; } }',"async function makeOffer() {","  try {","    pc = new RTCPeerConnection({ iceServers: [] });",'    dc = pc.createDataChannel("http", { ordered: true });',"    wireChannel();","    var offer = await pc.createOffer();","    await pc.setLocalDescription(offer);","    await iceComplete(pc);","    var sdp = pc.localDescription.sdp;","    var code = await deflateCode(sdp);",'    var url = $("guestBase").value + "#o=" + code;',"    renderQr(url);",'    setStatus("Offer ready - scan the QR with your phone (same Wi-Fi), or copy the URL.", "");','  } catch (e) { setStatus("Offer failed: " + e.message, "err"); }',"}","async function acceptAnswer() {","  try {",'    var raw = $("answerBox").value.trim();',"    if (!raw) return;","    var sdp = await inflateCode(raw);",'    await pc.setRemoteDescription({ type: "answer", sdp: sdp });','    setStatus("Answer accepted - connecting...", "");','  } catch (e) { setStatus("Bad answer code: " + e.message, "err"); }',"}","function wireChannel() {","  dc.onopen = function () {",'    setStatus("CONNECTED - your phone can now load the app.", "ok");','    $("answerBox").disabled = true; $("connectBtn").disabled = true;','    if (vscode) vscode.postMessage({ t: "ready" });',"  };",'  dc.onclose = function () { setStatus("Guest disconnected.", ""); };',"  dc.onmessage = function (ev) {","    var msg; try { msg = dcFeed(JSON.parse(ev.data)); } catch (e) { return; }","    if (!msg) return;",'    if (msg.t === "req") {','      console.error("[share-panel] guest req", msg.id, msg.method, msg.path);','      var head = msg.method + " " + msg.path + " HTTP/1.1\\r\\nHost: nodine.lan\\r\\n";',"      var hs = msg.headers || {};",'      for (var k in hs) { if (/^(host|connection|content-length)$/i.test(k)) continue; head += k + ": " + hs[k] + "\\r\\n"; }','      head += "Connection: close\\r\\n\\r\\n";','      if (vscode) vscode.postMessage({ t: "req", id: msg.id, head: head, bodyB64: msg.bodyB64 || null });',"    }","  };","}",'window.addEventListener("message", function (ev) {',"  var m = ev.data || {};",'  if (m.t === "init") {',"    sharedPort = m.port;",'    $("guestBase").value = m.guestBase;','    $("portLabel").textContent = ":" + m.port;',"    makeOffer();",'  } else if (m.t === "res") {','      console.error("[share-panel] host res", m.id, "len", (m.b64 || "").length, "err", m.err);','    dcSend({ t: "res", id: m.id, b64: m.b64, err: m.err || null });',"  }","});",'$("copyUrlBtn").addEventListener("click", function () { navigator.clipboard.writeText($("offerUrl").textContent); setStatus("URL copied.", "ok"); });','$("connectBtn").addEventListener("click", acceptAnswer);','$("answerBox").addEventListener("keydown", function (e) { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) acceptAnswer(); });',"}());"].join(`
`);function _e(o,e){return`<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${o}'; style-src 'unsafe-inline'; img-src data:;">
	<title>Share on LAN</title>
	<style>${He}</style>
</head>
<body>
	<h2>Share dev server <span id="portLabel"></span> on your local network</h2>
	<p class="sub">Zero infrastructure: the phone connects straight to this browser tab over WebRTC. Works on the same Wi-Fi only; nothing leaves your machine.</p>

	<div class="card">
		<span class="step">1</span><strong>Scan with your phone</strong>
		<p class="muted">Scan this QR with the phone's camera (same Wi-Fi as this computer). It opens the preview page with the connection offer embedded.</p>
		<div id="qrbox"><p class="muted">creating offer&hellip;</p></div>
		<div class="code" id="offerUrl"></div>
		<button id="copyUrlBtn">Copy URL</button>
	</div>

	<div class="card">
		<span class="step">2</span><strong>Paste the answer code from the phone</strong>
		<p class="muted">The phone shows an answer code after it loads. Paste it here and connect.</p>
		<textarea id="answerBox" placeholder="paste the answer code (deflate+base64url)..." spellcheck="false"></textarea>
		<button id="connectBtn" class="primary">Connect</button>
	</div>

	<p id="status" class="muted">Starting&hellip;</p>
	<input type="hidden" id="guestBase" value="">
	<script nonce="${o}">${e}<\/script>
	<script nonce="${o}">${Qe}<\/script>
</body>
</html>`}var xe=`//---------------------------------------------------------------------
//
// QR Code Generator for JavaScript
//
// Copyright (c) 2009 Kazuhiko Arase
//
// URL: http://www.d-project.com/
//
// Licensed under the MIT license:
//  http://www.opensource.org/licenses/mit-license.php
//
// The word 'QR Code' is registered trademark of
// DENSO WAVE INCORPORATED
//  http://www.denso-wave.com/qrcode/faqpatent-e.html
//
//---------------------------------------------------------------------

var qrcode = function() {

  //---------------------------------------------------------------------
  // qrcode
  //---------------------------------------------------------------------

  /**
   * qrcode
   * @param typeNumber 1 to 40
   * @param errorCorrectionLevel 'L','M','Q','H'
   */
  var qrcode = function(typeNumber, errorCorrectionLevel) {

    var PAD0 = 0xEC;
    var PAD1 = 0x11;

    var _typeNumber = typeNumber;
    var _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
    var _modules = null;
    var _moduleCount = 0;
    var _dataCache = null;
    var _dataList = [];

    var _this = {};

    var makeImpl = function(test, maskPattern) {

      _moduleCount = _typeNumber * 4 + 17;
      _modules = function(moduleCount) {
        var modules = new Array(moduleCount);
        for (var row = 0; row < moduleCount; row += 1) {
          modules[row] = new Array(moduleCount);
          for (var col = 0; col < moduleCount; col += 1) {
            modules[row][col] = null;
          }
        }
        return modules;
      }(_moduleCount);

      setupPositionProbePattern(0, 0);
      setupPositionProbePattern(_moduleCount - 7, 0);
      setupPositionProbePattern(0, _moduleCount - 7);
      setupPositionAdjustPattern();
      setupTimingPattern();
      setupTypeInfo(test, maskPattern);

      if (_typeNumber >= 7) {
        setupTypeNumber(test);
      }

      if (_dataCache == null) {
        _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
      }

      mapData(_dataCache, maskPattern);
    };

    var setupPositionProbePattern = function(row, col) {

      for (var r = -1; r <= 7; r += 1) {

        if (row + r <= -1 || _moduleCount <= row + r) continue;

        for (var c = -1; c <= 7; c += 1) {

          if (col + c <= -1 || _moduleCount <= col + c) continue;

          if ( (0 <= r && r <= 6 && (c == 0 || c == 6) )
              || (0 <= c && c <= 6 && (r == 0 || r == 6) )
              || (2 <= r && r <= 4 && 2 <= c && c <= 4) ) {
            _modules[row + r][col + c] = true;
          } else {
            _modules[row + r][col + c] = false;
          }
        }
      }
    };

    var getBestMaskPattern = function() {

      var minLostPoint = 0;
      var pattern = 0;

      for (var i = 0; i < 8; i += 1) {

        makeImpl(true, i);

        var lostPoint = QRUtil.getLostPoint(_this);

        if (i == 0 || minLostPoint > lostPoint) {
          minLostPoint = lostPoint;
          pattern = i;
        }
      }

      return pattern;
    };

    var setupTimingPattern = function() {

      for (var r = 8; r < _moduleCount - 8; r += 1) {
        if (_modules[r][6] != null) {
          continue;
        }
        _modules[r][6] = (r % 2 == 0);
      }

      for (var c = 8; c < _moduleCount - 8; c += 1) {
        if (_modules[6][c] != null) {
          continue;
        }
        _modules[6][c] = (c % 2 == 0);
      }
    };

    var setupPositionAdjustPattern = function() {

      var pos = QRUtil.getPatternPosition(_typeNumber);

      for (var i = 0; i < pos.length; i += 1) {

        for (var j = 0; j < pos.length; j += 1) {

          var row = pos[i];
          var col = pos[j];

          if (_modules[row][col] != null) {
            continue;
          }

          for (var r = -2; r <= 2; r += 1) {

            for (var c = -2; c <= 2; c += 1) {

              if (r == -2 || r == 2 || c == -2 || c == 2
                  || (r == 0 && c == 0) ) {
                _modules[row + r][col + c] = true;
              } else {
                _modules[row + r][col + c] = false;
              }
            }
          }
        }
      }
    };

    var setupTypeNumber = function(test) {

      var bits = QRUtil.getBCHTypeNumber(_typeNumber);

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod;
      }

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
      }
    };

    var setupTypeInfo = function(test, maskPattern) {

      var data = (_errorCorrectionLevel << 3) | maskPattern;
      var bits = QRUtil.getBCHTypeInfo(data);

      // vertical
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 6) {
          _modules[i][8] = mod;
        } else if (i < 8) {
          _modules[i + 1][8] = mod;
        } else {
          _modules[_moduleCount - 15 + i][8] = mod;
        }
      }

      // horizontal
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 8) {
          _modules[8][_moduleCount - i - 1] = mod;
        } else if (i < 9) {
          _modules[8][15 - i - 1 + 1] = mod;
        } else {
          _modules[8][15 - i - 1] = mod;
        }
      }

      // fixed module
      _modules[_moduleCount - 8][8] = (!test);
    };

    var mapData = function(data, maskPattern) {

      var inc = -1;
      var row = _moduleCount - 1;
      var bitIndex = 7;
      var byteIndex = 0;
      var maskFunc = QRUtil.getMaskFunction(maskPattern);

      for (var col = _moduleCount - 1; col > 0; col -= 2) {

        if (col == 6) col -= 1;

        while (true) {

          for (var c = 0; c < 2; c += 1) {

            if (_modules[row][col - c] == null) {

              var dark = false;

              if (byteIndex < data.length) {
                dark = ( ( (data[byteIndex] >>> bitIndex) & 1) == 1);
              }

              var mask = maskFunc(row, col - c);

              if (mask) {
                dark = !dark;
              }

              _modules[row][col - c] = dark;
              bitIndex -= 1;

              if (bitIndex == -1) {
                byteIndex += 1;
                bitIndex = 7;
              }
            }
          }

          row += inc;

          if (row < 0 || _moduleCount <= row) {
            row -= inc;
            inc = -inc;
            break;
          }
        }
      }
    };

    var createBytes = function(buffer, rsBlocks) {

      var offset = 0;

      var maxDcCount = 0;
      var maxEcCount = 0;

      var dcdata = new Array(rsBlocks.length);
      var ecdata = new Array(rsBlocks.length);

      for (var r = 0; r < rsBlocks.length; r += 1) {

        var dcCount = rsBlocks[r].dataCount;
        var ecCount = rsBlocks[r].totalCount - dcCount;

        maxDcCount = Math.max(maxDcCount, dcCount);
        maxEcCount = Math.max(maxEcCount, ecCount);

        dcdata[r] = new Array(dcCount);

        for (var i = 0; i < dcdata[r].length; i += 1) {
          dcdata[r][i] = 0xff & buffer.getBuffer()[i + offset];
        }
        offset += dcCount;

        var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
        var rawPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1);

        var modPoly = rawPoly.mod(rsPoly);
        ecdata[r] = new Array(rsPoly.getLength() - 1);
        for (var i = 0; i < ecdata[r].length; i += 1) {
          var modIndex = i + modPoly.getLength() - ecdata[r].length;
          ecdata[r][i] = (modIndex >= 0)? modPoly.getAt(modIndex) : 0;
        }
      }

      var totalCodeCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalCodeCount += rsBlocks[i].totalCount;
      }

      var data = new Array(totalCodeCount);
      var index = 0;

      for (var i = 0; i < maxDcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < dcdata[r].length) {
            data[index] = dcdata[r][i];
            index += 1;
          }
        }
      }

      for (var i = 0; i < maxEcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < ecdata[r].length) {
            data[index] = ecdata[r][i];
            index += 1;
          }
        }
      }

      return data;
    };

    var createData = function(typeNumber, errorCorrectionLevel, dataList) {

      var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectionLevel);

      var buffer = qrBitBuffer();

      for (var i = 0; i < dataList.length; i += 1) {
        var data = dataList[i];
        buffer.put(data.getMode(), 4);
        buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
        data.write(buffer);
      }

      // calc num max data.
      var totalDataCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalDataCount += rsBlocks[i].dataCount;
      }

      if (buffer.getLengthInBits() > totalDataCount * 8) {
        throw 'code length overflow. ('
          + buffer.getLengthInBits()
          + '>'
          + totalDataCount * 8
          + ')';
      }

      // end code
      if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
        buffer.put(0, 4);
      }

      // padding
      while (buffer.getLengthInBits() % 8 != 0) {
        buffer.putBit(false);
      }

      // padding
      while (true) {

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD0, 8);

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD1, 8);
      }

      return createBytes(buffer, rsBlocks);
    };

    _this.addData = function(data, mode) {

      mode = mode || 'Byte';

      var newData = null;

      switch(mode) {
      case 'Numeric' :
        newData = qrNumber(data);
        break;
      case 'Alphanumeric' :
        newData = qrAlphaNum(data);
        break;
      case 'Byte' :
        newData = qr8BitByte(data);
        break;
      case 'Kanji' :
        newData = qrKanji(data);
        break;
      default :
        throw 'mode:' + mode;
      }

      _dataList.push(newData);
      _dataCache = null;
    };

    _this.isDark = function(row, col) {
      if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) {
        throw row + ',' + col;
      }
      return _modules[row][col];
    };

    _this.getModuleCount = function() {
      return _moduleCount;
    };

    _this.make = function() {
      if (_typeNumber < 1) {
        var typeNumber = 1;

        for (; typeNumber < 40; typeNumber++) {
          var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, _errorCorrectionLevel);
          var buffer = qrBitBuffer();

          for (var i = 0; i < _dataList.length; i++) {
            var data = _dataList[i];
            buffer.put(data.getMode(), 4);
            buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
            data.write(buffer);
          }

          var totalDataCount = 0;
          for (var i = 0; i < rsBlocks.length; i++) {
            totalDataCount += rsBlocks[i].dataCount;
          }

          if (buffer.getLengthInBits() <= totalDataCount * 8) {
            break;
          }
        }

        _typeNumber = typeNumber;
      }

      makeImpl(false, getBestMaskPattern() );
    };

    _this.createTableTag = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var qrHtml = '';

      qrHtml += '<table style="';
      qrHtml += ' border-width: 0px; border-style: none;';
      qrHtml += ' border-collapse: collapse;';
      qrHtml += ' padding: 0px; margin: ' + margin + 'px;';
      qrHtml += '">';
      qrHtml += '<tbody>';

      for (var r = 0; r < _this.getModuleCount(); r += 1) {

        qrHtml += '<tr>';

        for (var c = 0; c < _this.getModuleCount(); c += 1) {
          qrHtml += '<td style="';
          qrHtml += ' border-width: 0px; border-style: none;';
          qrHtml += ' border-collapse: collapse;';
          qrHtml += ' padding: 0px; margin: 0px;';
          qrHtml += ' width: ' + cellSize + 'px;';
          qrHtml += ' height: ' + cellSize + 'px;';
          qrHtml += ' background-color: ';
          qrHtml += _this.isDark(r, c)? '#000000' : '#ffffff';
          qrHtml += ';';
          qrHtml += '"/>';
        }

        qrHtml += '</tr>';
      }

      qrHtml += '</tbody>';
      qrHtml += '</table>';

      return qrHtml;
    };

    _this.createSvgTag = function(cellSize, margin, alt, title) {

      var opts = {};
      if (typeof arguments[0] == 'object') {
        // Called by options.
        opts = arguments[0];
        // overwrite cellSize and margin.
        cellSize = opts.cellSize;
        margin = opts.margin;
        alt = opts.alt;
        title = opts.title;
      }

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      // Compose alt property surrogate
      alt = (typeof alt === 'string') ? {text: alt} : alt || {};
      alt.text = alt.text || null;
      alt.id = (alt.text) ? alt.id || 'qrcode-description' : null;

      // Compose title property surrogate
      title = (typeof title === 'string') ? {text: title} : title || {};
      title.text = title.text || null;
      title.id = (title.text) ? title.id || 'qrcode-title' : null;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var c, mc, r, mr, qrSvg='', rect;

      rect = 'l' + cellSize + ',0 0,' + cellSize +
        ' -' + cellSize + ',0 0,-' + cellSize + 'z ';

      qrSvg += '<svg version="1.1" xmlns="http://www.w3.org/2000/svg"';
      qrSvg += !opts.scalable ? ' width="' + size + 'px" height="' + size + 'px"' : '';
      qrSvg += ' viewBox="0 0 ' + size + ' ' + size + '" ';
      qrSvg += ' preserveAspectRatio="xMinYMin meet"';
      qrSvg += (title.text || alt.text) ? ' role="img" aria-labelledby="' +
          escapeXml([title.id, alt.id].join(' ').trim() ) + '"' : '';
      qrSvg += '>';
      qrSvg += (title.text) ? '<title id="' + escapeXml(title.id) + '">' +
          escapeXml(title.text) + '</title>' : '';
      qrSvg += (alt.text) ? '<description id="' + escapeXml(alt.id) + '">' +
          escapeXml(alt.text) + '</description>' : '';
      qrSvg += '<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>';
      qrSvg += '<path d="';

      for (r = 0; r < _this.getModuleCount(); r += 1) {
        mr = r * cellSize + margin;
        for (c = 0; c < _this.getModuleCount(); c += 1) {
          if (_this.isDark(r, c) ) {
            mc = c*cellSize+margin;
            qrSvg += 'M' + mc + ',' + mr + rect;
          }
        }
      }

      qrSvg += '" stroke="transparent" fill="black"/>';
      qrSvg += '</svg>';

      return qrSvg;
    };

    _this.createDataURL = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      return createDataURL(size, size, function(x, y) {
        if (min <= x && x < max && min <= y && y < max) {
          var c = Math.floor( (x - min) / cellSize);
          var r = Math.floor( (y - min) / cellSize);
          return _this.isDark(r, c)? 0 : 1;
        } else {
          return 1;
        }
      } );
    };

    _this.createImgTag = function(cellSize, margin, alt) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;

      var img = '';
      img += '<img';
      img += '\\u0020src="';
      img += _this.createDataURL(cellSize, margin);
      img += '"';
      img += '\\u0020width="';
      img += size;
      img += '"';
      img += '\\u0020height="';
      img += size;
      img += '"';
      if (alt) {
        img += '\\u0020alt="';
        img += escapeXml(alt);
        img += '"';
      }
      img += '/>';

      return img;
    };

    var escapeXml = function(s) {
      var escaped = '';
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charAt(i);
        switch(c) {
        case '<': escaped += '&lt;'; break;
        case '>': escaped += '&gt;'; break;
        case '&': escaped += '&amp;'; break;
        case '"': escaped += '&quot;'; break;
        default : escaped += c; break;
        }
      }
      return escaped;
    };

    var _createHalfASCII = function(margin) {
      var cellSize = 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r1, r2, p;

      var blocks = {
        '\u2588\u2588': '\u2588',
        '\u2588 ': '\u2580',
        ' \u2588': '\u2584',
        '  ': ' '
      };

      var blocksLastLineNoMargin = {
        '\u2588\u2588': '\u2580',
        '\u2588 ': '\u2580',
        ' \u2588': ' ',
        '  ': ' '
      };

      var ascii = '';
      for (y = 0; y < size; y += 2) {
        r1 = Math.floor((y - min) / cellSize);
        r2 = Math.floor((y + 1 - min) / cellSize);
        for (x = 0; x < size; x += 1) {
          p = '\u2588';

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r1, Math.floor((x - min) / cellSize))) {
            p = ' ';
          }

          if (min <= x && x < max && min <= y+1 && y+1 < max && _this.isDark(r2, Math.floor((x - min) / cellSize))) {
            p += ' ';
          }
          else {
            p += '\u2588';
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          ascii += (margin < 1 && y+1 >= max) ? blocksLastLineNoMargin[p] : blocks[p];
        }

        ascii += '\\n';
      }

      if (size % 2 && margin > 0) {
        return ascii.substring(0, ascii.length - size - 1) + Array(size+1).join('\u2580');
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.createASCII = function(cellSize, margin) {
      cellSize = cellSize || 1;

      if (cellSize < 2) {
        return _createHalfASCII(margin);
      }

      cellSize -= 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r, p;

      var white = Array(cellSize+1).join('\u2588\u2588');
      var black = Array(cellSize+1).join('  ');

      var ascii = '';
      var line = '';
      for (y = 0; y < size; y += 1) {
        r = Math.floor( (y - min) / cellSize);
        line = '';
        for (x = 0; x < size; x += 1) {
          p = 1;

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r, Math.floor((x - min) / cellSize))) {
            p = 0;
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          line += p ? white : black;
        }

        for (r = 0; r < cellSize; r += 1) {
          ascii += line + '\\n';
        }
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.renderTo2dContext = function(context, cellSize) {
      cellSize = cellSize || 2;
      var length = _this.getModuleCount();
      for (var row = 0; row < length; row++) {
        for (var col = 0; col < length; col++) {
          context.fillStyle = _this.isDark(row, col) ? 'black' : 'white';
          context.fillRect(row * cellSize, col * cellSize, cellSize, cellSize);
        }
      }
    }

    return _this;
  };

  //---------------------------------------------------------------------
  // qrcode.stringToBytes
  //---------------------------------------------------------------------

  qrcode.stringToBytesFuncs = {
    'default' : function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        bytes.push(c & 0xff);
      }
      return bytes;
    }
  };

  qrcode.stringToBytes = qrcode.stringToBytesFuncs['default'];

  //---------------------------------------------------------------------
  // qrcode.createStringToBytes
  //---------------------------------------------------------------------

  /**
   * @param unicodeData base64 string of byte array.
   * [16bit Unicode],[16bit Bytes], ...
   * @param numChars
   */
  qrcode.createStringToBytes = function(unicodeData, numChars) {

    // create conversion map.

    var unicodeMap = function() {

      var bin = base64DecodeInputStream(unicodeData);
      var read = function() {
        var b = bin.read();
        if (b == -1) throw 'eof';
        return b;
      };

      var count = 0;
      var unicodeMap = {};
      while (true) {
        var b0 = bin.read();
        if (b0 == -1) break;
        var b1 = read();
        var b2 = read();
        var b3 = read();
        var k = String.fromCharCode( (b0 << 8) | b1);
        var v = (b2 << 8) | b3;
        unicodeMap[k] = v;
        count += 1;
      }
      if (count != numChars) {
        throw count + ' != ' + numChars;
      }

      return unicodeMap;
    }();

    var unknownChar = '?'.charCodeAt(0);

    return function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        if (c < 128) {
          bytes.push(c);
        } else {
          var b = unicodeMap[s.charAt(i)];
          if (typeof b == 'number') {
            if ( (b & 0xff) == b) {
              // 1byte
              bytes.push(b);
            } else {
              // 2bytes
              bytes.push(b >>> 8);
              bytes.push(b & 0xff);
            }
          } else {
            bytes.push(unknownChar);
          }
        }
      }
      return bytes;
    };
  };

  //---------------------------------------------------------------------
  // QRMode
  //---------------------------------------------------------------------

  var QRMode = {
    MODE_NUMBER :    1 << 0,
    MODE_ALPHA_NUM : 1 << 1,
    MODE_8BIT_BYTE : 1 << 2,
    MODE_KANJI :     1 << 3
  };

  //---------------------------------------------------------------------
  // QRErrorCorrectionLevel
  //---------------------------------------------------------------------

  var QRErrorCorrectionLevel = {
    L : 1,
    M : 0,
    Q : 3,
    H : 2
  };

  //---------------------------------------------------------------------
  // QRMaskPattern
  //---------------------------------------------------------------------

  var QRMaskPattern = {
    PATTERN000 : 0,
    PATTERN001 : 1,
    PATTERN010 : 2,
    PATTERN011 : 3,
    PATTERN100 : 4,
    PATTERN101 : 5,
    PATTERN110 : 6,
    PATTERN111 : 7
  };

  //---------------------------------------------------------------------
  // QRUtil
  //---------------------------------------------------------------------

  var QRUtil = function() {

    var PATTERN_POSITION_TABLE = [
      [],
      [6, 18],
      [6, 22],
      [6, 26],
      [6, 30],
      [6, 34],
      [6, 22, 38],
      [6, 24, 42],
      [6, 26, 46],
      [6, 28, 50],
      [6, 30, 54],
      [6, 32, 58],
      [6, 34, 62],
      [6, 26, 46, 66],
      [6, 26, 48, 70],
      [6, 26, 50, 74],
      [6, 30, 54, 78],
      [6, 30, 56, 82],
      [6, 30, 58, 86],
      [6, 34, 62, 90],
      [6, 28, 50, 72, 94],
      [6, 26, 50, 74, 98],
      [6, 30, 54, 78, 102],
      [6, 28, 54, 80, 106],
      [6, 32, 58, 84, 110],
      [6, 30, 58, 86, 114],
      [6, 34, 62, 90, 118],
      [6, 26, 50, 74, 98, 122],
      [6, 30, 54, 78, 102, 126],
      [6, 26, 52, 78, 104, 130],
      [6, 30, 56, 82, 108, 134],
      [6, 34, 60, 86, 112, 138],
      [6, 30, 58, 86, 114, 142],
      [6, 34, 62, 90, 118, 146],
      [6, 30, 54, 78, 102, 126, 150],
      [6, 24, 50, 76, 102, 128, 154],
      [6, 28, 54, 80, 106, 132, 158],
      [6, 32, 58, 84, 110, 136, 162],
      [6, 26, 54, 82, 110, 138, 166],
      [6, 30, 58, 86, 114, 142, 170]
    ];
    var G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
    var G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
    var G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

    var _this = {};

    var getBCHDigit = function(data) {
      var digit = 0;
      while (data != 0) {
        digit += 1;
        data >>>= 1;
      }
      return digit;
    };

    _this.getBCHTypeInfo = function(data) {
      var d = data << 10;
      while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
        d ^= (G15 << (getBCHDigit(d) - getBCHDigit(G15) ) );
      }
      return ( (data << 10) | d) ^ G15_MASK;
    };

    _this.getBCHTypeNumber = function(data) {
      var d = data << 12;
      while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
        d ^= (G18 << (getBCHDigit(d) - getBCHDigit(G18) ) );
      }
      return (data << 12) | d;
    };

    _this.getPatternPosition = function(typeNumber) {
      return PATTERN_POSITION_TABLE[typeNumber - 1];
    };

    _this.getMaskFunction = function(maskPattern) {

      switch (maskPattern) {

      case QRMaskPattern.PATTERN000 :
        return function(i, j) { return (i + j) % 2 == 0; };
      case QRMaskPattern.PATTERN001 :
        return function(i, j) { return i % 2 == 0; };
      case QRMaskPattern.PATTERN010 :
        return function(i, j) { return j % 3 == 0; };
      case QRMaskPattern.PATTERN011 :
        return function(i, j) { return (i + j) % 3 == 0; };
      case QRMaskPattern.PATTERN100 :
        return function(i, j) { return (Math.floor(i / 2) + Math.floor(j / 3) ) % 2 == 0; };
      case QRMaskPattern.PATTERN101 :
        return function(i, j) { return (i * j) % 2 + (i * j) % 3 == 0; };
      case QRMaskPattern.PATTERN110 :
        return function(i, j) { return ( (i * j) % 2 + (i * j) % 3) % 2 == 0; };
      case QRMaskPattern.PATTERN111 :
        return function(i, j) { return ( (i * j) % 3 + (i + j) % 2) % 2 == 0; };

      default :
        throw 'bad maskPattern:' + maskPattern;
      }
    };

    _this.getErrorCorrectPolynomial = function(errorCorrectLength) {
      var a = qrPolynomial([1], 0);
      for (var i = 0; i < errorCorrectLength; i += 1) {
        a = a.multiply(qrPolynomial([1, QRMath.gexp(i)], 0) );
      }
      return a;
    };

    _this.getLengthInBits = function(mode, type) {

      if (1 <= type && type < 10) {

        // 1 - 9

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 10;
        case QRMode.MODE_ALPHA_NUM : return 9;
        case QRMode.MODE_8BIT_BYTE : return 8;
        case QRMode.MODE_KANJI     : return 8;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 27) {

        // 10 - 26

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 12;
        case QRMode.MODE_ALPHA_NUM : return 11;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 10;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 41) {

        // 27 - 40

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 14;
        case QRMode.MODE_ALPHA_NUM : return 13;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 12;
        default :
          throw 'mode:' + mode;
        }

      } else {
        throw 'type:' + type;
      }
    };

    _this.getLostPoint = function(qrcode) {

      var moduleCount = qrcode.getModuleCount();

      var lostPoint = 0;

      // LEVEL1

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount; col += 1) {

          var sameCount = 0;
          var dark = qrcode.isDark(row, col);

          for (var r = -1; r <= 1; r += 1) {

            if (row + r < 0 || moduleCount <= row + r) {
              continue;
            }

            for (var c = -1; c <= 1; c += 1) {

              if (col + c < 0 || moduleCount <= col + c) {
                continue;
              }

              if (r == 0 && c == 0) {
                continue;
              }

              if (dark == qrcode.isDark(row + r, col + c) ) {
                sameCount += 1;
              }
            }
          }

          if (sameCount > 5) {
            lostPoint += (3 + sameCount - 5);
          }
        }
      };

      // LEVEL2

      for (var row = 0; row < moduleCount - 1; row += 1) {
        for (var col = 0; col < moduleCount - 1; col += 1) {
          var count = 0;
          if (qrcode.isDark(row, col) ) count += 1;
          if (qrcode.isDark(row + 1, col) ) count += 1;
          if (qrcode.isDark(row, col + 1) ) count += 1;
          if (qrcode.isDark(row + 1, col + 1) ) count += 1;
          if (count == 0 || count == 4) {
            lostPoint += 3;
          }
        }
      }

      // LEVEL3

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount - 6; col += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row, col + 1)
              &&  qrcode.isDark(row, col + 2)
              &&  qrcode.isDark(row, col + 3)
              &&  qrcode.isDark(row, col + 4)
              && !qrcode.isDark(row, col + 5)
              &&  qrcode.isDark(row, col + 6) ) {
            lostPoint += 40;
          }
        }
      }

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount - 6; row += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row + 1, col)
              &&  qrcode.isDark(row + 2, col)
              &&  qrcode.isDark(row + 3, col)
              &&  qrcode.isDark(row + 4, col)
              && !qrcode.isDark(row + 5, col)
              &&  qrcode.isDark(row + 6, col) ) {
            lostPoint += 40;
          }
        }
      }

      // LEVEL4

      var darkCount = 0;

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount; row += 1) {
          if (qrcode.isDark(row, col) ) {
            darkCount += 1;
          }
        }
      }

      var ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
      lostPoint += ratio * 10;

      return lostPoint;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // QRMath
  //---------------------------------------------------------------------

  var QRMath = function() {

    var EXP_TABLE = new Array(256);
    var LOG_TABLE = new Array(256);

    // initialize tables
    for (var i = 0; i < 8; i += 1) {
      EXP_TABLE[i] = 1 << i;
    }
    for (var i = 8; i < 256; i += 1) {
      EXP_TABLE[i] = EXP_TABLE[i - 4]
        ^ EXP_TABLE[i - 5]
        ^ EXP_TABLE[i - 6]
        ^ EXP_TABLE[i - 8];
    }
    for (var i = 0; i < 255; i += 1) {
      LOG_TABLE[EXP_TABLE[i] ] = i;
    }

    var _this = {};

    _this.glog = function(n) {

      if (n < 1) {
        throw 'glog(' + n + ')';
      }

      return LOG_TABLE[n];
    };

    _this.gexp = function(n) {

      while (n < 0) {
        n += 255;
      }

      while (n >= 256) {
        n -= 255;
      }

      return EXP_TABLE[n];
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrPolynomial
  //---------------------------------------------------------------------

  function qrPolynomial(num, shift) {

    if (typeof num.length == 'undefined') {
      throw num.length + '/' + shift;
    }

    var _num = function() {
      var offset = 0;
      while (offset < num.length && num[offset] == 0) {
        offset += 1;
      }
      var _num = new Array(num.length - offset + shift);
      for (var i = 0; i < num.length - offset; i += 1) {
        _num[i] = num[i + offset];
      }
      return _num;
    }();

    var _this = {};

    _this.getAt = function(index) {
      return _num[index];
    };

    _this.getLength = function() {
      return _num.length;
    };

    _this.multiply = function(e) {

      var num = new Array(_this.getLength() + e.getLength() - 1);

      for (var i = 0; i < _this.getLength(); i += 1) {
        for (var j = 0; j < e.getLength(); j += 1) {
          num[i + j] ^= QRMath.gexp(QRMath.glog(_this.getAt(i) ) + QRMath.glog(e.getAt(j) ) );
        }
      }

      return qrPolynomial(num, 0);
    };

    _this.mod = function(e) {

      if (_this.getLength() - e.getLength() < 0) {
        return _this;
      }

      var ratio = QRMath.glog(_this.getAt(0) ) - QRMath.glog(e.getAt(0) );

      var num = new Array(_this.getLength() );
      for (var i = 0; i < _this.getLength(); i += 1) {
        num[i] = _this.getAt(i);
      }

      for (var i = 0; i < e.getLength(); i += 1) {
        num[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i) ) + ratio);
      }

      // recursive call
      return qrPolynomial(num, 0).mod(e);
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // QRRSBlock
  //---------------------------------------------------------------------

  var QRRSBlock = function() {

    var RS_BLOCK_TABLE = [

      // L
      // M
      // Q
      // H

      // 1
      [1, 26, 19],
      [1, 26, 16],
      [1, 26, 13],
      [1, 26, 9],

      // 2
      [1, 44, 34],
      [1, 44, 28],
      [1, 44, 22],
      [1, 44, 16],

      // 3
      [1, 70, 55],
      [1, 70, 44],
      [2, 35, 17],
      [2, 35, 13],

      // 4
      [1, 100, 80],
      [2, 50, 32],
      [2, 50, 24],
      [4, 25, 9],

      // 5
      [1, 134, 108],
      [2, 67, 43],
      [2, 33, 15, 2, 34, 16],
      [2, 33, 11, 2, 34, 12],

      // 6
      [2, 86, 68],
      [4, 43, 27],
      [4, 43, 19],
      [4, 43, 15],

      // 7
      [2, 98, 78],
      [4, 49, 31],
      [2, 32, 14, 4, 33, 15],
      [4, 39, 13, 1, 40, 14],

      // 8
      [2, 121, 97],
      [2, 60, 38, 2, 61, 39],
      [4, 40, 18, 2, 41, 19],
      [4, 40, 14, 2, 41, 15],

      // 9
      [2, 146, 116],
      [3, 58, 36, 2, 59, 37],
      [4, 36, 16, 4, 37, 17],
      [4, 36, 12, 4, 37, 13],

      // 10
      [2, 86, 68, 2, 87, 69],
      [4, 69, 43, 1, 70, 44],
      [6, 43, 19, 2, 44, 20],
      [6, 43, 15, 2, 44, 16],

      // 11
      [4, 101, 81],
      [1, 80, 50, 4, 81, 51],
      [4, 50, 22, 4, 51, 23],
      [3, 36, 12, 8, 37, 13],

      // 12
      [2, 116, 92, 2, 117, 93],
      [6, 58, 36, 2, 59, 37],
      [4, 46, 20, 6, 47, 21],
      [7, 42, 14, 4, 43, 15],

      // 13
      [4, 133, 107],
      [8, 59, 37, 1, 60, 38],
      [8, 44, 20, 4, 45, 21],
      [12, 33, 11, 4, 34, 12],

      // 14
      [3, 145, 115, 1, 146, 116],
      [4, 64, 40, 5, 65, 41],
      [11, 36, 16, 5, 37, 17],
      [11, 36, 12, 5, 37, 13],

      // 15
      [5, 109, 87, 1, 110, 88],
      [5, 65, 41, 5, 66, 42],
      [5, 54, 24, 7, 55, 25],
      [11, 36, 12, 7, 37, 13],

      // 16
      [5, 122, 98, 1, 123, 99],
      [7, 73, 45, 3, 74, 46],
      [15, 43, 19, 2, 44, 20],
      [3, 45, 15, 13, 46, 16],

      // 17
      [1, 135, 107, 5, 136, 108],
      [10, 74, 46, 1, 75, 47],
      [1, 50, 22, 15, 51, 23],
      [2, 42, 14, 17, 43, 15],

      // 18
      [5, 150, 120, 1, 151, 121],
      [9, 69, 43, 4, 70, 44],
      [17, 50, 22, 1, 51, 23],
      [2, 42, 14, 19, 43, 15],

      // 19
      [3, 141, 113, 4, 142, 114],
      [3, 70, 44, 11, 71, 45],
      [17, 47, 21, 4, 48, 22],
      [9, 39, 13, 16, 40, 14],

      // 20
      [3, 135, 107, 5, 136, 108],
      [3, 67, 41, 13, 68, 42],
      [15, 54, 24, 5, 55, 25],
      [15, 43, 15, 10, 44, 16],

      // 21
      [4, 144, 116, 4, 145, 117],
      [17, 68, 42],
      [17, 50, 22, 6, 51, 23],
      [19, 46, 16, 6, 47, 17],

      // 22
      [2, 139, 111, 7, 140, 112],
      [17, 74, 46],
      [7, 54, 24, 16, 55, 25],
      [34, 37, 13],

      // 23
      [4, 151, 121, 5, 152, 122],
      [4, 75, 47, 14, 76, 48],
      [11, 54, 24, 14, 55, 25],
      [16, 45, 15, 14, 46, 16],

      // 24
      [6, 147, 117, 4, 148, 118],
      [6, 73, 45, 14, 74, 46],
      [11, 54, 24, 16, 55, 25],
      [30, 46, 16, 2, 47, 17],

      // 25
      [8, 132, 106, 4, 133, 107],
      [8, 75, 47, 13, 76, 48],
      [7, 54, 24, 22, 55, 25],
      [22, 45, 15, 13, 46, 16],

      // 26
      [10, 142, 114, 2, 143, 115],
      [19, 74, 46, 4, 75, 47],
      [28, 50, 22, 6, 51, 23],
      [33, 46, 16, 4, 47, 17],

      // 27
      [8, 152, 122, 4, 153, 123],
      [22, 73, 45, 3, 74, 46],
      [8, 53, 23, 26, 54, 24],
      [12, 45, 15, 28, 46, 16],

      // 28
      [3, 147, 117, 10, 148, 118],
      [3, 73, 45, 23, 74, 46],
      [4, 54, 24, 31, 55, 25],
      [11, 45, 15, 31, 46, 16],

      // 29
      [7, 146, 116, 7, 147, 117],
      [21, 73, 45, 7, 74, 46],
      [1, 53, 23, 37, 54, 24],
      [19, 45, 15, 26, 46, 16],

      // 30
      [5, 145, 115, 10, 146, 116],
      [19, 75, 47, 10, 76, 48],
      [15, 54, 24, 25, 55, 25],
      [23, 45, 15, 25, 46, 16],

      // 31
      [13, 145, 115, 3, 146, 116],
      [2, 74, 46, 29, 75, 47],
      [42, 54, 24, 1, 55, 25],
      [23, 45, 15, 28, 46, 16],

      // 32
      [17, 145, 115],
      [10, 74, 46, 23, 75, 47],
      [10, 54, 24, 35, 55, 25],
      [19, 45, 15, 35, 46, 16],

      // 33
      [17, 145, 115, 1, 146, 116],
      [14, 74, 46, 21, 75, 47],
      [29, 54, 24, 19, 55, 25],
      [11, 45, 15, 46, 46, 16],

      // 34
      [13, 145, 115, 6, 146, 116],
      [14, 74, 46, 23, 75, 47],
      [44, 54, 24, 7, 55, 25],
      [59, 46, 16, 1, 47, 17],

      // 35
      [12, 151, 121, 7, 152, 122],
      [12, 75, 47, 26, 76, 48],
      [39, 54, 24, 14, 55, 25],
      [22, 45, 15, 41, 46, 16],

      // 36
      [6, 151, 121, 14, 152, 122],
      [6, 75, 47, 34, 76, 48],
      [46, 54, 24, 10, 55, 25],
      [2, 45, 15, 64, 46, 16],

      // 37
      [17, 152, 122, 4, 153, 123],
      [29, 74, 46, 14, 75, 47],
      [49, 54, 24, 10, 55, 25],
      [24, 45, 15, 46, 46, 16],

      // 38
      [4, 152, 122, 18, 153, 123],
      [13, 74, 46, 32, 75, 47],
      [48, 54, 24, 14, 55, 25],
      [42, 45, 15, 32, 46, 16],

      // 39
      [20, 147, 117, 4, 148, 118],
      [40, 75, 47, 7, 76, 48],
      [43, 54, 24, 22, 55, 25],
      [10, 45, 15, 67, 46, 16],

      // 40
      [19, 148, 118, 6, 149, 119],
      [18, 75, 47, 31, 76, 48],
      [34, 54, 24, 34, 55, 25],
      [20, 45, 15, 61, 46, 16]
    ];

    var qrRSBlock = function(totalCount, dataCount) {
      var _this = {};
      _this.totalCount = totalCount;
      _this.dataCount = dataCount;
      return _this;
    };

    var _this = {};

    var getRsBlockTable = function(typeNumber, errorCorrectionLevel) {

      switch(errorCorrectionLevel) {
      case QRErrorCorrectionLevel.L :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
      case QRErrorCorrectionLevel.M :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
      case QRErrorCorrectionLevel.Q :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
      case QRErrorCorrectionLevel.H :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
      default :
        return undefined;
      }
    };

    _this.getRSBlocks = function(typeNumber, errorCorrectionLevel) {

      var rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);

      if (typeof rsBlock == 'undefined') {
        throw 'bad rs block @ typeNumber:' + typeNumber +
            '/errorCorrectionLevel:' + errorCorrectionLevel;
      }

      var length = rsBlock.length / 3;

      var list = [];

      for (var i = 0; i < length; i += 1) {

        var count = rsBlock[i * 3 + 0];
        var totalCount = rsBlock[i * 3 + 1];
        var dataCount = rsBlock[i * 3 + 2];

        for (var j = 0; j < count; j += 1) {
          list.push(qrRSBlock(totalCount, dataCount) );
        }
      }

      return list;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrBitBuffer
  //---------------------------------------------------------------------

  var qrBitBuffer = function() {

    var _buffer = [];
    var _length = 0;

    var _this = {};

    _this.getBuffer = function() {
      return _buffer;
    };

    _this.getAt = function(index) {
      var bufIndex = Math.floor(index / 8);
      return ( (_buffer[bufIndex] >>> (7 - index % 8) ) & 1) == 1;
    };

    _this.put = function(num, length) {
      for (var i = 0; i < length; i += 1) {
        _this.putBit( ( (num >>> (length - i - 1) ) & 1) == 1);
      }
    };

    _this.getLengthInBits = function() {
      return _length;
    };

    _this.putBit = function(bit) {

      var bufIndex = Math.floor(_length / 8);
      if (_buffer.length <= bufIndex) {
        _buffer.push(0);
      }

      if (bit) {
        _buffer[bufIndex] |= (0x80 >>> (_length % 8) );
      }

      _length += 1;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrNumber
  //---------------------------------------------------------------------

  var qrNumber = function(data) {

    var _mode = QRMode.MODE_NUMBER;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var data = _data;

      var i = 0;

      while (i + 2 < data.length) {
        buffer.put(strToNum(data.substring(i, i + 3) ), 10);
        i += 3;
      }

      if (i < data.length) {
        if (data.length - i == 1) {
          buffer.put(strToNum(data.substring(i, i + 1) ), 4);
        } else if (data.length - i == 2) {
          buffer.put(strToNum(data.substring(i, i + 2) ), 7);
        }
      }
    };

    var strToNum = function(s) {
      var num = 0;
      for (var i = 0; i < s.length; i += 1) {
        num = num * 10 + chatToNum(s.charAt(i) );
      }
      return num;
    };

    var chatToNum = function(c) {
      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      }
      throw 'illegal char :' + c;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrAlphaNum
  //---------------------------------------------------------------------

  var qrAlphaNum = function(data) {

    var _mode = QRMode.MODE_ALPHA_NUM;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var s = _data;

      var i = 0;

      while (i + 1 < s.length) {
        buffer.put(
          getCode(s.charAt(i) ) * 45 +
          getCode(s.charAt(i + 1) ), 11);
        i += 2;
      }

      if (i < s.length) {
        buffer.put(getCode(s.charAt(i) ), 6);
      }
    };

    var getCode = function(c) {

      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      } else if ('A' <= c && c <= 'Z') {
        return c.charCodeAt(0) - 'A'.charCodeAt(0) + 10;
      } else {
        switch (c) {
        case ' ' : return 36;
        case '$' : return 37;
        case '%' : return 38;
        case '*' : return 39;
        case '+' : return 40;
        case '-' : return 41;
        case '.' : return 42;
        case '/' : return 43;
        case ':' : return 44;
        default :
          throw 'illegal char :' + c;
        }
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qr8BitByte
  //---------------------------------------------------------------------

  var qr8BitByte = function(data) {

    var _mode = QRMode.MODE_8BIT_BYTE;
    var _data = data;
    var _bytes = qrcode.stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _bytes.length;
    };

    _this.write = function(buffer) {
      for (var i = 0; i < _bytes.length; i += 1) {
        buffer.put(_bytes[i], 8);
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrKanji
  //---------------------------------------------------------------------

  var qrKanji = function(data) {

    var _mode = QRMode.MODE_KANJI;
    var _data = data;

    var stringToBytes = qrcode.stringToBytesFuncs['SJIS'];
    if (!stringToBytes) {
      throw 'sjis not supported.';
    }
    !function(c, code) {
      // self test for sjis support.
      var test = stringToBytes(c);
      if (test.length != 2 || ( (test[0] << 8) | test[1]) != code) {
        throw 'sjis not supported.';
      }
    }('\\u53cb', 0x9746);

    var _bytes = stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return ~~(_bytes.length / 2);
    };

    _this.write = function(buffer) {

      var data = _bytes;

      var i = 0;

      while (i + 1 < data.length) {

        var c = ( (0xff & data[i]) << 8) | (0xff & data[i + 1]);

        if (0x8140 <= c && c <= 0x9FFC) {
          c -= 0x8140;
        } else if (0xE040 <= c && c <= 0xEBBF) {
          c -= 0xC140;
        } else {
          throw 'illegal char at ' + (i + 1) + '/' + c;
        }

        c = ( (c >>> 8) & 0xff) * 0xC0 + (c & 0xff);

        buffer.put(c, 13);

        i += 2;
      }

      if (i < data.length) {
        throw 'illegal char at ' + (i + 1);
      }
    };

    return _this;
  };

  //=====================================================================
  // GIF Support etc.
  //

  //---------------------------------------------------------------------
  // byteArrayOutputStream
  //---------------------------------------------------------------------

  var byteArrayOutputStream = function() {

    var _bytes = [];

    var _this = {};

    _this.writeByte = function(b) {
      _bytes.push(b & 0xff);
    };

    _this.writeShort = function(i) {
      _this.writeByte(i);
      _this.writeByte(i >>> 8);
    };

    _this.writeBytes = function(b, off, len) {
      off = off || 0;
      len = len || b.length;
      for (var i = 0; i < len; i += 1) {
        _this.writeByte(b[i + off]);
      }
    };

    _this.writeString = function(s) {
      for (var i = 0; i < s.length; i += 1) {
        _this.writeByte(s.charCodeAt(i) );
      }
    };

    _this.toByteArray = function() {
      return _bytes;
    };

    _this.toString = function() {
      var s = '';
      s += '[';
      for (var i = 0; i < _bytes.length; i += 1) {
        if (i > 0) {
          s += ',';
        }
        s += _bytes[i];
      }
      s += ']';
      return s;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64EncodeOutputStream
  //---------------------------------------------------------------------

  var base64EncodeOutputStream = function() {

    var _buffer = 0;
    var _buflen = 0;
    var _length = 0;
    var _base64 = '';

    var _this = {};

    var writeEncoded = function(b) {
      _base64 += String.fromCharCode(encode(b & 0x3f) );
    };

    var encode = function(n) {
      if (n < 0) {
        // error.
      } else if (n < 26) {
        return 0x41 + n;
      } else if (n < 52) {
        return 0x61 + (n - 26);
      } else if (n < 62) {
        return 0x30 + (n - 52);
      } else if (n == 62) {
        return 0x2b;
      } else if (n == 63) {
        return 0x2f;
      }
      throw 'n:' + n;
    };

    _this.writeByte = function(n) {

      _buffer = (_buffer << 8) | (n & 0xff);
      _buflen += 8;
      _length += 1;

      while (_buflen >= 6) {
        writeEncoded(_buffer >>> (_buflen - 6) );
        _buflen -= 6;
      }
    };

    _this.flush = function() {

      if (_buflen > 0) {
        writeEncoded(_buffer << (6 - _buflen) );
        _buffer = 0;
        _buflen = 0;
      }

      if (_length % 3 != 0) {
        // padding
        var padlen = 3 - _length % 3;
        for (var i = 0; i < padlen; i += 1) {
          _base64 += '=';
        }
      }
    };

    _this.toString = function() {
      return _base64;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64DecodeInputStream
  //---------------------------------------------------------------------

  var base64DecodeInputStream = function(str) {

    var _str = str;
    var _pos = 0;
    var _buffer = 0;
    var _buflen = 0;

    var _this = {};

    _this.read = function() {

      while (_buflen < 8) {

        if (_pos >= _str.length) {
          if (_buflen == 0) {
            return -1;
          }
          throw 'unexpected end of file./' + _buflen;
        }

        var c = _str.charAt(_pos);
        _pos += 1;

        if (c == '=') {
          _buflen = 0;
          return -1;
        } else if (c.match(/^\\s$/) ) {
          // ignore if whitespace.
          continue;
        }

        _buffer = (_buffer << 6) | decode(c.charCodeAt(0) );
        _buflen += 6;
      }

      var n = (_buffer >>> (_buflen - 8) ) & 0xff;
      _buflen -= 8;
      return n;
    };

    var decode = function(c) {
      if (0x41 <= c && c <= 0x5a) {
        return c - 0x41;
      } else if (0x61 <= c && c <= 0x7a) {
        return c - 0x61 + 26;
      } else if (0x30 <= c && c <= 0x39) {
        return c - 0x30 + 52;
      } else if (c == 0x2b) {
        return 62;
      } else if (c == 0x2f) {
        return 63;
      } else {
        throw 'c:' + c;
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // gifImage (B/W)
  //---------------------------------------------------------------------

  var gifImage = function(width, height) {

    var _width = width;
    var _height = height;
    var _data = new Array(width * height);

    var _this = {};

    _this.setPixel = function(x, y, pixel) {
      _data[y * _width + x] = pixel;
    };

    _this.write = function(out) {

      //---------------------------------
      // GIF Signature

      out.writeString('GIF87a');

      //---------------------------------
      // Screen Descriptor

      out.writeShort(_width);
      out.writeShort(_height);

      out.writeByte(0x80); // 2bit
      out.writeByte(0);
      out.writeByte(0);

      //---------------------------------
      // Global Color Map

      // black
      out.writeByte(0x00);
      out.writeByte(0x00);
      out.writeByte(0x00);

      // white
      out.writeByte(0xff);
      out.writeByte(0xff);
      out.writeByte(0xff);

      //---------------------------------
      // Image Descriptor

      out.writeString(',');
      out.writeShort(0);
      out.writeShort(0);
      out.writeShort(_width);
      out.writeShort(_height);
      out.writeByte(0);

      //---------------------------------
      // Local Color Map

      //---------------------------------
      // Raster Data

      var lzwMinCodeSize = 2;
      var raster = getLZWRaster(lzwMinCodeSize);

      out.writeByte(lzwMinCodeSize);

      var offset = 0;

      while (raster.length - offset > 255) {
        out.writeByte(255);
        out.writeBytes(raster, offset, 255);
        offset += 255;
      }

      out.writeByte(raster.length - offset);
      out.writeBytes(raster, offset, raster.length - offset);
      out.writeByte(0x00);

      //---------------------------------
      // GIF Terminator
      out.writeString(';');
    };

    var bitOutputStream = function(out) {

      var _out = out;
      var _bitLength = 0;
      var _bitBuffer = 0;

      var _this = {};

      _this.write = function(data, length) {

        if ( (data >>> length) != 0) {
          throw 'length over';
        }

        while (_bitLength + length >= 8) {
          _out.writeByte(0xff & ( (data << _bitLength) | _bitBuffer) );
          length -= (8 - _bitLength);
          data >>>= (8 - _bitLength);
          _bitBuffer = 0;
          _bitLength = 0;
        }

        _bitBuffer = (data << _bitLength) | _bitBuffer;
        _bitLength = _bitLength + length;
      };

      _this.flush = function() {
        if (_bitLength > 0) {
          _out.writeByte(_bitBuffer);
        }
      };

      return _this;
    };

    var getLZWRaster = function(lzwMinCodeSize) {

      var clearCode = 1 << lzwMinCodeSize;
      var endCode = (1 << lzwMinCodeSize) + 1;
      var bitLength = lzwMinCodeSize + 1;

      // Setup LZWTable
      var table = lzwTable();

      for (var i = 0; i < clearCode; i += 1) {
        table.add(String.fromCharCode(i) );
      }
      table.add(String.fromCharCode(clearCode) );
      table.add(String.fromCharCode(endCode) );

      var byteOut = byteArrayOutputStream();
      var bitOut = bitOutputStream(byteOut);

      // clear code
      bitOut.write(clearCode, bitLength);

      var dataIndex = 0;

      var s = String.fromCharCode(_data[dataIndex]);
      dataIndex += 1;

      while (dataIndex < _data.length) {

        var c = String.fromCharCode(_data[dataIndex]);
        dataIndex += 1;

        if (table.contains(s + c) ) {

          s = s + c;

        } else {

          bitOut.write(table.indexOf(s), bitLength);

          if (table.size() < 0xfff) {

            if (table.size() == (1 << bitLength) ) {
              bitLength += 1;
            }

            table.add(s + c);
          }

          s = c;
        }
      }

      bitOut.write(table.indexOf(s), bitLength);

      // end code
      bitOut.write(endCode, bitLength);

      bitOut.flush();

      return byteOut.toByteArray();
    };

    var lzwTable = function() {

      var _map = {};
      var _size = 0;

      var _this = {};

      _this.add = function(key) {
        if (_this.contains(key) ) {
          throw 'dup key:' + key;
        }
        _map[key] = _size;
        _size += 1;
      };

      _this.size = function() {
        return _size;
      };

      _this.indexOf = function(key) {
        return _map[key];
      };

      _this.contains = function(key) {
        return typeof _map[key] != 'undefined';
      };

      return _this;
    };

    return _this;
  };

  var createDataURL = function(width, height, getPixel) {
    var gif = gifImage(width, height);
    for (var y = 0; y < height; y += 1) {
      for (var x = 0; x < width; x += 1) {
        gif.setPixel(x, y, getPixel(x, y) );
      }
    }

    var b = byteArrayOutputStream();
    gif.write(b);

    var base64 = base64EncodeOutputStream();
    var bytes = b.toByteArray();
    for (var i = 0; i < bytes.length; i += 1) {
      base64.writeByte(bytes[i]);
    }
    base64.flush();

    return 'data:image/gif;base64,' + base64;
  };

  //---------------------------------------------------------------------
  // returns qrcode function.

  return qrcode;
}();

// multibyte support
!function() {

  qrcode.stringToBytesFuncs['UTF-8'] = function(s) {
    // http://stackoverflow.com/questions/18729405/how-to-convert-utf8-string-to-byte-array
    function toUTF8Array(str) {
      var utf8 = [];
      for (var i=0; i < str.length; i++) {
        var charcode = str.charCodeAt(i);
        if (charcode < 0x80) utf8.push(charcode);
        else if (charcode < 0x800) {
          utf8.push(0xc0 | (charcode >> 6),
              0x80 | (charcode & 0x3f));
        }
        else if (charcode < 0xd800 || charcode >= 0xe000) {
          utf8.push(0xe0 | (charcode >> 12),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
        // surrogate pair
        else {
          i++;
          // UTF-16 encodes 0x10000-0x10FFFF by
          // subtracting 0x10000 and splitting the
          // 20 bits of 0x0-0xFFFFF into two halves
          charcode = 0x10000 + (((charcode & 0x3ff)<<10)
            | (str.charCodeAt(i) & 0x3ff));
          utf8.push(0xf0 | (charcode >>18),
              0x80 | ((charcode>>12) & 0x3f),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
      }
      return utf8;
    }
    return toUTF8Array(s);
  };

}();

(function (factory) {
  if (typeof define === 'function' && define.amd) {
      define([], factory);
  } else if (typeof exports === 'object') {
      module.exports = factory();
  }
}(function () {
    return qrcode;
}));
`;var F=null,x=null,Ge=0,P=new Map;function re(o,e){if(!P.has(o))return;P.delete(o),e.idleTimer&&clearTimeout(e.idleTimer);let r=e.chunks.reduce((n,a)=>n+a.length,0),t=new Uint8Array(r),i=0;for(let n of e.chunks)t.set(n,i),i+=n.length;e.resolve({b64:Je(t)})}function Xe(o){if(o.contentLen===void 0&&o.chunks.length){let e=Ke(o.chunks);if(e>=0){o.headBytes=e;let t=new TextDecoder().decode(ke(o.chunks,e)).match(/content-length:\s*(\d+)/i);o.contentLen=t?parseInt(t[1],10):-1}}return o.contentLen!==void 0&&o.contentLen>=0&&o.headBytes!==void 0&&o.chunks.reduce((r,t)=>r+t.length,0)-o.headBytes>=o.contentLen}function Ke(o){let e=Math.min(o.reduce((t,i)=>t+i.length,0),65536),r=ke(o,e);for(let t=0;t+3<r.length;t++)if(r[t]===13&&r[t+1]===10&&r[t+2]===13&&r[t+3]===10)return t+4;return-1}function ke(o,e){let r=new Uint8Array(e),t=0;for(let i of o){let n=Math.min(i.length,e-t);if(r.set(i.subarray(0,n),t),t+=n,t>=e)break}return r}function Je(o){let e="";for(let t=0;t<o.length;t+=32768)e+=String.fromCharCode(...o.subarray(t,t+32768));return btoa(e)}function Ve(o){let e=atob(o),r=new Uint8Array(e.length);for(let t=0;t<e.length;t++)r[t]=e.charCodeAt(t);return r}function Ye(){if(F)return F;let o=D(),e=o?o.__sup:null;if(!e||typeof e.initPreviewSW!="function")throw new Error("Nodine runtime is not booted yet \u2014 start the dev environment first.");let r=crypto.randomUUID(),t=new MessageChannel,i=new Map,n=null;return t.port2.onmessage=a=>{let l=a.data||{};if(console.error("[lanShare] bridge msg:",l.type,"port:",l.port,"ports:",a.ports?a.ports.length:0),l.type==="preview-port-open"){let s=a.ports&&a.ports[0];if(!s)return;s.onmessage=h=>{let f=h.data||{};console.error("[lanShare] pp msg:",f.type,f.id,"chunkBytes:",f.bytes?f.bytes.byteLength||f.bytes.length:0);let m=P.get(f.id);m&&(f.type==="preview-res"?(m.chunks.push(new Uint8Array(f.bytes)),Xe(m)?re(f.id,m):(m.idleTimer&&clearTimeout(m.idleTimer),m.idleTimer=setTimeout(()=>{P.has(f.id)&&re(f.id,m)},350))):f.type==="preview-open-req"?s.postMessage({type:"preview-open-ack"}):f.type==="preview-res-end"?re(f.id,m):f.type==="preview-res-err"&&(P.delete(f.id),m.idleTimer&&clearTimeout(m.idleTimer),m.resolve({b64:"",err:String(f.error||"preview error")})))},s.start?.(),s.postMessage({type:"preview-open-ack"}),i.set(l.port,s),n&&n()}else if(l.type==="preview-port-close"){let s=i.get(l.port);if(s)try{s.close()}catch{}i.delete(l.port),n&&n()}},t.port2.start?.(),e.initPreviewSW(r,t.port1),e.onPreviewEvent=()=>{n&&n()},F={sid:r,hasPort:a=>i.has(a),listPorts:()=>{let a=e.previewPorts,l=[];return a&&typeof a.forEach=="function"&&a.forEach((s,h)=>{l.push({port:h,argv:s&&s.argv||[]})}),l.sort((s,h)=>s.port-h.port)},request:(a,l,s)=>new Promise(h=>{let f=i.get(a);if(!f){h({b64:"",err:"no live bridge for port "+a});return}let m="r"+ ++Ge;P.set(m,{chunks:[],resolve:h}),console.error("[lanShare] posting preview-req",m,"on port",a,"head:",l.split(`\r
`)[0]),f.postMessage({type:"preview-req",id:m,head:l,body:s||void 0}),setTimeout(()=>{P.has(m)&&(P.delete(m),h({b64:"",err:"timeout (30s) waiting for the dev server"}))},3e4)})},F}function Ze(){let e=(w.extensions.getExtension("amplytic.webide-dev")??w.extensions.getExtension("webide-dev"))?.extensionUri?.toString()??"";return new URL(e).origin}async function et(o,e,r){let t=Date.now();for(;Date.now()-t<r;){if(o.hasPort(e))return!0;await new Promise(i=>setTimeout(i,250))}return o.hasPort(e)}async function Se(){if(console.error("[lanShare] command invoked"),await w.window.showInformationMessage("Share a dev server on your local network?",{modal:!0,detail:`Why: this opens a WebRTC connection between your phone and this browser tab so the phone can preview the dev server running in the IDE.

What this needs: devices on the same Wi-Fi can connect to this tab. Nothing is installed, no cloud service is involved, and your files stay on this machine.

Without it: the preview on your phone will not connect. The IDE itself keeps working.`},"Approve")!=="Approve")return;let e;try{e=Ye()}catch(i){w.window.showErrorMessage("Share on LAN: "+(i instanceof Error?i.message:String(i)));return}console.error("[lanShare] share using container",D()?.__bootTag),console.error("[lanShare] bridge ok, ports:",JSON.stringify(e.listPorts()));let r=e.listPorts(),t;if(r.length===0){let i=await w.window.showInputBox({prompt:"Port to share (start your dev server first so it appears here)",placeHolder:"3000"});if(!i||(t=Number(i),!Number.isFinite(t)||t<=0||t>65535))return}else if(r.length===1)t=r[0].port;else{let i=r.map(a=>({label:":"+a.port,description:(a.argv&&a.argv.length?a.argv.join(" "):"")||"listening",port:a.port})),n=await w.window.showQuickPick(i,{placeHolder:"Which dev server do you want to share?"});if(!n)return;t=n.port}e.hasPort(t)||await w.window.withProgress({location:w.ProgressLocation.Notification,title:`Share on LAN: attaching bridge for :${t}`},()=>et(e,t,4e3)),x?x.reveal():(x=w.window.createWebviewPanel("nodineLanShare",`LAN share :${t}`,{viewColumn:w.ViewColumn.Beside},{enableScripts:!0,retainContextWhenHidden:!0}),x.onDidDispose(()=>{x=null}),x.webview.onDidReceiveMessage(async i=>{if(!x||!i||i.t!=="req")return;console.error("[lanShare] relay req",i.id,"live:",F.hasPort(t));let n=await F.request(t,String(i.head||""),i.bodyB64?Ve(String(i.bodyB64)):null);console.error("[lanShare] relay res",i.id,"err:",n.err||"none","len:",n.b64.length),x.webview.postMessage({t:"res",id:i.id,b64:n.b64,err:n.err||null})})),x.title=`LAN share :${t}`,x.webview.html=_e(tt(),xe),await new Promise(i=>setTimeout(i,120)),x.webview.postMessage({t:"init",port:t,guestBase:Ze()+"/share/"}),w.window.showInformationMessage(`Sharing :${t} on your local network. Scan the QR from the panel with your phone (same Wi-Fi).`)}function tt(){let o="";for(;o.length<32;)o+=Math.random().toString(36).slice(2);return o.slice(0,32)}var ie=class{constructor(e,r){this.container=e;this.relPath=r}container;relPath;writeEmitter=new c.EventEmitter;onDidWrite=this.writeEmitter.event;closeEmitter=new c.EventEmitter;onDidClose=this.closeEmitter.event;async open(){try{let e=await this.container.spawn("node",[this.relPath],{cwd:this.container.workdir,env:this.container.baseEnv});if(e.output){let t=e.output.getReader();(async()=>{for(;;){let{done:i,value:n}=await t.read();if(i)break;this.writeEmitter.fire(n)}})()}let r=await e.exit;this.writeEmitter.fire(`\r
\x1B[90mexited with code ${r}\x1B[0m\r
`)}catch(e){this.writeEmitter.fire(`\r
\x1B[31m${e}\x1B[0m\r
`)}this.closeEmitter.fire(0)}handleInput(){}close(){}},ne=null;function Pe(o){ne=o}function U(){return ne}async function rt(o){console.error("[webide-dev] activate: registering commands");let e=()=>{let d=c.workspace.workspaceFolders?.some(u=>u.uri.scheme==="nodine")??!1;c.commands.executeCommand("setContext","webide-dev.noProject",!d)};e(),o.subscriptions.push(c.workspace.onDidChangeWorkspaceFolders(e));let r=c.window.createTreeView("webide-dev.welcome",{treeDataProvider:{getChildren:()=>[],getTreeItem:()=>({label:""})}});o.subscriptions.push(r),r.description="Upload \xB7 Import \xB7 Terminal",setTimeout(()=>{c.commands.executeCommand("webide-dev.welcome.focus").then(()=>{},()=>{})},1500);let i=c.workspace.getConfiguration("webide-dev").get("runtimeUrl","/nodine/supervisor.mjs"),n=null,a=()=>(n||(n=(async()=>{if(!V())return c.window.showErrorMessage("Dev environment needs a cross-origin isolated host: the server must send Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: credentialless headers."),null;try{return await j(i)}catch(d){return console.error("[webide-dev] runtime boot failed:",d),n=null,c.window.showErrorMessage(`Dev environment boot failed: ${d instanceof Error?d.message:d}`),null}})()),n),l=a(),s=new H(async()=>(await l,D())),h=!1;o.subscriptions.push(c.workspace.registerFileSystemProvider("nodine",s,{isCaseSensitive:!0})),h=!0,l.then(()=>{s.fireExternalChange(c.FileChangeType.Created,"/.nodine-sync")}).catch(()=>{}),he(()=>{s.fireExternalChange(c.FileChangeType.Created,"/.nodine-sync")});let f=async()=>{let d=await a();if(!d)return null;let u=(g,b)=>s.fireExternalChange(g,`/${b}`);return{writeFile:async(g,b)=>{let S=g.split("/").slice(0,-1).join("/");if(S)try{await d.fs.mkdir(`/${S}`,{recursive:!0}),u(c.FileChangeType.Created,S)}catch{}await d.fs.writeFile(`/${g}`,b),u(c.FileChangeType.Changed,g),u(c.FileChangeType.Changed,S)},ensureDir:async g=>{try{await d.fs.mkdir(`/${g}`,{recursive:!0}),u(c.FileChangeType.Created,g)}catch{}}}},m=async()=>{let d=await f();if(!d)throw new Error("Dev environment is not running (needs cross-origin isolated host with the nodine runtime).");return d},T=async d=>{let u=await f();return u?(await u.ensureDir(d),await u.writeFile(`${d}/package.json`,new TextEncoder().encode(JSON.stringify({name:d,version:"1.0.0",scripts:{start:"node index.js"}},null,2))),await u.writeFile(`${d}/index.js`,new TextEncoder().encode('console.log("hello from '+d+`");
`)),await L(d),"ok"):"no-runtime"};c.commands.registerCommand("webide-dev._simulateUpload",T),globalThis.__webideDevTest={simulateUpload:T,provider:s,state:async()=>({activated:!0,providerRegistered:h,watchCalls:s.watchCalls,hookFired:pe(),activationEvents:c.extensions.getExtension("amplytic.webide-dev")?.packageJSON?.activationEvents??null,folders:(c.workspace.workspaceFolders??[]).map(d=>({uri:d.uri.toString(),name:d.name})),readdirViaFs:await(async()=>{try{return(await c.workspace.fs.readDirectory(N())).map(([u,g])=>u+(g===c.FileType.Directory?"/":"")).join(",")}catch(d){return"ERR:"+String(d).slice(0,90)}})(),readdirRoot:await(async()=>{try{let d=await a();return d?(await d.fs.readdir("/")).join(","):"no-container"}catch(d){return"err:"+String(d).slice(0,80)}})()})};let y=async()=>{c.workspace.workspaceFolders?.find(u=>u.uri.scheme==="nodine")||await le()},I=async()=>{let d=c.Uri.joinPath(N(),".vscode/settings.json");try{await c.workspace.fs.readFile(d);return}catch{}let u=JSON.stringify({"files.exclude":{bin:!0,home:!0,project:!0,root:!0,tmp:!0,usr:!0,".vscode":!0},"terminal.integrated.defaultProfile.linux":"Nodine (Node.js)","terminal.integrated.defaultProfile.osx":"Nodine (Node.js)","terminal.integrated.defaultProfile.windows":"Nodine (Node.js)"},null,2);await c.workspace.fs.writeFile(d,new TextEncoder().encode(u+`
`))},A=async d=>{await c.commands.executeCommand("revealInExplorer",N()),s.fireExternalChange(c.FileChangeType.Created,"/.nodine-sync"),c.commands.executeCommand("workbench.view.explorer")},X=async()=>{let d=await c.window.showInputBox({prompt:"GitHub repository \u2014 paste the URL or owner/repo",placeHolder:"https://github.com/owner/repo (add #branch for a specific branch)",ignoreFocusOut:!0});if(!d)return null;let u=await c.window.showInputBox({prompt:"GitHub PAT \u2014 optional for public repos, required for private repos",placeHolder:"github_pat_\u2026 or ghp_\u2026 (kept for this session only, empty for public)",password:!0,ignoreFocusOut:!0});return u===void 0?null:{repoInput:d,tokenInput:u}},L=async d=>{Pe(`/${d}`),await y(),await ee(o),await A(d)};l.then(async d=>{if(d)try{await y(),e(),await I();let u=c.workspace.getConfiguration("terminal.integrated");Promise.allSettled([u.update("defaultProfile.linux",void 0,c.ConfigurationTarget.Workspace),u.update("defaultProfile.osx",void 0,c.ConfigurationTarget.Workspace),u.update("defaultProfile.windows",void 0,c.ConfigurationTarget.Workspace)]).then(()=>{Promise.allSettled([u.update("defaultProfile.linux","Nodine (Node.js)",c.ConfigurationTarget.Global),u.update("defaultProfile.osx","Nodine (Node.js)",c.ConfigurationTarget.Global),u.update("defaultProfile.windows","Nodine (Node.js)",c.ConfigurationTarget.Global)])}),await ee(o);let g=new WeakMap;o.subscriptions.push(c.window.onDidOpenTerminal(b=>g.set(b,Date.now()))),o.subscriptions.push(c.window.onDidCloseTerminal(b=>{c.window.terminals.length>0||Date.now()-(g.get(b)??0)<3e3||setTimeout(()=>{c.window.terminals.length===0&&W(o)},500)}))}catch(u){console.error("[webide-dev] auto workspace/terminal failed:",u)}}),o.subscriptions.push(c.commands.registerCommand("webide-dev.createTerminal",()=>{W(o)}),c.commands.registerCommand("webide-dev.createNodineTerminal",()=>W(o)),c.window.registerTerminalProfileProvider("webide-dev.nodine",new Q(i)),c.commands.registerCommand("webide-dev.importGithub",async()=>{let d=await X();if(!d)return;let u=await f();if(!u){c.window.showErrorMessage("Dev environment is not running (needs cross-origin isolated host with the nodine runtime).");return}await ge(d,u.writeFile,u.ensureDir,L)}),c.commands.registerCommand("webide-dev.uploadFolder",async()=>{await Ce(async(d,u)=>(await m()).writeFile(d,u),async d=>(await m()).ensureDir(d),L,async()=>{await m()})}),c.commands.registerCommand("webide-dev.runFile",async d=>{let u=d??c.window.activeTextEditor?.document.uri;if(!u||u.scheme!=="nodine"){c.window.showErrorMessage("Open a file from the nodine workspace to run it.");return}let g=D();if(!g)return;let b=u.path.replace(/^\/+/,""),S=c.window.createTerminal({name:`node ${b}`,pty:new ie(g,b)});o.subscriptions.push(S),S.show()}),c.commands.registerCommand("webide-dev.previewPort",async()=>{let d=D();if(!d)return;let u=await c.window.showInputBox({prompt:"Port number",placeHolder:"3000"}),g=Number(u);if(!Number.isFinite(g))return;let b=d.previewUrl(g);await c.env.openExternal(c.Uri.parse(b))}),c.commands.registerCommand("webide-dev.shareLan",()=>Se()))}
//# sourceMappingURL=extensionMain.js.map
