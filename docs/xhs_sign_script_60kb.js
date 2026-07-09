小红书 PC Web 签名算法 (X-s / X-t) 逆向分析报告
一、接口分析
签名 Header
X-s: 请求签名，格式 XYS_ + 自定义Base64编码
X-t: Unix毫秒时间戳（如 1783577855250）
适用接口
几乎所有小红书PC Web API都携带此签名，如：

https://edith.xiaohongshu.com/api/sns/web/*
https://edith.xiaohongshu.com/fe_api/*
二、签名生成完整流程
核心函数：seccore_signv2(url, body)
位置：webpack chunk 模块11436，函数定义在约17906行

完整算法（伪代码）：
function seccore_signv2(url, body):
    // Step 1: 构建签名数据
    u = url
    if body is Object or Array:
        u = url + JSON.stringify(body)
    elif body is string:
        u = url + body
    // 否则 u = url（无body或body为空）
    
    // Step 2: 计算MD5
    m = MD5(u)       // url+body的MD5
    w = MD5(url)     // 仅url的MD5
    
    // Step 3: 核心签名（Sanji虚拟机）
    C = window.mnsv2(u, m, w)
    // 返回格式: "mns0301_" + 自定义Base64(加密数据)
    // 约200字符，包含随机性（每次调用不同）
    
    // Step 4: 组装Payload
    P = {
        x0: "4.3.7",           // 指纹版本（R.i8，来自window.xhsFingerprintV3.VERSION fallback）
        x1: "xhs-pc-web",      // 平台标识（window.xsecappid）
        x2: window.xsecplatform || "PC",  // 设备类型
        x3: C,                 // mnsv2签名结果
        x4: typeof body        // body参数类型（"string"/"object"/"" 等）
    }
    
    // Step 5: 最终编码
    return "XYS_" + CustomBase64(UTF8Bytes(JSON.stringify(P)))
三、关键加密参数详解
3.1 MD5哈希 → webpack模块41439（导出名 K.Pu）
标准MD5实现，输入字符串，输出32位十六进制字符串。

3.2 UTF8编码 → webpack模块41439（导出名 K.lz）
function encodeUtf8(e) {
    var a = encodeURIComponent(e), s = [], u = 0;
    for (; u < a.length; u++) {
        var m = a.charAt(u);
        if ("%" === m) {
            var w = parseInt(a.charAt(u+1) + a.charAt(u+2), 16);
            s.push(w), u += 2;
        } else s.push(m.charCodeAt(0));
    }
    return s;  // 返回字节数组
}
3.3 🔑 自定义Base64 → webpack模块41439（导出名 K.xE）
自定义字母表（与标准Base64完全不同！）：

ZmserbBoHQtNP+wOcza/LpngG8yJq42KWYj0DSfdikx3VT16IlUAFM97hECvuRX5
字母表映射表（标准→自定义）： | 标准 | A | B | C | D | E | F | G | H | I | J | K | L | M | N | O | P | Q | R | S | T | U | V | W | X | Y | Z | |------|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---| | 自定义 | Z | m | s | e | r | b | B | o | H | Q | t | N | P | + | w | O | c | z | a | / | L | p | n | g | G | 8 |

| 标准 | a | b | c | d | e | f | g | h | i | j | k | l | m | n | o | p | q | r | s | t | u | v | w | x | y | z | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | + | / | |------|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---| | 自定义 | y | J | q | 4 | 2 | K | W | Y | j | 0 | D | S | f | d | i | k | x | 3 | V | T | 1 | 6 | I | l | U | A | F | M | 9 | 7 | h | E | C | v | u | R | X | 5 |

3.4 🔴 window.mnsv2 → Sanji虚拟机签名
来源：AS脚本 https://fe-static.xhscdn.com/as/v1/3e44/public/04b29480233f4def5c875875b6bdc3b1.js（约151KB）

函数签名：mnsv2(url_body_str, md5_url_body, md5_url)

特点：

返回格式："mns0301_" + 自定义Base64数据（恰好200字符）
包含随机性：相同输入每次返回不同值（内含计数器/时间戳/随机数）
依赖Sanji虚拟机（webpack模块60621，约360KB混淆代码）
当输入非真实MD5哈希时返回占位符 "mns0301_0"
执行耗时约13-16ms
Sanji虚拟机调用链：

window.mnsv2 → _0x31ad27(_0x30754b, ...) → Sanji解释器
四、关键常量和模块
| 模块ID | 导出名 | 值 | 说明 | |--------|--------|-----|------| | 59839 | R.i8 | "4.3.7" | 指纹版本号 | | 59839 | R.mj | "xsecplatform" | window属性名→设备类型 | | 59839 | R.ou | "xsecappid" | window属性名→appId | | 59839 | R.Ji | "xsecappvers" | window属性名→版本号 | | 59839 | R.mW | "dssts" | 安全时间戳 | | 41439 | K.Pu | MD5 | 标准MD5哈希 | | 41439 | K.lz | encodeUtf8 | UTF8字节编码 | | 41439 | K.xE | b64Encode | 自定义Base64编码 | | 41439 | K.kn | crc32 | CRC32校验 | | 11436 | seccore_signv2 | 签名主函数 | 组装完整X-s |

Window全局变量：
xsecappid    = "xhs-pc-web"
xsecappvers  = "6.30.0"
xsecplatform = "Windows"（或"Mac"/"Linux"等）
dssts        = "2"（动态值）
loadts       = "1783576041598"（页面加载时间戳）
五、验证结果
Replay验证
使用正确格式的签名重放请求，服务器返回：

{"code":-101,"success":false,"msg":"无登录信息，或登录信息为空","data":{}}
✅ 签名格式被接受，HTTP 200（业务错误-101是因为缺少登录Cookie，与签名无关）

mnsv2确定性验证
相同输入→不同输出（含随机性）
无效MD5输入→返回 "mns0301_0"
执行速度：约13-16ms
六、复用建议
由于 window.mnsv2 依赖约360KB的Sanji虚拟机混淆代码且包含随机性，无法在Node.js/Python中独立重现。推荐使用以下方案：

方案A：Headless浏览器（推荐）
// Puppeteer / Playwright
const page = await browser.newPage();
await page.goto('https://www.xiaohongshu.com/explore');

// 调用页内签名函数
const sign = await page.evaluate((url, body) => {
    // 手动实现 seccore_signv2
    const CUSTOM_B64 = "ZmserbBoHQtNP+wOcza/LpngG8yJq42KWYj0DSfdikx3VT16IlUAFM97hECvuRX5";
    const STD_B64   = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const encodeMap = {};
    for (let i = 0; i < 64; i++) encodeMap[STD_B64[i]] = CUSTOM_B64[i];
    
    // 构建u
    let u = url;
    const bodyType = typeof body;
    if (bodyType === 'object' && body !== null) {
        u += JSON.stringify(body);
    } else if (bodyType === 'string') {
        u += body;
    }
    
    // MD5
    function md5(str) { /* 引入MD5实现 */ }
    
    const m = md5(u);
    const w = md5(url);
    const C = window.mnsv2(u, m, w);
    
    const payload = JSON.stringify({
        x0: "4.3.7",
        x1: "xhs-pc-web",
        x2: window.xsecplatform || "PC",
        x3: C,
        x4: body ? (bodyType === 'object' && body !== null) ? "object" : 
             bodyType === 'string' ? "string" : typeof body : ""
    });
    
    // UTF8编码
    const utf8bytes = new TextEncoder().encode(payload);
    
    // 标准Base64编码后转自定义字母表
    const stdB64 = btoa(String.fromCharCode(...utf8bytes));
    const customB64 = stdB64.split('').map(c => encodeMap[c] || c).join('');
    
    return {
        'X-s': 'XYS_' + customB64,
        'X-t': String(Date.now())
    };
}, '/api/sns/web/v1/feed', {source_note_id:"xxx",num:20,cursor:""});

// 使用签名
const resp = await fetch('https://edith.xiaohongshu.com/api/sns/web/v1/feed', {
    headers: {
        ...sign,
        'Cookie': 'your_cookies',
        'User-Agent': '...'
    }
});
方案B：使用代理服务
部署一个本地代理服务，在浏览器中注入JS拦截器，自动为所有请求添加X-s/X-t签名。

方案C：直接注入（如Tampermonkey）
在页面中注入脚本，Hook XMLHttpRequest.prototype.send 和 fetch，自动调用 seccore_signv2 添加签名。

七、文件清单
| 文件 | ID | 大小 | 说明 | |------|-----|------|------| | AS主脚本1 | p95 | 151KB | Sanji虚拟机 + mnsv2注册 | | AS主脚本2 | p97 | 245KB | 另一个AS混淆脚本 | | AS dss脚本 | p98 | 60KB | getdss() 时间戳函数 | | webpack模块41439 | p104 | 7.6KB | MD5/Base64/UTF8/CRC32 | | webpack模块59839 | p99/p100 | - | 常量定义 | | webpack模块11436 | - | 58KB | seccore_signv2主函数 |

--- 引用数据 --- === p95 === "function L(h,b){var C=F();L=function(f,v){f=f-0x1aa;var t=C[f];return t;};return L(h,b);}(function(h,b){var C6={h:0x210,b:0x31f};var Fn=L;var C=h();while(!![]){try{var f=parseInt(Fn(0x314))/0x1+parseInt(Fn(0x23e))/0x2+parseInt(Fn(0x220))/0x3*(-parseInt(Fn(0x26e))/0x4)+-parseInt(Fn(0x319))/0x5*(parseInt(Fn(0x305))/0x6)+-parseInt(Fn(C6.h))/0x7+parseInt(Fn(0x2b0))/0x8*(parseInt(Fn(0x1c2))/0x9)+-parseInt(Fn(C6.b))/0xa*(-parseInt(Fn(0x2ce))/0xb);if(f===b){break;}else{C'push';}}catch(v){C'push';}}}(F,0xbce69));function F(){var RC=['JZLvj','oahov','gPDFl','DaRdU','eGCPD','pMsaX','vQQUk','SssvC','AMBCI','vSFPC','wSOnE','NIOdi','mXOEa','YAvpt','3956hsoIXl','UPxpr','hEIFf','oNTxv','PTNqV','qPPwK','oXgav','XEyPA','sRVor','FsXNX','oRxVE','GrgCd','ALpNt','kEqSg','VHkPt','GlBWa','yAZPc','yOvzN','AWvMp','kRdje','zCPbZ','fIDlR','QmRpf','lGvVL','kgeUA','NcKvK','MRQGa','reduce','zXemr','xCAJf','xnNmv','bHZSF','pop','nwOLN','iZTGz','mjdDi','lOrOp','aSIKX','GTnDt','Vdmrg','vpgNZ','sNnEf','nMMxv','ikzvH','GKtmp','JiTri','pCEKQ','CGaSJ','JSON','XWoOH','eqyFf','quyBc','hfEPg','ijFaB','Zfoeu','MrzJy','_sabo_95cb2','CScej','oBnDc','odVfd','XjCEE','kPfVf','SobNN','zzwfi','hXCqG','YqyTm','8XPIkOX','rpzig','vfuFM','qyZqB','WwqmJ','WqSKX','grXOT','TnYHa','HIswS','TByEj','DBWWn','eOFNg','WzxBd','WHsCZ','SEoiV','svkqH','lbZOY','bind','OMccf','4|1|2|0|5|9|6|3|8|7','epJNI','VLqYs','gSDNx','_sabo_5b836','_sabo_3088c','map','ZWORk','indexOf','hoXih','OChTg','5235241KFSZcx','aMltr','nDlQf','PHGCq','wWSUD','odYLt','tXtzn','PGxhU','uEfBT','AfBYF','sVuBy','fRDpO','JbvFu','KdPNG','DinAD','jYhqS','zQsUh','aiVyO','GnKMQ','Lkyuv','ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/','bOaOU','goMdg','aLwwx','prototype','AryJI','tRAuT','eXpUz','atDry','charCodeAt','JBdED','KAEds','qMPgm','tGZGI','xRcPH','zNAiV','wBccl','APjhA','vfvwF','buGvd','qehkP','sioDi','Uiemt','dOPfp','vsGkJ','WbHfy','Horkt','jXFeA','OIQJh','IvpwU','FdoKy','orFnF','ZvPja','zHUzN','CZeXt','722346TUWvEl','kweEL','PxhoI','RRNkR','ysQKL','YqfES','ibqQa','PUCdd','BWpPZ','hhbCq','fJlXY','OGgZX','fromCharCode','tRJfx','dBKVS','890714JAyMWZ','FrWRh','ptgek','nlBkp','nzYNo','45oABSvD','hxqUd','TwqJu','eMmdn','jHxlb','nHhGK','10BSxYuf','HRfcg','gUbAP','FGzOP','tItQY','jTwuf','CFtvf','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...[截断]

=== p97 === "function i(){var Wm=['iRtZg','VnhHV','jkknS','LPsJl','miLZj','EnYBk','IxjmH','_sabo_b5a26','jFKcT','fALiZ','ywvcD','pYebP','HVhmL','WmXKs','wyOGD','LnjBY','nLvLn','iBYZC','PwaWK','lkwoV','mPACD','SQPGp','HUDoP','kFToq','HrSBQ','DAnIC','LwDOM','eTmvv','indexOf','setTimeout','charCodeAt','vgNdB','yRnvC','VOkzy','AQEBw','WPNZa','xUiWt','charAt','aMCMy','split','yWBoX','WPaya','zaRyO','map','3508040eyhHxy','fMoAu','EQClf','Uedrm','VbaAS','Vqqwz','TKEee','CTTBf','3940698aNVmcs','hgfKm','FwBbT','10136835ozXxUW','GrKbv','xDjZf','nUiHg','hOgxl','GimjU','reduce','apply','jRIQY','WsRTQ','join','VtFAZ','WaqDR','push','OtBFd','zRwFd','Zlxgk','YUaEt','UOMyI','btWOj','AvPEM','CtDGk','haGXT','yYhVz','hasOwnProperty','agSrD','KBSOn','FZGzS','TZdJm','zRzHf','wSmGO','AZegk','bUiCT','_sabo_7c43','KsczN','qZUMn','prototype','GsXMi','axuxA','TGfDy','pop','PULef','lmNBM','ooUfS','Promise','GNCsd','bQTzM','CWeOZ','OINPC','gyWBg','SEsDW','hOCES','fdGJi','PbImY','jymKJ','taHho','ECEAe','ScwJF','gWIMc','HRHRD','5036361HZMRvJ','sBHTG','performance','KBbmk','CMytr','fromCharCode','rkXnk','bojJL','Hseqs','JSilk','RGKsR','YzDJe','ThGSA','ZAluK','SUQXy','chdkz','endTime1','DjpwY','alert','RmiMF','weh','FLldE','OsTSB','NcubW','eNMBC','PbDXg','yipxq','rFDqT','DjyPP','ztiJr','sFUvX','osTPf','vDevA','bind','Waqeo','CSnLB','isNaN','console','jVvAD','NrtfC','dbvII','CbDAI','JOPxk','geJck','LupTo','CQHTt','nFoxs','YmDwZ','OmXoN','rfnIE','beEZB','InFKZ','KqTYl','bVAyq','splice','30RHjpao','UVdyz','QrsYg','zWJRr','VlTOc','vUUXQ','bhbeF','CDJbA','sNVuu','osQzv','JAFxy','xpHLX','GbYTq','htZGw','rtaCa','IiUkf','HYHjz','9282312LEjcev','_sabo_93a3','_sabo_e14e7','yWcXg','lcPoc','Vdlyn','goQof','acpBn','rynQI','IOSEN','BADJn','TcvuD','_sabo_d3dbc','YdgGt','vivCy','ZAkum','WeKqa','KKnxn','kVsNt','ETmto','XfrHy','TRPOu','sXhRB','length','JsoBV','EtsrW','EUFIm','gURiC','rhZzE','CdTXq','mmXib','URgFm','qjvFD','yQOcz','qvVwt','116562Oneieo','sOvZP','bMYdi','gBEFo','ZhNfe','NvOZZ','slice','4|1|5|0|3|2','EXNrL','KYhTp','PrKhL','rOlEG','hjlMS','REXdt','bjUSQ','HVuAZ','PzHEe','RqhOa','dYNPM','FGxSS','MjcPA','kBZZW','oNMYg','gDPLQ','tEUzA','BJXWn','yYxCI','OBIsQ','pTAsw','gunUT','OfqND','undefined','BQgpV','cqeNd','tzqQg','xrGBF','EqQyR','WRpJW','RQMYW','NhSWv','VRgNA','SmoeH','BBTBk','_sabo_7667','eYCpC','wjmfh','FJbsu','PNyoy','doYBL','Ccpqg','GArVx','Hkrzo','LGDto','zHaxL','eBtuo','fshyD','QjIzg','HJVqu','vEqLG','TnUXt','process','RKrgN','AcZfo','fexOI','Kggcf','ouTQJ','RjsxZ','klpjo','yILUB','_sabo_c40ee','iXgDA','HHVJm','fFIxa','PMQuo','LepFi','rLDQX','zNzaH','cMfnX','UDKwm','NgtFg','DIcVq','HnFUf','sktqj','iRyzJ','KKSpo','bvxfc','jdrAP','startTime2','sjXPS','MUoIq','vWQoC','SlbFB','aQRjV','DvhIj','bcFxS','IRctX','TLiOP','uYfJn','yLuDg','PjiZU','eQsQe','XVxlc','xJnLW','ipqie','Dcuat','wbpSs','pmcED','GSWvO','Piilb','OLCXV','oDuvl','lTJuY','kaLqM','8|4|1|0|2|3|9|5|6|7','aSZeB','9wDQpRv','DcWSz','LoDIt','QoAlw','gglih','vJnKJ','requestAnimationFrame','RibPZ','PmNPq','self','qRZWi','ACTWj','proPT','cFjsK','QRyjE','dnnlj','27VmbvJN','dbYzi','wZqVE','TCkbw','startTime1','noryA','693372HhZNVV','gkTLk','fzSrK','PqPlU','_sabo_c7988','UivEO','Pygso','AcTZP','wyuVh','7VzZfdZ','PpVvv','zQZem','LsAid'];i=function(){return Wm;};return i();}function A(c,n){var U=i();A=function(b,g){b=b-0x1cc;var q=U[b];return q;};return A(c,n);}(function(c,n){var nw={c:0x25c,n:0x1f1};var ie=A;var U=c();while(!![]){try{var b=-parseInt(ie(0x2cf))/0x1*(-parseInt(ie(nw.c))/0x2)+-parseInt(ie(0x2df))/0x3*(-parseInt(ie(0x2e5))/0x4)+parseInt(ie(0x31e))/0x5+parseInt(ie(0x326))/0x6*(-parseInt(ie(0x2ee))/0x7)+parseInt(ie(0x239))/0x8+-parseInt(ie(0x329))/0x9+parseInt(ie(0x228))/0xa*(-parseInt(ie(nw.n))/0xb);if(b===n){break;}else{U'push';}}catch(g){U'push';}}}(i,0xc0d66));(function(){var WD={c:0x27f,n:0x1eb,U:0x301,b:0x1f4,g:0x264,q:0x1ec,R:0x263,W:0x21f,D:0x27b,m:0x298,I:0x1f3,E:0x30f,j:0x2db,l:0x320,x:0x1ef,y:0x2a6,t:0x21e,V:0x1e9,Q:0x2ca,X:0x1e4,O:0x2b3};var WW={c:0x2dd,n:0x21a,U:0x2da,b:0x1e6,g:0x2b6,q:0x286,R:0x226,W:0x32e};var WR={c:0x213,n:0x2ab,U:0x2fd,b:0x316,g:0x33c,q:0x209,R:0x1db};var g5={c:0x2a4};var g0={c:0x22e};var bx={c:0x1fc};var bg={c:0x2a4};var Ur={c:0x229};var is=A;var c={'GrKbv':function(U,b,g){return U(b,g);},'DjyPP':'hRSmj','QRyjE':is(WD.c),'CbDAI':is(0x28d),'bhbeF':function(U,b,g){return U(b,g);},'pfVmZ':is(WD.n),'OwwVc':is(0x2b5),'JkvtA':is(WD.U),'sktqj':function(U,b,g,q,R){return U(b,g,q,R);},'jMGFr':is(0x28a),'YGZiv':function(U,b){return U(b);},'eBtuo':function(U,b){return U===b;},'ACTWj':is(0x303),'XxSBq':function(U,b){return U(b);},'mPACD':function(U,b,g,q,R){return U(b,g,q,R);},'beEZB':function(U,b){return U!==b;},'UivEO':is(WD.b),'TZdJm':is(0x309),'UVdyz':function(U,b){return U==b;},'Kggcf':function(U,b){return U<b;},'AQEBw':function(U,b,g,q,R,W,D,m){return U(b,g,q,R,W,D,m);},'KKSpo':function(U,b){return U-b;},'lTJuY':function(U,b){return U!=b;},'dnnlj':'tEUzA','bojJL':function(U,b){return U<<b;},'kBZZW':is(0x1fd),'AvPEM':function(U,b){r...[截断]

=== p98 === "function getdss() { return '1782379992150'; };\n\n\n\n\n\n\nvar _0x341b=['KiPMi','KYOYJ','svzrL','proto','plHoS','UirlK','IΙΙ','MAyQD','bind','zIGrU','wTuGj','tQwMy','dUvxg','WqSCh','aXYbU','aIQKs','apply','iOiXN','tFvfX','IΙI','eXlMM','setPrototypeOf','KbRfp','2869054COIcFt','XoaJp','mqyXD','AXkMd','dIdJF','XlZRv','fAeaR','bHvwZ','Invalid\x20attempt\x20to\x20spread\x20non-iterable\x20instance','DXZKe','rgFDo','_BHjFmfUMEtxhI','KPLCP','yEAPv','PdIZI','AwEzy','dZaEW','xJHdx','294533hdASDc','zrQSt','call','cJrwQ','MDvWl','OTZka','Bleng','push','jWQXv','sIMvk','1vTWnSs','WxAuS','sviut','HNQkb','cTBAW','oBcBw','XdTry','kzApx','PRwfO','loVEd','AtNza','nSGde','ΙII','BTTtl','atVyM','TzzAb','IvKhR','hTIwL','79911NVrkuN','jyqld','BBDch','isArray','LNVYP','aCSui','CBSFl','uVyAn','gupAu','ofhwr','fMfaC','ICGTz','pvqDD','uPGcu','LlDCn','slYgQ','932536dXUvUS','RxzgE','__bc','cMdEZ','CqOfp','LSDRe','MtyaU','eVPjZ','ZZNlu','kquzW','undefined','hKIgv','keys','ommCb','ylKBf','hiQXs','pvpCQ','uUlAP','873536DjYRMR','abQbd','1076712GOYPEM','nHyri','hngMp','tVDgk','pSREd','weyvc','fPUfS','3|5|0|4|1|2','fSfrD','OnyPT','zuJjJ','ajGpD','err-209e10:\x20+\x20','ayOqy','GThbn','MUCjn','MrTDA','paGTj','VTKBBQFM','bTyoe','err:d93135:','KdWmZ','fromCharCode','XLvWZ','CUTnP','toString','slice','construct','LGFLa','UYPHZ','34387YtEtXF','zinis','cxrrV','MSuvz','KzcqC','zTTUP','URXWH','prototype','ApSrn','HvpCN','nYhRA','CyKDv','xIVze','FqPQn','NmoLf','from','IIΙ','rnTPg','kPxvY','1IFHsMj','PXCGU','uNrco','cYmRx','29KuFTNg','VZKCL','KyIdf','ΙIΙ','QGNbn','RCdRI','1uhbJdU','XPgam','dLuvX','sxqRa','bJUso','wcuqI','MAppL','vdkHm','tIwIM','uTAMz','length','URMgD','QeRPY','EZsnz','ImHDp','lvXja','pcEyU','vUaLA','[object\x20Arguments]','function','XPOoS','QDacf','hmLJb','tKFOd','mJRqp','hhvHC','GSrQM','VbBue','nEhmX','jmbqG'];var _0x1769=function(_0x1e6d9f,_0x341be1){_0x1e6d9f=_0x1e6d9f-0x0;var _0x1769e7=_0x341b[_0x1e6d9f];return _0x1769e7;};var _0x12372b=_0x1769;(function(_0x231545,_0x13bcf8){var _0x799b3c=_0x1769;while(!![]){try{var _0x510799=parseInt(_0x799b3c(0x4b))-parseInt(_0x799b3c(0xbc))+parseInt(_0x799b3c(0x77))-parseInt(_0x799b3c(0x55))+-parseInt(_0x799b3c(0x8b))+parseInt(_0x799b3c(0xc0))parseInt(_0x799b3c(0xa9))+-parseInt(_0x799b3c(0x4))-parseInt(_0x799b3c(0x67))+-parseInt(_0x799b3c(0x89))+parseInt(_0x799b3c(0x39));if(_0x510799===_0x13bcf8)break;else _0x231545'push';}catch(_0x2fa719){_0x231545'push';}}}(_0x341b,0xbbb67));var glb=_0x12372b(0x81)==typeof window?global:window;glb[_0x12372b(0x44)]=function(_0x3c396a,_0xe5cc21,_0x4ab9d0){var _0x258f3a=_0x12372b,_0x4e2823={'vdkHm':function(_0x2410f6,_0x25cc7f){return _0x2410f6==_0x25cc7f;},'gupAu':_0x258f3a(0x81),'LNVYP':function(_0x2930b1,_0x578a67){return _0x2930b1==_0x578a67;},'XoaJp':function(_0x5ab939,_0x5e6dc8){return _0x5ab939===_0x5e6dc8;},'loVEd':function(_0x1d4a99,_0x49f070){return _0x1d4a99!==_0x49f070;},'XPOoS':function(_0x348971,_0x30fde9){return _0x348971+_0x30fde9;},'hngMp':'xJHdx','eVPjZ':function(_0x1b483f,_0x4fd6f7){return _0x1b483f<_0x4fd6f7;},'jnKcJ':function(_0x121e9c,_0x57b19c,_0x1689d3){return _0x121e9c(_0x57b19c,_0x1689d3);},'tQwMy':function(_0x5c3827,_0xa9b78e){return _0x5c3827 in _0xa9b78e;},'nEhmX':_0x258f3a(0x8e),'MUCjn':function(_0x42da91,_0x52d5d9){return _0x42da91==_0x52d5d9;},'SQFLz':function(_0x31df30,_0x2854ed){return _0x31df30>>_0x2854ed;},'sviut':function(_0x118cd8,_0x592681){return _0x118cd8==_0x592681;},'plHoS':function(_0x28d9af,_0xff7780){return _0x28d9af>>_0xff7780;},'KzcqC':'SmWJq','uTAMz':function(_0x1eabce,_0x1de19e,_0x2cccaf){return _0x1eabce(_0x1de19e,_0x2cccaf);},'MSuvz':function(_0x32d56a,_0x4454b7){return _0x32d56a+_0x4454b7;},'URMgD':function(_0x10c1fa,_0x1e2427){return _0x10c1fa>_0x1e2427;},'XlZRv':function(_0x5ed27d,_0x2c3cd0){return _0x5ed27d-_0x2c3cd0;},'zuJjJ':function(_0x1152ce,_0x274b55){return _0x1152ce+_0x274b55;},'cATvH':_0x258f3a(0x43),'oCTAM':function(_0x91214e,_0x117a12){return _0x91214e+_0x117a12;},'bHvwZ':function(_0x6a2185,_0x3f16e7){return _0x6a2185+_0x3f16e7;},'OnyPT':function(_0x133c12,_0x260394){return _0x133c12+_0x260394;},'PdIZI':function(_0x42e665,_0x1c2d45){return _0x42e665+_0x1c2d45;},'rnTPg':function(_0x58dc59,_0x581cfb){return _0x58dc59+_0x581cfb;},'zTTUP':function(_0x116a4b,_0x2a78c2){return _0x116a4b+_0x2a78c2;},'ooLna':function(_0x3fb211,_0x216c8e){return _0x3fb211!==_0x216c8e;},'aXYbU':'uUlAP','GGreg':function(_0x608310,_0x4c9073){return _0x608310+_0x4c9073;},'dUvxg':function(_0x794f18,_0x5829e5){return _0x794f18+_0x5829e5;},'eMwlD':function(_0x3126b0,_0x107f74){return _0x3126b0+_0x107f74;},'atVyM':function(_0x1bf5c4,_0x59761e){return _0x1bf5c4+_0x59761e;},'XPgam':function(_0x448ae1,_0x136025){return _0x448ae1+_0x136025;},'mlOXl':function(_0x1fbd7c,_0xfbe0b9,_0x186fbd){return _0x1fbd7c(_0xfbe0b9,_0x186fbd);},'cxrrV':function(_0x4b086c,_0x5ba2c2){return _0x4b086c+_0x5ba2c2;},'nSGde':function(_0x7e6ff6,_0x15c60c){return _0x7e6ff6==_0x15c60c;},'fPUfS':...[截断]

=== p99 === {"preview":"function(e,a,s){"use strict";s.d(a,{$Z:function(){return eo},DY:function(){return et},Fx:function(){return R},Go:function(){return Z},Hz:function(){return eD},Ji:function(){return ef},LI:function(){return ew},LN:function(){return eL},MS:function(){return eu},N4:function(){return eS},N8:function(){return eE},PP:function(){return eg},Ql:function(){return em},Qo:function(){return eN},RH:function(){return j},Rp:function(){return ep},TG:function(){return e_},UG:function(){return eO},V_:function(){return G},WF:function(){return eT},WT:function(){return eC},XP:function(){return ea},YF:function(){return C},br:function(){return es},eQ:function(){return w},fG:function(){return ex},fI:function(){return P},gv:function(){return eb},hJ:function(){return eI},i8:function(){return eB},lJ:function(){return eM},lr:function(){return ev},ls:function(){return ek},mW:function(){return ed},mj:function(){return ec},o4:function(){return q},o8:function(){return eh},ou:function(){return er},p4:function(){return en},q2:function(){return K},qk:function(){return eP},qq:function(){return el},sU:function(){return M},tP:function(){return ei},vJ:function(){return ey},xC:function(){return m},yl:function(){return eR},z7:function(){return U}}),s(42876),s(33933);var u=s(21403),m=461,w=462,C=465,R=471,P="1",M="0",U="b1b1",q="a1",j="webId",G="gid",K="b1",Z="p1",et="sc",en="websectiga",ea="sec_poison_id",er="xsecappid",ef="xsecappvers",ec="xsecplatform",ei="loadts",eo="src_loaded",ed="dssts",es="dsllt",eu=0,el=1,eb=2,e_=3,ep=1e3,ex=1001,ev=1002,eh=["/t.xiaohongshu.com","/c.xiaohongshu.com","spltest.xiaohongshu.com","t2.xiaohongshu.com","t2-test.xiaohongshu.com","lng.xiaohongshu.com","apm-track.xiaohongshu.com","apm-track-test.xiaohongshu.com","apm-fe.xiaohongshu.com","fse.xiaohongshu.com","fse.devops.xiaohongshu.com","fesentry.xiaohongshu.com","spider-tracker.xiaohongshu.com"],eg=["/privacy","/privacy/teenager"],em="/api/sec/v1/scripting",ey="/api/sec/v1/sbtsource",ew="/api/redcaptcha/v2/getconfig",eE="scriptingEval",eS="sdt_source_storage_key",eT="sdt_source_init",ek="last_tiga_update_time",eC="sign_lack_info",eR=["fe_api/burdock/v2/user/keyInfo","fe_api/burdock/v2/shield/profile","fe_api/burdock/v2/shield/captcha","fe_api/burdock/v2/shield/registerCanvas","api/sec/v1/shield/webprofile","api/sec/v1/shield/captcha",/fe_api\/burdock\/v2\/note\/[0-9a-zA-Z]+\/tags/,/fe_api\/burdock\/v2\/note\/[0-9a-zA-Z]+\/image_stickers/,/fe_api\/burdock\/v2\/note\/[0-9a-zA-Z]+\/other\/notes/,/fe_api\/burdock\/v2\/note\/[0-9a-zA-Z]+\/related/,"/fe_api/burdock/v2/note/post","/api/sns/web","/api/redcaptcha","/api/store/jpd/main"],eP={300011:"检测到帐号异常，请稍后重试",300012:"网络连接异常，请检查网络设置后重试",300013:"访问频次异常，请勿频繁操作",300015:"浏览器异常，请尝试更换浏览器后重试"},eA=!u.ZP.isBrowser,eI="infra_sec_web_api_walify",eO="infra_sec_verify_walify",eN="infra_sec_spam_walify",eL=[],eM="cn"!==function getRegion(){var e="cn";return e?e:!eA&&(null==window?void 0:window.location.host.includes("rednote.com"))?"sg":"cn"}(),eD=eM?"rednote.com":"xiaohongsh","length":3018}

=== p100 === {"eB":"eB="4.3.7"}","vars":"var u=s(21403),m=461,w=462,C=465,R=471,P="1",M="0",U="b1b1",q="a1",j="webId",G="gid",K="b1",Z="p1",et="sc",en="websectiga",ea="sec_poison_id",er="xsecappid",ef="xsecappvers",ec="xsecplatform",ei="loadts",eo="src_loaded",ed="dssts",es="dsllt",eu=0,el=1,eb=2,e_=3,ep=1e3,ex=1001,ev=1002,eh=["/t.xiaohongshu.com","/c.xiaohongshu.com","spltest.xiaohongshu.com","t2.xiaohongshu.com","t2-test.xiaohongshu.com","lng.xiaohongshu.com","apm-track.xiaohongshu.com","apm-track-test.xiaohongshu.com","apm-fe.xiaohongshu.com","fse.xiaohongshu.com","fse.devops.xiaohongshu.com","fesentry.xiaohongshu.com","spider-tracker.xiaohongshu.com"],eg=["/privacy","/privacy/teenager"],em="/api/sec/v1/scripting",ey="/api/sec/v1/sbtsource",ew="/api/redcaptcha/v2/getconfig",eE="scriptingEval",eS="sdt_source_storage_key",eT="sdt_source_init",ek="last_tiga_update_time",eC="sign_lack_info",eR=["fe_api/burdock/v2/user/keyInfo","fe_api/burdock/v2/shield/profile","fe_api/burdock/v2/shield/captcha","fe_api/burdock/v2/shield/registerCanvas","api/sec/v1/shield/webprofile","api/sec/v1/shield/captcha",/fe_api\/burdock\/v2\/note\/[0-9a-zA-Z]+\/tags/,/fe_api\/burdock\/v2\/note\/[0-9a-zA-Z]+\/image_stickers/,/fe_api\/burdock\/v2\/note\/[0-9a-zA-Z]+\/other\/notes/,/fe_api\/burdock\/v2\/note\/[0-9a-zA-Z]+\/related/,"/fe_api/burdock/v2/note/post","/api/sns/web","/api/redcaptcha","/api/store/jpd/main"],eP={300011:"检测到帐号异常，请稍后重试",300012:"网络连接异常，请检查网络设置后重试",300013:"访问频次异常，请勿频繁操作",300015:"浏览器异常，请尝试更换浏览器后重试"},eA=!u.ZP.isBrowser,eI="i"}

=== p104 === {"length":7658,"preview":"function(e,a,s){"use strict";s.d(a,{Pu:function(){return P},kn:function(){return crc32},lz:function(){return encodeUtf8},tb:function(){return R},xE:function(){return b64Encode}}),s(86651),s(43648),s(34333),s(55947),s(41593),s(9557),s(72169),s(58486),s(34885),s(7608);for(var u=[],m="ZmserbBoHQtNP+wOcza/LpngG8yJq42KWYj0DSfdikx3VT16IlUAFM97hECvuRX5",w=0,C=m.length;w<C;++w)u[w]=m[w];var crc32=function crc32(e){for(var a,s=[],u=0;u<256;u++){a=u;for(var m=0;m<8;m++)a=1&a?0xedb88320^a>>>1:a>>>1;s[u]=a}for(var w=-1,C=0;C<e.length;C++)w=w>>>8^s[255&(w^e.charCodeAt(C))];return(-1^w)>>>0};function tripletToBase64(e){return u[e>>18&63]+u[e>>12&63]+u[e>>6&63]+u[63&e]}function encodeChunk(e,a,s){for(var u,m=[],w=a;w<s;w+=3)u=(e[w]<<16&0xff0000)+(e[w+1]<<8&65280)+(255&e[w+2]),m.push(tripletToBase64(u));return m.join("")}function encodeUtf8(e){for(var a=encodeURIComponent(e),s=[],u=0;u<a.length;u++){var m=a.charAt(u);if("%"===m){var w=parseInt(a.charAt(u+1)+a.charAt(u+2),16);s.push(w),u+=2}else s.push(m.charCodeAt(0))}return s}function b64Encode(e){for(var a,s=e.length,m=s%3,w=[],C=16383,R=0,P=s-m;R<P;R+=C)w.push(encodeChunk(e,R,R+C>P?P:R+C));return 1===m?(a=e[s-1],w.push(u[a>>2]+u[a<<4&63]+"==")):2===m&&(a=(e[s-2]<<8)+e[s-1],w.push(u[a>>10]+u[a>>4&63]+u[a<<2&63]+"=")),w.join("")}var R=function(e){for(var a=0xedb88320,s,u,m=256,w=[];m--;w[m]=s>>>0)for(u=8,s=m;u--;)s=1&s?s>>>1^a:s>>>1;return function(e){if("string"==typeof e){for(var s=0,u=-1;s<e.length;++s)u=w[255&u^e.charCodeAt(s)]^u>>>8;return -1^u^a}for(var s=0,u=-1;s<e.length;++s)u=w[255&u^e[s]]^u>>>8;return -1^u^a}}(),P=function(e){function n(s){if(a[s])return a[s].exports;var u=a[s]={i:s,l:!1,exports:{}};return e[s].call(u.exports,u,u.exports,n),u.l=!0,u.exports}var a={};return n.m=e,n.c=a,n.i=function(e){return e},n.d=function(e,a,s){n.o(e,a)||Object.defineProperty(e,a,{configurable:!1,enumerable:!0,get:s})},n.n=function(e){var a=e&&e.__esModule?function t(){return e.default}:function(){return e};return n.d(a,"a",a),a},n.o=f","Pu_fn":"Pu:function(){return P},kn:function(){return crc32},lz:function(){return encodeUtf8},tb:function(){return R},xE:function(){return b64Encode}}),s(86651),s(43648),s(34333),s(55947),s(41593),s(9557),s(72","xE_fn":"xE:function(){return b64Encode}}),s(86651),s(43648),s(34333),s(55947),s(41593),s(9557),s(72169),s(58486),s(34885),s(7608);for(var u=[],m="ZmserbBoHQtNP+wOcza/LpngG8yJq42KWYj0DSfdikx3VT16IlUAFM97hECvuR","lz_fn":"lz:function(){return encodeUtf8},tb:function(){return R},xE:function(){return b64Encode}}),s(86651),s(43648),s(34333),s(55947),s(41593),s(9557),s(72169),s(58486),s(34885),s(7608);for(var u=[],m="Zmser","hasBase64":true}