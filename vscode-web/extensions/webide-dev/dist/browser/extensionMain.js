"use strict";var Ee=Object.create;var $=Object.defineProperty;var Be=Object.getOwnPropertyDescriptor;var Le=Object.getOwnPropertyNames;var Ae=Object.getPrototypeOf,De=Object.prototype.hasOwnProperty;var Me=(i,e)=>{for(var t in e)$(i,t,{get:e[t],enumerable:!0})},ae=(i,e,t,r)=>{if(e&&typeof e=="object"||typeof e=="function")for(let o of Le(e))!De.call(i,o)&&o!==t&&$(i,o,{get:()=>e[o],enumerable:!(r=Be(e,o))||r.enumerable});return i};var L=(i,e,t)=>(t=i!=null?Ee(Ae(i)):{},ae(e||!i||!i.__esModule?$(t,"default",{value:i,enumerable:!0}):t,i)),Fe=i=>ae($({},"__esModule",{value:!0}),i);var nt={};Me(nt,{activate:()=>it,getProjectCwd:()=>U,projectCwd:()=>ne,setProjectCwd:()=>Pe});module.exports=Fe(nt);var s=L(require("vscode"));var J=L(require("vscode")),z=null,O=null;function P(){return O}function V(){return(typeof window<"u"?window:typeof self<"u"?self:globalThis).crossOriginIsolated===!0}async function j(i,e="project"){return O||(z||(z=(async()=>{if(!V())throw new Error("This page is not cross-origin isolated. The dev environment needs the hosting server to send Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: credentialless headers.");let r=(J.extensions.getExtension("amplytic.webide-dev")??J.extensions.getExtension("webide-dev"))?.extensionUri?.toString(),o=typeof document<"u"?document.baseURI:r?r.replace(/\/+$/,"")+"/":void 0;if(!o)throw new Error("Cannot resolve the app origin for the nodine runtime URL from this worker context.");let n=new URL(i,o).href,c=await(await import(new URL("./sdk.mjs",n).href)).Container.boot({runtimeUrl:n,coep:"credentialless",workdirName:e});return O=c,c.__bootTag="boot-"+Math.random().toString(36).slice(2,8),console.error("[webide-dev] bootContainer created",c.__bootTag),c})().catch(t=>{throw z=null,t})),z)}var m=L(require("vscode")),se="nodine",ce="nodine://nodine/Nodine/",Y="/Nodine";function N(){return m.Uri.parse(ce)}var H=class{constructor(e){this.getContainer=e}getContainer;watchCalls=0;async ready(){let e=await this.getContainer();if(!e)throw m.FileSystemError.Unavailable("Dev environment is still booting (nodine runtime)");return e}toContainerPath(e){let t=e.path;return t===Y?"/":t.startsWith(`${Y}/`)?t.slice(Y.length):t.startsWith("/")?t:`/${t}`}toWorkspaceUri(e){let t=e.replace(/^\/+/,"");return m.Uri.parse(`${ce}${t}`)}stat(e){return this._stat(this.toContainerPath(e))}async _stat(e){let t=await this.ready();try{return await t.fs.readdir(e),{type:m.FileType.Directory,ctime:0,mtime:Date.now(),size:0}}catch{try{let r=await t.fs.readFile(e);return{type:m.FileType.File,ctime:0,mtime:Date.now(),size:r.length}}catch{throw m.FileSystemError.FileNotFound(e)}}}readDirectory(e){return(async()=>{let t=await this.ready(),r=this.toContainerPath(e),o;try{o=await t.fs.readdir(r,{withFileTypes:!0})}catch{throw m.FileSystemError.FileNotFound(e)}let n=[],a=[];for(let l of o){let c=typeof l=="string"?l:l.name??String(l),h=typeof l=="object"&&l!==null?typeof l.isDirectory=="function"?l.isDirectory()?"directory":"file":l._kind??(l.type===2?"directory":l.type===1?"file":void 0):void 0;h==="directory"?n.push([c,m.FileType.Directory]):h==="file"?n.push([c,m.FileType.File]):a.push(c)}for(let l of a)try{await t.fs.readdir(`${r}/${l}`),n.push([l,m.FileType.Directory])}catch{n.push([l,m.FileType.File])}return n})()}readFile(e){return(async()=>(await this.ready()).fs.readFile(this.toContainerPath(e)).catch(()=>{throw m.FileSystemError.FileNotFound(e)}))()}writeFile(e,t,r){return(async()=>{let o=await this.ready(),n=this.toContainerPath(e);if(!r.overwrite)try{if(await o.fs.readFile(n),!r.overwrite)throw m.FileSystemError.FileExists(e)}catch(a){if(a instanceof m.FileSystemError&&a.code==="FileExists")throw a}await o.fs.writeFile(n,t),this._fireDidChange(e)})()}createDirectory(e){return(async()=>{await(await this.ready()).fs.mkdir(this.toContainerPath(e),{recursive:!0}),this._fireFileCreated(e)})()}fireExternalChange(e,t){this._onDidChangeFile.fire([{type:e,uri:this.toWorkspaceUri(t)}])}async exists(e){let t=await this.ready();try{return await t.fs.readdir(e),!0}catch{try{return await t.fs.readFile(e),!0}catch{return!1}}}delete(e,t){return(async()=>{let r=await this.ready(),o=this.toContainerPath(e);if(!await this.exists(o))throw m.FileSystemError.FileNotFound(e);await r.fs.rm(o,{recursive:t.recursive,force:!0}),this._fireFileDeleted(e)})()}rename(e,t,r){return(async()=>{let o=await this.ready(),n=this.toContainerPath(e),a=this.toContainerPath(t);if(!r.overwrite&&await this.exists(a))throw m.FileSystemError.FileExists(t);await o.fs.rename(n,a),this._fireFileDeleted(e),this._fireFileCreated(t)})()}watch(e){this.watchCalls++;let t=this.toContainerPath(e),r;return this.ready().then(o=>{try{r=o.fs.watch(t,(n,a)=>{let l=(a??"").startsWith("/")?a:`${t}/${a??""}`,c=l.replace(/\/+$/,"").split("/");c.pop();let h=c.join("/")||"/";this._fireDidChange(this.toWorkspaceUri(h)),this._fireDidChange(this.toWorkspaceUri(l))})}catch{}}).catch(()=>{}),new m.Disposable(()=>r?.close())}_onDidChangeFile=new m.EventEmitter;onDidChangeFile=this._onDidChangeFile.event;_fireDidChange(e){this._onDidChangeFile.fire([{type:m.FileChangeType.Changed,uri:e}])}_fireFileCreated(e){this._onDidChangeFile.fire([{type:m.FileChangeType.Created,uri:e}])}_fireFileDeleted(e){this._onDidChangeFile.fire([{type:m.FileChangeType.Deleted,uri:e}])}get scheme(){return se}};async function le(i){let e=N(),t=m.workspace.workspaceFolders;if(t?.some(n=>n.uri.scheme===se))return;m.workspace.updateWorkspaceFolders(0,t?.length??0,{uri:e,name:"Nodine"})||console.error("[webide-dev] updateWorkspaceFolders returned false (workspace change rejected)")}var _=L(require("vscode"));var ue=null,fe=0;function he(i){ue=i}function pe(){return fe}var q=class{constructor(e){this.runtimeUrl=e}runtimeUrl;writeEmitter=new _.EventEmitter;onDidWrite=this.writeEmitter.event;closeEmitter=new _.EventEmitter;onDidClose=this.closeEmitter.event;container=null;current=null;inputWriter=null;inheritSpawn=!1;outSub=null;outDecoder=null;acceptUntil=0;buffer="";running=!1;cwd=null;atLineStart=!0;stdinHintShown=!1;cd(e){e?this.cwd=e.replace(/\/+$/,"")||"/":this.cwd="/",this.container&&this.prompt()}resolveCwd(e){return this.cwd??"/"}outBuf="";outTimer=null;write(e){this.outBuf+=e.replace(/\r\n/g,`
`).replace(/\n/g,`\r
`),this.outTimer===null&&(this.outTimer=setTimeout(()=>this.flushOut(),12))}flushOut(){if(this.outTimer!==null&&(clearTimeout(this.outTimer),this.outTimer=null),!this.outBuf)return;let e=this.outBuf;this.outBuf="",this.atLineStart=e.endsWith(`\r
`)||e.endsWith(`
`),this.writeEmitter.fire(e)}clearScreen(){this.flushOut(),this.writeEmitter.fire("\x1B[2J\x1B[3J\x1B[H"),this.atLineStart=!0}async open(e){this.clearScreen(),this.write(`\x1B[90mstarting dev environment\u2026\x1B[0m\r
`);try{this.container=await j(this.runtimeUrl),console.error("[webide-dev] terminal using container",this.container.__bootTag)}catch(r){console.error("[webide-dev] runtime boot failed:",r),this.write(`\x1B[31mfailed to start the dev environment (the host must send cross-origin isolation headers).\x1B[0m\r
`),this.closeEmitter.fire(1);return}this.outDecoder=new TextDecoder,this.outSub=this.container.onOutput(r=>{if(!this.running&&Date.now()>this.acceptUntil)return;let o=typeof r=="string"?r:this.outDecoder.decode(r,{stream:!0});this.write(o)});let t=await this.nodeVersion();this.clearScreen(),t&&this.write(`Node.js ${t}\r
\r
`),this.prompt()}nodeVersionCache=null;async nodeVersion(){if(this.nodeVersionCache!==null)return this.nodeVersionCache;try{let e=await this.container.spawn("node",["-p","process.version"]),t="",r=(async()=>{if(!e.output)return;let n=e.output.getReader();for(;;){let{done:a,value:l}=await n.read();if(a)break;t+=l}})(),o=await Promise.race([e.exit,new Promise(n=>setTimeout(()=>n(null),2e4))]);if(await Promise.race([r,new Promise(n=>setTimeout(n,2e3))]),o===null){try{await e.kill()}catch{}this.nodeVersionCache=null}else this.nodeVersionCache=t.trim().replace(/^['"]|['"]$/g,"")||null}catch{this.nodeVersionCache=null}return this.nodeVersionCache}displayCwd(){let e=this.cwd??"/";return e==="/"?"Nodine/":`Nodine${e}`}prompt(){this.flushOut(),this.atLineStart||(this.writeEmitter.fire(`\r
`),this.atLineStart=!0),this.writeEmitter.fire(`\x1B[36m${this.displayCwd()}\x1B[0m \u276F `)}changeDir(e){if(!this.container)return;let t=this.resolveCwd(this.container),r;!e||e==="~"?r=this.container.workdir:e==="/"||e==="-"?r="/":e.startsWith("/")?r=e:r=`${t}/${e}`;let o=[];for(let n of r.split("/"))if(!(!n||n===".")){if(n===".."){o.pop();continue}o.push(n)}this.cwd="/"+o.join("/")}supStdin(){let e=this.container.__sup;return e?.sendStdin&&e.foreground&&!e.foreground.exited?t=>{try{e.sendStdin(t)}catch{}}:null}handleInput(e){if(this.container){if(this.running){if(e.includes("")){let t=this.supStdin();if(t)t(new Uint8Array([3]));else{this.inputWriter&&this.inputWriter.write("");try{this.current?.kill()}catch{}}this.write(`^C\r
`),this.atLineStart=!0;return}for(let t of e){let r=this.inheritSpawn?this.supStdin():null,o=new TextEncoder().encode(t);r?r(o):this.inputWriter&&(t==="\r"&&this.writeEmitter.fire(`\r
`),this.inputWriter.write(t))}return}for(let t of e)if(t==="\r"){let r=this.buffer;this.buffer="",this.write(`\r
`),this.runLine(r);return}else t==="\x7F"?this.buffer.length>0&&(this.buffer=this.buffer.slice(0,-1),this.writeEmitter.fire("\b \b")):t===""?(this.buffer="",this.write(`^C\r
`),this.prompt()):t>=" "&&(this.buffer+=t,this.writeEmitter.fire(t))}}async runLine(e){let t=this.container;if(!t)return;let r=Re(e);if(r.every(o=>de(o).length===0)){this.prompt();return}this.running=!0;try{for(let o of r)if(await this.runSegment(o,t)!==0)break}finally{this.finishCommand()}}async runSegment(e,t){let r=de(e);if(r.length===0)return 0;let o=null;for(let n=1;n<r.length;n++)if(r[n]===">"||r[n]===">>"){let a=r[n+1];if(!a)return this.write(`\x1B[31msyntax error: expected file after redirect\x1B[0m\r
`),2;o={path:a,append:r[n]===">>"},r.length=n;break}if(r[0]==="clear")return this.clearScreen(),0;if(r[0]==="cd")return this.changeDir(r[1]),0;if(r[0]==="pwd"){let n=`${this.resolveCwd(t)}\r
`;return o?await this.writeContainerFile(t,o,n.replace(`\r
`,`
`)):this.write(n),0}if(r[0]==="echo"){let n=`${r.slice(1).join(" ")}\r
`;return o?await this.writeContainerFile(t,o,r.slice(1).join(" ")+`
`):this.write(n),0}if(r[0]==="exit")return this.closeEmitter.fire(0),0;if(r[0]===">"){let n=e.replace(/^\s*>\s*/,"");if(!n)return 0;let a=await t.spawn("node",["-e",Ne(n)],{cwd:this.resolveCwd(t),env:{...t.baseEnv}});return this.current=a,this.inheritSpawn=!1,await this.pump(a,t)}try{let n,a={cwd:this.resolveCwd(t),env:{...t.baseEnv,...r[0]==="npm"||r[0]==="npx"?{npm_config_progress:"false"}:{}},stdio:o?"pipe":"inherit"};if(r[0]==="node"){if(r.length===1)return this.write(`\x1B[90musage: node <file.js> \xB7 node -v \xB7 node -e "<code>"\x1B[0m\r
`),0;n=await t.spawn("node",r.slice(1),a)}else n=await t.spawn(r[0],r.slice(1),a);return this.current=n,this.inheritSpawn=!o,this.inputWriter=n.input?n.input.getWriter():null,await this.pump(n,t,o)}catch(n){let a=String(n).split(`
`)[0].replace(/^FileSystemError:\s*/,"");return this.write(`\x1B[31m${a}\x1B[0m\r
`),1}}async writeContainerFile(e,t,r){let o=this.resolveCwd(e),n=t.path.startsWith("/")?t.path:`${o}/${t.path}`,a=r;if(t.append)try{a=new TextDecoder().decode(await e.fs.readFile(n))+r}catch{}else{let l=n.slice(0,n.lastIndexOf("/"))||"/";try{await e.fs.mkdir(l,{recursive:!0})}catch{}}await e.fs.writeFile(n,a)}async pump(e,t,r){let o="";if(e.output){let a=e.output.getReader();try{for(;;){let{done:l,value:c}=await a.read();if(l)break;r?o+=c:this.write(c)}}catch{}}let n=await e.exit;if(r){try{await this.writeContainerFile(t,r,o)}catch(a){return this.write(`\x1B[31mwrite failed: ${String(a).split(`
`)[0]}\x1B[0m\r
`),1}return n===0?0:n}return n!==0&&this.write(`\x1B[90m(exit ${n})\x1B[0m\r
`),n}finishCommand(){if(this.running=!1,this.current=null,this.stdinHintShown=!1,this.inheritSpawn=!1,this.acceptUntil=Date.now()+600,this.flushOut(),this.inputWriter){try{this.inputWriter.close()}catch{}this.inputWriter=null}try{fe++,ue?.()}catch{}setTimeout(()=>{this.flushOut(),this.container&&this.prompt()},160)}setDimensions(e){}async close(){if(this.outSub){try{this.outSub()}catch{}this.outSub=null}if(this.inputWriter){try{await this.inputWriter.close()}catch{}this.inputWriter=null}if(this.current)try{await this.current.kill()}catch{}}};function Ne(i){return`(function(){const __r=eval(${JSON.stringify(i)});if(__r!==undefined)console.log(__r)})()`}function Re(i){let e=[],t="",r=null;for(let o=0;o<i.length;o++){let n=i[o];r?(t+=n,n===r&&(r=null)):n==='"'||n==="'"?(r=n,t+=n):n==="&"&&i[o+1]==="&"?(e.push(t),t="",o++):t+=n}return e.push(t),e.map(o=>o.trim())}function de(i){let e=[],t="",r=null,o=!1;for(let n=0;n<i.length;n++){let a=i[n];r?a===r?r=null:t+=a:a==='"'||a==="'"?(r=a,o=!0):a==="\\"&&n+1<i.length?(t+=i[++n],o=!0):/\s/.test(a)?(t||o)&&(e.push(t),t="",o=!1):(t+=a,o=!0)}return(t||o)&&e.push(t),e}function W(i){let t=_.workspace.getConfiguration("webide-dev").get("runtimeUrl","/nodine/supervisor.mjs"),r=new q(t),o=_.window.createTerminal({name:"node (nodine)",pty:r,iconPath:new _.ThemeIcon("terminal")});return i.subscriptions.push(o),o.show(),o}var R=null,Z=null;function ee(i){if(R&&R.exitStatus===void 0)return Z&&Z.cd(U()??""),R.show(),R;let t=_.workspace.getConfiguration("webide-dev").get("runtimeUrl","/nodine/supervisor.mjs"),r=new q(t);r.cd(U()??"");let o=_.window.createTerminal({name:"node (nodine)",pty:r,iconPath:new _.ThemeIcon("terminal")});return R=o,Z=r,i.subscriptions.push(o),o.show(),o}var Q=class{runtimeUrl;constructor(e){this.runtimeUrl=e}provideTerminalProfile(e){let t=new q(this.runtimeUrl);return t.cd(U()??""),{name:"node (nodine)",options:{pty:t}}}};var x=L(require("vscode")),qe=new Set(["node_modules",".git",".github",".vscode","dist","build",".next",".turbo",".cache","coverage",".idea","out",".parcel-cache","target"]),Ue=new Set([".log",".map"]),Ie=new Set(["package-lock.json","yarn.lock","pnpm-lock.yaml"]),G=1e3,$e=512;function ze(i){i=i.trim().replace(/\.git$/,"");let e,t=i.match(/#([\w./-]+)$/);t&&(e=t[1],i=i.slice(0,t.index));let r=i.match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/tree\/([\w./-]+))?/i);return r?{owner:r[1],repo:r[2],ref:r[3]||e}:(r=i.match(/^([\w.-]+)\/([\w.-]+)$/),r?{owner:r[1],repo:r[2],ref:e}:null)}function Oe(i){let e=i.split("/").pop()||"";if(Ie.has(e))return!0;if(i.split("/").some(r=>qe.has(r)))return!1;let t=i.lastIndexOf(".");return!(t>=0&&Ue.has(i.slice(t)))}async function te(i,e){let t={Accept:"application/vnd.github+json"};e&&(t.Authorization=`Bearer ${e}`);let r=await fetch(`https://api.github.com${i}`,{headers:t});if(r.status===404)throw new Error("repo, ref or path not found (404) \u2014 check the URL"+(e?"":" and whether the repo is private (a token is needed for that)"));if(r.status===401)throw new Error("GitHub rejected the token (401).");if(r.status===403){let o=await r.json().catch(()=>({}));throw o?.message?.includes("rate limit")?new Error("GitHub rate limit exceeded. Provide a PAT (raises it to 5000/hr)."):new Error(String(o?.message||"HTTP 403 (forbidden \u2014 private repo? a token is needed)"))}if(!r.ok)throw new Error(`GitHub returned HTTP ${r.status}`);return r.json()}var me;async function ge(i,e,t,r){let{repoInput:o,tokenInput:n}=i,a=ze(o);if(!a){x.window.showErrorMessage(`Not a GitHub repository: ${o}`);return}let{owner:l,repo:c,ref:h}=a,f=n.trim()||me,g=x.workspace.getConfiguration("webide-dev").get("githubMaxFileKb",$e);await x.window.withProgress({location:x.ProgressLocation.Notification,title:`Importing ${l}/${c}${h?`#${h}`:""}`,cancellable:!1},async E=>{try{E.report({message:"resolving ref\u2026"});let C;h&&/^[0-9a-f]{40}$/i.test(h)?C=h:C=(await te(`/repos/${l}/${c}/commits/${encodeURIComponent(h??"HEAD")}`,f)).sha,n.trim()&&(me=n.trim()),E.report({message:"listing files\u2026"});let I=await te(`/repos/${l}/${c}/git/trees/${C}?recursive=1`,f);I.truncated&&x.window.showWarningMessage("Repo tree truncated by GitHub (very large repo) \u2014 importing a subset.");let A=I.tree.filter(p=>p.type==="blob"&&Oe(p.path)&&(p.size??0)<=g*1024);A.length>G&&x.window.showWarningMessage(`Repo has ${A.length} importable files \u2014 importing the first ${G} (large-repo cap).`);let X=A.slice(0,G),D=new Set,S=0,M=0,B=0,u=Array.from({length:6},async()=>{for(;;){let p=X.shift();if(!p)return;try{let b=await te(`/repos/${l}/${c}/git/blobs/${p.sha}`,f),Te=b.encoding==="base64"?je(b.content):new TextEncoder().encode(b.content),oe=p.path.split("/").slice(0,-1).join("/"),K=oe?`${l}-${c}/${oe}`:`${l}-${c}`;D.has(K)||(await t(K),D.add(K)),await e(`${l}-${c}/${p.path}`,Te),S++}catch(b){M++,console.warn(`[webide-dev] blob fetch failed for ${p.path}:`,b)}B++;let w=Math.min(A.length,G);if(B%(w<50?1:10)===0||B===w){let b=w>0?Math.round(B/w*100):100;E.report({message:`${B}/${w} files \xB7 ${b}%`,increment:100/w})}}});await Promise.all(u),await r(`${l}-${c}`),x.window.showInformationMessage(`Imported ${S} files from ${l}/${c}`+(M?` \u2014 ${M} failed`:"")+". node_modules and build artifacts were skipped.")}catch(C){x.window.showErrorMessage(`GitHub import failed: ${C instanceof Error?C.message:String(C)}`)}})}function je(i){let e=atob(i.replace(/\n/g,"")),t=new Uint8Array(e.length);for(let r=0;r<e.length;r++)t[r]=e.charCodeAt(r);return t}var v=L(require("vscode")),ve=new Set(["node_modules",".git",".github",".vscode","dist","build",".next",".cache","coverage",".idea",".turbo","out"]),we=512;async function be(i,e){let t;try{t=await v.workspace.fs.readDirectory(i)}catch{return 0}let r=0;for(let[o,n]of t)if(n===v.FileType.Directory){if(ve.has(o))continue;r+=await be(v.Uri.joinPath(i,o),e)}else if(n===v.FileType.File){if(o.endsWith(".map")||o===".DS_Store")continue;r++}return r}async function ye(i,e,t,r,o,n){let a;try{a=await v.workspace.fs.readDirectory(i)}catch{return 0}await r(e);let l=0;for(let[c,h]of a)if(h===v.FileType.Directory){if(ve.has(c))continue;l+=await ye(v.Uri.joinPath(i,c),`${e}/${c}`,t,r,o,n)}else if(h===v.FileType.File){if(c.endsWith(".map")||c===".DS_Store")continue;try{if((await v.workspace.fs.stat(v.Uri.joinPath(i,c))).size>we*1024){n.skipped++;continue}let g=await v.workspace.fs.readFile(v.Uri.joinPath(i,c));await t(`${e}/${c}`,g),l++,n.copied++,n.copied%(n.copied<50?1:10)===0&&o(0,`${n.copied} files copied${n.skipped?` \xB7 ${n.skipped} skipped`:""}`)}catch(f){n.skipped++,console.warn(`[webide-dev] upload: failed to read ${c}:`,f)}}return l}async function Ce(i,e,t,r){let o=await v.window.showOpenDialog({canSelectFiles:!1,canSelectFolders:!0,canSelectMany:!1,openLabel:"Upload Folder",title:"Choose a local folder to upload into the dev environment"});if(console.log("[webide-dev] upload: picker returned",o?.map(l=>l.toString())),!o||o.length===0)return;let n=o[0],a=n.path.split("/").filter(Boolean).pop()||"uploaded-folder";await v.window.withProgress({location:v.ProgressLocation.Notification,title:`Uploading ${a}`,cancellable:!1},async l=>{try{l.report({message:"booting dev environment\u2026"}),await r(),l.report({message:"scanning files\u2026"});let c={copied:0,skipped:0},h=await be(n,c);if(h===0){v.window.showWarningMessage(`No uploadable files found in ${a} (node_modules and build artifacts are skipped).`);return}l.report({message:`copying ${h} files\u2026`,increment:0});let f=await ye(n,a,i,e,(E,C)=>l.report({message:C}),c);if(f===0){v.window.showWarningMessage(`No files uploaded from ${a} (empty, or all filtered by ignore rules).`);return}l.report({message:"preparing workspace\u2026",increment:100}),await t(a);let g=c.skipped?` (${c.skipped} skipped \u2014 ignored dirs or >${we} KB)`:"";v.window.showInformationMessage(`Uploaded ${f} of ${h} files from ${a}${g} \u2014 dev terminal is booting at /${a}.`)}catch(c){v.window.showErrorMessage(`Folder upload failed: ${c instanceof Error?c.message:String(c)}`)}})}var y=L(require("vscode"));var He=`
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
`);function _e(i,e){return`<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${i}'; style-src 'unsafe-inline'; img-src data:;">
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
	<script nonce="${i}">${e}<\/script>
	<script nonce="${i}">${Qe}<\/script>
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
`;var F=null,k=null,Ge=0,T=new Map;function re(i,e){if(!T.has(i))return;T.delete(i),e.idleTimer&&clearTimeout(e.idleTimer);let t=e.chunks.reduce((n,a)=>n+a.length,0),r=new Uint8Array(t),o=0;for(let n of e.chunks)r.set(n,o),o+=n.length;e.resolve({b64:Je(r)})}function Xe(i){if(i.contentLen===void 0&&i.chunks.length){let e=Ke(i.chunks);if(e>=0){i.headBytes=e;let r=new TextDecoder().decode(ke(i.chunks,e)).match(/content-length:\s*(\d+)/i);i.contentLen=r?parseInt(r[1],10):-1}}return i.contentLen!==void 0&&i.contentLen>=0&&i.headBytes!==void 0&&i.chunks.reduce((t,r)=>t+r.length,0)-i.headBytes>=i.contentLen}function Ke(i){let e=Math.min(i.reduce((r,o)=>r+o.length,0),65536),t=ke(i,e);for(let r=0;r+3<t.length;r++)if(t[r]===13&&t[r+1]===10&&t[r+2]===13&&t[r+3]===10)return r+4;return-1}function ke(i,e){let t=new Uint8Array(e),r=0;for(let o of i){let n=Math.min(o.length,e-r);if(t.set(o.subarray(0,n),r),r+=n,r>=e)break}return t}function Je(i){let e="";for(let r=0;r<i.length;r+=32768)e+=String.fromCharCode(...i.subarray(r,r+32768));return btoa(e)}function Ve(i){let e=atob(i),t=new Uint8Array(e.length);for(let r=0;r<e.length;r++)t[r]=e.charCodeAt(r);return t}function Ye(){if(F)return F;let i=P(),e=i?i.__sup:null;if(!e||typeof e.initPreviewSW!="function")throw new Error("Nodine runtime is not booted yet \u2014 start the dev environment first.");let t=crypto.randomUUID(),r=new MessageChannel,o=new Map,n=null;return r.port2.onmessage=a=>{let l=a.data||{};if(console.error("[lanShare] bridge msg:",l.type,"port:",l.port,"ports:",a.ports?a.ports.length:0),l.type==="preview-port-open"){let c=a.ports&&a.ports[0];if(!c)return;c.onmessage=h=>{let f=h.data||{};console.error("[lanShare] pp msg:",f.type,f.id,"chunkBytes:",f.bytes?f.bytes.byteLength||f.bytes.length:0);let g=T.get(f.id);g&&(f.type==="preview-res"?(g.chunks.push(new Uint8Array(f.bytes)),Xe(g)?re(f.id,g):(g.idleTimer&&clearTimeout(g.idleTimer),g.idleTimer=setTimeout(()=>{T.has(f.id)&&re(f.id,g)},350))):f.type==="preview-open-req"?c.postMessage({type:"preview-open-ack"}):f.type==="preview-res-end"?re(f.id,g):f.type==="preview-res-err"&&(T.delete(f.id),g.idleTimer&&clearTimeout(g.idleTimer),g.resolve({b64:"",err:String(f.error||"preview error")})))},c.start?.(),c.postMessage({type:"preview-open-ack"}),o.set(l.port,c),n&&n()}else if(l.type==="preview-port-close"){let c=o.get(l.port);if(c)try{c.close()}catch{}o.delete(l.port),n&&n()}},r.port2.start?.(),e.initPreviewSW(t,r.port1),e.onPreviewEvent=()=>{n&&n()},F={sid:t,hasPort:a=>o.has(a),listPorts:()=>{let a=e.previewPorts,l=[];return a&&typeof a.forEach=="function"&&a.forEach((c,h)=>{l.push({port:h,argv:c&&c.argv||[]})}),l.sort((c,h)=>c.port-h.port)},request:(a,l,c)=>new Promise(h=>{let f=o.get(a);if(!f){h({b64:"",err:"no live bridge for port "+a});return}let g="r"+ ++Ge;T.set(g,{chunks:[],resolve:h}),console.error("[lanShare] posting preview-req",g,"on port",a,"head:",l.split(`\r
`)[0]),f.postMessage({type:"preview-req",id:g,head:l,body:c||void 0}),setTimeout(()=>{T.has(g)&&(T.delete(g),h({b64:"",err:"timeout (30s) waiting for the dev server"}))},3e4)})},F}function Ze(){let e=(y.extensions.getExtension("amplytic.webide-dev")??y.extensions.getExtension("webide-dev"))?.extensionUri?.toString()??"";return new URL(e).origin}async function et(i,e,t){let r=Date.now();for(;Date.now()-r<t;){if(i.hasPort(e))return!0;await new Promise(o=>setTimeout(o,250))}return i.hasPort(e)}async function Se(){console.error("[lanShare] command invoked");let i;try{i=Ye()}catch(r){y.window.showErrorMessage("Share on LAN: "+(r instanceof Error?r.message:String(r)));return}console.error("[lanShare] share using container",P()?.__bootTag),console.error("[lanShare] bridge ok, ports:",JSON.stringify(i.listPorts()));let e=i.listPorts(),t;if(e.length===0){let r=await y.window.showInputBox({prompt:"Port to share (start your dev server first so it appears here)",placeHolder:"3000"});if(!r||(t=Number(r),!Number.isFinite(t)||t<=0||t>65535))return}else if(e.length===1)t=e[0].port;else{let r=e.map(n=>({label:":"+n.port,description:(n.argv&&n.argv.length?n.argv.join(" "):"")||"listening",port:n.port})),o=await y.window.showQuickPick(r,{placeHolder:"Which dev server do you want to share?"});if(!o)return;t=o.port}i.hasPort(t)||await y.window.withProgress({location:y.ProgressLocation.Notification,title:`Share on LAN: attaching bridge for :${t}`},()=>et(i,t,4e3)),k?k.reveal():(k=y.window.createWebviewPanel("nodineLanShare",`LAN share :${t}`,{viewColumn:y.ViewColumn.Beside},{enableScripts:!0,retainContextWhenHidden:!0}),k.onDidDispose(()=>{k=null}),k.webview.onDidReceiveMessage(async r=>{if(!k||!r||r.t!=="req")return;console.error("[lanShare] relay req",r.id,"live:",F.hasPort(t));let o=await F.request(t,String(r.head||""),r.bodyB64?Ve(String(r.bodyB64)):null);console.error("[lanShare] relay res",r.id,"err:",o.err||"none","len:",o.b64.length),k.webview.postMessage({t:"res",id:r.id,b64:o.b64,err:o.err||null})})),k.title=`LAN share :${t}`,k.webview.html=_e(tt(),xe),await new Promise(r=>setTimeout(r,120)),k.webview.postMessage({t:"init",port:t,guestBase:Ze()+"/share/"}),y.window.showInformationMessage(`Sharing :${t} on your local network. Scan the QR from the panel with your phone (same Wi-Fi).`)}function tt(){let i="";for(;i.length<32;)i+=Math.random().toString(36).slice(2);return i.slice(0,32)}function rt(){let i=P(),t=(i?i.__sup:null)?.previewPorts,r=[];return t&&typeof t.forEach=="function"&&t.forEach((o,n)=>{r.push(n)}),r.sort((o,n)=>o-n)}var ie=class{constructor(e,t){this.container=e;this.relPath=t}container;relPath;writeEmitter=new s.EventEmitter;onDidWrite=this.writeEmitter.event;closeEmitter=new s.EventEmitter;onDidClose=this.closeEmitter.event;async open(){try{let e=await this.container.spawn("node",[this.relPath],{cwd:this.container.workdir,env:this.container.baseEnv});if(e.output){let r=e.output.getReader();(async()=>{for(;;){let{done:o,value:n}=await r.read();if(o)break;this.writeEmitter.fire(n)}})()}let t=await e.exit;this.writeEmitter.fire(`\r
\x1B[90mexited with code ${t}\x1B[0m\r
`)}catch(e){this.writeEmitter.fire(`\r
\x1B[31m${e}\x1B[0m\r
`)}this.closeEmitter.fire(0)}handleInput(){}close(){}},ne=null;function Pe(i){ne=i}function U(){return ne}async function it(i){console.error("[webide-dev] activate: registering commands");let e=()=>{let d=s.workspace.workspaceFolders?.some(u=>u.uri.scheme==="nodine")??!1;s.commands.executeCommand("setContext","webide-dev.noProject",!d)};e(),i.subscriptions.push(s.workspace.onDidChangeWorkspaceFolders(e));let t=s.window.createTreeView("webide-dev.welcome",{treeDataProvider:{getChildren:()=>[],getTreeItem:()=>({label:""})}});i.subscriptions.push(t),t.description="Upload \xB7 Import \xB7 Terminal",setTimeout(()=>{s.commands.executeCommand("webide-dev.welcome.focus").then(()=>{},()=>{})},1500);let o=s.workspace.getConfiguration("webide-dev").get("runtimeUrl","/nodine/supervisor.mjs"),n=null,a=()=>(n||(n=(async()=>{if(!V())return s.window.showErrorMessage("Dev environment needs a cross-origin isolated host: the server must send Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: credentialless headers."),null;try{return await j(o)}catch(d){return console.error("[webide-dev] runtime boot failed:",d),n=null,s.window.showErrorMessage(`Dev environment boot failed: ${d instanceof Error?d.message:d}`),null}})()),n),l=a(),c=new H(async()=>(await l,P())),h=!1;i.subscriptions.push(s.workspace.registerFileSystemProvider("nodine",c,{isCaseSensitive:!0})),h=!0,l.then(()=>{c.fireExternalChange(s.FileChangeType.Created,"/.nodine-sync")}).catch(()=>{}),he(()=>{c.fireExternalChange(s.FileChangeType.Created,"/.nodine-sync")});let f=async()=>{let d=await a();if(!d)return null;let u=(p,w)=>c.fireExternalChange(p,`/${w}`);return{writeFile:async(p,w)=>{let b=p.split("/").slice(0,-1).join("/");if(b)try{await d.fs.mkdir(`/${b}`,{recursive:!0}),u(s.FileChangeType.Created,b)}catch{}await d.fs.writeFile(`/${p}`,w),u(s.FileChangeType.Changed,p),u(s.FileChangeType.Changed,b)},ensureDir:async p=>{try{await d.fs.mkdir(`/${p}`,{recursive:!0}),u(s.FileChangeType.Created,p)}catch{}}}},g=async()=>{let d=await f();if(!d)throw new Error("Dev environment is not running (needs cross-origin isolated host with the nodine runtime).");return d},E=async d=>{let u=await f();return u?(await u.ensureDir(d),await u.writeFile(`${d}/package.json`,new TextEncoder().encode(JSON.stringify({name:d,version:"1.0.0",scripts:{start:"node index.js"}},null,2))),await u.writeFile(`${d}/index.js`,new TextEncoder().encode('console.log("hello from '+d+`");
`)),await D(d),"ok"):"no-runtime"};s.commands.registerCommand("webide-dev._simulateUpload",E),globalThis.__webideDevTest={simulateUpload:E,provider:c,state:async()=>({activated:!0,providerRegistered:h,watchCalls:c.watchCalls,hookFired:pe(),activationEvents:s.extensions.getExtension("amplytic.webide-dev")?.packageJSON?.activationEvents??null,folders:(s.workspace.workspaceFolders??[]).map(d=>({uri:d.uri.toString(),name:d.name})),readdirViaFs:await(async()=>{try{return(await s.workspace.fs.readDirectory(N())).map(([u,p])=>u+(p===s.FileType.Directory?"/":"")).join(",")}catch(d){return"ERR:"+String(d).slice(0,90)}})(),readdirRoot:await(async()=>{try{let d=await a();return d?(await d.fs.readdir("/")).join(","):"no-container"}catch(d){return"err:"+String(d).slice(0,80)}})()})};let C=async()=>{s.workspace.workspaceFolders?.find(u=>u.uri.scheme==="nodine")||await le()},I=async()=>{let d=s.Uri.joinPath(N(),".vscode/settings.json");try{await s.workspace.fs.readFile(d);return}catch{}let u=JSON.stringify({"files.exclude":{bin:!0,home:!0,project:!0,root:!0,tmp:!0,usr:!0,".vscode":!0},"terminal.integrated.defaultProfile.linux":"Nodine (Node.js)","terminal.integrated.defaultProfile.osx":"Nodine (Node.js)","terminal.integrated.defaultProfile.windows":"Nodine (Node.js)"},null,2);await s.workspace.fs.writeFile(d,new TextEncoder().encode(u+`
`))},A=async d=>{await s.commands.executeCommand("revealInExplorer",N()),c.fireExternalChange(s.FileChangeType.Created,"/.nodine-sync"),s.commands.executeCommand("workbench.view.explorer")},X=async()=>{let d=await s.window.showInputBox({prompt:"GitHub repository \u2014 paste the URL or owner/repo",placeHolder:"https://github.com/owner/repo (add #branch for a specific branch)",ignoreFocusOut:!0});if(!d)return null;let u=await s.window.showInputBox({prompt:"GitHub PAT \u2014 optional for public repos, required for private repos",placeHolder:"github_pat_\u2026 or ghp_\u2026 (kept for this session only, empty for public)",password:!0,ignoreFocusOut:!0});return u===void 0?null:{repoInput:d,tokenInput:u}},D=async d=>{Pe(`/${d}`),await C(),await ee(i),await A(d)};l.then(async d=>{if(d)try{await C(),e(),await I();let u=s.workspace.getConfiguration("terminal.integrated");Promise.allSettled([u.update("defaultProfile.linux",void 0,s.ConfigurationTarget.Workspace),u.update("defaultProfile.osx",void 0,s.ConfigurationTarget.Workspace),u.update("defaultProfile.windows",void 0,s.ConfigurationTarget.Workspace)]).then(()=>{Promise.allSettled([u.update("defaultProfile.linux","Nodine (Node.js)",s.ConfigurationTarget.Global),u.update("defaultProfile.osx","Nodine (Node.js)",s.ConfigurationTarget.Global),u.update("defaultProfile.windows","Nodine (Node.js)",s.ConfigurationTarget.Global)])}),await ee(i);let p=new WeakMap;i.subscriptions.push(s.window.onDidOpenTerminal(w=>p.set(w,Date.now()))),i.subscriptions.push(s.window.onDidCloseTerminal(w=>{s.window.terminals.length>0||Date.now()-(p.get(w)??0)<3e3||setTimeout(()=>{s.window.terminals.length===0&&W(i)},500)}))}catch(u){console.error("[webide-dev] auto workspace/terminal failed:",u)}});let S=s.window.createStatusBarItem(s.StatusBarAlignment.Right,100);S.command="webide-dev.shareLan",S.text="$(radio-tower) Share on LAN",S.tooltip="Share a dev server running in this IDE on your local network (phone / second tab preview, WebRTC, nothing leaves your machine)",S.show(),i.subscriptions.push(S);let M=()=>{try{let d=rt().join(", ");S.text=d?`$(radio-tower) Share :${d} on LAN`:"$(radio-tower) Share on LAN"}catch{}},B=setInterval(M,2e3);i.subscriptions.push({dispose:()=>clearInterval(B)}),M(),i.subscriptions.push(s.commands.registerCommand("webide-dev.createTerminal",()=>{W(i)}),s.commands.registerCommand("webide-dev.createNodineTerminal",()=>W(i)),s.window.registerTerminalProfileProvider("webide-dev.nodine",new Q(o)),s.commands.registerCommand("webide-dev.importGithub",async()=>{let d=await X();if(!d)return;let u=await f();if(!u){s.window.showErrorMessage("Dev environment is not running (needs cross-origin isolated host with the nodine runtime).");return}await ge(d,u.writeFile,u.ensureDir,D)}),s.commands.registerCommand("webide-dev.uploadFolder",async()=>{await Ce(async(d,u)=>(await g()).writeFile(d,u),async d=>(await g()).ensureDir(d),D,async()=>{await g()})}),s.commands.registerCommand("webide-dev.runFile",async d=>{let u=d??s.window.activeTextEditor?.document.uri;if(!u||u.scheme!=="nodine"){s.window.showErrorMessage("Open a file from the nodine workspace to run it.");return}let p=P();if(!p)return;let w=u.path.replace(/^\/+/,""),b=s.window.createTerminal({name:`node ${w}`,pty:new ie(p,w)});i.subscriptions.push(b),b.show()}),s.commands.registerCommand("webide-dev.previewPort",async()=>{let d=P();if(!d)return;let u=await s.window.showInputBox({prompt:"Port number",placeHolder:"3000"}),p=Number(u);if(!Number.isFinite(p))return;let w=d.previewUrl(p);await s.env.openExternal(s.Uri.parse(w))}),s.commands.registerCommand("webide-dev.shareLan",()=>Se()))}
//# sourceMappingURL=extensionMain.js.map
