/**
 * BULK COMUNITÁRIO — BACKEND V2
 * Substitui o Code.gs atual. Execute setup() uma vez.
 * Configure a senha executando configureAdminPassword() no editor.
 * Implantar como Web App: executar como proprietário; acesso conforme necessário.
 */
const CONFIG={SPREADSHEET_PROPERTY:"BULK_SPREADSHEET_ID",TIMEZONE:"America/Cuiaba",WEEKLY_LIMIT:7,
 HEADERS:["Protocolo","Data e hora","Nome","Telefone","Total retirado","Total deixado","Status","Atualizado em","Observação"],
 DETAIL_HEADERS:["Protocolo","Operação","Carta ID","Nome da carta","Coleção","Número","Quantidade"],
 STOCK_HEADERS:["Carta ID","Nome","Coleção","Número","Quantidade","Última atualização"],
 ADMIN_HASH:"BULK_ADMIN_PASSWORD_SHA256"};

function setup(){
 const props=PropertiesService.getScriptProperties();
 let id=props.getProperty(CONFIG.SPREADSHEET_PROPERTY), ss=id?SpreadsheetApp.openById(id):SpreadsheetApp.create("Bulk Comunitário - Ri Happy Tangará");
 ensureSheet_(ss,"Movimentações",CONFIG.HEADERS);
 ensureSheet_(ss,"Detalhes",CONFIG.DETAIL_HEADERS);
 ensureSheet_(ss,"Estoque",CONFIG.STOCK_HEADERS);
 props.setProperty(CONFIG.SPREADSHEET_PROPERTY,ss.getId());
 Logger.log("Planilha: "+ss.getUrl()); return ss.getUrl();
}
function ensureSheet_(ss,name,headers){
 let sh=ss.getSheetByName(name)||ss.insertSheet(name);
 if(sh.getLastRow()===0){sh.appendRow(headers);sh.setFrozenRows(1);sh.getRange(1,1,1,headers.length).setFontWeight("bold").setBackground("#0878c9").setFontColor("#fff");}
}
function configureAdminPassword(){
 // No editor do Apps Script, substitua temporariamente a senha abaixo,
 // execute esta função uma vez e depois apague a senha literal do código.
 const password="TROQUE_POR_UMA_SENHA_FORTE_DE_12_OU_MAIS_CARACTERES";
 if(password.indexOf("TROQUE_POR_")===0||password.length<12)throw new Error("Edite a senha dentro de configureAdminPassword() antes de executar.");
 PropertiesService.getScriptProperties().setProperty(CONFIG.ADMIN_HASH,sha256_(password));
 Logger.log("Senha administrativa configurada. Remova a senha literal do código e salve.");
}
function doPost(e){
 let p={};try{p=JSON.parse((e&&e.parameter&&e.parameter.payload)||"{}");let r;
 switch(p.action||"register"){case"register":r=registerMovement_(p);break;case"login":r=adminLogin_(p);break;case"list":r=adminList_(p);break;case"approve":r=adminApprove_(p);break;case"reject":r=adminReject_(p);break;default:throw new Error("Ação inválida.");}
 return responseHtml_(Object.assign({requestId:p.requestId||""},r));
 }catch(err){return responseHtml_({ok:false,requestId:p.requestId||"",message:err.message||"Erro inesperado."});}
}
function registerMovement_(p){
 if(p.website)throw new Error("Envio não permitido.");
 const requestId=String(p.requestId||"").slice(0,80),name=String(p.name||"").trim().replace(/\s+/g," ").slice(0,100),phone=String(p.phone||"").replace(/\D/g,"").slice(0,13);
 const withdrawals=normalizeCards_(p.withdrawals),deposits=normalizeCards_(p.deposits),out=withdrawals.reduce((s,c)=>s+c.quantity,0),inn=deposits.reduce((s,c)=>s+c.quantity,0);
 if(!requestId||name.length<3||phone.length<10||!p.declaration||(!out&&!inn)||out>7)throw new Error("Confira os dados, a declaração e o limite de 7 cartas retiradas.");
 const lock=LockService.getScriptLock();lock.waitLock(20000);
 try{
  const ss=getSpreadsheet_(),sh=ss.getSheetByName("Movimentações"),det=ss.getSheetByName("Detalhes");
  const last=sh.getLastRow();if(last>1){const found=sh.getRange(2,1,last-1,1).getDisplayValues().flat().find(x=>x===requestId);if(found)return{ok:true,requestId,protocol:found,duplicate:true,status:"Pendente"};}
  const now=new Date(),used=getWithdrawalsThisWeek_(sh,phone,now);
  if(used+out>7)throw new Error("Limite semanal atingido. Já retirou "+used+" carta(s); saldo: "+Math.max(0,7-used)+".");
  const protocol="BULK-"+Utilities.formatDate(now,CONFIG.TIMEZONE,"yyMMdd-HHmmss")+"-"+Utilities.getUuid().slice(0,4).toUpperCase();
  sh.appendRow([protocol,now,name,phone,out,inn,"Pendente",now,""]);
  const rows=[];withdrawals.forEach(c=>rows.push([protocol,"Retirada",c.id,c.name,c.setName,c.localId,c.quantity]));deposits.forEach(c=>rows.push([protocol,"Entrada",c.id,c.name,c.setName,c.localId,c.quantity]));
  if(rows.length)det.getRange(det.getLastRow()+1,1,rows.length,7).setValues(rows);
  return{ok:true,requestId,protocol,status:"Pendente"};
 }finally{lock.releaseLock();}
}
function normalizeCards_(cards){
 if(!Array.isArray(cards))return[];if(cards.length>100)throw new Error("Itens demais.");
 return cards.map(c=>{const q=Math.floor(Number(c.quantity)),id=String(c.id||"").slice(0,80),name=String(c.name||"").trim().slice(0,100);if(!id||!name||!Number.isFinite(q)||q<1||q>99)throw new Error("Carta inválida.");return{id,name,localId:String(c.localId||"").slice(0,30),setName:String(c.setName||"").slice(0,100),quantity:q};});
}
function adminLogin_(p){
 const hash=PropertiesService.getScriptProperties().getProperty(CONFIG.ADMIN_HASH);if(!hash)throw new Error("Senha administrativa ainda não configurada.");
 if(sha256_(String(p.password||""))!==hash)throw new Error("Senha incorreta.");
 const token=Utilities.getUuid()+Utilities.getUuid();CacheService.getScriptCache().put("bulk_admin_"+token,"1",21600);
 return{ok:true,token,expiresIn:21600};
}
function requireAdmin_(token){if(!token||CacheService.getScriptCache().get("bulk_admin_"+token)!=="1")throw new Error("Sessão expirada. Entre novamente.");}
function adminList_(p){
 requireAdmin_(p.token);const ss=getSpreadsheet_(),m=ss.getSheetByName("Movimentações"),d=ss.getSheetByName("Detalhes"),s=ss.getSheetByName("Estoque");
 const mv=m.getLastRow()>1?m.getRange(2,1,m.getLastRow()-1,9).getValues():[];
 const det=d.getLastRow()>1?d.getRange(2,1,d.getLastRow()-1,7).getValues():[];
 const stock=s.getLastRow()>1?s.getRange(2,1,s.getLastRow()-1,6).getValues():[];
 return{ok:true,movements:mv.map(r=>({protocol:r[0],date:r[1] instanceof Date?r[1].toISOString():String(r[1]),name:r[2],phone:r[3],withdrawals:r[4],deposits:r[5],status:r[6],note:r[8],cards:det.filter(x=>x[0]===r[0]).map(x=>({operation:x[1],id:x[2],name:x[3],setName:x[4],localId:x[5],quantity:x[6]}))})).reverse(),stock:stock.map(r=>({id:r[0],name:r[1],setName:r[2],localId:r[3],quantity:Number(r[4])||0}))};
}
function adminApprove_(p){
 requireAdmin_(p.token);const lock=LockService.getScriptLock();lock.waitLock(20000);
 try{
  const ss=getSpreadsheet_(),m=ss.getSheetByName("Movimentações"),d=ss.getSheetByName("Detalhes"),s=ss.getSheetByName("Estoque"),last=m.getLastRow();
  const vals=m.getRange(2,1,Math.max(0,last-1),9).getValues(),idx=vals.findIndex(r=>r[0]===p.protocol);if(idx<0)throw new Error("Protocolo não encontrado.");
  const row=idx+2;if(vals[idx][6]!=="Pendente")throw new Error("Esta solicitação já foi processada.");
  const det=d.getLastRow()>1?d.getRange(2,1,d.getLastRow()-1,7).getValues().filter(r=>r[0]===p.protocol):[];
  const stockRows=s.getLastRow()>1?s.getRange(2,1,s.getLastRow()-1,6).getValues():[];
  const map=new Map();stockRows.forEach((r,i)=>map.set(String(r[0]),{row:i+2,qty:Number(r[4])||0}));
  const withdrawals=det.filter(r=>r[1]==="Retirada"),deposits=det.filter(r=>r[1]==="Entrada");
  withdrawals.forEach(r=>{const item=map.get(String(r[2]));if(!item||item.qty<Number(r[6]))throw new Error("Estoque insuficiente para "+r[3]+" ("+r[4]+" · "+r[5]+"). Disponível: "+(item?item.qty:0)+".");});
  const now=new Date();
  withdrawals.forEach(r=>{const item=map.get(String(r[2]));s.getRange(item.row,5).setValue(item.qty-Number(r[6]));s.getRange(item.row,6).setValue(now);});
  deposits.forEach(r=>{const id=String(r[2]),item=map.get(id);if(item){s.getRange(item.row,5).setValue(item.qty+Number(r[6]));s.getRange(item.row,6).setValue(now);}else{s.appendRow([id,r[3],r[4],r[5],Number(r[6]),now]);}});
  m.getRange(row,7,1,3).setValues([["Aprovada",now,"Troca realizada e conferida"]]);
  return{ok:true,protocol:p.protocol,status:"Aprovada"};
 }finally{lock.releaseLock();}
}
function adminReject_(p){
 requireAdmin_(p.token);const lock=LockService.getScriptLock();lock.waitLock(20000);
 try{const sh=getSpreadsheet_().getSheetByName("Movimentações"),last=sh.getLastRow(),vals=last>1?sh.getRange(2,1,last-1,9).getValues():[],i=vals.findIndex(r=>r[0]===p.protocol);if(i<0)throw new Error("Protocolo não encontrado.");if(vals[i][6]!=="Pendente")throw new Error("Esta solicitação já foi processada.");sh.getRange(i+2,7,1,3).setValues([["Recusada",new Date(),String(p.note||"Recusada pelo administrador").slice(0,250)]]);return{ok:true,protocol:p.protocol,status:"Recusada"};}finally{lock.releaseLock();}
}
function getWithdrawalsThisWeek_(sheet,phone,now){
 const last=sheet.getLastRow();if(last<=1)return 0;const rows=sheet.getRange(2,1,last-1,9).getValues(),wk=weekKey_(now);
 return rows.reduce((sum,r)=>{const date=r[1] instanceof Date?r[1]:null;return String(r[3]).replace(/\D/g,"")===phone&&date&&weekKey_(date)===wk&&r[6]==="Aprovada"?sum+(Number(r[4])||0):sum;},0);
}
function weekKey_(date){const p=Utilities.formatDate(date,CONFIG.TIMEZONE,"yyyy-MM-dd").split("-").map(Number),u=new Date(Date.UTC(p[0],p[1]-1,p[2])),day=u.getUTCDay()||7;u.setUTCDate(u.getUTCDate()-day+1);return Utilities.formatDate(u,"UTC","yyyy-MM-dd");}
function getSpreadsheet_(){const id=PropertiesService.getScriptProperties().getProperty(CONFIG.SPREADSHEET_PROPERTY);if(!id)throw new Error("Planilha não configurada. Execute setup().");return SpreadsheetApp.openById(id);}
function sha256_(s){return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,s,Utilities.Charset.UTF_8).map(b=>(b<0?b+256:b).toString(16).padStart(2,"0")).join("");}
function responseHtml_(data){const json=JSON.stringify(Object.assign({type:"BULK_MOVEMENT_RESPONSE"},data||{})).replace(/</g,"\\u003c");return HtmlService.createHtmlOutput('<!doctype html><html><body><script>window.top.postMessage('+json+', "*");</script>Processado.</body></html>').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);}
